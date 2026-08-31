import assert from "node:assert/strict";
import test from "node:test";
import { backfillWindow, detectedRecoveryWindow, historyCheckpointStatement, toConsumerProgress } from "../src/db.js";

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

test("reports acknowledged and pending messages for a consumer", () => {
  assert.deepEqual(toConsumerProgress({ consumer_id: "hermes-vault-digest", total_messages: "121", acknowledged_messages: "120", pending_messages: "1", last_acknowledged_at: "2026-08-19 01:00:00+00" }), {
    consumerId: "hermes-vault-digest", totalMessages: 121, acknowledgedMessages: 120, pendingMessages: 1, lastAcknowledgedAt: "2026-08-19 01:00:00+00",
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
