import assert from "node:assert/strict";
import test from "node:test";
import { SlackMetadataSync } from "../src/slack-metadata.js";

test("enriches workspace and channel names without requesting Slack message history", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const saved: string[][] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("team.info")) return new Response(JSON.stringify({ ok: true, team: { name: "Engineering" } }));
    return new Response(JSON.stringify({ ok: true, channel: { name: "agent-lab", is_channel: true } }));
  };
  try {
    const database = {
      metadataLookupDue: async () => ({ workspace: true, channel: true }),
      saveWorkspaceMetadata: async (...values: string[]) => { saved.push(["workspace", ...values]); },
      saveChannelMetadata: async (...values: string[]) => { saved.push(["channel", ...values]); },
      saveMetadataError: async () => assert.fail("metadata lookup should not fail"),
    };
    const sync = new SlackMetadataSync("xoxb-test", database as never);
    sync.schedule("T1", "C1");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["https://slack.com/api/team.info", "https://slack.com/api/conversations.info?channel=C1"]);
    assert.deepEqual(saved, [["workspace", "T1", "Engineering"], ["channel", "T1", "C1", "agent-lab", "public_channel"]]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
