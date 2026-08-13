import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Database } from "./db.js";
import { makeDigestBatch } from "./digest.js";

export function createMcpTransport(database: Database, defaultSettleSeconds: number) {
  const server = new McpServer(
    { name: "agent-slack-observer", version: "0.1.0" },
    { instructions: "This server is strictly read-only. It observes Slack Events already stored locally and never sends Slack messages. Workspace/channel names are cached local metadata; they may briefly be absent or stale. Store the returned upperSequence yourself and use it as afterSequence on a later cron run." },
  );

  server.registerTool(
    "get_digest_batches",
    {
      title: "Get context-aware Slack digest batches",
      description: "Read observed Slack messages as context-sized batches. Replies in the same Slack thread are returned together even if unrelated messages arrived between them. Pass a token budget after reserving the agent's system/tool/output context. The returned upperSequence is an advisory, client-owned cursor; use a small overlap and eventId de-duplication when polling.",
      inputSchema: {
        afterSequence: z.number().int().min(0).default(0).describe("Last upperSequence saved by the agent; use an overlap if eventual duplicate delivery is acceptable."),
        maxTokens: z.number().int().min(128).max(100000).describe("Maximum estimated input tokens for this response."),
        settleSeconds: z.number().int().min(0).max(3600).optional().describe("Ignore a thread that received a message more recently than this duration. Defaults to observer configuration."),
        channelWindowSeconds: z.number().int().min(30).max(3600).optional().describe("How far apart standalone channel messages may be before a new context group begins."),
      },
    },
    async ({ afterSequence, maxTokens, settleSeconds, channelWindowSeconds }) => {
      const upperSequence = await database.latestSequence();
      const changed = await database.changedMessages(afterSequence, upperSequence, settleSeconds ?? defaultSettleSeconds);
      const hydrated = await database.hydrateThreads(changed);
      const batch = makeDigestBatch(hydrated, { maxTokens, channelWindowSeconds }, upperSequence);
      return {
        content: [{ type: "text", text: JSON.stringify(batch) }],
        structuredContent: batch,
      };
    },
  );

  server.registerTool(
    "list_channels",
    {
      title: "List observed channels",
      description: "List observed Slack channels with their stable IDs and locally cached workspace/channel names, when available.",
      inputSchema: {},
    },
    async () => {
      const channels = await database.listChannels();
      return { content: [{ type: "text", text: JSON.stringify({ channels }) }], structuredContent: { channels } };
    },
  );

  server.registerTool(
    "get_thread_digest",
    {
      title: "Continue a large Slack thread",
      description: "Read one observed Slack thread in chronological, context-sized chunks. Use this when get_digest_batches marks threadContinues. Every chunk repeats the root message; afterMessageTs advances only inside this thread and is owned by the agent.",
      inputSchema: {
        workspaceId: z.string().min(1),
        channelId: z.string().min(1),
        threadTs: z.string().min(1),
        afterMessageTs: z.string().optional().describe("Last non-root message_ts the agent received for this thread."),
        maxTokens: z.number().int().min(128).max(100000),
        settleSeconds: z.number().int().min(0).max(3600).optional(),
      },
    },
    async ({ workspaceId, channelId, threadTs, afterMessageTs, maxTokens, settleSeconds }) => {
      const messages = await database.getThread(workspaceId, channelId, threadTs, afterMessageTs, settleSeconds ?? defaultSettleSeconds);
      const batch = makeDigestBatch(messages, { maxTokens }, await database.latestSequence());
      return { content: [{ type: "text", text: JSON.stringify(batch) }], structuredContent: batch };
    },
  );

  server.registerTool(
    "get_observer_status",
    {
      title: "Get observer health",
      description: "Return local ingestion health and storage counts. No Slack request is made.",
      inputSchema: {},
    },
    async () => {
      const status = await database.dashboardStatus();
      return { content: [{ type: "text", text: JSON.stringify(status) }], structuredContent: status };
    },
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  return { server, transport, connect: () => server.connect(transport) };
}

type McpTransportFactory = typeof createMcpTransport;

// Stateless Streamable HTTP transports may serve only one request. Create a
// fresh server/transport pair for every request so clients can initialize,
// notify, and discover tools over separate HTTP requests.
export function createMcpRequestHandler(
  database: Database,
  defaultSettleSeconds: number,
  createTransport: McpTransportFactory = createMcpTransport,
) {
  return async (request: Request, response: Response, next: NextFunction) => {
    try {
      const { transport, connect } = createTransport(database, defaultSettleSeconds);
      await connect();
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      next(error);
    }
  };
}
