import type { DigestBatch, DigestGroup, DigestMessage, StoredMessage } from "./types.js";

type DigestOptions = {
  maxBytes: number;
  channelWindowSeconds?: number;
};

type GroupedMessages = {
  kind: DigestGroup["kind"];
  messages: StoredMessage[];
  threadTs?: string;
};

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function projectMessage(message: StoredMessage, text = message.text, textContinues?: number): DigestMessage {
  return {
    messageTs: message.messageTs,
    ...(message.userId ? { userId: message.userId } : {}),
    ...(message.subtype ? { subtype: message.subtype } : {}),
    text,
    ...(textContinues === undefined ? {} : { textContinues }),
  };
}

/** Return the next lossless text segment that fits the caller's budget. */
export function makeMessageDigestSegment(message: StoredMessage, maxTokens: number, afterTextOffset = 0): DigestMessage {
  if (!Number.isInteger(maxTokens) || maxTokens < 128) throw new Error("maxBytes must be at least 128");
  if (!Number.isInteger(afterTextOffset) || afterTextOffset < 0) throw new Error("afterTextOffset must be a non-negative integer");
  const characters = Array.from(message.text ?? "");
  if (afterTextOffset > characters.length) throw new Error("afterTextOffset is beyond the message text");

  const full = projectMessage(message, characters.slice(afterTextOffset).join(""));
  if (bytes(full) <= maxTokens || !message.text) return full;

  let low = afterTextOffset;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = projectMessage(message, characters.slice(afterTextOffset, middle).join(""), middle);
    if (bytes(candidate) <= maxTokens) low = middle;
    else high = middle - 1;
  }
  return projectMessage(message, characters.slice(afterTextOffset, low).join(""), low);
}

function messageTime(message: StoredMessage): number {
  return Number(message.messageTs.split(".")[0]) || 0;
}

function makeGroup(kind: DigestGroup["kind"], sourceMessages: StoredMessage[], threadTs?: string, digestMessages = sourceMessages.map((message) => projectMessage(message))): DigestGroup {
  const first = sourceMessages[0];
  return {
    kind,
    workspaceId: first.workspaceId,
    workspaceName: first.workspaceName,
    channelId: first.channelId,
    channelName: first.channelName,
    conversationType: first.conversationType,
    messages: digestMessages,
    ...(threadTs ? { threadTs } : {}),
  };
}

/**
 * Build groups before applying the model budget. Thread members are grouped by their
 * root timestamp, so unrelated live messages cannot split a discussion.
 */
function groupMessages(messages: StoredMessage[], channelWindowSeconds = 300): GroupedMessages[] {
  const threads = new Map<string, StoredMessage[]>();
  const standaloneByChannel = new Map<string, StoredMessage[]>();
  const rootKeys = new Set(messages.filter((message) => message.threadTs).map((message) => `${message.workspaceId}:${message.channelId}:${message.threadTs}`));

  // Socket delivery and reverse-paginated history backfill are not chronological.
  // Slack's timestamp is the stable ordering for a channel or thread digest.
  for (const message of [...messages].sort((a, b) => messageTime(a) - messageTime(b))) {
    // Slack omits thread_ts on the root event; hydrateThreads supplies that root alongside replies.
    const inferredThreadTs = rootKeys.has(`${message.workspaceId}:${message.channelId}:${message.messageTs}`) ? message.messageTs : null;
    const threadTs = message.threadTs ?? inferredThreadTs;
    if (threadTs) {
      const key = `${message.workspaceId}:${message.channelId}:${threadTs}`;
      threads.set(key, [...(threads.get(key) ?? []), message]);
    } else {
      const key = `${message.workspaceId}:${message.channelId}`;
      standaloneByChannel.set(key, [...(standaloneByChannel.get(key) ?? []), message]);
    }
  }

  const groups: GroupedMessages[] = [];
  for (const threadMessages of threads.values()) {
    const root = threadMessages.find((message) => message.messageTs === (message.threadTs ?? message.messageTs));
    const ordered = root ? [root, ...threadMessages.filter((message) => message !== root)] : threadMessages;
    groups.push({ kind: "thread", messages: ordered, threadTs: ordered[0].threadTs ?? ordered[0].messageTs });
  }

  for (const channelMessages of standaloneByChannel.values()) {
    let window: StoredMessage[] = [];
    for (const message of channelMessages) {
      const previous = window.at(-1);
      if (previous && messageTime(message) - messageTime(previous) > channelWindowSeconds) {
        groups.push({ kind: "channel_window", messages: window });
        window = [];
      }
      window.push(message);
    }
    if (window.length) groups.push({ kind: "channel_window", messages: window });
  }

  return groups.sort((a, b) => messageTime(a.messages[0]) - messageTime(b.messages[0]));
}

/** Packs complete groups where possible. Oversized threads are split only as a last resort,
 * retaining the root message in every continuation chunk. */
export function makeDigestBatch(messages: StoredMessage[], options: DigestOptions, upperSequence: number): DigestBatch {
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 128) throw new Error("maxBytes must be at least 128");
  const groups = groupMessages(messages, options.channelWindowSeconds);
  const selected: DigestGroup[] = [];

  for (let index = 0; index < groups.length; index += 1) {
    const sourceGroup = groups[index];
    const group = makeGroup(sourceGroup.kind, sourceGroup.messages, sourceGroup.threadTs);
    const candidate = { groups: [...selected, group], ...(index < groups.length - 1 ? { hasMore: true } : {}) };
    if (bytes(candidate) <= options.maxBytes) {
      selected.push(group);
      continue;
    }
    if (selected.length > 0) return { groups: selected, hasMore: true };

    // A single thread/window exceeds the caller's budget. Return the largest anchored prefix.
    const chunk: StoredMessage[] = [];
    const digestChunk: DigestMessage[] = [];
    let chunkTokens = 0;
    for (const message of sourceGroup.messages) {
      const remaining = options.maxBytes - chunkTokens;
      const projected = chunk.length === 0 ? makeMessageDigestSegment(message, remaining) : projectMessage(message);
      const cost = bytes(projected);
      if (chunk.length > 0 && chunkTokens + cost > options.maxBytes) break;
      chunk.push(message);
      digestChunk.push(projected);
      chunkTokens += cost;
    }
    const partial = makeGroup(sourceGroup.kind, chunk, sourceGroup.threadTs, digestChunk);
    if (chunk.length < sourceGroup.messages.length) partial.threadContinues = true;
    return { groups: [partial], hasMore: true };
  }
  return { groups: selected };
}
