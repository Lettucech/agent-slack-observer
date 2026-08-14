import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.js";
import { makeDigestBatch, makeMessageDigestSegment } from "./digest.js";

export function createMcpTransport(database: Database, defaultSettleSeconds: number, receiptSecret = "test-only-receipt-secret") {
  const server = new McpServer(
    { name: "agent-slack-observer", version: "0.1.0" },
    { instructions: "This server is read-only with respect to Slack: it observes already-stored Slack Events and never sends Slack messages. A consumer may acknowledge successfully processed events; acknowledgements affect only that consumer's local inbox, never Slack or other consumers. Workspace/channel names are cached local metadata and may briefly be absent or stale." },
  );

  server.registerTool(
    "get_digest_batches",
    {
      title: "Get context-aware Slack digest batches",
      description: "Read one consumer's unacknowledged Slack inbox as context-sized batches. Every complete group has an opaque ackToken; acknowledge it only after digesting the group successfully.",
      inputSchema: {
        consumerId: z.string().min(1).max(200).describe("Stable name for this digesting consumer. Acknowledgements never affect another consumer."),
        maxTokens: z.number().int().min(128).max(100000).describe("Maximum estimated input tokens for this response."),
        settleSeconds: z.number().int().min(0).max(3600).optional().describe("Ignore a thread that received a message more recently than this duration. Defaults to observer configuration."),
        channelWindowSeconds: z.number().int().min(30).max(3600).optional().describe("How far apart standalone channel messages may be before a new context group begins."),
      },
    },
    async ({ consumerId, maxTokens, settleSeconds, channelWindowSeconds }) => {
      const upperSequence = await database.latestSequence();
      const effectiveSettleSeconds = settleSeconds ?? defaultSettleSeconds;
      const changed = await database.pendingMessages(consumerId, upperSequence, effectiveSettleSeconds);
      const hydrated = await database.hydrateThreads(changed);
      const batch = makeDigestBatch(hydrated, { maxTokens, channelWindowSeconds }, upperSequence);
      const delivered = addAckTokens(batch, consumerId, new Set(changed.map((message) => message.eventId)), receiptSecret);
      return {
        content: [{ type: "text", text: JSON.stringify(delivered) }],
        structuredContent: delivered,
      };
    },
  );

  server.registerTool(
    "get_message_digest",
    {
      title: "Continue one oversized Slack message",
      description: "Read the next lossless text segment after get_digest_batches returns textContinues. Only a final segment has an ackToken for that one event.",
      inputSchema: {
        consumerId: z.string().min(1).max(200),
        workspaceId: z.string().min(1),
        channelId: z.string().min(1),
        messageTs: z.string().min(1),
        afterTextOffset: z.number().int().min(0).describe("Unicode code-point offset from textContinues."),
        maxTokens: z.number().int().min(128).max(100000),
      },
    },
    async ({ consumerId, workspaceId, channelId, messageTs, afterTextOffset, maxTokens }) => {
      const message = await database.getMessage(workspaceId, channelId, messageTs);
      if (!message) throw new Error("Message is no longer retained by this observer");
      const segment = makeMessageDigestSegment(message, maxTokens, afterTextOffset);
      const delivered = segment.textContinues === undefined
        ? { message: segment, ackToken: signReceipt({ consumerId, eventIds: [message.eventId], expiresAt: Date.now() + RECEIPT_TTL_MS }, receiptSecret) }
        : { message: segment };
      return { content: [{ type: "text", text: JSON.stringify(delivered) }], structuredContent: delivered };
    },
  );

  server.registerTool(
    "ack_digest",
    {
      title: "Acknowledge successfully digested Slack events",
      description: "Acknowledge one successfully digested delivery receipt. Pass the exact ackToken returned with a complete digest group. This never alters Slack, deletes retained messages, or affects another consumer.",
      inputSchema: {
        ackToken: z.string().min(1),
      },
    },
    async ({ ackToken }) => {
      const receipt = readReceipt(ackToken, receiptSecret);
      const result = await database.acknowledgeMessages(receipt.consumerId, receipt.eventIds);
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
      description: "Read one observed Slack thread in chronological, context-sized chunks. Use this when get_digest_batches marks threadContinues. Every final chunk has an ackToken covering the whole settled thread snapshot.",
      inputSchema: {
        consumerId: z.string().min(1).max(200),
        workspaceId: z.string().min(1),
        channelId: z.string().min(1),
        threadTs: z.string().min(1),
        afterMessageTs: z.string().optional().describe("Last non-root message_ts the agent received for this thread."),
        includeRoot: z.boolean().optional().describe("Set false after separately finishing an oversized root text; default true retains root context."),
        maxTokens: z.number().int().min(128).max(100000),
        settleSeconds: z.number().int().min(0).max(3600).optional(),
      },
    },
    async ({ consumerId, workspaceId, channelId, threadTs, afterMessageTs, includeRoot, maxTokens, settleSeconds }) => {
      const messages = await database.getThread(workspaceId, channelId, threadTs, afterMessageTs, settleSeconds ?? defaultSettleSeconds);
      const digestMessages = includeRoot === false ? messages.filter((message) => message.messageTs !== threadTs) : messages;
      const batch = makeDigestBatch(digestMessages, { maxTokens }, await database.latestSequence());
      const allMessages = await database.getThread(workspaceId, channelId, threadTs, undefined, settleSeconds ?? defaultSettleSeconds);
      const delivered = addAckTokens(batch, consumerId, new Set(allMessages.map((message) => message.eventId)), receiptSecret);
      return { content: [{ type: "text", text: JSON.stringify(delivered) }], structuredContent: delivered };
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

const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
type Receipt = { consumerId: string; eventIds: string[]; expiresAt: number };
function addAckTokens(batch: ReturnType<typeof makeDigestBatch>, consumerId: string, eligibleEventIds: Set<string>, secret: string) {
  return { ...batch, groups: batch.groups.map((group) => {
    if (group.threadContinues || group.messages.some((message) => message.textContinues !== undefined)) return group;
    const eventIds = group.messages.map((message) => message.eventId).filter((eventId) => eligibleEventIds.has(eventId));
    return eventIds.length ? { ...group, ackToken: signReceipt({ consumerId, eventIds: [...new Set(eventIds)], expiresAt: Date.now() + RECEIPT_TTL_MS }, secret) } : group;
  }) };
}
function signReceipt(receipt: Receipt, secret: string): string {
  const payload = Buffer.from(JSON.stringify(receipt)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
function readReceipt(token: string, secret: string): Receipt {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new Error("Invalid acknowledgement receipt");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("Invalid acknowledgement receipt");
  let receipt: unknown;
  try { receipt = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new Error("Invalid acknowledgement receipt"); }
  if (!receipt || typeof receipt !== "object") throw new Error("Invalid acknowledgement receipt");
  const item = receipt as Partial<Receipt>;
  if (typeof item.consumerId !== "string" || !Array.isArray(item.eventIds) || !item.eventIds.every((id) => typeof id === "string") || typeof item.expiresAt !== "number" || item.expiresAt < Date.now()) throw new Error("Acknowledgement receipt expired or invalid");
  return { consumerId: item.consumerId, eventIds: item.eventIds, expiresAt: item.expiresAt };
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
