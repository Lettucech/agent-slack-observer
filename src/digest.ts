import type { DigestBatch, DigestGroup, StoredMessage } from "./types.js";

type DigestOptions = {
  maxTokens: number;
  channelWindowSeconds?: number;
};

function estimateTokens(message: StoredMessage): number {
  // Deliberately conservative and tokenizer-independent: Japanese/Chinese and JSON metadata
  // can consume more tokens than English prose. The exact total is returned as an estimate.
  const text = message.text ?? "";
  const payloadOverhead = JSON.stringify(message.payload).length;
  return Math.max(24, Math.ceil((text.length * 1.25 + Math.min(payloadOverhead, 1200)) / 3));
}

function messageTime(message: StoredMessage): number {
  return Number(message.messageTs.split(".")[0]) || 0;
}

function makeGroup(kind: DigestGroup["kind"], messages: StoredMessage[], threadTs?: string): DigestGroup {
  const first = messages[0];
  return {
    id: threadTs ? `${first.workspaceId}:${first.channelId}:${threadTs}` : `${first.workspaceId}:${first.channelId}:${first.eventSequence}`,
    kind,
    workspaceId: first.workspaceId,
    workspaceName: first.workspaceName,
    channelId: first.channelId,
    channelName: first.channelName,
    messages,
    estimatedTokens: messages.reduce((sum, message) => sum + estimateTokens(message), 0),
    ...(threadTs ? { threadTs } : {}),
    threadContinues: false,
  };
}

/**
 * Build groups before applying the model budget. Thread members are grouped by their
 * root timestamp, so unrelated live messages cannot split a discussion.
 */
export function groupMessages(messages: StoredMessage[], channelWindowSeconds = 300): DigestGroup[] {
  const threads = new Map<string, StoredMessage[]>();
  const standaloneByChannel = new Map<string, StoredMessage[]>();
  const rootKeys = new Set(messages.filter((message) => message.threadTs).map((message) => `${message.workspaceId}:${message.channelId}:${message.threadTs}`));

  for (const message of [...messages].sort((a, b) => a.eventSequence - b.eventSequence)) {
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

  const groups: DigestGroup[] = [];
  for (const threadMessages of threads.values()) {
    const root = threadMessages.find((message) => message.messageTs === (message.threadTs ?? message.messageTs));
    const ordered = root ? [root, ...threadMessages.filter((message) => message !== root)] : threadMessages;
    groups.push(makeGroup("thread", ordered, ordered[0].threadTs ?? ordered[0].messageTs));
  }

  for (const channelMessages of standaloneByChannel.values()) {
    let window: StoredMessage[] = [];
    for (const message of channelMessages) {
      const previous = window.at(-1);
      if (previous && messageTime(message) - messageTime(previous) > channelWindowSeconds) {
        groups.push(makeGroup("channel_window", window));
        window = [];
      }
      window.push(message);
    }
    if (window.length) groups.push(makeGroup("channel_window", window));
  }

  return groups.sort((a, b) => a.messages[0].eventSequence - b.messages[0].eventSequence);
}

/** Packs complete groups where possible. Oversized threads are split only as a last resort,
 * retaining the root message in every continuation chunk. */
export function makeDigestBatch(messages: StoredMessage[], options: DigestOptions, upperSequence: number): DigestBatch {
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 128) throw new Error("maxTokens must be at least 128");
  const groups = groupMessages(messages, options.channelWindowSeconds);
  const selected: DigestGroup[] = [];
  let used = 0;

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (used + group.estimatedTokens <= options.maxTokens) {
      selected.push(group);
      used += group.estimatedTokens;
      continue;
    }
    if (selected.length > 0) return { groups: selected, estimatedTokens: used, hasMore: true, upperSequence };

    // A single thread/window exceeds the caller's budget. Return the largest anchored prefix.
    const root = group.kind === "thread" ? group.messages[0] : undefined;
    const chunk: StoredMessage[] = root ? [root] : [];
    let chunkTokens = root ? estimateTokens(root) : 0;
    for (const message of group.messages.slice(root ? 1 : 0)) {
      const cost = estimateTokens(message);
      if (chunk.length > 0 && chunkTokens + cost > options.maxTokens) break;
      chunk.push(message);
      chunkTokens += cost;
    }
    const partial = makeGroup(group.kind, chunk, group.threadTs);
    partial.threadContinues = chunk.length < group.messages.length;
    return { groups: [partial], estimatedTokens: partial.estimatedTokens, hasMore: true, upperSequence };
  }
  return { groups: selected, estimatedTokens: used, hasMore: false, upperSequence };
}
