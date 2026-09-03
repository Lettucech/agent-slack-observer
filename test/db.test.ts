import assert from "node:assert/strict";
import test from "node:test";
import { backfillWindow, Database, detectedRecoveryWindow, historyCheckpointStatement, textForSlackMessageEvent, toConsumerProgress } from "../src/db.js";

test("finishes the last history page without binding an untyped null cursor", () => {
  const statement = historyCheckpointStatement(42, null);
  assert.match(statement.text, /cursor = NULL/);
  assert.match(statement.text, /state = 'completed'/);
  assert.deepEqual(statement.values, [42]);
});

test("keeps a typed cursor bind only when a next history page exists", () => {
  const statement = historyCheckpointStatement(42, "next-page");
  assert.match(statement.text, /cursor = \$2/);
  assert.match(statement.text, /state = 'queued'/);
  assert.deepEqual(statement.values, [42, "next-page"]);
});

test("reports acknowledgement and agent-reported usage for a consumer", () => {
  assert.deepEqual(toConsumerProgress({ consumer_id: "hermes-vault-digest", total_messages: "121", acknowledged_messages: "120", pending_messages: "1", last_acknowledged_at: "2026-08-19 01:00:00+00", reported_runs: "4", input_tokens: "500", output_tokens: "125", total_duration_ms: "8000", last_consumed_at: "2026-08-19 01:02:00+00" }), {
    consumerId: "hermes-vault-digest", totalMessages: 121, acknowledgedMessages: 120, pendingMessages: 1, lastAcknowledgedAt: "2026-08-19 01:00:00+00", reportedRuns: 4, inputTokens: 500, outputTokens: 125, totalTokens: 625, totalDurationMs: 8000, lastConsumedAt: "2026-08-19 01:02:00+00",
  });
});

test("uses the requested backfill start without reading beyond retention", () => {
  const end = new Date("2026-08-31T12:00:00.000Z");
  assert.deepEqual(backfillWindow(new Date("2026-08-31T11:00:00.000Z"), end, 30), {
    startAt: new Date("2026-08-31T11:00:00.000Z"), endAt: end,
  });
  assert.deepEqual(backfillWindow(new Date("2026-07-01T00:00:00.000Z"), end, 30), {
    startAt: new Date("2026-08-01T12:00:00.000Z"), endAt: end,
  });
});

test("detects only qualifying Socket Mode gaps and bounds recovery to retention", () => {
  const recoveredAt = new Date("2026-08-31T12:00:00.000Z");
  assert.equal(detectedRecoveryWindow(new Date("2026-08-31T11:56:59.000Z"), recoveredAt, 300, 30), undefined);
  assert.deepEqual(detectedRecoveryWindow(new Date("2026-07-01T00:00:00.000Z"), recoveredAt, 300, 30), {
    startAt: new Date("2026-08-01T12:00:00.000Z"), endAt: recoveredAt,
  });
});

test("uses the changed message text from a Slack message_changed event", () => {
  assert.equal(textForSlackMessageEvent({ subtype: "message_changed", text: "", message: { text: "After edit" } }), "After edit");
});

test("uses the previous message text from a Slack message_deleted event", () => {
  assert.equal(textForSlackMessageEvent({ subtype: "message_deleted", text: "", previous_message: { text: "Before deletion" } }), "Before deletion");
});

test("does not create a consumer message for a disabled observation target", async () => {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const database = Object.create(Database.prototype) as Database;
  (database as unknown as { pool: { query: (text: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.includes("INSERT INTO slack_events")) return { rowCount: 1, rows: [{ event_sequence: "1" }] };
      if (text.includes("SELECT enabled FROM observation_targets")) return { rowCount: 1, rows: [{ enabled: false }] };
      throw new Error(`Unexpected query: ${text}`);
    },
  };

  await database.storeEnvelope({ event_id: "Ev-disabled", team_id: "T1", type: "event_callback", event: { type: "message", channel: "C-disabled", ts: "1.0", text: "ignored" } });

  assert.equal(queries.length, 2);
  assert.equal(queries.some((query) => query.text.includes("INSERT INTO messages")), false);
});

test("stores normalized changed text for an enabled observation target", async () => {
  const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
  const database = Object.create(Database.prototype) as Database;
  (database as unknown as { pool: { query: (text: string, values?: unknown[]) => Promise<unknown> } }).pool = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.includes("INSERT INTO slack_events")) return { rowCount: 1, rows: [{ event_sequence: "1" }] };
      if (text.includes("SELECT enabled FROM observation_targets")) return { rowCount: 1, rows: [{ enabled: true }] };
      if (text.includes("INSERT INTO channel_metadata")) return { rowCount: 1, rows: [] };
      if (text.includes("SELECT event_id FROM messages")) return { rowCount: 0, rows: [] };
      if (text.includes("INSERT INTO messages")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    },
  };

  await database.storeEnvelope({ event_id: "Ev-changed", team_id: "T1", type: "event_callback", event: { type: "message", channel: "C-enabled", ts: "1.0", subtype: "message_changed", message: { text: "After edit" } } });

  const insert = queries.find((query) => query.text.includes("INSERT INTO messages"));
  assert.equal(insert?.values?.[8], "After edit");
});
