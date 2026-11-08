# Task notifications

## Goal and boundary

Reduce coordination latency when a member needs a decision, without turning ordinary progress into interruptions. The host provides a generic, task-bound notification capability and enforces identity, authorization, persistence and delivery. The optional project-management plugin decides what constitutes a blocker, structures the question and guides the coordinator's response. There is no extra model classifier, new permission bypass, global priority switch, or new sidebar panel.

## Channels

| Message | Tool | Behavior |
| --- | --- | --- |
| Independent task | `conversation_send` | Start if idle; queue if busy; separate task receipt |
| Correction to an existing task | `project_management_supplement` | Merge queued task in place or steer its active turn |
| Normal result | `conversation_deliver` | Persist concise delivery; coordinator receives it through `conversation_wait` |
| Decision-blocking issue | `project_management_blocked` | Notify original coordinator; no second collaboration task |

A blocker contains **question, evidence, recommendation**, not a full transcript. Missing essential input, conflicting requirements and risks requiring a decision qualify. Routine progress, recoverable tool failures and reminders do not. This classification uses the member model's tool instructions; the host enforces the concrete boundaries below, rather than claiming to determine urgency from text.

## Delivery

1. Validate the currently running task, its recipient and original sender, current project membership and cancellation state. Only the recipient can notify its sender. The caller cannot choose an arbitrary target or priority.
2. Under the coordinator's context lock, persist a receipt before attempting delivery.
3. Busy coordinator: use the existing safe-boundary steering API. No ongoing model request or tool operation is cancelled. A refused steer is `rejected`, not silently retried or turned into another task.
4. Coordinator waiting in `conversation_wait`: return `reason: attention`, including when the wait concerns another member. This only releases the waiting tool so the queued notification can enter the next model request. The wait result carries compact receipt metadata, not a duplicate copy of the notification text. Existing result cursors still apply.
5. Idle coordinator: submit a normal message through the existing host submission path. If a user turn starts in the intervening lock boundary, the message safely queues. A stopped coordinator is not automatically revived.
6. The member continues independent work. If completely blocked, it delivers current findings with `unresolved` and ends its task instead of waiting for a reply. The coordinator checks current task state before deciding whether to supplement the existing task or plan follow-up work. No automatic acknowledgement loop.

The existing desktop/remote queue UI and SSE events display the message; no new remote mutation endpoint is exposed.

## Deduplication, limits and receipts

- Stable `requestKey` (8–100 word/hyphen characters); same key and same payload returns its existing receipt. Same key with different payload fails.
- Identical content under another key refers to the original receipt; no resend.
- At most one pending/uncertain notice per task; eight attempts per task; 60 seconds between different notices; six attempts per coordinator per minute. Rate-limit failures do not dispatch.
- Message text is capped at 2,000 characters. The plugin's question/evidence/recommendation limits are 600/600/400, with a final serialized-size check.
- `pending` means admitted for delivery; `consumed` means accepted into the coordinator's context/submission, not understood or resolved. `modified` means the user changed the queued content. `dropped`, `rejected`, `uncertain`, and `interrupted` never trigger automatic retries.
- `project_management_blocked_status` reads the receipt without initializing or waking a model.
- Pending/uncertain receipts become `interrupted` after restart; they are not replayed automatically. Cancellation, queue withdrawal and user edits update the receipt through existing queue events. A notification does not replace the child's result or alter either conversation's active task identity.

## Cost and compatibility

A busy coordinator receives one short appended message at its next normal request. No history rewriting or forced cancellation is introduced, preserving the existing cache prefix. An idle wake-up starts a model turn and therefore has the normal token cost of that turn. Limits and the blocker-only policy constrain this cost; they cannot guarantee how a model chooses to use the tool.

The plugin exposes the two new tools only when `ashub:collaboration:signal` exists. Older hosts keep the existing project-management functions. Upgrade the host and plugin together for notifications; restart existing asHub processes after tasks finish.

## Validation

Coverage includes busy steering, idle wake-up, idle-to-busy queue fallback, waits for other members, unchanged task ownership/cursors, duplicate keys/content, invalid and oversized messages, membership changes during restore, stopped coordinators, aborted calls, queue edits/withdrawal, persistence failure, restart, rate limits, old-host fallback, and real plugin/kernel registration. Tests use isolated profiles and a loopback model fixture, not production conversations or paid provider calls.
