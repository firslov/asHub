import type { Capture } from "./capture.js";
import type { AgentMessage, SessionStore } from "./session-store.js";
import type { CompactionStrategyHook } from "../bridges/types.js";

export interface CompactResult {
  before: number;
  after: number;
  evictedCount: number;
}

const APPROX_TOKENS_PER_CHAR = 0.25;
const DEFAULT_KEEP_RECENT_TOKEN_BUDGET = 20_000;

export function createCompactionStrategy(
  getStore: () => SessionStore | null,
  getCapture: () => Capture | null,
  onWarn?: (msg: string) => void,
  onCompacted?: (liveView: AgentMessage[], entryIds: (string | null)[]) => void | Promise<void>,
  runLocked?: <T>(fn: () => Promise<T>) => Promise<T>,
): CompactionStrategyHook {
  // Run tree mutations under the hub's contextLock when provided, so they
  // cannot interleave with rewind/drop; fall back to direct execution.
  const locked = <T>(fn: () => Promise<T>): Promise<T> => (runLocked ? runLocked(fn) : fn());
  return async (helpers, opts, next) => {
    const strategy = (opts as { strategy?: { kind?: string; target?: number; keepRecent?: number } })?.strategy;
    if (strategy?.kind === "rewind" || strategy?.kind === "replace") {
      return await next(opts);
    }

    const store = getStore();
    const capture = getCapture();
    if (!store || !capture) return await next(opts);

    // Flush under the lock too: capture.flush() appends pending entries to
    // the tree, so it must not interleave with rewind/drop either.
    await locked(() => capture.flush());
    const messages = helpers.getMessages() as AgentMessage[];
    if (messages.length < 4) return await next(opts);

    const target = (opts as { target?: number })?.target ?? strategy?.target;
    const keepRecentBudget = target && target > 0 ? Math.max(target, 4000) : DEFAULT_KEEP_RECENT_TOKEN_BUDGET;
    const cutIdx = findCutPoint(messages, keepRecentBudget);
    if (cutIdx < 2) return await next(opts);

    const firstKeptId = capture.getEntryIdAt(cutIdx);
    if (!firstKeptId) {
      onWarn?.(`compaction: no tree entry at cutIdx ${cutIdx} (live view longer than tree); falling through to kernel default strategy`);
      return await next(opts);
    }

    const tokensBefore = helpers.estimatePromptTokens();
    const evictedCount = cutIdx;

    const applied = await locked(async () => {
      try {
        await store.appendCompaction(firstKeptId, tokensBefore);
      } catch (err) {
        onWarn?.(`compaction: appendCompaction failed (${(err as Error).message}); falling through`);
        return null;
      }
      const { messages: liveView, entryIds } = store.buildBranchWithIds();
      helpers.replaceMessages(liveView);
      capture.resetTo(entryIds);
      return { liveView, entryIds };
    });
    if (!applied) return await next(opts);
    const { liveView, entryIds } = applied;
    if (onCompacted) {
      try { await onCompacted(liveView, entryIds); }
      catch (err) { onWarn?.(`compaction: onCompacted hook failed: ${(err as Error).message}`); }
    }

    const tokensAfter = helpers.estimatePromptTokens();
    return { before: tokensBefore, after: tokensAfter, evictedCount };
  };
}

function findCutPoint(messages: AgentMessage[], tokenBudget: number): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i]!);
    if (acc >= tokenBudget) {
      // Prefer a safe cut at or after the ideal cut (keeps the full budget).
      for (let cut = i; cut < messages.length; cut++) {
        if (isSafeCutPoint(messages, cut)) return cut;
      }
      // Tool-heavy tails may offer no safe cut going forward; fall back to
      // the nearest safe cut before the ideal cut (keeps more than budget).
      for (let cut = i - 1; cut >= 0; cut--) {
        if (isSafeCutPoint(messages, cut)) return cut;
      }
      return 0;
    }
  }
  return 0;
}

function isSafeCutPoint(messages: AgentMessage[], idx: number): boolean {
  const m = messages[idx];
  if (!m) return true;
  if (m.role === "tool") return false;
  return !(m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0);
}

function estimateMessageTokens(m: AgentMessage): number {
  let chars = 0;
  if (typeof m.content === "string") chars += m.content.length;
  // Multimodal content is an array of parts (e.g. base64 images); stringify
  // it so large payloads count toward the budget, matching agent-sh.
  else if (Array.isArray(m.content)) chars += JSON.stringify(m.content).length;
  if (m.tool_calls) for (const t of m.tool_calls) chars += (t.function?.arguments?.length ?? 0);
  return Math.ceil(chars * APPROX_TOKENS_PER_CHAR) + 20;
}
