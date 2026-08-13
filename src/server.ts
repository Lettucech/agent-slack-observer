import express, { type NextFunction, type Request, type Response } from "express";
import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { createMcpRequestHandler } from "./mcp.js";
import { SlackMetadataSync } from "./slack-metadata.js";
import { SocketModeObserver } from "./socket-mode.js";

const config = loadConfig();
const database = new Database(config.databaseUrl);
await database.migrate();

const slackMetadata = new SlackMetadataSync(config.slackBotToken, database);
const slackSocket = new SocketModeObserver(config.slackAppToken, database, (workspaceId, channelId) => slackMetadata.schedule(workspaceId, channelId));
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
  slackSocket.stop();
  httpServer.close();
  await database.close();
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
