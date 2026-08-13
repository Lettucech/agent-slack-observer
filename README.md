# Agent Slack Observer

An agent-facing, one-way Slack observer. A Slack app's bot receives Events API payloads over an outbound Socket Mode WebSocket for channels it has joined; this service stores them, then exposes Slack-read MCP tools plus consumer-local delivery acknowledgements for an agent's own cron job. Its local dashboard can also create a user-approved, rate-limited backfill job when Socket Mode was unavailable.

```text
Slack channel → Slack Socket Mode → observer database → Slack-read MCP + local ack → agent cron
```

The observer never uses Slack MCP or posts a reply. It can record a consumer's successful local digest acknowledgement, but this never alters Slack, deletes retained messages, or affects another consumer. It makes the narrow app-level `apps.connections.open` call required to establish its outbound Socket Mode WebSocket and low-frequency name lookups. It calls `conversations.history` and `conversations.replies` only through a user-created dashboard backfill queue; it never calls Slack search or messaging APIs.

## Start it

1. Copy the environment template and set the two required secrets:

   ```sh
   cp .env.example .env
   ```

2. Start the service:

   ```sh
   docker compose up --build
   ```

3. Open `http://localhost:${PORT:-3000}` to see local ingestion health and channel IDs. The MCP endpoint is `http://localhost:${PORT:-3000}/mcp` and requires `Authorization: Bearer $MCP_AUTH_TOKEN`.

PostgreSQL is internal to Docker Compose. The observer receives its database connection only from the Compose network; users never need to configure a database URL. Compose binds the dashboard and MCP port to `127.0.0.1` only, so other LAN devices cannot reach it.

## Environment variables

Copy `.env.example` to `.env`; it is ignored by Git. Keep the file and its values out of source control, screenshots, and logs.

| Variable | Required | Where the value comes from | Purpose |
| --- | --- | --- | --- |
| `SLACK_APP_TOKEN` | Yes | Slack App settings → **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**; select `connections:write`. It starts with `xapp-`. | Opens and reconnects the outbound Slack Socket Mode WebSocket. It is not a bot token. |
| `SLACK_BOT_TOKEN` | Yes | Slack App settings → **OAuth & Permissions** → **OAuth Tokens for Your Workspace**, after installing/reinstalling the app. It starts with `xoxb-`. | Cached workspace/channel names and user-triggered, rate-limited history/thread backfill. |
| `MCP_AUTH_TOKEN` | Yes | Generate locally: `openssl rand -base64 32` | Bearer token for the agent connecting to `/mcp`. |
| `PORT` | No | Local deployment choice; defaults to `3000`. | Localhost-only host port published by Docker Compose. The observer itself always listens on private container port `3000`. |
| `THREAD_SETTLE_SECONDS` | No | Local deployment choice; defaults to `90`. | How long a newly active thread waits before MCP offers it to an agent. |
| `MESSAGE_RETENTION_DAYS` | No | Local deployment choice; defaults to `30`. | Normalized message and thread-context retention. |
| `RAW_EVENT_RETENTION_DAYS` | No | Local deployment choice; defaults to `7`. | Shorter retention for raw Socket Mode and backfill payloads. |
| `BACKFILL_REQUEST_INTERVAL_SECONDS` | No | Local deployment choice; defaults to `60`. | Global minimum spacing between `conversations.history` and `conversations.replies` requests. |
| `DOWNTIME_SUGGESTION_SECONDS` | No | Local deployment choice; defaults to `300`. | Minimum Socket Mode gap before the dashboard suggests, but does not start, a backfill. |

### Why the Slack App-Level Token is needed

Company networks that allow outbound connections but block inbound public callbacks can use Slack Socket Mode. `SLACK_APP_TOKEN` is an app-level `xapp-…` token with only `connections:write`; the observer uses it to request a temporary WebSocket URL, then connects out to Slack and receives Events API payloads on that socket. No public webhook URL, tunnel, or inbound Slack request is required. [Slack Socket Mode](https://api.slack.com/apis/connections/socket) [connections:write scope](https://docs.slack.dev/reference/scopes/connections.write/)

Do **not** put any of these in `.env` for this project:

- OAuth client secret — only needed when this service implements an OAuth installation flow; users install their Slack app themselves.
- `DATABASE_URL` — Docker Compose creates the PostgreSQL service and passes its private, internal connection URL directly to the observer.

## Slack app setup

This service does **not** create or install the Slack app. Each user does that in Slack, then adds the installed bot to the channels they intentionally want observed.

1. Create a Slack app, enable a bot user, and install it to the target workspace.
2. Under **OAuth & Permissions**, add the minimal bot scope for every channel type you choose to observe, plus read-only metadata scopes:
   - Public channels: `channels:history`
   - Private channels (optional): `groups:history`
   - Direct messages (optional): `im:history`
   - Group direct messages (optional): `mpim:history`
   - Workspace name: `team:read`
   - Public channel name: `channels:read`
   - Private/DM/MPIM names (only when those are observed): `groups:read`, `im:read`, `mpim:read`
3. Under **Settings → Socket Mode**, enable Socket Mode. No Request URL is needed or allowed in this mode.
4. Under **Settings → Basic Information → App-Level Tokens**, choose **Generate Token and Scopes**, give it a name, select `connections:write`, and copy the generated `xapp-…` value into `SLACK_APP_TOKEN`.
5. Under **Event Subscriptions**, enable events and subscribe to the corresponding bot events: `message.channels` (and, only if required, `message.groups`, `message.im`, `message.mpim`).
6. Reinstall the app after scope changes, then copy its `xoxb-…` bot token from **OAuth Tokens for Your Workspace** into `SLACK_BOT_TOKEN`.
7. Add the bot to each channel being observed. In the dashboard, add any quiet channel's workspace and channel IDs before the first backfill. Socket Mode channels are registered automatically after their first event. The observer does no workspace-wide channel discovery.

The observer uses the bot token only for `team.info` and `conversations.info` metadata calls. It never calls `conversations.history` or `conversations.replies`.

## What happens on a new message

1. The observer opens an outbound Socket Mode WebSocket to Slack with its restricted app-level token.
2. Slack sends an event envelope down that socket; the observer stores the raw event and a normalized message in PostgreSQL.
3. `event_id` is unique, so Slack retries cannot create duplicate records.
4. The observer acknowledges the socket envelope. This is delivery protocol traffic only, **not** a Slack channel reply.

The write happens before the socket acknowledgement and is intentionally small; model work never runs in the ingestion path.

## Complete thread index and backfill

`conversations.history` returns channel root messages rather than the content of every thread reply. To avoid silently losing a reply to an older root, the observer treats the recent message retention window as a finite thread index:

1. Click **Initialize 30-day thread index** after adding the observation targets. The queue scans each target channel's roots and saves their reply metadata.
2. It calls `conversations.replies` only for roots whose reply count is new or has increased, then stores the complete thread.
3. On later backfills, the same root scan detects changed threads; it does not blindly issue one replies call per root.

For a first-time index, let the dashboard job finish before allowing an agent to treat that historical range as a digest queue. Slack paginates history newest-first; the observer orders every returned digest by Slack timestamp, but it cannot make an unfinished remote scan complete instantly.

The dashboard can also enqueue an explicit start/end time window. A detected Socket Mode disconnection produces only a suggested window; no Slack history call happens until a user clicks **Queue fetch**. Jobs are persistent and globally serial: each page cursor, retry time, and current task is stored in PostgreSQL, so a restart resumes at the next request. `429` responses respect Slack's `Retry-After` value.

Backfill covers targets that you deliberately register. It cannot discover a completely quiet channel by itself, because the observer intentionally does not request `conversations.list`. The full thread guarantee is bounded by `MESSAGE_RETENTION_DAYS`: an old root outside that retained index can only be reconstructed by a separate historical scan.

## Retention

The observer is a bounded inbox, not a permanent Slack archive. Raw Slack payloads are deleted after `RAW_EVENT_RETENTION_DAYS` (7 by default). Normalized messages are deleted after `MESSAGE_RETENTION_DAYS` (30 by default), except a thread root is retained while it still has a retained reply so a fresh reply remains intelligible to the agent. The dashboard reports the earliest locally available message context.

## MCP: context-aware reads

The MCP transport is Streamable HTTP at `/mcp`, protected by the independent agent token. It exposes only these tools:

| Tool | Purpose |
| --- | --- |
| `get_digest_batches` | Return observed messages in context-sized groups. With `consumerId`, return only that consumer's unacknowledged inbox. Thread root and replies are grouped together even when unrelated messages were received between them. |
| `ack_digest` | Mark successfully processed event IDs for one consumer's local inbox. It never changes Slack or deletes retained observer messages. |
| `get_thread_digest` | Continue a thread that cannot fit in one context window; the root is repeated in each chunk. |
| `list_channels` | List channel IDs that have actually emitted observed messages. |
| `get_observer_status` | Read local counts and latest-received time. |

`get_digest_batches` takes `maxTokens`, which should be the model context remaining after the agent reserves system prompt, tools, and output tokens. Its tokenizer estimate is intentionally conservative; callers should leave headroom. New messages are held for `THREAD_SETTLE_SECONDS` (90 seconds by default) after the latest activity, reducing the chance of digesting a thread while it is still active.

For the recommended consumer inbox workflow, an agent chooses a stable `consumerId`, calls `get_digest_batches` without `afterSequence`, then calls `ack_digest` only after it has safely completed each group and any required thread continuation. Acknowledgements are idempotent and scoped to that consumer; they do not delete the retained event or message, so thread hydration, retries, and other agents remain safe. A thread with a new reply can intentionally include earlier retained root/context again, which keeps the model from reading a fragment. Legacy callers that omit `consumerId` retain the client-owned `upperSequence` / event-ID de-duplication workflow.

### Agent digest skill

This repository ships `slack-observer-digest`, an optional cross-agent skill that teaches an agent to consume these read-only MCP tools safely and efficiently. It uses a thread-first workflow, token-aware batches, local cursors, and event de-duplication; it never instructs the agent to reply in Slack.

After this repository is published to GitHub, install it into Codex with:

```sh
npx skills add <github-owner>/agent-slack-observer --skill slack-observer-digest --agent codex
```

Add `-g` to install it globally instead of only in the current agent project. The MCP endpoint and `MCP_AUTH_TOKEN` remain a separate, local agent configuration; the skill contains no deployment URL or credentials. [skills CLI](https://github.com/vercel-labs/skills)

Example remote MCP configuration shape (adapt this to the agent host's configuration format):

```json
{
  "url": "https://observer.example.com/mcp",
  "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
}
```

## Dashboard and security

The dashboard is intentionally unauthenticated for this local-first deployment. It shows observer status, target channels, cached workspace/channel names and IDs, and backfill controls/progress; it does not expose MCP credentials. It can cause read-only Slack history calls, so do not expose it beyond the intended local environment without authentication. `MCP_AUTH_TOKEN` remains required to read messages through MCP, and Slack Socket Mode requires the app-level token for ingestion. PostgreSQL stores raw message payloads, so set backups and infrastructure access policy accordingly.

## Verification

```sh
npm run build
npm test
docker compose up --build
curl http://localhost:3000/healthz
```

The tests cover thread grouping, oversized-thread root retention, cursor persistence, and `Retry-After` handling. A live Slack connection needs an outbound-allowed network and a manually configured Socket Mode Slack app.
