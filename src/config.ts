/** Docker-only bootstrap values. Product settings live in PostgreSQL and start in the dashboard. */
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required: set it to a PostgreSQL connection string");
}

export const bootstrapConfig = {
  databaseUrl,
  port: 3000,
};
