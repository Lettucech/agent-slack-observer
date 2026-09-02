---
name: slack-observer-digest
description: Retrieve, digest, acknowledge, and summarize messages from an Agent Slack Observer's Slack-read MCP endpoint. Use when an agent is reviewing monitored Slack activity on a schedule, needs to preserve thread context within a model-token budget, or needs to turn pending Slack conversations into concise actions, decisions, or status updates.
---

# Slack Observer Digest

Use the observer as a Slack read-only inbox. It monitors conversations chosen by its owner, including channels and DMs; never reply in Slack, alter Slack state, or use Slack history/search APIs as part of this workflow. `ack_digest` only updates this consumer's local delivery state; it never changes Slack or deletes retained observer data. The owner can turn a conversation's coverage off at any time; its stored messages are then removed from every consumer inbox without acknowledgement, so a conversation disappearing between runs is expected, not an observer failure. Treat a shrunk inbox as normal and continue from whatever remains.

## Before reading

- Ensure the observer MCP server is configured outside this skill, including its bearer token. Never request, print, or persist that token in a summary.
- Pick and keep a stable `consumerId` for this scheduled digesting agent (for example, `hermes-vault-digest`). The observer tracks successful acknowledgements separately for each consumer, so another agent cannot clear this inbox.
- Keep an unfinished thread continuation (`workspaceId`, `channelId`, `threadTs`, `afterMessageTs`) only while processing. A consumer inbox does not need a persisted `upperSequence`, handled-event IDs, or acknowledgement state.
- Set `maxBytes` to a conservative UTF-8 response-byte allowance derived from the runtime's remaining context. The observer intentionally does not assume a provider tokenizer. Digest results exclude raw Slack payloads. A `textContinues` value is a Unicode code-point offset, not data loss.
- Use `conversationType` to render human-readable conversation labels. Render `public_channel` and `private_channel` as `#<channelName>`; `im` as `DM · <channelName>`; and `mpim` as `Group DM · <channelName>`. For `unknown`, use the available name or stable ID without inventing a type. `channelName` for a DM may be a resolved participant label. Never infer type from the ID or add `#` to a DM.

## Digest workflow

1. Optionally call `get_observer_status` to distinguish an empty inbox from an unhealthy observer. Call `list_channels` when conversation names, types, or stable conversation IDs are needed for reporting.
2. Call `get_digest_batches` with your `consumerId`, `maxBytes`, and the default settling delay unless urgency justifies `settleSeconds: 0`.
3. Process each returned group as one conversation:
   - Preserve chronological order.
   - For a `thread`, read the root and replies together, even if the replies arrived between unrelated channel messages.
   - For a `channel_window`, treat the nearby messages as one local discussion, but do not invent a thread relationship.
   - Use `workspaceName`, `channelName`, and `conversationType` as helpful labels only; IDs are the stable references. Apply the label rule above rather than assuming every conversation is a channel.
4. If any message has `textContinues`, call `get_message_digest` with the same `consumerId`, its workspace/channel/message IDs, the returned offset, and the same budget. Repeat until it has no `textContinues`; concatenate the segments in order. Its final segment has an `ackToken` for that completed event only. If it was a thread root, call `get_thread_digest` with `includeRoot: false` before reading replies, so the root does not restart from its first segment.
5. Extract only material information: decisions, owners, deadlines, blockers, open questions, and changes that affect the requesting task. Attribute claims to the speaker or message when ambiguity matters. Raw Slack payloads are not available through digest tools.
6. If `threadContinues` is true, call `get_thread_digest` for that exact thread with the same `consumerId`. Pass the last returned non-root `messageTs` as `afterMessageTs` and use `includeRoot: false` after the root is already in this execution's context. Continue until the thread no longer continues before treating that thread as digested.
7. If a complete thread has `checkpointSuggested`, include a concise, source-linked checkpoint in `ack_digest`: decisions, actions, blockers, open questions, and important context only. On later runs, the observer returns that checkpoint plus new replies instead of replaying old text. If a new reply is ambiguous, contradictory, or refers to prior wording, use `get_thread_digest` to retrieve the retained raw thread before deciding.
8. After saving a complete group, call `ack_digest` with exactly its `ackToken`. Do not acknowledge a partial or failed group. A final thread chunk's token covers the complete settled thread snapshot.

## Acknowledgement safety

`ack_digest` is idempotent: a retry reports already-acknowledged events and leaves the inbox correct. Receipts expire after seven days; re-fetch if one expires.

If `hasMore` is true while no returned group has `threadContinues`, acknowledge each complete group, then call `get_digest_batches` again with the same `consumerId`. The server will return the remaining unacknowledged inbox; no cursor advancement is needed.

## Output shape

Match the user's request. A useful default is:

```text
Slack digest — <workspace> / <conversation label>
- Decision: ...
- Owner and deadline: ...
- Blocker or open question: ...
- Relevant context: ...
```

For a no-change run, say that there were no settled, new messages. For task execution, convert relevant items into a short next-action list and keep the source thread reference nearby.
