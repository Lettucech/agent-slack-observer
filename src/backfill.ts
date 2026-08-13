import type { BackfillTask, SlackHistoryMessage } from "./db.js";

const FALLBACK_RETRY_MS = 60_000;

export type BackfillDatabase = {
  backfillRuntime(): Promise<{ nextRequestAt: string | null }>;
  claimBackfillTask(): Promise<BackfillTask | null>;
  threadNeedsRefresh(task: BackfillTask): Promise<boolean>;
  storeHistoryPage(task: BackfillTask, messages: SlackHistoryMessage[]): Promise<void>;
  storeReplies(task: BackfillTask, messages: SlackHistoryMessage[]): Promise<void>;
  completeHistoryTask(taskId: number, cursor: string | null): Promise<void>;
  completeBackfillTask(taskId: number): Promise<void>;
  retryBackfillTask(taskId: number, error: string, retryAt: Date): Promise<void>;
  setBackfillRuntime(nextRequestAt: Date, error?: string | null): Promise<void>;
  purgeExpired(rawEventRetentionDays: number, messageRetentionDays: number): Promise<void>;
};

export type BackfillWorkerOptions = {
  requestIntervalSeconds: number;
  rawEventRetentionDays: number;
  messageRetentionDays: number;
};

/**
 * Executes at most one Slack history/replies request at a time. Queue state and
 * rate-limit time live in PostgreSQL, so restart resumes rather than replays a scan.
 */
export class SlackBackfillWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private running = false;

  constructor(private readonly botToken: string, private readonly database: BackfillDatabase, private readonly options: BackfillWorkerOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.wake();
    void this.database.purgeExpired(this.options.rawEventRetentionDays, this.options.messageRetentionDays).catch(() => undefined);
    this.cleanupTimer = setInterval(() => void this.database.purgeExpired(this.options.rawEventRetentionDays, this.options.messageRetentionDays).catch(() => undefined), 60 * 60 * 1000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.timer = undefined;
    this.cleanupTimer = undefined;
  }

  wake(): void {
    if (this.stopped || this.timer || this.running) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, 0);
  }

  async runOnce(): Promise<{ state: "idle" | "waiting" | "worked"; waitMs?: number }> {
    const now = Date.now();
    const runtime = await this.database.backfillRuntime();
    const waitMs = runtime.nextRequestAt ? new Date(runtime.nextRequestAt).getTime() - now : 0;
    if (waitMs > 0) return { state: "waiting", waitMs };
    const task = await this.database.claimBackfillTask();
    if (!task) return { state: "idle" };
    if (task.phase === "replies" && !await this.database.threadNeedsRefresh(task)) {
      await this.database.completeBackfillTask(task.id);
      return { state: "worked" };
    }
    try {
      const result = await this.fetchPage(task);
      if (task.phase === "history") {
        await this.database.storeHistoryPage(task, result.messages);
        await this.database.completeHistoryTask(task.id, result.cursor);
      } else {
        await this.database.storeReplies(task, result.messages);
        await this.database.completeBackfillTask(task.id);
      }
      await this.database.setBackfillRuntime(new Date(Date.now() + this.options.requestIntervalSeconds * 1000));
      return { state: "worked" };
    } catch (error) {
      const retryMs = error instanceof RateLimitError ? error.retryAfterMs : Math.max(this.options.requestIntervalSeconds * 1000, FALLBACK_RETRY_MS);
      const retryAt = new Date(Date.now() + retryMs);
      const message = error instanceof Error ? error.message : "Slack backfill request failed";
      await this.database.retryBackfillTask(task.id, message, retryAt);
      await this.database.setBackfillRuntime(retryAt, message);
      return { state: "waiting", waitMs: retryMs };
    }
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const result = await this.runOnce();
      if (!this.stopped) this.schedule(result.state === "waiting" ? Math.max(250, result.waitMs ?? 1000) : result.state === "worked" ? 0 : 1000);
    } finally { this.running = false; }
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, delayMs);
  }

  private async fetchPage(task: BackfillTask): Promise<{ messages: SlackHistoryMessage[]; cursor: string | null }> {
    const parameters = new URLSearchParams({ channel: task.channelId, oldest: task.oldest, latest: task.latest, limit: "100" });
    if (task.phase === "history" && task.cursor) parameters.set("cursor", task.cursor);
    if (task.phase === "replies") {
      if (!task.rootTs) throw new Error("Reply task is missing its root timestamp");
      parameters.set("ts", task.rootTs);
    }
    const method = task.phase === "history" ? "conversations.history" : "conversations.replies";
    const response = await fetch(`https://slack.com/api/${method}?${parameters}`, { headers: { Authorization: `Bearer ${this.botToken}` } });
    if (response.status === 429) {
      const parsed = Number(response.headers.get("retry-after"));
      throw new RateLimitError(Number.isFinite(parsed) && parsed >= 0 ? parsed * 1000 : FALLBACK_RETRY_MS);
    }
    const body: unknown = await response.json();
    if (!response.ok || !isOk(body)) {
      const detail = isObject(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new Error(`Slack ${method} failed: ${detail}`);
    }
    const messages = Array.isArray(body.messages) ? body.messages.filter(isSlackMessage) : [];
    const cursor = isObject(body.response_metadata) && typeof body.response_metadata.next_cursor === "string" && body.response_metadata.next_cursor ? body.response_metadata.next_cursor : null;
    return { messages, cursor };
  }
}

class RateLimitError extends Error {
  constructor(readonly retryAfterMs: number) { super(`Slack backfill rate limited; retry after ${Math.ceil(retryAfterMs / 1000)}s`); }
}
function isSlackMessage(value: unknown): value is SlackHistoryMessage { return isObject(value) && typeof value.ts === "string"; }
function isOk(value: unknown): value is Record<string, unknown> & { ok: true } { return isObject(value) && value.ok === true; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
