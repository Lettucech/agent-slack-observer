import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.js";
import { makeDigestBatch, makeMessageDigestSegment } from "./digest.js";
import type { ThreadCheckpoint } from "./types.js";

// Slack timestamps are identifiers, so consumers should send text. A few MCP
// runtimes coerce numeric-looking tool arguments before they reach the server;
// accepting finite numbers here keeps those clients lossless for normal Slack
// timestamp values while all database lookups still use their canonical text form.
const slackTimestamp = z.union([z.string(), z.number().finite()])
  .transform((value) => String(value))
  .pipe(z.string().min(1));

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
        maxBytes: z.number().int().min(128).max(400000).describe("Maximum UTF-8 bytes for compact digest content before its opaque acknowledgement receipt. This is provider-neutral, not a model-token estimate."),
        settleSeconds: z.number().int().min(0).max(3600).optional().describe("Ignore a thread that received a message more recently than this duration. Defaults to observer configuration."),
        channelWindowSeconds: z.number().int().min(30).max(3600).optional().describe("How far apart standalone channel messages may be before a new context group begins."),
      },
    },
    async ({ consumerId, maxBytes, settleSeconds, channelWindowSeconds }) => {
      const upperSequence = await database.latestSequence();
      const effectiveSettleSeconds = settleSeconds ?? defaultSettleSeconds;
      const changed = await database.pendingMessages(consumerId, upperSequence, effectiveSettleSeconds);
      const checkpoints = await database.threadCheckpoints?.(consumerId, changed) ?? new Map<string, ThreadCheckpoint>();
      const reopened = await database.reopenedThreads?.(consumerId, changed) ?? new Set<string>();
      const hydrated = await database.hydrateThreads(changed, new Set(checkpoints.keys()));
      const batch = makeDigestBatch(hydrated, { maxBytes, channelWindowSeconds }, upperSequence);
      const delivered = addAckTokens(batch, consumerId, new Set(changed.map((message) => message.eventId)), receiptSecret, hydrated);
      for (const group of delivered.groups) {
        const key = group.threadTs ? `${group.workspaceId}\u0000${group.channelId}\u0000${group.threadTs}` : undefined;
        if (key && checkpoints.has(key)) group.checkpoint = checkpoints.get(key);
        if (key && reopened.has(key) && !group.checkpoint && group.messages.length >= 8 && Buffer.byteLength(JSON.stringify(group), "utf8") >= 6_000) group.checkpointSuggested = true;
      }
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
        messageTs: slackTimestamp,
        afterTextOffset: z.number().int().min(0).describe("Unicode code-point offset from textContinues."),
        maxBytes: z.number().int().min(128).max(400000),
      },
    },
    async ({ consumerId, workspaceId, channelId, messageTs, afterTextOffset, maxBytes }) => {
      const message = await database.getMessage(workspaceId, channelId, messageTs);
      if (!message) throw new Error("Message is no longer retained by this observer");
      const segment = makeMessageDigestSegment(message, maxBytes, afterTextOffset);
      const delivered = segment.textContinues === undefined
        ? { message: segment, ackToken: signReceipt({ id: randomUUID(), consumerId, eventIds: [message.eventId], expiresAt: Date.now() + RECEIPT_TTL_MS }, receiptSecret) }
        : { message: segment };
      return { content: [{ type: "text", text: JSON.stringify(delivered) }], structuredContent: delivered };
    },
  );

  server.registerTool(
    "ack_digest",
    {
      title: "Acknowledge successfully digested Slack events",
      description: "Acknowledge one successfully digested delivery receipt. Pass the exact ackToken returned with a complete digest group. Optionally report the agent's measured token usage and elapsed time for the dashboard. This never alters Slack, deletes retained messages, or affects another consumer.",
      inputSchema: {
        ackToken: z.string().min(1),
        usage: z.object({
          inputTokens: z.number().int().min(0).max(10_000_000).describe("Agent-reported input tokens used to digest this receipt."),
          outputTokens: z.number().int().min(0).max(10_000_000).describe("Agent-reported output tokens used to digest this receipt."),
          durationMs: z.number().int().min(0).max(86_400_000).describe("Agent-reported elapsed processing time in milliseconds."),
        }).optional(),
        checkpoint: z.object({
          decisions: z.array(z.object({ text: z.string().min(1).max(500), sourceMessageTs: slackTimestamp, owner: z.string().max(200).optional(), deadline: z.string().max(200).optional() })).max(12).optional(),
          actions: z.array(z.object({ text: z.string().min(1).max(500), sourceMessageTs: slackTimestamp, owner: z.string().max(200).optional(), deadline: z.string().max(200).optional() })).max(12).optional(),
          blockers: z.array(z.object({ text: z.string().min(1).max(500), sourceMessageTs: slackTimestamp, owner: z.string().max(200).optional(), deadline: z.string().max(200).optional() })).max(12).optional(),
          openQuestions: z.array(z.object({ text: z.string().min(1).max(500), sourceMessageTs: slackTimestamp, owner: z.string().max(200).optional(), deadline: z.string().max(200).optional() })).max(12).optional(),
          importantContext: z.array(z.object({ text: z.string().min(1).max(500), sourceMessageTs: slackTimestamp, owner: z.string().max(200).optional(), deadline: z.string().max(200).optional() })).max(12).optional(),
        }).optional(),
      },
    },
    async ({ ackToken, usage, checkpoint }) => {
      const receipt = readReceipt(ackToken, receiptSecret);
      const result = checkpoint && receipt.thread
        ? usage
          ? await database.acknowledgeMessagesAndSaveCheckpointAndRecordConsumption(receipt.consumerId, receipt.eventIds, receipt.id, usage, receipt.thread.workspaceId, receipt.thread.channelId, receipt.thread.threadTs, receipt.thread.coveredThroughTs, checkpoint)
          : await database.acknowledgeMessagesAndSaveCheckpoint(receipt.consumerId, receipt.eventIds, receipt.thread.workspaceId, receipt.thread.channelId, receipt.thread.threadTs, receipt.thread.coveredThroughTs, checkpoint)
        : usage
          ? await database.acknowledgeMessagesAndRecordConsumption(receipt.consumerId, receipt.eventIds, receipt.id, usage)
          : await database.acknowledgeMessages(receipt.consumerId, receipt.eventIds);
      const delivered = { acknowledgedCount: result.acknowledgedEventIds.length, alreadyAcknowledgedCount: result.alreadyAcknowledgedEventIds.length, unknownCount: result.unknownEventIds.length };
      return { content: [{ type: "text", text: JSON.stringify(delivered) }], structuredContent: delivered };
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
        threadTs: slackTimestamp,
        afterMessageTs: slackTimestamp.optional().describe("Last non-root message_ts the agent received for this thread."),
        includeRoot: z.boolean().optional().describe("Set false after separately finishing an oversized root text; default true retains root context."),
        maxBytes: z.number().int().min(128).max(400000),
        settleSeconds: z.number().int().min(0).max(3600).optional(),
      },
    },
    async ({ consumerId, workspaceId, channelId, threadTs, afterMessageTs, includeRoot, maxBytes, settleSeconds }) => {
      const messages = await database.getThread(workspaceId, channelId, threadTs, afterMessageTs, settleSeconds ?? defaultSettleSeconds);
      const digestMessages = includeRoot === false ? messages.filter((message) => message.messageTs !== threadTs) : messages;
      const batch = makeDigestBatch(digestMessages, { maxBytes }, await database.latestSequence());
      const allMessages = await database.getThread(workspaceId, channelId, threadTs, undefined, settleSeconds ?? defaultSettleSeconds);
      const delivered = addAckTokens(batch, consumerId, new Set(allMessages.map((message) => message.eventId)), receiptSecret, allMessages);
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
type Receipt = { id: string; consumerId: string; eventIds: string[]; expiresAt: number; thread?: { workspaceId: string; channelId: string; threadTs: string; coveredThroughTs: string } };
function addAckTokens(batch: ReturnType<typeof makeDigestBatch>, consumerId: string, eligibleEventIds: Set<string>, secret: string, sourceMessages: import("./types.js").StoredMessage[]) {
  const eventIdByTimestamp = new Map(sourceMessages.map((message) => [`${message.workspaceId}:${message.channelId}:${message.messageTs}`, message.eventId]));
  return { ...batch, groups: batch.groups.map((group) => {
    if (group.threadContinues || group.messages.some((message) => message.textContinues !== undefined)) return group;
    const eventIds = group.messages.map((message) => eventIdByTimestamp.get(`${group.workspaceId}:${group.channelId}:${message.messageTs}`)).filter((eventId): eventId is string => Boolean(eventId && eligibleEventIds.has(eventId)));
    const thread = group.threadTs ? { workspaceId: group.workspaceId, channelId: group.channelId, threadTs: group.threadTs, coveredThroughTs: group.messages.at(-1)!.messageTs } : undefined;
    return eventIds.length ? { ...group, ackToken: signReceipt({ id: randomUUID(), consumerId, eventIds: [...new Set(eventIds)], expiresAt: Date.now() + RECEIPT_TTL_MS, ...(thread ? { thread } : {}) }, secret) } : group;
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
  const thread = item.thread;
  if (thread && (typeof thread !== "object" || typeof thread.workspaceId !== "string" || typeof thread.channelId !== "string" || typeof thread.threadTs !== "string" || typeof thread.coveredThroughTs !== "string")) throw new Error("Invalid acknowledgement receipt");
  return { id: typeof item.id === "string" ? item.id : createHash("sha256").update(token).digest("hex"), consumerId: item.consumerId, eventIds: item.eventIds, expiresAt: item.expiresAt, ...(thread ? { thread } : {}) };
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
