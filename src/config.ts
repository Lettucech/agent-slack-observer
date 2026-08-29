/** Docker-only bootstrap values. Product settings live in PostgreSQL and start in the dashboard. */
export const bootstrapConfig = {
  databaseUrl: "postgres://observer:observer@db:5432/observer",
  port: 3000,
};
