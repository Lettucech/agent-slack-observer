# Agent Slack Observer

An agent-facing, one-way Slack observer. A Slack app's bot receives Events API payloads over an outbound Socket Mode WebSocket for channels it has joined; this service stores them, then exposes **read-only MCP tools** for an agent's own cron job.

```text
Slack channel → Slack Socket Mode → observer database → read-only MCP → agent cron
```

The observer never uses Slack MCP, never posts a reply, and never records whether an agent has processed a message. It makes the narrow app-level `apps.connections.open` call required to establish its outbound Socket Mode WebSocket, and low-frequency name lookups only; it never calls Slack history, search, or messaging APIs.

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
| `SLACK_BOT_TOKEN` | Yes | Slack App settings → **OAuth & Permissions** → **OAuth Tokens for Your Workspace**, after installing/reinstalling the app. It starts with `xoxb-`. | Low-frequency lookup of workspace/channel names only; never reads message history. |
| `MCP_AUTH_TOKEN` | Yes | Generate locally: `openssl rand -base64 32` | Bearer token for the agent connecting to `/mcp`. |
| `PORT` | No | Local deployment choice; defaults to `3000`. | Localhost-only host port published by Docker Compose. The observer itself always listens on private container port `3000`. |
| `THREAD_SETTLE_SECONDS` | No | Local deployment choice; defaults to `90`. | How long a newly active thread waits before MCP offers it to an agent. |

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
7. Add the bot to each channel being observed. The observer does no channel discovery and makes no history backfill request.

The observer uses the bot token only for `team.info` and `conversations.info` metadata calls. It never calls `conversations.history` or `conversations.replies`.

## What happens on a new message

1. The observer opens an outbound Socket Mode WebSocket to Slack with its restricted app-level token.
2. Slack sends an event envelope down that socket; the observer stores the raw event and a normalized message in PostgreSQL.
3. `event_id` is unique, so Slack retries cannot create duplicate records.
4. The observer acknowledges the socket envelope. This is delivery protocol traffic only, **not** a Slack channel reply.

The write happens before the socket acknowledgement and is intentionally small; model work never runs in the ingestion path.

## MCP: context-aware reads

The MCP transport is Streamable HTTP at `/mcp`, protected by the independent agent token. It exposes only these tools:

| Tool | Purpose |
| --- | --- |
| `get_digest_batches` | Return observed messages in context-sized groups. Thread root and replies are grouped together even when unrelated messages were received between them. |
| `get_thread_digest` | Continue a thread that cannot fit in one context window; the root is repeated in each chunk. |
| `list_channels` | List channel IDs that have actually emitted observed messages. |
| `get_observer_status` | Read local counts and latest-received time. |

`get_digest_batches` takes `maxTokens`, which should be the model context remaining after the agent reserves system prompt, tools, and output tokens. Its tokenizer estimate is intentionally conservative; callers should leave headroom. New messages are held for `THREAD_SETTLE_SECONDS` (90 seconds by default) after the latest activity, reducing the chance of digesting a thread while it is still active.

The observer does not own agent progress. An agent cron stores `upperSequence`, thread continuation positions, and processed `eventId`s itself. Poll with a small sequence overlap and de-duplicate `eventId`: a thread with a new reply is intentionally returned with its earlier root/context again, which lets the model read it coherently rather than as a fragment.

Example remote MCP configuration shape (adapt this to the agent host's configuration format):

```json
{
  "url": "https://observer.example.com/mcp",
  "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
}
```

## Dashboard and security

The dashboard is intentionally unauthenticated for this local-first deployment. It shows observer status plus cached workspace/channel names and IDs; it does not expose MCP credentials. `MCP_AUTH_TOKEN` remains required to read messages through MCP, and Slack Socket Mode requires the app-level token for ingestion. Add an authentication system before exposing the dashboard beyond the intended local environment. PostgreSQL stores raw message payloads, so set backups and infrastructure access policy accordingly.

## Verification

```sh
npm run build
npm test
docker compose up --build
curl http://localhost:3000/healthz
```

The tests cover thread grouping and oversized-thread root retention. A live Slack connection needs an outbound-allowed network and a manually configured Socket Mode Slack app.
