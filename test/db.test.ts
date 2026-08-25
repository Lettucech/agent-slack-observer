import assert from "node:assert/strict";
import test from "node:test";
import { historyCheckpointStatement, toConsumerProgress } from "../src/db.js";

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
