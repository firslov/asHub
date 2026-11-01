# Mid-task follow-ups

While a conversation is running, the composer defaults to **Mid-task follow-up**
(中途补充). Click this control to select **Queue for later** (排队发送). The choice
is remembered on that client. Idle submissions start a normal turn.

Follow-ups join the same task at the next model-call boundary, after the current
response and its tool batch finish. They do not cancel an in-flight request or
repeat completed tools. Text and images are supported. Pending follow-ups can be
withdrawn for editing; once consumed they cannot be withdrawn. Stop cancels the
active task and drops its unconsumed follow-ups. During model preparation,
follow-ups fall back to the normal queue. Internal collaboration submissions
continue to use the normal queue by default.

## Contract

- `POST /:session/submit`: optional `delivery: "steer" | "queue"`; omission means
  queue. Remote RPC forwards it only when the host advertises `steering`.
- Every pending item has a unique queue ID. `/queue` exposes its actual delivery
  mode; `/queue/withdraw` uses the existing ID-based operation.
- Consuming a follow-up flushes the prior response segment and emits
  `agent:query` with `steering: true`. It does not start/end a separate task or
  reset the plan, tool ownership, or watchdog. Persistent history IDs still
  support rewind and branching after completion.
- Old hosts keep the existing queue UI. Updating only the remote website does
  not enable steering on an older desktop build.

The pinned agent-sh already implements safe-boundary steering. The explicit
`scripts/patch-steering.cjs` compatibility patch adds optional IDs to its events
and targeted withdrawal, including duplicate texts. It changes no provider or
transport behavior. Installation/build verifies every patch hunk and fails on
an unknown upstream shape, rather than silently accepting an incompatible core.

This avoids deliberately restarting generation or rewriting the system/tools
prefix. Additional instructions and answers still consume tokens; provider
cache hits and actual cost are not guaranteed by this mechanism.

## Verification

- `npm run test:steering`: patch compatibility, composer intent, real agent-sh
  against a local synthetic model, and real Hub HTTP/SSE/history handling.
- `npm run test:steering:ui`: live/replay placement in Electron.
- `npm test` and `npm test --prefix remote`: existing desktop/remote regression.
- `npm run test:layout --prefix remote`: real mobile layout regression.

Tests do not send requests to a paid model or use personal conversations.

## Pending message controls

Pending messages share a compact list with three actions. Edit updates the text
in place and retains attachments and identity. Withdraw removes it without
changing the composer draft. Promote moves a normal queued message to the next
safe model boundary; an already promoted message cannot be added twice.

`POST /:id/queue/update` accepts `id`, `revision`, `requestId`, and `action`
(`edit` with `query`, or `promote`). Stale revisions and consumed messages return
409. Bounded receipts make retries idempotent. `agent:queue-updated` synchronizes
live and replay views. The bridge mutates its pending queues synchronously;
the kernel identity patch replaces an existing steering ID without moving it.
Editing does not pause execution; changes apply only if saved before consumption.
The remote `queueActions` capability gates the new controls for older desktops.

`npm run test:steering:ui` also exercises compact queue layout and the three
actions in real desktop/mobile DOMs, including caret preservation during refresh.
