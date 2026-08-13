import assert from "node:assert/strict";
import test from "node:test";
import { SlackBackfillWorker, type BackfillDatabase } from "../src/backfill.js";
import type { BackfillTask, SlackHistoryMessage } from "../src/db.js";

const historyTask: BackfillTask = { id: 7, jobId: 4, workspaceId: "T1", channelId: "C1", phase: "history", cursor: "page-1", rootTs: null, oldest: "1000.0", latest: "2000.0", attempts: 1 };

test("persists one history page and its cursor before allowing the next request", async () => {
  const originalFetch = globalThis.fetch;
  const stored: SlackHistoryMessage[][] = []; const completed: Array<[number, string | null]> = []; const deadlines: Date[] = [];
  const database: BackfillDatabase = {
    backfillRuntime: async () => ({ nextRequestAt: null }), claimBackfillTask: async () => historyTask,
    threadNeedsRefresh: async () => assert.fail("history should not check thread state"), storeHistoryPage: async (_task, messages) => { stored.push(messages); },
    storeReplies: async () => assert.fail("history should not store replies"), completeHistoryTask: async (id, cursor) => { completed.push([id, cursor]); },
    completeBackfillTask: async () => assert.fail("history should not complete a reply task"), retryBackfillTask: async () => assert.fail("history request should succeed"),
    setBackfillRuntime: async (deadline) => { deadlines.push(deadline); }, purgeExpired: async () => undefined,
  };
  globalThis.fetch = async (url) => {
    assert.match(String(url), /conversations\.history\?/); assert.match(String(url), /channel=C1/); assert.match(String(url), /cursor=page-1/);
    return new Response(JSON.stringify({ ok: true, messages: [{ type: "message", ts: "1100.0", text: "root", reply_count: 2 }], response_metadata: { next_cursor: "page-2" } }));
  };
  try {
    const worker = new SlackBackfillWorker("xoxb-test", database, { requestIntervalSeconds: 60, rawEventRetentionDays: 7, messageRetentionDays: 30 });
    assert.deepEqual(await worker.runOnce(), { state: "worked" });
    assert.deepEqual(stored, [[{ type: "message", ts: "1100.0", text: "root", reply_count: 2 }]]);
    assert.deepEqual(completed, [[7, "page-2"]]);
    assert.equal(deadlines.length, 1);
    assert.ok(deadlines[0].getTime() >= Date.now() + 59_000);
  } finally { globalThis.fetch = originalFetch; }
});

test("honors Slack Retry-After globally and leaves the task resumable", async () => {
  const originalFetch = globalThis.fetch;
  const retries: Array<{ id: number; error: string; at: Date }> = []; const deadlines: Date[] = [];
  const database: BackfillDatabase = {
    backfillRuntime: async () => ({ nextRequestAt: null }), claimBackfillTask: async () => ({ ...historyTask, cursor: null }),
    threadNeedsRefresh: async () => true, storeHistoryPage: async () => assert.fail("429 must not store a page"), storeReplies: async () => assert.fail("429 must not store replies"),
    completeHistoryTask: async () => assert.fail("429 must not complete task"), completeBackfillTask: async () => assert.fail("429 must not complete task"),
    retryBackfillTask: async (id, error, at) => { retries.push({ id, error, at }); }, setBackfillRuntime: async (at) => { deadlines.push(at); }, purgeExpired: async () => undefined,
  };
  globalThis.fetch = async () => new Response("", { status: 429, headers: { "retry-after": "120" } });
  try {
    const worker = new SlackBackfillWorker("xoxb-test", database, { requestIntervalSeconds: 60, rawEventRetentionDays: 7, messageRetentionDays: 30 });
    const result = await worker.runOnce();
    assert.equal(result.state, "waiting"); assert.equal(result.waitMs, 120_000);
    assert.equal(retries.length, 1); assert.match(retries[0].error, /rate limited/); assert.equal(deadlines.length, 1);
    assert.ok(retries[0].at.getTime() >= Date.now() + 119_000);
  } finally { globalThis.fetch = originalFetch; }
});
