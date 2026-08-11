# Agent Slack Observer

An agent-facing, one-way Slack observer. A Slack app's bot receives Events API webhooks only for channels it has joined; this service verifies and stores them, then exposes **read-only MCP tools** for an agent's own cron job.

```text
Slack channel → Slack Events API → observer database → read-only MCP → agent cron
```

The observer never calls Slack Web API, never uses Slack MCP, never posts a reply, and never records whether an agent has processed a message. The only outbound response is the HTTP success response Slack's delivery protocol requires.

## Start it

1. Copy the environment template and replace all three secrets:

   ```sh
   cp .env.example .env
   ```

2. Start the service:

   ```sh
   docker compose up --build
   ```

3. Open `http://localhost:3000`, then enter `DASHBOARD_AUTH_TOKEN` to see local ingestion health and channel IDs. The MCP endpoint is `http://localhost:3000/mcp` and requires `Authorization: Bearer $MCP_AUTH_TOKEN`.

`DATABASE_URL` inside Compose always points to the included PostgreSQL container. For a non-Compose deployment, replace it with the deployment's PostgreSQL URL.

## Slack app setup

This service does **not** create or install the Slack app. Each user does that in Slack, then adds the installed bot to the channels they intentionally want observed.

1. Create a Slack app, enable a bot user, and install it to the target workspace.
2. Under **OAuth & Permissions**, add the minimal bot scope for every channel type you choose to observe:
   - Public channels: `channels:history`
   - Private channels (optional): `groups:history`
   - Direct messages (optional): `im:history`
   - Group direct messages (optional): `mpim:history`
3. Under **Event Subscriptions**, enable events and set the Request URL to `https://YOUR-HOST/slack/events`. Slack must be able to reach it over public HTTPS.
4. Subscribe to the corresponding bot events: `message.channels` (and, only if required, `message.groups`, `message.im`, `message.mpim`).
5. Copy the Slack app's **Signing Secret** to `SLACK_SIGNING_SECRET`, restart the observer, and let Slack verify the URL.
6. Add the bot to each channel being observed. The observer does no channel discovery and makes no history backfill request.

The observer needs no bot token (`xoxb-…`); do not put one in `.env`.

## What happens on a new message

1. Slack sends a signed HTTP event to `/slack/events`.
2. The observer checks its timestamp and HMAC signature against the exact raw body, rejects stale or invalid requests, then stores a raw event and a normalized message in PostgreSQL.
3. `event_id` is unique, so Slack retries cannot create duplicate records.
4. The endpoint returns `200 OK` to Slack. This is a delivery acknowledgement, **not** a Slack channel reply.

The write happens before the response and is intentionally small; model work never runs in the webhook path.

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

The dashboard is a human-only view. It has a separate `DASHBOARD_AUTH_TOKEN`, creates a 12-hour HTTP-only browser session, and does not expose MCP credentials. Put the service behind TLS in real deployment and keep both tokens secret. PostgreSQL stores raw message payloads, so set backups and infrastructure access policy accordingly.

## Verification

```sh
npm run build
npm test
docker compose up --build
curl http://localhost:3000/healthz
```

The tests cover Slack signing checks plus thread grouping and oversized-thread root retention. A live Slack webhook still needs a public HTTPS URL and a manually configured Slack app.
