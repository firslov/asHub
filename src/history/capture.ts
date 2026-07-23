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
  // Set when the snapshot and the persisted tree diverge beyond repair; all
  // further appends are refused so a misaligned capture can't corrupt history.
  let desynced = false;

  // Content comparison ignoring meta: meta carries treeEntryId tags that the
  // stored entry's message may not share.
  const sameMessage = (a: AgentMessage, b: AgentMessage): boolean => {
    const strip = (m: AgentMessage) => {
      const { meta: _meta, ...rest } = m as AgentMessage & { meta?: unknown };
      return rest;
    };
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  };

  const flush = async (): Promise<void> => {
    const store = getStore();
    if (!store || desynced) return;
    const snap = await bridge.snapshot();
    const messages = snap.messages as AgentMessage[];

    if (messages.length < liveEntryIds.length) {
      // The snapshot shrank. Path 1 — realign by content: walk the shared
      // prefix comparing each live message against its stored tree entry,
      // truncate liveEntryIds at the first divergence and rewind activeLeaf
      // to match, then fall through so the divergent tail re-appends under
      // the correct parent.
      let prefix = 0;
      while (prefix < messages.length) {
        const id = liveEntryIds[prefix];
        const entry = id ? store.getEntry(id) : undefined;
        if (!entry || entry.type !== "message" || !sameMessage(entry.message, messages[prefix]!)) break;
        prefix++;
      }
      const newLeafId = prefix > 0 ? liveEntryIds[prefix - 1]! : null;
      if (prefix > 0 && newLeafId) {
        opts?.onWarn?.(`capture: snapshot shrank (${messages.length} < ${liveEntryIds.length}); realigned to verified prefix of ${prefix} message(s), re-appending divergent tail`);
        liveEntryIds = liveEntryIds.slice(0, prefix);
        store.setActiveLeaf(newLeafId);
      } else {
        // Path 2 — no verifiable shared prefix (contents diverge from index
        // 0, or the boundary entry is a compaction placeholder): any append
        // would hang messages under the wrong parent, so halt persistence
        // until hub re-syncs via resetTo/truncateTo.
        desynced = true;
        opts?.onWarn?.(`capture: snapshot shrank (${messages.length} < ${liveEntryIds.length}) and shares no verifiable prefix with the persisted tree — history persistence halted (desynced) to prevent corruption; restart or re-sync required`);
        return;
      }
    }
    if (messages.length === liveEntryIds.length) return;
    const newMessages = messages.slice(liveEntryIds.length);
    const newIds = await store.appendMessages(newMessages);
    liveEntryIds = [...liveEntryIds, ...newIds];
  };

  return {
    flush,
    getEntryIdAt: (i) => liveEntryIds[i] ?? null,
    // resetTo/truncateTo are hub-driven re-syncs (load, rewind, compaction):
    // they re-establish a trusted alignment, so they clear the desynced flag.
    resetTo: (ids) => { liveEntryIds = [...ids]; desynced = false; },
    truncateTo: (n) => { liveEntryIds = liveEntryIds.slice(0, Math.max(0, n)); desynced = false; },
    length: () => liveEntryIds.length,
  };
}
