import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { NextFunction, Request, Response } from "express";
import { createMcpRequestHandler, createMcpTransport } from "../src/mcp.js";
import type { Database } from "../src/db.js";
import type { StoredMessage } from "../src/types.js";

test("creates a fresh stateless MCP transport for each HTTP request", async () => {
  const created: number[] = [];
  const connected: number[] = [];
  const handled: number[] = [];
  const factory: typeof createMcpTransport = () => {
    const id = created.length + 1;
    created.push(id);
    return {
      server: {} as ReturnType<typeof createMcpTransport>["server"],
      transport: {
        handleRequest: async () => { handled.push(id); },
      } as ReturnType<typeof createMcpTransport>["transport"],
      connect: async () => { connected.push(id); },
    };
  };
  const handler = createMcpRequestHandler({} as Database, 90, factory);
  const next: NextFunction = (error) => { if (error) throw error; };

  await handler({ body: {} } as Request, {} as Response, next);
  await handler({ body: {} } as Request, {} as Response, next);

  assert.deepEqual(created, [1, 2]);
  assert.deepEqual(connected, [1, 2]);
  assert.deepEqual(handled, [1, 2]);
});

test("uses a consumer inbox without requiring an agent cursor and acknowledges only supplied events", async () => {
  const pendingCalls: Array<{ consumerId: string; upperSequence: number; settleSeconds: number }> = [];
  const acknowledgements: Array<{ consumerId: string; eventIds: string[] }> = [];
  const messages: StoredMessage[] = [{ eventId: "Ev1", eventSequence: 1, workspaceId: "T1", channelId: "C1", conversationType: "private_channel", messageTs: "1000.0", threadTs: null, userId: "U1", subtype: null, text: "pending", payload: {}, observedAt: "2026-08-13T00:00:00Z" }];
  const acknowledged = new Map<string, Set<string>>();
  const database = {
    latestSequence: async () => 9,
    pendingMessages: async (consumerId: string, upperSequence: number, settleSeconds: number) => {
      pendingCalls.push({ consumerId, upperSequence, settleSeconds });
      return messages.filter((message) => !acknowledged.get(consumerId)?.has(message.eventId));
    },
    changedMessages: async () => assert.fail("consumer reads must not depend on afterSequence"),
    hydrateThreads: async (items: StoredMessage[]) => items,
    acknowledgeMessages: async (consumerId: string, eventIds: string[]) => {
      acknowledgements.push({ consumerId, eventIds });
      const seen = acknowledged.get(consumerId) ?? new Set<string>();
      acknowledged.set(consumerId, seen);
      const acknowledgedEventIds = eventIds.filter((eventId) => !seen.has(eventId));
      acknowledgedEventIds.forEach((eventId) => seen.add(eventId));
      return { acknowledgedEventIds, alreadyAcknowledgedEventIds: eventIds.filter((eventId) => seen.has(eventId) && !acknowledgedEventIds.includes(eventId)), unknownEventIds: [] };
    },
  } as unknown as Database;
  const { server } = createMcpTransport(database, 90);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const digest = await client.callTool({ name: "get_digest_batches", arguments: { consumerId: "hermes", afterSequence: 999, maxTokens: 1000 } });
    const digestBatch = digest.structuredContent as { groups: Array<{ ackToken?: string; conversationType: string }> };
    assert.equal(digestBatch.groups.length, 1);
    assert.equal(typeof digestBatch.groups[0].ackToken, "string");
    assert.equal(digestBatch.groups[0].conversationType, "private_channel");
    assert.deepEqual(pendingCalls, [{ consumerId: "hermes", upperSequence: 9, settleSeconds: 90 }]);

    const ack = await client.callTool({ name: "ack_digest", arguments: { ackToken: digestBatch.groups[0].ackToken } });
    assert.deepEqual(ack.structuredContent, { acknowledgedEventIds: ["Ev1"], alreadyAcknowledgedEventIds: [], unknownEventIds: [] });
    assert.deepEqual(acknowledgements, [{ consumerId: "hermes", eventIds: ["Ev1"] }]);

    const hermesAgain = await client.callTool({ name: "get_digest_batches", arguments: { consumerId: "hermes", maxTokens: 1000 } });
    const anotherConsumer = await client.callTool({ name: "get_digest_batches", arguments: { consumerId: "another-agent", maxTokens: 1000 } });
    assert.equal((hermesAgain.structuredContent as { groups: unknown[] }).groups.length, 0);
    assert.equal((anotherConsumer.structuredContent as { groups: unknown[] }).groups.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("continues an oversized message without dropping text", async () => {
  const oversized: StoredMessage = { eventId: "Ev-large", eventSequence: 1, workspaceId: "T1", channelId: "C1", conversationType: "unknown", messageTs: "1000.0", threadTs: null, userId: "U1", subtype: null, text: "x".repeat(500), payload: { blocks: "ignored" }, observedAt: "2026-08-13T00:00:00Z" };
  const database = { getMessage: async () => oversized } as unknown as Database;
  const { server } = createMcpTransport(database, 90);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    let offset = 0;
    let reconstructed = "";
    let finalAckToken: string | undefined;
    for (let index = 0; index < 20; index += 1) {
      const result = await client.callTool({ name: "get_message_digest", arguments: { consumerId: "hermes", workspaceId: "T1", channelId: "C1", messageTs: "1000.0", afterTextOffset: offset, maxTokens: 128 } });
      const segment = result.structuredContent as { message: { text: string; textContinues?: number }; ackToken?: string };
      reconstructed += segment.message.text;
      if (segment.message.textContinues === undefined) {
        finalAckToken = segment.ackToken;
        break;
      }
      assert.equal(segment.ackToken, undefined);
      offset = segment.message.textContinues;
    }
    assert.equal(reconstructed, oversized.text);
    assert.equal(typeof finalAckToken, "string");
  } finally {
    await client.close();
    await server.close();
  }
});

test("normalizes numeric Slack timestamps coerced by an MCP client", async () => {
  const message: StoredMessage = { eventId: "Ev-ts", eventSequence: 1, workspaceId: "T1", channelId: "C1", conversationType: "unknown", messageTs: "1786501755.941399", threadTs: null, userId: "U1", subtype: null, text: "one", payload: {}, observedAt: "2026-08-13T00:00:00Z" };
  const messageLookups: string[] = [];
  const threadLookups: Array<{ threadTs: string; afterMessageTs: string | undefined }> = [];
  const database = {
    getMessage: async (_workspaceId: string, _channelId: string, messageTs: string) => {
      messageLookups.push(messageTs);
      return message;
    },
    getThread: async (_workspaceId: string, _channelId: string, threadTs: string, afterMessageTs: string | undefined) => {
      threadLookups.push({ threadTs, afterMessageTs });
      return [message];
    },
    latestSequence: async () => 1,
  } as unknown as Database;
  const { server } = createMcpTransport(database, 90);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await client.callTool({ name: "get_message_digest", arguments: { consumerId: "hermes", workspaceId: "T1", channelId: "C1", messageTs: 1786501755.941399, afterTextOffset: 0, maxTokens: 128 } });
    await client.callTool({ name: "get_thread_digest", arguments: { consumerId: "hermes", workspaceId: "T1", channelId: "C1", threadTs: 1786501755.941399, afterMessageTs: 1786501755.941399, maxTokens: 128 } });
    assert.deepEqual(messageLookups, ["1786501755.941399"]);
    assert.deepEqual(threadLookups, [
      { threadTs: "1786501755.941399", afterMessageTs: "1786501755.941399" },
      { threadTs: "1786501755.941399", afterMessageTs: undefined },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
