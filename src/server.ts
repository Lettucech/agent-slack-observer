import { randomUUID } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { loadConfig } from "./config.js";
import { Database, type SlackEnvelope } from "./db.js";
import { createMcpTransport } from "./mcp.js";
import { isValidSlackSignature } from "./slack.js";

const config = loadConfig();
const database = new Database(config.databaseUrl);
await database.migrate();

const { transport, connect } = createMcpTransport(database, config.threadSettleSeconds);
await connect();

const app = express();
const sessions = new Map<string, number>();

function requireBearer(expected: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (token !== expected) return response.status(401).json({ error: "unauthorized" });
    next();
  };
}

function hasDashboardAccess(request: Request): boolean {
  const bearer = request.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer === config.dashboardAuthToken) return true;
  const session = request.header("cookie")?.match(/(?:^|;\s*)observer_dashboard_session=([^;]+)/)?.[1];
  return !!session && (sessions.get(session) ?? 0) > Date.now();
}

function requireDashboard(request: Request, response: Response, next: NextFunction) {
  if (!hasDashboardAccess(request)) return response.status(401).json({ error: "dashboard authentication required" });
  next();
}

app.post("/slack/events", express.raw({ type: "application/json", limit: "2mb" }), async (request, response, next) => {
  try {
    const rawBody = request.body as Buffer;
    if (!Buffer.isBuffer(rawBody) || !isValidSlackSignature(config.slackSigningSecret, request.header("x-slack-request-timestamp"), request.header("x-slack-signature"), rawBody)) {
      return response.status(401).json({ error: "invalid Slack signature" });
    }
    const payload = JSON.parse(rawBody.toString("utf8")) as SlackEnvelope & { challenge?: unknown };
    if (payload.type === "url_verification" && typeof payload.challenge === "string") return response.status(200).type("text/plain").send(payload.challenge);
    if (payload.type !== "event_callback") return response.status(200).json({ ignored: true });
    // Persist before responding, but do no model work here. The operation is bounded by a single DB transaction.
    await database.storeEnvelope(payload);
    return response.status(200).json({ ok: true });
  } catch (error) { next(error); }
});

app.use(express.json({ limit: "1mb" }));
app.post("/mcp", requireBearer(config.mcpAuthToken), async (request, response, next) => {
  try { await transport.handleRequest(request, response, request.body); } catch (error) { next(error); }
});
app.get("/mcp", requireBearer(config.mcpAuthToken), async (request, response, next) => {
  try { await transport.handleRequest(request, response); } catch (error) { next(error); }
});

app.post("/dashboard/login", (request, response) => {
  if (request.body?.token !== config.dashboardAuthToken) return response.status(401).json({ error: "invalid token" });
  const id = randomUUID();
  sessions.set(id, Date.now() + 12 * 60 * 60 * 1000);
  response.cookie("observer_dashboard_session", id, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 12 * 60 * 60 * 1000 });
  response.status(204).send();
});
app.get("/dashboard/status", requireDashboard, async (_request, response, next) => {
  try { response.json(await database.dashboardStatus()); } catch (error) { next(error); }
});
app.get("/dashboard/channels", requireDashboard, async (_request, response, next) => {
  try { response.json({ channels: await database.listChannels() }); } catch (error) { next(error); }
});

app.use(express.static("public"));
app.get("/healthz", async (_request, response) => {
  await database.pool.query("SELECT 1");
  response.json({ ok: true });
});
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  if (!response.headersSent) response.status(500).json({ error: "internal server error" });
});

const httpServer = app.listen(config.port, () => console.log(`agent-slack-observer listening on ${config.port}`));
async function shutdown() {
  httpServer.close();
  await database.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
