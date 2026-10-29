import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { Bridge, SessionKind } from "../bridges/types.js";
import type { SessionStore as HistoryStore } from "../history/session-store.js";
import type { Session } from "./session-types.js";
import type { SessionSetup } from "./session-service.js";
import type { RestoredSession, SessionLifecycleAdapters, SessionLifecycleOptions } from "./session-lifecycle-types.js";
import { installLazySessionRestore } from "./session-lazy-restore.js";

/** Application-composed lifecycle. Mutable write queues, initialization tracking
 * and frame counters remain in injected persistence/runtime adapters so existing
 * archive/delete/shutdown commands synchronize with exactly the same owners. */
export class SessionLifecycle {
  constructor(private readonly adapters: SessionLifecycleAdapters) {}
  create(sessions: Map<string, Session>, options: SessionLifecycleOptions, cwd: string,
    existing?: RestoredSession, kind: SessionKind = "agent", setup?: SessionSetup): Promise<Session> {
    return initializeSession(this.adapters, sessions, options, cwd, existing, kind, setup);
  }
  restore(sessions: Map<string, Session>, options: SessionLifecycleOptions): Promise<void> {
    return restoreSavedSessions(this.adapters, sessions, options);
  }
}

async function initializeSession(
  adapters: SessionLifecycleAdapters,
  sessions: Map<string, Session>,
  opts: SessionLifecycleOptions,
  cwd: string,
  existing?: RestoredSession,
  spawnKind: SessionKind = "agent",
  setup?: SessionSetup,
): Promise<Session> {
  const { directory: SESSIONS_DIR, metadataPath: sessionMetaPath, saveMetadata: saveSessionMeta, deleteFiles: deleteSessionFiles } = adapters.persistence;
  const { Store: SessionStore, createCapture, createCompactionStrategy, withContextLock, rebuildReplay, synthesizeBranchFrames } = adapters.history;
  const { routeEvent, pushFrame, sseFrame, parseFrameName } = adapters.events;
  const { syncAutoApprove, writeNetworkPolicy } = adapters.configuration;
  const { stopIdleWatchdog, releaseClosedReplay } = adapters.runtime;

  if (opts.signal?.aborted) throw new Error("Hub shutting down");
  let id = existing?.id ?? randomBytes(3).toString("hex");
  while (!existing && (sessions.has(id) || fs.existsSync(sessionMetaPath(id)) || fs.existsSync(path.join(SESSIONS_DIR, `${id}.deleted`)))) id = randomBytes(3).toString("hex");
  const kind: SessionKind = existing?.kind ?? spawnKind;
  const isAgent = kind === "agent";
  const isTerminalKind = kind === "terminal" || kind === "ash-terminal";
  const isRestored = !!existing;
  const needsLazyRestore = isRestored && isAgent && existing!.replay.length === 0;

  let store: HistoryStore | undefined;
  let initialMessages: unknown[] | undefined;
  const treePath = path.join(SESSIONS_DIR, `${id}.jsonl`);

  if (isAgent && !needsLazyRestore) {
    try {
      if (existing && fs.existsSync(treePath)) {
        store = new SessionStore(treePath, { metaPath: sessionMetaPath(id) });
      } else if (!existing) {
        store = new SessionStore(treePath, {
          create: { cwd, sessionId: id },
          metaPath: sessionMetaPath(id),
        });
      } else {
        store = new SessionStore(treePath, {
          create: { cwd, sessionId: id },
          metaPath: sessionMetaPath(id),
        });
      }
    } catch (err) {
      console.error(`[hub] failed to attach tree store for ${id}:`, err);
      throw err;
    }
    initialMessages = existing && store ? store.buildMessages() : existing?.messages;
  }

  const compactionStrategy = isAgent
    ? createCompactionStrategy(
        () => session?.store ?? null,
        () => session?.capture ?? null,
        (msg) => console.error(`[hub] ${id}: ${msg}`),
        async (liveView, entryIds) => {
          if (session) await rebuildReplay(session, liveView, entryIds);
        },
        // Run the strategy's tree mutations under this session's contextLock
        // so auto-compaction can't interleave with rewind/drop/fork.
        <T>(fn: () => Promise<T>) => withContextLock(session, fn),
      )
    : undefined;

  let bridge: Bridge;
  try {
    if (typeof setup?.proxyEnabled === "boolean") writeNetworkPolicy(setup.proxyEnabled, id);
    bridge = isRestored && isAgent ? null as unknown as Bridge
      : opts.makeBridge({ sessionId: id, cwd, kind, initialMessages, compactionStrategy, ...setup, conversationAccess: opts.conversationAccess?.(id), hostAccess: opts.hostAccess?.(id) });
  } catch (error) {
    if (typeof setup?.proxyEnabled === "boolean") { try { writeNetworkPolicy(null, id); } catch {} }
    await store?.seal();
    if (!existing) await deleteSessionFiles(id).catch(() => {});
    throw error;
  }

  const defaultTitle = isTerminalKind ? `▷ ${path.basename(cwd) || cwd}` : "";
  const session: Session = {
    id,
    title: existing?.title ?? defaultTitle,
    kind,
    cwd,
    bridge,
    replay: existing?.replay ?? [],
    segmentText: "",
    segmentSeq: 0,
    sseClients: new Set(),
    model: existing?.model,
    provider: existing?.provider,
    startedAt: existing?.startedAt ?? Date.now(),
    firstTurnDone: !!(initialMessages?.length),
    firstQuery: existing?.firstQuery,
    userTitle: existing?.userTitle,
    lastActivity: Date.now(),
    toolsRunning: 0,
    lastModified: existing?.lastModified ?? existing?.startedAt ?? Date.now(),
    isProcessing: false,
    hasUnread: false,
    lastAgentInfo: null,
    backendState: existing?.backendState,
    backendId: existing?.backendId ?? (existing ? (existing.backendState?.acpSessionId ? "acp" : "ash") : bridge?.backendId),
    collaboration: opts.collaboration,
    queuedQueries: [],
    pendingPermissions: new Map(),
    store,
    contextLock: Promise.resolve(),
    lastFrameSeq: existing?.lastFrameSeq ?? 0,
    _needsRestore: needsLazyRestore || undefined,
  };

  let cancelled = false;
  let rejectInit!: (error: Error) => void;
  let finishInit!: () => void;
  const cancellation = new Promise<never>((_, reject) => { rejectInit = reject; });
  void cancellation.catch(() => {});
  const pending = {
    cancel() { cancelled = true; rejectInit(new Error("Hub shutting down")); },
    done: new Promise<void>(resolve => { finishInit = resolve; }),
  };
  const finishTracking = adapters.runtime.trackInitialization(sessions, pending);
  opts.signal?.addEventListener("abort", pending.cancel, { once: true });
  const checkInitialization = () => {
    if (cancelled || opts.signal?.aborted) throw new Error("Hub shutting down");
    if (session._closed || session._closing) throw new Error("backend closed during initialization");
  };

  adapters.persistence.claimReplay(session);

  // Rebuild replay from store messages so image data is included.
  if (isRestored && store && initialMessages?.length && !needsLazyRestore) {
    try {
      const { entryIds: restoredIds } = store.buildBranchWithIds();
      session.replay = synthesizeBranchFrames(session, initialMessages, restoredIds);
    } catch (err) {
      console.error(`[hub] replay rebuild failed for ${id}:`, err);
    }
  }

  if (isRestored && isAgent) installLazySessionRestore(sessions, opts, session, treePath, compactionStrategy, adapters);

  try {
  if (bridge) {
    if (!isRestored && isAgent) {
      bridge.onEvent((e) => { try { routeEvent(session, e); } catch (err) { console.error("[hub] routeEvent error:", err); } });
      bridge.onClose(() => {
        try { rejectInit(new Error("backend closed during initialization")); session.collaboration?.stopSession(session.id); session._closed = true; stopIdleWatchdog(session); if (sessions.get(id) === session) sessions.delete(id); for (const r of session.sseClients) { try { r.end(); } catch {} } session.sseClients.clear(); releaseClosedReplay(session); } catch (err) { console.error("[hub] bridge onClose error:", err); }
      });
      bridge.onError((err) => {
        try { routeEvent(session, { name: "agent:error", payload: { message: String(err) } }); } catch (e) { console.error("[hub] bridge onError error:", e); }
      });
      if (store) {
        session.capture = createCapture(bridge, () => session.store ?? null, { onWarn: (msg) => console.error(`[hub] ${id}: ${msg}`) });
      }
    }
    // Terminal sessions also need event routing — PTY output flows through
    // shell:pty-data events which must reach SSE clients via routeEvent.
    if (isTerminalKind) {
      bridge.onEvent((e) => { try { routeEvent(session, e); } catch (err) { console.error("[hub] routeEvent error:", err); } });
      bridge.onClose(() => {
        try { rejectInit(new Error("backend closed during initialization")); session.collaboration?.stopSession(session.id); session._closed = true; stopIdleWatchdog(session); if (sessions.get(id) === session) sessions.delete(id); for (const r of session.sseClients) { try { r.end(); } catch {} } session.sseClients.clear(); releaseClosedReplay(session); } catch (err) { console.error("[hub] bridge onClose error:", err); }
      });
    }
    await Promise.race([bridge.ready(), cancellation]);
    checkInitialization();
    syncAutoApprove(bridge);
    if (existing && store && session.capture) {
      const { entryIds } = store.buildBranchWithIds();
      session.capture.resetTo(entryIds);
    }
  }

  checkInitialization();
  sessions.set(id, session);

  // If the session was restored from disk and the replay ends with a
  // dangling agent:processing-start (app was closed mid-response), inject
  // an agent:cancelled frame so the UI does not get stuck in thinking.
  if (existing?.replay && existing.replay.length > 0) {
    let hasDangling = false;
    for (let i = existing.replay.length - 1; i >= 0; i--) {
      const name = parseFrameName(existing.replay[i]!);
      if (!name) continue;
      if (name === "agent:processing-done" || name === "agent:cancelled" || name === "agent:error") break;
      if (name === "agent:processing-start") { hasDangling = true; break; }
    }
    if (hasDangling) {  // from createSession restore
      pushFrame(session, "agent:cancelled", sseFrame(
        { source: id, ts: Date.now(), id: `hub:${id}:recovery`, name: "agent:cancelled" },
        {},
      ));
    }
  }

  if (!existing) {
    await saveSessionMeta(session);
  } else if (!existing.title) {
    // Legacy session without a title field — persist the default (id).
    await saveSessionMeta(session);
  }
  checkInitialization();
  // Push initial title into replay so reconnecting SSE clients see it.
  pushFrame(session, "session:title", sseFrame(
    { source: id, ts: Date.now(), id: `hub:${id}:title`, name: "session:title" },
    { title: session.title },
  ));
  return session;
  } catch (err) {
    session.collaboration?.stopSession(session.id);
    session._closing = true;
    session._closed = true;
    if (!existing) session._deletingFiles = true;
    stopIdleWatchdog(session);
    try { bridge?.close(); } catch {}
    await session.store?.seal();
    if (sessions.get(id) === session) sessions.delete(id);
    await adapters.persistence.settleFailedInitialization(id);
    if (typeof setup?.proxyEnabled === "boolean") { try { writeNetworkPolicy(null, id); } catch {} }
    if (!existing) await deleteSessionFiles(id).catch(e => console.error("[hub] failed initialization cleanup:", e));
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", pending.cancel);
    finishTracking();
    finishInit();
  }
}

async function restoreSavedSessions(adapters: SessionLifecycleAdapters, sessions: Map<string, Session>, opts: SessionLifecycleOptions): Promise<void> {
  const { migrateLegacy: migrateLegacySessions, loadFrameSequence: loadFrameSeq, loadPersisted: loadPersistedSessions, loadArchived: loadArchivedSessions, deleteFiles: deleteSessionFiles, advanceFrameSequence } = adapters.persistence;
  await migrateLegacySessions();
  // Load global frameSeq counter as safety net for old sessions without per-session lastFrameSeq.
  await loadFrameSeq();
  const persisted = await loadPersistedSessions();
  if (persisted.length === 0) return;

  // Skip archived sessions — they stay on disk but don't consume memory.
  const archived = await loadArchivedSessions();

  // Sort by lastModified descending so most recent sessions appear first.
  persisted.sort((a, b) => (b.lastModified ?? b.startedAt ?? 0) - (a.lastModified ?? a.startedAt ?? 0));

  // Restore frameSeq from cached lastFrameSeq values (no replay scanning needed).
  let maxSeq = 0;
  for (const p of persisted) {
    if (p.lastFrameSeq && p.lastFrameSeq > maxSeq) maxSeq = p.lastFrameSeq;
  }
  advanceFrameSequence(maxSeq, false);

  console.error(`[hub] restoring ${persisted.length} session(s) (lightweight, lazy load on open)…`);
  for (const p of persisted) {
    if (p.kind === "terminal" || p.kind === "ash-terminal") {
      try { await deleteSessionFiles(p.id); }
      catch (err) { console.error(`[hub] terminal cleanup failed for ${p.id}:`, err); }
      continue;
    }
    if (archived.has(p.id)) continue; // archived — skip bridge creation
    try {
      await initializeSession(adapters, sessions, opts, p.cwd, {
        id: p.id, title: p.title, kind: p.kind, replay: p.replay,
        startedAt: p.startedAt, messages: p.messages,
        firstQuery: p.firstQuery, userTitle: p.userTitle,
        model: p.model, provider: p.provider,
        lastModified: p.lastModified, lastFrameSeq: p.lastFrameSeq, backendState: p.backendState, backendId: p.backendId,
      });
    } catch (err) {
      console.error(`[hub] failed to restore session ${p.id}; files preserved for retry:`, err);
    }
  }
}
