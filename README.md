# Agent Slack Observer

An agent-facing, one-way Slack observer. Slack Events API payloads arrive over an outbound Socket Mode WebSocket and this service stores them, then exposes Slack-read MCP tools plus consumer-local delivery acknowledgements for an agent's own cron job. With an optional user token, the local dashboard can find conversations the authorised user can see, then lets you explicitly include selected conversations in read-only recovery coverage. When Socket Mode has a confirmed gap, it automatically queues a rate-limited recovery for that coverage.

```text
Slack channel → Slack Socket Mode → observer database → Slack-read MCP + local ack → agent cron
```

The observer never uses Slack MCP or posts a reply. It can record a consumer's successful local digest acknowledgement, but this never alters Slack, deletes retained messages, or affects another consumer. It makes the narrow app-level `apps.connections.open` call required to establish its outbound Socket Mode WebSocket and low-frequency name lookups. `conversations.list` runs only after an explicit dashboard action; `conversations.history` and `conversations.replies` run for an explicit index/manual action or a detected Socket Mode recovery gap. It never calls Slack search or messaging APIs.

## Start it

1. Start the service:

   ```sh
   docker compose up --build
   ```

   To use a different local port without restoring an `.env` file:

   ```sh
   PORT=13000 docker compose up --build
   ```

2. Open `http://localhost:3000`. Until setup is complete, Observer shows a dedicated onboarding flow rather than the dashboard.

3. Choose either a User or Bot Token, review its scopes, then enter the App Token and selected read token. The dashboard stores only that choice and removes the unselected read token when you save. Use **Test connection** before saving; it verifies Slack without writing settings or starting Socket Mode. Save to activate the observer immediately. The dashboard generates an MCP bearer token on the first save and displays it once.

The MCP endpoint is `http://localhost:3000/mcp` and requires the Bearer token generated or rotated in the dashboard.

PostgreSQL is internal to Docker Compose. The observer receives its database connection only from the Compose network; users never need to configure a database URL. Compose binds the dashboard and MCP port to `127.0.0.1` only, so other LAN devices cannot reach it.

## Dashboard-first settings

The dashboard stores Slack credentials, the generated MCP bearer token, and runtime limits in the PostgreSQL volume. It returns only whether each secret is configured; saved values are never sent back to the browser, endpoints, or logs. Updating settings immediately restarts the affected local Socket Mode and backfill workers.

| Dashboard setting | Default | Purpose |
| --- | --- | --- |
| Slack App Token | — | Opens and reconnects the outbound Socket Mode WebSocket. |
| Slack User Token | — | Choose this for explicit user-visible conversation discovery and Slack reads. |
| Slack Bot Token | — | Choose this for channels where the installed bot has access. Only one Slack read token is stored. |
| MCP bearer token | Generated on first save | Authenticates agents to `/mcp`; rotate it from the dashboard when needed. |
| Thread settle seconds | 90 | Wait before MCP offers an active thread to an agent. |
| Message retention days | 30 | Retain normalized message and thread context. |
| Raw event retention days | 7 | Retain raw Socket Mode and backfill payloads. |
| Backfill interval seconds | 60 | Minimum spacing between history and replies calls. |
| Recover Socket Mode gap after seconds | 300 | Minimum confirmed gap before an automatic recovery is queued. |

### Why the Slack App-Level Token is needed

Company networks that allow outbound connections but block inbound public callbacks can use Slack Socket Mode. The dashboard accepts an app-level `xapp-…` token with only `connections:write`; the observer uses it to request a temporary WebSocket URL, then connects out to Slack and receives Events API payloads on that socket. No public webhook URL, tunnel, or inbound Slack request is required. [Slack Socket Mode](https://api.slack.com/apis/connections/socket) [connections:write scope](https://docs.slack.dev/reference/scopes/connections.write/)

## Slack app setup

This service does **not** create or install the Slack app. Each user does that in Slack; bot-only operation also requires adding the installed bot to every channel it should observe.

1. Create a Slack app, enable a bot user, and install it to the target workspace.
2. Under **OAuth & Permissions**, add scopes to the selected **user** or **bot** token only for the conversation types you intend to observe. The dashboard lists the complete scope checklist:
   - Public channels: `channels:read`, `channels:history`
   - Private channels (optional): `groups:read`, `groups:history`
   - Direct messages (optional): `im:read`, `im:history`
   - Group direct messages (optional): `mpim:read`, `mpim:history`
   - Workspace metadata: `team:read`
3. Under **Settings → Socket Mode**, enable Socket Mode. No Request URL is needed or allowed in this mode.
4. Under **Settings → Basic Information → App-Level Tokens**, choose **Generate Token and Scopes**, give it a name, select `connections:write`, and paste the generated `xapp-…` value into the dashboard's **Slack App Token** field.
5. Under **Event Subscriptions**, enable only matching events: `message.channels`, `message.groups`, `message.im`, and/or `message.mpim`. For bot-only operation, add the installed bot to every observed channel. For user-visible observation, subscribe to the matching Workspace Events after the user has granted the corresponding user scopes. Slack filters those event deliveries to conversations the authorising user can see.
6. Reinstall or re-authorise after scope changes. For user-visible observation, paste the authorising user's `xoxp-…` token into **Slack User Token**; otherwise paste the app's `xoxb-…` token into **Slack Bot Token**.
7. Test and save the dashboard settings. With a user token, use **Find accessible conversations** to list public channels, private channels, DMs, and group DMs that token can see, then click **Include** only for conversations you want in recovery coverage. Finding conversations stores names and IDs only; it does not read message content or add coverage automatically. Without it, include a quiet channel by workspace and channel ID. Socket Mode channels are included automatically after their first event.

The observer uses the selected read token for `auth.test`, `team.info`, `conversations.info`, and dashboard-created backfill. A user-token selection additionally enables explicit `conversations.list` discovery. No Slack API call is made by that discovery feature until its dashboard button is pressed.

### User-visible observation and privacy

The Slack user token is a user OAuth credential, not an app token. Request only these user scopes when the associated conversation types are needed: `channels:read`, `channels:history`, `groups:read`, `groups:history`, `im:read`, `im:history`, `mpim:read`, `mpim:history`. Finding conversations can include DMs and group DMs, but it stores only conversation IDs and display names as excluded candidates. Message content is fetched only after you include a conversation and either build an index, request an exact window, or an automatic recovery is needed; it remains subject to retention.

Slack tokens are stored in the local PostgreSQL volume so the dashboard can apply them without a process restart. The observer never returns them from dashboard or MCP endpoints, and it does not log them. Revoke a token in Slack to invalidate it; switching the selected read-token type removes the formerly selected token immediately on save.

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

The dashboard can also enqueue an explicit start/end time window. After Socket Mode reconnects, a confirmed gap longer than the configured threshold automatically queues recovery for included conversations. That recovery is bounded to the actual missing window and the retention window, is persistent and globally serial, and can be cancelled from the dashboard. Each page cursor, retry time, and current task is stored in PostgreSQL, so a restart resumes at the next request. `429` responses respect Slack's `Retry-After` value.

Backfill covers only conversations in recovery coverage. With a configured user token, **Find accessible conversations** can list completely quiet conversations using `conversations.list`, but they remain excluded until you choose **Include**; otherwise the observer intentionally does not discover them. The full thread guarantee is bounded by the configured message retention window: an old root outside that retained index can only be reconstructed by a separate historical scan.

## Retention

The observer is a bounded inbox, not a permanent Slack archive. Raw Slack payloads are deleted after the configured raw-event window (7 days by default). Normalized messages are deleted after the configured message window (30 days by default), except a thread root is retained while it still has a retained reply so a fresh reply remains intelligible to the agent. The dashboard reports the earliest locally available message context.

## MCP: context-aware reads

The MCP transport is Streamable HTTP at `/mcp`, protected by the independent agent token. It exposes only these tools:

| Tool | Purpose |
| --- | --- |
| `get_digest_batches` | Return one consumer's unacknowledged messages in context-sized groups. Every complete group includes an opaque `ackToken`. |
| `get_message_digest` | Continue one oversized message's text without loss. Its final segment includes a receipt for that message only. |
| `ack_digest` | Mark one completed delivery receipt with its `ackToken`. It never changes Slack or deletes retained observer messages. |
| `get_thread_digest` | Continue a thread that cannot fit in one context window; its final chunk includes an `ackToken` for the complete settled thread snapshot. |
| `list_channels` | List channel IDs that have actually emitted observed messages. |
| `get_observer_status` | Read local counts and latest-received time. |

`get_digest_batches` takes `maxTokens`, which should be the model context remaining after the agent reserves system prompt, tools, and output tokens. Digest results are a bounded projection: they include message identity, timestamp, author, subtype, and text, but never the stored raw Slack payload. Budgeting counts the projected JSON bytes conservatively. If one message's text cannot fit, the result contains a lossless first segment plus `textContinues`, a Unicode code-point offset for `get_message_digest`; no text is discarded. New messages are held for the configured thread-settle window (90 seconds by default) after the latest activity, reducing the chance of digesting a thread while it is still active.

For the consumer inbox workflow, an agent chooses a stable `consumerId`, calls `get_digest_batches`, then calls `ack_digest` with the opaque `ackToken` returned with each complete group. When `textContinues` is present, it must first call `get_message_digest` repeatedly with the same consumer and next offset. Only that tool's final text segment has a receipt, scoped to the completed event. If the completed message is an oversized thread root, continue replies with `get_thread_digest` using `includeRoot: false` so the root does not restart from its first text segment. The server signs every receipt with the exact event snapshot and consumer, so the agent never constructs IDs or persists a cursor. Acknowledgements are idempotent and scoped to that consumer; they do not delete the retained event or message, so thread hydration, retries, and other agents remain safe. For an oversized thread, the final `get_thread_digest` chunk returns its receipt after all chunks have been read.

### Agent digest skill

This repository ships `slack-observer-digest`, an optional cross-agent skill that teaches an agent to consume these read-only MCP tools safely and efficiently. It uses a thread-first workflow, token-aware batches, local cursors, and event de-duplication; it never instructs the agent to reply in Slack.

After this repository is published to GitHub, install it into Codex with:

```sh
npx skills add <github-owner>/agent-slack-observer --skill slack-observer-digest --agent codex
```

Add `-g` to install it globally instead of only in the current agent project. The MCP endpoint and dashboard-generated bearer token remain a separate, local agent configuration; the skill contains no deployment URL or credentials. [skills CLI](https://github.com/vercel-labs/skills)

Example remote MCP configuration shape (adapt this to the agent host's configuration format):

```json
{
  "url": "https://observer.example.com/mcp",
  "headers": { "Authorization": "Bearer YOUR_DASHBOARD_GENERATED_TOKEN" }
}
```

## Dashboard and security

The dashboard is intentionally unauthenticated for this local-first deployment and Compose binds it to `127.0.0.1`. It shows observer status, target channels, cached workspace/channel names and IDs, backfill controls, and the setup form; it does not return saved Slack tokens or MCP credentials. It can cause read-only Slack conversation-list/history calls, so do not expose it beyond the intended local environment without adding authentication. PostgreSQL stores raw message payloads **and dashboard-configured credentials**; protect the Docker volume, backups, and host account accordingly.

## Verification

```sh
npm run build
npm test
docker compose up --build
curl http://localhost:3000/healthz
```

The tests cover thread grouping, oversized-thread root retention, cursor persistence, and `Retry-After` handling. A live Slack connection needs an outbound-allowed network and a manually configured Socket Mode Slack app.
