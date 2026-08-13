import express, { type NextFunction, type Request, type Response } from "express";
import { SlackBackfillWorker } from "./backfill.js";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { createMcpRequestHandler } from "./mcp.js";
import { SlackMetadataSync } from "./slack-metadata.js";
import { SocketModeObserver } from "./socket-mode.js";

const config = loadConfig();
const database = new Database(config.databaseUrl);
await database.migrate();

const slackMetadata = new SlackMetadataSync(config.slackBotToken, database);
const backfillWorker = new SlackBackfillWorker(config.slackBotToken, database, {
  requestIntervalSeconds: config.backfillRequestIntervalSeconds,
  rawEventRetentionDays: config.rawEventRetentionDays,
  messageRetentionDays: config.messageRetentionDays,
});
backfillWorker.start();
const slackSocket = new SocketModeObserver(
  config.slackAppToken,
  database,
  (workspaceId, channelId) => slackMetadata.schedule(workspaceId, channelId),
  {
    connected: () => void database.markSocketConnected(config.downtimeSuggestionSeconds).catch(console.error),
    disconnected: () => void database.markSocketDisconnected().catch(console.error),
    eventStored: () => void database.markSocketEvent().catch(console.error),
  },
);
slackSocket.start();
void database.listChannels().then((channels) => channels.forEach((channel) => slackMetadata.schedule(channel.workspaceId, channel.channelId)));

const app = express();

function requireBearer(expected: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (token !== expected) return response.status(401).json({ error: "unauthorized" });
    next();
  };
}

app.use(express.json({ limit: "1mb" }));
const handleMcpRequest = createMcpRequestHandler(database, config.threadSettleSeconds);
app.post("/mcp", requireBearer(config.mcpAuthToken), handleMcpRequest);
app.get("/mcp", requireBearer(config.mcpAuthToken), handleMcpRequest);

app.get("/dashboard/status", async (_request, response, next) => {
  try { response.json({ ...(await database.dashboardStatus()), socketMode: slackSocket.status() }); } catch (error) { next(error); }
});
app.get("/dashboard/channels", async (_request, response, next) => {
  try { response.json({ channels: await database.listChannels() }); } catch (error) { next(error); }
});
app.post("/dashboard/metadata/sync", async (_request, response, next) => {
  try {
    const channels = await database.listChannels();
    channels.forEach((channel) => slackMetadata.schedule(channel.workspaceId, channel.channelId, true));
    response.status(202).json({ queued: channels.length });
  } catch (error) { next(error); }
});
app.get("/dashboard/backfill", async (_request, response, next) => {
  try { response.json({ jobs: await database.listBackfillJobs(), suggestions: await database.listBackfillSuggestions() }); } catch (error) { next(error); }
});
app.post("/dashboard/targets", async (request, response, next) => {
  try {
    const workspaceId = inputString(request.body, "workspaceId"); const channelId = inputString(request.body, "channelId");
    await database.addObservationTarget(workspaceId, channelId);
    slackMetadata.schedule(workspaceId, channelId);
    response.status(201).json({ workspaceId, channelId });
  } catch (error) { next(error); }
});
app.post("/dashboard/backfill/initial", async (_request, response, next) => {
  try {
    const endAt = new Date(); const startAt = new Date(endAt.getTime() - config.messageRetentionDays * 86_400_000);
    const created = await database.createBackfillJob("initial", startAt, endAt, config.messageRetentionDays);
    backfillWorker.wake(); response.status(202).json(created);
  } catch (error) { next(error); }
});
app.post("/dashboard/backfill/manual", async (request, response, next) => {
  try {
    const startAt = validDate(inputString(request.body, "startAt")); const endAt = validDate(inputString(request.body, "endAt"));
    const created = await database.createBackfillJob("manual", startAt, endAt, config.messageRetentionDays);
    backfillWorker.wake(); response.status(202).json(created);
  } catch (error) { next(error); }
});
app.post("/dashboard/backfill/suggestions/:id/accept", async (request, response, next) => {
  try {
    const created = await database.acceptBackfillSuggestion(validId(request.params.id), config.messageRetentionDays);
    backfillWorker.wake(); response.status(202).json(created);
  } catch (error) { next(error); }
});
app.post("/dashboard/backfill/suggestions/:id/dismiss", async (request, response, next) => {
  try { await database.dismissBackfillSuggestion(validId(request.params.id)); response.status(204).end(); } catch (error) { next(error); }
});
app.post("/dashboard/backfill/:id/cancel", async (request, response, next) => {
  try { await database.cancelBackfillJob(validId(request.params.id)); response.status(204).end(); } catch (error) { next(error); }
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
  backfillWorker.stop();
  slackSocket.stop();
  httpServer.close();
  await database.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function inputString(value: unknown, name: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>)[name] !== "string" || !(value as Record<string, string>)[name].trim()) throw new Error(`${name} is required`);
  return (value as Record<string, string>)[name].trim();
}
function validDate(value: string): Date { const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error("Invalid timestamp"); return date; }
function validId(value: string): number { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid id"); return id; }
