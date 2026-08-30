import assert from "node:assert/strict";
import test from "node:test";
import { dashboardSettings, settingsFromInput, validateSettingsInput } from "../src/settings.js";

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
  assert.throws(() => validateSettingsInput({ slackAppToken: "xapp-token", slackUserToken: "xoxp-token", slackBotToken: "xoxb-token" }), /Choose only one/);
  assert.deepEqual(validateSettingsInput({ slackAppToken: "xapp-token", slackUserToken: "xoxp-token", threadSettleSeconds: 60 }).threadSettleSeconds, 60);
});

test("settings retain only the selected Slack read token", () => {
  const existing = {
    slackAppToken: "xapp-secret",
    slackUserToken: "xoxp-old",
    slackBotToken: "xoxb-old",
    mcpAuthToken: "mcp-secret",
    threadSettleSeconds: 90,
    messageRetentionDays: 30,
    rawEventRetentionDays: 7,
    backfillRequestIntervalSeconds: 60,
    downtimeSuggestionSeconds: 300,
  };

  const botSelection = settingsFromInput(existing, { slackReadTokenType: "bot" });
  assert.equal(botSelection.slackUserToken, undefined);
  assert.equal(botSelection.slackBotToken, "xoxb-old");

  const userSelection = settingsFromInput(existing, { slackReadTokenType: "user", slackUserToken: "xoxp-new" });
  assert.equal(userSelection.slackUserToken, "xoxp-new");
  assert.equal(userSelection.slackBotToken, undefined);
  assert.throws(() => settingsFromInput(existing, { slackReadTokenType: "invalid" }), /Choose a Slack User or Bot Token/);
});
