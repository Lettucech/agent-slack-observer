import assert from "node:assert/strict";
import test from "node:test";
import { SlackConversationNameResolver } from "../src/slack-conversation-name.js";

test("uses Slack display names for direct-message and group-DM labels", async () => {
  const calls: string[] = [];
  const resolver = new SlackConversationNameResolver(async (method) => {
    calls.push(method);
    if (method === "users.info?user=U1") return { ok: true, user: { profile: { display_name: "Alice" } } };
    if (method === "conversations.members?channel=G1&limit=100") return { ok: true, members: ["U1", "U2", "U3", "U4"] };
    if (method === "users.info?user=U2") return { ok: true, user: { profile: { display_name: "Ben" } } };
    if (method === "users.info?user=U3") return { ok: true, user: { real_name: "Casey" } };
    if (method === "users.info?user=U4") return { ok: true, user: { name: "drew" } };
    throw new Error(`Unexpected Slack request: ${method}`);
  });

  assert.equal(await resolver.resolve({ id: "D1", is_im: true, user: "U1" }), "Alice");
  assert.equal(await resolver.resolve({ id: "G1", is_mpim: true }), "Alice, Ben, Casey +1");
  assert.deepEqual(calls, ["users.info?user=U1", "conversations.members?channel=G1&limit=100", "users.info?user=U2", "users.info?user=U3", "users.info?user=U4"]);
});

test("keeps a stable ID fallback when profile lookup is unavailable", async () => {
  const resolver = new SlackConversationNameResolver(async () => { throw new Error("missing_scope"); });
  assert.equal(await resolver.resolve({ id: "D1", is_im: true, user: "U1" }), "U1");
  assert.equal(await resolver.resolve({ id: "G1", is_mpim: true }), "G1");
});
