import { createHmac, timingSafeEqual } from "node:crypto";

export function isValidSlackSignature(
  signingSecret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: Buffer,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!timestamp || !signature || !/^v0=[0-9a-f]{64}$/i.test(signature)) return false;
  const eventTime = Number(timestamp);
  if (!Number.isFinite(eventTime) || Math.abs(nowSeconds - eventTime) > 300) return false;
  const base = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function normaliseMessage(eventId: string, eventSequence: number, teamId: string, event: Record<string, unknown>, observedAt: string) {
  const messageTs = typeof event.ts === "string" ? event.ts : null;
  const channelId = typeof event.channel === "string" ? event.channel : null;
  if (event.type !== "message" || !messageTs || !channelId) return null;
  return {
    eventId,
    eventSequence,
    workspaceId: teamId,
    channelId,
    messageTs,
    threadTs: typeof event.thread_ts === "string" ? event.thread_ts : null,
    userId: typeof event.user === "string" ? event.user : null,
    subtype: typeof event.subtype === "string" ? event.subtype : null,
    text: typeof event.text === "string" ? event.text : null,
    payload: event,
    observedAt,
  };
}
