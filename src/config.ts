/** Docker-only bootstrap values. Product settings live in PostgreSQL and start in the dashboard. */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required: point it at the shared Postgres from the agent-infra repo");
}

export const bootstrapConfig = {
  databaseUrl,
  port: 3000,
};
