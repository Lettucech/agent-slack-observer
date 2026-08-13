import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Database } from "./db.js";
import { makeDigestBatch } from "./digest.js";

export function createMcpTransport(database: Database, defaultSettleSeconds: number) {
  const server = new McpServer(
    { name: "agent-slack-observer", version: "0.1.0" },
    { instructions: "This server is read-only with respect to Slack: it observes already-stored Slack Events and never sends Slack messages. A consumer may acknowledge successfully processed events; acknowledgements affect only that consumer's local inbox, never Slack or other consumers. Workspace/channel names are cached local metadata and may briefly be absent or stale." },
  );

  server.registerTool(
    "get_digest_batches",
    {
      title: "Get context-aware Slack digest batches",
      description: "Read observed Slack messages as context-sized batches. Replies in the same Slack thread are returned together even if unrelated messages arrived between them. With consumerId, return that consumer's unacknowledged inbox and ignore afterSequence; acknowledge successfully processed eventIds with ack_digest. Without consumerId, preserve the legacy client-owned afterSequence cursor behavior.",
      inputSchema: {
        consumerId: z.string().min(1).max(200).optional().describe("Stable name for this digesting consumer. Enables its server-managed inbox; acknowledgements never affect another consumer."),
        afterSequence: z.number().int().min(0).default(0).describe("Legacy cursor used only when consumerId is omitted. It is ignored for a consumer inbox."),
        maxTokens: z.number().int().min(128).max(100000).describe("Maximum estimated input tokens for this response."),
        settleSeconds: z.number().int().min(0).max(3600).optional().describe("Ignore a thread that received a message more recently than this duration. Defaults to observer configuration."),
        channelWindowSeconds: z.number().int().min(30).max(3600).optional().describe("How far apart standalone channel messages may be before a new context group begins."),
      },
    },
    async ({ consumerId, afterSequence, maxTokens, settleSeconds, channelWindowSeconds }) => {
      const upperSequence = await database.latestSequence();
      const effectiveSettleSeconds = settleSeconds ?? defaultSettleSeconds;
      const changed = consumerId
        ? await database.pendingMessages(consumerId, upperSequence, effectiveSettleSeconds)
        : await database.changedMessages(afterSequence, upperSequence, effectiveSettleSeconds);
      const hydrated = await database.hydrateThreads(changed);
      const batch = makeDigestBatch(hydrated, { maxTokens, channelWindowSeconds }, upperSequence);
      return {
        content: [{ type: "text", text: JSON.stringify(batch) }],
        structuredContent: batch,
      };
    },
  );

  server.registerTool(
    "ack_digest",
    {
      title: "Acknowledge successfully digested Slack events",
      description: "Mark supplied eventIds as successfully processed for one consumer's local inbox. This never alters Slack, deletes retained messages, or affects other consumers. Call only after the digest output and any required thread continuation were completed successfully.",
      inputSchema: {
        consumerId: z.string().min(1).max(200),
        eventIds: z.array(z.string().min(1)).min(1).max(1000).describe("Event IDs that this consumer fully digested. Duplicate IDs are safe."),
      },
    },
    async ({ consumerId, eventIds }) => {
      const result = await database.acknowledgeMessages(consumerId, eventIds);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
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
