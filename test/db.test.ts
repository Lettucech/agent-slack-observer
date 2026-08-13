import assert from "node:assert/strict";
import test from "node:test";
import { historyCheckpointStatement } from "../src/db.js";

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
