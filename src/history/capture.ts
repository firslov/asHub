import type { Bridge } from "../bridges/types.js";
import type { AgentMessage, SessionStore } from "./session-store.js";

export function tagMessagesWithEntryIds(
  messages: unknown[],
  entryIds: (string | null)[],
): unknown[] {
  return messages.map((m, i) => {
    const id = entryIds[i];
    if (id == null) return m;
    const existing = (m as { meta?: Record<string, unknown> }).meta ?? {};
    return { ...(m as object), meta: { ...existing, treeEntryId: id } };
  });
}

export function readEntryIdTags(messages: unknown[]): (string | null)[] {
  return messages.map((m) => {
    const meta = (m as { meta?: { treeEntryId?: unknown } }).meta;
    return typeof meta?.treeEntryId === "string" ? meta.treeEntryId : null;
  });
}

export interface Capture {
  flush(): Promise<void>;
  getEntryIdAt(messageIndex: number): string | null;
  resetTo(ids: (string | null)[]): void;
  truncateTo(n: number): void;
  length(): number;
}

export interface CaptureOpts {
  onWarn?(msg: string): void;
}

export function createCapture(
  bridge: Bridge,
  getStore: () => SessionStore | null,
  opts?: CaptureOpts,
): Capture {
  let liveEntryIds: (string | null)[] = [];

  const flush = async (): Promise<void> => {
    const store = getStore();
    if (!store) return;
    const snap = await bridge.snapshot();
    const messages = snap.messages as AgentMessage[];

    if (messages.length < liveEntryIds.length) {
      opts?.onWarn?.(`capture: snapshot shrank (${messages.length} < ${liveEntryIds.length}) — asHub-owned compaction should never produce this; bridge contract violated or fallback path fired`);
      return;
    }
    if (messages.length === liveEntryIds.length) return;
    const newMessages = messages.slice(liveEntryIds.length);
    const newIds = await store.appendMessages(newMessages);
    liveEntryIds = [...liveEntryIds, ...newIds];
  };

  return {
    flush,
    getEntryIdAt: (i) => liveEntryIds[i] ?? null,
    resetTo: (ids) => { liveEntryIds = [...ids]; },
    truncateTo: (n) => { liveEntryIds = liveEntryIds.slice(0, Math.max(0, n)); },
    length: () => liveEntryIds.length,
  };
}
