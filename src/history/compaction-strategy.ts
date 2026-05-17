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
): CompactionStrategyHook {
  return async (helpers, opts, next) => {
    const strategy = (opts as { strategy?: { kind?: string; target?: number; keepRecent?: number } })?.strategy;
    if (strategy?.kind === "rewind" || strategy?.kind === "replace") {
      return await next(opts);
    }

    const store = getStore();
    const capture = getCapture();
    if (!store || !capture) return await next(opts);

    await capture.flush();
    const messages = helpers.getMessages() as AgentMessage[];
    if (messages.length < 4) return await next(opts);

    const target = (opts as { target?: number })?.target ?? strategy?.target;
    const keepRecentBudget = target && target > 0 ? Math.max(target, 4000) : DEFAULT_KEEP_RECENT_TOKEN_BUDGET;
    const cutIdx = findCutPoint(messages, keepRecentBudget);
    if (cutIdx < 2) return await next(opts);

    const firstKeptId = capture.getEntryIdAt(cutIdx);
    if (!firstKeptId) {
      onWarn?.(`compaction: cutIdx ${cutIdx} resolves to synthetic slot; falling through to default strategy`);
      return await next(opts);
    }

    const tokensBefore = helpers.estimatePromptTokens();
    const evictedCount = cutIdx;

    try {
      await store.appendCompaction(firstKeptId, tokensBefore);
    } catch (err) {
      onWarn?.(`compaction: appendCompaction failed (${(err as Error).message}); falling through`);
      return await next(opts);
    }

    const { messages: liveView, entryIds } = store.buildBranchWithIds();
    helpers.replaceMessages(liveView);
    capture.resetTo(entryIds);

    const tokensAfter = helpers.estimatePromptTokens();
    return { before: tokensBefore, after: tokensAfter, evictedCount };
  };
}

function findCutPoint(messages: AgentMessage[], tokenBudget: number): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i]!);
    if (acc >= tokenBudget) {
      let cut = i;
      while (cut < messages.length && !isSafeCutPoint(messages, cut)) cut++;
      return cut;
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
  if (m.tool_calls) for (const t of m.tool_calls) chars += (t.function?.arguments?.length ?? 0);
  return Math.ceil(chars * APPROX_TOKENS_PER_CHAR) + 20;
}
