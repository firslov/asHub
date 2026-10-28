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
