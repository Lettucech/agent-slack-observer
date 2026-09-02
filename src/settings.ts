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
  conversationNameFilterTerms: string;
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
  conversationNameFilterTerms: "",
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
    conversationNameFilterTerms: settings.conversationNameFilterTerms,
  };
}

/** Merges a dashboard submission with stored secrets. An empty selected secret field means keep its current value. */
export function settingsFromInput(existing: ObserverSettings, input: unknown): ObserverSettings {
  const body = record(input);
  const slackReadTokenType = readTokenType(body);
  const selectedToken = secret(body, slackReadTokenType === "user" ? "slackUserToken" : "slackBotToken")
    ?? (slackReadTokenType === "user" ? existing.slackUserToken : existing.slackBotToken);
  if (!selectedToken) throw new Error(`Slack ${slackReadTokenType === "user" ? "User" : "Bot"} Token is required`);
  const candidate: ObserverSettings = {
    slackAppToken: secret(body, "slackAppToken") ?? existing.slackAppToken,
    slackUserToken: slackReadTokenType === "user" ? selectedToken : undefined,
    slackBotToken: slackReadTokenType === "bot" ? selectedToken : undefined,
    mcpAuthToken: existing.mcpAuthToken,
    threadSettleSeconds: integer(body, "threadSettleSeconds", existing.threadSettleSeconds, 0, 3600),
    messageRetentionDays: integer(body, "messageRetentionDays", existing.messageRetentionDays, 1, 3650),
    rawEventRetentionDays: integer(body, "rawEventRetentionDays", existing.rawEventRetentionDays, 1, 3650),
    backfillRequestIntervalSeconds: integer(body, "backfillRequestIntervalSeconds", existing.backfillRequestIntervalSeconds, 1, 86_400),
    downtimeSuggestionSeconds: integer(body, "downtimeSuggestionSeconds", existing.downtimeSuggestionSeconds, 1, 86_400),
    // Unlike secrets, an explicitly empty value clears the filter rather than keeping the previous one.
    conversationNameFilterTerms: text(body, "conversationNameFilterTerms", existing.conversationNameFilterTerms),
  };
  return validateSettingsInput(candidate);
}

export function validateSettingsInput(input: unknown): ObserverSettings {
  const body = record(input);
  const slackAppToken = requiredSecret(body, "slackAppToken", "Slack App Token");
  const slackUserToken = optionalSecret(body, "slackUserToken");
  const slackBotToken = optionalSecret(body, "slackBotToken");
  if (!slackUserToken && !slackBotToken) throw new Error("A Slack user or bot token is required");
  if (slackUserToken && slackBotToken) throw new Error("Choose only one Slack user or bot token");
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
    conversationNameFilterTerms: text(body, "conversationNameFilterTerms", defaultSettings.conversationNameFilterTerms),
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
function readTokenType(body: Record<string, unknown>): "user" | "bot" {
  const value = body.slackReadTokenType;
  if (value !== "user" && value !== "bot") throw new Error("Choose a Slack User or Bot Token");
  return value;
}
function integer(body: Record<string, unknown>, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = body[name];
  if (value === undefined || value === null || value === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return number;
}
function text(body: Record<string, unknown>, name: string, fallback: string): string {
  const value = body[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value.trim();
}
