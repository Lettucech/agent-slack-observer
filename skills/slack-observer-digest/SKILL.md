---
name: slack-observer-digest
description: Retrieve, digest, acknowledge, and summarize messages from an Agent Slack Observer's Slack-read MCP endpoint. Use when an agent is reviewing monitored Slack activity on a schedule, needs to preserve thread context within a model-token budget, or needs to turn pending Slack conversations into concise actions, decisions, or status updates.
---

# Slack Observer Digest

Use the observer as a Slack read-only inbox. It monitors channels chosen by its owner; never reply in Slack, alter Slack state, or use Slack history/search APIs as part of this workflow. `ack_digest` only updates this consumer's local delivery state; it never changes Slack or deletes retained observer data.

## Before reading

- Ensure the observer MCP server is configured outside this skill, including its bearer token. Never request, print, or persist that token in a summary.
- Pick and keep a stable `consumerId` for this scheduled digesting agent (for example, `hermes-vault-digest`). The observer tracks successful acknowledgements separately for each consumer, so another agent cannot clear this inbox.
- Keep an unfinished thread continuation (`workspaceId`, `channelId`, `threadTs`, `afterMessageTs`) only while processing. A consumer inbox does not need a persisted `upperSequence`, handled-event IDs, or acknowledgement state.
- Set `maxTokens` to the input context remaining after reserving system, tool, and answer tokens. Prefer a conservative budget; message token estimates are approximate.

## Digest workflow

1. Optionally call `get_observer_status` to distinguish an empty inbox from an unhealthy observer. Call `list_channels` when names or stable channel IDs are needed for reporting.
2. Call `get_digest_batches` with your `consumerId`, token budget, and the default settling delay unless urgency justifies `settleSeconds: 0`. Do not send `afterSequence`: it is ignored for a consumer inbox. `upperSequence` is diagnostic only.
3. Process each returned group as one conversation:
   - Preserve chronological order.
   - For a `thread`, read the root and replies together, even if the replies arrived between unrelated channel messages.
   - For a `channel_window`, treat the nearby messages as one local discussion, but do not invent a thread relationship.
   - Use `workspaceName` and `channelName` as helpful labels only; IDs are the stable references.
4. Extract only material information: decisions, owners, deadlines, blockers, open questions, and changes that affect the requesting task. Attribute claims to the speaker or message when ambiguity matters. Do not expose raw payloads unless the user needs forensic detail.
5. If `threadContinues` is true, call `get_thread_digest` for that exact thread with the same `consumerId`. Pass the last returned non-root `messageTs` as `afterMessageTs`; keep the repeated root as context. Continue until the thread no longer continues before treating that thread as digested.
6. After saving a complete group, call `ack_digest` with exactly its `ackToken`. Do not acknowledge a partial or failed group. A final thread chunk's token covers the complete settled thread snapshot.

## Acknowledgement safety

`ack_digest` is idempotent: a retry reports already-acknowledged events and leaves the inbox correct. Receipts expire after seven days; re-fetch if one expires.

If `hasMore` is true while no returned group has `threadContinues`, acknowledge each complete group, then call `get_digest_batches` again with the same `consumerId`. The server will return the remaining unacknowledged inbox; no cursor advancement is needed.

## Output shape

Match the user's request. A useful default is:

```text
Slack digest — <workspace> / #<channel>
- Decision: ...
- Owner and deadline: ...
- Blocker or open question: ...
- Relevant context: ...
```

For a no-change run, say that there were no settled, new messages. For task execution, convert relevant items into a short next-action list and keep the source thread reference nearby.
