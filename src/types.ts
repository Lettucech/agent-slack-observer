export type StoredMessage = {
  eventId: string;
  eventSequence: number;
  workspaceId: string;
  channelId: string;
  messageTs: string;
  threadTs: string | null;
  userId: string | null;
  subtype: string | null;
  text: string | null;
  payload: Record<string, unknown>;
  observedAt: string;
};

export type DigestGroup = {
  id: string;
  kind: "thread" | "channel_window";
  workspaceId: string;
  channelId: string;
  messages: StoredMessage[];
  estimatedTokens: number;
  threadTs?: string;
  threadContinues: boolean;
};

export type DigestBatch = {
  groups: DigestGroup[];
  estimatedTokens: number;
  hasMore: boolean;
  upperSequence: number;
};
