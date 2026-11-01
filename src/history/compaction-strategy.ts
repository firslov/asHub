import type { CompactionDiagnostic } from "./compaction-diagnostics.js";
import { createHash } from "node:crypto";
import type { Capture } from "./capture.js";
import type { AgentMessage, CompactionEntry, SessionStore } from "./session-store.js";
import type { CompactionStrategyHook } from "../bridges/types.js";
import { isSystemNoteMessage } from "./summarize.js";
import { estimateContextTokens, fallbackMemory, parseMemory, renderMemory, summaryInput, validateCheckpointMemory, type ContextCheckpoint } from "./context-memory.js";

export interface CompactResult { before: number; after: number; evictedCount: number }

/** Cut between completed tool interactions, including parallel batches. */
export function safeCutPoints(messages: AgentMessage[]): number[] {
  const points: number[] = [], pending = new Set<string>();
  let unknownCall = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (i > 0 && !pending.size && !unknownCall && m.role !== "tool" && !isSystemNoteMessage(m)) points.push(i);
    for (const call of m.tool_calls ?? []) {
      if (call.id) pending.add(call.id); else unknownCall = true;
    }
    if (m.role === "tool" && m.tool_call_id) pending.delete(m.tool_call_id);
  }
  return points;
}

function fingerprint(messages: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(messages, (key, value) => key === "meta" ? undefined : value)).digest("hex");
}

export function createCompactionStrategy(
  getStore: () => SessionStore | null,
  getCapture: () => Capture | null,
  onWarn?: (msg: string) => void,
  onCompacted?: (liveView: AgentMessage[], entryIds: (string | null)[]) => void | Promise<void>,
  runLocked?: <T>(fn: () => Promise<T>) => Promise<T>,
): CompactionStrategyHook {
  const locked = <T>(fn: () => Promise<T>) => runLocked ? runLocked(fn) : fn();
  let running = false, lastUnproductive = "";
  return async (helpers, opts, next) => {
    const options = opts as { target?: number; force?: boolean; strategy?: { kind?: string; target?: number; keepRecent?: number; force?: boolean } } | undefined;
    if (options?.strategy?.kind === "rewind" || options?.strategy?.kind === "replace") return await next(opts);
    const store = getStore(), capture = getCapture();
    if (!store || !capture) return await next(opts);
    if (running || helpers.signal?.aborted) return null;
    running = true;
    const started = Date.now();
    const diagnostic: CompactionDiagnostic = { outcome: "unchanged" };
    let recoveryFailed = false;
    try {
      const snapshot = await locked(async () => {
        await capture.flush();
        const messages = helpers.getMessages() as AgentMessage[];
        return { messages: JSON.parse(JSON.stringify(messages)) as AgentMessage[], fingerprint: fingerprint(messages),
          ids: messages.map((_, i) => capture.getEntryIdAt(i)), leaf: store.getActiveLeaf(), revision: store.getRevision(),
          branch: store.getBranch(), sources: store.getHistoryEntries(),
          durableFingerprint: fingerprint(store.buildMessages()),
          before: helpers.estimatePromptTokens(), contextKey: helpers.contextKey?.() };
      });
      const { messages, branch, before } = snapshot;
      Object.assign(diagnostic, { sourceLeaf: snapshot.leaf, revision: snapshot.revision, before });
      if (messages.length < 4 || helpers.signal?.aborted) return null;
      if (snapshot.durableFingerprint !== fingerprint(messages.filter(m => !isSystemNoteMessage(m)))) {
        diagnostic.outcome = "stale";
        onWarn?.("compaction skipped: live context is not aligned with durable history");
        return null;
      }
      const overhead = Math.max(0, before - estimateContextTokens(messages));
      const requested = options?.target ?? options?.strategy?.target;
      const target = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : 20000 + overhead;
      diagnostic.target = target;
      if (!(options?.force || options?.strategy?.force) && before <= target && requested !== 0) { diagnostic.reason = "below-target"; return null; }
      const key = `${snapshot.revision}:${snapshot.contextKey}:${target}:${snapshot.fingerprint}`;
      if (key === lastUnproductive) return null;
      const allEntries = snapshot.sources, sourceIds = new Set(allEntries.map(e => e.id));
      // Context deletion can copy the synthetic summary into a new branch.
      // Its retained marker, not just journal ancestors, carries working state.
      let previousEntry: CompactionEntry | undefined;
      for (const entry of [...branch].reverse()) {
        const marker = entry.type === "message" ? entry.message.meta?.ashubCheckpoint : undefined;
        const candidate = entry.type === "compaction" ? entry : typeof marker === "string" ? store.getEntry(marker) : undefined;
        if (candidate?.type === "compaction") { previousEntry = candidate; break; }
      }
      // A branch rewrite gives the retained tail new IDs, so firstKeptId may
      // no longer be on this branch. Identify the already summarized originals
      // from the checkpoint's source branch. Without valid notes, summarize the
      // full available evidence instead of silently skipping the old prefix.
      const previousSources = previousEntry ? store.getHistoryEntries(previousEntry.parentId) : [];
      const previousEnd = previousEntry ? previousSources.findIndex(e => e.id === previousEntry.firstKeptId) : -1;
      const previousPrefix = previousEnd >= 0 ? previousSources.slice(0, previousEnd) : [];
      // Validate against the checkpoint's own evicted evidence, not the whole
      // current conversation: restore rejects references into its retained tail.
      const previous = validateCheckpointMemory(previousEntry?.checkpoint,
        new Set(previousPrefix.filter(e => sourceIds.has(e.id)).map(e => e.id))) ?? undefined;
      const summarizedIds = new Set(previous ? previousPrefix.map(e => e.id) : []);
      const boundaries = safeCutPoints(messages).filter(i => i >= 2 && snapshot.ids[i]);
      const window = helpers.contextWindow?.() ?? 60000;
      const minTail = Math.min(4000, Math.max(256, Math.floor(window * 0.1)));
      let chosen: { cut: number; firstKeptId: string; evicted: typeof allEntries; delta: typeof allEntries; memory: ReturnType<typeof fallbackMemory>; estimate: number } | undefined;
      for (const cut of boundaries) {
        const firstKeptId = snapshot.ids[cut]!;
        const end = allEntries.findIndex(e => e.id === firstKeptId);
        if (end < 1) continue;
        const evicted = allEntries.slice(0, end), delta = evicted.filter(e => !summarizedIds.has(e.id));
        const memory = fallbackMemory(delta, previous), tail = messages.slice(cut);
        const estimate = overhead + estimateContextTokens([{ role: "user", content: renderMemory(evicted, memory, "fallback") }, ...tail]);
        if (!chosen || estimate < chosen.estimate) chosen = { cut, firstKeptId, evicted, delta, memory, estimate };
        if (estimate <= target || estimateContextTokens(tail) < minTail) break;
      }
      if (!chosen || chosen.estimate >= before - Math.max(128, Math.ceil(before * 0.05))) {
        lastUnproductive = key;
        diagnostic.reason = "insufficient-savings";
        onWarn?.("compaction skipped: protected user inputs and complete recent interactions leave insufficient savings");
        return null;
      }
      const inputBudget = Math.min(32000, Math.max(0, window - 8192 - 2048));
      const input = summaryInput(chosen.delta, previous, inputBudget);
      let mode: ContextCheckpoint["mode"] = "fallback", memory = chosen.memory;
      if (helpers.summarize && input.usable && !helpers.signal?.aborted) {
        try {
          const result = parseMemory(await helpers.summarize(input.messages), input.allowedIds);
          if (result) { memory = result; mode = "semantic"; }
          else { diagnostic.reason = "summary-invalid"; onWarn?.("compaction: invalid semantic checkpoint; using source-backed fallback"); }
        } catch {
          diagnostic.reason = "summary-unavailable";
          if (!helpers.signal?.aborted) onWarn?.("compaction: summary unavailable; using source-backed fallback");
        }
      }
      if (helpers.signal?.aborted) return null;
      const estimate = (m: typeof memory, kind: typeof mode) => overhead + estimateContextTokens([
        { role: "user", content: renderMemory(chosen!.evicted, m, kind) }, ...messages.slice(chosen!.cut),
      ]);
      // A longer semantic answer cannot consume the runway reserved by planning.
      if (estimate(memory, mode) > Math.min(Math.max(target, chosen.estimate), before - Math.max(128, Math.ceil(before * 0.05)))) { memory = chosen.memory; mode = "fallback"; diagnostic.reason = "summary-too-large"; }
      const checkpoint: ContextCheckpoint = { version: 1, sourceLeaf: snapshot.leaf, mode, memory,
        diagnostics: { target, estimatedAfter: estimate(memory, mode), elapsedMs: Date.now() - started,
          inputTokens: input.usable && helpers.summarize ? input.inputTokens : 0, omittedRecords: input.omittedRecords } };
      return await locked(async () => {
        if (helpers.signal?.aborted || getStore() !== store || getCapture() !== capture
          || store.getRevision() !== snapshot.revision || store.getActiveLeaf() !== snapshot.leaf
          || helpers.contextKey?.() !== snapshot.contextKey || fingerprint(helpers.getMessages()) !== snapshot.fingerprint) {
          diagnostic.outcome = "stale";
          onWarn?.("compaction skipped: conversation changed while preparing checkpoint");
          return null;
        }
        await store.appendCompaction(chosen.firstKeptId, before, checkpoint, snapshot.revision);
        const rollback = () => {
          try { store.setActiveLeaf(snapshot.leaf); }
          catch (error) { recoveryFailed = true; helpers.failClosed?.(); throw error; }
        };
        // File I/O yielded. A manual compact can overlap a streaming response;
        // never replace a newer live view with the earlier checkpoint.
        if (helpers.signal?.aborted || fingerprint(helpers.getMessages()) !== snapshot.fingerprint
          || helpers.contextKey?.() !== snapshot.contextKey) {
          rollback(); diagnostic.outcome = "stale"; return null;
        }
        const { messages: liveView, entryIds } = store.buildBranchWithIds();
        try { helpers.replaceMessages(liveView); capture.resetTo(entryIds); }
        catch (error) {
          rollback();
          try { helpers.replaceMessages(snapshot.messages); capture.resetTo(snapshot.ids); }
          catch { recoveryFailed = true; helpers.failClosed?.(); }
          throw error;
        }
        if (onCompacted) {
          try { await onCompacted(liveView, entryIds); }
          catch { onWarn?.("compaction: replay refresh failed; durable checkpoint retained"); }
        }
        lastUnproductive = "";
        const after = helpers.estimatePromptTokens();
        Object.assign(diagnostic, { outcome: "applied", mode, after, inputTokens: checkpoint.diagnostics.inputTokens });
        return { before, after, evictedCount: chosen.cut };
      });
    } catch (error) {
      // Never fall through to an unpersisted compactor on a managed tree.
      diagnostic.outcome = "failed";
      onWarn?.("compaction skipped: checkpoint could not be committed");
      if (recoveryFailed) throw error;
      return null;
    } finally {
      running = false;
      if (helpers.signal?.aborted && diagnostic.outcome !== "applied") diagnostic.outcome = "cancelled";
      diagnostic.elapsedMs = Date.now() - started;
      try { helpers.diagnostic?.(diagnostic); } catch { /* diagnostic sinks cannot break compaction */ }
    }
  };
}
