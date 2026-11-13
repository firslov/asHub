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

### Task supplements

Feature-detect `ashub:collaboration:supplement`. Call with `{id: taskId, requestKey, message?, signal?}`. Only the original task sender, still in the same project as the live recipient, may use it. A message must contain 1–8000 characters; requestKey is 8–100 letters/digits/underscores/hyphens. Omit `message` to read an existing receipt without sending. Source/project identity and cancellation are checked again inside the recipient's context lock.

For a queued task, the host appends the supplement to that exact pending message without changing its queue position. For a running task, it uses strict current-turn steering at the next model-request boundary. It never cancels a tool, starts a second task, or falls back to a new turn. It does not grant user authorization. New messages for an ended task return `state: task_ended` without delivery.

Receipts return `{taskId, requestKey, state, mode, taskState}`. `pending` waits for consumption; `consumed` means included in model context, not understood/completed; `modified` means the user changed the queued contents; `dropped` means withdrawn or ended before consumption; `rejected` means the bridge refused it; `uncertain` means the bridge threw with unknown side effects; `interrupted` means a pending/uncertain receipt was recovered after restart. Unknown receipt keys fail rather than creating work. Exact retries return the same receipt with its latest state; a changed message with the same key is rejected. No unsuccessful/uncertain receipt is automatically resent. Receipts are written before dispatch and persist within the original collaboration task. Limit: 32 supplements per task, 64,000 characters for a combined queued message.

A supplement keeps the original active task and result stream. Once consumed, it invalidates any earlier explicit delivery, so the recipient must submit an updated delivery. Cancellation and withdrawal update the supplement without prematurely completing the active task. Queue changes use the existing desktop/mobile event protocol. Plugins own decisions about urgency, batching, dependencies and follow-up; the host provides only validation, delivery and receipts.

Queued collaboration tasks keep a stable queue ID across user edits, so editing or withdrawing them does not lose task tracking. Promoting an entire independent collaboration task into another task's running turn is rejected (HTTP 409); use a task supplement for corrections. Ordinary user-message queue promotion remains supported.

## Application resources and authorized messages

Application plugins may declare the additive `plugin-resources` and `authorized-messages` capabilities. The host exposes no calendar or task-specific operations: recurrence, catch-up rules, templates and job history remain plugin code.

`ctx.services.dataDirectory` is a stable package-scoped local directory. `ctx.services.interactions.register(id, {view, prepare})` registers a bounded declarative resource; the manifest renders it with `{type:"resource", id}`. A panel may use the built-in `clock`, `panel`, `browser`, or `devices` icon. Older browser-capable packages using the generic panel icon receive the browser glyph automatically. A resource view contains `actions`, `rows`, optional `note`, and an optional form. Forms accept text, password, textarea, number, checkbox, select, time and datetime-local controls, optional advanced groups, and `when:{field,values}` visibility conditions. `refresh:false` holds a detail view until the user navigates back. A row's `conversationId` creates a host-generated local conversation link. Arbitrary HTML, scripts, event names and URLs are not accepted.

`prepare(action, values)` returns `{preview?, authorization?, execute(grantId?)}`. The host renders the preview, appends its own authorization scope, and issues a short-lived, resource-scoped confirmation token. Only confirmation creates a grant and invokes the prepared commit. Duplicate confirmation shares one result. Plugin stop/disposal invalidates pending confirmations. Commits participate in the application registry's in-flight operation tracking; failed commits revoke newly created grants. Plugins must recheck their own revision/version before mutation.

A message authorization has `{targetId, template, variables?, label, minIntervalMs, maxRuns?, expiresAt?}`. It binds a target's identity and directory, the exact message template, allowed bounded substitutions, frequency/usage limits and optional expiry. The basic bound message service provides:

- `messages.submit({grantId,key,values?,expiresAt})`: durably reserve an idempotent delivery and return its receipt.
- `messages.lookup(key)` / `messages.status(id)`: inspect a package-scoped receipt, including recovery after a crash between submission and local receipt storage.
- `messages.revoke(grantId)`: cancel pending admissions and prevent new uses of this grant.

The host checks ownership and grant scope, waits until the target is idle, then rechecks expiry, plugin lifetime and target binding under the normal conversation context lock. It does not place these messages in the kernel's unbounded input queue or bypass tool approvals. Slow target initialization does not block other targets. Receipts distinguish queued, running, completed, failed, expired, cancelled and interrupted. Completed means the model turn ended, not that an external business action was verified.

Uncertain deliveries are never automatically replayed after restart. Storage failure stops message admission without preventing unrelated core conversations from starting or shutting down. Receipts and authorizations have bounded capacity and are not automatically pruned, preserving deduplication. This is at-most-once admission, not exactly-once execution of external side effects; a crash may leave a task interrupted even if some work occurred. Plugin permissions are cooperative capabilities, not a sandbox for untrusted Node code.

The `examples/extensions/scheduled-tasks` package demonstrates once/daily/weekdays/weekly/interval scheduling, confirmed message grants, bounded catch-up, pause/resume and a generic resource UI. It needs the new capabilities; older desktop releases reject it through normal manifest compatibility checks. Remote web management is not added by this package.


## Shared package data directory

Hosts advertising `plugin-data` expose the same `ctx.services.dataDirectory` to a package's session and application entries. It is an absolute, stable path scoped to the package identity and settings profile under `hub-sessions/plugin-data`. The session service object exposes only this path: no unbound operation executor, credentials or other conversations are added. Creating directories, storage schema/migrations, size limits, database connections and backup semantics remain plugin responsibilities. Feature-detect or declare this capability in the manifest; released 0.21.1 does not provide it.

An application-owned database can be shared with session adapters through a canonical sibling module inside the same installed package. Stop/dispose the application service to revoke new operations; do not create a second background service per session. Upgrade after restarting asHub because JavaScript submodule caching can otherwise mix package versions. This is trusted in-process code, not a sandbox or a cross-plugin service registry.

`examples/extensions/personal-assistant` demonstrates a separately installed, application-owned memory store, one dedicated conversation, evidence-based automatic learning, bounded Chinese search and ephemeral multipart-safe request recall. The host supplies authorized original history; it does not extract memories, learn personal preferences or decide memory policy.

## Authorized background services

The additive `background-services` capability exposes `ctx.services.background` to application entries only. Learning, memory policy, schedules and UI remain plugin code. This is trusted in-process JavaScript, not a sandbox.

The application-side service shape is defined by
`ApplicationExtensionServices` in `src/extensions/services.ts`. Services are
explicitly injected and may be absent; their types and capability declarations
do not create user grants or an implicit current-conversation identity.

A resource plan may declare `backgroundAuthorization: {modelSessionId, includeHistory, excludedIds, dailyCalls}`. The host appends its own scope, provider/model and cost preview. Only user confirmation creates a package-bound grant and passes its ID to `execute(grantId)`. A plan cannot also request message authorization. A failed commit revokes the new grant; replacement invalidates the old one. Plugins cannot mint grants themselves.

The grant covers current and future active agent conversations except exclusions. Archived, terminal and closing sessions are excluded. `includeHistory:false` sets the start time to preparation of this authorization. The configured model source is bound to its session identity, directory, provider and model; changes require renewed approval for inference. The host persists grants and usage atomically under the settings profile; corrupt storage fails closed without preventing ordinary conversations from starting.

- `background.status(grantId)` returns the current grant and quota, without the internal model binding. Usage is persisted per plugin and UTC day independently of grant replacement/revocation. A newly approved `dailyCalls` is the total daily limit, not an additional allowance. Failed or cancelled requests that have started still count; quota is persisted before calling the provider. Existing grant counters migrate to the version 2 usage ledger; revoked counters already discarded by older hosts cannot be reconstructed. Older hosts fail closed on this ledger rather than resetting it.
- `background.targets(grantId)` returns authorized target metadata, including busy state.
- `background.read(grantId, conversationId, cursor?)` returns `{target, entries, cursor, reset, more}`. Pages scan at most 40 persisted active-branch entries, with stable IDs, timestamps, roles and text capped at 3000 UTF-16 units on a safe Unicode boundary. System notes are omitted; recognized generated task envelopes use the `generated` role. This is not complete provenance classification. The cursor tracks scanned entries, even if filtered. A missing cursor restarts the active branch with `reset:true`; consumers must deduplicate by source ID.
- `background.valid(grantId, conversationId, sourceIds)` checks whether up to 200 IDs still belong to the authorized active branch. It does not attest to semantic correctness or user intent.
- `background.infer(grantId, messages, signal?)` makes a separate, tool-free request through the approved model. It accepts 1–8 system/user messages and at most 16000 serialized characters; output budget is 4096 tokens with a 60-second deadline. Busy model sources and concurrent requests for the same plugin are rejected for later retry. It does not append history or acquire permission to call tools.
- `background.revoke(grantId)` cancels the package's running background request and removes the grant.

Each grant permits 1–24 requests per UTC day; reservation is persisted before inference, and failed/cancelled calls count. Application/plugin shutdown, model-session disposal and caller cancellation abort related requests. Consumers must also check scope, lifetime and their own revisions before storing asynchronous results. The API gives a count/input/output ceiling, not an exact monetary cost guarantee.

The personal-assistant example uses this capability for incremental, source-backed learning, bounded recall and user-feedback-based strategy revision. No assistant-specific memory or self-evolution logic is embedded in the host.

## Desktop browser pages

Electron advertises the optional `browser-pages` capability. Hosts with bounded file/editor operations also advertise `browser-files`; plugins requiring these operations must declare both capabilities. Declare it in a v2
session plugin manifest to receive `ctx.services.browserPages`. Each binding is
owned by the plugin activation and the host-provided conversation ID. Use
`available()` for tool visibility. Disabling the feature or disposing the
session revokes access and closes its native page. CLI hosts omit the capability.

`run(request, signal?)` accepts the following bounded primitives:

- `open` with an HTTPS `url` opens the conversation's isolated page and returns a snapshot.
- `observe` returns the URL (without query or fragment), semantic items, and a truncation flag. By default it issues fresh element references. Set `references: false` to inspect text without invalidating existing references.
- `fill` with `ref` and `value`, or `click` with `ref`, goes through the host permission preview. Bind approvals to the actual control and recheck identity, page and form fields before dispatch. For a stable standalone button the caller may explicitly request a seven-day, once-per-calendar-day grant with `daily: true`. A reserved attempt is never automatically repeated. Form submissions require one-time approval.
- `write` with `ref` and exactly one of `sourcePath` / `value` replaces up to 256 KiB of UTF-8 source in a text field. `editor: true` selects fixed Monaco/Ace/CodeMirror 5 adapters (only exposed instances). Authorization previews include source path, length, digest and a bounded excerpt. The editor instance and document object, as well as current content, are checked again before dispatch; the response reports read-back verification, not server-side saving.
- `upload` with `ref` and `sourcePath` selects a single file (up to 32 MiB) in a visible native file input. Sources must resolve inside the conversation working directory. The approved bytes are staged as an immutable snapshot until the page closes, preventing edits during approval from changing the upload. A site may transmit it immediately; submission is a separate action.
- `download` with `ref` authorizes bounded receipt of one same-origin or blob file, up to 64 MiB and 120 seconds. The file is first staged in a private temporary directory. A separate `manualOnly` approval presents its actual name, size, digest and untrusted preview; plugin auto-approval cannot bypass it. Only approved snapshot bytes are published in a unique `browser-download-*` directory under the revalidated working directory. `completed` means the actual file was confirmed and saved, with `triggerVerified: false` and `attribution: "user-confirmed-file"`; the host cannot establish which page action caused it. Refusal, cancellation or timeout cleans staging without automatic retry. Completed and uncertain downloads quarantine the page (`reopenRequired: true`). `open` requests approval to destroy/rebuild it, retaining persistent site data but discarding unsaved state and callbacks, without replaying any action. Definite pre-dispatch rejection does not quarantine. Navigation, manual takeover, activation and cancellation revoke outstanding receipt/confirmation; extra files are rejected.
- `close` revokes the open page and its grants. `close()` on the service releases the binding itself. Human takeover suspends all automated reading and mutation.

The host does not expose cookies, arbitrary page JavaScript or raw debugger commands through this interface. Trusted plugin code owns model tools, summaries and post-action verification. Persisted site data is scoped to conversation and origin. The `examples/extensions/browser-automation` package demonstrates the interface.


## Per-plugin operation approval

The plugin configuration editor includes an optional auto-approval switch for host
operations. It defaults to off and applies to subsequent requests immediately.
The host owns this consent in `ashub.plugins.autoApprove`; plugin defaults and
configuration namespaces cannot grant it. The runtime supplies the installed
package identity for `ctx.call('ashub:execute', ...)`, and browser services bind
the same identity when created. This setting covers that plugin's supported
host mutations, including conversation deletion and webpage actions. Existing
validation, cancellation, receipts and page checks still apply.
Host previews with `manualOnly: true` always require an explicit decision and cannot use per-plugin automatic consent. This is used for confirmation of an actual received browser file whose triggering action cannot be verified. Pending manual requests retain their existing approval and expiry.

Uninstalling an installed plugin removes its registration, session tools and automatic approval. Settings and plugin data are retained. Discovered packages are moved to `plugin-install/backups` under the agent home; explicitly configured external sources are unregistered in place. Installed dependents must be removed first.

## Session image resources

Optional session extensions declaring `image-resources` in `requires.capabilities` receive `ctx.services.imageResources.publish(path, signal?)`. This generic service is bound to the requesting conversation; a plugin cannot supply another conversation ID or widen its filesystem scope. Missing capability means the host is too old. The service returns `{id, ref, mimeType, width, height, size, name}`. It does not call a model or provide image interpretation.

```js
const image = await ctx.services.imageResources.publish('output/chart.png', signal);
// Return this reference to the model; it can include it in the final answer.
const markdown = `![Chart](${image.ref})`;
```

`ref` is `ashub-image:<sha256>/<width>x<height>`. Rendering resolves it against the owning reply's conversation (and remote device), never the currently selected conversation. The shared Markdown renderer reserves space, loads bounded image bytes lazily, opens the existing preview surface and cleans up requests/object URLs when the reply is removed. The optional `examples/extensions/image-display` plugin owns the tool, captions and guidance about when images are useful; it adds no dedicated core menu or model policy.

Publication enforces current workspace containment, regular files, source stability during copying, static PNG/JPEG/WebP, 8 MiB / 32 megapixels / 16,384 pixels per side, and 200 images / 256 MiB per conversation. Publication is serialized with deletion. The resource service is revoked on plugin disposal and checks enablement before every call. Published snapshots persist across source changes, restarts and plugin disable/uninstall, and are deleted with their conversation. Existing conversation branches share that conversation's snapshots.

The desktop resource endpoint `GET|HEAD /<session>/image-resources/<id>` uses existing local authentication, returns no-store/nosniff attachment headers and never serves HTML or SVG. `?meta=1` and `?offset=<bytes>` provide bounded metadata and 256 KiB chunks. The remote gateway exposes only authenticated, device-owned, current-directory-authorized reads through `image-resource`; it revalidates authorization after asynchronous reads. Resources are not added to the PWA shell cache. The endpoint is a renderer transport, not an unbound plugin filesystem API.

Regression commands: `npm run test:images`, `npm run test:images:ui`; lifecycle coverage also resides in `tests/plugins.mjs`, connector authorization in `tests/regression-remote-connector.mjs`, and separate gateway integration in `remote/test.mjs`.

## Task-bound notifications

Session handlers may expose `ashub:collaboration:signal({id, requestKey, message?, signal?})`. `id` is an existing collaboration task, not a conversation ID. Only its currently executing recipient can send a bounded notification to its original sender in the same current project; omitting `message` reads a prior receipt without waking a model. The host supplies identity, durable deduplication, rate limits, safe-boundary steering or idle submission, and restart/queue-state accounting. The plugin supplies domain-specific notification policy. `conversation_wait` can return `reason: "attention"` to release the current wait for a pending steering notice; this is not task completion. See [Task notifications](task-notifications.md) for delivery guarantees, limits and failure states.


### Task events and message lifecycle

Application plugins requiring `task-events` receive `services.collaboration.snapshot(ownerId)` and `subscribe(listener)`. Snapshots contain task metadata only (IDs, state, revision, terminal and delivery flags), scoped to a current project owner and its current members. Subscriptions are invalidation signals; read a fresh snapshot and reconcile persistent plugin state. They are removed on deactivation. No model is invoked by observation.

With `message-lifecycle`, an explicitly confirmed message grant may opt into `projectId`, `pauseOnStop` and `recoverQueued`. Project scope is checked at confirmation and again at delivery admission. User Stop revokes grants that opt into pauseOnStop, including pending deliveries, and invalidates older confirmation previews even before a grant exists. Fresh confirmation can authorize work again; unrelated scheduled grants and previews are unchanged. Only queued recoverQueued deliveries survive graceful shutdown or process restart; running/uncertain work remains interrupted and is never automatically replayed. Disabling a plugin cancels its waiting deliveries. The bound message service also exposes `authorization(id)` (revoked, used, maxRuns, expiresAt) and `cancel(key)` (queued only). Grant ownership and existing idempotency checks remain enforced.

With `activity-hints`, `services.activities.replace(records)` publishes up to 100 text-only `{id,projectId,sessionId,label,state}` hints per plugin. Labels are limited to 200 characters and other fields to 100. Hints are validated against current membership, cleared on deactivation, and emitted through the project invalidation channel. Remote catalogs include only hints whose owner conversation is shared. These are presentation metadata, not executable actions or additional authority.

Project DAGs, progress checks, coalescing, continuation policy and authorization UI belong to plugins. Core APIs do not infer task completion or authorize future work from an assistant response.


## Named conversation entries and scoped resources

Application plugins can declare `conversation-entries` and receive `services.conversations`:

- `register(key, {label, resource, cwd, setupResource?, description?})` registers a stable, profile/package-scoped sidebar entry until disposal. `resource` identifies its declarative resource panel. Registration never creates a conversation. Optional `setupResource` opens a bounded resource in the central reading canvas before a binding exists; `description` (up to 300 characters) labels its chat welcome. Bound entries always open the persisted conversation. Its matching settings panel remains accessible via the entry’s secondary action rather than a duplicate toolbar button.
- `get(key)` returns the active bound conversation ID or `null`; `models()` returns configured provider/model choices.
- A resource plan may request `entryAuthorization: {key, provider, model}`. The host appends the exact model/path to confirmation and passes the resulting conversation ID to `execute`. It persists a reserved ID before creation, serializes concurrent creation and reuses the saved binding. Missing/deleted conversations require a new explicit creation review. This is mutually exclusive with other grant types.

A setup resource may return `openConversation: id` in its completed view. Only a user-initiated action result can navigate; passive reads never do. The workspace rechecks that the ID is this entry’s current binding, and disposal or changing conversations cancels navigation. Other resource mounts ignore this completion hint.

`scoped-history` extends background authorization with optional `includedIds`. When supplied it must be nonempty; the host intersects it with exclusions for every target/read/provenance call. Existing unscoped plugins remain compatible. The assistant always supplies exactly its dedicated conversation. Additional read methods:

- `search(grant, conversationId, query)`: at most 12 matching snippets of 800 characters, with original message ID, role and timestamp.
- `entry(grant, conversationId, sourceId, offset?)`: at most 3000 characters with `nextOffset` and `more`; rejects invalid UTF-16 boundaries. `previousId` identifies the directly preceding message in the current authorized history, or is `null` at its beginning or authorization boundary; invisible system notes remain omitted, while tool/generated messages are not skipped.
- `latestUser(grant, conversationId)`: the latest authorized user entry ID, allowing plugins to validate fresh user intent.

These methods obey the grant start date, current history branch and plugin lifecycle. Generated cross-conversation messages are marked `generated` in search results, not asserted as human statements.

A registered resource may opt into `remote-resources` with `remote: {conversationId: () => idOrNull, actions: [...]}`. The desktop connector shares it only when that conversation's directory is currently authorized for mobile access. The host binds confirmation tokens to desktop/remote origin and the exact remote conversation, rechecks scope after async work, and rejects creation/background/message authorization from remote. Unsupported controls are removed from remote views.

Remote mutations keep existing persistent idempotent receipts. Private view payloads are stored only in a bounded five-minute memory cache; receipts contain an opaque result reference. Fetching a result rechecks sharing and plugin ownership. Expired/restarted results are reported as unavailable, never automatically re-executed. Plugin authors must put mutations behind `preview` confirmations and retain version checks. The website reuses the desktop declarative resource renderer with a scoped RPC transport; no plugin HTML or scripts are accepted.

Background authorization previews summarize a single model-bound conversation with no exclusions, combining history policy into the visible scope and retaining only per-request technical limits in host-owned `preview.details`. Raw IDs, repeated scope/model fields and empty exclusions are omitted from this compact display. Broader or excluded scopes retain full visible fields. Plugins cannot move mandatory authorization fields into details; this presentation does not alter the stored grant or runtime checks.

`services.background.supportsFollowModel` advertises explicitly approved `followModel` grants, limited to one conversation with a fixed identity/directory and budget. Existing grants stay fixed-model. `services.conversations.supportsEntryBackground` advertises resource plans combining `entryAuthorization` with `entryBackground: {dailyCalls, includeHistory, followModel:true}`. The host displays both scopes in one desktop confirmation, binds background access only to the resulting owned conversation, and revokes the new grant on plugin commit failure. Remote clients cannot approve these grants.

These are general conversation/background capabilities, not memory APIs. Plugin
previews supply the purpose (for example, long-term memory or meeting analysis).
The host supplies the authoritative history scope, model/network binding, limits
and cost disclosure using the same background authorization presentation for
existing and newly created conversations. Plugin wording cannot replace those
facts or move mandatory fields into collapsed details. Conversation creation does
not promise preservation or migration of plugin-owned data.

`conversation-resource-popovers` declares that conversation-entry resources can open directly in a dismissible dialog without a registered sidebar panel. Plugins relying on this presentation must require the capability. Combined `entryBackground` inputs accept only the three documented fields; the host freezes them at preview time and supplies the created conversation identity itself.

Conversation resources may expose `toggle: { label, checked, action, status? }` for an inline sidebar switch. `action` references an existing resource action; absent or remotely filtered actions leave the switch disabled. The host never derives permission from toggle metadata. Enabling follows normal resource confirmation; reversible disabling may execute immediately. An optional plain-text `status` (up to 160 characters) shows a quiet inline notice below the entry and is associated with the switch for assistive technology. It describes resource health and never changes authorization state. Other resource views retain their generic management entry.


### Conversation-scoped session entries

A v2 plugin with both application and session entries may declare
`"sessionScope": {"conversationEntries": ["assistant"]}` and require
`conversation-scoped-sessions`. Entry keys refer only to named conversations
owned by that same plugin through `services.conversations`. The application
entry remains application-scoped; only its bound conversation imports and
activates the session entry. Other kernels do not import that module, attach
its hooks, or list it as a loaded session plugin. Omitting `sessionScope`
preserves the existing all-session behavior.

The host matches persisted binding IDs, not titles or paths. Binding creation
precedes kernel startup, and lazy restore uses the same match before application
entries re-register. Missing host support or unmatched ownership never falls
back to loading in all conversations. This controls loading, not memory or
history authorization: plugins must retain their existing runtime access guards.
After updating an already loaded plugin, restart asHub to replace old kernels;
no active conversation is interrupted for a hot reload.


## Optional backend workspaces

An application extension declaring `backend-connections` receives `ctx.services.backends`.
It must register only connections the user has authorized. The capability is opt-in and
not available to session tools. Existing local conversations keep their original paths.

```js
const registration = ctx.services.backends.register('stable-target-id', {
  label: 'Office computer',
  online: () => connection.online,
  request: (operation, args, signal) => connection.request(operation, args, signal),
  subscribe: (sessionId, emit, signal) => connection.subscribe(sessionId, emit, signal),
  resource: (args, signal) => connection.resource(args, signal),
});
await registration.open(); // invoke from a plugin-owned, desktop-only resource action
registration.dispose();
```

The host derives an opaque ID from the package identity and registration key. A native
workspace is permanently bound to that ID; credentials and protocol endpoints never enter
the renderer. Disposal, plugin disable, client disconnection and host shutdown cancel work.
Late responses from disposed registrations are rejected even if the same ID is re-registered.
Adapters must honor cancellation and dispose their network clients on shutdown.
`registration.open()` can open only that still-active registration, rejects offline targets,
and fails when native windows are unavailable. It accepts no URL, target ID or renderer code.
There is no HTTP `open` route. Plugins provide device selection through existing declarative
resources; the local client has no fixed connection launcher or background discovery polling.
Account/device discovery remains in the plugin. Resource rows may reference an existing action
using `primaryAction: 'action-id'` to display it directly; other actions retain their menu.
If that action is filtered out by remote permissions, no primary button is rendered. This is
presentation only and does not grant any additional authority.

The v1 workspace uses the conversation operation contract in `BackendConnections`:
metadata (`capabilities`, `sessions`, `project-groups`, `projects`, `models`), conversation
creation/deletion, submit/receipt/cancel, model/thinking, conversation network policy,
queue edits, one-time permissions, images and explicitly exposed plugin resources.
Local terminal, admin settings, plugin installation and persistent approvals are not routes.
The adapter must also enforce the target's user and directory authorization. It must never
fall back to local execution when offline.

`subscribe` emits conversation protocol v1 frames, including `hub:replay-done`. A fresh
subscription reconstructs history, and an upstream reset emits `backend:reset` before replay.
`request-status` and stable request IDs preserve uncertain write receipts across disconnection.
The host bounds request/response/event sizes and streaming backpressure.

`resource` receives string query arguments plus host-provided `method` (`HEAD`/`GET`).
Return `{data:Uint8Array,type,size?,version?}`. HEAD must not transfer the file; GET must
validate the supplied version. Responses are private, bounded to 32 MB, attachment-only,
with active content forced to an inert MIME type. Version values are opaque alphanumeric,
underscore or hyphen identifiers. No local path or native-open capability is granted.

`ctx.services.backends.secrets` provides `available`, `read(key)` and `write(key,value|null)`.
Keys are package-scoped. The desktop uses OS encryption; unavailable secure storage fails
closed. Store session credentials, not passwords. A declarative `password` field is always
rendered empty and masked; do not return password contents in resource views or previews.

Remote workspace windows have no Electron preload. Their device/session drafts and pending
send payloads are isolated from the existing local conversation storage. The multi-machine
plugin is an optional example adapter for the existing remote gateway; no provider protocol
or account policy is implemented in the core.

## Authorized local conversation sharing

Application plugins declaring `shared-conversations` receive
`ctx.services.sharedConversations`. A resource action requests
`sharingAuthorization: {roots: ['/absolute/project']}`. The host canonicalizes
existing directories, displays its own scope description and requires a desktop
confirmation. Remote callers cannot approve this grant. After confirmation,
`execute(grantId)` receives a package-bound grant. Failed execution revokes the
new grant. Keep successful grants private in scoped secure storage.

`scope(grantId)` returns the saved roots or null; `open(grantId)` returns a scoped
channel with `roots`, `request(route, body?, method?)`, `events(sessionId, recent,
signal)`, `image(sessionId, imageId)`, `openArtifact(sessionId, path)` and `close()`.
`revoke(grantId)` persists revocation and cancels active channels; plugin disposal
also invalidates channels. Local authentication credentials and arbitrary URLs
are never provided. Callers must close file handles after use and bound reads.
The local route allowlist permits shared conversation operations, project metadata,
models, files and explicitly remote-enabled plugin resources. Administrative
settings, unrestricted filesystem access, shell shortcuts and persistent approvals
are excluded; network policy changes are conversation-scoped. Streams exclude
terminal data and stop when directory authorization changes.

`registerStatus(read)` supplies a lifecycle-bound, non-secret status snapshot for
native desktop affordances. Only return public connectivity metadata. The host has
no account, gateway, device discovery or reconnection policy.

The optional device interconnect application combines the former mobile publisher
and multi-machine controller. A one-time compatibility migration copies existing
identity/scope/receipt state into plugin storage. The old local `/api/mobile` GET
remains a status shim; mutation routes return 410 after migration. A legacy adapter
runs only if migration fails, preserving an existing paired phone until upgrade
can finish; it is not used for fresh installations or successful migrations.
