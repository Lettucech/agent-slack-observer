export type UserVisibleConversation = { channelId: string; channelName: string | null };

export type ConversationDiscoveryDatabase = {
  registerUserVisibleConversations(workspaceId: string, workspaceName: string | null, conversations: UserVisibleConversation[]): Promise<void>;
};

/**
 * Discovers conversations only when the local dashboard explicitly requests it.
 * It uses a user token exclusively: a bot token must never broaden the target set.
 */
export class SlackConversationDiscovery {
  constructor(private readonly userToken: string, private readonly database: ConversationDiscoveryDatabase) {}

  async discover(): Promise<{ workspaceId: string; conversations: number }> {
    const identity = await this.slackGet("auth.test");
    const workspaceId = stringValue(identity.team_id);
    if (!workspaceId) throw new Error("Slack auth.test returned no workspace ID");
    const conversations: UserVisibleConversation[] = [];
    let cursor: string | undefined;
    do {
      const parameters = new URLSearchParams({
        types: "public_channel,private_channel,im,mpim",
        exclude_archived: "true",
        limit: "200",
      });
      if (cursor) parameters.set("cursor", cursor);
      const page = await this.slackGet(`conversations.list?${parameters}`);
      const channels = Array.isArray(page.channels) ? page.channels : [];
      for (const channel of channels) {
        if (!isObject(channel) || channel.is_archived === true) continue;
        const channelId = stringValue(channel.id);
        if (channelId) conversations.push({ channelId, channelName: stringValue(channel.name) });
      }
      cursor = isObject(page.response_metadata) ? nonEmptyString(page.response_metadata.next_cursor) : undefined;
    } while (cursor);
    const unique = [...new Map(conversations.map((channel) => [channel.channelId, channel])).values()];
    await this.database.registerUserVisibleConversations(workspaceId, stringValue(identity.team), unique);
    return { workspaceId, conversations: unique.length };
  }

  private async slackGet(methodAndQuery: string): Promise<Record<string, unknown>> {
    const response = await fetch(`https://slack.com/api/${methodAndQuery}`, { headers: { Authorization: `Bearer ${this.userToken}` } });
    const body: unknown = await response.json();
    if (!response.ok || !isOk(body)) {
      const detail = isObject(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new Error(`Slack ${methodAndQuery.split("?")[0]} failed: ${detail}`);
    }
    return body;
  }
}

function isOk(value: unknown): value is Record<string, unknown> & { ok: true } { return isObject(value) && value.ok === true; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): string | null { return typeof value === "string" ? value : null; }
function nonEmptyString(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
