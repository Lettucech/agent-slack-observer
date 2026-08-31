export const conversationTypes = ["public_channel", "private_channel", "im", "mpim", "unknown"] as const;
export type ConversationType = typeof conversationTypes[number];

/** Normalizes Slack's event and conversations.info/list conversation markers. */
export function conversationTypeFromSlackChannel(channel: Record<string, unknown>): ConversationType {
  if (channel.is_im === true || channel.channel_type === "im") return "im";
  if (channel.is_mpim === true || channel.channel_type === "mpim") return "mpim";
  if (channel.is_private === true || channel.is_group === true || channel.channel_type === "group" || channel.channel_type === "private_channel") return "private_channel";
  if (channel.is_channel === true || channel.channel_type === "channel" || channel.channel_type === "public_channel") return "public_channel";
  return "unknown";
}

export function conversationTypeFromStoredValue(value: string | null | undefined): ConversationType {
  return conversationTypes.includes(value as ConversationType) ? value as ConversationType : "unknown";
}
