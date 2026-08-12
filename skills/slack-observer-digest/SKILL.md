---
name: slack-observer-digest
description: Retrieve, digest, and summarize messages from an Agent Slack Observer's read-only MCP endpoint. Use when an agent is reviewing monitored Slack activity on a schedule, needs to preserve thread context within a model-token budget, or needs to turn pending Slack conversations into concise actions, decisions, or status updates.
---

# Slack Observer Digest

Use the observer as a read-only inbox. It monitors channels chosen by its owner; never reply in Slack, alter Slack state, or use Slack history/search APIs as part of this workflow.

## Before reading

- Ensure the observer MCP server is configured outside this skill, including its bearer token. Never request, print, or persist that token in a summary.
- Keep agent-owned state: the last safely completed `upperSequence`, handled `eventId`s, and any unfinished thread continuation (`workspaceId`, `channelId`, `threadTs`, `afterMessageTs`). The observer deliberately does not track agent progress.
- Set `maxTokens` to the input context remaining after reserving system, tool, and answer tokens. Prefer a conservative budget; message token estimates are approximate.

## Digest workflow

1. Optionally call `get_observer_status` to distinguish an empty inbox from an unhealthy observer. Call `list_channels` when names or stable channel IDs are needed for reporting.
2. Call `get_digest_batches` with the saved `afterSequence`, your token budget, and the default settling delay unless urgency justifies `settleSeconds: 0`.
3. Process each returned group as one conversation:
   - Preserve chronological order.
   - For a `thread`, read the root and replies together, even if the replies arrived between unrelated channel messages.
   - For a `channel_window`, treat the nearby messages as one local discussion, but do not invent a thread relationship.
   - Use `workspaceName` and `channelName` as helpful labels only; IDs are the stable references.
4. Extract only material information: decisions, owners, deadlines, blockers, open questions, and changes that affect the requesting task. Attribute claims to the speaker or message when ambiguity matters. Do not expose raw payloads unless the user needs forensic detail.
5. If `threadContinues` is true, call `get_thread_digest` for that exact thread. Pass the last returned non-root `messageTs` as `afterMessageTs`; keep the repeated root as context. Continue until the thread no longer continues before treating that thread as digested.
6. De-duplicate by `eventId`. A changed thread can intentionally repeat its earlier root and replies on a later poll; retain that context but do not report the same event twice.

## Cursor safety

Treat `upperSequence` as a client-owned checkpoint, not evidence that every returned item has been handled. Save it only after all returned groups and any required thread continuations have been digested successfully. On the next cron run, use a small sequence overlap and your `eventId` set to tolerate retries and late processing.

If `hasMore` is true while no returned group has `threadContinues`, do **not** advance the checkpoint or silently drop messages. Report that the observer needs an additional batch-pagination cursor before this run can be completed safely.

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
