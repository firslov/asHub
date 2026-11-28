import type { CompactionDiagnostic } from "./compaction-diagnostics.js";
import { createHash } from "node:crypto";
import type { Capture } from "./capture.js";
import type { AgentMessage, CompactionEntry, SessionStore } from "./session-store.js";
import type { CompactionStrategyHook } from "../bridges/types.js";
import { isSystemNoteMessage } from "./summarize.js";
import { projectToolCalls } from "./tool-call-projection.js";
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

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function comparable(message: AgentMessage): string {
  // Ignore only host/kernel entry tags at the message level. A nested `meta`
  // in tool payloads and checkpoint markers are part of the context.
  const { meta, ...rest } = message;
  if (!meta) return JSON.stringify(rest);
  const { treeEntryId: _tree, entryId: _kernel, ...metadata } = meta;
  return JSON.stringify(Object.keys(metadata).length ? { ...rest, meta: metadata } : rest);
}

function alignContext(raw: AgentMessage[], ids: (string | null)[], durable: ReturnType<SessionStore["readBranchContext"]>, settled: boolean | undefined) {
  const projected = projectToolCalls(durable.messages);
  const messages = raw.slice();
  let j = 0, usedProjection = false;
  for (let i = 0; i < raw.length; i++) {
    const message = raw[i]!;
    if (isSystemNoteMessage(message) && ids[i] === null) continue;
    const original = durable.messages[j], normalized = projected.messages[j], id = durable.entryIds[j];
    const liveText = comparable(message);
    const originalText = original && comparable(original);
    const projectedText = normalized === original ? originalText : normalized && comparable(normalized);
    const fail = (reason: string) => ({ mismatch: fingerprint([reason, id, ids[i], originalText, liveText]) });
    if (!original || !normalized || ids[i] !== id || (liveText !== originalText && liveText !== projectedText)) return fail("different");
    if (liveText !== projectedText) {
      if (projected.ambiguous.has(j)) return fail("ambiguous");
      if (settled !== true) return fail("pending");
      usedProjection = true;
      // Start with the live message to retain its entry tags in this view.
      messages[i] = { ...normalized, ...(message.meta ? { meta: message.meta } : {}) };
    }
    j++;
  }
  if (j !== durable.messages.length) return { mismatch: fingerprint(["missing", durable.entryIds[j], durable.messages[j]]) };
  // A supported runtime explicitly reports a live batch (even if its
  // assistant message hasn't been appended to the history yet).
  if (settled === false) return { mismatch: "pending-tool-batch" };
  return { messages, usedProjection };
}

export function createCompactionStrategy(
  getStore: () => SessionStore | null,
  getCapture: () => Capture | null,
  onWarn?: (msg: string) => void,
  onCompacted?: (liveView: AgentMessage[], entryIds: (string | null)[]) => void | Promise<void>,
  runLocked?: <T>(fn: () => Promise<T>) => Promise<T>,
): CompactionStrategyHook {
  const locked = <T>(fn: () => Promise<T>) => runLocked ? runLocked(fn) : fn();
  let running = false, lastUnproductive = "", lastMismatch = "";
  return async (helpers, opts, next) => {
    const options = opts as { target?: number; force?: boolean; strategy?: { kind?: string; target?: number; keepRecent?: number; force?: boolean } } | undefined;
    if (options?.strategy?.kind === "rewind" || options?.strategy?.kind === "replace") return await next(opts);
    const store = getStore(), capture = getCapture();
    if (!store || !capture) return await next(opts);
    if (running || helpers.signal?.aborted) return null;
    running = true;
    const started = Date.now();
    const diagnostic: CompactionDiagnostic = { outcome: "unchanged" };
    let recoveryFailed = false, reportDiagnostic = true;
    try {
      const snapshot = await locked(async () => {
        await capture.flush();
        const serialized = JSON.stringify(helpers.getMessages());
        const raw = JSON.parse(serialized) as AgentMessage[];
        const ids = raw.map((_, i) => capture.getEntryIdAt(i));
        return { raw, fingerprint: createHash("sha256").update(serialized).digest("hex"), ids,
          alignment: alignContext(raw, ids, store.readBranchContext(), helpers.toolCallsSettled?.()),
          leaf: store.getActiveLeaf(), revision: store.getRevision(), branch: store.getBranch(), sources: store.getHistoryEntries(),
          before: helpers.estimatePromptTokens(), contextKey: helpers.contextKey?.() };
      });
      const { alignment, raw, branch, before } = snapshot;
      Object.assign(diagnostic, { sourceLeaf: snapshot.leaf, revision: snapshot.revision, before });
      if (raw.length < 4 || helpers.signal?.aborted) return null;
      const force = options?.force || options?.strategy?.force;
      if ("mismatch" in alignment) {
        diagnostic.outcome = "stale";
        diagnostic.reason = "unaligned-context";
        reportDiagnostic = !!force || lastMismatch !== alignment.mismatch;
        lastMismatch = alignment.mismatch;
        if (reportDiagnostic) onWarn?.("compaction skipped: live context is not aligned with durable history or tools are still active");
        return null;
      }
      lastMismatch = "";
      const { messages } = alignment;
      const contextStillMatches = () => {
        const settled = helpers.toolCallsSettled?.();
        return settled !== false && (!alignment.usedProjection || settled === true)
          && helpers.contextKey?.() === snapshot.contextKey && fingerprint(helpers.getMessages()) === snapshot.fingerprint;
      };
      const overhead = Math.max(0, before - estimateContextTokens(raw));
      // The kernel's context:compact event wraps a caller-supplied strategy
      // with target: 0 (the default sentinel). Prefer the explicit strategy.
      const requested = options?.strategy?.target ?? options?.target;
      const target = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : 20000 + overhead;
      diagnostic.target = target;
      if (!force && before <= target && requested !== 0) { diagnostic.reason = "below-target"; return null; }
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
          || !contextStillMatches()) {
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
        if (helpers.signal?.aborted || !contextStillMatches()) {
          rollback(); diagnostic.outcome = "stale"; return null;
        }
        const { messages: liveView, entryIds } = store.buildBranchWithIds();
        try { helpers.replaceMessages(liveView); capture.resetTo(entryIds); }
        catch (error) {
          rollback();
          try { helpers.replaceMessages(snapshot.raw); capture.resetTo(snapshot.ids); }
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
      try { if (reportDiagnostic) helpers.diagnostic?.(diagnostic); } catch { /* diagnostic sinks cannot break compaction */ }
    }
  };
}
