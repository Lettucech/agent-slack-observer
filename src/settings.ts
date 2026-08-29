import { randomBytes } from "node:crypto";

export type ObserverSettings = {
  slackAppToken: string | undefined;
  slackUserToken: string | undefined;
  slackBotToken: string | undefined;
  mcpAuthToken: string | undefined;
  threadSettleSeconds: number;
  messageRetentionDays: number;
  rawEventRetentionDays: number;
  backfillRequestIntervalSeconds: number;
  downtimeSuggestionSeconds: number;
};

export type DashboardSettings = Omit<ObserverSettings, "slackAppToken" | "slackUserToken" | "slackBotToken" | "mcpAuthToken"> & {
  configured: boolean;
  slackAppTokenConfigured: boolean;
  slackUserTokenConfigured: boolean;
  slackBotTokenConfigured: boolean;
  mcpAuthTokenConfigured: boolean;
};

export const defaultSettings: ObserverSettings = {
  slackAppToken: undefined,
  slackUserToken: undefined,
  slackBotToken: undefined,
  mcpAuthToken: undefined,
  threadSettleSeconds: 90,
  messageRetentionDays: 30,
  rawEventRetentionDays: 7,
  backfillRequestIntervalSeconds: 60,
  downtimeSuggestionSeconds: 300,
};

export function dashboardSettings(settings: ObserverSettings): DashboardSettings {
  const slackAppTokenConfigured = Boolean(settings.slackAppToken);
  const slackUserTokenConfigured = Boolean(settings.slackUserToken);
  const slackBotTokenConfigured = Boolean(settings.slackBotToken);
  const mcpAuthTokenConfigured = Boolean(settings.mcpAuthToken);
  return {
    configured: slackAppTokenConfigured && (slackUserTokenConfigured || slackBotTokenConfigured) && mcpAuthTokenConfigured,
    slackAppTokenConfigured,
    slackUserTokenConfigured,
    slackBotTokenConfigured,
    mcpAuthTokenConfigured,
    threadSettleSeconds: settings.threadSettleSeconds,
    messageRetentionDays: settings.messageRetentionDays,
    rawEventRetentionDays: settings.rawEventRetentionDays,
    backfillRequestIntervalSeconds: settings.backfillRequestIntervalSeconds,
    downtimeSuggestionSeconds: settings.downtimeSuggestionSeconds,
  };
}

/** Merges a dashboard submission with stored secrets. An empty secret field means keep the current value. */
export function settingsFromInput(existing: ObserverSettings, input: unknown): ObserverSettings {
  const body = record(input);
  const candidate: ObserverSettings = {
    slackAppToken: secret(body, "slackAppToken") ?? existing.slackAppToken,
    slackUserToken: secret(body, "slackUserToken") ?? existing.slackUserToken,
    slackBotToken: secret(body, "slackBotToken") ?? existing.slackBotToken,
    mcpAuthToken: existing.mcpAuthToken,
    threadSettleSeconds: integer(body, "threadSettleSeconds", existing.threadSettleSeconds, 0, 3600),
    messageRetentionDays: integer(body, "messageRetentionDays", existing.messageRetentionDays, 1, 3650),
    rawEventRetentionDays: integer(body, "rawEventRetentionDays", existing.rawEventRetentionDays, 1, 3650),
    backfillRequestIntervalSeconds: integer(body, "backfillRequestIntervalSeconds", existing.backfillRequestIntervalSeconds, 1, 86_400),
    downtimeSuggestionSeconds: integer(body, "downtimeSuggestionSeconds", existing.downtimeSuggestionSeconds, 1, 86_400),
  };
  return validateSettingsInput(candidate);
}

export function validateSettingsInput(input: unknown): ObserverSettings {
  const body = record(input);
  const slackAppToken = requiredSecret(body, "slackAppToken", "Slack App Token");
  const slackUserToken = optionalSecret(body, "slackUserToken");
  const slackBotToken = optionalSecret(body, "slackBotToken");
  if (!slackUserToken && !slackBotToken) throw new Error("A Slack user or bot token is required");
  return {
    slackAppToken,
    slackUserToken,
    slackBotToken,
    mcpAuthToken: optionalSecret(body, "mcpAuthToken"),
    threadSettleSeconds: integer(body, "threadSettleSeconds", defaultSettings.threadSettleSeconds, 0, 3600),
    messageRetentionDays: integer(body, "messageRetentionDays", defaultSettings.messageRetentionDays, 1, 3650),
    rawEventRetentionDays: integer(body, "rawEventRetentionDays", defaultSettings.rawEventRetentionDays, 1, 3650),
    backfillRequestIntervalSeconds: integer(body, "backfillRequestIntervalSeconds", defaultSettings.backfillRequestIntervalSeconds, 1, 86_400),
    downtimeSuggestionSeconds: integer(body, "downtimeSuggestionSeconds", defaultSettings.downtimeSuggestionSeconds, 1, 86_400),
  };
}

export function newMcpAuthToken(): string { return randomBytes(32).toString("base64url"); }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings must be an object");
  return value as Record<string, unknown>;
}
function optionalSecret(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
function requiredSecret(body: Record<string, unknown>, name: string, label: string): string {
  const value = optionalSecret(body, name);
  if (!value) throw new Error(`${label} is required`);
  return value;
}
function secret(body: Record<string, unknown>, name: string): string | undefined { return optionalSecret(body, name); }
function integer(body: Record<string, unknown>, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = body[name];
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return number;
}
