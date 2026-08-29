import assert from "node:assert/strict";
import test from "node:test";
import { testSlackConnection } from "../src/runtime.js";

test("tests Slack credentials without opening a Socket Mode WebSocket or writing observer state", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    if (String(url).endsWith("apps.connections.open")) return new Response(JSON.stringify({ ok: true, url: "wss://unused.example.test" }));
    return new Response(JSON.stringify({ ok: true, team_id: "T1" }));
  };
  try {
    await testSlackConnection({
      slackAppToken: "xapp-test", slackUserToken: "xoxp-test", slackBotToken: undefined, mcpAuthToken: undefined,
      threadSettleSeconds: 90, messageRetentionDays: 30, rawEventRetentionDays: 7, backfillRequestIntervalSeconds: 60, downtimeSuggestionSeconds: 300,
    });
    assert.deepEqual(calls, [
      { url: "https://slack.com/api/apps.connections.open", authorization: "Bearer xapp-test" },
      { url: "https://slack.com/api/auth.test", authorization: "Bearer xoxp-test" },
    ]);
  } finally { globalThis.fetch = originalFetch; }
});
