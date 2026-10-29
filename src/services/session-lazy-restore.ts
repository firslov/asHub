import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { Bridge, CompactionStrategyHook } from "../bridges/types.js";
import type { Session } from "./session-types.js";
import type { SessionLifecycleAdapters, SessionLifecycleOptions } from "./session-lifecycle-types.js";

/** Install the retryable lazy restore state machine. Disk repair completes before
 * backend setup; cancellation never revives a deleted/archived conversation. */
export function installLazySessionRestore(
  sessions: Map<string, Session>, opts: SessionLifecycleOptions, session: Session,
  treePath: string, compactionStrategy: CompactionStrategyHook | undefined,
  adapters: SessionLifecycleAdapters,
): void {
  const id = session.id;
  const frameIdRe = /^id: (\d+)/;
  const { directory: SESSIONS_DIR, metadataPath: sessionMetaPath, saveMetadata: saveSessionMeta, persistReplay: persistReplayFile, advanceFrameSequence } = adapters.persistence;
  const { Store: SessionStore, createCapture, withContextLock, synthesizeBranchFrames, migrateLegacyQueryTags, tagLastQueryFrame } = adapters.history;
  const { routeEvent, sseFrame, isDroppedRestoreFrame, parseFrameName, replayFrameId } = adapters.events;
  const { syncAutoApprove } = adapters.configuration;
  const { stopIdleWatchdog, releaseClosedReplay } = adapters.runtime;
  session._ensureBridge = async () => {
    if (session._closing || session._closed || opts.signal?.aborted) throw new Error("session closing");
    if (session._restorePromise) return session._restorePromise;
    if (session.bridge) return;

    let restoreAborted = false;
    let rejectRestore!: (error: Error) => void;
    const cancelledRestore = new Promise<never>((_, reject) => { rejectRestore = reject; });
    void cancelledRestore.catch(() => {});
    const cancelRestore = () => { restoreAborted = true; rejectRestore(new Error("session closing")); };
    session._cancelRestore = cancelRestore;
    opts.signal?.addEventListener("abort", cancelRestore, { once: true });
    const checkRestore = () => {
      if (restoreAborted || session._closing || session._closed || opts.signal?.aborted) throw new Error("session closing");
    };
    const restoreTask = (async () => {
      let replayNeedsCheckpoint = false;
      // ── Phase 2 lazy restore: load replay + messages from disk ──
      if (session._needsRestore) {
        try {
          let loadedReplay = false;
          // Load replay file
          try {
            const replayPath = path.join(SESSIONS_DIR, `${id}.replay.jsonl`);
            const replayRaw = await Promise.race([fs.promises.readFile(replayPath, "utf-8"), cancelledRestore]);
            const replayFrames = replayRaw.split("\n\n").filter((l) => l.trim()).map((l) => l + "\n\n")
              // Drop transient UI frames and legacy thinking-chunk frames
              // (no longer persisted; they only inflate the frame count).
              // Cheap substring pre-filter — no JSON.parse per frame.
              .filter((f) => !isDroppedRestoreFrame(f));
            if (replayFrames.some(f => !["session:title", "agent:info"].includes(parseFrameName(f) ?? ""))) {
              // Keep the FULL history: tail=100 resyncs slice at send time
              // (openSseMulti), so truncating here only loses old turns.
              session.replay = replayFrames;
              loadedReplay = true;
              // SSE control frames (hub:replay-starting/done, ui:error,
              // reemit agent:info) are written straight to clients without
              // touching meta lastFrameSeq, and an idle session has no 2s
              // flush timer — so the persisted counters can lag the ids a
              // client has already seen.  Raise frameSeq past the max id in
              // the restored file (ids are monotonic, so the last frame's
              // id is the max; the file was just fully read, so this is
              // free) — otherwise a restart could reissue old ids and a
              // since=N incremental reconnect would filter new frames
              // permanently.  Monotonicity is preserved: the raised
              // counter keeps every new frame id larger than replayed ones.
              const lastId = replayFrameId(replayFrames[replayFrames.length - 1]!);
              if (lastId !== null) {
                advanceFrameSequence(lastId, true);
                if (lastId > session.lastFrameSeq) session.lastFrameSeq = lastId;
              }
            }
          } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }

          if (session._closing || session._closed) throw new Error("session closing");

          // Load / create SessionStore
          if (!session.store) {
            try {
              if (fs.existsSync(treePath)) {
                session.store = new SessionStore(treePath, { metaPath: sessionMetaPath(id) });
              } else {
                session.store = new SessionStore(treePath, {
                  create: { cwd: session.cwd, sessionId: id },
                  metaPath: sessionMetaPath(id),
                });
              }
            } catch (err) {
              console.error(`[hub] lazy store init failed for ${id}:`, err);
              throw err;
            }
          }

          // A checkpoint mismatch invalidates the projection. Missing legacy
          // checkpoints do not invalidate independent shell/command history.
          if (session.store && session.backendId !== "acp") {
            const checkpoint = path.join(SESSIONS_DIR, `${id}.replay-state.json`);
            let raw: string | undefined;
            try {
              raw = await Promise.race([fs.promises.readFile(checkpoint, "utf-8"), cancelledRestore]);
              const saved = JSON.parse(raw);
              if (!saved || typeof saved.leaf !== "string") throw new SyntaxError("invalid replay checkpoint");
              if (saved.leaf !== session.store.getActiveLeaf()) {
                loadedReplay = false;
                replayNeedsCheckpoint = true;
              }
            } catch (err) {
              if (err instanceof SyntaxError) {
                // Keep both source artifacts before replacing the projection.
                await withContextLock(session, async () => {
                  if (session._closing || session._closed) throw new Error("session closing");
                  const suffix = `.recovery-${Date.now()}-${randomBytes(4).toString("hex")}`;
                  await fs.promises.writeFile(checkpoint + suffix, raw ?? "", { flag: "wx" });
                  const replayPath = path.join(SESSIONS_DIR, `${id}.replay.jsonl`);
                  try { await fs.promises.copyFile(replayPath, replayPath + suffix, fs.constants.COPYFILE_EXCL); }
                  catch (backupError) { if ((backupError as NodeJS.ErrnoException).code !== "ENOENT") throw backupError; }
                });
                loadedReplay = false;
              } else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                if (fs.existsSync(treePath) && !session.store.buildMessages().length) {
                  // Empty trees can still have legitimate shell history. Only
                  // stale conversation frames require an empty projection.
                  const hasConversation = session.replay.some(frame => {
                    try {
                      const line = frame.split("\n").find(l => l.startsWith("data: "));
                      if (!line) return false;
                      const { meta, payload } = JSON.parse(line.slice(6));
                      return (meta?.name === "agent:query" && !payload?.command)
                        || meta?.name === "agent:response-segment";
                    } catch { return false; }
                  });
                  if (hasConversation) loadedReplay = false;
                }
              } else { throw err; }
              replayNeedsCheckpoint = true;
            }
          }
          if (session.store && !loadedReplay && session.backendId !== "acp") {
            const { messages, entryIds } = session.store.buildBranchWithIds();
            session.replay = synthesizeBranchFrames(session, messages, entryIds);
          }

          // Detect dangling agent:processing-start (app closed mid-response)
          // and inject an agent:cancelled frame so UI doesn't get stuck thinking.
          if (session.replay.length > 0) {
            let hasDangling = false;
            for (let i = session.replay.length - 1; i >= 0; i--) {
              const name = parseFrameName(session.replay[i]!);
              if (name === "agent:processing-done" || name === "agent:cancelled" || name === "agent:error") break;
              if (name === "agent:processing-start") { hasDangling = true; break; }
            }
            if (hasDangling) {
              const frame = sseFrame(
                { source: id, ts: Date.now(), id: `hub:${id}:recovery`, name: "agent:cancelled" },
                {},
              );
              // Deliberately NOT persisted (recovery marker, rebuilt on the
              // next restore) — but like pushFrame it must still track the
              // per-session high-water mark so meta lastFrameSeq never lags
              // an id a client may have seen.
              session.replay.push(frame);
              const m = frame.match(frameIdRe);
              if (m) session.lastFrameSeq = Math.max(session.lastFrameSeq, Number(m[1]));
            }
          }

          session._needsRestore = false;
          // Repair the projection even if the external backend fails to start.
          if (replayNeedsCheckpoint) await persistReplayFile(id, session.replay);
        } catch (err) {
          console.error(`[hub] lazy restore failed for ${id}:`, err);
          throw err;
        }
      }

      checkRestore();
      const storeRef = session.store;
      const msgs = storeRef ? storeRef.buildMessages() : undefined;
      const b = opts.makeBridge({ sessionId: id, conversationAccess: opts.conversationAccess?.(id), hostAccess: opts.hostAccess?.(id), cwd: session.cwd, kind: session.kind, initialMessages: msgs, model: session.model, provider: session.provider, compactionStrategy, isRestored: true, restoreState: session.backendState, restoreBackend: session.backendId });
      if (session.backendId && b.backendId && session.backendId !== b.backendId) {
        b.close();
        throw new Error("This session belongs to another backend; restart with its original backend.");
      }
      session.bridge = b;
      session.firstTurnDone = !!(msgs?.length);
      b.onEvent((e) => { try { routeEvent(session, e); } catch (err) { console.error("[hub] routeEvent error:", err); } });
      b.onClose(() => {
        try { if (session.bridge !== b) return; if (session._restorePromise) { cancelRestore(); return; } session.collaboration?.stopSession(session.id); session._closed = true; stopIdleWatchdog(session); if (sessions.get(id) === session) sessions.delete(id); for (const r of session.sseClients) { try { r.end(); } catch {} } session.sseClients.clear(); releaseClosedReplay(session); } catch (err) { console.error("[hub] bridge onClose error:", err); }
      });
      b.onError((err) => {
        try { routeEvent(session, { name: "agent:error", payload: { message: String(err) } }); } catch (e) { console.error("[hub] bridge onError error:", e); }
      });
      if (storeRef) {
        session.capture = createCapture(b, () => session.store ?? null, { onWarn: (msg) => console.error(`[hub] ${id}: ${msg}`) });
        const { entryIds } = storeRef.buildBranchWithIds();
        session.capture.resetTo(entryIds);
      }
      await Promise.race([b.ready(), cancelledRestore]);
      checkRestore();
      syncAutoApprove(b);
      session.backendState = b.getRestoreState?.();
      await saveSessionMeta(session);
      checkRestore();
      if (migrateLegacyQueryTags(session)) await persistReplayFile(id, session.replay);
      await tagLastQueryFrame(session);
      checkRestore();
      session._restorePromise = undefined;
      session._ensureBridge = undefined;
    })();
    // On failure, clear _restorePromise so a later call can retry instead
    // of returning a permanently-rejected promise; still propagate the
    // error to this caller so the route can answer with a 500.
    session._restorePromise = restoreTask.catch((err) => {
      console.error(`[hub] bridge restore failed for ${id}:`, err);
      const failed = session.bridge;
      session.bridge = null as unknown as Bridge;
      session.capture = undefined;
      try { failed?.close(); } catch {}
      session._restorePromise = undefined;
      throw err;
    }).finally(() => {
      opts.signal?.removeEventListener("abort", cancelRestore);
      if (session._cancelRestore === cancelRestore) session._cancelRestore = undefined;
    });
    return session._restorePromise;
  };
}
