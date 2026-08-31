import type { Database } from "./db.js";
import { SlackBackfillWorker } from "./backfill.js";
import { SlackConversationDiscovery } from "./slack-conversations.js";
import { SlackMetadataSync } from "./slack-metadata.js";
import type { ObserverSettings } from "./settings.js";
import { SocketModeObserver, type SocketModeStatus } from "./socket-mode.js";

export class ObserverRuntime {
  private socket: SocketModeObserver | undefined;
  private metadata: SlackMetadataSync | undefined;
  private backfill: SlackBackfillWorker | undefined;
  private discovery: SlackConversationDiscovery | undefined;

  constructor(private readonly database: Database) {}

  async apply(settings: ObserverSettings): Promise<void> {
    this.stop();
    const readToken = settings.slackUserToken ?? settings.slackBotToken;
    if (!readToken) return;
    this.metadata = new SlackMetadataSync(readToken, this.database);
    this.backfill = new SlackBackfillWorker(readToken, this.database, {
      requestIntervalSeconds: settings.backfillRequestIntervalSeconds,
      rawEventRetentionDays: settings.rawEventRetentionDays,
      messageRetentionDays: settings.messageRetentionDays,
    });
    this.backfill.start();
    if (await this.database.promotePendingBackfillSuggestions(settings.messageRetentionDays)) this.backfill.wake();
    this.discovery = settings.slackUserToken ? new SlackConversationDiscovery(settings.slackUserToken, this.database) : undefined;
    if (settings.slackAppToken) {
      this.socket = new SocketModeObserver(settings.slackAppToken, this.database, (workspaceId, channelId) => this.metadata?.schedule(workspaceId, channelId), {
        connected: () => void this.database.markSocketConnected(settings.downtimeSuggestionSeconds, settings.messageRetentionDays)
          .then((recovery) => { if (recovery) this.backfill?.wake(); })
          .catch(console.error),
        disconnected: () => void this.database.markSocketDisconnected().catch(console.error),
        eventStored: () => void this.database.markSocketEvent().catch(console.error),
      });
      this.socket.start();
    }
    const channels = await this.database.listChannels();
    channels.filter((channel) => channel.enabled).forEach((channel) => this.metadata?.schedule(channel.workspaceId, channel.channelId));
  }

  stop(): void {
    this.backfill?.stop();
    this.socket?.stop();
    this.socket = undefined;
    this.metadata = undefined;
    this.backfill = undefined;
    this.discovery = undefined;
  }

  socketStatus(): SocketModeStatus | { state: "not_configured"; lastConnectedAt: null; lastEventAt: null; lastError: null } {
    return this.socket?.status() ?? { state: "not_configured", lastConnectedAt: null, lastEventAt: null, lastError: null };
  }
  userTokenConfigured(): boolean { return Boolean(this.discovery); }
  async discoverConversations(): Promise<{ workspaceId: string; conversations: number }> {
    if (!this.discovery) throw new Error("Configure a Slack user token in Settings before syncing user-visible conversations");
    return this.discovery.discover();
  }
  async syncMetadata(): Promise<number> {
    if (!this.metadata) throw new Error("Configure a Slack read token in Settings before syncing metadata");
    const channels = await this.database.listChannels();
    const covered = channels.filter((channel) => channel.enabled);
    covered.forEach((channel) => this.metadata?.schedule(channel.workspaceId, channel.channelId, true));
    return covered.length;
  }
  wakeBackfill(): void {
    if (!this.backfill) throw new Error("Configure a Slack read token in Settings before creating a backfill job");
    this.backfill.wake();
  }
  scheduleMetadata(workspaceId: string, channelId: string): void { this.metadata?.schedule(workspaceId, channelId); }
}

export async function testSlackConnection(settings: ObserverSettings): Promise<void> {
  const readToken = settings.slackUserToken ?? settings.slackBotToken;
  if (!readToken || !settings.slackAppToken) throw new Error("A Slack App Token and a Slack read token are required");
  const appResponse = await fetch("https://slack.com/api/apps.connections.open", {
    method: "POST", headers: { Authorization: `Bearer ${settings.slackAppToken}`, "Content-Type": "application/x-www-form-urlencoded" },
  });
  await requireSlackOk(appResponse, "apps.connections.open");
  const readResponse = await fetch("https://slack.com/api/auth.test", { headers: { Authorization: `Bearer ${readToken}` } });
  await requireSlackOk(readResponse, "auth.test");
}

async function requireSlackOk(response: Response, method: string): Promise<void> {
  const body: unknown = await response.json();
  if (response.ok && body && typeof body === "object" && (body as Record<string, unknown>).ok === true) return;
  const detail = body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string" ? (body as Record<string, string>).error : `HTTP ${response.status}`;
  throw new Error(`Slack ${method} failed: ${detail}`);
}
