import { conversationTypeFromSlackChannel } from "./slack-conversation-type.js";

type SlackGet = (methodAndQuery: string) => Promise<Record<string, unknown>>;

/** Resolves short, local display labels without collecting email addresses or message content. */
export class SlackConversationNameResolver {
  private readonly userNames = new Map<string, Promise<string>>();

  constructor(private readonly slackGet: SlackGet) {}

  async resolve(channel: Record<string, unknown>): Promise<string | null> {
    const channelId = stringValue(channel.id);
    const conversationType = conversationTypeFromSlackChannel(channel);
    if (conversationType === "im") return this.userName(stringValue(channel.user) ?? channelId);
    if (conversationType === "mpim") {
      if (!channelId) return null;
      const members = await this.members(channelId).catch(() => []);
      if (!members.length) return channelId;
      const names = await Promise.all(members.map((memberId) => this.userName(memberId)));
      return summarizeNames(names);
    }
    return stringValue(channel.name) ?? channelId;
  }

  private userName(userId: string | null): Promise<string> {
    if (!userId) return Promise.resolve("Unknown user");
    let result = this.userNames.get(userId);
    if (!result) {
      result = this.slackGet(`users.info?user=${encodeURIComponent(userId)}`)
        .then((response) => userDisplayName(response) ?? userId)
        .catch(() => userId);
      this.userNames.set(userId, result);
    }
    return result;
  }

  private async members(channelId: string): Promise<string[]> {
    const members: string[] = [];
    let cursor: string | undefined;
    do {
      const parameters = new URLSearchParams({ channel: channelId, limit: "100" });
      if (cursor) parameters.set("cursor", cursor);
      const response = await this.slackGet(`conversations.members?${parameters}`);
      if (Array.isArray(response.members)) members.push(...response.members.filter((member): member is string => typeof member === "string"));
      cursor = isObject(response.response_metadata) ? nonEmptyString(response.response_metadata.next_cursor) : undefined;
    } while (cursor);
    return [...new Set(members)];
  }
}

function userDisplayName(response: Record<string, unknown>): string | null {
  if (!isObject(response.user)) return null;
  const profile = isObject(response.user.profile) ? response.user.profile : {};
  return nonEmptyString(profile.display_name) ?? nonEmptyString(profile.real_name) ?? nonEmptyString(response.user.real_name) ?? nonEmptyString(response.user.name) ?? null;
}

function summarizeNames(names: string[]): string {
  const visible = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${visible} +${names.length - 3}` : visible;
}

function stringValue(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
function nonEmptyString(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
