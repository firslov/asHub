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
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Bridge, BridgeFactory, BusEvent, SessionKind } from "./bridges/types.js";
import { LlmClient } from "agent-sh";
import { resolveProvider, getSettings, getProviderNames } from "agent-sh/settings";
import { SessionStore, type AgentMessage } from "./history/session-store.js";
import { createCapture, tagMessagesWithEntryIds, readEntryIdTags, type Capture } from "./history/capture.js";
import { extractText, snippet, stripContextWrappers, summarizeMessage } from "./history/summarize.js";
import { createCompactionStrategy } from "./history/compaction-strategy.js";

export interface HubOpts {
  port: number;
  host: string;
  webRoot: string;
  /** Factory the hub uses to spawn one bridge per session. */
  makeBridge: BridgeFactory;
}

interface Session {
  id: string;
  title: string;
  kind: SessionKind;
  cwd: string;
  bridge: Bridge;
  replay: string[];
  segmentText: string;
  segmentSeq: number;
  sseClients: Set<http.ServerResponse>;
  model?: string;
  provider?: string;
  startedAt: number;
  /** True once the first user→assistant turn has completed (for auto-title). */
  firstTurnDone: boolean;
  /** The first user query text, captured for auto-title generation. */
  firstQuery?: string;
  /** User-set title (empty = auto-generate). */
  userTitle?: string;
  /** Timestamp of last agent activity — used by idle-timeout heartbeat. */
  lastActivity: number;
  /** How many tools are currently running (tracked via agent:tool-started / agent:tool-completed). */
  toolsRunning: number;
  /** Timestamp of most recent modification (create, title change, new turn, command). */
  lastModified: number;
  /** Whether the agent is currently processing a turn. */
  isProcessing: boolean;
  /** Whether the session has new output since the user last viewed it. */
  hasUnread: boolean;
  lastAgentInfo: Record<string, unknown> | null;
  store?: SessionStore;
  capture?: Capture;
  contextLock: Promise<void>;
}

const REPLAY_LIMIT = 5000;

let frameSeq = 0;
const frameIdRe = /^id: (\d+)/;

function parseFrameName(frame: string): string {
  const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) return "";
  try {
    const inner = JSON.parse(dataLine.slice("data: ".length));
    return (inner?.meta?.name ?? "") as string;
  } catch { return ""; }
}
const REPLAY_NAMES = new Set([
  "agent:info",
  "agent:query",
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
  "ui:info",
  "ui:error",
  "session:title",
  "hub:compaction-marker",
  "shell:command-start",
  "shell:command-done",
  "shell:cwd-change",
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

async function ensureSessionsDir(): Promise<void> {
  await fs.promises.mkdir(SESSIONS_DIR, { recursive: true });
}

function sessionMetaPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.meta.json`);
}

async function saveSessionMeta(session: Session): Promise<void> {
  await ensureSessionsDir();
  const metaPath = sessionMetaPath(session.id);
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(await fs.promises.readFile(metaPath, "utf-8")); } catch {}
  const merged = { ...existing, id: session.id, title: session.title, kind: session.kind, cwd: session.cwd, model: session.model, provider: session.provider, startedAt: session.startedAt, firstQuery: session.firstQuery, userTitle: session.userTitle, lastModified: session.lastModified };
  await fs.promises.writeFile(metaPath, JSON.stringify(merged));
}

const _writeBufs = new Map<string, { frames: string[]; timer: ReturnType<typeof setTimeout> | null }>();
const _writeLocks = new Map<string, Promise<void>>();
const BATCH_FLUSH_MS = 2000;

function _flushBuf(sessionId: string): void {
  const buf = _writeBufs.get(sessionId);
  if (!buf || buf.frames.length === 0) return;
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
  const frames = buf.frames.splice(0);
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
  const prev = _writeLocks.get(sessionId) ?? Promise.resolve();
  const p = prev.then(() => new Promise<void>((resolve) => {
    fs.appendFile(
      path.join(SESSIONS_DIR, `${sessionId}.replay.jsonl`),
      frames.join(""),
      () => {
        if (_writeLocks.get(sessionId) === p) _writeLocks.delete(sessionId);
        resolve();
      },
    );
  }));
  _writeLocks.set(sessionId, p);
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

export async function shutdownHub(): Promise<void> {
  for (const id of Array.from(_writeBufs.keys())) {
    _flushBuf(id);
  }
  await Promise.allSettled(Array.from(_writeLocks.values()));
}

function persistReplayFile(sessionId: string, frames: string[]): Promise<void> {
  const buf = _writeBufs.get(sessionId);
  if (buf) {
    if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
    buf.frames.length = 0;
  }
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
  const prev = _writeLocks.get(sessionId) ?? Promise.resolve();
  const p = prev.then(() => new Promise<void>((resolve) => {
    fs.writeFile(
      path.join(SESSIONS_DIR, `${sessionId}.replay.jsonl`),
      frames.join(""),
      () => {
        if (_writeLocks.get(sessionId) === p) _writeLocks.delete(sessionId);
        resolve();
      },
    );
  }));
  _writeLocks.set(sessionId, p);
  return p;
}

async function deleteSessionFiles(id: string): Promise<void> {
  try { await fs.promises.unlink(path.join(SESSIONS_DIR, `${id}.meta.json`)); } catch {}
  try { await fs.promises.unlink(path.join(SESSIONS_DIR, `${id}.replay.jsonl`)); } catch {}
  try { await fs.promises.unlink(path.join(SESSIONS_DIR, `${id}.messages.json`)); } catch {}
  try { await fs.promises.unlink(path.join(SESSIONS_DIR, `${id}.jsonl`)); } catch {}
  try { await fs.promises.unlink(path.join(SESSIONS_DIR, `${id}.jsonl.leaf`)); } catch {}
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
}

function inferProviderForModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  for (const name of getProviderNames()) {
    const p = resolveProvider(name);
    if (!p) continue;
    if (p.defaultModel === model) return name;
    if (p.models?.includes(model)) return name;
  }
  return undefined;
}

function providerHasModel(name: string | undefined, model: string | undefined): boolean {
  if (!name || !model) return false;
  const p = resolveProvider(name);
  if (!p) return false;
  return p.defaultModel === model || (p.models?.includes(model) ?? false);
}

async function migrateLegacySessions(): Promise<void> {
  await ensureSessionsDir();
  let files: string[];
  try { files = await fs.promises.readdir(SESSIONS_DIR); } catch { return; }
  for (const file of files) {
    if (!file.endsWith(".meta.json")) continue;
    const id = file.slice(0, -".meta.json".length);
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
    const results: PersistedSession[] = [];
    for (const file of files) {
      if (!file.endsWith(".meta.json")) continue;
      const id = file.slice(0, -".meta.json".length);
      try {
        const metaRaw = await fs.promises.readFile(path.join(SESSIONS_DIR, file), "utf-8");
        const meta = JSON.parse(metaRaw);
        let replay: string[] = [];
        try {
          const replayRaw = await fs.promises.readFile(path.join(SESSIONS_DIR, `${id}.replay.jsonl`), "utf-8");
          replay = replayRaw.split("\n\n").filter((l) => l.trim()).map((l) => l + "\n\n");
          if (replay.length > REPLAY_LIMIT) replay = replay.slice(-REPLAY_LIMIT);
        } catch {}
        let messages: unknown[] | undefined;
        try {
          const msgRaw = await fs.promises.readFile(path.join(SESSIONS_DIR, `${id}.messages.json`), "utf-8");
          const parsed = JSON.parse(msgRaw);
          if (Array.isArray(parsed)) messages = parsed;
        } catch {}
        results.push({ id: meta.id || id, title: meta.title, kind: meta.kind, cwd: meta.cwd, model: meta.model, provider: meta.provider, startedAt: meta.startedAt, replay, messages, firstQuery: meta.firstQuery, userTitle: meta.userTitle, lastModified: meta.lastModified });
      } catch {}
    }

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
        // Heal persisted pairings written while a stale defaultProvider was active.
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
};

export function startHub(opts: HubOpts): http.Server {
  const sessions = new Map<string, Session>();

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "/";

    if (req.method === "GET" && url === "/api/config") return getConfig(res);
    if (req.method === "PUT" && url === "/api/config") return updateConfig(req, res);
    if (req.method === "POST" && url === "/api/config/reload") return reloadConfig(res);
    if (req.method === "GET" && url === "/api/version") return getVersion(res);
    if (req.method === "GET" && url.startsWith("/api/balance")) return getBalance(req, res);
    if (req.method === "GET" && url === "/sessions") return listSessions(res, sessions);
    if (req.method === "GET" && url.startsWith("/events")) {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      return openSseMulti(req, res, sessions, params.get("subs") ?? "", params.get("since") ?? "");
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
      const session = sessions.get(id);
      if (!session) { res.statusCode = 404; res.end("no session"); return; }

      if (req.method === "POST" && rest === "/pty-input") return ptyInput(req, res, session);
      if (req.method === "POST" && rest === "/pty-resize") return ptyResize(req, res, session);
      if (req.method === "POST" && rest === "/submit") return submit(req, res, session);
      if (req.method === "POST" && rest === "/command") return execCommand(req, res, session);
      if (req.method === "POST" && rest === "/thinking") return setThinking(req, res, session);
      if (req.method === "POST" && rest === "/title") return updateTitle(req, res, session);
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
      if (req.method === "GET" && rest.startsWith("/files")) {
        const params = new URLSearchParams(rawRest.split("?")[1] ?? "");
        return listFiles(res, session, params.get("subdir") ?? "");
      }
      if (req.method === "GET" && rest === "/context") return getContext(res, session);
      if (req.method === "POST" && rest === "/context/rewind") return rewindContext(req, res, session);
      if (req.method === "POST" && rest === "/context/rewind-to-turn") return rewindToTurn(req, res, session);
      if (req.method === "POST" && rest === "/context/drop") return dropContext(req, res, session);
      if (req.method === "GET" && rest === "/branch") return branchEndpoint(res, session);
      if (req.method === "GET" && rest === "/git-branch") return gitBranchEndpoint(res, session);
      if (req.method === "GET" && rest === "/tree") return treeEndpoint(res, session);
      if (req.method === "POST" && rest === "/fork") return forkEndpoint(req, res, session);
      if (req.method === "DELETE" && rest === "/") return closeSession(res, sessions, id);

      const file = rest === "/" || rest === "/index.html" ? "/index.html" : rest;
      return serveStatic(res, opts.webRoot, file);
    }

    if (url === "/") {
      const first = Array.from(sessions.keys())[0];
      if (first) { res.writeHead(302, { Location: `/${first}/` }); res.end(); return; }
      // No sessions yet — serve the landing page; the user clicks "+" to spawn.
      return serveStatic(res, opts.webRoot, "/index.html");
    }

    return serveStatic(res, opts.webRoot, url.split("?")[0]!);
  });

  // Restore persisted sessions before starting the HTTP server so that
  // the first /sessions request already sees the full list.
  restoreSessions(sessions, opts).catch((err) => {
    console.error("[hub] session restore error:", err);
  }).finally(() => {
    server.listen(opts.port, opts.host, () => {
      console.error(`asHub listening on http://${opts.host}:${opts.port}/`);
    });
  });

  return server;
}

// ── Balance ──────────────────────────────────────────────────────────

async function getBalance(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const params = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const provider = params.get("provider") ?? "";
  if (!provider) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing provider" }));
    return;
  }

  // Only DeepSeek supports balance checking via their API
  if (provider !== "deepseek") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ is_available: false }));
    return;
  }

  try {
    // Use resolveProvider to expand $ENV_VAR syntax in apiKey
    const resolved = resolveProvider("deepseek");
    const apiKey = resolved?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
    if (!apiKey || apiKey === "YOUR_API_KEY") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ is_available: false, error: "no api key" }));
      return;
    }

    const baseURL = resolved?.baseURL ?? "https://api.deepseek.com";
    // Balance API is at the root, not under /v1 — use origin
    let balanceURL: string;
    try { balanceURL = `${new URL(baseURL).origin}/user/balance`; }
    catch { balanceURL = `${baseURL.replace(/\/+$/, "")}/user/balance`; }

    const r = await fetch(balanceURL, {
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!r.ok) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ is_available: false, error: `HTTP ${r.status}` }));
      return;
    }

    const data = await r.json();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (err) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ is_available: false, error: err instanceof Error ? err.message : String(err) }));
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
    if (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(raw);
  });
}

async function updateConfig(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
  const fp = settingsPath();
  try {
    await fs.promises.mkdir(path.dirname(fp), { recursive: true });
    await fs.promises.writeFile(fp, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
    try {
      const { reloadSettings } = await import("agent-sh/settings");
      reloadSettings();
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 500;
    res.end(`write failed: ${err instanceof Error ? err.message : err}`);
  }
}

function reloadConfig(res: http.ServerResponse): void {
  import("agent-sh/settings")
    .then((m) => { m.reloadSettings(); })
    .catch(() => {});
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// ── Session management ──────────────────────────────────────────────

async function createSession(
  sessions: Map<string, Session>,
  opts: HubOpts,
  cwd: string,
  existing?: { id: string; title?: string; kind?: SessionKind; replay: string[]; startedAt: number; messages?: unknown[]; firstQuery?: string; userTitle?: string; model?: string; provider?: string; lastModified?: number },
  spawnKind: SessionKind = "agent",
): Promise<Session> {
  const id = existing?.id ?? randomBytes(3).toString("hex");
  const kind: SessionKind = existing?.kind ?? spawnKind;
  const isAgent = kind === "agent";

  let store: SessionStore | undefined;
  const treePath = path.join(SESSIONS_DIR, `${id}.jsonl`);
  try {
    if (isAgent) {
      if (existing && fs.existsSync(treePath)) {
        store = new SessionStore(treePath, { metaPath: sessionMetaPath(id) });
      } else if (!existing) {
        store = new SessionStore(treePath, {
          create: { cwd, sessionId: id },
          metaPath: sessionMetaPath(id),
        });
      } else {
        // Restored session whose tree file is missing — re-create it
        store = new SessionStore(treePath, {
          create: { cwd, sessionId: id },
          metaPath: sessionMetaPath(id),
        });
      }
    }
  } catch (err) {
    console.error(`[hub] failed to attach tree store for ${id}:`, err);
  }

  const initialMessages = existing && store ? store.buildMessages() : existing?.messages;
  const compactionStrategy = isAgent
    ? createCompactionStrategy(
        () => session?.store ?? null,
        () => session?.capture ?? null,
        (msg) => console.error(`[hub] ${id}: ${msg}`),
        async (liveView, entryIds) => {
          if (session) await rebuildReplay(session, liveView, entryIds);
        },
      )
    : undefined;
  const bridge = opts.makeBridge({ cwd, kind, initialMessages, model: existing?.model, provider: existing?.provider, compactionStrategy });

  const defaultTitle = kind === "terminal" ? `▷ ${path.basename(cwd) || cwd}` : "";
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
    // If the session already has messages (from tree store or legacy
    // messages.json), the first turn was already done.
    firstTurnDone: !!(initialMessages?.length),
    firstQuery: existing?.firstQuery,
    userTitle: existing?.userTitle,
    lastActivity: Date.now(),
    toolsRunning: 0,
    lastModified: existing?.lastModified ?? existing?.startedAt ?? Date.now(),
    isProcessing: false,
    hasUnread: false,
    lastAgentInfo: null,
    store,
    contextLock: Promise.resolve(),
  };
  if (isAgent) {
    session.capture = createCapture(bridge, () => session.store ?? null, {
      onWarn: (msg) => console.error(`[hub] ${id}: ${msg}`),
    });
  }

  bridge.onEvent((e) => {
    try { routeEvent(session, e); }
    catch (err) { console.error("[hub] routeEvent error:", err); }
  });
  bridge.onClose(() => {
    try {
      sessions.delete(id);
      for (const r of session.sseClients) { try { r.end(); } catch {} }
    } catch (err) { console.error("[hub] bridge onClose error:", err); }
  });
  bridge.onError((err) => {
    try { routeEvent(session, { name: "agent:error", payload: { message: String(err) } }); }
    catch (e) { console.error("[hub] bridge onError error:", e); }
  });

  await bridge.ready();
  if (existing && store && session.capture) {
    const { entryIds } = store.buildBranchWithIds();
    session.capture.resetTo(entryIds);
  }
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
    if (hasDangling) {
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
  // Push initial title into replay so reconnecting SSE clients see it.
  pushFrame(session, "session:title", sseFrame(
    { source: id, ts: Date.now(), id: `hub:${id}:title`, name: "session:title" },
    { title: session.title },
  ));
  return session;
}

async function restoreSessions(sessions: Map<string, Session>, opts: HubOpts): Promise<void> {
  await migrateLegacySessions();
  const persisted = await loadPersistedSessions();
  if (persisted.length === 0) return;
  // Sort by lastModified descending so the most recently active sessions
  // appear first in the sidebar — mirroring listSessions.
  persisted.sort((a, b) => (b.lastModified ?? b.startedAt ?? 0) - (a.lastModified ?? a.startedAt ?? 0));
  // Restart safety: client's Last-Event-ID stays valid because we keep growing
  // past the highest persisted id.
  for (const p of persisted) {
    for (const line of p.replay) {
      const m = line.match(frameIdRe);
      if (m) {
        const n = Number(m[1]);
        if (n > frameSeq) frameSeq = n;
      }
    }
  }
  console.error(`[hub] restoring ${persisted.length} session(s)…`);
  for (const p of persisted) {
    if (p.kind === "terminal") {
      await deleteSessionFiles(p.id);
      continue;
    }
    try {
      await createSession(sessions, opts, p.cwd, { id: p.id, title: p.title, kind: p.kind, replay: p.replay, startedAt: p.startedAt, messages: p.messages, firstQuery: p.firstQuery, userTitle: p.userTitle, model: p.model, provider: p.provider, lastModified: p.lastModified });
      console.error(`[hub] restored session ${p.id} (cwd: ${p.cwd})`);
    } catch (err) {
      console.error(`[hub] failed to restore session ${p.id}:`, err);
      await deleteSessionFiles(p.id);
    }
  }
}

/**
 * Inject a bridge-emitted event into the session: replay buffer, SSE
 * clients, and the segment accumulator that lets reconnects see properly
 * interleaved text/tool ordering (mirrors web-renderer.ts).
 */
function routeEvent(session: Session, e: BusEvent): void {
  const meta = {
    source: session.id,
    ts: Date.now(),
    id: `hub:${session.id}:${session.segmentSeq}`,
    name: e.name,
  };

  if (session.kind === "terminal") {
    if (e.name === "shell:pty-data" || e.name === "shell:exit") {
      pushFrame(session, e.name, sseFrame(meta, e.payload), { transient: true });
    } else if (e.name === "ui:error" || e.name === "ui:info") {
      pushFrame(session, e.name, sseFrame(meta, e.payload), { transient: true });
    }
    return;
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
    for (const b of blocks) if (b.type === "text") session.segmentText += b.text ?? "";
    const frame = sseFrame(meta, e.payload);
    for (const r of session.sseClients) { try { r.write(frame); } catch {} }
    return;
  }

  if (e.name === "agent:queued-submit") {
    session.lastModified = Date.now();
    session.isProcessing = true;
    session.hasUnread = false;
    const query = (e.payload as { query?: string })?.query ?? "";
    // Generate fresh meta for each frame so they don't share the same
    // id / ts — mirroring submit()'s non-queued path.
    const makeMeta = (name: string) => ({
      source: session.id,
      ts: Date.now(),
      id: `hub:${session.id}:${name}`,
      name,
    });
    pushFrame(session, "agent:query", sseFrame(makeMeta("agent:query"), { query }));
    pushFrame(session, "agent:processing-start", sseFrame(makeMeta("agent:processing-start"), {}));
    return;
  }

  if (e.name === "agent:queued-done") {
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
    saveSessionMeta(session).catch(() => {});
    session.capture?.flush().catch((err) =>
      console.error(`[hub] capture.flush failed for ${session.id}:`, err)
    );
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
      if (typeof info.model === "string" && info.model) session.model = info.model;
      if (typeof info.provider === "string" && info.provider) session.provider = info.provider;
    }
  }

  if (e.name === "agent:cancelled") {
    session.isProcessing = false;
  }

  pushFrame(session, e.name, sseFrame(meta, e.payload));
}

function flushSegment(session: Session): void {
  if (!session.segmentText) return;
  const meta = {
    source: session.id,
    ts: Date.now(),
    id: `hub:${session.id}:seg:${session.segmentSeq++}`,
    name: "agent:response-segment",
  };
  const text = session.segmentText;
  session.segmentText = "";
  pushFrame(session, "agent:response-segment", sseFrame(meta, { text }));
}

function sseFrame(meta: object, payload: unknown): string {
  return `id: ${++frameSeq}\ndata: ${JSON.stringify({ meta, payload })}\n\n`;
}

function pushFrame(session: Session, name: string, frame: string, opts?: { transient?: boolean }): void {
  if (opts?.transient) {
    session.replay.push(frame);
    if (session.replay.length > REPLAY_LIMIT) session.replay.shift();
  } else if (REPLAY_NAMES.has(name)) {
    session.replay.push(frame);
    if (session.replay.length > REPLAY_LIMIT) session.replay.shift();
    persistReplayFrame(session.id, frame);
  }
  for (const r of session.sseClients) { try { r.write(frame); } catch {} }
}

// ── Session title management ─────────────────────────────────────────

async function setSessionTitle(session: Session, title: string): Promise<void> {
  const trimmed = title.trim().slice(0, 100);
  if (!trimmed || trimmed === session.title) return;
  session.title = trimmed;
  session.lastModified = Date.now();
  await saveSessionMeta(session);
  const frame = sseFrame(
    { source: session.id, ts: Date.now(), id: `hub:${session.id}:title`, name: "session:title" },
    { title: session.title },
  );
  pushFrame(session, "session:title", frame);
}

async function generateTitleAsync(session: Session): Promise<void> {
  let query = session.firstQuery?.trim();
  if (!query || session.userTitle) return;
  // Slash-commands don't make good titles — skip them.
  if (query.startsWith("/")) query = undefined;
  if (!query) return;

  const fallback = query.slice(0, 80);

  const providerName = session.provider || getSettings().defaultProvider;
  if (!providerName) { await setSessionTitle(session, fallback); return; }
  const resolved = resolveProvider(providerName);
  if (!resolved?.apiKey) { await setSessionTitle(session, fallback); return; }
  const model = session.model || resolved.defaultModel;
  if (!model) { await setSessionTitle(session, fallback); return; }

  const client = new LlmClient({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    model,
    appName: "asHub",
  });

  try {
    const stream = await client.stream({
      messages: [
        { role: "system", content: "You are a title generator. Given a user's first message to an AI assistant, generate a concise, descriptive title (max 10 words, no quotes). Return ONLY the title text, nothing else." },
        { role: "user", content: `Generate a short title for a conversation that starts with: "${query}"` },
      ],
      max_tokens: 4096,
    });
    let raw = "";
    for await (const chunk of stream) {
      raw += chunk?.choices?.[0]?.delta?.content ?? "";
    }
    const title = raw.trim().replace(/^"|"$/g, "");
    if (title && !session.userTitle) { await setSessionTitle(session, title); return; }
  } catch {
    // LLM call failed — fall through to fallback.
  }

  // Fallback: use the first query text as title.
  if (!session.userTitle) await setSessionTitle(session, fallback);
}

// ── HTTP handlers ───────────────────────────────────────────────────

function listSessions(res: http.ServerResponse, sessions: Map<string, Session>): void {
  const list = Array.from(sessions.values())
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .map((s) => ({
      instanceId: s.id,
      title: s.title,
      kind: s.kind,
      model: s.model,
      provider: s.provider,
      cwd: s.cwd,
      startedAt: s.startedAt,
      lastModified: s.lastModified,
      isProcessing: s.isProcessing,
      hasUnread: s.hasUnread,
    }));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(list));
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
    if (parsed.kind === "terminal" || parsed.kind === "agent") kind = parsed.kind;
  } catch {}
  if (!cwd) cwd = kind === "terminal" ? os.homedir() : process.cwd();
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
  if (input === "~" || input.startsWith("~/")) return os.homedir() + input.slice(1);
  return input;
}

function pickDir(res: http.ServerResponse): void {
  const platform = process.platform;
  let cmd: string, args: string[];
  if (platform === "darwin") {
    cmd = "osascript";
    args = ["-e", 'POSIX path of (choose folder with prompt "Select working directory")'];
  } else if (platform === "win32") {
    cmd = "powershell";
    args = [
      "-NoProfile", "-Command",
      "$f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select working directory'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }",
    ];
  } else {
    cmd = "zenity";
    args = ["--file-selection", "--directory", "--title=Select working directory"];
  }
  execFile(cmd, args, { timeout: 120_000 }, (err, stdout) => {
    if (err) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cancelled: true }));
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
}

async function listDirs(res: http.ServerResponse, prefix: string): Promise<void> {
  const home = os.homedir();
  const usedTilde = prefix === "~" || prefix.startsWith("~/");
  let raw = prefix ? expandHome(prefix) : process.cwd() + "/";

  let parent: string, partial: string;
  if (raw.endsWith("/")) { parent = raw; partial = ""; }
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
    let full = path.join(parent, e.name) + "/";
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
    const resolved = path.resolve(session.cwd, subdir);
    // Prevent directory traversal
    if (!resolved.startsWith(path.resolve(session.cwd) + path.sep) && resolved !== path.resolve(session.cwd)) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    targetDir = resolved;
  }
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(targetDir, { withFileTypes: true }); }
  catch {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cwd: targetDir, files: [] }));
    return;
  }
  const files: Array<{ name: string; size: number; kind: "file" | "dir" }> = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    files.push({ name: e.name, size: 0, kind: e.isDirectory() ? "dir" : "file" });
    if (files.length >= 200) break;
  }
  // Sort: dirs first, then files; alphabetical within each group.
  files.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ cwd: targetDir, files }));
}

function closeSession(res: http.ServerResponse, sessions: Map<string, Session>, id: string): void {
  const s = sessions.get(id);
  if (s) {
    try { s.bridge.close(); } catch {}
    sessions.delete(id);
  }
  const buf = _writeBufs.get(id);
  if (buf?.timer) { clearTimeout(buf.timer); buf.timer = null; }
  _writeBufs.delete(id);
  const lock = _writeLocks.get(id);
  _writeLocks.delete(id);
  void (async () => {
    if (lock) { try { await lock; } catch {} }
    await deleteSessionFiles(id);
  })();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function updateTitle(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const body = await readBody(req);
  let title = "";
  try { title = ((JSON.parse(body) as { title?: string }).title ?? "").trim(); } catch {}
  if (!title) { res.statusCode = 400; res.end("empty title"); return; }
  session.userTitle = title;
  await setSessionTitle(session, title);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, title: session.title }));
}

async function generateTitle(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  // Use the stored firstQuery, or accept one from the request body.
  const body = await readBody(req);
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
function openSseMulti(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessions: Map<string, Session>,
  subsParam: string,
  sinceParam: string,
): void {
  const subs = subsParam.split(",").map((s) => {
    const [id, tailStr] = s.split(":");
    const tail = tailStr === "all" ? Infinity : Math.max(0, Number(tailStr ?? "50") || 0);
    return { id: id ?? "", tail };
  }).filter((s) => s.id);

  const headerLast = req.headers["last-event-id"];
  const since = Math.max(
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
  res.write(`: connected ${subs.length}\n\n`);

  for (const { id, tail } of subs) {
    const session = sessions.get(id);
    if (!session) continue;
    if (tail > 0) {
      session.hasUnread = false;
      for (const line of session.replay.slice(-tail)) {
        try { res.write(line); } catch { return; }
      }
      if (session.lastAgentInfo) {
        const meta = { source: id, ts: Date.now(), id: `hub:${id}:reemit:agent:info`, name: "agent:info" };
        try { res.write(`id: ${++frameSeq}\ndata: ${JSON.stringify({ meta, payload: session.lastAgentInfo })}\n\n`); } catch { return; }
      }
      const doneMeta = { source: id, ts: Date.now(), name: "hub:replay-done" };
      try { res.write(`id: ${++frameSeq}\ndata: ${JSON.stringify({ meta: doneMeta })}\n\n`); } catch { return; }
    } else if (since > 0) {
      for (const line of session.replay) {
        const m = line.match(frameIdRe);
        if (m && Number(m[1]) > since) {
          try { res.write(line); } catch { return; }
        }
      }
    }
    session.sseClients.add(res);
  }

  req.on("close", () => {
    for (const { id } of subs) sessions.get(id)?.sseClients.delete(res);
  });
}

async function ptyInput(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  if (!session.bridge.writePty) {
    res.statusCode = 400; res.end("session has no PTY"); return;
  }
  const body = await readBody(req);
  let data = "";
  try { data = (JSON.parse(body) as { data?: string }).data ?? ""; } catch {}
  if (typeof data !== "string") { res.statusCode = 400; res.end("invalid data"); return; }
  try { session.bridge.writePty(data); } catch (err) {
    res.statusCode = 500; res.end(`pty write failed: ${err instanceof Error ? err.message : err}`); return;
  }
  session.lastActivity = Date.now();
  session.lastModified = Date.now();
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
  try { query = (JSON.parse(body) as { query?: string }).query ?? ""; } catch {}
  if (!query.trim()) { res.statusCode = 400; res.end("empty"); return; }

  const meta = (name: string) => ({
    source: session.id,
    ts: Date.now(),
    id: `hub:${session.id}:${name}`,
    name,
  });

  // Capture the first user query for auto-title generation.
  const isFirstTurn = !session.firstTurnDone;
  if (isFirstTurn) session.firstQuery = query;

  // Bump lastModified so this session moves to the top of the sidebar.
  session.lastModified = Date.now();

  const queued = !!session.bridge.isProcessing?.();
  if (!queued) {
    session.isProcessing = true;
    session.hasUnread = false;
    pushFrame(session, "agent:query", sseFrame(meta("agent:query"), { query }));
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
  // Reset toolsRunning at the start of a non-queued turn so stale counts from
  // a previous turn (e.g. crashed agent, missed tool-completed) don't keep
  // the window artificially wide.
  if (!queued) session.toolsRunning = 0;

  let done = false;
  let rejectTimeout: ((err: Error) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  session.lastActivity = Date.now();

  const checkIdle = () => {
    if (done) return; // prevent reschedule after cleanup
    const elapsed = Date.now() - session.lastActivity;
    const windowMs = (session.toolsRunning > 0 ? 10 : 3) * 60 * 1000;
    if (elapsed >= windowMs) {
      // Double-check: if the bridge still reports it's processing, extend
      // the window instead of declaring it stuck.  This is a last-resort
      // safety net that doesn't depend on accurate toolsRunning tracking.
      if (session.bridge.isProcessing?.()) {
        timer = setTimeout(checkIdle, 2 * 60 * 1000);
        return;
      }
      done = true;
      try { session.bridge.cancel(); } catch {}
      rejectTimeout!(new Error("Request timed out — the agent may be stuck."));
    } else {
      timer = setTimeout(checkIdle, windowMs - elapsed + 500);
    }
  };
  // Base the initial check interval on whether tools are already running.
  timer = setTimeout(checkIdle, (session.toolsRunning > 0 ? 10 : 3) * 60 * 1000);

  const cleanup = () => {
    done = true;
    if (timer !== undefined) clearTimeout(timer);
  };

  Promise.race([session.bridge.submit(query), timeout])
    .then((result) => {
      cleanup();
      if (result.stopReason === "queued") {
        pushFrame(session, "agent:queued", sseFrame(meta("agent:queued"), { query }));
        return;
      }
      flushSegment(session);
      session.isProcessing = false;
      // Only mark unread if no one is watching (no active SSE client).
      session.hasUnread = session.sseClients.size === 0;
      pushFrame(session, "agent:processing-done", sseFrame(meta("agent:processing-done"), {}));
      _flushBuf(session.id);
      saveSessionMeta(session).catch(() => {});
      session.capture?.flush().catch((err) =>
        console.error(`[hub] capture.flush failed for ${session.id}:`, err)
      );

      // After the first turn completes, generate a title via the LLM.
      if (isFirstTurn && !session.firstTurnDone) {
        session.firstTurnDone = true;
        generateTitleAsync(session).catch((err) =>
          console.error(`[hub] auto-title failed for ${session.id}:`, err)
        );
      }
    })
    .catch((err) => {
      cleanup();
      session.isProcessing = false;
      pushFrame(session, "agent:error", sseFrame(meta("agent:error"), { message: String(err) }));
    });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function setThinking(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  session: Session,
): Promise<void> {
  const body = await readBody(req);
  let level = "";
  try { level = String((JSON.parse(body) as { level?: string }).level ?? "").trim(); } catch {}
  if (!level) { res.statusCode = 400; res.end("missing level"); return; }
  if (!session.bridge.setThinking) { res.statusCode = 501; res.end("bridge does not support setThinking"); return; }
  try { session.bridge.setThinking(level); } catch (err) {
    res.statusCode = 500; res.end(String(err)); return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function execCommand(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  session: Session,
): Promise<void> {
  const body = await readBody(req);
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
  const meta = (n: string) => ({
    source: session.id, ts: Date.now(),
    id: `hub:${session.id}:${n}`, name: n,
  });
  pushFrame(session, "agent:query", sseFrame(meta("agent:query"), { query: args ? `${name} ${args}` : name }));
  try { session.bridge.execCommand(name, args); } catch (err) {
    pushFrame(session, "ui:error", sseFrame(meta("ui:error"), { message: String(err) }));
  }
  saveSessionMeta(session).catch(() => {});
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

async function getContext(res: http.ServerResponse, session: Session): Promise<void> {
  try {
    const snap = await session.bridge.snapshot();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snap));
  } catch (err) {
    res.statusCode = 500;
    res.end(`snapshot failed: ${err instanceof Error ? err.message : err}`);
  }
}

function getBranchEntries(session: Session): Array<{ id: string; type: string; parentId: string | null; timestamp: number; preview: string; role?: string; summary?: string }> | null {
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
      preview: snippet(display, 80),
    };
  });
}

function gitBranchEndpoint(res: http.ServerResponse, session: Session): void {
  res.setHeader("Content-Type", "application/json");
  execFile("git", ["-C", session.cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeout: 1000 }, (err, stdout) => {
    if (err) { res.end(JSON.stringify({ branch: null })); return; }
    const branch = stdout.toString().trim();
    res.end(JSON.stringify({ branch: branch && branch !== "HEAD" ? branch : null }));
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
    return { id: e.id, type: e.type, parentId: e.parentId, timestamp: e.timestamp, role: e.message.role, preview: snippet(display, 80) };
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ leafId: session.store.getActiveLeaf(), rootId: session.store.getRootId(), entries: all }));
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
    await withContextLock(session, async () => {
      session.store!.setActiveLeaf(resolved);
      await applyBranchMessages(session);
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, leafId: resolved }));
  } catch (err) {
    res.statusCode = 500;
    res.end(`fork failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function dropContext(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const body = await readBody(req);
  let indices: number[];
  try {
    const parsed = JSON.parse(body) as { indices?: number[] };
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
    const stats = await withContextLock(session, async () => {
      const snap = await session.bridge.snapshot();
      const drop = new Set(indices);
      const { kept, originalIndices } = buildKeptWithPlaceholders(snap.messages, drop);
      const keptEntryIds = session.capture
        ? originalIndices.map((i) => i === null ? null : session.capture!.getEntryIdAt(i))
        : null;
      const wire = keptEntryIds ? tagMessagesWithEntryIds(kept, keptEntryIds) : kept;
      const result = await session.bridge.compact({ kind: "replace", messages: wire });
      if (session.capture) {
        const sanitized = await session.bridge.snapshot();
        session.capture.resetTo(readEntryIdTags(sanitized.messages));
      }
      await truncateReplayAfterCompact(session);
      return result;
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stats }));
  } catch (err) {
    res.statusCode = 500;
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

function makePlaceholder(dropped: unknown[]): { role: "user"; content: string } {
  const lines = dropped.map((m) => `- ${summarizeMessage(m)}`);
  return {
    role: "user",
    content: `[${dropped.length} message(s) elided]\n${lines.join("\n")}`,
  };
}

async function truncateReplayAfterCompact(session: Session): Promise<void> {
  try {
    const snap = await session.bridge.snapshot();
    const messages = snap.messages as Array<{ role?: string }>;
    const remainingUserMsgs = messages.filter((m) => m?.role === "user").length;
    truncateReplayToTurnCount(session, remainingUserMsgs);
  } catch {}
}

function withContextLock<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  const prev = session.contextLock;
  let release!: () => void;
  session.contextLock = new Promise<void>((r) => { release = r; });
  return prev.then(fn).finally(release);
}

async function syncTreeAfterRewind(session: Session, newLength: number): Promise<void> {
  if (!session.store || !session.capture) return;
  if (newLength <= 0) {
    session.store.setActiveLeaf(session.store.getRootId());
    session.capture.resetTo([]);
    return;
  }
  const leafId = session.capture.getEntryIdAt(newLength - 1);
  if (!leafId) {
    throw new Error(`rewind target index ${newLength - 1} resolves to a synthetic slot (no tree entry); rewind to a concrete message position instead`);
  }
  session.store.setActiveLeaf(leafId);
  session.capture.truncateTo(newLength);
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

  const closeTurn = () => {
    if (!turnStarted) return;
    frames.push(sseFrame(meta("agent:response-done"), {}));
    frames.push(sseFrame(meta("agent:processing-done"), {}));
    turnStarted = false;
  };

  for (let idx = 0; idx < msgs.length; idx++) {
    const m = msgs[idx]!;
    if (entryIds[idx] === null && m.role === "user" && typeof m.content === "string") {
      closeTurn();
      const evictedCount = parseEvictedCount(m.content);
      frames.push(sseFrame(meta("hub:compaction-marker"), { evictedCount, summary: m.content }));
      continue;
    }
    if (m.role === "user") {
      closeTurn();
      frames.push(sseFrame(meta("agent:query"), { query: extractText(m.content) }));
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
        exitCode: 0,
        rawOutput: content,
        kind: "execute",
      }));
      continue;
    }
  }
  closeTurn();
  return frames;
}

async function rebuildReplay(
  session: Session,
  messages: unknown[],
  entryIds: (string | null)[] = [],
): Promise<void> {
  const frames = synthesizeBranchFrames(session, messages, entryIds);
  session.replay = frames;
  session.segmentText = "";
  session.segmentSeq = 0;
  for (const r of session.sseClients) {
    for (const f of frames) { try { r.write(f); } catch {} }
  }
  await persistReplayFile(session.id, frames);
}

async function applyBranchMessages(session: Session): Promise<void> {
  if (!session.store || !session.capture) throw new Error("tree store not attached");
  const { messages, entryIds } = session.store.buildBranchWithIds();
  const wire = tagMessagesWithEntryIds(messages, entryIds);
  await session.bridge.compact({ kind: "replace", messages: wire });
  const sanitized = await session.bridge.snapshot();
  const sanitizedIds = readEntryIdTags(sanitized.messages);
  session.capture.resetTo(sanitizedIds);
  await rebuildReplay(session, sanitized.messages, sanitizedIds);
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
  const replayQueryCount = session.replay.reduce(
    (n, f) => n + (parseFrameName(f) === "agent:query" ? 1 : 0),
    0,
  );
  if (keepCount > replayQueryCount) return;
  let agentQueryCount = 0;
  let truncateAt = session.replay.length;
  for (let i = 0; i < session.replay.length; i++) {
    if (parseFrameName(session.replay[i]!) === "agent:query") {
      if (agentQueryCount >= keepCount) { truncateAt = i; break; }
      agentQueryCount++;
    }
  }
  if (truncateAt < session.replay.length) {
    session.replay.length = truncateAt;
    void persistReplayFile(session.id, session.replay).catch(() => {});
  }
}

async function rewindContext(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const body = await readBody(req);
  let toIndex: number;
  try {
    const parsed = JSON.parse(body) as { toIndex?: number };
    toIndex = Number(parsed.toIndex);
  } catch {
    res.statusCode = 400; res.end("invalid body"); return;
  }
  if (!Number.isInteger(toIndex) || toIndex < 0) {
    res.statusCode = 400; res.end("toIndex must be a non-negative integer"); return;
  }
  try {
    const stats = await withContextLock(session, async () => {
      const result = await session.bridge.compact({ kind: "rewind", toIndex });
      await syncTreeAfterRewind(session, toIndex);
      await truncateReplayAfterCompact(session);
      return result;
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stats }));
  } catch (err) {
    res.statusCode = 500;
    res.end(`rewind failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Atomically find a user message by its turn number and rewind the context
 * to drop everything from that message onward.  This avoids the TOCTOU race
 * where the client fetches context then rewinds in two separate requests.
 */
async function rewindToTurn(req: http.IncomingMessage, res: http.ServerResponse, session: Session): Promise<void> {
  const body = await readBody(req);
  let turn: number;
  try {
    const parsed = JSON.parse(body) as { turn?: number };
    turn = Number(parsed.turn);
  } catch {
    res.statusCode = 400; res.end("invalid body"); return;
  }
  if (!Number.isInteger(turn) || turn < 0) {
    res.statusCode = 400; res.end("turn must be a non-negative integer"); return;
  }
  try {
    const stats = await withContextLock(session, async () => {
      const snap = await session.bridge.snapshot();
      const msgs = snap.messages as Array<{ role?: string }>;
      let seen = 0;
      let toIndex = -1;
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i]?.role === "user") {
          if (seen === turn) { toIndex = i; break; }
          seen++;
        }
      }
      let result: unknown = null;
      // Snapshot may report fewer user msgs than the replay has agent:query
      // frames (legacy sessions, prior compacts). Truncate the replay
      // regardless so the UI matches the kernel state.
      if (toIndex !== -1) {
        result = await session.bridge.compact({ kind: "rewind", toIndex });
        await syncTreeAfterRewind(session, toIndex);
      }
      truncateReplayToTurnCount(session, turn);
      return result;
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stats }));
  } catch (err) {
    res.statusCode = 500;
    res.end(`rewind-to-turn failed: ${err instanceof Error ? err.message : err}`);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", () => resolve(""));
  });
}

function serveStatic(res: http.ServerResponse, root: string, urlPath: string): void {
  // Normalize and resolve to absolute path to prevent directory traversal
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(path.join(resolvedRoot, urlPath));
  if (!filePath.startsWith(resolvedRoot + path.sep) && filePath !== resolvedRoot) {
    res.statusCode = 403; res.end(); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.statusCode = 404; res.end("not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  });
}
