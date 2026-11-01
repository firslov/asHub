# Replay persistence and flow control

The authoritative conversation tree, capture rules and branch identifiers remain
unchanged. Replay files remain the existing SSE text format. The host now owns one
replay writer per live session, with one active write and one latest pending
snapshot. Superseded pending snapshots share the later write's completion;
serialization happens only when admitted to disk work.

An unchanged frame prefix is appended as a delta. A query tag edit, rewind,
compaction, branch replacement or externally changed file uses an atomic full
replacement. ACP keeps the atomic replacement path. A replay checkpoint records
its existing `leaf` plus committed UTF-8 byte length and SHA-256. Startup ignores
uncommitted appended bytes; a mismatched snapshot/checkpoint preserves recovery
copies and rebuilds the current branch from the conversation tree. Legacy
leaf-only checkpoints remain readable. Write failures retain the in-memory source
and retry a complete snapshot; they do not blindly repeat a possibly partial
append. Archive still refuses to discard unsaved history. These are application
crash guarantees, not filesystem/power-loss guarantees.

Each SSE connection has one ordered writer. Historical sources are consumed in
bounded batches; socket backpressure pauses them until `drain`. Live frames are
admitted behind the captured historical batch and replay-end marker before the
request yields, so a slow replay cannot lose events or reorder the stream. Slow
consumers have bounded live backlog and a drain deadline; closing them does not
block another client or conversation. Branch rebuilds use the same writer.

This change reduces recurring disk I/O and pending serialized copies. Full
conversation history is still retained in the existing session structures and
current desktop replay semantics remain intact; it does not introduce a new
on-disk database, evict history or silently shorten context. Indexed cold-history
paging can be introduced separately once the same rewind and reconnect contracts
are verified against it.

Verification: `tests/replay-writer.cjs`, `tests/replay-recovery.cjs`,
`tests/sse-writer.cjs`, `tests/http-replay-flow.cjs`, and the existing history,
rewind, archive, queue and compaction suites. The long-history fixture measures
bytes written rather than assuming a production latency improvement.
