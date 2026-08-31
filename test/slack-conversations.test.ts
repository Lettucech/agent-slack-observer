import assert from "node:assert/strict";
import test from "node:test";
import { SlackConversationDiscovery } from "../src/slack-conversations.js";

test("discovers every user-visible conversation over paginated Slack results", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const registered: Array<{ workspaceId: string; workspaceName: string | null; conversations: unknown[] }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    if (String(url).endsWith("auth.test")) return new Response(JSON.stringify({ ok: true, team_id: "T1", team: "Engineering" }));
    if (String(url).includes("users.info?user=U1")) return new Response(JSON.stringify({ ok: true, user: { profile: { display_name: "Alice" } } }));
    if (String(url).includes("users.info?user=U2")) return new Response(JSON.stringify({ ok: true, user: { profile: { display_name: "Ben" } } }));
    if (String(url).includes("conversations.members?channel=G2")) return new Response(JSON.stringify({ ok: true, members: ["U1", "U2"] }));
    if (String(url).includes("cursor=next-page")) return new Response(JSON.stringify({ ok: true, channels: [{ id: "D1", is_im: true, user: "U1" }, { id: "G2", is_mpim: true }, { id: "C-archived", name: "old", is_archived: true }] }));
    return new Response(JSON.stringify({ ok: true, channels: [{ id: "C1", name: "general", is_channel: true }, { id: "G1", name: "private", is_private: true }], response_metadata: { next_cursor: "next-page" } }));
  };
  try {
    const discovery = new SlackConversationDiscovery("xoxp-test", {
      registerUserVisibleConversations: async (workspaceId, workspaceName, conversations) => { registered.push({ workspaceId, workspaceName, conversations }); },
    });
    assert.deepEqual(await discovery.discover(), { workspaceId: "T1", conversations: 4 });
    assert.deepEqual(calls.map((call) => call.authorization), ["Bearer xoxp-test", "Bearer xoxp-test", "Bearer xoxp-test", "Bearer xoxp-test", "Bearer xoxp-test", "Bearer xoxp-test"]);
    assert.match(calls[1].url, /types=public_channel%2Cprivate_channel%2Cim%2Cmpim/);
    assert.match(calls[2].url, /cursor=next-page/);
    assert.deepEqual(registered, [{ workspaceId: "T1", workspaceName: "Engineering", conversations: [
      { channelId: "C1", channelName: "general", conversationType: "public_channel" }, { channelId: "G1", channelName: "private", conversationType: "private_channel" }, { channelId: "D1", channelName: "Alice", conversationType: "im" }, { channelId: "G2", channelName: "Alice, Ben", conversationType: "mpim" },
    ] }]);
  } finally { globalThis.fetch = originalFetch; }
});

test("does not register a partial target set when Slack discovery fails", async () => {
  const originalFetch = globalThis.fetch;
  let registered = false;
  globalThis.fetch = async (url) => String(url).endsWith("auth.test")
    ? new Response(JSON.stringify({ ok: true, team_id: "T1" }))
    : new Response(JSON.stringify({ ok: false, error: "missing_scope" }), { status: 200 });
  try {
    const discovery = new SlackConversationDiscovery("xoxp-test", { registerUserVisibleConversations: async () => { registered = true; } });
    await assert.rejects(discovery.discover(), /conversations\.list failed: missing_scope/);
    assert.equal(registered, false);
  } finally { globalThis.fetch = originalFetch; }
});
