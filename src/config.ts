export type Config = {
  databaseUrl: string;
  slackAppToken: string;
  slackBotToken: string;
  mcpAuthToken: string;
  port: number;
  threadSettleSeconds: number;
  messageRetentionDays: number;
  rawEventRetentionDays: number;
  backfillRequestIntervalSeconds: number;
  downtimeSuggestionSeconds: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 3000);
  const threadSettleSeconds = Number(process.env.THREAD_SETTLE_SECONDS ?? 90);
  const messageRetentionDays = Number(process.env.MESSAGE_RETENTION_DAYS ?? 30);
  const rawEventRetentionDays = Number(process.env.RAW_EVENT_RETENTION_DAYS ?? 7);
  const backfillRequestIntervalSeconds = Number(process.env.BACKFILL_REQUEST_INTERVAL_SECONDS ?? 60);
  const downtimeSuggestionSeconds = Number(process.env.DOWNTIME_SUGGESTION_SECONDS ?? 300);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid port");
  if (!Number.isInteger(threadSettleSeconds) || threadSettleSeconds < 0) {
    throw new Error("THREAD_SETTLE_SECONDS must be a non-negative integer");
  }
  for (const [name, value] of [["MESSAGE_RETENTION_DAYS", messageRetentionDays], ["RAW_EVENT_RETENTION_DAYS", rawEventRetentionDays], ["BACKFILL_REQUEST_INTERVAL_SECONDS", backfillRequestIntervalSeconds], ["DOWNTIME_SUGGESTION_SECONDS", downtimeSuggestionSeconds]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  return {
    databaseUrl: required("DATABASE_URL"),
    slackAppToken: required("SLACK_APP_TOKEN"),
    slackBotToken: required("SLACK_BOT_TOKEN"),
    mcpAuthToken: required("MCP_AUTH_TOKEN"),
    port,
    threadSettleSeconds,
    messageRetentionDays,
    rawEventRetentionDays,
    backfillRequestIntervalSeconds,
    downtimeSuggestionSeconds,
  };
}
