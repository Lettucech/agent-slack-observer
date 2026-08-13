import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { createMcpRequestHandler, createMcpTransport } from "../src/mcp.js";
import type { Database } from "../src/db.js";

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
