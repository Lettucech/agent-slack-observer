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
  eventId: string;
  messageTs: string;
  userId: string | null;
  subtype: string | null;
  text: string | null;
  /** Unicode code-point offset for the next segment of this message's text. */
  textContinues?: number;
};

export type DigestGroup = {
  id: string;
  kind: "thread" | "channel_window";
  workspaceId: string;
  workspaceName?: string | null;
  channelId: string;
  channelName?: string | null;
  conversationType: ConversationType;
  messages: DigestMessage[];
  estimatedTokens: number;
  threadTs?: string;
  threadContinues: boolean;
  ackToken?: string;
};

export type DigestBatch = {
  groups: DigestGroup[];
  estimatedTokens: number;
  hasMore: boolean;
  upperSequence: number;
};
