import assert from "node:assert/strict";
import test from "node:test";
import { makeDigestBatch } from "../src/digest.js";
import type { StoredMessage } from "../src/types.js";

function message(sequence: number, ts: string, text: string, threadTs: string | null = null, payload: Record<string, unknown> = {}): StoredMessage {
  return { eventId: `Ev${sequence}`, eventSequence: sequence, workspaceId: "T1", channelId: "C1", conversationType: "im", messageTs: ts, threadTs, userId: "U1", subtype: null, text, payload, observedAt: "2026-08-11T00:00:00Z" };
}

test("keeps a thread together even when unrelated messages arrive between replies", () => {
  const root = message(1, "1000.000001", "Incident starts");
  const unrelated = message(2, "1001.000001", "Unrelated announcement");
  const reply = message(3, "1002.000001", "Investigating", "1000.000001");
  const batch = makeDigestBatch([root, unrelated, reply], { maxTokens: 2000 }, 3);
  assert.equal(batch.groups.length, 2);
  const thread = batch.groups.find((group) => group.kind === "thread");
  assert.deepEqual(thread?.messages.map((item) => item.eventId), ["Ev1", "Ev3"]);
  assert.equal(thread?.conversationType, "im");
});

test("splits an oversized thread with its root message retained", () => {
  const root = message(1, "1000.000001", "Root");
  const reply = message(2, "1001.000001", "x".repeat(2000), "1000.000001");
  const batch = makeDigestBatch([root, reply], { maxTokens: 128 }, 2);
  assert.equal(batch.groups[0].kind, "thread");
  assert.equal(batch.groups[0].messages[0].eventId, "Ev1");
  assert.equal(batch.groups[0].threadContinues, true);
});

test("omits raw Slack payloads from digest output", () => {
  const batch = makeDigestBatch([
    message(1, "1000.000001", "Short digest text", null, { blocks: "x".repeat(137_000) }),
  ], { maxTokens: 128 }, 1);

  assert.equal("payload" in batch.groups[0].messages[0], false);
  assert.ok(batch.estimatedTokens <= 128);
  assert.ok(Buffer.byteLength(JSON.stringify(batch), "utf8") < 128 * 4);
});

test("returns a continuation for a single oversized root without losing text", () => {
  const batch = makeDigestBatch([
    message(1, "1000.000001", "x".repeat(10_000)),
  ], { maxTokens: 128 }, 1);

  assert.ok(batch.estimatedTokens <= 128);
  assert.equal(typeof batch.groups[0].messages[0].textContinues, "number");
  assert.ok(batch.groups[0].messages[0].text.length < 10_000);
  assert.ok(Buffer.byteLength(JSON.stringify(batch), "utf8") < 128 * 4);
});

test("orders reverse-paginated backfill by Slack timestamp rather than insertion sequence", () => {
  const older = message(20, "1000.000001", "Older root");
  const newer = message(10, "1001.000001", "Newer root");
  const batch = makeDigestBatch([newer, older], { maxTokens: 2000 }, 20);
  assert.deepEqual(batch.groups[0].messages.map((item) => item.eventId), ["Ev20", "Ev10"]);
});
