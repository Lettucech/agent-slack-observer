import express, { type NextFunction, type Request, type Response } from "express";
import { bootstrapConfig } from "./config.js";
import { Database } from "./db.js";
import { createMcpRequestHandler, createMcpTransport } from "./mcp.js";
import { ObserverRuntime, testSlackConnection } from "./runtime.js";
import { dashboardSettings, newMcpAuthToken, settingsFromInput } from "./settings.js";

const database = new Database(bootstrapConfig.databaseUrl);
await database.migrate();
const runtime = new ObserverRuntime(database);
await runtime.apply(await database.observerSettings());

const app = express();
app.use(express.json({ limit: "1mb" }));
app.post("/mcp", handleMcp);
app.get("/mcp", handleMcp);

app.get("/dashboard/status", async (_request, response, next) => {
  try {
    const settings = await database.observerSettings();
    response.json({ ...(await database.dashboardStatus()), socketMode: runtime.socketStatus(), userTokenConfigured: runtime.userTokenConfigured(), settings: dashboardSettings(settings) });
  } catch (error) { next(error); }
});
app.get("/dashboard/settings", async (_request, response, next) => {
  try { response.json({ settings: dashboardSettings(await database.observerSettings()) }); } catch (error) { next(error); }
});
app.post("/dashboard/settings/test", async (request, response, next) => {
  try {
    const candidate = settingsFromInput(await database.observerSettings(), request.body);
    await testSlackConnection(candidate);
    response.status(204).end();
  } catch (error) { next(error); }
});
app.post("/dashboard/settings", async (request, response, next) => {
  try {
    const current = await database.observerSettings();
    const candidate = settingsFromInput(current, request.body);
    const mcpAuthToken = candidate.mcpAuthToken ?? newMcpAuthToken();
    const saved = { ...candidate, mcpAuthToken };
    await database.saveObserverSettings(saved);
    await runtime.apply(saved);
    response.json({ settings: dashboardSettings(saved), mcpAuthToken: current.mcpAuthToken ? undefined : mcpAuthToken });
  } catch (error) { next(error); }
});
app.post("/dashboard/settings/mcp-token", async (_request, response, next) => {
  try {
    const settings = { ...(await database.observerSettings()), mcpAuthToken: newMcpAuthToken() };
    await database.saveObserverSettings(settings);
    response.json({ mcpAuthToken: settings.mcpAuthToken });
  } catch (error) { next(error); }
});
app.get("/dashboard/channels", async (_request, response, next) => {
  try { response.json({ channels: await database.listChannels() }); } catch (error) { next(error); }
});
app.post("/dashboard/metadata/sync", async (_request, response, next) => {
  try { response.status(202).json({ queued: await runtime.syncMetadata() }); } catch (error) { next(error); }
});
app.get("/dashboard/backfill", async (_request, response, next) => {
  try { response.json({ jobs: await database.listBackfillJobs() }); } catch (error) { next(error); }
});
app.post("/dashboard/targets", async (request, response, next) => {
  try {
    const workspaceId = inputString(request.body, "workspaceId"); const channelId = inputString(request.body, "channelId");
    await database.addObservationTarget(workspaceId, channelId);
    runtime.scheduleMetadata(workspaceId, channelId);
    response.status(201).json({ workspaceId, channelId });
  } catch (error) { next(error); }
});
app.post("/dashboard/targets/coverage", async (request, response, next) => {
  try {
    const workspaceId = inputString(request.body, "workspaceId"); const channelId = inputString(request.body, "channelId");
    if (typeof request.body?.enabled !== "boolean") throw new Error("enabled must be a boolean");
    await database.setObservationTargetEnabled(workspaceId, channelId, request.body.enabled);
    if (request.body.enabled) runtime.scheduleMetadata(workspaceId, channelId);
    response.status(204).end();
  } catch (error) { next(error); }
});
app.post("/dashboard/conversations/discover", async (_request, response, next) => {
  try { response.json(await runtime.discoverConversations()); } catch (error) { next(error); }
});
app.post("/dashboard/backfill/initial", async (_request, response, next) => {
  try {
    const settings = await database.observerSettings();
    const endAt = new Date(); const startAt = new Date(endAt.getTime() - settings.messageRetentionDays * 86_400_000);
    const created = await database.createBackfillJob("initial", startAt, endAt, settings.messageRetentionDays);
    runtime.wakeBackfill(); response.status(202).json(created);
  } catch (error) { next(error); }
});
app.post("/dashboard/backfill/manual", async (request, response, next) => {
  try {
    const settings = await database.observerSettings();
    const startAt = validDate(inputString(request.body, "startAt")); const endAt = validDate(inputString(request.body, "endAt"));
    const created = await database.createBackfillJob("manual", startAt, endAt, settings.messageRetentionDays);
    runtime.wakeBackfill(); response.status(202).json(created);
  } catch (error) { next(error); }
});
app.post("/dashboard/backfill/:id/cancel", async (request, response, next) => {
  try { await database.cancelBackfillJob(validId(request.params.id)); response.status(204).end(); } catch (error) { next(error); }
});

app.use(express.static("public"));
app.get("/healthz", async (_request, response) => { await database.pool.query("SELECT 1"); response.json({ ok: true }); });
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  if (!response.headersSent) response.status(500).json({ error: error instanceof Error ? error.message : "internal server error" });
});

const httpServer = app.listen(bootstrapConfig.port, () => console.log(`agent-slack-observer listening on ${bootstrapConfig.port}`));
async function shutdown() { runtime.stop(); httpServer.close(); await database.close(); }
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

async function handleMcp(request: Request, response: Response, next: NextFunction): Promise<void> {
  try {
    const settings = await database.observerSettings();
    if (!settings.mcpAuthToken) { response.status(503).json({ error: "Configure the observer in its local dashboard first" }); return; }
    const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (token !== settings.mcpAuthToken) { response.status(401).json({ error: "unauthorized" }); return; }
    await createMcpRequestHandler(database, settings.threadSettleSeconds, (db, settleSeconds) => createMcpTransport(db, settleSeconds, settings.mcpAuthToken!))(request, response, next);
  } catch (error) { next(error); }
}
function inputString(value: unknown, name: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>)[name] !== "string" || !(value as Record<string, string>)[name].trim()) throw new Error(`${name} is required`);
  return (value as Record<string, string>)[name].trim();
}
function validDate(value: string): Date { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error("Invalid timestamp"); return date; }
function validId(value: string): number { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid id"); return id; }
