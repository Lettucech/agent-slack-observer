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
  workspaceName?: string | null;
  channelName?: string | null;
};

export type DigestGroup = {
  id: string;
  kind: "thread" | "channel_window";
  workspaceId: string;
  workspaceName?: string | null;
  channelId: string;
  channelName?: string | null;
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
