import { Pool } from "pg";
import type { StoredMessage } from "./types.js";

export type SlackEnvelope = {
  event_id?: unknown;
  team_id?: unknown;
  api_app_id?: unknown;
  type?: unknown;
  event?: unknown;
};

export class Database {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS slack_events (
        event_sequence BIGSERIAL PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        api_app_id TEXT,
        callback_type TEXT NOT NULL,
        event_type TEXT,
        event_ts TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        payload JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS slack_events_workspace_received_idx
        ON slack_events (workspace_id, received_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        event_id TEXT PRIMARY KEY REFERENCES slack_events(event_id) ON DELETE CASCADE,
        event_sequence BIGINT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        thread_ts TEXT,
        user_id TEXT,
        subtype TEXT,
        text TEXT,
        event_payload JSONB NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_thread_idx
        ON messages (workspace_id, channel_id, thread_ts, event_sequence);
      CREATE INDEX IF NOT EXISTS messages_sequence_idx ON messages (event_sequence);
      CREATE TABLE IF NOT EXISTS channel_labels (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        label TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_metadata (
        workspace_id TEXT PRIMARY KEY,
        workspace_name TEXT,
        last_synced_at TIMESTAMPTZ,
        last_attempted_at TIMESTAMPTZ,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS channel_metadata (
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        last_synced_at TIMESTAMPTZ,
        last_attempted_at TIMESTAMPTZ,
        last_error TEXT,
        PRIMARY KEY (workspace_id, channel_id)
      );
    `);
  }

  async storeEnvelope(envelope: SlackEnvelope): Promise<{ inserted: boolean; eventSequence?: number }> {
    const eventId = typeof envelope.event_id === "string" ? envelope.event_id : null;
    const workspaceId = typeof envelope.team_id === "string" ? envelope.team_id : null;
    const callbackType = typeof envelope.type === "string" ? envelope.type : null;
    if (!eventId || !workspaceId || !callbackType) throw new Error("Slack event envelope is missing event_id, team_id, or type");
    const event = isObject(envelope.event) ? envelope.event : {};
    const insert = await this.pool.query<{ event_sequence: string }>(
      `INSERT INTO slack_events (event_id, workspace_id, api_app_id, callback_type, event_type, event_ts, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_sequence`,
      [eventId, workspaceId, typeof envelope.api_app_id === "string" ? envelope.api_app_id : null, callbackType,
        typeof event.type === "string" ? event.type : null, typeof event.event_ts === "string" ? event.event_ts : null, envelope],
    );
    if (insert.rowCount === 0) return { inserted: false };
    const eventSequence = Number(insert.rows[0].event_sequence);
    if (event.type === "message" && typeof event.channel === "string" && typeof event.ts === "string") {
      await this.pool.query(
        `INSERT INTO messages (event_id, event_sequence, workspace_id, channel_id, message_ts, thread_ts, user_id, subtype, text, event_payload, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
        [eventId, eventSequence, workspaceId, event.channel, event.ts,
          typeof event.thread_ts === "string" ? event.thread_ts : null,
          typeof event.user === "string" ? event.user : null,
          typeof event.subtype === "string" ? event.subtype : null,
          typeof event.text === "string" ? event.text : null, event],
      );
    }
    return { inserted: true, eventSequence };
  }

  async latestSequence(): Promise<number> {
    const result = await this.pool.query<{ value: string }>("SELECT COALESCE(MAX(event_sequence), 0)::text AS value FROM slack_events");
    return Number(result.rows[0].value);
  }

  async changedMessages(afterSequence: number, upperSequence: number, settleSeconds: number): Promise<StoredMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT m.event_id, m.event_sequence::text, m.workspace_id, m.channel_id, m.message_ts, m.thread_ts, m.user_id, m.subtype, m.text, m.event_payload, m.observed_at::text,
              wm.workspace_name, cm.channel_name
       FROM messages m LEFT JOIN workspace_metadata wm USING (workspace_id)
       LEFT JOIN channel_metadata cm USING (workspace_id, channel_id)
       WHERE m.event_sequence > $1 AND m.event_sequence <= $2
         AND m.observed_at <= now() - make_interval(secs => $3)
       ORDER BY m.event_sequence ASC`,
      [afterSequence, upperSequence, settleSeconds],
    );
    return result.rows.map(toStoredMessage);
  }

  /** Returns the complete observed history for each touched thread. It performs no Slack API call. */
  async hydrateThreads(changed: StoredMessage[]): Promise<StoredMessage[]> {
    const threadKeys = [...new Map(
      changed.filter((message) => message.threadTs).map((message) => [`${message.workspaceId}\u0000${message.channelId}\u0000${message.threadTs}`, message]),
    ).values()];
    if (threadKeys.length === 0) return changed;
    const clauses: string[] = [];
    const values: string[] = [];
    for (const item of threadKeys) {
      const index = values.length;
      values.push(item.workspaceId, item.channelId, item.threadTs!);
      clauses.push(`(workspace_id = $${index + 1} AND channel_id = $${index + 2} AND (thread_ts = $${index + 3} OR message_ts = $${index + 3}))`);
    }
    const result = await this.pool.query<MessageRow>(
      `SELECT m.event_id, m.event_sequence::text, m.workspace_id, m.channel_id, m.message_ts, m.thread_ts, m.user_id, m.subtype, m.text, m.event_payload, m.observed_at::text,
              wm.workspace_name, cm.channel_name
       FROM messages m LEFT JOIN workspace_metadata wm USING (workspace_id)
       LEFT JOIN channel_metadata cm USING (workspace_id, channel_id)
       WHERE ${clauses.map((clause) => clause.replaceAll("workspace_id", "m.workspace_id").replaceAll("channel_id", "m.channel_id").replaceAll("thread_ts", "m.thread_ts").replaceAll("message_ts", "m.message_ts")).join(" OR ")}
       ORDER BY m.event_sequence ASC`, values,
    );
    const byEventId = new Map<string, StoredMessage>();
    for (const message of [...changed, ...result.rows.map(toStoredMessage)]) byEventId.set(message.eventId, message);
    return [...byEventId.values()].sort((a, b) => a.eventSequence - b.eventSequence);
  }

  async getThread(workspaceId: string, channelId: string, threadTs: string, afterMessageTs: string | undefined, settleSeconds: number): Promise<StoredMessage[]> {
    const result = await this.pool.query<MessageRow>(
      `SELECT m.event_id, m.event_sequence::text, m.workspace_id, m.channel_id, m.message_ts, m.thread_ts, m.user_id, m.subtype, m.text, m.event_payload, m.observed_at::text,
              wm.workspace_name, cm.channel_name
       FROM messages m LEFT JOIN workspace_metadata wm USING (workspace_id)
       LEFT JOIN channel_metadata cm USING (workspace_id, channel_id)
       WHERE m.workspace_id = $1 AND m.channel_id = $2 AND (m.thread_ts = $3 OR m.message_ts = $3)
         AND m.observed_at <= now() - make_interval(secs => $4)
       ORDER BY m.message_ts ASC`,
      [workspaceId, channelId, threadTs, settleSeconds],
    );
    const messages = result.rows.map(toStoredMessage);
    if (!afterMessageTs) return messages;
    const root = messages.find((message) => message.messageTs === threadTs);
    return [...(root ? [root] : []), ...messages.filter((message) => message.messageTs > afterMessageTs && message.messageTs !== threadTs)];
  }

  async listChannels(): Promise<Array<{ workspaceId: string; workspaceName: string | null; channelId: string; channelName: string | null; messageCount: number; lastObservedAt: string }>> {
    const result = await this.pool.query<{ workspace_id: string; workspace_name: string | null; channel_id: string; channel_name: string | null; message_count: string; last_observed_at: string }>(
      `SELECT m.workspace_id, wm.workspace_name, m.channel_id, cm.channel_name, count(*)::text AS message_count, max(m.observed_at)::text AS last_observed_at
       FROM messages m LEFT JOIN workspace_metadata wm USING (workspace_id)
       LEFT JOIN channel_metadata cm USING (workspace_id, channel_id)
       GROUP BY m.workspace_id, wm.workspace_name, m.channel_id, cm.channel_name ORDER BY last_observed_at DESC`,
    );
    return result.rows.map((row) => ({ workspaceId: row.workspace_id, workspaceName: row.workspace_name, channelId: row.channel_id, channelName: row.channel_name, messageCount: Number(row.message_count), lastObservedAt: row.last_observed_at }));
  }

  async metadataLookupDue(workspaceId: string, channelId: string, maxAgeHours = 24): Promise<{ workspace: boolean; channel: boolean }> {
    const result = await this.pool.query<{ workspace_due: boolean; channel_due: boolean }>(
      `SELECT NOT EXISTS (SELECT 1 FROM workspace_metadata WHERE workspace_id = $1 AND ((workspace_name IS NOT NULL AND last_synced_at > now() - make_interval(hours => $3)) OR last_attempted_at > now() - interval '15 minutes')) AS workspace_due,
              NOT EXISTS (SELECT 1 FROM channel_metadata WHERE workspace_id = $1 AND channel_id = $2 AND ((channel_name IS NOT NULL AND last_synced_at > now() - make_interval(hours => $3)) OR last_attempted_at > now() - interval '15 minutes')) AS channel_due`,
      [workspaceId, channelId, maxAgeHours],
    );
    return { workspace: result.rows[0].workspace_due, channel: result.rows[0].channel_due };
  }

  async saveWorkspaceMetadata(workspaceId: string, workspaceName: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO workspace_metadata (workspace_id, workspace_name, last_synced_at, last_attempted_at, last_error)
       VALUES ($1, $2, now(), now(), NULL)
       ON CONFLICT (workspace_id) DO UPDATE SET workspace_name = EXCLUDED.workspace_name, last_synced_at = now(), last_attempted_at = now(), last_error = NULL`,
      [workspaceId, workspaceName],
    );
  }

  async saveChannelMetadata(workspaceId: string, channelId: string, channelName: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO channel_metadata (workspace_id, channel_id, channel_name, last_synced_at, last_attempted_at, last_error)
       VALUES ($1, $2, $3, now(), now(), NULL)
       ON CONFLICT (workspace_id, channel_id) DO UPDATE SET channel_name = EXCLUDED.channel_name, last_synced_at = now(), last_attempted_at = now(), last_error = NULL`,
      [workspaceId, channelId, channelName],
    );
  }

  async saveMetadataError(workspaceId: string, channelId: string, error: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO workspace_metadata (workspace_id, last_attempted_at, last_error)
       VALUES ($1, now(), $2)
       ON CONFLICT (workspace_id) DO UPDATE SET last_attempted_at = now(), last_error = EXCLUDED.last_error`,
      [workspaceId, error],
    );
    await this.pool.query(
      `INSERT INTO channel_metadata (workspace_id, channel_id, last_attempted_at, last_error)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (workspace_id, channel_id) DO UPDATE SET last_attempted_at = now(), last_error = EXCLUDED.last_error`,
      [workspaceId, channelId, error],
    );
  }

  async dashboardStatus(): Promise<{ events: number; messages: number; lastReceivedAt: string | null; channels: number }> {
    const result = await this.pool.query<{ events: string; messages: string; last_received_at: string | null; channels: string }>(
      `SELECT (SELECT count(*) FROM slack_events)::text AS events,
              (SELECT count(*) FROM messages)::text AS messages,
              (SELECT max(received_at)::text FROM slack_events) AS last_received_at,
              (SELECT count(DISTINCT (workspace_id, channel_id)) FROM messages)::text AS channels`,
    );
    const row = result.rows[0];
    return { events: Number(row.events), messages: Number(row.messages), lastReceivedAt: row.last_received_at, channels: Number(row.channels) };
  }

  async close(): Promise<void> { await this.pool.end(); }
}

type MessageRow = {
  event_id: string; event_sequence: string; workspace_id: string; channel_id: string; message_ts: string; thread_ts: string | null;
  user_id: string | null; subtype: string | null; text: string | null; event_payload: Record<string, unknown>; observed_at: string; workspace_name: string | null; channel_name: string | null;
};

function toStoredMessage(row: MessageRow): StoredMessage {
  return { eventId: row.event_id, eventSequence: Number(row.event_sequence), workspaceId: row.workspace_id, channelId: row.channel_id,
    messageTs: row.message_ts, threadTs: row.thread_ts, userId: row.user_id, subtype: row.subtype, text: row.text, payload: row.event_payload, observedAt: row.observed_at,
    workspaceName: row.workspace_name, channelName: row.channel_name };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
