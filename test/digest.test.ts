import assert from "node:assert/strict";
import test from "node:test";
import { makeDigestBatch, makeMessageDigestSegment } from "../src/digest.js";
import type { StoredMessage } from "../src/types.js";

function message(sequence: number, ts: string, text: string | null, threadTs: string | null = null, payload: Record<string, unknown> = {}): StoredMessage {
  return { eventId: `Ev${sequence}`, eventSequence: sequence, workspaceId: "T1", channelId: "C1", conversationType: "im", messageTs: ts, threadTs, userId: "U1", subtype: null, text, payload, observedAt: "2026-08-11T00:00:00Z" };
}

test("keeps a thread together even when unrelated messages arrive between replies", () => {
  const root = message(1, "1000.000001", "Incident starts");
  const unrelated = message(2, "1001.000001", "Unrelated announcement");
  const reply = message(3, "1002.000001", "Investigating", "1000.000001");
  const batch = makeDigestBatch([root, unrelated, reply], { maxBytes: 2000 }, 3);
  assert.equal(batch.groups.length, 2);
  const thread = batch.groups.find((group) => group.kind === "thread");
  assert.deepEqual(thread?.messages.map((item) => item.messageTs), ["1000.000001", "1002.000001"]);
  assert.equal(thread?.conversationType, "im");
});

test("splits an oversized thread with its root message retained", () => {
  const root = message(1, "1000.000001", "Root");
  const reply = message(2, "1001.000001", "x".repeat(2000), "1000.000001");
  const batch = makeDigestBatch([root, reply], { maxBytes: 128 }, 2);
  assert.equal(batch.groups[0].kind, "thread");
  assert.equal(batch.groups[0].messages[0].messageTs, "1000.000001");
  assert.equal(batch.groups[0].threadContinues, true);
});

test("omits raw Slack payloads from digest output", () => {
  const batch = makeDigestBatch([
    message(1, "1000.000001", "Short digest text", null, { blocks: "x".repeat(137_000) }),
  ], { maxBytes: 128 }, 1);

  assert.equal("payload" in batch.groups[0].messages[0], false);
  assert.ok(Buffer.byteLength(JSON.stringify(batch), "utf8") < 128 * 4);
});

test("returns a continuation for a single oversized root without losing text", () => {
  const batch = makeDigestBatch([
    message(1, "1000.000001", "x".repeat(10_000)),
  ], { maxBytes: 128 }, 1);

  assert.equal(typeof batch.groups[0].messages[0].textContinues, "number");
  assert.ok(batch.groups[0].messages[0].text.length < 10_000);
  assert.ok(Buffer.byteLength(JSON.stringify(batch), "utf8") < 128 * 4);
});

test("orders reverse-paginated backfill by Slack timestamp rather than insertion sequence", () => {
  const older = message(20, "1000.000001", "Older root");
  const newer = message(10, "1001.000001", "Newer root");
  const batch = makeDigestBatch([newer, older], { maxBytes: 2000 }, 20);
  assert.deepEqual(batch.groups[0].messages.map((item) => item.messageTs), ["1000.000001", "1001.000001"]);
});

test("uses a compact, complete-response byte budget", () => {
  const batch = makeDigestBatch([
    message(1, "1000.000001", "A concise message"),
    message(2, "1001.000001", "Another concise message"),
  ], { maxBytes: 1_024 }, 2);

  assert.ok(Buffer.byteLength(JSON.stringify(batch), "utf8") <= 1_024);
  assert.equal("eventId" in batch.groups[0].messages[0], false);
  assert.equal("estimatedTokens" in batch.groups[0], false);
  assert.equal("upperSequence" in batch, false);
});

test("preserves null text in batch and individual digest projections", () => {
  const stored = message(1, "1000.000001", null);
  const batch = makeDigestBatch([stored], { maxBytes: 1_024 }, 1);

  assert.equal(batch.groups[0].messages[0].text, null);
  assert.equal(makeMessageDigestSegment(stored, 1_024).text, null);
});
