import assert from "node:assert/strict";
import test from "node:test";
import { SocketModeObserver } from "../src/socket-mode.js";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly readyState = FakeSocket.OPEN;
  readonly sent: string[] = [];

  constructor(_url: string) {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(value: string) { this.sent.push(value); }
  close() { this.dispatchEvent(new Event("close")); }
  emitMessage(payload: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) })); }
}

test("stores and acknowledges a Socket Mode Events API envelope", async () => {
  const originalFetch = globalThis.fetch;
  const OriginalWebSocket = globalThis.WebSocket;
  const stored: unknown[] = [];
  let socket: FakeSocket | undefined;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, url: "wss://socket.example.test/link" }), { status: 200 });
  globalThis.WebSocket = class extends FakeSocket { constructor(url: string) { super(url); socket = this; } } as typeof WebSocket;
  try {
    const observer = new SocketModeObserver("xapp-test", { storeEnvelope: async (payload: unknown) => { stored.push(payload); return { inserted: true, eventSequence: 1 }; } } as never);
    observer.start();
    await new Promise((resolve) => setImmediate(resolve));
    socket?.emitMessage({ envelope_id: "envelope-1", type: "events_api", payload: { type: "event_callback", event_id: "Ev1", team_id: "T1", event: { type: "message", channel: "C1", ts: "1.0" } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stored.length, 1);
    assert.deepEqual(socket?.sent, [JSON.stringify({ envelope_id: "envelope-1" })]);
    assert.equal(observer.status().state, "connected");
    observer.stop();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = OriginalWebSocket;
  }
});
