# Plugin host API v1

Trusted agent-sh extensions running inside asHub can use two handler calls. These are session-bound capabilities, not HTTP endpoints. They do not expose credentials. Check `ctx.list()` before calling; earlier asHub builds do not provide these handlers.

```js
const catalog = await ctx.call('ashub:catalog', { signal });
const receipt = await ctx.call('ashub:execute', {
  signal,
  request: {
    idempotencyKey: 'unique-plan-001',
    operations: [{ type: 'conversation.create', input: {
      title: 'Review', projectId: 'id-from-catalog',
      provider: 'provider-from-catalog', model: 'model-from-catalog',
      thinking: 'default', proxyEnabled: null, instructions: 'Check the evidence'
    } }]
  }
});
```

`catalog` returns `version`, supported `operations`, `currentId`, `currentProjectId`, projects, active agent `conversations` (id/title/cwd/provider/model/thinking/proxyEnabled/projectId/busy), registered models with `thinkingLevels`, and the global proxy default. It contains no conversation contents or authentication data.

## Operations

- `project.create`: `name`, existing absolute `cwd`, optional `members` (currently only the requesting conversation). Adding a member moves it out of its previous project. The preview identifies the move.
- `conversation.create`: `title`, `projectId` or `null`, `cwd` for independent conversations, `provider`, `model`, `thinking` (`default` or a supported value), `proxyEnabled` (`null` inherits global), optional `instructions` (up to 8,000 characters). Omitted model/provider use the requesting conversation's active selection. Project conversations always use the project root. Instructions persist independently of the plugin and are not permission grants. Creation never starts a model turn.

The gateway supports 1–12 operations per request and a 100 KB request limit. It does not implement team templates, role selection, dependency planning or automatic task dispatch. Plugins own those behaviors. Create a project first, then use the returned ID in a separately approved member plan; references to uncreated resources are not supported.

## Authorization and receipts

The host normalizes and validates input, shows the actual operation parameters in a generic read-only preview, and waits up to five minutes for explicit user confirmation. File-tool auto-approval and session-wide approval do not bypass this gate. Only the internal gateway executes approved operations; the plugin cannot pass an `approved` flag or reuse an authorization token. A changed plan needs new confirmation. Cancel or close the requesting conversation to deny pending requests. Forward the tool execution AbortSignal.

Operations are revalidated after approval. Project roots, membership preconditions, directories, available models and reasoning levels cannot silently change underneath an approved plan. Multi-operation execution is sequential and not transactional. Completed operations remain if a later one fails. Cancellation is checked again after asynchronous validation and model setup, before further changes. If cancellation or setup failure occurs after a conversation was created, the error identifies that conversation; later batch items are not started. A metadata persistence failure does not hide the created ID.

An idempotency key is scoped to the requesting conversation. Concurrent duplicates share execution. Completed/failed receipts are written under `hub-sessions/operation-receipts`; repeats return the original result. Reusing a key with changed parameters fails. Denied requests create nothing and may be presented again only on renewed user intent. If the process stops during execution, an `interrupted` receipt prevents automatic re-execution. If a result receipt cannot be saved after execution, the response still contains known results and a persistence error; the earlier running receipt blocks automatic replay. Inspect existing conversations before proposing replacement operations. Retain these receipt files alongside session data when backing up.

Approval preview items use `{title, fields: [{label, value}]}` and are rendered as plain text on desktop and mobile. They are a general host primitive, with no plugin-specific UI.

Extensions execute trusted JavaScript in the application process. This API prevents accidental authorization bypass in normal plugin workflows; it is not a sandbox against malicious extensions with arbitrary filesystem/network access.

## Existing conversation operations

Capability-detect through `catalog.operations`; older v1 hosts only offer creation.

- `conversation.update`: `id` plus one or more of `title`, `model` + `provider` (always together), `thinking`, `proxyEnabled`. Omitted fields are retained; specifying a model without thinking explicitly resets thinking to `default`. Only actual target-model levels are allowed. `null` proxy means inherit. Other parameters, including cwd and instructions, are rejected.
- `conversation.detach`: `id`. Remove project membership, keeping history and original working directory.
- `conversation.archive`: `id`. Archive using the host persistence lifecycle, then remove project membership. History remains restorable from the archive UI.
- `conversation.delete`: `id`. Permanently remove history and uploaded attachments, then remove project membership. Workspace files are kept.

Targets must be live, idle agent conversations with no queued work. Archive/delete cannot target the requesting conversation. Each target can occur only once per plan. The approval preview identifies the target and directory, shows before/after configuration, and distinguishes reversible membership removal, restorable archival, and irreversible deletion. After approval the host rechecks target identity, configuration, membership and activity; concurrent changes invalidate the plan. Existing-operation execution blocks conflicting conversation mutations. No model turn is started. A partial failure reports the target ID and is not automatically replayed; check current state before a new plan. The API adds no project-management-specific policy to asHub.


## Read-only application host protocol

Application extensions receive `ctx.services.host` with `capabilities()`, `snapshot()` and `subscribe(listener)` (returns an unsubscribe function). Register the unsubscribe function with `ctx.onDispose`. Snapshot objects are detached from internal state. There is no unbound execute method: operations still require the source-bound session handlers and explicit user approval above.

The authenticated desktop HTTP interface additionally exposes:

| Endpoint | Contract |
| --- | --- |
| `GET /api/host/capabilities` | v1 queries/operations, invalidation transport, explicit approval and receipt semantics |
| `GET /api/host/snapshot` | `{version:1, epoch, revision, sessions, projects, extensions}` |
| `GET /api/host/events` | SSE `snapshot` on connection, then `invalidation` notices |
| `GET /api/extensions` | `{version:1, features:[{id,name,enabled,state,scope,...}]}` |
| `POST /api/extensions/:id/enabled` | `{enabled:boolean}`, existing auth/Origin/Host checks; 409 if busy |

SSE data contains `{version:1, epoch, revision, kind?, id?}`. Kinds are `sessions`, `projects`, `network`, `extensions` and `configuration`. SSE IDs are `epoch:revision`. No message bodies, credentials or approval tokens are included. Epoch changes on Hub startup. Revision increases within one epoch only. This is a bounded invalidation channel without durable replay: refetch on connection/reconnection, epoch change or a missed revision. Slow consumers are disconnected instead of accumulating unbounded pending events.

The session shape in the snapshot matches legacy `GET /sessions`; projects match `/api/projects`. Snapshots reflect current in-process state, not a cross-process transaction with arbitrary external file edits. Legacy HTTP routes and the v1 plugin handler names remain supported. Only explicit 404/405/501 indicates an older host; authentication or server failures must not be treated as capability absence.

Application extension states are `inactive`, `starting`, `active`, `stopping` and `error`. An enabled extension can still be unavailable during startup or after failure. A failed optional extension does not block core session routes. Feature disable preserves stored data. The remote gateway intentionally does not forward these unrestricted local host/plugin-management routes; it retains its permission-filtered remote protocol.


## Collaboration handlers

Agent conversations with project communication support expose two additional, session-scoped handlers. Feature-detect them with `ctx.list()`; availability is independent of the CRUD approval interface. These handlers do not send messages or create model turns.

- `ashub:collaboration:wait({ targets: [{ id, afterRevision?, afterState? }], waitMs?, signal? })`: 1–16 unique task IDs, default/max 120000 ms; 0 takes a snapshot. Returns `reason` (`changed`, `timeout`, `settled`), unseen terminal `results`, compact `statuses`, `hasMore`, and `cursors` to pass back unchanged as the next targets. Large batches are paged; when `hasMore` is true, use those cursors with `waitMs:0` to drain the remaining deliveries. Deferred results are not acknowledged. Omit a cursor to reread a result. The state cursor detects interrupted receipts after restart even when a failed final disk write causes a revision to be reused. Errors in concise results are capped at 1000 characters with `errorTruncated:true` when shortened; the original remains in the transcript API. Only tasks involving the caller and still within its project are readable. Membership is checked before/after waiting and on project changes. Waiting is abortable. Unchanged completed tasks do not block waiting for other tasks. No transcript text is returned, including on timeout.
- `ashub:collaboration:deliver({ id, delivery: { summary, artifacts: [{label, path}], unresolved: [] }, signal? })`: only the recipient's currently running task can accept a delivery. Summary is 1–2000 characters, up to 8 artifact references (label 1–120, path 1–1000), up to 8 unresolved items (1–300). Exact retries are idempotent; replacements are allowed only during this task. Writes are persisted before success. This does not complete a task or verify its claims; artifact references are inert data and grant no file access.

Corresponding generic model tools are `conversation_wait` and `conversation_deliver`. `conversation_task` remains the original paginated transcript API. Delivery is explicitly `null` when missing; no heuristic or model-generated summary replaces the transcript. Old persisted receipts remain readable and interrupted work remains marked interrupted after restart. Long-running subscribers must propagate cancellation. Team-specific task decomposition and delivery conventions belong in plugins, not these handlers.
