import assert from "node:assert/strict";
import test from "node:test";
import { conversationTypeFromSlackChannel } from "../src/slack-conversation-type.js";

test("normalizes every supported Slack message conversation type", () => {
  assert.equal(conversationTypeFromSlackChannel({ channel_type: "channel" }), "public_channel");
  assert.equal(conversationTypeFromSlackChannel({ channel_type: "group" }), "private_channel");
  assert.equal(conversationTypeFromSlackChannel({ channel_type: "im" }), "im");
  assert.equal(conversationTypeFromSlackChannel({ channel_type: "mpim" }), "mpim");
});

test("uses conversations.info/list flags and never guesses an unknown type", () => {
  assert.equal(conversationTypeFromSlackChannel({ is_channel: true }), "public_channel");
  assert.equal(conversationTypeFromSlackChannel({ is_private: true }), "private_channel");
  assert.equal(conversationTypeFromSlackChannel({ is_im: true }), "im");
  assert.equal(conversationTypeFromSlackChannel({ is_mpim: true }), "mpim");
  assert.equal(conversationTypeFromSlackChannel({}), "unknown");
});
