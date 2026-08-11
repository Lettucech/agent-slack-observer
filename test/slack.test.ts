import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { isValidSlackSignature } from "../src/slack.js";

test("accepts a current Slack v0 signature over the unchanged raw body", () => {
  const secret = "signing-secret";
  const timestamp = "1723334400";
  const body = Buffer.from('{"type":"event_callback"}');
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  assert.equal(isValidSlackSignature(secret, timestamp, signature, body, 1723334400), true);
});

test("rejects a stale or altered Slack request", () => {
  const body = Buffer.from('{"type":"event_callback"}');
  assert.equal(isValidSlackSignature("secret", "1", "v0=" + "0".repeat(64), body, 1000), false);
});
