import type { Database } from "./db.js";
import { conversationTypeFromSlackChannel } from "./slack-conversation-type.js";
import { SlackConversationNameResolver } from "./slack-conversation-name.js";

const DEFAULT_RETRY_MS = 60_000;

/**
 * Low-frequency Slack Web API client for display metadata only. It never requests
 * message history and runs strictly after Socket Mode has persisted and acknowledged an event.
 */
export class SlackMetadataSync {
  private readonly pending = new Set<string>();
  private readonly workspaceRequests = new Map<string, Promise<void>>();
  private readonly displayNames: SlackConversationNameResolver;
  private retryNotBefore = 0;

  constructor(private readonly readToken: string, private readonly database: Database) {
    this.displayNames = new SlackConversationNameResolver((methodAndQuery) => this.slackGet(methodAndQuery));
  }

  schedule(workspaceId: string, channelId: string, force = false, resolvePeople = false): void {
    const key = `${workspaceId}:${channelId}`;
    if (this.pending.has(key)) return;
    this.pending.add(key);
    void this.sync(workspaceId, channelId, force, resolvePeople).finally(() => this.pending.delete(key));
  }

  private async sync(workspaceId: string, channelId: string, force: boolean, resolvePeople: boolean): Promise<void> {
    const due = force ? { workspace: true, channel: true } : await this.database.metadataLookupDue(workspaceId, channelId);
    if (!due.workspace && !due.channel) return;
    const delay = this.retryNotBefore - Date.now();
    if (delay > 0) {
      setTimeout(() => this.schedule(workspaceId, channelId, force, resolvePeople), delay);
      return;
    }
    try {
      if (due.workspace) await this.syncWorkspace(workspaceId);
      if (due.channel) {
        const channel = await this.slackGet(`conversations.info?channel=${encodeURIComponent(channelId)}`);
        const name = getString(channel, "channel", "name");
        const details = isObject(channel.channel) ? channel.channel : {};
        const displayName = resolvePeople ? await this.displayNames.resolve(details) : name ?? channelId;
        await this.database.saveChannelMetadata(workspaceId, channelId, displayName ?? channelId, conversationTypeFromSlackChannel(details));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Slack metadata lookup failed";
      await this.database.saveMetadataError(workspaceId, channelId, message);
      const delay = this.retryNotBefore - Date.now();
      if (delay > 0) setTimeout(() => this.schedule(workspaceId, channelId, force, resolvePeople), delay);
    }
  }

  private syncWorkspace(workspaceId: string): Promise<void> {
    const existing = this.workspaceRequests.get(workspaceId);
    if (existing) return existing;
    const request = (async () => {
      const team = await this.slackGet("team.info");
      const name = getString(team, "team", "name");
      if (!name) throw new Error("team.info returned no team name");
      await this.database.saveWorkspaceMetadata(workspaceId, name);
    })().finally(() => this.workspaceRequests.delete(workspaceId));
    this.workspaceRequests.set(workspaceId, request);
    return request;
  }

  private async slackGet(methodAndQuery: string): Promise<Record<string, unknown>> {
    const response = await fetch(`https://slack.com/api/${methodAndQuery}`, { headers: { Authorization: `Bearer ${this.readToken}` } });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      this.retryNotBefore = Date.now() + (Number.isFinite(retryAfter) ? retryAfter * 1000 : DEFAULT_RETRY_MS);
      throw new Error(`Slack metadata rate limited; retry after ${Math.ceil((this.retryNotBefore - Date.now()) / 1000)}s`);
    }
    const body: unknown = await response.json();
    if (!response.ok || !isOk(body)) {
      const detail = isObject(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new Error(`Slack metadata lookup failed: ${detail}`);
    }
    return body;
  }
}

function getString(value: Record<string, unknown>, parent: string, child: string): string | null {
  const nested = value[parent];
  return isObject(nested) && typeof nested[child] === "string" ? nested[child] : null;
}

function isOk(value: unknown): value is Record<string, unknown> & { ok: true } {
  return isObject(value) && value.ok === true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
