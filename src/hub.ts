import { SessionLifecycle } from "./services/session-lifecycle.js";
import type { RestoredSession } from "./services/session-lifecycle-types.js";
import { readBodyWithSignal } from "./transport/body-reader.js";
import { createProviderBalanceService } from "./services/provider-balance.js";
import { createSkillsMarketplaceService } from "./services/skills-marketplace.js";
import { handleFeatureRequest, type FeatureServices } from "./transport/feature-http.js";
import { ApplicationExtensionRegistry } from "./extensions/application.js";
import { installedApplicationDefinitions } from "./extensions/installed.js";
import { HOST_PLUGIN_CAPABILITIES } from "./extensions/manifest.js";
import { MobileAccessExtension } from "./remote/extension.js";
import { handleProjectRequest } from "./transport/project-http.js";
import type { HostSnapshot } from "./services/host-contract.js";
import type { Session, QueuedMessage } from "./services/session-types.js";
import { createHostAccess } from "./services/host-service.js";
import { createConversationAccess } from "./services/conversation-service.js";
import { SessionService } from "./services/session-service.js";
import { ProjectService } from "./services/project-service.js";
import { HostEvents } from "./services/host-events.js";
import { handleHostQuery, HOST_CAPABILITIES } from "./transport/host-http.js";
import { PluginInstaller, MAX_PLUGIN_ZIP } from './plugin-installer.js';
import { HostOperations, type HostAccess } from "./host-operations.js";
import { reasoningProfile, SessionThinking } from "./providers/reasoning.js";
import { mobileReplayStart, mobileReplayFrame } from "./remote/replay.js";
import { readNetworkPolicy, writeNetworkPolicy } from "./network-policy.js";
import { CollaborationTasks } from "./collaboration.js";
import { serveArtifact } from "./artifacts.js";
/**
 * Hub: spawns and supervises Bridges (one per session), exposes them
 * through the web UI on a single port. Path-based routing
 * (/<id>/events, /<id>/submit) matches the embedded web-renderer
 * extension so the same client works.
 *
 * The hub is bridge-agnostic: it consumes BusEvents and delegates
 * lifecycle to whatever Bridge factory the CLI selected (AshBridge,
 * AcpBridge, or anything else conforming to ./bridges/types.ts).
 */
import { ProjectStore } from "./projects.js";
import type { ConversationAccess } from "./bridges/types.js";
import { RemoteConnector, type RemoteSecretStore } from "./remote/connector.js";
import { DEEPSEEK_MODELS } from "./providers/deepseek.js";
import { codexStatus } from "./providers/codex.js";
import * as http from "node:http";
import { settingsValidationError } from "./config-validation.js";
import { pluginCatalog, builtinPluginCatalog, getPluginConfig, savePluginConfig, PluginConfigConflict, PLUGIN_DISABLED } from "./plugins.js";
import { updateSettingsFile } from "./settings-store.js";
import { createAccessGuard } from "./http-auth.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import type { Bridge, BridgeFactory, BusEvent, ContextSnapshot, SessionKind } from "./bridges/types.js";
import { resolveProvider, getProviderNames, getSettings } from "agent-sh/settings";
import { listAllProviders, resolveApiKey, anyProviderConfigured } from "agent-sh/auth";
import { SessionStore, type AgentMessage } from "./history/session-store.js";
import { createCapture, tagMessagesWithEntryIds, readEntryIdTags, type Capture } from "./history/capture.js";
import { extractText, extractImages, snippet, stripContextWrappers, summarizeMessage, isSystemNoteMessage } from "./history/summarize.js";
import { createCompactionStrategy } from "./history/compaction-strategy.js";
import { invalidateGlobalSkillsCache } from "agent-sh/skills";

export interface HubOpts {
  conversationAccess?: (id: string) => ConversationAccess;
  hostAccess?: (id: string) => HostAccess;
  collaboration?: CollaborationTasks;
  port: number;
  remoteSecretStore?: RemoteSecretStore;
  host: string;
  webRoot: string;
  /** Factory the hub uses to spawn one bridge per session. */
  makeBridge: BridgeFactory;
  /** Internal lifecycle signal: prevents late creation after shutdown. */
  signal?: AbortSignal;
}


const AUTO_APPROVE_KEY = "ashub.permissions.autoApprove";

let frameSeq = 0;
const frameIdRe = /^id: (\d+)/;

function replayFrameId(frame: string): number | null {
  const m = frameIdRe.exec(frame);
  return m ? Number(m[1]) : null;
}

function parseFrameName(frame: string): string {
  const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) return "";
  try {
    const inner = JSON.parse(dataLine.slice("data: ".length));
    return (inner?.meta?.name ?? "") as string;
  } catch { return ""; }
}
// NOTE: agent:thinking-chunk is deliberately NOT replayed/persisted — it is
// by far the largest frame source (one frame per reasoning delta) and would
// drown out real history.  Live clients still receive chunks via the direct
// SSE write in pushFrame; restored sessions simply show no thinking blocks.
//
// Frame names dropped from replay on restore.  Every frame in replay.jsonl
// is sseFrame output — `id: N\ndata: {"meta":{…},"payload":…}\n\n` written by
// JSON.stringify — so meta.name always serializes exactly as `"name":"<name>"`
// and the meta object precedes payload.  That lets the restore filter extract
// the name with plain string ops instead of a full JSON.parse per frame
// (~40ms for a 50k-frame session on the session-open path).
const RESTORE_DROP_NAMES = ["ui:error", "ui:info", "agent:thinking-chunk"] as const;
const RESTORE_DROP_NEEDLES = RESTORE_DROP_NAMES.map((n) => `"name":"${n}"`);

function isDroppedRestoreFrame(frame: string): boolean {
  // Necessary condition first: without the literal needle the frame cannot
  // be a drop candidate (JSON.stringify never inserts spaces).
  if (!RESTORE_DROP_NEEDLES.some((needle) => frame.includes(needle))) return false;
  // meta's scalar values (source/ts/id) contain no quotes or braces, so the
  // FIRST `"name":"` in the data line is meta.name — a needle hit inside
  // payload text does not false-positive.  A frame missing the full envelope
  // (e.g. a torn tail after a crash mid-append) is one JSON.parse would
  // reject, and the old parse-based filter KEPT those — keep them here too.
  const ds = frame.indexOf("data: ");
  if (ds < 0) return false;
  const line = frame.slice(ds + "data: ".length, frame.endsWith("\n\n") ? -2 : undefined);
  if (!line.startsWith('{"meta":{') || !line.endsWith("}")) return false;
  const nameStart = line.indexOf('"name":"');
  if (nameStart < 0) return false;
  const from = nameStart + '"name":"'.length;
  const to = line.indexOf('"', from);
  if (to < 0) return false;
  return (RESTORE_DROP_NAMES as readonly string[]).includes(line.slice(from, to));
}
const REPLAY_NAMES = new Set([
  "agent:info",
  "agent:query",
  "agent:query-tagged",
  "agent:response-segment",
  "agent:response-done",
  "agent:usage",
  "agent:processing-start",
  "agent:processing-done",
  "agent:tool-started",
  "agent:tool-completed",
  "agent:tool-batch",
  "agent:cancelled",
  "agent:error",
  "agent:queued",
  "agent:queued-submit",
  "agent:queued-done",
  "permission:request",
  "permission:resolved",
  "session:title",
  "hub:compaction-marker",
  "shell:command-start",
  "shell:command-done",
  "shell:cwd-change",
  "shell:queued",
  "subagent:started",
  "subagent:done",
  "subagent:swarm-started",
  "subagent:swarm-progress",
  "subagent:swarm-done",
  "agent:todo",
]);

/** Agent events that indicate forward progress (reset idle timeout). */
const ACTIVITY_EVENTS = new Set([
  "agent:response-chunk",
  "agent:thinking-chunk",
  "agent:tool-batch",
  "agent:tool-started",
  "agent:tool-completed",
  "agent:tool-output-chunk",
  "agent:usage",
]);

// ── Session persistence ──────────────────────────────────────────────

const SESSIONS_DIR = path.join(
  process.env.AGENT_SH_HOME
    ? path.resolve(process.env.AGENT_SH_HOME)
    : path.join(os.homedir(), ".agent-sh"),
  "hub-sessions",
);

const FRAME_SEQ_FILE = path.join(SESSIONS_DIR, ".frame-seq");

// Persist the global frameSeq counter so reconnections work across restarts.
// Writes are batched: pushFrame only marks the counter dirty, and the 2s
// replay-flush cycle (_flushBuf) writes it once per batch.  A dedicated
// promise chain serializes writes across sessions, and values are sampled
// from the monotonic counter at schedule time, so a stale write can never
// overwrite a newer seq.
let _frameSeqDirty = false;
let _frameSeqChain: Promise<void> = Promise.resolve();

function flushFrameSeq(force = false): void {
  if (!force && !_frameSeqDirty) return;
  _frameSeqDirty = false;
  const seq = frameSeq;
  _frameSeqChain = _frameSeqChain.then(async () => {
    try {
      if (!_mkdirDone.has(SESSIONS_DIR)) {
        await fs.promises.mkdir(SESSIONS_DIR, { recursive: true });
        _mkdirDone.add(SESSIONS_DIR);
      }
      await fs.promises.writeFile(FRAME_SEQ_FILE, String(seq));
    } catch {}
  });
}

async function loadFrameSeq(): Promise<void> {
  try {
    const raw = await fs.promises.readFile(FRAME_SEQ_FILE, "utf-8");
    const n = Number(raw.trim());
    if (n > frameSeq) frameSeq = n;
  } catch {}
}

async function ensureSessionsDir(): Promise<void> {
  await fs.promises.mkdir(SESSIONS_DIR, { recursive: true });
}

const ARCHIVED_PATH = path.join(SESSIONS_DIR, "archived.json");
const PINNED_PATH = path.join(SESSIONS_DIR, "pinned.json");

async function loadPinnedSessions(): Promise<Set<string>> {
  try {
    const raw = await fs.promises.readFile(PINNED_PATH, "utf-8");
    return new Set(JSON.parse(raw) as string[]);
  } catch { return new Set(); }
}

async function savePinnedSessions(pinned: Set<string>): Promise<void> {
  await ensureSessionsDir();
  const tmp = PINNED_PATH + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify([...pinned], null, 2), "utf-8");
  await fs.promises.rename(tmp, PINNED_PATH);
}

let pinLock: Promise<void> = Promise.resolve();
function updatePinnedSessions(update: (pinned: Set<string>) => void): Promise<Set<string>> {
  const next = pinLock.catch(() => {}).then(async () => {
    const pinned = await loadPinnedSessions();
    update(pinned);
    await savePinnedSessions(pinned);
    return pinned;
  });
  pinLock = next.then(() => {});
  // Retain failure for the caller without an unhandled rejection on the lock.
  void pinLock.catch(() => {});
  return next;
}

async function loadArchivedSessions(): Promise<Map<string, number>> {
  try {
    const raw = await fs.promises.readFile(ARCHIVED_PATH, "utf-8");
    return new Map(Object.entries(JSON.parse(raw)));
  } catch { return new Map(); }
}

let archiveLock: Promise<void> = Promise.resolve();
function saveArchivedSession(id: string, at?: number): Promise<void> {
  const next = archiveLock.catch(() => {}).then(async () => {
    await ensureSessionsDir();
    const map = await loadArchivedSessions();
    if (at !== undefined) map.set(id, at); else map.delete(id);
    const tmp = ARCHIVED_PATH + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(Object.fromEntries(map)));
    await fs.promises.rename(tmp, ARCHIVED_PATH);
  });
  archiveLock = next;
  return next;
}

function sessionMetaPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.meta.json`);
}

const _metaTimers = new Map<string, ReturnType<typeof setTimeout>>();
const META_DEBOUNCE_MS = 500;

const _metaLocks = new Map<string, Promise<void>>();
function saveSessionMeta(session: Session, opts?: { allowClosed?: boolean; titleChange?: { title: string; userTitle?: string; lastModified: number } }): Promise<void> {
  const next = (_metaLocks.get(session.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (session._deletingFiles || (session._closed && !opts?.allowClosed)) {
      if (opts?.titleChange) throw new Error("session closing");
      return;
    }
    await ensureSessionsDir();
    const metaPath = sessionMetaPath(session.id);
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(await fs.promises.readFile(metaPath, "utf-8")); } catch {}
    if (session._deletingFiles || (session._closed && !opts?.allowClosed)) {
      if (opts?.titleChange) throw new Error("session closing");
      return;
    }
    // Read live state inside the per-id transaction, never before waiting.
    const merged = { ...existing, id: session.id, title: session.title, kind: session.kind, cwd: session.cwd, model: session.model, provider: session.provider, startedAt: session.startedAt, firstQuery: session.firstQuery, userTitle: session.userTitle, lastModified: session.lastModified, lastFrameSeq: session.lastFrameSeq, backendId: session.bridge?.backendId ?? session.backendId, backendState: session.bridge?.getRestoreState?.() ?? session.backendState };
    if (opts?.titleChange) {
      Object.assign(merged, opts.titleChange);
      merged.lastModified = Math.max(session.lastModified ?? 0, opts.titleChange.lastModified);
    }
    const tmp = metaPath + ".tmp";
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(merged));
      if (session._deletingFiles) {
        if (opts?.titleChange) throw new Error("session closing");
        return;
      }
      await fs.promises.rename(tmp, metaPath);
      // Commit while holding the metadata queue: other saves must never
      // observe a title that has not reached disk.
      if (opts?.titleChange) Object.assign(session, opts.titleChange, {
        lastModified: Math.max(session.lastModified ?? 0, merged.lastModified ?? 0),
      });
      session._onHostChange?.("metadata");
    } finally { await fs.promises.unlink(tmp).catch(() => {}); }
  });
  _metaLocks.set(session.id, next);
  void next.finally(() => { if (_metaLocks.get(session.id) === next) _metaLocks.delete(session.id); }).catch(() => {});
  return next;
}

/** Retry transient storage failures, without rejecting an async timer callback. */
function saveSessionMetaDebounced(session: Session, delay = META_DEBOUNCE_MS): void {
  if (session._closed || session._closing) return;
  const pending = _metaTimers.get(session.id);
  if (pending) clearTimeout(pending);
  _metaTimers.set(session.id, setTimeout(async () => {
    _metaTimers.delete(session.id);
    if (session._closed || session._closing) return;
    try { await saveSessionMeta(session); }
    catch (err) {
      console.error(`[hub] metadata save failed for ${session.id}:`, err);
      pushFrame(session, "ui:error", sseFrame({ source: session.id, ts: Date.now(), id: `hub:${session.id}:storage`, name: "ui:error" }, { message: "Session metadata could not be saved; retrying." }), { transient: true });
      saveSessionMetaDebounced(session, Math.min(Math.max(delay * 2, 5000), 60000));
    }
  }, delay));
}

const _mkdirDone = new Set<string>();
const _replayOwners = new Map<string, Session>();
const _deletedIds = new Set<string>();
const _writeBufs = new Map<string, { frames: string[]; timer: ReturnType<typeof setTimeout> | null }>();
const _writeLocks = new Map<string, Promise<void>>();
/** In-flight session-file deletions (closeSession) — awaited on shutdown
 *  so a close-then-quit can't leave orphaned files that resurrect the
 *  session on next launch.  Keyed by session id; entries self-remove in
 *  their finally, so no self-reference is needed. */
const _pendingDeletes = new Map<string, Promise<void>>();
const BATCH_FLUSH_MS = 2000;

function _flushBuf(sessionId: string): void {
  // Piggyback the global frameSeq write on the 2s batch cycle: one write per
  // flush instead of one per replay frame.
  flushFrameSeq();
  const buf = _writeBufs.get(sessionId);
  if (!buf || buf.frames.length === 0) return;
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
  const owner = _replayOwners.get(sessionId);
  if (!owner || owner._deletingFiles) return;
  void persistReplayFile(sessionId, owner.replay);

}

function releaseClosedReplay(session: Session): void {
  if (session._deletingFiles) return;
  _flushBuf(session.id);
  if (!_writeLocks.has(session.id) && !_writeBufs.get(session.id)?.frames.length && _replayOwners.get(session.id) === session) {
    _replayOwners.delete(session.id);
    _writeBufs.delete(session.id);
  }
}

function persistReplayFrame(sessionId: string, frame: string): void {
  let buf = _writeBufs.get(sessionId);
  if (!buf) {
    buf = { frames: [], timer: null };
    _writeBufs.set(sessionId, buf);
  }
  buf.frames.push(frame);
  if (!buf.timer) {
    buf.timer = setTimeout(() => _flushBuf(sessionId), BATCH_FLUSH_MS);
  }
}

const _initializing = new WeakMap<Map<string, Session>, Set<{ cancel(): void; done: Promise<void> }>>();

export async function shutdownHub(server?: http.Server, sessions?: Map<string, Session>): Promise<void> {
  const initializing = sessions ? [...(_initializing.get(sessions) ?? [])] : [];
  for (const pending of initializing) pending.cancel();
  await Promise.allSettled(initializing.map(pending => pending.done));
  // Snapshot the session list up front: step 3's bridge.close() fires
  // onClose, which marks sessions _closed and removes them from the map —
  // but their files stay on disk, so step 4's meta flush must still see them.
  const allSessions = sessions ? Array.from(sessions.values()) : [];

  // 1. Close all SSE long-lived connections so server.close() doesn't hang.
  for (const s of allSessions) {
    s.collaboration?.stopSession(s.id);
    s._closing = true;
    s._cancelRestore?.();
    for (const res of s.sseClients) {
      try { res.end(); } catch {}
    }
    s.sseClients.clear();
  }

  await Promise.allSettled(allSessions.map(s => s._restorePromise).filter(Boolean));

  // 2. Stop accepting new connections with a hard timeout.
  if (server) {
    await Promise.race([
      new Promise<void>((resolve) => server.close((err) => {
        if (err) console.error("[hub] server close error:", err);
        resolve();
      })),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
  }

  // 3. Gracefully close all bridges.
  if (sessions) {
    await Promise.allSettled(
      Array.from(sessions.values()).map(async (s) => {
        try { s.bridge?.cancel?.(); } catch {}
        try { await withContextLock(s, async () => { await s.capture?.flush(); }); } catch (err) { console.error("[hub] shutdown capture failed:", err); }
        flushSegment(s);
        await s.store?.seal();
        s._closed = true;
        try { await s.bridge?.close?.(); } catch {}
      })
    );
  }

  // 4. Flush all pending writes.
  for (const id of Array.from(_writeBufs.keys())) {
    _flushBuf(id);
  }
  // frameSeq backstop: the dirty flag is set at every counter increment, but
  // write unconditionally on exit so the persisted counter always covers
  // every frame id any client may have seen.
  flushFrameSeq(true);
  // Persist per-session metas (carrying lastFrameSeq) — in-memory values are
  // updated on every pushFrame, but the meta file is otherwise only written
  // on spawn/title-change, so without this the fast restore path would keep
  // seeing a stale lastFrameSeq.  Also flushes any debounced meta writes.
  // allowClosed: step 3's bridge close marked these sessions _closed, but
  // their files were NOT deleted (no closeSession), so writing the meta
  // cannot resurrect anything.
  await Promise.allSettled(allSessions.map(async (s) => {
    const t = _metaTimers.get(s.id);
    if (t) { clearTimeout(t); _metaTimers.delete(s.id); }
    try { await saveSessionMeta(s, { allowClosed: true }); } catch {}
  }));
  await Promise.allSettled(Array.from(_writeLocks.values()));
  for (const id of _writeBufs.keys()) _flushBuf(id);
  await Promise.allSettled(Array.from(_writeLocks.values()));
  for (const [id, buf] of _writeBufs) {
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
    if (buf.frames.length) console.error(`[hub] UNSAVED replay remains for ${id}; storage did not recover`);
  }
  await _frameSeqChain;
  await Promise.allSettled(Array.from(_metaLocks.values()));

  // 5. Await in-flight session-file deletions (closeSession).  Without
  // this, a close-then-quit can leave the session's files on disk and
  // the session reappears on the next launch.
  await Promise.allSettled(Array.from(_pendingDeletes.values()));
}

function persistReplayFile(sessionId: string, frames: string[]): Promise<void> {
  const owner = _replayOwners.get(sessionId);
  if (_deletedIds.has(sessionId) || owner?._deletingFiles) return Promise.resolve();
  const buf = _writeBufs.get(sessionId);
  if (buf?.timer) { clearTimeout(buf.timer); buf.timer = null; }
  if (buf) buf.frames.length = 0;
  // Capture both at enqueue time. A later tree append must never be marked
  // durable by an earlier replay snapshot.
  const contents = frames.filter(f => (REPLAY_NAMES.has(parseFrameName(f)) || parseFrameName(f) === "hub:branch-switched")).join("");
  const leaf = owner?.store?.getActiveLeaf() ?? null;
  const file = path.join(SESSIONS_DIR, `${sessionId}.replay.jsonl`);
  const checkpoint = path.join(SESSIONS_DIR, `${sessionId}.replay-state.json`);
  const prev = (_writeLocks.get(sessionId) ?? Promise.resolve()).catch(() => {});
  const p = prev.then(async () => {
    if (owner?._deletingFiles || _deletedIds.has(sessionId)) return;
    try {
      await ensureSessionsDir();
      await fs.promises.writeFile(file + ".tmp", contents);
      await fs.promises.rename(file + ".tmp", file);
      await fs.promises.writeFile(checkpoint + ".tmp", JSON.stringify({ leaf }));
      await fs.promises.rename(checkpoint + ".tmp", checkpoint);
    } catch (err) {
      console.error(`[hub] replay save failed for ${sessionId}:`, err);
      // Keep the complete replay in memory; retry an atomic replacement, not
      // an append that may already have partially succeeded.
      if (owner && !owner._deletingFiles) {
        let retry = _writeBufs.get(sessionId);
        if (!retry) { retry = { frames: [], timer: null }; _writeBufs.set(sessionId, retry); }
        retry.frames.push("dirty");
        if (!owner._closing && !owner._closed && !retry.timer) retry.timer = setTimeout(() => _flushBuf(sessionId), 5000);
        pushFrame(owner, "ui:error", sseFrame({ source: sessionId, ts: Date.now(), name: "ui:error" }, { message: "History could not be saved. Keep this session open while storage is unavailable; saving will be retried." }), { transient: true });
      }
    } finally {
      if (_writeLocks.get(sessionId) === p) {
        _writeLocks.delete(sessionId);
        if (owner?._closed && !_writeBufs.get(sessionId)?.frames.length && _replayOwners.get(sessionId) === owner) {
          _replayOwners.delete(sessionId);
          _writeBufs.delete(sessionId);
        }
      }
    }
  });
  _writeLocks.set(sessionId, p);
  return p;
}

async function unlinkIfExists(file: string): Promise<void> {
  try { await fs.promises.unlink(file); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
}

async function deleteSessionFiles(id: string): Promise<void> {
  const files = [".meta.json.tmp", ".meta.json", ".replay.jsonl", ".replay.jsonl.tmp", ".replay-state.json", ".replay-state.json.tmp", ".messages.json", ".jsonl", ".jsonl.leaf"];
  const results = await Promise.allSettled(files.map(ext => unlinkIfExists(path.join(SESSIONS_DIR, `${id}${ext}`))));
  try {
    const dir = path.join(SESSIONS_DIR, "uploads");
    const names = await fs.promises.readdir(dir);
    results.push(...await Promise.allSettled(names.filter(n => n.startsWith(id + "_")).map(n => unlinkIfExists(path.join(dir, n)))));
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") results.push({ status: "rejected", reason: err }); }
  try {
    const names = await fs.promises.readdir(SESSIONS_DIR);
    const backups = names.filter(n => n.startsWith(`${id}.replay-state.json.recovery-`) || n.startsWith(`${id}.replay.jsonl.recovery-`));
    results.push(...await Promise.allSettled(backups.map(n => unlinkIfExists(path.join(SESSIONS_DIR, n)))));
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") results.push({ status: "rejected", reason: err }); }
  const failed = results.find(r => r.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

interface PersistedSession {
  id: string;
  title?: string;
  kind?: SessionKind;
  cwd: string;
  model?: string;
  provider?: string;
  startedAt: number;
  replay: string[];
  messages?: unknown[];
  firstQuery?: string;
  userTitle?: string;
  lastModified?: number;
  lastFrameSeq?: number;
  backendState?: Record<string, unknown>;
  backendId?: string;
}

let modelProvidersCache: Map<string, Set<string>> | null = null;

function invalidateModelProviders(): void {
  modelProvidersCache = null;
}

function modelToProviders(): Map<string, Set<string>> {
  if (modelProvidersCache) return modelProvidersCache;
  const m = new Map<string, Set<string>>();
  for (const name of getProviderNames()) {
    const p = resolveProvider(name);
    if (!p) continue;
    const ids = [p.defaultModel, ...(p.models ?? [])].filter((x): x is string => !!x);
    for (const id of ids) {
      let set = m.get(id);
      if (!set) { set = new Set(); m.set(id, set); }
      set.add(name);
    }
  }
  return (modelProvidersCache = m);
}

function inferProviderForModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return modelToProviders().get(model)?.values().next().value;
}

function providerHasModel(name: string | undefined, model: string | undefined): boolean {
  if (!name || !model) return false;
  return modelToProviders().get(model)?.has(name) ?? false;
}

async function migrateLegacySessions(): Promise<void> {
  await ensureSessionsDir();
  let files: string[];
  try { files = await fs.promises.readdir(SESSIONS_DIR); } catch { return; }
  for (const file of files) {
    if (!file.endsWith(".meta.json")) continue;
    const id = file.slice(0, -".meta.json".length);
    if (fs.existsSync(path.join(SESSIONS_DIR, `${id}.deleted`))) continue;
    const treePath = path.join(SESSIONS_DIR, `${id}.jsonl`);
    if (fs.existsSync(treePath)) continue;
    try {
      const metaRaw = await fs.promises.readFile(path.join(SESSIONS_DIR, file), "utf-8");
      const meta = JSON.parse(metaRaw);
      const cwd = meta.cwd ?? process.cwd();
      let messages: AgentMessage[] = [];
      try {
        const msgRaw = await fs.promises.readFile(path.join(SESSIONS_DIR, `${id}.messages.json`), "utf-8");
        const parsed = JSON.parse(msgRaw);
        if (Array.isArray(parsed)) messages = parsed;
      } catch {}
      const store = new SessionStore(treePath, {
        create: { cwd, sessionId: id },
        metaPath: sessionMetaPath(id),
      });
      if (messages.length > 0) await store.appendMessages(messages);
      console.error(`[hub] migrated session ${id} → tree (${messages.length} messages)`);
    } catch (err) {
      console.error(`[hub] migration failed for ${id}:`, err);
    }
  }
}

async function loadPersistedSessions(): Promise<PersistedSession[]> {
  try {
    await ensureSessionsDir();
    const files = await fs.promises.readdir(SESSIONS_DIR);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json") && !files.includes(f.slice(0, -".meta.json".length) + ".deleted"));

    // Phase 1: parallel read of meta.json only (tiny files, minimal I/O)
    const results = (await Promise.all(metaFiles.map(async (file) => {
      const id = file.slice(0, -".meta.json".length);
      try {
        const metaRaw = await fs.promises.readFile(path.join(SESSIONS_DIR, file), "utf-8");
        const meta = JSON.parse(metaRaw);
        return {
          id: meta.id || id,
          title: meta.title,
          kind: meta.kind,
          cwd: meta.cwd,
          model: meta.model,
          provider: meta.provider,
          startedAt: meta.startedAt,
          replay: [] as string[], // lazy-loaded on first SSE connect
          messages: undefined,    // lazy-loaded on first SSE connect
          firstQuery: meta.firstQuery,
          userTitle: meta.userTitle,
          lastModified: meta.lastModified,
          lastFrameSeq: meta.lastFrameSeq as number | undefined,
          backendState: meta.backendState as Record<string, unknown> | undefined,
          backendId: typeof meta.backendId === "string" ? meta.backendId : undefined,
        } as PersistedSession;
      } catch { return null; }
    }))).filter((s): s is PersistedSession => s !== null);

    // Fallback for dynamic-catalog models that never appear in any static `models` list.
    const observed = new Map<string, string>();
    for (const s of results) {
      if (s.model && s.provider) observed.set(s.model, s.provider);
    }

    for (const s of results) {
      if (!s.model) continue;
      const staticMatch = inferProviderForModel(s.model);

      if (!s.provider) {
        const inferred = staticMatch ?? observed.get(s.model);
        if (inferred) {
          s.provider = inferred;
          console.log(`[hub] backfilled provider="${inferred}" for session ${s.id} (model=${s.model})`);
        }
      } else if (staticMatch && staticMatch !== s.provider && !providerHasModel(s.provider, s.model)) {
        console.log(`[hub] corrected stale provider for session ${s.id}: "${s.provider}" → "${staticMatch}" (model=${s.model})`);
        s.provider = staticMatch;
      }
    }

    return results;
  } catch {
    return [];
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/**
 * DNS-rebinding / hostile-Host guard. A rebinding page resolves its own
 * hostname to 127.0.0.1 and requests with Host: <that hostname> — a
 * same-origin request that CORS cannot stop. Only accept requests whose
 * Host is an IP literal, "localhost", or an explicitly configured bind
 * hostname. Missing Host (HTTP/1.0, raw local clients) is allowed: the
 * browser-based rebinding threat always carries a hostname.
 */
function isAllowedHost(hostHeader: string | undefined, bindHost: string): boolean {
  if (!hostHeader) return true;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost") return true;
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (isIP(bare) !== 0) return true;
  if (bindHost && bindHost.toLowerCase() === hostname) return true;
  return false;
}

/** Placeholder substituted for configured provider API keys on the wire. */
const MASKED_API_KEY = "••••••••";

/** Strip real API keys out of a settings.json object before sending it to the client. */
function maskApiKeys(config: Record<string, unknown>): void {
  const providers = (config as { providers?: Record<string, Record<string, unknown>> }).providers;
  if (!providers || typeof providers !== "object") return;
  for (const p of Object.values(providers)) {
    if (p && typeof p === "object" && typeof p.apiKey === "string" && p.apiKey) {
      p.apiKey = MASKED_API_KEY;
    }
  }
}

/**
 * Restore masked API keys from the on-disk settings before persisting a
 * client-submitted config. The config editor round-trips the GET response,
 * so an untouched apiKey arrives back as MASKED_API_KEY — write the real
 * value back instead of clobbering it with the placeholder.
 */
function unmaskApiKeys(parsed: Record<string, unknown>, old: Record<string, unknown>): void {
  const newProviders = (parsed as { providers?: Record<string, Record<string, unknown>> }).providers;
  const oldProviders = (old as { providers?: Record<string, Record<string, unknown>> }).providers;
  if (!newProviders || typeof newProviders !== "object") return;
  if (!oldProviders || typeof oldProviders !== "object") return;
  for (const [name, p] of Object.entries(newProviders)) {
    if (!p || typeof p !== "object" || p.apiKey !== MASKED_API_KEY) continue;
    const prev = oldProviders[name];
    if (prev && typeof prev === "object") {
      if (typeof prev.apiKey === "string" && prev.apiKey) p.apiKey = prev.apiKey;
      else delete p.apiKey;
    }
  }
}

export function startHub(opts: HubOpts): { server: http.Server; shutdown: () => Promise<void>; remoteStatus: () => ReturnType<RemoteConnector["status"]> } {
  const lifecycle = new AbortController();
  opts = { ...opts, signal: lifecycle.signal };
  const hostEvents = new HostEvents();
  const sessionService = new SessionService({ events: hostEvents, busy: sessionBusy, thinking: sessionThinkingLevel });
  const sessions = sessionService.sessions;
  sessionServices.set(sessions, sessionService);
  const projects = new ProjectService(path.join(SESSIONS_DIR, "projects.json"), {
    sessions, events: hostEvents, deleteSession: id => deleteSession(sessions, id), expandHome,
  });
  const featureServices = createFeatureServices(hostEvents, lifecycle.signal);
  featureServicesBySessions.set(sessions, featureServices);
  opts.collaboration = new CollaborationTasks(path.join(SESSIONS_DIR, "collaboration"));
  opts.conversationAccess = id => conversationAccess(id, sessions, projects, opts.collaboration);
  let extensions: ApplicationExtensionRegistry;
  const pluginInstaller = new PluginInstaller(settingsPath(), undefined, process.platform, target => {
    const ids = new Set(pluginCatalog(settingsPath()).filter(p => (p.packageRoot ?? path.dirname(p.source)) === target).map(p => p.id));
    return [...ids].some(id => extensions?.isPluginBusy(id)) || [...sessions.values()].some(s => s.isProcessing && s.bridge?.getPluginStatus?.().some(p => ids.has(p.id) && p.state === 'loaded'));
  }, async () => {
    // Committed installs must become visible without an installer panel polling
    // metadata. The installer records notification failure separately from success.
    await extensions.refresh();
    extensionSnapshot();
  });
  const operations = new HostOperations(path.join(SESSIONS_DIR, "operation-receipts"));
  opts.hostAccess = id => hostAccess(id, sessions, projects, opts, operations, projects.isDeleting);

  const access = createAccessGuard(opts.host);
  const mobile = new MobileAccessExtension(new RemoteConnector({ store: opts.remoteSecretStore, dataDir: path.join(SESSIONS_DIR, "remote"), localToken: access.token }));
  let knownExtensions = '';
  const extensionSnapshot = () => {
    const snapshot = extensions.snapshot();
    const fingerprint = JSON.stringify(snapshot);
    if (knownExtensions !== fingerprint) {
      knownExtensions = fingerprint;
      hostEvents.publish('extensions');
    }
    return snapshot;
  };
  const hostSnapshot = (): HostSnapshot => {
    const features = extensionSnapshot();
    return { version: 1, ...hostEvents.version(), sessions: sessionService.list(projects), projects: projects.list(), extensions: features };
  };
  extensions = new ApplicationExtensionRegistry({ settingsFile: settingsPath(), capabilities: HOST_PLUGIN_CAPABILITIES,
    discover: () => installedApplicationDefinitions(settingsPath(), { services: {
      host: Object.freeze({ capabilities: () => JSON.parse(JSON.stringify(HOST_CAPABILITIES)), snapshot: () => JSON.parse(JSON.stringify(hostSnapshot())),
        subscribe: (listener: Parameters<HostEvents['subscribe']>[0]) => hostEvents.subscribe(listener) }),
    } }), definitions: [
    { id: 'quick-prompts', name: '快捷提示词', scope: 'frontend', ui: { panel: 'prompt-manager' } },
    { id: 'skills-marketplace', name: '技能市场', capabilities: ['skills.search', 'skills.install'], ui: { panel: 'skills-panel' },
      create: () => ({ canStop: () => featureServices.skills.pendingCount === 0 }) },
    { id: 'provider-balance', name: '余额查询', capabilities: ['provider.balance'],
      create: () => ({ canStop: () => featureServices.balance.pendingCount === 0 }) },
    mobile.definition,
  ] });
  knownExtensions = JSON.stringify(extensions.snapshot());
  if (access.token) console.error(`[hub] Access token: ${access.token} (sign in at /auth)`);
  const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = req.url ?? "/";
    if (lifecycle.signal.aborted) { res.writeHead(503); res.end("Hub shutting down"); return; }

    // Reject requests with a foreign Host header before any route handling
    // (DNS-rebinding protection — see isAllowedHost).
    if (!isAllowedHost(req.headers.host, opts.host)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("bad host");
      return;
    }

    if (!await access.allow(req, res)) return;
    if (await extensions.handle(req, res)) {
      extensionSnapshot();
      return;
    }
    if (handleHostQuery(req, res, { events: hostEvents, signal: lifecycle.signal,
      snapshot: hostSnapshot })) return;
    if (await handleFeatureRequest(req, res, featureServices, extensions)) return;
    if (url === "/api/mobile" || url.startsWith("/api/mobile/")) return mobile.handle(req, res);

    if (await handleProjectRequest(req, res, { sessions, projects, collaboration: opts.collaboration!, worktreesDirectory: path.join(SESSIONS_DIR, "worktrees"), readBody,
      create: cwd => createSession(sessions, opts, cwd), saveSessionMetaDebounced, setSessionTitle })) return;
    if (url.split('?')[0] === '/api/plugins/install') {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const query = new URL(url, 'http://localhost').searchParams;
        let result: unknown;
        if (req.method === 'POST' && query.get('action') === 'preview') {
          if (req.headers['content-type']?.split(';')[0] !== 'application/zip') throw Error('Select a ZIP archive');
          result = await pluginInstaller.preview(await readLimitedBody(req, MAX_PLUGIN_ZIP));
        } else if (req.method === 'POST' && query.get('action') === 'confirm') {
          const body = JSON.parse((await readLimitedBody(req, 1024)).toString('utf8'));
          if (!body || typeof body.token !== 'string') throw Error('Invalid installation token');
          result = pluginInstaller.confirm(body.token);
        } else if (req.method === 'GET') result = query.get('action') === 'preview'
          ? pluginInstaller.previewStatus(query.get('id') ?? '') : pluginInstaller.status(query.get('id') ?? '');
        else if (req.method === 'DELETE') { pluginInstaller.discard(query.get('id') ?? ''); result = { ok: true }; }
        else { res.writeHead(405); res.end('Method not allowed'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
      } catch (e) { res.writeHead((e as { status?: number }).status ?? 400); res.end(String(e)); }
      return;
    }

    if (url.split('?')[0] === "/api/plugins/config") {
      try {
        let result;
        if (req.method === 'GET') {
          const params = new URLSearchParams(url.split('?')[1]);
          result = getPluginConfig(settingsPath(), params.get('id') ?? '', params.get('namespace'));
        } else if (req.method === 'PUT') {
          const input = JSON.parse(await readBody(req));
          if (!input || typeof input.id !== 'string') throw new Error('Invalid plugin configuration');
          result = savePluginConfig(settingsPath(), input.id, input.namespace, input.config, input.revision);
        } else { res.writeHead(405); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(err instanceof PluginConfigConflict ? 409 : 400, { 'Cache-Control': 'no-store' });
        res.end(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (url === "/api/plugins") {
      try {
        if (req.method === "PUT") {
          const input = JSON.parse(await readBody(req));
          if (!input || typeof input.id !== "string" || typeof input.enabled !== "boolean") throw new Error("Invalid plugin update");
          try { await extensions.setPluginEnabled(input.id, input.enabled); }
          catch (error) {
            // Preserve the legacy plugin-manager validation status; the new
            // feature API independently uses 404 for missing contributions.
            if ((error as { status?: number }).status === 404) throw new Error(error instanceof Error ? error.message : String(error));
            throw error;
          } finally { extensionSnapshot(); }
        } else if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
        const catalog = [...pluginCatalog(settingsPath()).map(({ specifier, directoryNames, ...plugin }) => plugin), ...builtinPluginCatalog(settingsPath())];
        const livePluginStatus = [...sessions.values()].filter(s => !s._closed && !s._closing).flatMap(s =>
          (s.bridge?.getPluginStatus?.() ?? []).map(p => ({ ...p, sessionId: s.id, title: s.title || s.id })));
        const plugins = catalog.map(plugin => ({
          ...plugin,
          sessions: livePluginStatus.filter(p => p.id === plugin.id).map(p => ({
            sessionId: p.sessionId, title: p.title, state: p.state, error: p.error, configNamespaces: p.configNamespaces,
          })),
        }));
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ plugins }));
      } catch (err) { res.writeHead((err as { status?: number }).status ?? (req.method === "GET" ? 500 : 400)); res.end(err instanceof Error ? err.message : String(err)); }
      return;
    }
    if (req.method === "GET" && url === "/api/config") return getConfig(res);
    if (req.method === "GET" && url.startsWith("/api/config/apikey")) return getApiKey(req, res);
    if (req.method === "PUT" && url === "/api/config") return updateConfig(req, res, sessions);
    if (req.method === "POST" && url === "/api/config/reload") return reloadConfig(res, sessions);
    if (url === "/api/settings/network" && ["GET", "PUT"].includes(req.method || "")) {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(readNetworkPolicy())); return;
      }
      let data: any;
      try { data = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end("invalid JSON"); return; }
      if (!data || (data.enabled !== null && typeof data.enabled !== "boolean")
          || (data.session !== undefined && (typeof data.session !== "string" || !sessions.has(data.session)))
          || (data.enabled === null && !data.session)) {
        res.writeHead(400); res.end("invalid network setting"); return;
      }
      try {
        if (data.session && sessions.get(data.session)?._hostOperation) { res.writeHead(409); res.end("Conversation operation in progress"); return; }
        const policy = sessionService.writeNetworkPolicy(data.enabled, data.session);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(policy));
      } catch { res.writeHead(500); res.end("network setting could not be saved"); }
      return;
    }
    if (req.method === "GET" && url === "/api/settings/auto-approve") return getAutoApprove(res);
    if (req.method === "PUT" && url === "/api/settings/auto-approve") return setAutoApprove(req, res, sessions);
    if (req.method === "GET" && url === "/api/version") return getVersion(res);
    if (req.method === "GET" && url.startsWith("/api/models")) return getModels(req, res, sessions);
    if (req.method === "GET" && url === "/sessions") return listSessions(res, sessions, projects);
    if (req.method === "GET" && url === "/api/sessions/archived") return listArchivedSessions(res);
    if (req.method === "POST" && url === "/api/sessions/archive") return archiveSession(req, res, sessions);
    if (req.method === "POST" && url === "/api/sessions/unarchive") return unarchiveSession(req, res, sessions, opts);
    if (req.method === "POST" && url === "/api/sessions/unpin") return unpinSession(req, res);
    if (req.method === "POST" && url === "/api/permission/decide") return decidePermission(req, res, sessions);
    if (req.method === "POST" && url === "/api/upload") return uploadImage(req, res, sessions);
    if (req.method === "GET" && url.startsWith("/api/uploads/")) return serveUpload(res, decodeURIComponent(url.slice("/api/uploads/".length)));
    if (req.method === "GET" && url === "/api/sessions/pinned") return listPinnedSessions(res);
    if (req.method === "GET" && url.startsWith("/events")) {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      return openSseMulti(req, res, sessions, params.get("subs") ?? "", params.get("since") ?? "", params.get("view") === "mobile");
    }
    if (req.method === "GET" && url.startsWith("/fs")) {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      return listDirs(res, params.get("prefix") ?? "");
    }
    if (req.method === "GET" && url === "/pick-dir") return pickDir(res);
    if (req.method === "POST" && url === "/sessions") return spawnSession(req, res, sessions, opts);

    const m = url.match(/^\/([0-9a-f]{4,32})(\/.*)?$/);
    if (m) {
      const id = m[1]!;
      const rawRest = m[2] ?? "/";
      const rest = rawRest.split("?")[0]!;  // strip query string for route matching
      if (req.method === "DELETE" && rest === "/" && fs.existsSync(path.join(SESSIONS_DIR, `${id}.deleted`))) return closeSession(res, sessions, id);
      const session = sessions.get(id);
      if (!session) { res.statusCode = 404; res.end("no session"); return; }
      if (session._closing || session._closed || (session._hostOperation && req.method !== "GET" && req.method !== "HEAD")) { res.writeHead(409); res.end("session busy or closing"); return; }
      if (req.method === "GET" || req.method === "HEAD") {
        if (rest === "/artifacts") {
          const params = new URLSearchParams(rawRest.split("?")[1] ?? "");
          return serveArtifact(req, res, session.cwd, params.get("path") ?? "");
        }
        // Compatibility with relative file links already present in replies.
        // Application assets retain their routes; artifacts have a dedicated
        // endpoint so workspace files with the same names remain accessible.
        if (rest !== "/index.html" && !/^\/(?:js|css|vendor|assets)\//.test(rest) && /\.[^/]+$/.test(rest)) {
          return serveArtifact(req, res, session.cwd, decodeURIComponent(rest.slice(1)));
        }
      }
      // Reading the page and managing saved sessions must work even when an
      // external backend is unavailable or cannot resume an old session.
      if (req.method === "DELETE" && rest === "/") return closeSession(res, sessions, id);
      if (req.method === "POST" && rest === "/title") return updateTitle(req, res, session);
      if (req.method === "POST" && rest === "/pin") return togglePin(req, res, session);
      if (req.method === "GET" && (rest === "/" || rest === "/index.html" || /\.(?:js|css|svg|png|ico|woff2?)$/.test(rest))) {
        return serveStatic(req, res, opts.webRoot, rest === "/" ? "/index.html" : rest);
      }
      if (req.method === "GET" && rest === "/git-branch") return gitBranchEndpoint(res, session);
      if (req.method === "GET" && rest === "/files") {
        const params = new URLSearchParams(rawRest.split("?")[1] ?? "");
        return listFiles(res, session, params.get("subdir") ?? "");
      }
      if (req.method === "GET" && (rest === "/tree" || rest === "/branch")) {
        const file = path.join(SESSIONS_DIR, `${id}.jsonl`);
        if (!session.store && fs.existsSync(file)) session.store = new SessionStore(file, { metaPath: sessionMetaPath(id) });
        return rest === "/tree" ? treeEndpoint(res, session) : branchEndpoint(res, session);
      }
      // Lazy-init bridge for restored sessions that haven't been activated yet.
      try {
        await session._ensureBridge?.();
      } catch (err) {
        console.error(`[hub] ensure bridge failed for ${id}:`, err);
        if (req.method === "GET" && rest === "/context") return getContext(res, session);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "session bridge unavailable" }));
        return;
      }

      if (req.method === "POST" && rest === "/pty-input") return ptyInput(req, res, session);
      if (req.method === "POST" && rest === "/pty-resize") return ptyResize(req, res, session);
      if (req.method === "GET" && rest === "/queue") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(session.bridge.withdrawQueued ? [...(session.queuedItems?.values() ?? [])] : [])); return;
      }
      if (req.method === "POST" && rest === "/queue/withdraw") {
        let input;
        try { input = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end("Invalid request"); return; }
        if (typeof input?.requestId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) { res.writeHead(400); res.end("Invalid request ID"); return; }
        const previous = typeof input.id === "string" ? session.withdrawnItems?.get(input.id) : undefined;
        if (previous && previous.requestId === input.requestId) {
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(previous.item)); return;
        }
        const item = typeof input?.id === "string" ? session.queuedItems?.get(input.id) : undefined;
        // No await between lookup and removal: dequeue and withdrawal cannot both win.
        if (!item || session._closed || session._closing || !session.bridge.withdrawQueued?.(item.id)) {
          res.writeHead(409); res.end("Message is no longer queued"); return;
        }
        session.queuedItems?.delete(item.id);
        session._onHostChange?.("queue-withdrawn");
        const receipts = session.withdrawnItems ??= new Map();
        receipts.set(item.id, { requestId: input.requestId, item });
        if (receipts.size > 128) receipts.delete(receipts.keys().next().value!);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(item)); return;
      }
      if (req.method === "POST" && rest === "/submit") return submit(req, res, session);
      if (req.method === "POST" && rest === "/command") return execCommand(req, res, session);
      if (req.method === "GET" && rest === "/thinking") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(session.bridge.getThinking?.() ?? { model: session.model, provider: session.provider, level: "default", levels: [], supported: false }));
        return;
      }
      if (req.method === "POST" && rest === "/thinking") return setThinking(req, res, session);
      if (req.method === "POST" && rest === "/generate-title") return generateTitle(req, res, session);
      if (req.method === "GET" && rest.startsWith("/autocomplete")) {
        const q = url.split("?")[1] ?? "";
        const params = new URLSearchParams(q);
        return autocomplete(res, session, params.get("buffer") ?? "");
      }
      if (req.method === "POST" && rest === "/cancel") {
        const wasProcessing = session.bridge.isProcessing?.() ?? false;
        try { session.bridge.cancel(); } catch (err) { console.error("[hub] cancel:", err); }
        // If the bridge was not actually processing (e.g. restored session
        // with a dangling processing-start in replay), force-push a cancel
        // frame so the UI exits the stuck "thinking" state.
        if (!wasProcessing) {
          session.isProcessing = false;
          pushFrame(session, "agent:cancelled", sseFrame(
            { source: id, ts: Date.now(), id: `hub:${id}:cancel`, name: "agent:cancelled" },
            {},
          ));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && rest === "/context") return getContext(res, session);
      if (req.method === "POST" && rest === "/context/rewind") return rewindContext(req, res, session);
      if (req.method === "POST" && rest === "/context/rewind-to-turn") return rewindToTurn(req, res, session);
      if (req.method === "POST" && rest === "/context/drop") return dropContext(req, res, session);
      if (req.method === "POST" && rest === "/fork") return forkEndpoint(req, res, session);
      if (req.method === "PUT" && rest === "/model") return setModelEndpoint(req, res, session);
      if (req.method === "PUT" && rest === "/sa-model") return setSubagentModel(req, res, session);
      if (req.method === "PUT" && rest === "/sa-budget") return setSubagentBudget(req, res, session);
      if (req.method === "GET" && rest === "/sa-model") return getSubagentModelOverrides(req, res, session);
      if (req.method === "GET" && rest === "/sa-types") return getSubagentTypes(req, res, session);
      if (req.method === "PUT" && rest === "/cwd") return setCwdEndpoint(req, res, session);

      const file = rest === "/" || rest === "/index.html" ? "/index.html" : rest;
      return serveStatic(req, res, opts.webRoot, file);
    }

    if (url === "/") {
      // The root is also the explicitly empty workspace after the last tab
      // closes. Let the client restore its own tabs instead of redirecting
      // every browser/window to the first backend session.
      return serveStatic(req, res, opts.webRoot, "/index.html");
    }

    return serveStatic(req, res, opts.webRoot, url.split("?")[0]!);
  };
  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      console.error("[hub] request failed:", err);
      if (res.writableEnded) return;
      if (res.headersSent) { res.end(); return; }
      res.writeHead(err instanceof TypeError || err instanceof URIError || err instanceof SyntaxError ? 400 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "request failed" }));
    });
  });

  // Restore persisted sessions before starting the HTTP server so that
  // the first /sessions request already sees the full list.
  let stopping = false;
  let shutdownTask: Promise<void> | undefined;
  const restoring = restoreSessions(sessions, opts).catch((err) => {
    console.error("[hub] session restore error:", err);
  }).then(() => {
    if (stopping) return;
    server.listen(opts.port, opts.host, () => {
      const address = server.address();
      if (address && typeof address !== "string") mobile.start(address.port);
      void extensions.start().then(extensionSnapshot, error => {
        extensionSnapshot(); console.error("[hub] extension startup failed:", error);
      });
      console.error(`asHub listening on http://${opts.host}:${opts.port}/`);
    });
  });

  return {
    server,
    remoteStatus: () => mobile.status(),
    shutdown: () => {
      stopping = true;
      lifecycle.abort();
      return shutdownTask ??= Promise.allSettled([restoring, extensions.close(), pluginInstaller.close(), featureServices.skills.close(), featureServices.balance.close()])
        .then(async results => {
          // A broken optional extension must never skip durable core shutdown.
          await shutdownHub(server, sessions);
          const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Application extension cleanup failed');
        }).finally(() => { hostEvents.close(); featureServicesBySessions.delete(sessions); });
    },
  };
}

// Compatibility adapters for existing internal callers; application routes use
// their own service instances below, never a process-wide feature cache.
const featureServicesBySessions = new WeakMap<Map<string, Session>, FeatureServices>();
let compatibilityFeatures: FeatureServices | undefined;
function createFeatureServices(events?: HostEvents, signal?: AbortSignal): FeatureServices {
  return {
    balance: createProviderBalanceService({ resolveApiKey: provider => resolveApiKey(provider), resolveProvider: provider => resolveProvider(provider) }),
    skills: createSkillsMarketplaceService({ settingsPath, getSettings: () => getSettings(), readBody: req => readBodyWithSignal(req, readBody, signal), invalidateGlobalSkillsCache,
      onChanged: () => events?.publish('extensions', 'skills-marketplace') }),
  };
}
function featuresFor(sessions?: Map<string, Session>): FeatureServices {
  return (sessions ? featureServicesBySessions.get(sessions) : undefined) ?? (compatibilityFeatures ??= createFeatureServices());
}
function getBalance(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> { return featuresFor().balance.getBalance(req, res); }
function invalidateBalanceCache(sessions?: Map<string, Session>): void { featuresFor(sessions).balance.invalidate(); }

// ── Models ──────────────────────────────────────────────────────────

// Server-side cache: when OpenRouter async model fetch completes,
// the cached result is served immediately, skipping any wait.
let _serverModelCache: {
  providers: Array<{ name: string; defaultModel?: string; models: Array<{ id: string; modalities?: string[] }> }>;
  ts: number;
} | null = null;
const SERVER_MODEL_CACHE_TTL = 30_000; // 30 seconds
let _serverModelGeneration = 0;
let _codexModelStatus = "";

function scheduleOpenRouterRefresh(sessions: Map<string, Session>): void {
  const generation = _serverModelGeneration;
  // Fire-and-forget: after async fetch completes, recompute and cache.
  (async () => {
    await new Promise((r) => setTimeout(r, 3000));
    if (generation !== _serverModelGeneration) return;
    for (const s of sessions.values()) {
      if (s.kind !== "agent" || !s.bridge?.getModels) continue;
      try {
        const { models } = await s.bridge.getModels();
        if (generation !== _serverModelGeneration) return;
        const orModels = models.filter((m) => m.provider === "openrouter");
        if (orModels.length <= 1) continue;
        invalidateServerModelCache();
        break;
      } catch { continue; }
    }
  })().catch(() => {});
}

function invalidateServerModelCache(): void {
  _serverModelGeneration++;
  _serverModelCache = null;
}

async function getModels(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessions: Map<string, Session>,
): Promise<void> {
  const raw = req.url!.split("/api/models")[1] ?? "";
  const status = JSON.stringify(codexStatus());
  if (status !== _codexModelStatus) {
    _codexModelStatus = status;
    invalidateServerModelCache();
  }
  const single = raw.startsWith("/") ? raw.slice(1).split("?")[0] : "";
  const generation = _serverModelGeneration;

  // Serve from server-side cache if fresh and this is the full list request.
  // Single-provider requests have a different response shape and must not be
  // served from the full-list cache.
  if (!single && _serverModelCache && Date.now() - _serverModelCache.ts < SERVER_MODEL_CACHE_TTL) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(_serverModelCache));
    return;
  }

  try {
    // Bridge models are authoritative — collect them first, then
    // fill in settings-based models only for providers the bridge
    // didn't cover.
    const bridgeModels = new Map<string, { defaultModel?: string; models: Set<string> }>();
    const modelModalities = new Map<string, string[] | undefined>();
    const modelThinking = new Map<string, string[]>();

    for (const s of sessions.values()) {
      if (s.kind !== "agent" || !s.bridge || !s.bridge.getModels) continue;
      try {
        const { models } = await s.bridge.getModels();
        for (const { model, provider, modalities, thinkingLevels } of models) {
          if (!provider || !model) continue;
          let entry = bridgeModels.get(provider);
          if (!entry) {
            entry = { defaultModel: model, models: new Set() };
            bridgeModels.set(provider, entry);
          }
          entry.models.add(model);
          if (modalities) modelModalities.set(`${provider}:${model}`, modalities);
          if (thinkingLevels) modelThinking.set(`${provider}:${model}`, thinkingLevels);
        }
      } catch {
        continue;
      }
    }

    // Do not return or cache a catalog read before the latest invalidation.
    if (generation !== _serverModelGeneration) return getModels(req, res, sessions);

    const byName = new Map(bridgeModels);
    for (const { id } of listAllProviders()) {
      const bridged = bridgeModels.get(id);
      if (bridged) {
        byName.set(id, bridged);
        continue;
      }
      const resolved = resolveProvider(id);
      const defaults = id === "deepseek" ? DEEPSEEK_MODELS : [];
      const models = resolved?.modelsExplicit && resolved.models.length
        ? resolved.models
        : defaults.length ? defaults.map(m => m.id) : resolved?.models ?? [];
      const set = new Set<string>(models);
      if (resolved?.defaultModel) set.add(resolved.defaultModel);
      for (const model of defaults) {
        if (set.has(model.id)) modelModalities.set(`${id}:${model.id}`, resolved?.modelCapabilities?.get(model.id)?.modalities ?? model.modalities);
      }
      byName.set(id, { defaultModel: resolved?.defaultModel ?? (defaults.length ? models[0] : undefined), models: set });
    }

    // OpenRouter fetches its catalog asynchronously after registration.
    // If only the default model is present, return what we have now and
    // schedule an async refresh so the next request gets the full list.
    // A short-lived server-side cache avoids blocking the UI on every open.
    const orEntry = byName.get("openrouter");
    if (orEntry && orEntry.models.size <= 1) {
      scheduleOpenRouterRefresh(sessions);
    }

    if (single) {
      const entry = byName.get(single);
      if (!entry) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `unknown provider: ${single}` }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        provider: single,
        defaultModel: entry.defaultModel,
        models: [...entry.models].map((id) => ({
	        id,
	        modalities: modelModalities.get(`${single}:${id}`),
            thinkingLevels: modelThinking.get(`${single}:${id}`) ?? reasoningProfile({ id, provider: single })?.levels ?? []
	      })),
      }));
      return;
    }

    const providers = [...byName].map(([name, entry]) => ({
      name,
      defaultModel: entry.defaultModel,
      models: [...entry.models].map((id) => ({
	        id,
	        modalities: modelModalities.get(`${name}:${id}`),
            thinkingLevels: modelThinking.get(`${name}:${id}`) ?? reasoningProfile({ id, provider: name })?.levels ?? []
	      })),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    const body = { providers };
    // Only cache when OpenRouter entries are complete (>1 model) or absent,
    // otherwise the incomplete result would block the async refresh.
    const orProv = (body.providers as Array<{ name: string; models: Array<unknown> }>).find((p) => p.name === "openrouter");
    if (!orProv || orProv.models.length > 1) {
      _serverModelCache = { ...body, ts: Date.now() };
    }
    res.end(JSON.stringify(body));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}

// ── Version ──────────────────────────────────────────────────────────

function getVersion(res: http.ServerResponse): void {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  fs.readFile(pkgPath, "utf-8", (err, raw) => {
    let version = "0.0.0";
    if (!err) {
      try {
        const pkg = JSON.parse(raw);
        version = pkg.version || version;
      } catch { /* ignore */ }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version }));
  });
}

// ── Config management ────────────────────────────────────────────────

function settingsPath(): string {
  const home = process.env.AGENT_SH_HOME
    ? path.resolve(process.env.AGENT_SH_HOME)
    : path.join(os.homedir(), ".agent-sh");
  return path.join(home, "settings.json");
}

function getConfig(res: http.ServerResponse): void {
  const fp = settingsPath();
  fs.readFile(fp, "utf-8", (err, raw) => {
    // anyProviderConfigured() also counts env-var and keys-file sources, not
    // just apiKey fields in settings.json — the frontend onboarding hint
    // relies on it. Default to true on failure (never false-alarm).
    let anyConfigured = true;
    try { anyConfigured = anyProviderConfigured() || codexStatus().configured; } catch { /* keep true */ }
    if (err) {
      // Only a missing file is an empty initial configuration. Read failures
      // must not let the editor replace existing settings with defaults.
      const missing = err.code === "ENOENT";
      res.writeHead(missing ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(missing ? { anyProviderConfigured: anyConfigured } : { error: "Failed to read settings" }));
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid settings object");
      parsed.anyProviderConfigured = anyConfigured;
      // Never send real API keys to the renderer — mask them; the editor
      // round-trips the masked value and updateConfig restores the originals.
      maskApiKeys(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(parsed));
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid settings file" }));
    }
  });
}

/**
 * On-demand reveal of a single provider's API key.  GET /api/config masks
 * keys by design, so the "show API key" button fetches the real value here
 * only when the user explicitly asks to see it.
 */
function getApiKey(req: http.IncomingMessage, res: http.ServerResponse): void {
  let provider = "";
  try {
    provider = (new URL(req.url ?? "", "http://localhost")).searchParams.get("provider") ?? "";
  } catch { /* ignore */ }
  if (!provider) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing provider" }));
    return;
  }
  const fp = settingsPath();
  fs.readFile(fp, "utf-8", (err, raw) => {
    if (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ apiKey: "" }));
      return;
    }
    try {
      const parsed = JSON.parse(raw) as { providers?: Record<string, { apiKey?: unknown }> };
      const pk = parsed?.providers?.[provider]?.apiKey;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ apiKey: typeof pk === "string" ? pk : "" }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ apiKey: "" }));
    }
  });
}

async function updateConfig(req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, Session>): Promise<void> {
  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      res.statusCode = 400;
      res.end("invalid JSON object");
      return;
    }
  } catch {
    res.statusCode = 400;
    res.end("invalid JSON");
    return;
  }
  const validationError = settingsValidationError(parsed);
  if (validationError) { res.writeHead(400); res.end(validationError); return; }
  const fp = settingsPath();
  try {
    delete parsed.anyProviderConfigured;
    updateSettingsFile(fp, (old) => {
      for (const key of [AUTO_APPROVE_KEY, "ashub.network", PLUGIN_DISABLED, "subagentModels", "subagentBudgets", "ashub.features.disabled"]) {
        if (old[key] !== undefined) parsed[key] = old[key];
        else delete parsed[key];
      }
      unmaskApiKeys(parsed, old);
      return parsed;
    });
    invalidateSkillCaches(sessions);
    invalidateBalanceCache(sessions);
    invalidateServerModelCache();
    try {
      const { reloadSettings } = await import("agent-sh/settings");
      await reloadSettings();
      invalidateModelProviders();
      for (const s of sessions.values()) { s.bridge?.reloadProviders?.(); }
      sessionServices.get(sessions)?.events.publish('configuration');
    } catch {}
    finally {
      // Also discard reads started while provider reload was in progress.
      invalidateBalanceCache(sessions);
      invalidateServerModelCache();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 500;
    res.end(`write failed: ${err instanceof Error ? err.message : err}`);
  }
}

// Auto-approve setting (stored as a key in settings.json)

function getAutoApprove(res: http.ServerResponse): void {
  const fp = settingsPath();
  fs.readFile(fp, "utf-8", (err, raw) => {
    if (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ autoApprove: false }));
      return;
    }
    try {
      const data = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ autoApprove: data[AUTO_APPROVE_KEY] === true }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ autoApprove: false }));
    }
  });
}

function syncAutoApprove(bridge: Bridge): void {
  if (!bridge.setAutoApprove) return;
  // Synchronous read + apply: no settings update can interleave before publish.
  let enabled = false;
  try { enabled = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"))[AUTO_APPROVE_KEY] === true; } catch {}
  bridge.setAutoApprove(enabled);
}

async function setAutoApprove(req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, Session>): Promise<void> {
  const body = await readBody(req);
  let parsed: { autoApprove?: boolean };
  try { parsed = JSON.parse(body); } catch {
    res.statusCode = 400; res.end("invalid JSON"); return;
  }
  if (!parsed || typeof parsed.autoApprove !== "boolean") {
    res.writeHead(400); res.end("autoApprove must be a boolean"); return;
  }
  const fp = settingsPath();
  try {
    updateSettingsFile(fp, data => ({ ...data, [AUTO_APPROVE_KEY]: parsed.autoApprove }));
    for (const s of sessions.values()) {
      s.bridge?.setAutoApprove?.(!!parsed.autoApprove);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, autoApprove: !!parsed.autoApprove }));
  } catch (err) {
    res.statusCode = 500;
    res.end(`write failed: ${err instanceof Error ? err.message : err}`);
  }
}

function reloadConfig(res: http.ServerResponse, sessions?: Map<string, Session>): void {
  import("agent-sh/settings")
    .then(async (m) => { await m.reloadSettings(); invalidateSkillCaches(sessions); invalidateBalanceCache(sessions); invalidateModelProviders(); invalidateServerModelCache(); if (sessions) sessionServices.get(sessions)?.events.publish('configuration'); })
    .catch(() => {});
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// ── Session management ──────────────────────────────────────────────

const sessionLifecycle = new SessionLifecycle({
  persistence: {
    directory: SESSIONS_DIR,
    metadataPath: sessionMetaPath,
    saveMetadata: session => saveSessionMeta(session),
    deleteFiles: id => deleteSessionFiles(id),
    persistReplay: (id, frames) => persistReplayFile(id, frames),
    claimReplay: session => { _replayOwners.set(session.id, session); },
    async settleFailedInitialization(id) {
      const timer = _metaTimers.get(id);
      if (timer) clearTimeout(timer);
      _metaTimers.delete(id);
      const buf = _writeBufs.get(id);
      if (buf?.timer) clearTimeout(buf.timer);
      _writeBufs.delete(id);
      await Promise.allSettled([_writeLocks.get(id), _metaLocks.get(id)].filter(Boolean));
      _replayOwners.delete(id);
    },
    migrateLegacy: () => migrateLegacySessions(),
    loadFrameSequence: () => loadFrameSeq(),
    loadPersisted: () => loadPersistedSessions(),
    loadArchived: () => loadArchivedSessions(),
    advanceFrameSequence(value, dirty) {
      if (value > frameSeq) { frameSeq = value; if (dirty) _frameSeqDirty = true; }
    },
  },
  history: {
    Store: SessionStore, createCapture, createCompactionStrategy,
    withContextLock, rebuildReplay, synthesizeBranchFrames,
    migrateLegacyQueryTags, tagLastQueryFrame,
  },
  events: { routeEvent, pushFrame, sseFrame, isDroppedRestoreFrame, parseFrameName, replayFrameId },
  configuration: { syncAutoApprove, writeNetworkPolicy },
  runtime: {
    trackInitialization(sessions, pending) {
      let entries = _initializing.get(sessions);
      if (!entries) { entries = new Set(); _initializing.set(sessions, entries); }
      entries.add(pending);
      return () => { entries.delete(pending); };
    },
    stopIdleWatchdog, releaseClosedReplay,
  },
});

/** Compatibility entry points; state machines live in independently composed services. */
async function createSession(
  sessions: Map<string, Session>, opts: HubOpts, cwd: string,
  existing?: RestoredSession, spawnKind: SessionKind = "agent",
  setup?: { instructions?: string; model?: string; provider?: string; proxyEnabled?: boolean | null },
): Promise<Session> {
  return sessionLifecycle.create(sessions, opts, cwd, existing, spawnKind, setup);
}
async function restoreSessions(sessions: Map<string, Session>, opts: HubOpts): Promise<void> {
  return sessionLifecycle.restore(sessions, opts);
}

// ── Idle watchdog ─────────────────────────────────────────────────────
// Force-cancels the agent when no activity (chunks, tool events) is seen for
// the idle window: 3 min base, 10 min while tools are running, extended while
// the bridge still reports processing, with a 30 min hard cap.  See submit()
// for the full rationale.  Shared by submit()'s direct path and by queued
// turns, which only start running on agent:queued-submit — long after
// submit()'s own watchdog has been cleaned up.
//
// The token keeps timer management safe across overlapping turns: restarting
// is idempotent (timers never stack), and a stale stop(token) from a finished
// turn can't kill a newer turn's watchdog.
let idleWatchdogSeq = 0;

function startIdleWatchdog(session: Session, onStuck: (err: Error) => void): number {
  stopIdleWatchdog(session);
  const token = ++idleWatchdogSeq;
  session._idleToken = token;
  session.lastActivity = Date.now();
  session._idleSince = 0;

  const checkIdle = () => {
    if (session._idleToken !== token) return; // stopped or superseded
    const elapsed = Date.now() - session.lastActivity;
    const windowMs = (session.toolsRunning > 0 ? 10 : 3) * 60 * 1000;
    if (elapsed >= windowMs) {
      const idleSince = session._idleSince || Date.now();
      session._idleSince = idleSince;
      // Double-check: if the bridge still reports it's processing, extend
      // the window instead of declaring it stuck.  This is a last-resort
      // safety net that doesn't depend on accurate toolsRunning tracking.
      if (session.bridge.isProcessing?.()) {
        // Hard cap: force-cancel after 30 minutes of total idle time even
        // when the bridge still claims to be processing.  This prevents
        // indefinite hangs from stuck API calls.
        if (Date.now() - idleSince >= 30 * 60 * 1000) {
          session._idleToken = undefined;
          try { session.bridge.cancel(); } catch {}
          onStuck(new Error("Request timed out after 30 minutes of inactivity — the agent may be stuck on an unresponsive API."));
          return;
        }
        session._idleTimer = setTimeout(checkIdle, 2 * 60 * 1000);
        return;
      }
      session._idleToken = undefined;
      try { session.bridge.cancel(); } catch {}
      onStuck(new Error("Request timed out — the agent may be stuck."));
    } else {
      session._idleSince = 0; // activity resumed within the window, reset idle tracking
      session._idleTimer = setTimeout(checkIdle, windowMs - elapsed + 500);
    }
  };
  // Base the initial check interval on whether tools are already running.
  session._idleTimer = setTimeout(checkIdle, (session.toolsRunning > 0 ? 10 : 3) * 60 * 1000);
  return token;
}

function stopIdleWatchdog(session: Session, token?: number): void {
  // A token mismatch means a newer turn already replaced the watchdog —
  // leave it running.
  if (token !== undefined && session._idleToken !== token) return;
  if (session._idleTimer !== undefined) { clearTimeout(session._idleTimer); session._idleTimer = undefined; }
  session._idleToken = undefined;
}

/**
 * Inject a bridge-emitted event into the session: replay buffer, SSE
 * clients, and the segment accumulator that lets reconnects see properly
 * interleaved text/tool ordering (mirrors web-renderer.ts).
 */
function routeEvent(session: Session, e: BusEvent): void {
  // Drop late bridge events for closed/archived sessions entirely — no
  // SSE writes, no replay persistence, no watchdog re-arming.
  if (session._closed) return;
  if (e.name === "agent:request-status") {
    const phase = (e.payload as { phase?: string })?.phase;
    if (!session.isProcessing || !phase || !["sending", "waiting", "retrying", "clear"].includes(phase)) return;
    session.lastRequestStatus = phase === "clear" ? undefined : { phase };
  }
  session.collaboration?.event(session.id, e.name, e.payload);
  if (e.name === "agent:queued-submit" || (e.name === "agent:queued-done" && (e.payload as any)?.dropped)) {
    session.queuedItems?.delete((e.payload as any)?.queueId);
    const i = session.queuedQueries?.indexOf((e.payload as any)?.query);
    if (i !== undefined && i >= 0) session.queuedQueries!.splice(i, 1);
  }
  if (e.name === "agent:providers:changed") invalidateServerModelCache();
  const meta = {
    source: session.id,
    ts: Date.now(),
    id: `hub:${session.id}:${session.segmentSeq}`,
    name: e.name,
  };

  if (e.name === "shell:cwd-change") {
    const cwd = (e.payload as { cwd?: unknown })?.cwd;
    if (typeof cwd === "string" && cwd) {
      session.cwd = cwd;
      session.lastModified = Date.now();
      saveSessionMetaDebounced(session);
    }
  }
  if (session.kind === "terminal" || session.kind === "ash-terminal") {
    if (e.name === "shell:pty-data") {
      bufferPtyData(session, meta, (e.payload as { raw?: string })?.raw ?? "");
    } else if (e.name === "shell:exit" || e.name === "ui:error" || e.name === "ui:info") {
      // Flush buffered PTY output first so these frames keep their stream
      // order (an exit that arrives during a coalesce window must land
      // after the output that preceded it).
      flushPtyBuffer(session);
      pushFrame(session, e.name, sseFrame(meta, e.payload), { transient: true });
    }
    return;
  }

  if (e.name === "permission:request") {
    const p = e.payload as { requestId: string; expiresAt?: number };
    (session.pendingPermissions ??= new Map()).set(p.requestId, { expiresAt: p.expiresAt ?? Date.now() + 30_000 });
  } else if (e.name === "permission:resolved") {
    session.pendingPermissions?.delete((e.payload as { requestId: string }).requestId);
  }

  // ── Activity heartbeat ──────────────────────────────────────────
  // These events indicate the agent is making progress; bump the idle
  // timestamp so the inactivity timeout in submit() doesn't fire while
  // the agent is legitimately working (e.g. long reasoning, slow tools).
  if (ACTIVITY_EVENTS.has(e.name)) {
    session.lastActivity = Date.now();
  }

  // ── Tool-running tracking ────────────────────────────────────────
  // File-modifying tools (write_file, edit_file) don't emit output-chunk
  // events during execution (the permission diff preview suppresses them),
  // so the idle timeout must tolerate longer tool execution windows.
  // Track how many tools are in-flight and use a dynamic idle window.
  if (e.name === "agent:tool-started") session.toolsRunning++;
  if (e.name === "agent:tool-completed" && session.toolsRunning > 0) session.toolsRunning--;

  if (e.name === "agent:response-chunk") {
    const blocks = (e.payload as { blocks?: Array<{ type: string; text?: string }> })?.blocks ?? [];
    for (const b of blocks) if (b.type === "text" && b.text) {
      if (!session.segmentText) session.segmentStartedAt = meta.ts;
      session.segmentText += b.text;
    }
    const frame = sseFrame(meta, e.payload);
    for (const r of session.sseClients) {
      if (r.writableEnded) continue;
      try { r.write(frame); } catch {}
    }
    return;
  }

  if (e.name === "agent:queued-submit") {
    session.lastModified = Date.now();
    session.isProcessing = true;
    session.hasUnread = false;
    session._cancelled = false;
    session.toolsRunning = 0;
    // Same stale-segment guard as submit()'s non-queued path: a previously
    // errored turn may have left text in segmentText — never let it leak
    // into the queued turn that is about to start.
    session.segmentText = "";
    session.segmentStartedAt = undefined;
    // submit() cleaned up its idle watchdog as soon as the bridge reported
    // this turn as queued, so arm a fresh one now that the turn is actually
    // starting — otherwise a stuck queued turn would leave isProcessing true
    // forever.  Record the token so queued-done stops THIS watchdog only:
    // a tokenless stop would also kill a newer turn's watchdog if the
    // queued-done arrives after the user already submitted again.
    const queuedToken = startIdleWatchdog(session, (err) => {
      // Flush any in-flight text before the error card so the stuck turn's
      // partial output survives replay and never contaminates the next turn.
      flushSegment(session);
      session.isProcessing = false;
      pushFrame(session, "agent:error", sseFrame({
        source: session.id,
        ts: Date.now(),
        id: `hub:${session.id}:agent:error`,
        name: "agent:error",
      }, { message: String(err) }));
    });
    session._queuedWdToken = queuedToken;
    const query = (e.payload as { query?: string })?.query ?? "";
    // Generate fresh meta for each frame so they don't share the same
    // id / ts — mirroring submit()'s non-queued path.
    const makeMeta = (name: string) => ({
      source: session.id,
      ts: Date.now(),
      id: `hub:${session.id}:${name}`,
      name,
    });
    pushFrame(session, "agent:query", sseFrame(makeMeta("agent:query"), { query, queueId: (e.payload as any)?.queueId, images: (e.payload as { images?: unknown[] })?.images }));
    pushFrame(session, "agent:processing-start", sseFrame(makeMeta("agent:processing-start"), {}));
    return;
  }

  if (e.name === "agent:queued-done") {
    const dropped = e.payload as { query?: string; queueId?: string; dropped?: boolean } | undefined;
    if (dropped?.dropped) {
      // A queued item that never ran cannot finish or stop another turn.
      pushFrame(session, "agent:queued-done", sseFrame(meta, { query: dropped.query ?? "", queueId: dropped.queueId, dropped: true }));
      _flushBuf(session.id);
      return;
    }
    // Stop only THIS queued turn's watchdog (by token) — a tokenless stop
    // would also kill a newer turn's watchdog when a late queued-done
    // arrives after the user already submitted the next message.
    stopIdleWatchdog(session, session._queuedWdToken);
    session._queuedWdToken = undefined;
    flushSegment(session);
    session.isProcessing = false;
    // Only mark unread if no one is watching (no active SSE client).
    session.hasUnread = session.sseClients.size === 0;
    // Generate a fresh meta so the frame carries its own ts/id — mirroring
    // the non-queued path in submit().
    pushFrame(session, "agent:processing-done", sseFrame({
      source: session.id,
      ts: Date.now(),
      id: `hub:${session.id}:agent:processing-done`,
      name: "agent:processing-done",
    }, {}));
    _flushBuf(session.id);
    saveSessionMetaDebounced(session);
    // Flush under the context lock so it can't interleave with an automatic
    // compaction or a rewind/fork replacing the kernel mid-snapshot.
    if (session.capture) {
      withContextLock(session, async () => {
        await session.capture!.flush();
        await tagLastQueryFrame(session);
      }).catch((err) =>
        console.error(`[hub] capture.flush failed for ${session.id}:`, err)
      );
    }
    if (!session.firstTurnDone && session.firstQuery) {
      session.firstTurnDone = true;
      generateTitleAsync(session).catch((err) =>
        console.error(`[hub] auto-title failed for ${session.id}:`, err)
      );
    }
    return;
  }

  if (e.name === "agent:tool-started") flushSegment(session);

  if (e.name === "agent:info") {
    const info = e.payload as Record<string, unknown> | undefined;
    if (info && typeof info === "object") {
      session.lastAgentInfo ??= {};
      for (const [k, v] of Object.entries(info)) {
        if (v !== undefined && v !== null && v !== "") session.lastAgentInfo[k] = v;
      }
      // Model identity replaces capabilities; thinking-only frames do not.
      if (info.model && !Array.isArray(info.modalities)) session.lastAgentInfo.modalities = [];
      if (typeof info.model === "string" && info.model) session.model = info.model;
      if (typeof info.provider === "string" && info.provider) session.provider = info.provider;
      saveSessionMetaDebounced(session);
    }
  }

  if (e.name === "agent:cancelled") {
    stopIdleWatchdog(session);
    session.isProcessing = false;
    session._cancelled = true;
    session.toolsRunning = 0;
  }

  // A queued turn that died with agent:error (bridge drainQueue's reject
  // emits it directly): stop that turn's watchdog here too, or it fires
  // minutes later and pushes a phantom error card on top of the real one.
  // (submit()'s non-queued error path already cleans up its own watchdog.)
  if (e.name === "agent:error") {
    stopIdleWatchdog(session, session._queuedWdToken);
    session._queuedWdToken = undefined;
  }

  // After cancel, drop tool events from still-running subagents.
  if (session._cancelled && (e.name === "agent:tool-started" || e.name === "agent:tool-completed" || e.name === "agent:tool-output-chunk")) {
    return;
  }

  if (e.name === "ui:error" || e.name === "ui:info" || e.name === "agent:providers:changed" || e.name === "agent:request-status") {
    pushFrame(session, e.name, sseFrame(meta, e.payload), { transient: true });
    return;
  }

  pushFrame(session, e.name, sseFrame(meta, e.payload));
}

function flushSegment(session: Session): void {
  if (!session.segmentText) return;
  const meta = {
    source: session.id,
    // Replays must seal preceding activity at the same time as live chunks.
    ts: session.segmentStartedAt ?? Date.now(),
    id: `hub:${session.id}:seg:${session.segmentSeq++}`,
    name: "agent:response-segment",
  };
  const text = session.segmentText;
  session.segmentText = "";
  session.segmentStartedAt = undefined;
  pushFrame(session, "agent:response-segment", sseFrame(meta, { text }));
}

// Every counter increment must eventually be persisted: mark dirty here so
// frames that never touch the replay write buffer (transient PTY frames,
// broadcast-only control frames, direct response-chunk writes) can't leave
// the on-disk counter behind what clients have already seen — a stale
// counter after restart would make the incremental since-filter drop new
// frames permanently.
function nextFrameId(): number {
  _frameSeqDirty = true;
  return ++frameSeq;
}

function sseFrame(meta: object, payload: unknown): string {
  const id = nextFrameId();
  if ((meta as { name?: string }).name === "agent:query" && payload && typeof payload === "object") {
    payload = { ...payload, queryId: String(id) };
  }
  return `id: ${id}\ndata: ${JSON.stringify({ meta, payload })}\n\n`;
}

// Terminal output arrives as one PTY chunk per read(2) — thousands of tiny
// frames per second during a screen refresh, each with its own JSON.stringify
// and per-client socket write.  Coalesce chunks within a short window into a
// single shell:pty-data frame (the frontend just writes the raw text to
// xterm, so a merged frame renders identically).  An oversized buffer
// flushes immediately so bulk output (cat of a large file) isn't delayed.
const PTY_COALESCE_MS = 12;
const PTY_COALESCE_MAX_CHARS = 256 * 1024;

function bufferPtyData(session: Session, meta: { source: string; ts: number; id: string; name: string }, raw: string): void {
  session._ptyChunks ??= [];
  if (session._ptyChunks.length === 0) session._ptyMeta = meta;
  session._ptyChunks.push(raw);
  session._ptyBuffered = (session._ptyBuffered ?? 0) + raw.length;
  if (session._ptyBuffered >= PTY_COALESCE_MAX_CHARS) {
    flushPtyBuffer(session);
    return;
  }
  if (!session._ptyTimer) {
    session._ptyTimer = setTimeout(() => {
      session._ptyTimer = undefined;
      flushPtyBuffer(session);
    }, PTY_COALESCE_MS);
  }
}

function flushPtyBuffer(session: Session): void {
  if (session._ptyTimer) { clearTimeout(session._ptyTimer); session._ptyTimer = undefined; }
  const chunks = session._ptyChunks;
  if (!chunks || chunks.length === 0) return;
  session._ptyChunks = [];
  session._ptyBuffered = 0;
  const meta = session._ptyMeta ?? {
    source: session.id,
    ts: Date.now(),
    id: `hub:${session.id}:pty`,
    name: "shell:pty-data",
  };
  session._ptyMeta = undefined;
  pushFrame(session, "shell:pty-data", sseFrame(meta, { raw: chunks.join("") }), { transient: true });
}

// Transient frames (pty-data, ui:error/ui:info) are kept in session.replay so
// reconnecting clients see recent scrollback, but they are never persisted —
// cap their in-memory footprint.  64K chars ≈ 64-192KB of terminal scrollback;
// xterm's own buffer covers anything deeper.
const TRANSIENT_REPLAY_MAX_CHARS = 64 * 1024;

function pushTransientFrame(session: Session, frame: string): void {
  session.replay.push(frame);
  const fifo = (session._transientFrames ??= []);
  fifo.push(frame);
  session._transientSize = (session._transientSize ?? 0) + frame.length;
  // Always keep at least the newest frame.
  while ((session._transientSize ?? 0) > TRANSIENT_REPLAY_MAX_CHARS && fifo.length > 1) {
    const oldest = fifo.shift()!;
    session._transientSize! -= oldest.length;
    const i = session.replay.indexOf(oldest);
    if (i >= 0) {
      session.replay.splice(i, 1);
      // The splice shifts every later frame down by one — keep the tag
      // watermark and pending indices aligned with the frames they point
      // at, or tagLastQueryFrame could patch an entryId onto the wrong
      // query frame.  Pendings at or below the evicted slot are dropped:
      // frames below the watermark that lost their pending stay unaddressed
      // until refreshed; the UI requires a stable ID for rewinding.
      if (session._tagScanIdx !== undefined && session._tagScanIdx > i) session._tagScanIdx--;
      if (session._tagPending?.length) {
        session._tagPending = session._tagPending.filter((p) => p.idx > i);
        for (const p of session._tagPending) p.idx--;
      }
    }
  }
}

function pushFrame(session: Session, name: string, frame: string, opts?: { transient?: boolean }): void {
  // Session closed/archived: drop late bridge events entirely.  Their
  // frames were never seen by a client, and persisting them would
  // recreate the deleted replay file as an orphan.
  if (session._closed) return;
  if (["agent:processing-start", "agent:processing-done", "agent:error", "agent:cancelled"].includes(name)) session.lastRequestStatus = undefined;
  if (name === "agent:processing-start") session.lastTurnError = false;
  if (name === "agent:error") {
    session.lastTurnError = true;
    try { session.collaboration?.event(session.id, name, JSON.parse(frame.split("data: ")[1]!).payload); } catch {}
  }
  if (name === "agent:cancelled") session.collaboration?.event(session.id, name, {});
  if (opts?.transient) {
    pushTransientFrame(session, frame);
  } else if (REPLAY_NAMES.has(name) && !session._needsRestore) {
    // The replay keeps the FULL history (no sliding window): thinking-chunk
    // frames — the original reason for the cap — are no longer replayed, so
    // growth is modest, and tail=N subscribers slice at send time anyway.
    session.replay.push(frame);
    persistReplayFrame(session.id, frame);
  }
  // Track highest frameSeq per-session for fast restore — for EVERY pushed
  // frame, transient included: terminal sessions emit nothing but transient
  // frames, so gating this on REPLAY_NAMES left their meta lastFrameSeq at 0
  // forever.  (The global counter's dirty flag is set in nextFrameId at
  // increment time.)
  const m = frame.match(frameIdRe);
  if (m) session.lastFrameSeq = Math.max(session.lastFrameSeq, Number(m[1]));
  for (const r of session.sseClients) {
    if (r.writableEnded) continue;
    try { r.write(frame); } catch {}
  }
  if (["session:title", "shell:cwd-change", "agent:info", "agent:processing-start", "agent:processing-done", "agent:cancelled", "agent:error", "agent:queued", "agent:queued-submit", "agent:queued-done", "permission:request", "permission:resolved"].includes(name)) session._onHostChange?.(name);
}

// ── Session title management ─────────────────────────────────────────

const _titleLocks = new WeakMap<Session, Promise<void>>();
function setSessionTitle(session: Session, title: string, user = false): Promise<void> {
  const next = (_titleLocks.get(session) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const trimmed = title.trim().slice(0, 100);
    if (!trimmed || (!user && session.userTitle) || (!user && trimmed === session.title && !session._titleDirty)) return;
    if (session._closed || session._closing) throw new Error("session closing");
    await saveSessionMeta(session, { titleChange: {
      title: trimmed, ...(user ? { userTitle: trimmed } : {}), lastModified: Date.now(),
    } });
    session._titleDirty = false;
    const frame = sseFrame(
      { source: session.id, ts: Date.now(), id: `hub:${session.id}:title`, name: "session:title" },
      { title: session.title },
    );
    pushFrame(session, "session:title", frame);
  });
  _titleLocks.set(session, next);
  void next.finally(() => { if (_titleLocks.get(session) === next) _titleLocks.delete(session); }).catch(() => {});
  return next;
}

async function generateTitleAsync(session: Session): Promise<void> {
  let query = session.firstQuery?.trim();
  if (!query || session.userTitle) return;
  // Slash-commands don't make good titles — skip them.
  if (query.startsWith("/")) query = undefined;
  if (!query) return;

  const fallback = query.slice(0, 80);

  try {
    const raw = await session.bridge?.complete?.([
      { role: "system", content: "You are a title generator. Given a user's first message to an AI assistant, generate a concise, descriptive title (max 10 words, no quotes). Return ONLY the title text, nothing else." },
      { role: "user", content: `Generate a short title for a conversation that starts with: "${query}"` },
    ], { maxTokens: 256 });
    const title = raw?.trim().replace(/^"|"$/g, "");
    if (title && !session.userTitle) { await setSessionTitle(session, title); return; }
  } catch (err) {
    console.error(`[hub] auto-title LLM call failed for ${session.id}:`, err);
  }

  // Fallback: use the first query text as title.
  if (!session.userTitle) await setSessionTitle(session, fallback);
}

// ── HTTP handlers ───────────────────────────────────────────────────

/** Read saved reasoning without eagerly starting restored conversation kernels. */
function sessionThinkingLevel(s: Session) {
  return s.bridge?.getThinking?.()?.level ?? s.lastAgentInfo?.thinkingLevel ?? (s.model && s.provider ? new SessionThinking(s.backendState?.thinkingSelections).state({ id: s.model, provider: s.provider }).level : "default");
}

const sessionServices = new WeakMap<Map<string, Session>, SessionService>();
function sessionBusy(s: Session): boolean {
  return !!(s.isProcessing || s.bridge?.isProcessing?.() || s.queuedItems?.size || s.queuedQueries?.length
    || s._commandsRunning || _titleLocks.has(s) || _pendingDeletes.has(s.id));
}
function listSessions(res: http.ServerResponse, sessions: Map<string, Session>, projects: ProjectStore): void {
  const service = sessionServices.get(sessions) ?? new SessionService({ busy: sessionBusy, thinking: sessionThinkingLevel });
  const body = JSON.stringify(service.list(projects, sessions));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
}

// ── Archived sessions ───────────────────────────────────────────────────

async function listArchivedSessions(res: http.ServerResponse): Promise<void> {
  const archived = await loadArchivedSessions();
  const items: Array<{ id: string; title: string; cwd: string; startedAt: number; archivedAt: number }> = [];
  for (const [id, archivedAt] of archived) {
    if (fs.existsSync(path.join(SESSIONS_DIR, `${id}.deleted`))) continue;
    try {
      const metaRaw = await fs.promises.readFile(sessionMetaPath(id), "utf-8");
      const meta = JSON.parse(metaRaw);
      items.push({
        id,
        title: meta.title || meta.firstQuery?.slice(0, 80) || "",
        cwd: meta.cwd || "",
        startedAt: meta.startedAt || 0,
        archivedAt,
      });
    } catch { /* meta missing — skip */ }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(items));
}

async function archiveSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessions: Map<string, Session>,
): Promise<void> {
  const body = await readBody(req);
  let id = "";
  try { id = (JSON.parse(body) as { id?: string }).id ?? ""; } catch {}
  if (!id || !/^[0-9a-f]{4,32}$/i.test(id)) { res.statusCode = 400; res.end("invalid id"); return; }

  if (sessions.get(id)?._hostOperation || sessions.get(id)?._closing) { res.writeHead(409); res.end("Conversation busy or closing"); return; }
  await archiveSessionById(sessions, id);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function archiveSessionById(sessions: Map<string, Session>, id: string): Promise<void> {
  const session = sessions.get(id);
  if (session) {
    if (session._closing) throw new Error("session closing");
    session.collaboration?.stopSession(session.id);
    session._closing = true;
    session._cancelRestore?.();
    await session._restorePromise?.catch(() => {});
    stopIdleWatchdog(session);
    try { session.bridge?.cancel(); } catch {}
    try {
      await withContextLock(session, async () => { await session.capture?.flush(); });
      flushSegment(session);
      await saveSessionMeta(session);
      // A lazy session has no replay loaded: never replace its file with [].
      if (!session._needsRestore) {
        await persistReplayFile(id, session.replay);
        if (_writeBufs.get(id)?.frames.length) throw new Error("history could not be saved; archive aborted");
      }
      await saveArchivedSession(id, Date.now());
    } catch (err) {
      session._closing = false;
      const buf = _writeBufs.get(id);
      if (buf?.frames.length && !buf.timer) buf.timer = setTimeout(() => _flushBuf(id), 5000);
      throw err;
    }
    await session.store?.seal();
    session._closed = true;
    try { session.bridge?.cancel(); } catch {}
    try { session.bridge?.close(); } catch {}
    // End + clear SSE clients so late bridge events (e.g. permission
    // timeout) can't write to ended responses.
    for (const r of session.sseClients) { try { r.end(); } catch {} }
    session.sseClients.clear();
    sessions.delete(id);
    // Archived sessions keep their files for unarchive — flush any replay
    // frames still sitting in the write buffer (up to BATCH_FLUSH_MS of
    // tail content) BEFORE removing the buffer, or the restored session
    // would silently lose its last moments.
    _flushBuf(id);
    const lock = _writeLocks.get(id);
    const buf = _writeBufs.get(id);
    if (buf?.timer) { clearTimeout(buf.timer); buf.timer = null; }
    _writeBufs.delete(id);
    if (lock) { try { await lock; } catch {} }
    if (!_writeBufs.get(id)?.frames.length) _replayOwners.delete(id);
  }
  if (!session) await saveArchivedSession(id, Date.now());
}

async function unarchiveSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessions: Map<string, Session>,
  opts: HubOpts,
): Promise<void> {
  const body = await readBody(req);
  let id = "";
  try { id = (JSON.parse(body) as { id?: string }).id ?? ""; } catch {}
  if (!id || !/^[0-9a-f]{4,32}$/i.test(id)) { res.statusCode = 400; res.end("invalid id"); return; }

  const archived = await loadArchivedSessions();
  if (fs.existsSync(path.join(SESSIONS_DIR, `${id}.deleted`))) { res.writeHead(409); res.end("session deleted; retry DELETE to finish cleanup"); return; }
  if (!archived.has(id)) { res.statusCode = 404; res.end("not archived"); return; }

  // Read meta to get cwd, title, and timing
  let cwd = os.homedir();
  let startedAt = Date.now();
  let title: string | undefined;
  let firstQuery: string | undefined;
  let restoredMeta: Partial<Session> = {};
  try {
    const metaRaw = await fs.promises.readFile(sessionMetaPath(id), "utf-8");
    const meta = JSON.parse(metaRaw);
    restoredMeta = meta;
    cwd = meta.cwd || cwd;
    startedAt = meta.startedAt || startedAt;
    title = meta.title || meta.userTitle || undefined;
    firstQuery = meta.firstQuery || undefined;
  } catch {}

  if (sessions.has(id) || _pendingDeletes.has(id)) { res.writeHead(409); res.end("session already active or closing"); return; }
  try {
    await createSession(sessions, opts, cwd, {
      ...restoredMeta,
      id,
      startedAt,
      title,
      firstQuery,
      replay: [],
    });
    await saveArchivedSession(id);
  } catch (err) {
    const failed = sessions.get(id);
    if (failed) {
      failed._closing = true;
      failed._closed = true;
      sessions.delete(id);
      try { failed.bridge?.close(); } catch {}
      await failed.store?.seal();
      const timer = _metaTimers.get(id);
      if (timer) { clearTimeout(timer); _metaTimers.delete(id); }
      const buffer = _writeBufs.get(id);
      if (buffer?.timer) clearTimeout(buffer.timer);
      _writeBufs.delete(id);
      if (_replayOwners.get(id) === failed) _replayOwners.delete(id);
    }
    console.error(`[hub] unarchive createSession failed for ${id}:`, err);
    res.statusCode = 500;
    res.end("failed to restore session");
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function spawnSession(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessions: Map<string, Session>,
  opts: HubOpts,
): Promise<void> {
  const body = await readBody(req);
  let kind: SessionKind = "agent";
  let cwd: string | null = null;
  try {
    const parsed = JSON.parse(body) as { cwd?: string; kind?: SessionKind };
    if (parsed.cwd) cwd = path.resolve(expandHome(parsed.cwd.trim()));
    if (parsed.kind === "terminal" || parsed.kind === "agent" || parsed.kind === "ash-terminal") kind = parsed.kind;
  } catch {}
  if (!cwd) cwd = (kind === "terminal" || kind === "ash-terminal") ? os.homedir() : process.cwd();
  try {
    const stat = await fs.promises.stat(cwd);
    if (!stat.isDirectory()) {
      res.statusCode = 400;
      res.end(`not a directory: ${cwd}`);
      return;
    }
  } catch {
    res.statusCode = 400;
    res.end(`no such directory: ${cwd}`);
    return;
  }
  try {
    const s = await createSession(sessions, opts, cwd, undefined, kind);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ instanceId: s.id, cwd: s.cwd, kind: s.kind }));
  } catch (err) {
    console.error("[hub] spawn failed:", err);
    res.statusCode = 500;
    res.end(`spawn failed: ${err instanceof Error ? err.stack ?? err.message : err}`);
  }
}

function expandHome(input: string): string {
  // Windows produces "~\..." as well as the POSIX "~/..." form — accept both.
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return os.homedir() + input.slice(1);
  return input;
}

function pickDir(res: http.ServerResponse): void {
  const platform = process.platform;
  // Candidates are tried in order when the previous one is not installed.
  const candidates: Array<{ cmd: string; args: string[] }> = [];
  if (platform === "darwin") {
    candidates.push({
      cmd: "osascript",
      args: ["-e", 'POSIX path of (choose folder with prompt "Select working directory")'],
    });
  } else if (platform === "win32") {
    candidates.push({
      cmd: "powershell",
      args: [
        "-NoProfile", "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select working directory'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }",
      ],
    });
  } else {
    candidates.push(
      { cmd: "zenity", args: ["--file-selection", "--directory", "--title=Select working directory"] },
      { cmd: "kdialog", args: ["--getexistingdirectory", os.homedir(), "--title", "Select working directory"] },
      { cmd: "yad", args: ["--file-selection", "--directory", "--title=Select working directory"] },
    );
  }

  const tryNext = (idx: number): void => {
    const { cmd, args } = candidates[idx];
    execFile(cmd, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) {
        // Tool not installed — fall back to the next candidate.
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && idx + 1 < candidates.length) {
          tryNext(idx + 1);
          return;
        }
        // An empty selection (and no unexpected stderr) means the user cancelled the dialog.
        if (!stdout.trim() && (!stderr.trim() || /user cancel/i.test(stderr))) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ cancelled: true }));
          return;
        }
        console.error(`[hub] pick-dir failed (${cmd}):`, stderr || err);
        res.statusCode = 500;
        res.end(`pick-dir failed: ${stderr.trim() || err.message}`);
        return;
      }
      const cwd = stdout.trim();
      if (!cwd) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ cancelled: true }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cwd }));
    });
  };
  tryNext(0);
}

async function listDirs(res: http.ServerResponse, prefix: string): Promise<void> {
  const home = os.homedir();
  const usedTilde = prefix === "~" || prefix.startsWith("~/") || prefix.startsWith("~\\");
  let raw = prefix ? expandHome(prefix) : process.cwd() + path.sep;

  let parent: string, partial: string;
  if (raw.endsWith("/") || (process.platform === "win32" && raw.endsWith("\\"))) { parent = raw; partial = ""; }
  else { parent = path.dirname(raw); partial = path.basename(raw); }

  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(parent, { withFileTypes: true }); }
  catch {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
    return;
  }

  const partialLower = partial.toLowerCase();
  const items: Array<{ name: string; description: string }> = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (partial && !e.name.toLowerCase().startsWith(partialLower)) continue;
    let full = path.join(parent, e.name) + path.sep;
    if (usedTilde && full.startsWith(home)) full = "~" + full.slice(home.length);
    items.push({ name: full, description: "" });
    if (items.length >= 50) break;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ items }));
}

async function listFiles(res: http.ServerResponse, session: Session, subdir?: string): Promise<void> {
  let targetDir = session.cwd;
  if (subdir) {
    const root = path.resolve(session.cwd);
    const resolved = path.resolve(session.cwd, subdir);
    // Prevent directory traversal — using relative() is cross-platform safe.
    const rel = path.relative(root, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    targetDir = resolved;
  }
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(targetDir, { withFileTypes: true }); }
  catch {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to read directory" }));
    return;
  }
  const files: Array<{ name: string; size: number; kind: "file" | "dir" }> = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    files.push({ name: e.name, size: 0, kind: e.isDirectory() ? "dir" : "file" });
  }
  // Sort: dirs first, then files; alphabetical within each group.
  files.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ cwd: targetDir, files }));
}

async function deleteSession(sessions: Map<string, Session>, id: string, approvedOperation = false): Promise<void> {
  if (sessions.get(id)?._hostOperation && !approvedOperation) throw new Error("Conversation operation in progress");
  let pending = _pendingDeletes.get(id);
  if (!pending) {
    pending = (async () => {
      // Persist intent before closing anything. Errors keep DELETE retryable,
      // while this marker excludes residual files from restoration.
      await ensureSessionsDir();
      await fs.promises.writeFile(path.join(SESSIONS_DIR, `${id}.deleted`), "deleted\n");
      _deletedIds.add(id);
      const session = sessions.get(id);
      const storeWrites = session?.store?.seal();
      if (session) {
        session.collaboration?.stopSession(session.id);
    session._closing = true;
        session._closed = true;
        session._deletingFiles = true;
        session._cancelRestore?.();
        stopIdleWatchdog(session);
        try { session.bridge?.close(); } catch {}
        for (const r of session.sseClients) { try { r.end(); } catch {} }
        session.sseClients.clear();
        sessions.delete(id);
      }
      const buf = _writeBufs.get(id);
      if (buf?.timer) clearTimeout(buf.timer);
      _writeBufs.delete(id);
      const metaTimer = _metaTimers.get(id);
      if (metaTimer) clearTimeout(metaTimer);
      _metaTimers.delete(id);
      await Promise.allSettled([_writeLocks.get(id), storeWrites, session?.contextLock, _metaLocks.get(id), session?._restorePromise, ...(session?._uploads ?? [])].filter(Boolean));
      await session?.store?.seal();
      await deleteSessionFiles(id);
      _replayOwners.delete(id);
      // Retain only the tiny tombstone; successful DELETE is idempotent.
    })();
    _pendingDeletes.set(id, pending);
    void pending.finally(() => _pendingDeletes.delete(id)).catch(() => {});
  }
  await pending;
}

async function closeSession(res: http.ServerResponse, sessions: Map<string, Session>, id: string): Promise<void> {
  try { await deleteSession(sessions, id); }
  catch (err) { res.writeHead(500); res.end(`delete failed; retry DELETE: ${err instanceof Error ? err.message : err}`); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function updateTitle(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const body = await readBody(req);
  if (session._hostOperation) { res.writeHead(409); res.end("Conversation operation in progress"); return; }
  let title = "";
  try { title = ((JSON.parse(body) as { title?: string }).title ?? "").trim(); } catch {}
  if (!title) { res.statusCode = 400; res.end("empty title"); return; }
  await setSessionTitle(session, title, true);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, title: session.title }));
}

async function generateTitle(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  // Use the stored firstQuery, or accept one from the request body.
  const body = await readBody(req);
  if (session._hostOperation) { res.writeHead(409); res.end("Conversation operation in progress"); return; }
  let query = session.firstQuery?.trim() ?? "";
  try {
    const parsed = JSON.parse(body) as { query?: string };
    if (parsed.query) query = parsed.query.trim();
  } catch {}
  if (!query) { res.statusCode = 400; res.end("no query to generate title from"); return; }
  session.firstQuery = query;

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, generating: true }));

  // Generate asynchronously — the title will arrive via SSE.
  generateTitleAsync(session).catch((err) =>
    console.error(`[hub] generate-title error for ${session.id}:`, err)
  );
}

// subs=A:50,B:0 — sessionId:tail. tail>0 fresh-replays; tail=0 + since
// catches up missed frames via the monotonic id stream.
function permissionReplayFrame(session: Session, frame: string): string {
  if (parseFrameName(frame) !== "permission:request") return frame;
  return frame.replace(/^data: (.+)$/m, (_, json) => {
    const data = JSON.parse(json);
    const entry = session.pendingPermissions?.get(data.payload?.requestId);
    data.payload = { ...data.payload, pending: !!entry && entry.expiresAt > Date.now(), expiresAt: entry?.expiresAt };
    return "data: " + JSON.stringify(data);
  });
}

async function openSseMulti(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessions: Map<string, Session>,
  subsParam: string,
  sinceParam: string,
  mobile = false,
): Promise<void> {
  const subs = subsParam.split(",").map((s) => {
    const [id, tailStr, cursor] = s.split(":");
    const tail = tailStr === "all" ? Infinity : Math.max(0, Number(tailStr ?? "50") || 0);
    return { id: id ?? "", tail, cursor: cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : undefined };
  }).filter((s) => s.id);

  const headerLast = req.headers["last-event-id"];
  const globalSince = Math.max(
    0,
    Number(Array.isArray(headerLast) ? headerLast[0] : headerLast ?? "") || 0,
    Number(sinceParam) || 0,
  );

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Swallow stream errors (e.g. a late write-after-end racing an end(),
  // or a client disconnect mid-replay) — without a listener,
  // errorOrDestroy escalates to an uncaught exception and kills the hub.
  // Attach before ANY writes: replay writes happen after the potentially
  // slow `await session._ensureBridge()`, during which the client may
  // disconnect.
  res.on("error", () => {});
  res.write(`: connected ${subs.length}\n\n`);

  let disconnected = false;
  const attached = new Set<Session>();
  const cleanup = () => {
    disconnected = true;
    for (const session of attached) session.sseClients.delete(res);
    attached.clear();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  await Promise.all(subs.filter((sub, index) => subs.findIndex(other => other.id === sub.id) === index).map(async ({ id, tail, cursor }) => {
    const since = cursor ?? globalSince;
    const session = sessions.get(id);
    if (!session) {
      const errFrame = `id: ${nextFrameId()}\ndata: ${JSON.stringify({ meta: { source: id, ts: Date.now(), name: "ui:error" }, payload: { message: "Session not found." } })}\n\n`;
      try { res.write(errFrame); } catch {}
      const doneMeta = { source: id, ts: Date.now(), name: "hub:replay-done" };
      try { res.write(`id: ${nextFrameId()}\ndata: ${JSON.stringify({ meta: doneMeta })}\n\n`); } catch {}
      return;
    }
    // Send keepalive before potentially-slow _ensureBridge so the
    // client's 500ms safety timer is reset and doesn't fire prematurely.
    if (tail > 0) {
      try { res.write(`id: ${nextFrameId()}\ndata: ${JSON.stringify({ meta: { source: id, ts: Date.now(), name: "hub:replay-starting" } })}\n\n`); } catch { return; }
    }
    // Lazily create bridge + restore session data if needed.
    try {
      await session._ensureBridge?.();
      if (disconnected || res.writableEnded) return;
    } catch (err) {
      console.error(`[hub] _ensureBridge failed for ${id}:`, err);
      const errFrame = `id: ${nextFrameId()}\ndata: ${JSON.stringify({ meta: { source: id, ts: Date.now(), name: "ui:error" }, payload: { message: err instanceof Error ? err.message : "Failed to restore session data." } })}\n\n`;
      try { res.write(errFrame); } catch {}
      // Keep persisted history readable even when the remote backend cannot resume.
    }
    if (disconnected || res.writableEnded || session._closed || session._closing) return;
    if (tail > 0) {
      if (session.hasUnread) { session.hasUnread = false; session._onHostChange?.("read"); }
      // Persist any text emitted since the last flush (an in-flight turn's
      // response-chunks accumulate in segmentText and are NOT in replay) so
      // a client connecting mid-turn sees the partial output instead of an
      // empty turn. Live clients already rendered the chunks and skip the
      // segment frame (hasReply/sawLiveSegment guard in the frontend).
      flushSegment(session);
      const start = mobile ? mobileReplayStart(session.replay) : tail === Infinity ? 0 : Math.max(0, session.replay.length - tail);
      if (mobile) res.write(sseFrame({ source: id, ts: Date.now(), name: "hub:history-window" }, { recent: true, hasEarlier: start > 0 }));
      for (let i = start; i < session.replay.length; i++) {
        try { res.write(permissionReplayFrame(session, mobile ? mobileReplayFrame(session.replay[i]!) : session.replay[i]!)); } catch { return; }
      }
      if (session.lastAgentInfo) {
        const meta = { source: id, ts: Date.now(), id: `hub:${id}:reemit:agent:info`, name: "agent:info" };
        try { res.write(`id: ${nextFrameId()}\ndata: ${JSON.stringify({ meta, payload: session.lastAgentInfo })}\n\n`); } catch { return; }
      }
      for (const [name, payload] of [["session:title", { title: session.title }], ["shell:cwd-change", { cwd: session.cwd }], ["hub:capabilities", { readOnlyContext: !session.bridge || !!session.bridge.readOnlyContext, supportsCwdChange: !!session.bridge?.supportsCwdChange }]] as const) {
        try { res.write(sseFrame({ source: id, ts: Date.now(), name }, payload)); } catch { return; }
      }
      try { res.write(sseFrame({ source: id, ts: Date.now(), name: "agent:request-status" }, session.lastRequestStatus ?? { phase: "clear" })); } catch { return; }
      const doneMeta = { source: id, ts: Date.now(), name: "hub:replay-done" };
      try { res.write(`id: ${nextFrameId()}\ndata: ${JSON.stringify({ meta: doneMeta })}\n\n`); } catch { return; }
    } else if (since > 0) {
      // Only clear hasUnread once this connection has actually received the
      // missed frames — clearing up-front would lose the unread badge if
      // this connection drops before any frame is delivered.
      let sentAny = false;
      const replay = session.replay;
      // Frame ids within a session's replay are strictly increasing (every
      // frame id comes from the single monotonic global frameSeq counter —
      // live pushes, disk-restored files, and synthesizeBranchFrames rebuilds
      // alike), so binary-search the first frame newer than `since` instead
      // of regex-matching all N frames.  A boundary monotonicity check guards
      // the assumption; if it fails, fall back to the old full scan.
      let start: number | null = null;
      if (replay.length > 0) {
        const firstId = replayFrameId(replay[0]!);
        const lastId = replayFrameId(replay[replay.length - 1]!);
        if (firstId !== null && lastId !== null && (replay.length === 1 || lastId > firstId)) {
          let lo = 0, hi = replay.length;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            const id = replayFrameId(replay[mid]!);
            if (id !== null && id > since) hi = mid; else lo = mid + 1;
          }
          start = lo;
        }
      }
      if (start !== null) {
        for (let i = start; i < replay.length; i++) {
          try { res.write(replay[i]!); sentAny = true; } catch { return; }
        }
      } else {
        for (const line of replay) {
          const m = line.match(frameIdRe);
          if (m && Number(m[1]) > since) {
            try { res.write(line); sentAny = true; } catch { return; }
          }
        }
      }
      if (sentAny && session.hasUnread) { session.hasUnread = false; session._onHostChange?.("read"); }
      try { res.write(sseFrame({ source: id, ts: Date.now(), name: "agent:request-status" }, session.lastRequestStatus ?? { phase: "clear" })); } catch { return; }
    }
    if (disconnected || res.writableEnded || session._closed || session._closing) return;
    session.sseClients.add(res);
    attached.add(session);
  }));


}

async function ptyInput(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  if (!session.bridge.writePty) {
    res.statusCode = 400; res.end("session has no PTY"); return;
  }
  const body = await readBody(req);
  if (session._closed || session._closing) { res.statusCode = 409; res.end("session closed"); return; }
  let data = "";
  try { data = (JSON.parse(body) as { data?: string }).data ?? ""; } catch {}
  if (typeof data !== "string") { res.statusCode = 400; res.end("invalid data"); return; }
  try { session.bridge.writePty(data); } catch (err) {
    res.statusCode = 500; res.end(`pty write failed: ${err instanceof Error ? err.message : err}`); return;
  }
  session.lastActivity = Date.now();
  session.lastModified = Date.now();
  session._onHostChange?.('pty-input');
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function ptyResize(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  if (!session.bridge.resizePty) {
    res.statusCode = 400; res.end("session has no PTY"); return;
  }
  const body = await readBody(req);
  let cols = 0, rows = 0;
  try {
    const parsed = JSON.parse(body) as { cols?: number; rows?: number };
    cols = Number(parsed.cols) | 0;
    rows = Number(parsed.rows) | 0;
  } catch {}
  if (cols <= 0 || rows <= 0) { res.statusCode = 400; res.end("invalid size"); return; }
  try { session.bridge.resizePty(cols, rows); } catch (err) {
    res.statusCode = 500; res.end(`pty resize failed: ${err instanceof Error ? err.message : err}`); return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function submit(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const body = await readBody(req);
  let query = "";
  let images: Array<{ data: string; mimeType: string }> | undefined;

  // Parse JSON body
  let parsed: { query?: string; images?: Array<{ data?: string; id?: string; mimeType: string }> };
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    res.statusCode = 400;
    res.end(`invalid JSON: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed.query !== undefined && typeof parsed.query !== "string")) { res.writeHead(400); res.end("invalid query"); return; }
  query = parsed.query ?? "";
  // Image refs carried by the agent:query/agent:queued frames — replay after
  // restart rebuilds the user box from these, so they must reference the
  // persisted uploads/ files by id, not transient base64 data.
  let imageRefs: Array<{ id?: string; data?: string; mimeType: string }> | undefined;
  if (Array.isArray(parsed.images) && parsed.images.length > 0 && session.bridge.supportsImages === false) {
    res.writeHead(409); res.end("This backend does not support image submissions"); return;
  }
  if (Array.isArray(parsed.images) && parsed.images.length > 0) {
    try {
      const resolved = await Promise.all(parsed.images.map(async (img) => {
        if (img.data) {
          // Raw-data fallback (client upload failed): persist now so replay
          // frames can reference the file by id.
          const id = await persistSessionImage(session, img.data, img.mimeType);
          return { image: { data: img.data, mimeType: img.mimeType }, ref: { id, mimeType: img.mimeType } };
        }
        if (img.id) {
          const uploadsDir = path.join(SESSIONS_DIR, "uploads");
          const files = await fs.promises.readdir(uploadsDir);
          const match = files.find((f) => f.startsWith(img.id!));
          if (match) {
            const buf = await fs.promises.readFile(path.join(uploadsDir, match));
            return { image: { data: buf.toString("base64"), mimeType: img.mimeType }, ref: { id: img.id, mimeType: img.mimeType } };
          }
        }
        throw new Error("invalid image ref");
      }));
      images = resolved.map(r => r.image);
      imageRefs = resolved.map(r => r.ref);
    } catch (err) {
      res.statusCode = 400;
      res.end(`invalid images: ${err instanceof Error ? err.message : err}`);
      return;
    }
  }

  if (!query.trim() && (!images || images.length === 0)) { res.statusCode = 400; res.end("empty"); return; }

  try {
    const result = await submitQuery(session, query, images, imageRefs);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result));
  } catch (err) { res.writeHead(409); res.end(String(err)); }
}

async function submitQuery(session: Session, query: string,
  images?: Array<{ data: string; mimeType: string }>,
  imageRefs?: Array<{ id?: string; data?: string; mimeType: string }>,
  beforeSubmit?: () => void,
  taskId?: string,
) {
  const meta = (name: string) => ({
    source: session.id,
    ts: Date.now(),
    id: `hub:${session.id}:${name}`,
    name,
  });

  return withContextLock(session, async () => {
    if (session._hostOperation) throw new Error("Conversation operation in progress");
    beforeSubmit?.();
    if (session._closed || session._closing) { throw new Error("session closed"); }
    if (session._contextBroken) { throw new Error("context recovery required; restart asHub before continuing this session"); }
    if (session.bridge.isProcessing?.() && !session.bridge.supportsQueue) { throw new Error("backend turn already in progress"); }
    // Capture the first user query for auto-title generation.
    const isFirstTurn = !session.firstTurnDone;
    if (isFirstTurn) session.firstQuery = query;

    // Bump lastModified so this session moves to the top of the sidebar.
    session.lastModified = Date.now();

    const queued = !!session.bridge.isProcessing?.();
    const queueId = queued ? randomUUID() : undefined;
    if (queued) {
      (session.queuedQueries ??= []).push(query);
      (session.queuedItems ??= new Map()).set(queueId!, { id: queueId!, query, ...(imageRefs?.length ? { images: imageRefs } : {}) });
    }
    else if (taskId) session.collaboration?.start(taskId);
    if (!queued) {
      session.isProcessing = true;
      session.hasUnread = false;
      session._cancelled = false;
      // A turn that ended in error without a flush leaves stale text in
      // segmentText (see submit()'s catch). Reset here so a fresh turn can
      // never inherit it.
      session.segmentText = "";
      session.segmentStartedAt = undefined;
      pushFrame(session, "agent:query", sseFrame(meta("agent:query"), { query, ...(imageRefs?.length ? { images: imageRefs } : {}) }));
      pushFrame(session, "agent:processing-start", sseFrame(meta("agent:processing-start"), {}));
    }

    // Safety timeout: if no agent activity (chunks, tool events) is seen for
    // the idle window, the agent is considered stuck and we force-push an error.
    // Large reasoning models (DeepSeek v4, o1-pro) can legitimately think for
    // many minutes, so a fixed wall-clock timeout is too aggressive. Instead we
    // use an idle timeout that resets on every activity signal.
    //
    // File-modifying tools (write_file, edit_file) suppress output-chunk events
    // during execution (the diff preview is shown up-front), so tool execution
    // can be a long idle stretch.  When tools are running the idle window is
    // widened to 10 min so large writes don't false-trigger.
    //
    // When the bridge reports isProcessing() but no activity events are seen,
    // we extend the window rather than immediately declaring it stuck (the
    // agent may be waiting on a slow API).  To prevent indefinite hangs, a
    // hard cap of 30 minutes of total idle time forces cancellation regardless.
    //
    // Reset toolsRunning at the start of a non-queued turn so stale counts from
    // a previous turn (e.g. crashed agent, missed tool-completed) don't keep
    // the window artificially wide.
    if (!queued) session.toolsRunning = 0;

    let rejectTimeout: ((err: Error) => void) | undefined;
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    // Only arm the watchdog for the turn actually running now — a queued
    // submit returns immediately, and its watchdog starts on agent:queued-submit
    // (arming it here would clobber the currently-running turn's).
    const wdToken = queued ? undefined : startIdleWatchdog(session, (err) => rejectTimeout!(err));
    const cleanup = () => { if (wdToken !== undefined) stopIdleWatchdog(session, wdToken); };

    // Encode images into submit payload for multimodal models.
    const submitPayload = images && images.length > 0
      ? JSON.stringify({ query, images })
      : query;

    Promise.race([session.bridge.submit(submitPayload, queueId), timeout])
      .then((result) => {
        cleanup();
        if (session._closed || session._closing) return;
        if (result.stopReason === "queued") {
          pushFrame(session, "agent:queued", sseFrame(meta("agent:queued"), { query, queueId, ...(imageRefs?.length ? { images: imageRefs } : {}) }));
          return;
        }
        if (taskId) session.collaboration?.finish(taskId, session._cancelled ? "cancelled" : "completed");
        flushSegment(session);
        session.isProcessing = false;
        // Only mark unread if no one is watching (no active SSE client).
        session.hasUnread = session.sseClients.size === 0;
        pushFrame(session, "agent:processing-done", sseFrame(meta("agent:processing-done"), {}));
        _flushBuf(session.id);
        saveSessionMetaDebounced(session);
        // Flush under the context lock so it can't interleave with an automatic
        // compaction or a rewind/fork replacing the kernel mid-snapshot.
        if (session.capture) {
          withContextLock(session, async () => {
            await session.capture!.flush();
            await tagLastQueryFrame(session);
          }).catch((err) =>
            console.error(`[hub] capture.flush failed for ${session.id}:`, err)
          );
        }

        // After the first turn completes, generate a title via the LLM.
        if (isFirstTurn && !session.firstTurnDone) {
          session.firstTurnDone = true;
          generateTitleAsync(session).catch((err) =>
            console.error(`[hub] auto-title failed for ${session.id}:`, err)
          );
        }
      })
      .catch((err) => {
        if (taskId) session.collaboration?.finish(taskId, "failed", String(err));
        cleanup();
        if (session._closed || session._closing) return;
        if (queueId) {
          session.queuedItems?.delete(queueId);
          const index = session.queuedQueries?.indexOf(query) ?? -1;
          if (index >= 0) session.queuedQueries!.splice(index, 1);
          pushFrame(session, "agent:queued-done", sseFrame(meta("agent:queued-done"), { query, queueId, dropped: true }));
          return;
        }
        // Persist any text the agent emitted before the error so it survives
        // reload/replay — and MUST run before the error frame so the segment
        // renders before the error card. Without it, the leftover text would
        // also bleed into the next turn's first flush (stale segment bug).
        flushSegment(session);
        session.isProcessing = false;
        pushFrame(session, "agent:error", sseFrame(meta("agent:error"), { message: String(err) }));
        void withContextLock(session, async () => { await session.capture?.flush(); await tagLastQueryFrame(session); })
          .catch(e => console.error("[hub] error-turn capture failed:", e));
        _flushBuf(session.id);
        saveSessionMetaDebounced(session);
      });

    return { ok: true, queued, ...(queueId ? { queueId } : {}) };
  });
}

async function setThinking(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  session: Session,
): Promise<void> {
  const body = await readBody(req);
  if (session._hostOperation) { res.writeHead(409); res.end("Conversation operation in progress"); return; }
  let level = "", model: unknown, provider: unknown;
  try {
    const parsed = JSON.parse(body);
    level = typeof parsed.level === "string" ? parsed.level.trim() : "";
    model = parsed.model; provider = parsed.provider;
  } catch {}
  if (!level) { res.statusCode = 400; res.end("missing level"); return; }
  if (!session.bridge.setThinking) { res.statusCode = 501; res.end("bridge does not support setThinking"); return; }
  const current = session.bridge.getThinking?.();
  if (current && ((model !== undefined && model !== current.model) || (provider !== undefined && provider !== current.provider))) {
    res.statusCode = 409; res.end("Model changed; reopen the model picker"); return;
  }
  if (current && (!current.supported || (level !== "default" && !current.levels.includes(level)))) {
    res.statusCode = 400; res.end("Unsupported thinking level for this model"); return;
  }
  try { session.bridge.setThinking(level); } catch (err) {
    res.statusCode = 400; res.end(String(err)); return;
  }
  saveSessionMetaDebounced(session);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, ...session.bridge.getThinking?.() }));
}

async function execCommand(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  session: Session,
): Promise<void> {
  const body = await readBody(req);
  if (session._hostOperation) { res.writeHead(409); res.end("Conversation operation in progress"); return; }
  let name = "", args = "";
  try {
    const parsed = JSON.parse(body) as { name?: string; args?: string };
    name = (parsed.name ?? "").trim();
    args = (parsed.args ?? "").trim();
  } catch {}
  if (!name) { res.statusCode = 400; res.end("missing name"); return; }
  if (!session.bridge.execCommand) {
    res.statusCode = 501; res.end("bridge does not support commands"); return;
  }
  session.lastModified = Date.now();
  // Echo the command into the stream so users see what they ran. Slash output
  // arrives back via ui:info / ui:error frames the bridge already forwards.
  // `command: true` marks the frame as a slash command (not a real turn) so
  // clients skip it when counting turns for rewind — the kernel gets no user
  // message for these, so counting them would misalign rewind-to-turn.
  const meta = (n: string) => ({
    source: session.id, ts: Date.now(),
    id: `hub:${session.id}:${n}`, name: n,
  });
  pushFrame(session, "agent:query", sseFrame(meta("agent:query"), { query: args ? `${name} ${args}` : name, command: true }));
  session._commandsRunning = (session._commandsRunning ?? 0) + 1;
  try { await session.bridge.execCommand(name, args); } catch (err) {
    pushFrame(session, "ui:error", sseFrame(meta("ui:error"), { message: String(err) }), { transient: true });
    res.writeHead(500); res.end(`command failed: ${String(err)}`); return;
  } finally { session._commandsRunning = (session._commandsRunning ?? 1) - 1; }
  saveSessionMetaDebounced(session);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function autocomplete(
  res: http.ServerResponse,
  session: Session,
  buffer: string,
): Promise<void> {
  if (!session.bridge.autocomplete) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
    return;
  }
  try {
    const items = (await session.bridge.autocomplete(buffer)) ?? [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items }));
  } catch (err) {
    res.statusCode = 500;
    res.end(`autocomplete failed: ${err instanceof Error ? err.message : err}`);
  }
}

function contextFromReplay(session: Session): ContextSnapshot {
  const messages: Array<{ role: string; content: unknown }> = [];
  for (const frame of session.replay) {
    try {
      const line = frame.split("\n").find(l => l.startsWith("data: "));
      if (!line) continue;
      const { meta, payload: p } = JSON.parse(line.slice(6));
      if (meta?.name === "agent:query" && !p?.command) {
        messages.push({ role: "user", content: p?.query ?? "" });
      } else if (meta?.name === "agent:response-segment" && p?.text) {
        messages.push({ role: "assistant", content: p.text });
      } else if (meta?.name === "agent:tool-completed") {
        messages.push({ role: "tool", content: typeof p?.output === "string" ? p.output : JSON.stringify(p) });
      }
    } catch {}
  }
  if (session.segmentText) messages.push({ role: "assistant", content: session.segmentText });
  return { messages, contextWindow: 0, activeTokens: 0, readOnly: true };
}

function contextRevision(session: Session, messages: unknown[]): string {
  return createHash("sha256").update(JSON.stringify([session.store?.getActiveLeaf() ?? null, messages])).digest("hex");
}

function requireContextRevision(session: Session, messages: unknown[], revision: unknown): void {
  if (typeof revision !== "string" || revision !== contextRevision(session, messages)) {
    throw new ContextBusyError("Context changed; refresh before changing messages");
  }
}

async function getContext(res: http.ServerResponse, session: Session): Promise<void> {
  try {
    const { snap, revision } = await withContextLock(session, async () => {
      const snap = !session.bridge || session.bridge.readOnlyContext
        ? contextFromReplay(session) : await session.bridge.snapshot();
      return { snap, revision: contextRevision(session, snap.messages) };
    });
    // Tag system notes for the UI so panels/export can hide them. Use a
    // shallow copy — never mutate kernel messages — and keep the array
    // order/int indices untouched: drop/rewind rely on exact alignment.
    snap.messages = snap.messages.map((m) =>
      isSystemNoteMessage(m) ? { ...(m as object), systemNote: true } : m
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...snap, revision }));
  } catch (err) {
    res.statusCode = 500;
    res.end(`snapshot failed: ${err instanceof Error ? err.message : err}`);
  }
}

function getBranchEntries(session: Session): Array<{ id: string; type: string; parentId: string | null; timestamp: number; preview: string; role?: string; summary?: string; systemNote?: boolean }> | null {
  if (!session.store) return null;
  const branch = session.store.getBranch();
  return branch.map((e) => {
    if (e.type === "session") {
      return { id: e.id, type: e.type, parentId: e.parentId, timestamp: e.timestamp, preview: `[session ${e.id} cwd=${e.cwd}]` };
    }
    if (e.type === "compaction") {
      return { id: e.id, type: e.type, parentId: e.parentId, timestamp: e.timestamp, preview: `[compacted — firstKept ${e.firstKeptId.slice(0, 6)}]`, firstKeptId: e.firstKeptId };
    }
    const text = extractText(e.message.content);
    const display = e.message.role === "user" ? stripContextWrappers(text) : text;
    return {
      id: e.id, type: e.type, parentId: e.parentId, timestamp: e.timestamp,
      role: e.message.role,
      // Mark system notes (legacy persisted project-skills messages) so the
      // tree panel can render them as structural but invisible nodes.
      systemNote: isSystemNoteMessage(e.message) || undefined,
      preview: snippet(display, 80),
    };
  });
}

// The frontend re-fetches the branch after every turn; spawning a git child
// process each time is wasteful, so cache per cwd with a short TTL.  The
// branch changing mid-TTL just means the badge lags a few seconds.
const GIT_BRANCH_CACHE_TTL_MS = 5_000;
const _gitBranchCache = new Map<string, { branch: string | null; ts: number }>();

function gitBranchEndpoint(res: http.ServerResponse, session: Session): void {
  res.setHeader("Content-Type", "application/json");
  const cached = _gitBranchCache.get(session.cwd);
  if (cached && Date.now() - cached.ts < GIT_BRANCH_CACHE_TTL_MS) {
    res.end(JSON.stringify({ branch: cached.branch }));
    return;
  }
  execFile("git", ["-C", session.cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 1000 }, (err, stdout) => {
    const trimmed = err ? "" : stdout.toString().trim();
    const branch = trimmed && trimmed !== "HEAD" ? trimmed : null;
    // Bound the map — cwds are few, but closed sessions would linger.
    if (_gitBranchCache.size > 500) _gitBranchCache.clear();
    _gitBranchCache.set(session.cwd, { branch, ts: Date.now() });
    res.end(JSON.stringify({ branch }));
  });
}

async function branchEndpoint(res: http.ServerResponse, session: Session): Promise<void> {
  const entries = getBranchEntries(session);
  if (!entries) { res.statusCode = 409; res.end("session has no tree store"); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ leafId: session.store!.getActiveLeaf(), entries }));
}

async function treeEndpoint(res: http.ServerResponse, session: Session): Promise<void> {
  if (!session.store) { res.statusCode = 409; res.end("session has no tree store"); return; }
  const all = session.store.getAllEntries().map((e) => {
    if (e.type === "session") return { id: e.id, type: e.type, parentId: e.parentId, timestamp: e.timestamp };
    if (e.type === "compaction") return { id: e.id, type: e.type, parentId: e.parentId, timestamp: e.timestamp, firstKeptId: e.firstKeptId };
    const text = extractText(e.message.content);
    const display = e.message.role === "user" ? stripContextWrappers(text) : text;
    return { id: e.id, type: e.type, parentId: e.parentId, timestamp: e.timestamp, role: e.message.role, systemNote: isSystemNoteMessage(e.message) || undefined, preview: snippet(display, 80) };
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ leafId: session.store.getActiveLeaf(), rootId: session.store.getRootId(), entries: all }));
}

async function setModelEndpoint(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const body = await readBody(req);
  let model: string;
  let provider: string | undefined;
  try {
    const parsed = JSON.parse(body) as { model?: unknown; provider?: unknown };
    if (typeof parsed.model !== "string" || !parsed.model) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid model" }));
      return;
    }
    model = parsed.model;
    provider = typeof parsed.provider === "string" ? parsed.provider : undefined;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON" }));
    return;
  }

  if (!session.bridge.execCommand) {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "session does not support model switching" }));
    return;
  }

  const target = provider ? `${model}@${provider}` : model;
  try { await session.bridge.execCommand("/model", target); }
  catch (err) { res.writeHead(500); res.end(`model switch failed: ${String(err)}`); return; }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, model, provider }));
}

async function forkEndpoint(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  if (!session.store || !session.capture) { res.statusCode = 409; res.end("session has no tree store"); return; }
  if (session.isProcessing) { res.statusCode = 409; res.end("cannot switch branches while a turn is in progress"); return; }
  const body = await readBody(req);
  let entryId: string | undefined;
  let idPrefix: string | undefined;
  try {
    const parsed = JSON.parse(body) as { entryId?: string; idPrefix?: string };
    entryId = parsed.entryId;
    idPrefix = parsed.idPrefix;
  } catch {
    res.statusCode = 400; res.end("invalid body"); return;
  }
  const resolved = resolveEntryId(session, entryId, idPrefix);
  if (!resolved) { res.statusCode = 404; res.end("entry not found or prefix ambiguous"); return; }
  try {
    await withIdleContextLock(session, async () => {
      // Apply the target branch BEFORE moving the active leaf: if the kernel
      // replace fails, the leaf must still point at the branch the kernel and
      // capture actually contain, or the next turn's messages would be
      // recorded under a leaf whose context was never loaded.
      await applyBranchMessages(session, resolved);

    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, leafId: resolved }));
  } catch (err) {
    res.statusCode = err instanceof ContextBusyError ? 409 : 500;
    res.end(`fork failed: ${err instanceof Error ? err.message : err}`);
  }
}
async function setCwdEndpoint(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const body = await readBody(req);
  if (session._hostOperation) { res.writeHead(409); res.end("Conversation operation in progress"); return; }
  let cwd: string;
  try { cwd = JSON.parse(body).cwd; } catch { res.statusCode = 400; res.end("invalid body"); return; }
  if (!cwd || typeof cwd !== "string") { res.statusCode = 400; res.end("missing cwd"); return; }
  if (!session.bridge?.supportsCwdChange || !session.bridge.relayEvent) { res.writeHead(409); res.end("backend does not support changing cwd"); return; }
  try { if (!path.isAbsolute(cwd) || !(await fs.promises.stat(cwd)).isDirectory()) throw new Error(); }
  catch { res.writeHead(400); res.end("cwd must be an existing absolute directory"); return; }
  try {
    await withIdleContextLock(session, async () => {
      session.bridge.relayEvent!("shell:cwd-change", { cwd });
      session.cwd = cwd;
      await saveSessionMeta(session);
    });
  } catch (err) { res.writeHead(err instanceof ContextBusyError ? 409 : 500); res.end(String(err)); return; }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}


async function dropContext(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  if (session.isProcessing) { res.statusCode = 409; res.end("cannot switch branches while a turn is in progress"); return; }
  const body = await readBody(req);
  let indices: number[];
  let revision: unknown;
  try {
    const parsed = JSON.parse(body) as { indices?: number[]; revision?: unknown };
    revision = parsed.revision;
    indices = Array.isArray(parsed.indices) ? parsed.indices : [];
  } catch {
    res.statusCode = 400; res.end("invalid body"); return;
  }
  if (indices.length === 0) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stats: null }));
    return;
  }
  try {
    const stats = await withIdleContextLock(session, async () => {
      const snap = await session.bridge.snapshot();
      requireContextRevision(session, snap.messages, revision);
      if (indices.some(i => !Number.isInteger(i) || i < 0 || i >= snap.messages.length)) throw new TypeError("invalid message index");
      const drop = new Set(indices);
      const { kept, originalIndices } = buildKeptWithPlaceholders(snap.messages, drop);
      const keptEntryIds = session.capture
        ? originalIndices.map((i) => i === null ? null : session.capture!.getEntryIdAt(i))
        : null;
      const wire = (keptEntryIds ? tagMessagesWithEntryIds(kept, keptEntryIds) : kept).map((m, i) => {
        const message = m as { role?: string; meta?: Record<string, unknown> };
        return keptEntryIds?.[i] === null && message.role === "user" && !isSystemNoteMessage(m)
          ? { ...message, meta: { ...message.meta, hubPlaceholder: true } } : m;
      });
      const result = await contextTransaction(session, async () => {
        const result = await session.bridge.compact({ kind: "replace", messages: wire });
        if (session.capture && session.store) {
          const sanitized = await session.bridge.snapshot();
          const messages = sanitized.messages.filter(m => !isSystemNoteMessage(m as AgentMessage));
          const ids = await session.store.appendMessages(messages as AgentMessage[], session.store.getRootId());
          if (!ids.length) session.store.setActiveLeaf(session.store.getRootId());
          let i = 0;
          session.capture.resetTo(sanitized.messages.map(m => isSystemNoteMessage(m as AgentMessage) ? null : ids[i++]!));
        }
        return result;
      });
      // Full rebuild + broadcast (like fork) so every connected client drops
      // the elided content, not just the tab that issued the request.
      await rebuildReplayFromKernel(session);
      return result;
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stats }));
  } catch (err) {
    res.statusCode = err instanceof ContextBusyError ? 409 : 500;
    res.end(`drop failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Group consecutive dropped indices into runs and replace each run with a
 * single synthetic user-role placeholder summarizing what was elided. This
 * preserves chronology — the agent sees `[older] [placeholder] [newer]`
 * instead of a silent gap or a misleading front-prepended history block.
 */
function buildKeptWithPlaceholders(messages: unknown[], drop: Set<number>): { kept: unknown[]; originalIndices: (number | null)[] } {
  const kept: unknown[] = [];
  const originalIndices: (number | null)[] = [];
  let i = 0;
  while (i < messages.length) {
    if (!drop.has(i)) { kept.push(messages[i]); originalIndices.push(i); i++; continue; }
    const run: unknown[] = [];
    while (i < messages.length && drop.has(i)) { run.push(messages[i]); i++; }
    kept.push(makePlaceholder(run));
    originalIndices.push(null);
  }
  return { kept, originalIndices };
}

function isContextPlaceholder(message: unknown): boolean {
  return (message as { meta?: { hubPlaceholder?: boolean } })?.meta?.hubPlaceholder === true;
}

function makePlaceholder(dropped: unknown[]): { role: "user"; content: string; meta: { hubPlaceholder: true } } {
  const lines = dropped.map((m) => `- ${summarizeMessage(m)}`);
  return {
    role: "user",
    content: `[${dropped.length} message(s) elided]\n${lines.join("\n")}`,
    meta: { hubPlaceholder: true },
  };
}

/**
 * Rebuild and broadcast the replay from the live kernel after a context
 * mutation (rewind / drop), so every connected client sees the same state.
 */
async function rebuildReplayFromKernel(session: Session): Promise<void> {
  const snap = await session.bridge.snapshot();
  // Prefer capture's slot mapping over meta tags: messages appended by normal
  // turns after the last replace carry no meta.treeEntryId in the kernel, but
  // capture holds real entry ids for them — tag-based detection would render
  // those real turns as compaction markers.
  const entryIds = session.capture
    ? snap.messages.map((_, i) => session.capture!.getEntryIdAt(i))
    : readEntryIdTags(snap.messages);
  await rebuildReplay(session, snap.messages, entryIds);
}

class ContextBusyError extends Error {}
function withIdleContextLock<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  return withContextLock(session, async () => {
    if (session._hostOperation) throw new ContextBusyError("Conversation operation in progress");
    if (session._closing || session._closed) throw new ContextBusyError("session closing");
    if (session._contextBroken) throw new ContextBusyError("context recovery required; restart asHub before continuing this session");
    if (session.bridge.readOnlyContext) throw new ContextBusyError("backend context is read-only");
    if (session.isProcessing || session.bridge?.isProcessing?.()) throw new ContextBusyError("turn in progress");
    return fn();
  });
}

function withContextLock<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  const prev = session.contextLock;
  let release!: () => void;
  session.contextLock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(release);
}

/**
 * Resolve the tree leaf for a rewind target WITHOUT mutating anything.
 * Callers validate through this before touching the kernel so a synthetic
 * target slot fails fast instead of leaving kernel and tree out of sync.
 */
function resolveRewindLeaf(session: Session, newLength: number): string {
  if (!session.store || !session.capture) throw new Error("tree store not attached");
  if (newLength <= 0) return session.store.getRootId();
  // Walk back past invisible slots (system-note placeholders have a null
  // entry id and cannot be a tree leaf) to the last persisted entry.
  for (let i = newLength - 1; i >= 0; i--) {
    const leafId = session.capture.getEntryIdAt(i);
    if (leafId) return leafId;
  }
  // Every slot up to the target is a null placeholder (a compaction summary
  // and/or system notes).  The correct leaf is the entry just before the last
  // compaction — the last evicted message — not the root.  Returning the root
  // would orphan the pre-compaction history, so the next append/rebuild would
  // silently drop the evicted context ("rewind jumped back to the root node").
  const branch = session.store.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i]!;
    if (e.type === "compaction") return e.parentId;
  }
  return session.store.getRootId();
}

async function syncTreeAfterRewind(session: Session, newLength: number): Promise<void> {
  if (!session.store || !session.capture) return;
  const leafId = resolveRewindLeaf(session, newLength);
  session.store.setActiveLeaf(leafId);
  if (newLength <= 0) session.capture.resetTo([]);
  else session.capture.truncateTo(newLength);
}

/**
 * After a turn's capture.flush(), the user message that opened the turn has
 * a real tree entry id.  Broadcast it as an agent:query-tagged frame so
 * clients can address rewind targets by stable entryId instead of by
 * client-counted turn number (which drifts whenever the replay window is
 * truncated).  The replay file stays append-only (original query frame +
 * tag frame); the IN-MEMORY copy of the query frame is additionally patched
 * to carry the entryId, which keeps this scan from re-tagging frames on
 * later flushes and lets full-file rewrites persist the id inline.
 *
 * Queued turns finish back-to-back, so several query frames may be awaiting
 * a tag when one flush lands — tag them all.  Matching is by query text
 * against the kernel's real user messages (newest first): a turn that died
 * before reaching the kernel has no message and is dropped after
 * MAX_TAG_ATTEMPTS flushes; unaddressed frames cannot rewind from the UI.
 *
 * Scanning is incremental: _tagScanIdx watermarks the replay so each frame
 * is classified exactly once, instead of re-parsing the whole tail (down to
 * the last tagged query) on every turn-end flush.
 */
const MAX_TAG_ATTEMPTS = 3;

/** Migrate a complete, verifiable legacy replay before sending it to clients.
 * Position and existing IDs disambiguate identical queries. If the sequences
 * differ (e.g. an uncaptured failed turn), leave the replay untouched. */
function migrateLegacyQueryTags(session: Session): boolean {
  if (!session.store || session.backendId === "acp") return false;
  const { messages, entryIds } = session.store.buildBranchWithIds();
  const visibleUsers = messages.flatMap((message, i) => message.role === "user" && !isSystemNoteMessage(message) && entryIds[i]
    ? [{ query: stripContextWrappers(extractText(message.content)).trim(), entryId: entryIds[i]! }] : []);
  const queries: Array<{ index: number; line: number; lines: string[]; data: { payload: { query?: unknown; command?: boolean; entryId?: string } } }> = [];
  for (let index = 0; index < session.replay.length; index++) {
    const frame = session.replay[index]!;
    if (parseFrameName(frame) !== "agent:query") continue;
    const lines = frame.split("\n");
    const line = lines.findIndex(l => l.startsWith("data: "));
    if (line < 0) return false;
    try {
      const data = JSON.parse(lines[line]!.slice(6));
      if (data.payload?.command === true) continue;
      if (typeof data.payload?.query !== "string") return false;
      queries.push({ index, line, lines, data });
    } catch { return false; }
  }
  if (!queries.some(q => !q.data.payload.entryId)) return false;
  // Older rich replays may include the full pre-compaction conversation.
  const fullUsers = session.store.getBranch().flatMap(entry => entry.type === "message"
    && entry.message.role === "user" && !isSystemNoteMessage(entry.message)
    ? [{ query: stripContextWrappers(extractText(entry.message.content)).trim(), entryId: entry.id }] : []);
  const users = [visibleUsers, fullUsers].find(candidate => queries.length === candidate.length
    && queries.every((q, i) => (q.data.payload.query as string).trim() === candidate[i]!.query
      && (!q.data.payload.entryId || q.data.payload.entryId === candidate[i]!.entryId)));
  if (!users) return false;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i]!;
    if (q.data.payload.entryId) continue;
    q.data.payload.entryId = users[i]!.entryId;
    q.lines[q.line] = "data: " + JSON.stringify(q.data);
    session.replay[q.index] = q.lines.join("\n");
  }
  return true;
}

async function tagLastQueryFrame(session: Session): Promise<void> {
  if (!session.capture || session._closed) return;
  if (session._tagScanIdx === undefined) {
    // First scan for this session (fresh restore / replay just loaded):
    // one legacy backward pass establishes the settled boundary — everything
    // at or below the newest already-tagged query frame (or the first
    // unparseable one) is addressed and never re-examined.
    let floor = 0;
    for (let i = session.replay.length - 1; i >= 0; i--) {
      const f = session.replay[i]!;
      if (parseFrameName(f) !== "agent:query") continue;
      const dataLine = f.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) { floor = i + 1; break; }
      try {
        const inner = JSON.parse(dataLine.slice("data: ".length));
        if (inner?.payload?.command === true) continue;
        if (inner?.payload?.entryId) { floor = i + 1; break; }
      } catch { floor = i + 1; break; }
    }
    session._tagScanIdx = floor;
    session._tagPending = [];
  }
  // Classify only frames appended since the last scan.
  for (let i = session._tagScanIdx; i < session.replay.length; i++) {
    const f = session.replay[i]!;
    if (parseFrameName(f) !== "agent:query") continue;
    const dataLine = f.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    try {
      const inner = JSON.parse(dataLine.slice("data: ".length));
      if (inner?.payload?.command === true) continue;
      if (inner?.payload?.entryId) continue; // already addressed
      session._tagPending!.unshift({
        idx: i,
        query: typeof inner?.payload?.query === "string" ? inner.payload.query : "",
        attempts: 0,
      });
    } catch { continue; }
  }
  session._tagScanIdx = session.replay.length;
  const pending = session._tagPending!;
  if (pending.length === 0) return;
  // Backends without snapshot support (ACP) can't be tagged — their rewind
  // remains unavailable in the UI. Bail quietly instead of throwing
  // into the caller's "capture.flush failed" catch-log every single turn —
  // but still age the pendings out, or they would be re-matched (and their
  // frames re-parsed) on every turn-end flush forever.
  let snap: ContextSnapshot;
  try {
    snap = await session.bridge.snapshot({ skipTokens: true });
  } catch {
    session._tagPending = pending.filter((p) => ++p.attempts < MAX_TAG_ATTEMPTS);
    return;
  }
  const msgs = snap.messages as Array<{ role?: string; content?: unknown }>;
  const claimedIds = new Set<string>();
  for (const frame of session.replay) {
    if (parseFrameName(frame) !== "agent:query") continue;
    try {
      const line = frame.split("\n").find(l => l.startsWith("data: "));
      const payload = line ? JSON.parse(line.slice(6)).payload : undefined;
      if (typeof payload?.entryId === "string") claimedIds.add(payload.entryId);
    } catch { /* malformed legacy frame cannot claim an ID */ }
  }
  const used = new Set<number>();
  const tags: Array<{ idx: number; query: string; entryId: string }> = [];
  const matched = new Set<number>();
  for (const p of pending) {
    // Newest available matching kernel message: both sequences are
    // chronological, so newest-frame ↔ newest-message keeps duplicate
    // queries paired in order.
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (used.has(i)) continue;
      const m = msgs[i]!;
      if (m.role !== "user" || isSystemNoteMessage(m)) continue;
      const entryId = session.capture.getEntryIdAt(i);
      if (!entryId || claimedIds.has(entryId)) continue;
      // Normalize before comparing: kernel user messages may carry a
      // <query_context> wrapper (shell_events injection) or arrive as a
      // multimodal content array (image parts join as empty strings,
      // leaving stray spaces) — strict equality would never match those
      // turns, silently keeping them on the legacy turn-number rewind.
      if (stripContextWrappers(extractText(m.content)).trim() !== p.query.trim()) continue;
      used.add(i);
      claimedIds.add(entryId);
      matched.add(p.idx);
      tags.push({ ...p, entryId });
      break;
    }
  }
  // Retry bookkeeping: matched frames leave the list; unmatched ones age
  // out after MAX_TAG_ATTEMPTS flushes so a turn that never reached the
  // kernel stops being re-matched (and its frame re-parsed) forever.
  session._tagPending = pending.filter((p) => {
    if (matched.has(p.idx)) return false;
    return ++p.attempts < MAX_TAG_ATTEMPTS;
  });
  // Process oldest first so clients pairing tags to boxes in stream order
  // stay consistent for identical consecutive queries.
  for (const { idx, query, entryId } of tags.reverse()) {
    // Patch the in-memory frame (same SSE id, entryId added to payload).
    // Verify frame identity first: pushTransientFrame evictions adjust the
    // watermark/pending indices on splice, but a belt-and-braces check here
    // guarantees a stale idx can never stamp an entryId onto an unrelated
    // frame (which would rewind the user to the wrong tree node).
    const f = session.replay[idx];
    if (f === undefined || parseFrameName(f) !== "agent:query") continue;
    const dataLine = f.split("\n").find((l) => l.startsWith("data: "));
    let queryId: string | undefined;
    if (dataLine) {
      let queryMatches = false;
      try {
        const inner = JSON.parse(dataLine.slice("data: ".length));
        const frameQuery = typeof inner?.payload?.query === "string" ? inner.payload.query : "";
        if (frameQuery.trim() === query.trim()) {
          queryMatches = true;
          const frameId = replayFrameId(f);
          queryId = inner.payload?.queryId ?? (frameId === null ? undefined : String(frameId));
          inner.payload = { ...inner.payload, entryId, queryId };
          const idLine = f.split("\n").find((l) => l.startsWith("id: "));
          session.replay[idx] = `${idLine ?? ""}\ndata: ${JSON.stringify(inner)}\n\n`;
        }
      } catch { /* leave frame as-is; the tag frame below still covers it */ }
      // Wrong frame at this index (a splice shifted the array after the
      // match) — drop the tag entirely rather than risk pairing it to a
      // different query client-side.
      if (!queryMatches) continue;
    }
    pushFrame(session, "agent:query-tagged", sseFrame({
      source: session.id,
      ts: Date.now(),
      id: `hub:${session.id}:agent:query-tagged`,
      name: "agent:query-tagged",
    }, { query, entryId, queryId }));
  }
}

function synthesizeBranchFrames(
  session: Session,
  messages: unknown[],
  entryIds: (string | null)[] = [],
): string[] {
  const frames: string[] = [];
  let seq = 0;
  const meta = (name: string) => ({
    source: session.id,
    ts: Date.now(),
    id: `hub:${session.id}:branch:${seq++}`,
    name,
  });
  frames.push(sseFrame(meta("hub:branch-switched"), {}));
  frames.push(sseFrame(meta("session:title"), { title: session.title }));

  type Msg = {
    role?: string;
    content?: unknown;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    tool_call_id?: string;
  };
  const msgs = messages as Msg[];
  let turnStarted = false;
  // A null entryId slot only marks a compaction summary when the tag system
  // is actually in use. Sessions without a tree store report all-null tags,
  // and their user messages are real messages, not summaries.
  const hasEntryIdTags = entryIds.some((id) => id !== null);

  const closeTurn = () => {
    if (!turnStarted) return;
    frames.push(sseFrame(meta("agent:response-done"), {}));
    frames.push(sseFrame(meta("agent:processing-done"), {}));
    turnStarted = false;
  };

  for (let idx = 0; idx < msgs.length; idx++) {
    const m = msgs[idx]!;
    // System notes are invisible to the UI — never synthesize a user turn
    // or a compaction marker for them (a note carries a null entry-id
    // placeholder in new sessions and would otherwise match the marker
    // branch below).
    if (isSystemNoteMessage(m)) continue;
    if (((hasEntryIdTags && entryIds[idx] === null) || isContextPlaceholder(m)) && m.role === "user" && typeof m.content === "string") {
      closeTurn();
      const evictedCount = parseEvictedCount(m.content);
      frames.push(sseFrame(meta("hub:compaction-marker"), { evictedCount, summary: m.content }));
      continue;
    }
    if (m.role === "user") {
      closeTurn();
      const images = extractImages(m.content);
      const payload: Record<string, unknown> = { query: extractText(m.content) };
      if (images.length > 0) payload.images = images;
      // Stable rewind address: the tree entry this message is persisted
      // under.  Clients prefer it over the volatile client-counted turn.
      if (entryIds[idx]) payload.entryId = entryIds[idx];
      frames.push(sseFrame(meta("agent:query"), payload));
      frames.push(sseFrame(meta("agent:processing-start"), {}));
      turnStarted = true;
      continue;
    }
    if (m.role === "assistant") {
      const text = extractText(m.content);
      if (text) frames.push(sseFrame(meta("agent:response-segment"), { text }));
      const tcs = m.tool_calls;
      if (tcs && tcs.length > 0) {
        const groups = [{
          kind: "execute",
          tools: tcs.map((tc) => ({ name: tc.function?.name ?? "tool" })),
        }];
        frames.push(sseFrame(meta("agent:tool-batch"), { groups }));
        for (let i = 0; i < tcs.length; i++) {
          const tc = tcs[i]!;
          let rawInput: unknown = undefined;
          try { rawInput = tc.function?.arguments ? JSON.parse(tc.function.arguments) : undefined; } catch {}
          frames.push(sseFrame(meta("agent:tool-started"), {
            name: tc.function?.name ?? "tool",
            title: tc.function?.name ?? "tool",
            toolCallId: tc.id,
            kind: "execute",
            rawInput,
            batchIndex: i,
            batchTotal: tcs.length,
          }));
        }
      }
      continue;
    }
    if (m.role === "tool") {
      const content = typeof m.content === "string" ? m.content : extractText(m.content);
      frames.push(sseFrame(meta("agent:tool-completed"), {
        toolCallId: m.tool_call_id,
        exitCode: inferToolExitCode(content),
        rawOutput: content,
        kind: "execute",
      }));
      continue;
    }
  }
  closeTurn();
  return frames;
}

/**
 * Infer a tool call's exit code from its persisted result content so branch
 * rebuilds (fork/rewind/compaction) keep failure marks instead of rendering
 * every historical tool call as ✓ success.
 *
 * agent-sh persists tool results as plain content: every failed call gets a
 * canonical "Error: " prefix (see agent-sh tool-protocol.ts recordResults
 * AND every built-in tool's error returns — e.g. `Error: old_text not
 * found…`).  The structured exitCode/isError fields never reach the
 * persisted message.  Bash output itself does NOT carry an "exit N" line
 * (executor.ts keeps the code out of `output`), so prefix sniffing is the
 * only reliable signal.
 */
function inferToolExitCode(content: string): number {
  return /^Error: /.test(String(content ?? "").trimStart()) ? 1 : 0;
}

async function rebuildReplay(
  session: Session,
  messages: unknown[],
  entryIds: (string | null)[] = [],
): Promise<void> {
  // Session closed (e.g. compaction hook fired after close): skip —
  // persisting rebuilt frames would recreate the deleted replay file.
  if (session._closed) return;
  // No frame cap here either (see pushFrame): the rebuilt replay is the
  // complete current branch, and truncating it would re-introduce the
  // history loss this rebuild is meant to avoid.
  const frames = synthesizeBranchFrames(session, messages, entryIds);
  session.replay = frames;
  session.segmentText = "";
  session.segmentStartedAt = undefined;
  session.segmentSeq = 0;
  // The replay array was replaced wholesale — the transient-frame FIFO's
  // references are no longer in it, so reset the accounting.
  session._transientFrames = [];
  session._transientSize = 0;
  // Rebuilt frames carry their entryIds inline (or were deliberately left
  // untagged by the rebuild), so tagLastQueryFrame treats them as settled:
  // only frames pushed after this rebuild are tag candidates.
  session._tagScanIdx = frames.length;
  session._tagPending = [];
  for (const r of session.sseClients) {
    if (r.writableEnded) continue;
    for (const f of frames) { try { r.write(f); } catch {} }
  }
  // Terminal marker so clients can mount the rebuilt batch atomically.
  // Mirrors openSseMulti's replay-done: broadcast-only, never buffered or
  // persisted (the name is deliberately not in REPLAY_NAMES).
  pushFrame(session, "hub:replay-done", sseFrame({ source: session.id, ts: Date.now(), name: "hub:replay-done" }, {}));
  await persistReplayFile(session.id, frames);
}

/** The idle context lock is held throughout; failed durable commits restore
 * the kernel and capture. If rollback itself fails, refuse further writes. */
async function contextTransaction<T>(session: Session, operation: () => Promise<T>): Promise<T> {
  const old = await session.bridge.snapshot();
  const leaf = session.store?.getActiveLeaf();
  const ids = session.capture ? old.messages.map((_, i) => session.capture!.getEntryIdAt(i)) : [];
  try { return await operation(); }
  catch (err) {
    try {
      await session.bridge.compact({ kind: "replace", messages: old.messages });
      if (leaf && session.store?.getActiveLeaf() !== leaf) session.store!.setActiveLeaf(leaf);
      session.capture?.resetTo(ids);
    } catch (rollbackError) {
      session._contextBroken = true;
      console.error("[hub] context rollback failed:", rollbackError);
    }
    throw err;
  }
}

async function applyBranchMessages(session: Session, leafId?: string): Promise<void> {
  if (!session.store || !session.capture) throw new Error("tree store not attached");
  await contextTransaction(session, async () => {
    const { messages, entryIds } = session.store!.buildBranchWithIds(leafId);
    await session.bridge.compact({ kind: "replace", messages: tagMessagesWithEntryIds(messages, entryIds) });
    const sanitized = await session.bridge.snapshot();
    session.store!.setActiveLeaf(leafId ?? session.store!.getActiveLeaf());
    session.capture!.resetTo(readEntryIdTags(sanitized.messages));
  });
  await rebuildReplayFromKernel(session);

}

function parseEvictedCount(summary: string): number {
  const m = summary.match(/(\d+)\s+message\(s\)\s+elided/);
  return m ? Number(m[1]) : 0;
}

function resolveEntryId(session: Session, entryId?: string, idPrefix?: string): string | null {
  if (!session.store) return null;
  if (entryId) {
    return session.store.getEntry(entryId) ? entryId : null;
  }
  if (idPrefix) {
    const matches = session.store.getAllEntries().filter((e) => e.id.startsWith(idPrefix));
    if (matches.length === 1) return matches[0]!.id;
  }
  return null;
}

// Anchored on a known turn count rather than a post-compact snapshot.
// Legacy sessions whose snapshot disagrees with the replay's agent:query
// count would otherwise wipe surviving turns.
function truncateReplayToTurnCount(session: Session, keepCount: number): void {
  // A turn still in flight owns the replay tail: its agent:query frame is
  // already pushed while the kernel message may not be captured yet, so
  // truncating here would irreversibly cut a REAL turn from replay.
  // Wait for the turn to settle — a later rewind will re-run this path.
  if (session.isProcessing) return;
  // Slash commands also emit agent:query frames (payload.command === true)
  // but are not real turns — exclude them from the count.
  const isRealTurnQuery = (f: string): boolean => {
    if (parseFrameName(f) !== "agent:query") return false;
    const dataLine = f.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) return true;
    try {
      const inner = JSON.parse(dataLine.slice("data: ".length));
      return inner?.payload?.command !== true;
    } catch { return true; }
  };
  const replayQueryCount = session.replay.reduce(
    (n, f) => n + (isRealTurnQuery(f) ? 1 : 0),
    0,
  );
  if (keepCount > replayQueryCount) return;
  let agentQueryCount = 0;
  let truncateAt = session.replay.length;
  for (let i = 0; i < session.replay.length; i++) {
    if (isRealTurnQuery(session.replay[i]!)) {
      if (agentQueryCount >= keepCount) { truncateAt = i; break; }
      agentQueryCount++;
    }
  }
  if (truncateAt < session.replay.length) {
    session.replay.length = truncateAt;
    // Frames past truncateAt are gone: clamp the tag watermark so a new
    // turn's query frame is scannable again, and drop pending indices that
    // now point past the end (an out-of-range idx would crash the tag patch
    // loop on undefined).  Mirrors rebuildReplay's reset semantics.
    if (session._tagScanIdx !== undefined && session._tagScanIdx > truncateAt) {
      session._tagScanIdx = truncateAt;
    }
    if (session._tagPending?.length) {
      session._tagPending = session._tagPending.filter((p) => p.idx < truncateAt);
    }
    void persistReplayFile(session.id, session.replay).catch(() => {});
  }
}

async function rewindContext(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  if (session.isProcessing) { res.statusCode = 409; res.end("cannot switch branches while a turn is in progress"); return; }
  const body = await readBody(req);
  let toIndex: number;
  let revision: unknown;
  try {
    const parsed = JSON.parse(body) as { toIndex?: number; revision?: unknown };
    revision = parsed.revision;
    toIndex = Number(parsed.toIndex);
  } catch {
    res.statusCode = 400; res.end("invalid body"); return;
  }
  if (!Number.isInteger(toIndex) || toIndex < 0) {
    res.statusCode = 400; res.end("toIndex must be a non-negative integer"); return;
  }
  try {
    const stats = await withIdleContextLock(session, async () => {
      const snap = await session.bridge.snapshot();
      requireContextRevision(session, snap.messages, revision);
      // Validate the target leaf BEFORE compacting the kernel: a synthetic
      // slot would fail the tree sync after the kernel was already rewound,
      // stalling capture recording from then on.
      if (session.store && session.capture) resolveRewindLeaf(session, toIndex);
      const result = await contextTransaction(session, async () => {
        const result = await session.bridge.compact({ kind: "rewind", toIndex });
        await syncTreeAfterRewind(session, toIndex);
        return result;
      });
      await rebuildReplayFromKernel(session);
      return result;
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stats }));
  } catch (err) {
    res.statusCode = err instanceof ContextBusyError ? 409 : 500;
    res.end(`rewind failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Rewind by stable tree entry id (preferred over client-counted turn
 * numbers, which drift whenever the replay window is truncated).
 * Semantically "drop this message and everything after it": the context
 * becomes the branch ending at the entry's parent — the same branch-apply
 * fork uses, so it stays correct even if the entry sits on another branch.
 */
async function rewindToEntry(res: http.ServerResponse, session: Session, entryId: string): Promise<void> {
  if (!session.store || !session.capture) { res.statusCode = 409; res.end("session has no tree store"); return; }
  const resolved = resolveEntryId(session, entryId);
  if (!resolved) { res.statusCode = 404; res.end("entry not found"); return; }
  const entry = session.store.getEntry(resolved)!;
  if (entry.type !== "message") { res.statusCode = 400; res.end("entry is not a message"); return; }
  const leafId = entry.parentId;
  // The context already ends right before this message — nothing would move.
  if (session.store.getActiveLeaf() === leafId) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stats: null }));
    return;
  }
  try {
    await withIdleContextLock(session, async () => {
      // Converge persistence state first (same rationale as rewindToTurn).
      if (session.capture) { try { await session.capture!.flush(); } catch {} }
      // Apply the target branch BEFORE moving the active leaf: if the kernel
      // replace fails, the leaf must still point at the branch the kernel
      // and capture actually contain (same ordering rationale as fork).
      await applyBranchMessages(session, leafId);

    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stats: { leafId } }));
  } catch (err) {
    res.statusCode = err instanceof ContextBusyError ? 409 : 500;
    res.end(`rewind failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Atomically find a user message by its turn number and rewind the context
 * to drop everything from that message onward.  This avoids the TOCTOU race
 * where the client fetches context then rewinds in two separate requests.
 *
 * Accepts { entryId } (preferred — stable across replay truncation) or
 * { turn } (legacy fallback for frames rendered before entryId tagging).
 */
async function rewindToTurn(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  if (session.isProcessing) { res.statusCode = 409; res.end("cannot switch branches while a turn is in progress"); return; }
  const body = await readBody(req);
  let turn: number;
  let revision: unknown;
  try {
    const parsed = JSON.parse(body) as { turn?: number; entryId?: string; revision?: unknown };
    revision = parsed.revision;
    if (typeof parsed.entryId === "string" && parsed.entryId) {
      return await rewindToEntry(res, session, parsed.entryId);
    }
    turn = Number(parsed.turn);
  } catch {
    res.statusCode = 400; res.end("invalid body"); return;
  }
  if (!Number.isInteger(turn) || turn < 0) {
    res.statusCode = 400; res.end("turn must be a non-negative integer"); return;
  }
  try {
    const stats = await withIdleContextLock(session, async () => {
      requireContextRevision(session, (await session.bridge.snapshot()).messages, revision);
      // Converge persistence state first: flush pending capture appends so
      // the snapshot below reflects every completed turn.  Without this,
      // a snapshot racing a not-yet-flushed capture would under-count turns
      // and the truncation fallback below could cut REAL turns from replay.
      if (session.capture) { try { await session.capture.flush(); } catch {} }
      const snap = await session.bridge.snapshot();
      const msgs = snap.messages as Array<{ role?: string }>;
      // Count real turns only: synthetic user messages (compaction summaries,
      // drop placeholders) occupy slots with no tree entry, and system notes
      // (project-skills discovery, role:"user") are invisible to the UI — so
      // neither has a matching agent:query frame on the client, and counting
      // them would misalign the requested turn with the wrong message index.
      const isRealTurn = (i: number) =>
        msgs[i]?.role === "user"
        && !isSystemNoteMessage(msgs[i]) && !isContextPlaceholder(msgs[i])
        && (!session.capture || session.capture.getEntryIdAt(i) !== null);
      let seen = 0;
      let toIndex = -1;
      for (let i = 0; i < msgs.length; i++) {
        if (isRealTurn(i)) {
          if (seen === turn) { toIndex = i; break; }
          seen++;
        }
      }
      if (toIndex === -1) {
        // Bridge context is empty — the session was probably interrupted
        // before the turn completed and the tree store wasn't flushed.
        // Don't touch bridge or replay; returning null leaves the visible
        // conversation intact.  A page refresh will re-initialize the
        // bridge from the replay and the rewind will work normally.
        if (seen === 0) return null;
        // Snapshot has user messages but fewer than the requested turn
        // (e.g. prior compaction elided some).  Truncate the replay to
        // match the kernel's actual message count so the UI stays in sync.
        truncateReplayToTurnCount(session, seen);
        return null;
      }
      // Validate the target leaf BEFORE compacting the kernel (see
      // rewindContext): a failed tree sync after the fact stalls capture.
      if (session.store && session.capture) resolveRewindLeaf(session, toIndex);
      const result = await contextTransaction(session, async () => {
        const result = await session.bridge.compact({ kind: "rewind", toIndex });
        await syncTreeAfterRewind(session, toIndex);
        return result;
      });
      await rebuildReplayFromKernel(session);
      return result;
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stats }));
  } catch (err) {
    res.statusCode = err instanceof ContextBusyError ? 409 : 500;
    res.end(`rewind-to-turn failed: ${err instanceof Error ? err.message : err}`);
  }
}

// Legacy private entry points retained for integrations while implementations
// and caches belong to the optional marketplace service.
function searchSkills(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> { return featuresFor().skills.searchSkills(req, res); }
function listInstalledSkills(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> { return featuresFor().skills.listInstalledSkills(req, res); }
function installSkill(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> { return featuresFor().skills.installSkill(req, res); }
function uninstallSkill(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> { return featuresFor().skills.uninstallSkill(req, res); }
function invalidateSkillCaches(sessions?: Map<string, Session>): void { featuresFor(sessions).skills.invalidate(); }

function readLimitedBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, failed = false;
    const fail = (error: Error) => { if (!failed) { failed = true; chunks.length = 0; reject(error); } };
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) { fail(Object.assign(Error('Upload too large'), { status: 413 })); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', fail); req.on('aborted', () => fail(Error('Upload cancelled')));
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(""));
  });
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, root: string, urlPath: string): void {
  // Normalize and resolve to absolute path to prevent directory traversal
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(path.join(resolvedRoot, urlPath));
  if (!filePath.startsWith(resolvedRoot + path.sep) && filePath !== resolvedRoot) {
    res.statusCode = 403; res.end(); return;
  }
  fs.stat(filePath, (statErr, st) => {
    if (statErr || !st.isFile()) { res.statusCode = 404; res.end("not found"); return; }
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    const lastModified = st.mtime.toUTCString();
    // Vendor assets live under versioned directories (katex/fonts/…) — safe
    // to cache for a day.  Everything else revalidates (no-cache + ETag →
    // cheap 304s) so app updates take effect immediately.
    const cacheControl = urlPath.includes("/vendor/")
      ? "public, max-age=86400"
      : "no-cache";
    const inm = req.headers["if-none-match"];
    const ims = req.headers["if-modified-since"];
    const imsMs = typeof ims === "string" ? Date.parse(ims) : NaN;
    // HTTP dates have 1s resolution — compare at second granularity.
    const mtimeMs = Math.floor(st.mtimeMs / 1000) * 1000;
    if ((typeof inm === "string" && inm === etag) || (!inm && !Number.isNaN(imsMs) && imsMs >= mtimeMs)) {
      res.writeHead(304, { ETag: etag, "Last-Modified": lastModified, "Cache-Control": cacheControl });
      res.end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.statusCode = 404; res.end("not found"); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        ETag: etag,
        "Last-Modified": lastModified,
        "Cache-Control": cacheControl,
      });
      res.end(data);
    });
  });
}

async function setSubagentModel(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const body = await readBody(req);
  let parsed: { type?: string; model?: string };
  try { parsed = JSON.parse(body); } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON" }));
    return;
  }
  if (!parsed.type || typeof parsed.model !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing type or model" }));
    return;
  }
  if (!VALID_SUBAGENT_TYPES.has(parsed.type)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unknown subagent type" }));
    return;
  }
  if (!session.bridge.execCommand) { res.writeHead(409); res.end("backend does not support subagent settings"); return; }
  try { await session.bridge.execCommand("/sa-model", JSON.stringify({ type: parsed.type, model: parsed.model })); }
  catch (err) { res.writeHead(500); res.end(`settings update failed: ${String(err)}`); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// Whitelist for PUT /sa-model and PUT /sa-budget — mirrors SUBAGENT_TYPES in bridges/ash.ts.
const VALID_SUBAGENT_TYPES = new Set(["plan", "explore", "review", "research", "implement"]);
const VALID_REASONING_LEVELS = new Set(["off", "low", "medium", "high", "xhigh", "inherit"]);

async function setSubagentBudget(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const bad = (error: string) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  };
  const body = await readBody(req);
  let parsed: { type?: string; budgetTokens?: number | null; maxIterations?: number | null; reasoning?: string | null };
  try { parsed = JSON.parse(body); } catch {
    return bad("invalid JSON");
  }
  if (!parsed.type || !VALID_SUBAGENT_TYPES.has(parsed.type)) {
    return bad("unknown subagent type");
  }
  const numOk = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);
  if (parsed.budgetTokens !== undefined && !numOk(parsed.budgetTokens)) {
    return bad("budgetTokens must be a positive number or null");
  }
  if (parsed.maxIterations !== undefined && !numOk(parsed.maxIterations)) {
    return bad("maxIterations must be a positive number or null");
  }
  if (parsed.reasoning !== undefined && !(parsed.reasoning === null || (typeof parsed.reasoning === "string" && VALID_REASONING_LEVELS.has(parsed.reasoning)))) {
    return bad("reasoning must be one of off/low/medium/high/xhigh/inherit or null");
  }
  if (parsed.budgetTokens === undefined && parsed.maxIterations === undefined && parsed.reasoning === undefined) {
    return bad("nothing to set — pass budgetTokens, maxIterations, and/or reasoning");
  }
  if (!session.bridge.execCommand) { res.writeHead(409); res.end("backend does not support subagent settings"); return; }
  try { await session.bridge.execCommand("/sa-budget", JSON.stringify({
    type: parsed.type,
    ...(parsed.budgetTokens !== undefined ? { budgetTokens: parsed.budgetTokens } : {}),
    ...(parsed.maxIterations !== undefined ? { maxIterations: parsed.maxIterations } : {}),
    ...(parsed.reasoning !== undefined ? { reasoning: parsed.reasoning } : {}),
  })); } catch (err) { res.writeHead(500); res.end(`settings update failed: ${String(err)}`); return; }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}


async function getSubagentModelOverrides(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const bridge = session.bridge as any;
  const models = bridge?.getSubagentModels?.() ?? {};
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ models }));
}

async function getSubagentTypes(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const bridge = session.bridge as any;
  const types = bridge?.getSubagentTypes?.() ?? [];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ types }));
}


async function unpinSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  let id = "";
  try { id = JSON.parse(body).id; } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON" }));
    return;
  }
  await updatePinnedSessions(pinned => { pinned.delete(id); });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// Permission decision forwarded from client to bridge.
async function decidePermission(req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, Session>): Promise<void> {
  try {
    const body = await readBody(req);
    const { requestId, outcome, sessionId, sessionWide } = JSON.parse(body) as Record<string, unknown>;
    if (!requestId || !outcome || !sessionId) {
      res.writeHead(400);
      res.end("missing parameters");
      return;
    }
    const session = sessions.get(String(sessionId));
    if (!session) {
      res.writeHead(404);
      res.end("session not found");
      return;
    }
    // Ensure bridge is created — restored sessions are lazy-loaded.
    try { await session._ensureBridge?.(); } catch (err) {
      console.error(`[hub] decidePermission _ensureBridge failed:`, err);
      res.writeHead(500);
      res.end("failed to restore session");
      return;
    }
    if (!session.bridge?.decidePermission) {
      res.writeHead(404);
      res.end("permission not supported");
      return;
    }
    if (outcome !== "approved" && outcome !== "denied") { res.writeHead(400); res.end("invalid outcome"); return; }
    const pending = session.pendingPermissions?.get(String(requestId));
    if (!pending || pending.expiresAt <= Date.now()) { res.writeHead(409); res.end("permission expired or already handled"); return; }
    session.bridge.decidePermission(String(requestId), String(outcome), !!sessionWide);
    routeEvent(session, { name: "permission:resolved", payload: { requestId, outcome } });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch {
    res.writeHead(400);
    res.end("invalid request");
  }
}

// Upload a base64-encoded image. Returns { id: "img_xxx" } that can be
// referenced in the submit body's images array as { id: "...", mimeType: "..." }.
async function uploadImage(req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, Session>): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "failed to read body" }));
    return;
  }

  let parsed: { data?: string; mimeType?: string; sessionId?: string };
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `invalid JSON: ${err instanceof Error ? err.message : err}` }));
    return;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { res.writeHead(400); res.end("invalid upload"); return; }
  const { data, mimeType, sessionId } = parsed;
  if (!data || !mimeType) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing data or mimeType" }));
    return;
  }
  // sessionId is embedded in the output filename — reject anything that
  // doesn't look like a session id to keep the write inside uploadsDir.
  if (sessionId && !/^[0-9a-f]{4,32}$/i.test(sessionId)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid sessionId" }));
    return;
  }

  const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
  if (!session || session._closing || session._closed) { res.writeHead(404); res.end("session not found or closing"); return; }
  if (typeof data !== "string" || typeof mimeType !== "string" || !/^image\/(png|jpe?g|gif|webp)$/i.test(mimeType)) { res.writeHead(400); res.end("invalid image"); return; }
  try {
    const id = await persistSessionImage(session, data, mimeType);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id }));
  } catch (err) {
    res.writeHead(session._closing || session._closed ? 409 : 500);
    res.end(String(err));
  }
}

function persistSessionImage(session: Session, data: string, mimeType: string): Promise<string> {
  if (session._closing || session._closed) return Promise.reject(new Error("session closing"));
  const write = persistImageData(session.id, data, mimeType).then(id => {
    if (session._closing || session._closed) throw new Error("session closing");
    return id;
  });
  (session._uploads ??= new Set()).add(write);
  void write.finally(() => session._uploads!.delete(write)).catch(() => {});
  return write;
}

// Persist a base64 image into uploads/ with a session-prefixed id (same
// naming as uploadImage, so cleanup on session delete covers it). Used by
// submit() when the client sends raw data instead of an uploaded id.
async function persistImageData(sessionId: string, data: string, mimeType: string): Promise<string> {
  if (!/^image\/(png|jpe?g|gif|webp)$/i.test(mimeType)) throw new Error("unsupported image type");
  const uploadsDir = path.join(SESSIONS_DIR, "uploads");
  await fs.promises.mkdir(uploadsDir, { recursive: true });
  const baseId = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const id = `${sessionId}_${baseId}`;
  const ext = mimeType.split("/")[1]!.toLowerCase().replace("jpeg", "jpg");
  await fs.promises.writeFile(path.join(uploadsDir, `${id}.${ext}`), Buffer.from(data, "base64"));
  return id;
}

// Serve an uploaded image by id (prefix match, same lookup as submit()).
// Ids carry an unguessable random component; the id charset is validated so
// the read cannot escape uploadsDir.
async function serveUpload(res: http.ServerResponse, id: string): Promise<void> {
  if (!/^[0-9a-z_]+$/i.test(id)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid image id" }));
    return;
  }
  const uploadsDir = path.join(SESSIONS_DIR, "uploads");
  let match: string | undefined;
  try {
    match = (await fs.promises.readdir(uploadsDir)).find((f) => f.startsWith(id));
  } catch { /* dir missing */ }
  if (!match) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const ext = match.split(".").pop()?.toLowerCase() ?? "png";
  const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  const buf = await fs.promises.readFile(path.join(uploadsDir, match));
  res.writeHead(200, {
    "Content-Type": types[ext] ?? "application/octet-stream",
    // Ids are unique per upload — the content at this URL never changes.
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  res.end(buf);
}

async function listPinnedSessions(res: http.ServerResponse): Promise<void> {
  const pinned = await loadPinnedSessions();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ pinned: [...pinned] }));
}

async function togglePin(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  if (req.method === "POST") {
    // Drain the (ignored) body so the client's request completes cleanly.
    try { await readBody(req); } catch {}
  }
  const pinned = await updatePinnedSessions(pinned => {
    if (pinned.has(session.id)) pinned.delete(session.id);
    else pinned.add(session.id);
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ pinned: pinned.has(session.id) }));
}

/** Project membership is checked on every call, including after lazy restore. */
function conversationAccess(sourceId: string, sessions: Map<string, Session>, projects: ProjectStore, tasks?: CollaborationTasks): ConversationAccess {
  return createConversationAccess(sourceId, { sessions, projects, tasks, tasksDirectory: path.join(SESSIONS_DIR, "collaboration"), withContextLock, submitQuery });
}

/** Bind source identity at composition; extensions cannot choose a different actor. */
function hostAccess(sourceId: string, sessions: Map<string, Session>, projects: ProjectStore, opts: HubOpts, operations: HostOperations, deleting: () => boolean): HostAccess {
  const service = sessionServices.get(sessions) ?? new SessionService({ busy: sessionBusy, thinking: sessionThinkingLevel });
  return createHostAccess(sourceId, { sessions, projects, operations, signal: opts.signal, deleting,
    busy: sessionBusy, describe: service.describe, version: () => service.events.version(), writeNetworkPolicy: service.writeNetworkPolicy,
    sessionThinkingLevel, expandHome, withContextLock, setSessionTitle, saveSessionMeta,
    create: (cwd, setup) => createSession(sessions, opts, cwd, undefined, 'agent', setup),
    archive: id => archiveSessionById(sessions, id), delete: (id, approved) => deleteSession(sessions, id, approved),
  });
}
