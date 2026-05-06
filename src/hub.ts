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
import type { Bridge, BridgeFactory, BusEvent } from "./bridges/types.js";

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
  cwd: string;
  bridge: Bridge;
  replay: string[];
  segmentText: string;
  segmentSeq: number;
  sseClients: Set<http.ServerResponse>;
  model?: string;
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
}

const REPLAY_LIMIT = 5000;
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

async function saveSessionMeta(session: Session): Promise<void> {
  await ensureSessionsDir();
  const meta = { id: session.id, title: session.title, cwd: session.cwd, model: session.model, startedAt: session.startedAt, firstQuery: session.firstQuery, userTitle: session.userTitle };
  await fs.promises.writeFile(path.join(SESSIONS_DIR, `${session.id}.meta.json`), JSON.stringify(meta));
}

// ── Batched replay persistence ─────────────────────────────────────────
// Writing synchronously on every SSE frame (appendFileSync per token) causes
// UI jank during streaming at 10–50 tokens/sec.  Instead we accumulate frames
// in memory and flush them in batches with async I/O.
//
// persistReplayFile (bulk overwrite on context compaction) drains the buffer
// first so the file is never corrupted by interleaved writes.  A per-session
// write-lock (Promise) tracks in-flight async flushes so drain() can await
// their completion before truncating.

const _writeBufs = new Map<string, { frames: string[]; timer: ReturnType<typeof setTimeout> | null }>();
const _writeLocks = new Map<string, Promise<void>>();
const BATCH_FLUSH_MS = 2000;

function _flushBuf(sessionId: string): void {
  const buf = _writeBufs.get(sessionId);
  if (!buf || buf.frames.length === 0) return;
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
  const frames = buf.frames.splice(0);
  // Ensure the sessions directory exists (mkdirSync is cheap when the dir
  // already exists, which it almost always does after the first write).
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch { /* ignore */ }
  const p = new Promise<void>((resolve) => {
    fs.appendFile(
      path.join(SESSIONS_DIR, `${sessionId}.replay.jsonl`),
      frames.join(""),
      () => { _writeLocks.delete(sessionId); resolve(); },
    );
  });
  _writeLocks.set(sessionId, p);
}

async function _drainBuf(sessionId: string): Promise<void> {
  // Wait for any in-flight async flush to complete before touching the file.
  const lock = _writeLocks.get(sessionId);
  if (lock) await lock;
  const buf = _writeBufs.get(sessionId);
  if (!buf || buf.frames.length === 0) return;
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
  const frames = buf.frames.splice(0);
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.appendFileSync(path.join(SESSIONS_DIR, `${sessionId}.replay.jsonl`), frames.join(""));
  } catch { /* ignore */ }
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

async function persistReplayFile(sessionId: string, frames: string[]): Promise<void> {
  // Drain any buffered frames and wait for in-flight async writes before
  // overwriting so the file is never corrupted.
  await _drainBuf(sessionId);
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SESSIONS_DIR, `${sessionId}.replay.jsonl`), frames.join(""));
  } catch {
    // Ignore write errors
  }
}

async function deleteSessionFiles(id: string): Promise<void> {
  try { await fs.promises.unlink(path.join(SESSIONS_DIR, `${id}.meta.json`)); } catch {}
  try { await fs.promises.unlink(path.join(SESSIONS_DIR, `${id}.replay.jsonl`)); } catch {}
  try { await fs.promises.unlink(path.join(SESSIONS_DIR, `${id}.messages.json`)); } catch {}
}

async function saveSessionMessages(session: Session): Promise<void> {
  try {
    await ensureSessionsDir();
    const snap = await session.bridge.snapshot();
    if (snap.messages.length === 0) return;
    await fs.promises.writeFile(
      path.join(SESSIONS_DIR, `${session.id}.messages.json`),
      JSON.stringify(snap.messages),
    );
  } catch {
    // Ignore write errors
  }
}

interface PersistedSession {
  id: string;
  title?: string;
  cwd: string;
  model?: string;
  startedAt: number;
  replay: string[];
  messages?: unknown[];
  firstQuery?: string;
  userTitle?: string;
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
        results.push({ id: meta.id || id, title: meta.title, cwd: meta.cwd, model: meta.model, startedAt: meta.startedAt, replay, messages, firstQuery: meta.firstQuery, userTitle: meta.userTitle });
      } catch {}
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
    if (req.method === "GET" && url === "/sessions") return listSessions(res, sessions);
    if (req.method === "GET" && url.startsWith("/fs")) {
      const params = new URLSearchParams(url.split("?")[1] ?? "");
      return listDirs(res, params.get("prefix") ?? "");
    }
    if (req.method === "GET" && url === "/pick-dir") return pickDir(res);
    if (req.method === "POST" && url === "/sessions") return spawnSession(req, res, sessions, opts);

    const m = url.match(/^\/([0-9a-f]{4,32})(\/.*)?$/);
    if (m) {
      const id = m[1]!;
      const rest = m[2] ?? "/";
      const session = sessions.get(id);
      if (!session) { res.statusCode = 404; res.end("no session"); return; }

      if (rest === "/events") return openSse(req, res, session);
      if (req.method === "POST" && rest === "/submit") return submit(req, res, session);
      if (req.method === "POST" && rest === "/command") return execCommand(req, res, session);
      if (req.method === "POST" && rest === "/title") return updateTitle(req, res, session);
      if (req.method === "POST" && rest === "/generate-title") return generateTitle(req, res, session);
      if (req.method === "GET" && rest.startsWith("/autocomplete")) {
        const q = url.split("?")[1] ?? "";
        const params = new URLSearchParams(q);
        return autocomplete(res, session, params.get("buffer") ?? "");
      }
      if (req.method === "POST" && rest === "/cancel") {
        try { session.bridge.cancel(); } catch (err) { console.error("[hub] cancel:", err); }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "GET" && rest === "/files") return listFiles(res, session);
      if (req.method === "GET" && rest === "/context") return getContext(res, session);
      if (req.method === "POST" && rest === "/context/rewind") return rewindContext(req, res, session);
      if (req.method === "POST" && rest === "/context/rewind-to-turn") return rewindToTurn(req, res, session);
      if (req.method === "POST" && rest === "/context/drop") return dropContext(req, res, session);
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
  existing?: { id: string; title?: string; replay: string[]; startedAt: number; messages?: unknown[]; firstQuery?: string; userTitle?: string; model?: string },
): Promise<Session> {
  const id = existing?.id ?? randomBytes(3).toString("hex");
  const bridge = opts.makeBridge({ cwd, initialMessages: existing?.messages, model: existing?.model });

  const session: Session = {
    id,
    title: existing?.title ?? id,
    cwd,
    bridge,
    replay: existing?.replay ?? [],
    segmentText: "",
    segmentSeq: 0,
    sseClients: new Set(),
    model: existing?.model,
    startedAt: existing?.startedAt ?? Date.now(),
    // If the session already has messages, the first turn was already done.
    firstTurnDone: !!(existing?.messages?.length),
    firstQuery: existing?.firstQuery,
    userTitle: existing?.userTitle,
    lastActivity: Date.now(),
    toolsRunning: 0,
  };

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
  sessions.set(id, session);
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
  const persisted = await loadPersistedSessions();
  if (persisted.length === 0) return;
  console.error(`[hub] restoring ${persisted.length} session(s)…`);
  for (const p of persisted) {
    try {
      await createSession(sessions, opts, p.cwd, { id: p.id, title: p.title, replay: p.replay, startedAt: p.startedAt, messages: p.messages, firstQuery: p.firstQuery, userTitle: p.userTitle, model: p.model });
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
    const query = (e.payload as { query?: string })?.query ?? "";
    pushFrame(session, "agent:query", sseFrame({ ...meta, name: "agent:query" }, { query }));
    pushFrame(session, "agent:processing-start", sseFrame({ ...meta, name: "agent:processing-start" }, {}));
    return;
  }

  if (e.name === "agent:queued-done") {
    flushSegment(session);
    pushFrame(session, "agent:processing-done", sseFrame({ ...meta, name: "agent:processing-done" }, {}));
    // Mirror submit()'s .then() handler for queued turns: persist messages
    // so restarted sessions restore their state, and auto-generate a title
    // after the first completed turn.
    saveSessionMessages(session).catch(() => {});
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
    const info = e.payload as { model?: string } | undefined;
    if (info?.model) session.model = info.model;
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
  return `data: ${JSON.stringify({ meta, payload })}\n\n`;
}

function pushFrame(session: Session, name: string, frame: string): void {
  if (REPLAY_NAMES.has(name)) {
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
  await saveSessionMeta(session);
  const frame = sseFrame(
    { source: session.id, ts: Date.now(), id: `hub:${session.id}:title`, name: "session:title" },
    { title: session.title },
  );
  pushFrame(session, "session:title", frame);
}

async function generateTitleAsync(session: Session): Promise<void> {
  const query = session.firstQuery?.trim();
  // Skip if no query captured, or if user already set a custom title manually.
  if (!query || session.userTitle) return;

  const settings = await readSettings();
  const provider: string = (settings?.defaultProvider as string) || (settings?.provider as string) || "openai";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: any = settings?.providers ?? {};
  const providerCfg = providers[provider] as { apiKey?: string; baseURL?: string; model?: string; defaultModel?: string } | undefined;
  const apiKey = (providerCfg?.apiKey as string) || (settings?.apiKey as string);
  if (!apiKey) return;

  const model = (providerCfg?.defaultModel ?? providerCfg?.model ?? settings?.model ?? "gpt-4o-mini") as string;
  const baseURL = (providerCfg?.baseURL ?? settings?.baseURL ?? "https://api.openai.com/v1") as string;
  const url = baseURL.replace(/\/+$/, "") + "/chat/completions";

  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: "You are a title generator. Given a user's first message to an AI assistant, generate a concise, descriptive title (max 6 words, no quotes). Return ONLY the title text, nothing else." },
      { role: "user", content: `Generate a short title for a conversation that starts with: "${query}"` },
    ],
    max_tokens: 80,
    temperature: 0.3,
    thinking: { type: "disabled" },
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body,
      signal: controller.signal,
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const title = data?.choices?.[0]?.message?.content?.trim().replace(/^"|"$/g, "") ?? "";
    if (title && !session.userTitle) await setSessionTitle(session, title);
  } catch {
    // Silently ignore — title generation is a best-effort feature
  } finally {
    clearTimeout(timeout);
  }
}

async function readSettings(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.promises.readFile(settingsPath(), "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── HTTP handlers ───────────────────────────────────────────────────

function listSessions(res: http.ServerResponse, sessions: Map<string, Session>): void {
  const list = Array.from(sessions.values()).map((s) => ({
    instanceId: s.id,
    title: s.title,
    model: s.model,
    cwd: s.cwd,
    startedAt: s.startedAt,
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
  let cwd = process.cwd();
  try {
    const parsed = JSON.parse(body) as { cwd?: string };
    if (parsed.cwd) cwd = path.resolve(expandHome(parsed.cwd.trim()));
  } catch {}
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
    const s = await createSession(sessions, opts, cwd);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ instanceId: s.id, cwd: s.cwd }));
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

async function listFiles(res: http.ServerResponse, session: Session): Promise<void> {
  const cwd = session.cwd;
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(cwd, { withFileTypes: true }); }
  catch {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cwd, files: [] }));
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
  res.end(JSON.stringify({ cwd, files }));
}

function closeSession(res: http.ServerResponse, sessions: Map<string, Session>, id: string): void {
  const s = sessions.get(id);
  if (s) {
    try { s.bridge.close(); } catch {}
    sessions.delete(id);
  }
  // Drop any pending buffered frames and release the in-memory write-buffer
  // / lock entries for this session.  (The replay file is deleted below, so
  // flushing would be wasted I/O.)
  const buf = _writeBufs.get(id);
  if (buf?.timer) { clearTimeout(buf.timer); }
  _writeBufs.delete(id);
  _writeLocks.delete(id);
  deleteSessionFiles(id);
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

function openSse(req: http.IncomingMessage, res: http.ServerResponse, session: Session): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`: connected ${session.id}\n\n`);
  for (const line of session.replay) {
    try { res.write(line); } catch { return; }
  }
  session.sseClients.add(res);
  req.on("close", () => session.sseClients.delete(res));
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

  const queued = !!session.bridge.isProcessing?.();
  if (!queued) {
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
      pushFrame(session, "agent:processing-done", sseFrame(meta("agent:processing-done"), {}));
      // Persist messages snapshot so restarted sessions restore their
      // conversation state (not just SSE replay frames).
      saveSessionMessages(session).catch(() => {});

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
      pushFrame(session, "agent:error", sseFrame(meta("agent:error"), { message: String(err) }));
    });

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
    const snap = await session.bridge.snapshot();
    const drop = new Set(indices);
    const kept = buildKeptWithPlaceholders(snap.messages, drop);
    const stats = await session.bridge.compact({ kind: "replace", messages: kept });
    await truncateReplayAfterCompact(session);
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
function buildKeptWithPlaceholders(messages: unknown[], drop: Set<number>): unknown[] {
  const kept: unknown[] = [];
  let i = 0;
  while (i < messages.length) {
    if (!drop.has(i)) { kept.push(messages[i]); i++; continue; }
    const run: unknown[] = [];
    while (i < messages.length && drop.has(i)) { run.push(messages[i]); i++; }
    kept.push(makePlaceholder(run));
  }
  return kept;
}

function makePlaceholder(dropped: unknown[]): { role: "user"; content: string } {
  // Deterministic placeholder: uses a fixed format regardless of the
  // dropped messages' actual content. This preserves cache prefix stability
  // — the same count of dropped messages always yields the exact same
  // placeholder text, so subsequent model requests can hit KV cache.
  return {
    role: "user",
    content: `[${dropped.length} message(s) elided]`,
  };
}

function summarizeMessage(m: unknown): string {
  const msg = m as { role?: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string } }> };
  const role = msg?.role ?? "?";
  if (role === "assistant" && Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
    const tools = msg.tool_calls.map((tc) => tc?.function?.name ?? "tool").join(", ");
    const text = extractText(msg.content);
    const prefix = text ? `${snippet(text, 60)} → ` : "";
    return `assistant: ${prefix}called ${tools}`;
  }
  if (role === "tool") {
    const text = typeof msg?.content === "string" ? msg.content : extractText(msg?.content);
    return `tool result: ${snippet(text, 80)}`;
  }
  return `${role}: ${snippet(extractText(msg?.content), 100)}`;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === "string") return p;
      const part = p as { text?: string; content?: string };
      return part?.text ?? part?.content ?? "";
    }).join(" ");
  }
  return "";
}

function snippet(text: string, max: number): string {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned || "(empty)";
  return cleaned.slice(0, max) + "…";
}

/**
 * Truncate the session replay buffer so that reconnecting SSE clients don't
 * see deleted messages reappear.  Must be called after the bridge context has
 * been compacted (so snapshot() reflects the new message count).
 */
async function truncateReplayAfterCompact(session: Session): Promise<void> {
  try {
    const snap = await session.bridge.snapshot();
    const messages = snap.messages as Array<{ role?: string }>;
    const remainingUserMsgs = messages.filter((m) => m?.role === "user").length;
    let agentQueryCount = 0;
    let truncateAt = session.replay.length;
    for (let i = 0; i < session.replay.length; i++) {
      const frame = session.replay[i]!;
      let name = "";
      try {
        const inner = JSON.parse(frame.replace(/^data:\s*/, "").trimEnd());
        name = (inner?.meta?.name ?? "") as string;
      } catch { /* malformed frame — skip */ }
      if (name === "agent:query") {
        if (agentQueryCount >= remainingUserMsgs) {
          truncateAt = i;
          break;
        }
        agentQueryCount++;
      }
    }
    if (truncateAt < session.replay.length) {
      session.replay.length = truncateAt;
      await persistReplayFile(session.id, session.replay);
    }
  } catch {
    // If replay truncation fails, the rewind is still valid.
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
    const stats = await session.bridge.compact({ kind: "rewind", toIndex });
    await truncateReplayAfterCompact(session);
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
    if (toIndex === -1) {
      res.statusCode = 404;
      res.end(`turn ${turn} not found in context`);
      return;
    }
    const stats = await session.bridge.compact({ kind: "rewind", toIndex });
    await truncateReplayAfterCompact(session);
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
