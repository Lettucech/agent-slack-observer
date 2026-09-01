import { Pool, type PoolClient } from "pg";
import type { StoredMessage, ThreadCheckpoint } from "./types.js";
import type { UserVisibleConversation } from "./slack-conversations.js";
import { defaultSettings, type ObserverSettings } from "./settings.js";
import { conversationTypeFromSlackChannel, conversationTypeFromStoredValue, type ConversationType } from "./slack-conversation-type.js";

export type SlackEnvelope = { event_id?: unknown; team_id?: unknown; api_app_id?: unknown; type?: unknown; event?: unknown };
export type SlackHistoryMessage = Record<string, unknown> & { ts: string; type?: string; thread_ts?: string; reply_count?: number; latest_reply?: string };
export type BackfillTask = { id: number; jobId: number; workspaceId: string; channelId: string; phase: "history" | "replies"; cursor: string | null; rootTs: string | null; oldest: string; latest: string; attempts: number };
export type BackfillJob = { id: number; kind: "initial" | "manual" | "downtime"; state: string; requestedStartAt: string; requestedEndAt: string; createdAt: string; completedAt: string | null; channels: number; completedTasks: number; totalTasks: number; historyTasks: number; replyTasks: number; lastError: string | null };
export type ConsumerProgress = { consumerId: string; totalMessages: number; acknowledgedMessages: number; pendingMessages: number; lastAcknowledgedAt: string | null };

export class Database {
  readonly pool: Pool;

  constructor(connectionString: string) { this.pool = new Pool({ connectionString }); }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS slack_events (
        event_sequence BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
        api_app_id TEXT, callback_type TEXT NOT NULL, event_type TEXT, event_ts TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(), payload JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS slack_events_workspace_received_idx ON slack_events (workspace_id, received_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        event_id TEXT PRIMARY KEY REFERENCES slack_events(event_id) ON DELETE CASCADE, event_sequence BIGINT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_ts TEXT NOT NULL, thread_ts TEXT,
        user_id TEXT, subtype TEXT, text TEXT, event_payload JSONB NOT NULL, observed_at TIMESTAMPTZ NOT NULL
      );
      -- Raw events expire before normalized messages, so the latter cannot retain a foreign key to the former.
      ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_event_id_fkey;
      CREATE TABLE IF NOT EXISTS consumer_message_acks (
        consumer_id TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES messages(event_id) ON DELETE CASCADE,
        acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS consumer_message_acks_event_idx ON consumer_message_acks (event_id);
      CREATE TABLE IF NOT EXISTS consumer_thread_checkpoints (
        consumer_id TEXT NOT NULL, workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL,
        covered_through_ts TEXT NOT NULL, checkpoint JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer_id, workspace_id, channel_id, thread_ts)
      );
      CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (workspace_id, channel_id, thread_ts, event_sequence);
      CREATE INDEX IF NOT EXISTS messages_identity_idx ON messages (workspace_id, channel_id, message_ts);
      CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages (message_ts);
      CREATE INDEX IF NOT EXISTS messages_sequence_idx ON messages (event_sequence);
      CREATE TABLE IF NOT EXISTS channel_labels (
        workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, label TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_metadata (
        workspace_id TEXT PRIMARY KEY, workspace_name TEXT, last_synced_at TIMESTAMPTZ, last_attempted_at TIMESTAMPTZ, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS channel_metadata (
        workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, channel_name TEXT, conversation_type TEXT NOT NULL DEFAULT 'unknown', last_synced_at TIMESTAMPTZ, last_attempted_at TIMESTAMPTZ, last_error TEXT,
        PRIMARY KEY (workspace_id, channel_id)
      );
      ALTER TABLE channel_metadata ADD COLUMN IF NOT EXISTS conversation_type TEXT NOT NULL DEFAULT 'unknown';
      CREATE TABLE IF NOT EXISTS observation_targets (
        workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, channel_id)
      );
      CREATE TABLE IF NOT EXISTS thread_index (
        workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, root_ts TEXT NOT NULL,
        observed_reply_count INTEGER NOT NULL DEFAULT 0, fetched_reply_count INTEGER NOT NULL DEFAULT 0,
        latest_reply_ts TEXT, indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(), fetched_at TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, channel_id, root_ts)
      );
      CREATE TABLE IF NOT EXISTS backfill_jobs (
        id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('initial', 'manual', 'downtime')),
        state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'canceled')),
        requested_start_at TIMESTAMPTZ NOT NULL, requested_end_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS backfill_tasks (
        id BIGSERIAL PRIMARY KEY, job_id BIGINT NOT NULL REFERENCES backfill_jobs(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('history', 'replies')), root_ts TEXT,
        oldest TEXT NOT NULL, latest TEXT NOT NULL, cursor TEXT,
        state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'retry', 'completed', 'canceled')),
        attempts INTEGER NOT NULL DEFAULT 0, not_before TIMESTAMPTZ, last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS backfill_tasks_ready_idx ON backfill_tasks (state, not_before, id);
      CREATE UNIQUE INDEX IF NOT EXISTS backfill_reply_task_unique ON backfill_tasks (job_id, workspace_id, channel_id, root_ts) WHERE phase = 'replies';
      CREATE TABLE IF NOT EXISTS backfill_runtime (
        singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), next_request_at TIMESTAMPTZ, last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO backfill_runtime (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;
      CREATE TABLE IF NOT EXISTS observer_health (
        singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton), socket_state TEXT NOT NULL DEFAULT 'unknown',
        last_connected_at TIMESTAMPTZ, last_disconnected_at TIMESTAMPTZ, last_event_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO observer_health (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;
      CREATE TABLE IF NOT EXISTS observer_settings (
        singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
        slack_app_token TEXT, slack_user_token TEXT, slack_bot_token TEXT, mcp_auth_token TEXT,
        thread_settle_seconds INTEGER NOT NULL DEFAULT 90,
        message_retention_days INTEGER NOT NULL DEFAULT 30,
        raw_event_retention_days INTEGER NOT NULL DEFAULT 7,
        backfill_request_interval_seconds INTEGER NOT NULL DEFAULT 60,
        downtime_suggestion_seconds INTEGER NOT NULL DEFAULT 300,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO observer_settings (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING;
    `);
  }

  async storeEnvelope(envelope: SlackEnvelope): Promise<{ inserted: boolean; eventSequence?: number }> {
    const eventId = stringValue(envelope.event_id); const workspaceId = stringValue(envelope.team_id); const callbackType = stringValue(envelope.type);
    if (!eventId || !workspaceId || !callbackType) throw new Error("Slack event envelope is missing event_id, team_id, or type");
    const event = isObject(envelope.event) ? envelope.event : {};
    const insert = await this.pool.query<{ event_sequence: string }>(
      `INSERT INTO slack_events (event_id, workspace_id, api_app_id, callback_type, event_type, event_ts, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (event_id) DO NOTHING RETURNING event_sequence`,
      [eventId, workspaceId, stringValue(envelope.api_app_id), callbackType, stringValue(event.type), stringValue(event.event_ts), envelope],
    );
    if (insert.rowCount === 0) return { inserted: false };
    const eventSequence = Number(insert.rows[0].event_sequence);
    if (event.type === "message" && typeof event.channel === "string" && typeof event.ts === "string") {
      await this.upsertTarget(workspaceId, event.channel);
      await this.saveChannelConversationType(workspaceId, event.channel, conversationTypeFromSlackChannel(event));
      await this.insertMessageIfAbsent(eventId, eventSequence, workspaceId, event.channel, event, new Date().toISOString());
    }
    return { inserted: true, eventSequence };
  }

  async storeHistoryPage(task: BackfillTask, messages: SlackHistoryMessage[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Slack history pages are newest-first; sequence numbers are the agent's cursor,
      // so write the page oldest-first to keep a new backfill digest chronological.
      for (const message of [...messages].sort(compareSlackTimestamp)) {
        if (message.type && message.type !== "message") continue;
        const eventId = historyEventId(task.workspaceId, task.channelId, message.ts);
        const inserted = await client.query<{ event_sequence: string }>(
          `INSERT INTO slack_events (event_id, workspace_id, callback_type, event_type, event_ts, payload)
           VALUES ($1, $2, 'history_backfill', 'message', $3, $4) ON CONFLICT (event_id) DO NOTHING RETURNING event_sequence`,
          [eventId, task.workspaceId, message.ts, message],
        );
        if (inserted.rowCount) await this.insertMessageIfAbsent(eventId, Number(inserted.rows[0].event_sequence), task.workspaceId, task.channelId, message, new Date().toISOString(), client);
        // conversations.history normally contains root messages only; keep this guard so a
        // future Slack response variant can never turn a reply into a separate root index.
        if (typeof message.thread_ts === "string") continue;
        const replyCount = numberValue(message.reply_count) ?? 0;
        const latestReply = stringValue(message.latest_reply);
        const index = await client.query<{ fetched_reply_count: number }>(
          `INSERT INTO thread_index (workspace_id, channel_id, root_ts, observed_reply_count, latest_reply_ts, indexed_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (workspace_id, channel_id, root_ts) DO UPDATE
             SET observed_reply_count = EXCLUDED.observed_reply_count, latest_reply_ts = EXCLUDED.latest_reply_ts, indexed_at = now()
           RETURNING fetched_reply_count`,
          [task.workspaceId, task.channelId, message.ts, replyCount, latestReply],
        );
        if (replyCount > index.rows[0].fetched_reply_count) {
          await client.query(
            `INSERT INTO backfill_tasks (job_id, workspace_id, channel_id, phase, root_ts, oldest, latest)
             VALUES ($1, $2, $3, 'replies', $4, $5, $6) ON CONFLICT DO NOTHING`,
            [task.jobId, task.workspaceId, task.channelId, message.ts, task.oldest, task.latest],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async storeReplies(task: BackfillTask, messages: SlackHistoryMessage[]): Promise<void> {
    if (!task.rootTs) throw new Error("Reply task is missing root_ts");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const message of [...messages].sort(compareSlackTimestamp)) {
        if (message.type && message.type !== "message") continue;
        const eventId = historyEventId(task.workspaceId, task.channelId, message.ts);
        const inserted = await client.query<{ event_sequence: string }>(
          `INSERT INTO slack_events (event_id, workspace_id, callback_type, event_type, event_ts, payload)
           VALUES ($1, $2, 'thread_backfill', 'message', $3, $4) ON CONFLICT (event_id) DO NOTHING RETURNING event_sequence`,
          [eventId, task.workspaceId, message.ts, message],
        );
        if (inserted.rowCount) await this.insertMessageIfAbsent(eventId, Number(inserted.rows[0].event_sequence), task.workspaceId, task.channelId, message, new Date().toISOString(), client);
      }
      await client.query(
        `UPDATE thread_index SET fetched_reply_count = observed_reply_count, fetched_at = now()
         WHERE workspace_id = $1 AND channel_id = $2 AND root_ts = $3`, [task.workspaceId, task.channelId, task.rootTs],
      );
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async threadNeedsRefresh(task: BackfillTask): Promise<boolean> {
    if (!task.rootTs) return false;
    const result = await this.pool.query<{ needed: boolean }>(
      `SELECT observed_reply_count > fetched_reply_count AS needed FROM thread_index WHERE workspace_id = $1 AND channel_id = $2 AND root_ts = $3`,
      [task.workspaceId, task.channelId, task.rootTs],
    );
    return result.rows[0]?.needed === true;
  }

  async createBackfillJob(kind: "initial" | "manual" | "downtime", startAt: Date, endAt: Date, retentionDays: number): Promise<{ job: BackfillJob; targetCount: number }> {
    if (startAt >= endAt) throw new Error("Backfill start must be before end");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const targets = await client.query<{ workspace_id: string; channel_id: string }>("SELECT workspace_id, channel_id FROM observation_targets WHERE enabled ORDER BY workspace_id, channel_id");
      const job = await client.query<{ id: string }>(
        `INSERT INTO backfill_jobs (kind, requested_start_at, requested_end_at) VALUES ($1, $2, $3) RETURNING id`, [kind, startAt, endAt],
      );
      const scanStart = backfillWindow(startAt, endAt, retentionDays).startAt.toISOString();
      for (const target of targets.rows) {
        await client.query(
          `INSERT INTO backfill_tasks (job_id, workspace_id, channel_id, phase, oldest, latest) VALUES ($1, $2, $3, 'history', $4, $5)`,
          [job.rows[0].id, target.workspace_id, target.channel_id, scanStart, endAt.toISOString()],
        );
      }
      if (!targets.rowCount) await client.query(`UPDATE backfill_jobs SET state = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`, [job.rows[0].id]);
      await client.query("COMMIT");
      return { job: await this.getBackfillJob(Number(job.rows[0].id)), targetCount: targets.rowCount ?? 0 };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async addObservationTarget(workspaceId: string, channelId: string): Promise<void> { await this.upsertTarget(workspaceId, channelId); }
  async registerUserVisibleConversations(workspaceId: string, workspaceName: string | null, conversations: UserVisibleConversation[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (workspaceName) {
        await client.query(`INSERT INTO workspace_metadata (workspace_id, workspace_name, last_synced_at, last_attempted_at, last_error)
          VALUES ($1, $2, now(), now(), NULL)
          ON CONFLICT (workspace_id) DO UPDATE SET workspace_name = EXCLUDED.workspace_name, last_synced_at = now(), last_attempted_at = now(), last_error = NULL`, [workspaceId, workspaceName]);
      }
      for (const conversation of conversations) {
        await client.query(`INSERT INTO observation_targets (workspace_id, channel_id, enabled) VALUES ($1, $2, false)
          ON CONFLICT (workspace_id, channel_id) DO UPDATE SET updated_at = now()`, [workspaceId, conversation.channelId]);
        await client.query(`INSERT INTO channel_metadata (workspace_id, channel_id, channel_name, conversation_type, last_synced_at, last_attempted_at, last_error)
          VALUES ($1, $2, $3, $4, now(), now(), NULL)
          ON CONFLICT (workspace_id, channel_id) DO UPDATE SET channel_name = COALESCE(EXCLUDED.channel_name, channel_metadata.channel_name), conversation_type = CASE WHEN EXCLUDED.conversation_type = 'unknown' THEN channel_metadata.conversation_type ELSE EXCLUDED.conversation_type END, last_synced_at = now(), last_attempted_at = now(), last_error = NULL`, [workspaceId, conversation.channelId, conversation.channelName, conversation.conversationType]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async setObservationTargetEnabled(workspaceId: string, channelId: string, enabled: boolean): Promise<void> {
    await this.pool.query(`UPDATE observation_targets SET enabled = $3, updated_at = now() WHERE workspace_id = $1 AND channel_id = $2`, [workspaceId, channelId, enabled]);
  }

  async claimBackfillTask(): Promise<BackfillTask | null> {
    const result = await this.pool.query<TaskRow>(
      `WITH candidate AS (
         SELECT t.id FROM backfill_tasks t JOIN backfill_jobs j ON j.id = t.job_id
         WHERE t.state IN ('queued', 'retry') AND j.state IN ('queued', 'running')
           AND (t.not_before IS NULL OR t.not_before <= now())
         ORDER BY t.id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE backfill_tasks t SET state = 'running', attempts = attempts + 1, updated_at = now()
       FROM candidate WHERE t.id = candidate.id
       RETURNING t.id::text, t.job_id::text, t.workspace_id, t.channel_id, t.phase, t.cursor, t.root_ts, t.oldest, t.latest, t.attempts`,
    );
    if (!result.rowCount) return null;
    await this.pool.query(`UPDATE backfill_jobs SET state = 'running', updated_at = now() WHERE id = $1 AND state = 'queued'`, [result.rows[0].job_id]);
    return toTask(result.rows[0]);
  }

  async completeHistoryTask(taskId: number, cursor: string | null): Promise<void> {
    const statement = historyCheckpointStatement(taskId, cursor);
    await this.pool.query(statement.text, statement.values);
    await this.finishJobIfDone(taskId);
  }
  async completeBackfillTask(taskId: number): Promise<void> {
    await this.pool.query(`UPDATE backfill_tasks SET state = 'completed', completed_at = now(), updated_at = now(), last_error = NULL WHERE id = $1`, [taskId]);
    await this.finishJobIfDone(taskId);
  }
  async retryBackfillTask(taskId: number, error: string, retryAt: Date): Promise<void> {
    await this.pool.query(`UPDATE backfill_tasks SET state = 'retry', not_before = $2, last_error = $3, updated_at = now() WHERE id = $1`, [taskId, retryAt, error]);
    await this.pool.query(`UPDATE backfill_jobs SET last_error = $2, updated_at = now() WHERE id = (SELECT job_id FROM backfill_tasks WHERE id = $1)`, [taskId, error]);
  }
  async cancelBackfillJob(jobId: number): Promise<void> {
    await this.pool.query(`UPDATE backfill_jobs SET state = 'canceled', updated_at = now() WHERE id = $1 AND state IN ('queued', 'running')`, [jobId]);
    await this.pool.query(`UPDATE backfill_tasks SET state = 'canceled', updated_at = now() WHERE job_id = $1 AND state IN ('queued', 'retry')`, [jobId]);
  }
  async backfillRuntime(): Promise<{ nextRequestAt: string | null }> {
    const result = await this.pool.query<{ next_request_at: string | null }>("SELECT next_request_at::text FROM backfill_runtime WHERE singleton");
    return { nextRequestAt: result.rows[0].next_request_at };
  }
  async setBackfillRuntime(nextRequestAt: Date, error: string | null = null): Promise<void> {
    await this.pool.query(`UPDATE backfill_runtime SET next_request_at = $1, last_error = $2, updated_at = now() WHERE singleton`, [nextRequestAt, error]);
  }

  async markSocketConnected(minGapSeconds: number, retentionDays: number): Promise<{ job: BackfillJob; targetCount: number } | undefined> {
    const result = await this.pool.query<{ checkpoint: string | null }>(
      `SELECT COALESCE(last_disconnected_at, last_event_at, last_connected_at)::text AS checkpoint FROM observer_health WHERE singleton`,
    );
    const checkpoint = result.rows[0].checkpoint;
    const now = new Date();
    await this.pool.query(`UPDATE observer_health SET socket_state = 'connected', last_connected_at = $1, last_disconnected_at = NULL, updated_at = $1 WHERE singleton`, [now]);
    const recoveryWindow = detectedRecoveryWindow(checkpoint ? new Date(checkpoint) : null, now, minGapSeconds, retentionDays);
    return recoveryWindow ? this.queueAutomaticRecovery(recoveryWindow.startAt, recoveryWindow.endAt, retentionDays) : undefined;
  }
  async markSocketDisconnected(): Promise<void> { await this.pool.query(`UPDATE observer_health SET socket_state = 'disconnected', last_disconnected_at = now(), updated_at = now() WHERE singleton`); }
  async markSocketEvent(): Promise<void> { await this.pool.query(`UPDATE observer_health SET last_event_at = now(), updated_at = now() WHERE singleton`); }
  async promotePendingBackfillSuggestions(retentionDays: number): Promise<number> {
    const table = await this.pool.query<{ name: string | null }>("SELECT to_regclass('backfill_suggestions')::text AS name");
    if (!table.rows[0]?.name) return 0;
    const pending = await this.pool.query<{ id: string; start_at: string; end_at: string }>(
      "SELECT id::text, start_at::text, end_at::text FROM backfill_suggestions WHERE state = 'pending' ORDER BY id",
    );
    for (const suggestion of pending.rows) {
      await this.queueAutomaticRecovery(new Date(suggestion.start_at), new Date(suggestion.end_at), retentionDays);
      await this.pool.query("UPDATE backfill_suggestions SET state = 'accepted' WHERE id = $1 AND state = 'pending'", [suggestion.id]);
    }
    return pending.rowCount ?? 0;
  }

  async purgeExpired(rawEventRetentionDays: number, messageRetentionDays: number): Promise<void> {
    await this.pool.query(`DELETE FROM slack_events WHERE received_at < now() - make_interval(days => $1)`, [rawEventRetentionDays]);
    await this.pool.query(
      `DELETE FROM messages m WHERE to_timestamp(m.message_ts::double precision) < now() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM messages recent WHERE recent.workspace_id = m.workspace_id AND recent.channel_id = m.channel_id
         AND recent.thread_ts = m.message_ts AND to_timestamp(recent.message_ts::double precision) >= now() - make_interval(days => $1))`, [messageRetentionDays],
    );
    await this.pool.query(
      `DELETE FROM thread_index i WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = i.workspace_id AND m.channel_id = i.channel_id AND m.message_ts = i.root_ts)`,
    );
    await this.pool.query(`DELETE FROM consumer_thread_checkpoints c WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = c.workspace_id AND m.channel_id = c.channel_id AND m.message_ts = c.thread_ts)`);
  }

  async latestSequence(): Promise<number> {
    const result = await this.pool.query<{ value: string }>("SELECT COALESCE(MAX(event_sequence), 0)::text AS value FROM messages");
    return Number(result.rows[0].value);
  }
  async changedMessages(afterSequence: number, upperSequence: number, settleSeconds: number): Promise<StoredMessage[]> {
    const result = await this.pool.query<MessageRow>(`${messageSelect}
       WHERE m.event_sequence > $1 AND m.event_sequence <= $2 AND m.observed_at <= now() - make_interval(secs => $3) ORDER BY m.event_sequence ASC`, [afterSequence, upperSequence, settleSeconds]);
    return result.rows.map(toStoredMessage);
  }
  async pendingMessages(consumerId: string, upperSequence: number, settleSeconds: number): Promise<StoredMessage[]> {
    const result = await this.pool.query<MessageRow>(`${messageSelect}
       WHERE m.event_sequence <= $1 AND m.observed_at <= now() - make_interval(secs => $2)
       AND NOT EXISTS (SELECT 1 FROM consumer_message_acks a WHERE a.consumer_id = $3 AND a.event_id = m.event_id)
       ORDER BY m.event_sequence ASC`, [upperSequence, settleSeconds, consumerId]);
    return result.rows.map(toStoredMessage);
  }
  async acknowledgeMessages(consumerId: string, eventIds: string[]): Promise<{ acknowledgedEventIds: string[]; alreadyAcknowledgedEventIds: string[]; unknownEventIds: string[] }> {
    const uniqueEventIds = [...new Set(eventIds)];
    const result = await this.pool.query<{ event_id: string; is_known: boolean; inserted: boolean }>(
      `WITH input AS (SELECT DISTINCT unnest($2::text[]) AS event_id),
       known AS (SELECT input.event_id FROM input JOIN messages m USING (event_id)),
       inserted AS (
         INSERT INTO consumer_message_acks (consumer_id, event_id)
         SELECT $1, event_id FROM known ON CONFLICT DO NOTHING RETURNING event_id
       )
       SELECT input.event_id, EXISTS (SELECT 1 FROM known WHERE known.event_id = input.event_id) AS is_known,
         EXISTS (SELECT 1 FROM inserted WHERE inserted.event_id = input.event_id) AS inserted
       FROM input`, [consumerId, uniqueEventIds],
    );
    return {
      acknowledgedEventIds: result.rows.filter((row) => row.inserted).map((row) => row.event_id),
      alreadyAcknowledgedEventIds: result.rows.filter((row) => row.is_known && !row.inserted).map((row) => row.event_id),
      unknownEventIds: result.rows.filter((row) => !row.is_known).map((row) => row.event_id),
    };
  }
  async saveThreadCheckpoint(consumerId: string, workspaceId: string, channelId: string, threadTs: string, coveredThroughTs: string, checkpoint: ThreadCheckpoint): Promise<void> {
    await this.pool.query(`INSERT INTO consumer_thread_checkpoints (consumer_id, workspace_id, channel_id, thread_ts, covered_through_ts, checkpoint)
      VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (consumer_id, workspace_id, channel_id, thread_ts) DO UPDATE
      SET covered_through_ts = EXCLUDED.covered_through_ts, checkpoint = EXCLUDED.checkpoint, updated_at = now()`, [consumerId, workspaceId, channelId, threadTs, coveredThroughTs, checkpoint]);
  }
  async acknowledgeMessagesAndSaveCheckpoint(consumerId: string, eventIds: string[], workspaceId: string, channelId: string, threadTs: string, coveredThroughTs: string, checkpoint: ThreadCheckpoint): Promise<{ acknowledgedEventIds: string[]; alreadyAcknowledgedEventIds: string[]; unknownEventIds: string[] }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const uniqueEventIds = [...new Set(eventIds)];
      const result = await client.query<{ event_id: string; is_known: boolean; inserted: boolean }>(
        `WITH input AS (SELECT DISTINCT unnest($2::text[]) AS event_id), known AS (SELECT input.event_id FROM input JOIN messages m USING (event_id)), inserted AS (
          INSERT INTO consumer_message_acks (consumer_id, event_id) SELECT $1, event_id FROM known ON CONFLICT DO NOTHING RETURNING event_id
        ) SELECT input.event_id, EXISTS (SELECT 1 FROM known WHERE known.event_id = input.event_id) AS is_known, EXISTS (SELECT 1 FROM inserted WHERE inserted.event_id = input.event_id) AS inserted FROM input`, [consumerId, uniqueEventIds],
      );
      await client.query(`INSERT INTO consumer_thread_checkpoints (consumer_id, workspace_id, channel_id, thread_ts, covered_through_ts, checkpoint)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (consumer_id, workspace_id, channel_id, thread_ts) DO UPDATE
        SET covered_through_ts = EXCLUDED.covered_through_ts, checkpoint = EXCLUDED.checkpoint, updated_at = now()`, [consumerId, workspaceId, channelId, threadTs, coveredThroughTs, checkpoint]);
      await client.query("COMMIT");
      return { acknowledgedEventIds: result.rows.filter((row) => row.inserted).map((row) => row.event_id), alreadyAcknowledgedEventIds: result.rows.filter((row) => row.is_known && !row.inserted).map((row) => row.event_id), unknownEventIds: result.rows.filter((row) => !row.is_known).map((row) => row.event_id) };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async threadCheckpoints(consumerId: string, messages: StoredMessage[]): Promise<Map<string, ThreadCheckpoint>> {
    const keys = [...new Map(messages.filter((item) => item.threadTs).map((item) => [`${item.workspaceId}\u0000${item.channelId}\u0000${item.threadTs}`, item])).values()];
    if (!keys.length) return new Map();
    const values: string[] = [consumerId]; const clauses = keys.map((item) => { const i = values.length; values.push(item.workspaceId, item.channelId, item.threadTs!); return `(workspace_id = $${i + 1} AND channel_id = $${i + 2} AND thread_ts = $${i + 3})`; });
    const result = await this.pool.query<{ workspace_id: string; channel_id: string; thread_ts: string; checkpoint: ThreadCheckpoint }>(`SELECT workspace_id, channel_id, thread_ts, checkpoint FROM consumer_thread_checkpoints WHERE consumer_id = $1 AND (${clauses.join(" OR ")})`, values);
    return new Map(result.rows.map((row) => [`${row.workspace_id}\u0000${row.channel_id}\u0000${row.thread_ts}`, row.checkpoint]));
  }
  async reopenedThreads(consumerId: string, messages: StoredMessage[]): Promise<Set<string>> {
    const keys = [...new Map(messages.filter((item) => item.threadTs).map((item) => [`${item.workspaceId}\u0000${item.channelId}\u0000${item.threadTs}`, item])).values()];
    if (!keys.length) return new Set();
    const values: string[] = [consumerId]; const clauses = keys.map((item) => { const i = values.length; values.push(item.workspaceId, item.channelId, item.threadTs!); return `(m.workspace_id = $${i + 1} AND m.channel_id = $${i + 2} AND (m.thread_ts = $${i + 3} OR m.message_ts = $${i + 3}))`; });
    const result = await this.pool.query<{ workspace_id: string; channel_id: string; thread_ts: string }>(`SELECT DISTINCT m.workspace_id, m.channel_id, COALESCE(m.thread_ts, m.message_ts) AS thread_ts FROM messages m JOIN consumer_message_acks a ON a.event_id = m.event_id AND a.consumer_id = $1 WHERE ${clauses.join(" OR ")}`, values);
    return new Set(result.rows.map((row) => `${row.workspace_id}\u0000${row.channel_id}\u0000${row.thread_ts}`));
  }
  /** Returns the complete locally retained history for each touched thread. It performs no Slack API call. */
  async hydrateThreads(changed: StoredMessage[], skipThreadKeys = new Set<string>()): Promise<StoredMessage[]> {
    const keys = [...new Map(changed.filter((item) => item.threadTs && !skipThreadKeys.has(`${item.workspaceId}\u0000${item.channelId}\u0000${item.threadTs}`)).map((item) => [`${item.workspaceId}\u0000${item.channelId}\u0000${item.threadTs}`, item])).values()];
    if (!keys.length) return changed;
    const values: string[] = []; const clauses = keys.map((item) => { const index = values.length; values.push(item.workspaceId, item.channelId, item.threadTs!); return `(m.workspace_id = $${index + 1} AND m.channel_id = $${index + 2} AND (m.thread_ts = $${index + 3} OR m.message_ts = $${index + 3}))`; });
    const result = await this.pool.query<MessageRow>(`${messageSelect} WHERE ${clauses.join(" OR ")} ORDER BY m.event_sequence ASC`, values);
    const byId = new Map<string, StoredMessage>(); for (const message of [...changed, ...result.rows.map(toStoredMessage)]) byId.set(message.eventId, message);
    return [...byId.values()].sort((a, b) => a.eventSequence - b.eventSequence);
  }
  async getThread(workspaceId: string, channelId: string, threadTs: string, afterMessageTs: string | undefined, settleSeconds: number): Promise<StoredMessage[]> {
    const result = await this.pool.query<MessageRow>(`${messageSelect} WHERE m.workspace_id = $1 AND m.channel_id = $2 AND (m.thread_ts = $3 OR m.message_ts = $3) AND m.observed_at <= now() - make_interval(secs => $4) ORDER BY m.message_ts ASC`, [workspaceId, channelId, threadTs, settleSeconds]);
    const messages = result.rows.map(toStoredMessage); if (!afterMessageTs) return messages;
    const root = messages.find((item) => item.messageTs === threadTs); return [...(root ? [root] : []), ...messages.filter((item) => item.messageTs > afterMessageTs && item.messageTs !== threadTs)];
  }
  async getMessage(workspaceId: string, channelId: string, messageTs: string): Promise<StoredMessage | undefined> {
    const result = await this.pool.query<MessageRow>(`${messageSelect} WHERE m.workspace_id = $1 AND m.channel_id = $2 AND m.message_ts = $3`, [workspaceId, channelId, messageTs]);
    return result.rows[0] ? toStoredMessage(result.rows[0]) : undefined;
  }

  async listChannels(): Promise<Array<{ workspaceId: string; workspaceName: string | null; channelId: string; channelName: string | null; conversationType: ConversationType; enabled: boolean; messageCount: number; lastObservedAt: string | null }>> {
    const result = await this.pool.query<ChannelRow>(
      `SELECT t.workspace_id, wm.workspace_name, t.channel_id, cm.channel_name, cm.conversation_type, t.enabled, count(m.event_id)::text AS message_count, max(m.observed_at)::text AS last_observed_at
       FROM observation_targets t LEFT JOIN messages m ON m.workspace_id = t.workspace_id AND m.channel_id = t.channel_id
       LEFT JOIN workspace_metadata wm ON wm.workspace_id = t.workspace_id LEFT JOIN channel_metadata cm ON cm.workspace_id = t.workspace_id AND cm.channel_id = t.channel_id
      GROUP BY t.workspace_id, wm.workspace_name, t.channel_id, cm.channel_name, cm.conversation_type, t.enabled ORDER BY max(m.observed_at) DESC NULLS LAST, t.channel_id`,
    );
    return result.rows.map((row) => ({ workspaceId: row.workspace_id, workspaceName: row.workspace_name, channelId: row.channel_id, channelName: row.channel_name, conversationType: conversationTypeFromStoredValue(row.conversation_type), enabled: row.enabled, messageCount: Number(row.message_count), lastObservedAt: row.last_observed_at }));
  }
  async metadataLookupDue(workspaceId: string, channelId: string, maxAgeHours = 24): Promise<{ workspace: boolean; channel: boolean }> {
    const result = await this.pool.query<{ workspace_due: boolean; channel_due: boolean }>(
      `SELECT NOT EXISTS (SELECT 1 FROM workspace_metadata WHERE workspace_id = $1 AND ((workspace_name IS NOT NULL AND last_synced_at > now() - make_interval(hours => $3)) OR last_attempted_at > now() - interval '15 minutes')) AS workspace_due,
       NOT EXISTS (SELECT 1 FROM channel_metadata WHERE workspace_id = $1 AND channel_id = $2 AND conversation_type <> 'unknown' AND ((channel_name IS NOT NULL AND last_synced_at > now() - make_interval(hours => $3)) OR last_attempted_at > now() - interval '15 minutes')) AS channel_due`, [workspaceId, channelId, maxAgeHours]);
    return { workspace: result.rows[0].workspace_due, channel: result.rows[0].channel_due };
  }
  async saveWorkspaceMetadata(workspaceId: string, workspaceName: string): Promise<void> { await this.pool.query(`INSERT INTO workspace_metadata (workspace_id, workspace_name, last_synced_at, last_attempted_at, last_error) VALUES ($1, $2, now(), now(), NULL) ON CONFLICT (workspace_id) DO UPDATE SET workspace_name = EXCLUDED.workspace_name, last_synced_at = now(), last_attempted_at = now(), last_error = NULL`, [workspaceId, workspaceName]); }
  async saveChannelMetadata(workspaceId: string, channelId: string, channelName: string, conversationType: ConversationType): Promise<void> { await this.pool.query(`INSERT INTO channel_metadata (workspace_id, channel_id, channel_name, conversation_type, last_synced_at, last_attempted_at, last_error) VALUES ($1, $2, $3, $4, now(), now(), NULL) ON CONFLICT (workspace_id, channel_id) DO UPDATE SET channel_name = EXCLUDED.channel_name, conversation_type = CASE WHEN EXCLUDED.conversation_type = 'unknown' THEN channel_metadata.conversation_type ELSE EXCLUDED.conversation_type END, last_synced_at = now(), last_attempted_at = now(), last_error = NULL`, [workspaceId, channelId, channelName, conversationType]); }
  async saveMetadataError(workspaceId: string, channelId: string, error: string): Promise<void> {
    await this.pool.query(`INSERT INTO workspace_metadata (workspace_id, last_attempted_at, last_error) VALUES ($1, now(), $2) ON CONFLICT (workspace_id) DO UPDATE SET last_attempted_at = now(), last_error = EXCLUDED.last_error`, [workspaceId, error]);
    await this.pool.query(`INSERT INTO channel_metadata (workspace_id, channel_id, last_attempted_at, last_error) VALUES ($1, $2, now(), $3) ON CONFLICT (workspace_id, channel_id) DO UPDATE SET last_attempted_at = now(), last_error = EXCLUDED.last_error`, [workspaceId, channelId, error]);
  }
  async listBackfillJobs(): Promise<BackfillJob[]> {
    const result = await this.pool.query<JobRow>(`SELECT j.id::text, j.kind, j.state, j.requested_start_at::text, j.requested_end_at::text, j.created_at::text, j.completed_at::text, j.last_error,
      count(DISTINCT (t.workspace_id, t.channel_id))::text AS channels, count(*) FILTER (WHERE t.state = 'completed')::text AS completed_tasks, count(*)::text AS total_tasks,
      count(*) FILTER (WHERE t.phase = 'history')::text AS history_tasks, count(*) FILTER (WHERE t.phase = 'replies')::text AS reply_tasks
      FROM backfill_jobs j LEFT JOIN backfill_tasks t ON t.job_id = j.id GROUP BY j.id ORDER BY j.id DESC LIMIT 20`);
    return result.rows.map(toJob);
  }
  async dashboardStatus(): Promise<{ events: number; messages: number; lastReceivedAt: string | null; channels: number; earliestMessageAt: string | null; nextBackfillRequestAt: string | null; consumers: ConsumerProgress[] }> {
    const result = await this.pool.query<{ events: string; messages: string; last_received_at: string | null; channels: string; earliest_message_at: string | null; next_request_at: string | null }>(
      `SELECT (SELECT count(*) FROM slack_events)::text AS events, (SELECT count(*) FROM messages)::text AS messages,
       (SELECT max(received_at)::text FROM slack_events) AS last_received_at, (SELECT count(*) FROM observation_targets WHERE enabled)::text AS channels,
       (SELECT min(to_timestamp(message_ts::double precision))::text FROM messages) AS earliest_message_at,
       (SELECT next_request_at::text FROM backfill_runtime WHERE singleton) AS next_request_at`);
    const consumers = await this.pool.query<{ consumer_id: string; total_messages: string; acknowledged_messages: string; pending_messages: string; last_acknowledged_at: string | null }>(
      `WITH consumers AS (SELECT DISTINCT consumer_id FROM consumer_message_acks)
       SELECT c.consumer_id, count(m.event_id)::text AS total_messages, count(a.event_id)::text AS acknowledged_messages,
         (count(m.event_id) - count(a.event_id))::text AS pending_messages, max(a.acknowledged_at)::text AS last_acknowledged_at
       FROM consumers c CROSS JOIN messages m
       LEFT JOIN consumer_message_acks a ON a.consumer_id = c.consumer_id AND a.event_id = m.event_id
       GROUP BY c.consumer_id ORDER BY max(a.acknowledged_at) DESC NULLS LAST, c.consumer_id`);
    const row = result.rows[0]; return { events: Number(row.events), messages: Number(row.messages), lastReceivedAt: row.last_received_at, channels: Number(row.channels), earliestMessageAt: row.earliest_message_at, nextBackfillRequestAt: row.next_request_at, consumers: consumers.rows.map(toConsumerProgress) };
  }
  async observerSettings(): Promise<ObserverSettings> {
    const result = await this.pool.query<SettingsRow>(`SELECT slack_app_token, slack_user_token, slack_bot_token, mcp_auth_token, thread_settle_seconds, message_retention_days, raw_event_retention_days, backfill_request_interval_seconds, downtime_suggestion_seconds FROM observer_settings WHERE singleton`);
    const row = result.rows[0];
    if (!row) return { ...defaultSettings };
    return {
      slackAppToken: row.slack_app_token ?? undefined, slackUserToken: row.slack_user_token ?? undefined, slackBotToken: row.slack_bot_token ?? undefined, mcpAuthToken: row.mcp_auth_token ?? undefined,
      threadSettleSeconds: row.thread_settle_seconds, messageRetentionDays: row.message_retention_days, rawEventRetentionDays: row.raw_event_retention_days,
      backfillRequestIntervalSeconds: row.backfill_request_interval_seconds, downtimeSuggestionSeconds: row.downtime_suggestion_seconds,
    };
  }
  async saveObserverSettings(settings: ObserverSettings): Promise<void> {
    await this.pool.query(`UPDATE observer_settings SET slack_app_token = $1, slack_user_token = $2, slack_bot_token = $3, mcp_auth_token = $4, thread_settle_seconds = $5, message_retention_days = $6, raw_event_retention_days = $7, backfill_request_interval_seconds = $8, downtime_suggestion_seconds = $9, updated_at = now() WHERE singleton`, [settings.slackAppToken ?? null, settings.slackUserToken ?? null, settings.slackBotToken ?? null, settings.mcpAuthToken ?? null, settings.threadSettleSeconds, settings.messageRetentionDays, settings.rawEventRetentionDays, settings.backfillRequestIntervalSeconds, settings.downtimeSuggestionSeconds]);
  }
  async close(): Promise<void> { await this.pool.end(); }

  private async queueAutomaticRecovery(startAt: Date, endAt: Date, retentionDays: number): Promise<{ job: BackfillJob; targetCount: number }> {
    const window = backfillWindow(startAt, endAt, retentionDays);
    const existing = await this.pool.query<{ id: string }>(
      `SELECT id::text FROM backfill_jobs
       WHERE kind = 'downtime' AND state IN ('queued', 'running')
         AND requested_start_at <= $2 AND requested_end_at >= $1
       LIMIT 1`, [window.startAt, window.endAt],
    );
    if (existing.rowCount) return { job: await this.getBackfillJob(Number(existing.rows[0].id)), targetCount: 0 };
    return this.createBackfillJob("downtime", window.startAt, window.endAt, retentionDays);
  }
  private async upsertTarget(workspaceId: string, channelId: string): Promise<void> { await this.pool.query(`INSERT INTO observation_targets (workspace_id, channel_id) VALUES ($1, $2) ON CONFLICT (workspace_id, channel_id) DO UPDATE SET updated_at = now()`, [workspaceId, channelId]); }
  private async saveChannelConversationType(workspaceId: string, channelId: string, conversationType: ConversationType): Promise<void> { await this.pool.query(`INSERT INTO channel_metadata (workspace_id, channel_id, conversation_type) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, channel_id) DO UPDATE SET conversation_type = CASE WHEN EXCLUDED.conversation_type = 'unknown' THEN channel_metadata.conversation_type ELSE EXCLUDED.conversation_type END`, [workspaceId, channelId, conversationType]); }
  private async insertMessageIfAbsent(eventId: string, eventSequence: number, workspaceId: string, channelId: string, message: Record<string, unknown>, observedAt: string, client: Pool | PoolClient = this.pool): Promise<void> {
    const exists = await client.query<{ event_id: string }>(`SELECT event_id FROM messages WHERE workspace_id = $1 AND channel_id = $2 AND message_ts = $3 LIMIT 1`, [workspaceId, channelId, message.ts]);
    if (exists.rowCount) return;
    await client.query(`INSERT INTO messages (event_id, event_sequence, workspace_id, channel_id, message_ts, thread_ts, user_id, subtype, text, event_payload, observed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [eventId, eventSequence, workspaceId, channelId, message.ts, stringValue(message.thread_ts), stringValue(message.user), stringValue(message.subtype), stringValue(message.text), message, observedAt]);
  }
  private async finishJobIfDone(taskId: number): Promise<void> { await this.pool.query(`UPDATE backfill_jobs j SET state = 'completed', completed_at = now(), updated_at = now() WHERE j.id = (SELECT job_id FROM backfill_tasks WHERE id = $1) AND NOT EXISTS (SELECT 1 FROM backfill_tasks t WHERE t.job_id = j.id AND t.state NOT IN ('completed', 'canceled'))`, [taskId]); }
  private async getBackfillJob(id: number): Promise<BackfillJob> { const jobs = await this.pool.query<JobRow>(`SELECT j.id::text, j.kind, j.state, j.requested_start_at::text, j.requested_end_at::text, j.created_at::text, j.completed_at::text, j.last_error, count(DISTINCT (t.workspace_id, t.channel_id))::text AS channels, count(*) FILTER (WHERE t.state = 'completed')::text AS completed_tasks, count(*)::text AS total_tasks, count(*) FILTER (WHERE t.phase = 'history')::text AS history_tasks, count(*) FILTER (WHERE t.phase = 'replies')::text AS reply_tasks FROM backfill_jobs j LEFT JOIN backfill_tasks t ON t.job_id = j.id WHERE j.id = $1 GROUP BY j.id`, [id]); return toJob(jobs.rows[0]); }
}

const messageSelect = `SELECT m.event_id, m.event_sequence::text, m.workspace_id, m.channel_id, m.message_ts, m.thread_ts, m.user_id, m.subtype, m.text, m.event_payload, m.observed_at::text, wm.workspace_name, cm.channel_name, cm.conversation_type FROM messages m LEFT JOIN workspace_metadata wm USING (workspace_id) LEFT JOIN channel_metadata cm USING (workspace_id, channel_id)`;
type MessageRow = { event_id: string; event_sequence: string; workspace_id: string; channel_id: string; message_ts: string; thread_ts: string | null; user_id: string | null; subtype: string | null; text: string | null; event_payload: Record<string, unknown>; observed_at: string; workspace_name: string | null; channel_name: string | null; conversation_type: string | null };
type TaskRow = { id: string; job_id: string; workspace_id: string; channel_id: string; phase: "history" | "replies"; cursor: string | null; root_ts: string | null; oldest: string; latest: string; attempts: number };
type ChannelRow = { workspace_id: string; workspace_name: string | null; channel_id: string; channel_name: string | null; conversation_type: string | null; enabled: boolean; message_count: string; last_observed_at: string | null };
type JobRow = { id: string; kind: "initial" | "manual" | "downtime"; state: string; requested_start_at: string; requested_end_at: string; created_at: string; completed_at: string | null; last_error: string | null; channels: string; completed_tasks: string; total_tasks: string; history_tasks: string; reply_tasks: string };
type SettingsRow = { slack_app_token: string | null; slack_user_token: string | null; slack_bot_token: string | null; mcp_auth_token: string | null; thread_settle_seconds: number; message_retention_days: number; raw_event_retention_days: number; backfill_request_interval_seconds: number; downtime_suggestion_seconds: number };
function toStoredMessage(row: MessageRow): StoredMessage { return { eventId: row.event_id, eventSequence: Number(row.event_sequence), workspaceId: row.workspace_id, channelId: row.channel_id, conversationType: conversationTypeFromStoredValue(row.conversation_type), messageTs: row.message_ts, threadTs: row.thread_ts, userId: row.user_id, subtype: row.subtype, text: row.text, payload: row.event_payload, observedAt: row.observed_at, workspaceName: row.workspace_name, channelName: row.channel_name }; }
export function toConsumerProgress(row: { consumer_id: string; total_messages: string; acknowledged_messages: string; pending_messages: string; last_acknowledged_at: string | null }): ConsumerProgress { return { consumerId: row.consumer_id, totalMessages: Number(row.total_messages), acknowledgedMessages: Number(row.acknowledged_messages), pendingMessages: Number(row.pending_messages), lastAcknowledgedAt: row.last_acknowledged_at }; }
function toTask(row: TaskRow): BackfillTask { return { id: Number(row.id), jobId: Number(row.job_id), workspaceId: row.workspace_id, channelId: row.channel_id, phase: row.phase, cursor: row.cursor, rootTs: row.root_ts, oldest: row.oldest, latest: row.latest, attempts: row.attempts }; }
function toJob(row: JobRow): BackfillJob { return { id: Number(row.id), kind: row.kind, state: row.state, requestedStartAt: row.requested_start_at, requestedEndAt: row.requested_end_at, createdAt: row.created_at, completedAt: row.completed_at, channels: Number(row.channels), completedTasks: Number(row.completed_tasks), totalTasks: Number(row.total_tasks), historyTasks: Number(row.history_tasks), replyTasks: Number(row.reply_tasks), lastError: row.last_error }; }
function historyEventId(workspaceId: string, channelId: string, ts: string): string { return `history:${workspaceId}:${channelId}:${ts}`; }
function stringValue(value: unknown): string | null { return typeof value === "string" ? value : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null; }
function compareSlackTimestamp(left: SlackHistoryMessage, right: SlackHistoryMessage): number { return Number(left.ts) - Number(right.ts); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export function historyCheckpointStatement(taskId: number, cursor: string | null): { text: string; values: Array<number | string> } {
  if (cursor === null) {
    return {
      text: `UPDATE backfill_tasks SET cursor = NULL, state = 'completed', completed_at = now(), updated_at = now(), last_error = NULL WHERE id = $1`,
      values: [taskId],
    };
  }
  return {
    text: `UPDATE backfill_tasks SET cursor = $2, state = 'queued', completed_at = NULL, updated_at = now(), last_error = NULL WHERE id = $1`,
    values: [taskId, cursor],
  };
}

/** Keeps every requested fetch within the retained local context window. */
export function backfillWindow(requestedStartAt: Date, requestedEndAt: Date, retentionDays: number): { startAt: Date; endAt: Date } {
  const retainedStartAt = new Date(requestedEndAt.getTime() - retentionDays * 86_400_000);
  return { startAt: new Date(Math.max(requestedStartAt.getTime(), retainedStartAt.getTime())), endAt: new Date(requestedEndAt) };
}

export function detectedRecoveryWindow(checkpoint: Date | null, recoveredAt: Date, minGapSeconds: number, retentionDays: number): { startAt: Date; endAt: Date } | undefined {
  if (!checkpoint || recoveredAt.getTime() - checkpoint.getTime() < minGapSeconds * 1000) return undefined;
  return backfillWindow(checkpoint, recoveredAt, retentionDays);
}
