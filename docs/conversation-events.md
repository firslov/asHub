# Conversation event presentation

Desktop and remote clients share the pure rules in
`web/js/conversation-presentation.js`. The remote copy must remain identical;
the contract regression checks this when the separately maintained remote tree
is available. Each client continues to own its DOM, transport, authorization
controls, and responsive layout.

## Result and lifecycle rules

- `diagnosticState` distinguishes a pending call, a failed call, a partial child
  result (budget or iteration limit), and an ended call. It reads existing
  `success`, `isError`, `error`, `exitCode`, and `degraded` fields. Failure wins
  over an otherwise successful exit or partial result. An ended execution is
  not proof that the user's overall task succeeded.
- `turnLifecycle` recognizes main-agent start, completion, cancellation, and
  error events. Cleanup completion retains an earlier cancellation/error until
  the next explicit processing start. Tool and child-agent results do not
  change the main turn's outcome.
- `activityState` derives running, waiting, or settled presentation. Background
  collaborators can continue after normal main-turn completion; late events
  cannot reopen a cancelled or failed activity indicator.

These rules are compatible with existing event payloads and do not add a new
wire protocol or modify kernel execution. New or unknown diagnostic records
remain available in the existing detail views.

## Lightweight replay

`src/remote/replay.ts` may shorten diagnostic content, but retains call/child/
swarm identities, result flags, degradation metadata, and bounded error text.
The preview is explicitly labelled and complete history remains available.
Preview generation never mutates the persisted source event.

## Verification

`tests/fixtures/conversation-events.cjs` provides the common outcome corpus for
actual desktop handlers, full/preview mobile rendering, and transport checks.
The existing activity and mobile lifecycle suites also cover cancellation,
cleanup events, pending background collaborators, and approvals. Run the normal
architecture, activity, mobile replay, and remote rendering suites after changing
these rules; Electron activity/detail tests cover real DOM layout separately.
