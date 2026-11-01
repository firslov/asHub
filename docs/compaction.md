# Context compaction

asHub owns the compaction policy through the kernel's existing
`conversation:compact` advisor. The kernel still decides when to compact and
when a turn ends. This change does not add goals, automatic continuation,
background wakeups, cross-conversation memory or permission changes.

## Context retained

- Historical user text is preserved in chronological order with original source
  IDs, excluding runtime query-context wrappers. It is quoted as historical data,
  not elevated to new instructions. Later user corrections take precedence;
  task-specific requests do not become permanent rules. This conservative first
  version does not let a summarizer silently decide which user requirements to
  delete. Quoted documents and cross-conversation messages retain their original
  authority.
- Structured working notes separate goal, open work, next steps and blockers
  from historical findings, decisions and failed attempts. They remain fallible
  notes, not completion evidence or authorization.
- Recent complete tool interactions stay verbatim. A cut cannot separate a
  parallel tool batch from its results, even with an interleaved user message.
- Original messages and attachments remain in the append-only session tree.
  `conversation_history` can browse/search the active branch, expand source text
  and tool arguments, and recall a selected persisted inline image on a vision
  model. It cannot read unrelated branches or other sessions.

## Planning and generation

Budget estimation matches agent-sh 0.16.1: metadata is excluded and images count
as estimated image tokens rather than Base64 text. The planner includes prompt
overhead, protected user text, notes and the recent tail. Existing kernel trigger
thresholds are unchanged. It looks for a useful reduction (at least 5% and 128
estimated tokens), with a bounded recent-tail preference; preserving user input
can prevent reaching the requested target.

Only an eligible compaction makes a tool-free summary request on the current
model and provider. It uses low reasoning effort when the model's known profile
supports it; otherwise it leaves the provider default. The request preserves
the session's network policy and uses a separate provider session header where
available. Summary text is not emitted as an assistant reply.

The input is incremental: previous validated notes plus a bounded recent window
of newly evicted records. Earlier omitted records remain recoverable. Input is
limited to 32,000 estimated tokens and the active model's available window; output
is limited to 8,192 tokens, 24,000 returned characters and a 90-second deadline.
The validated notes allow at most 24 items and 8,000 text characters. Cancellation
and bridge closure abort the request. Existing transport retries remain bounded
by this deadline; no new agent retry/continuation loop is introduced.

Invalid, oversized, incomplete or unavailable summaries use deterministic,
source-backed fallback notes. Earlier open work remains explicitly unverified
rather than being treated as finished. Unchanged unproductive contexts do not
repeat paid summary calls. Structured validation checks shape, size and source
membership; it cannot prove semantic correctness.

## Persistence and isolation

A versioned checkpoint is stored in the existing compaction journal entry. Raw
history is not rewritten. Startup rebuilds the same notes without calling a
model. Legacy compaction entries retain their original rendering behavior.

Generation runs outside the context lock. Commit verifies the source leaf,
monotonic revision, model identity, live message fingerprint and durable
alignment. A second check after journal I/O catches cancellation or messages
arriving while writing. Failed context replacement rolls back the leaf and live
view; unrecoverable rollback closes the bridge instead of continuing with a
mixed state. Managed-tree failures do not fall through to the kernel's separate
rolling-history compactor.

Rewind/fork use their own branch checkpoint. When context deletion rewrites a
branch while retaining its synthetic summary, an internal source marker preserves
access to that summary's evicted evidence only, not the deleted recent tail.
Removing the summary removes that source access. Desktop and remote use the same
backend checkpoint and existing replay/compaction-marker protocol.

`$AGENT_SH_HOME/logs/compaction.jsonl` (normally `~/.agent-sh/logs/compaction.jsonl`)
records outcome, reason code, mode, leaf/revision, token estimates and elapsed
time. It rotates at 2 MiB and never contains prompts, summaries, exception text,
URLs or credentials. Input token counts here are estimates, not billing usage.

## Limits

Very large user inputs can exhaust the protected budget. In that case compaction
may be skipped rather than silently removing requirements; the kernel's existing
overflow handling still applies. Semantic summarization adds cost and delay at
compaction boundaries, and changing context can reduce cache reuse on the next
request. This does not guarantee that a model follows every retained instruction
or completes a task before ending its turn.

## Verification

`npm run test:compaction` builds and runs deterministic source/persistence tests
and an actual AshBridge/kernel integration against a local mock model server.
Coverage includes repeated compaction, instruction tails and corrections, images,
tool boundaries, invalid summaries, source isolation, restart, context deletion,
rewind, cancellation, disk failure and concurrent writes. The fixture explicitly
blocks nonlocal model traffic. These tests establish mechanical behavior; real
long-task quality and total cost still require observation with actual models.
