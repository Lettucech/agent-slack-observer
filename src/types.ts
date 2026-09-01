import type { ConversationType } from "./slack-conversation-type.js";

export type StoredMessage = {
  eventId: string;
  eventSequence: number;
  workspaceId: string;
  channelId: string;
  conversationType: ConversationType;
  messageTs: string;
  threadTs: string | null;
  userId: string | null;
  subtype: string | null;
  text: string | null;
  payload: Record<string, unknown>;
  observedAt: string;
  workspaceName?: string | null;
  channelName?: string | null;
};

/** The bounded message shape returned by digest tools. Raw Slack payloads stay in storage. */
export type DigestMessage = {
  /** Slack timestamp; use it for continuation and source attribution. */
  messageTs: string;
  userId?: string;
  subtype?: string;
  text: string | null;
  /** Unicode code-point offset for the next segment of this message's text. */
  textContinues?: number;
};

export type ThreadCheckpointFact = { text: string; sourceMessageTs: string; owner?: string; deadline?: string };
export type ThreadCheckpoint = {
  decisions?: ThreadCheckpointFact[];
  actions?: ThreadCheckpointFact[];
  blockers?: ThreadCheckpointFact[];
  openQuestions?: ThreadCheckpointFact[];
  importantContext?: ThreadCheckpointFact[];
};

export type DigestGroup = {
  kind: "thread" | "channel_window";
  workspaceId: string;
  workspaceName?: string | null;
  channelId: string;
  channelName?: string | null;
  conversationType: ConversationType;
  messages: DigestMessage[];
  threadTs?: string;
  checkpoint?: ThreadCheckpoint;
  threadContinues?: true;
  /** The agent may attach a bounded, source-linked checkpoint when acknowledging this complete thread. */
  checkpointSuggested?: true;
  ackToken?: string;
};

export type DigestBatch = {
  groups: DigestGroup[];
  hasMore?: true;
};
