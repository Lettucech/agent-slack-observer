import type { Database, SlackEnvelope } from "./db.js";

export type SocketModeStatus = {
  state: "starting" | "connecting" | "connected" | "reconnecting" | "stopped";
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
};

type SocketEnvelope = {
  envelope_id?: unknown;
  type?: unknown;
  payload?: unknown;
};

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Receives Slack Events API payloads over an outbound Socket Mode connection. */
export class SocketModeObserver {
  private socket: WebSocket | undefined;
  private stopped = true;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private statusValue: SocketModeStatus = { state: "stopped", lastConnectedAt: null, lastEventAt: null, lastError: null };

  constructor(private readonly appToken: string, private readonly database: Database, private readonly onStored?: (workspaceId: string, channelId: string) => void) {}

  status(): SocketModeStatus { return { ...this.statusValue }; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.statusValue.state = "starting";
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.statusValue.state = "stopped";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.statusValue.state = this.reconnectAttempt ? "reconnecting" : "connecting";
    try {
      const url = await this.openConnectionUrl();
      if (this.stopped) return;
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.reconnectAttempt = 0;
        this.statusValue = { ...this.statusValue, state: "connected", lastConnectedAt: new Date().toISOString(), lastError: null };
      });
      socket.addEventListener("message", (event) => { void this.handleMessage(socket, event.data); });
      socket.addEventListener("error", () => { this.statusValue.lastError = "Slack Socket Mode connection error"; });
      socket.addEventListener("close", () => {
        if (!this.stopped && this.socket === socket) this.scheduleReconnect();
      });
    } catch (error) {
      this.statusValue.lastError = error instanceof Error ? error.message : "Unable to open Slack Socket Mode connection";
      this.scheduleReconnect();
    }
  }

  private async openConnectionUrl(): Promise<string> {
    const response = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.appToken}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    const data: unknown = await response.json();
    if (!response.ok || !isSocketOpenResponse(data)) {
      const error = isObject(data) && typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
      throw new Error(`Slack Socket Mode connection rejected: ${error}`);
    }
    return data.url;
  }

  private async handleMessage(socket: WebSocket, data: unknown): Promise<void> {
    try {
      const envelope = JSON.parse(String(data)) as SocketEnvelope;
      if (envelope.type === "disconnect") {
        socket.close();
        return;
      }
      if (envelope.type !== "events_api" || !isObject(envelope.payload)) return;
      await this.database.storeEnvelope(envelope.payload as SlackEnvelope);
      this.statusValue.lastEventAt = new Date().toISOString();
      if (typeof envelope.envelope_id === "string" && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      }
      const payload = envelope.payload as SlackEnvelope;
      if (typeof payload.team_id === "string" && isObject(payload.event) && typeof payload.event.channel === "string") {
        this.onStored?.(payload.team_id, payload.event.channel);
      }
    } catch (error) {
      this.statusValue.lastError = error instanceof Error ? error.message : "Unable to persist Slack Socket Mode event";
      // Do not acknowledge a failed write. Slack can redeliver the event after reconnection.
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.statusValue.state = "reconnecting";
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }
}

function isSocketOpenResponse(value: unknown): value is { ok: true; url: string } {
  return isObject(value) && value.ok === true && typeof value.url === "string" && value.url.startsWith("wss://");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
