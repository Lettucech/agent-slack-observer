export type Config = {
  databaseUrl: string;
  slackSigningSecret: string;
  mcpAuthToken: string;
  dashboardAuthToken: string;
  port: number;
  threadSettleSeconds: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 3000);
  const threadSettleSeconds = Number(process.env.THREAD_SETTLE_SECONDS ?? 90);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid port");
  if (!Number.isInteger(threadSettleSeconds) || threadSettleSeconds < 0) {
    throw new Error("THREAD_SETTLE_SECONDS must be a non-negative integer");
  }
  return {
    databaseUrl: required("DATABASE_URL"),
    slackSigningSecret: required("SLACK_SIGNING_SECRET"),
    mcpAuthToken: required("MCP_AUTH_TOKEN"),
    dashboardAuthToken: required("DASHBOARD_AUTH_TOKEN"),
    port,
    threadSettleSeconds,
  };
}
