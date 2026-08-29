import assert from "node:assert/strict";
import test from "node:test";
import { dashboardSettings, validateSettingsInput } from "../src/settings.js";

test("dashboard settings disclose configuration state without returning secrets", () => {
  const settings = dashboardSettings({
    slackAppToken: "xapp-secret",
    slackUserToken: "xoxp-secret",
    slackBotToken: undefined,
    mcpAuthToken: "mcp-secret",
    threadSettleSeconds: 90,
    messageRetentionDays: 30,
    rawEventRetentionDays: 7,
    backfillRequestIntervalSeconds: 60,
    downtimeSuggestionSeconds: 300,
  });
  assert.deepEqual(settings, {
    configured: true,
    slackAppTokenConfigured: true,
    slackUserTokenConfigured: true,
    slackBotTokenConfigured: false,
    mcpAuthTokenConfigured: true,
    threadSettleSeconds: 90,
    messageRetentionDays: 30,
    rawEventRetentionDays: 7,
    backfillRequestIntervalSeconds: 60,
    downtimeSuggestionSeconds: 300,
  });
  assert.doesNotMatch(JSON.stringify(settings), /secret/);
});

test("settings input requires an app token and a read token before activation", () => {
  assert.throws(() => validateSettingsInput({ slackAppToken: "", slackUserToken: "", slackBotToken: "" }), /Slack App Token/);
  assert.throws(() => validateSettingsInput({ slackAppToken: "xapp-token", slackUserToken: "", slackBotToken: "" }), /user or bot token/);
  assert.deepEqual(validateSettingsInput({ slackAppToken: "xapp-token", slackUserToken: "xoxp-token", threadSettleSeconds: 60 }).threadSettleSeconds, 60);
});
