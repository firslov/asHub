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
  cwd: string;
  bridge: Bridge;
  replay: string[];
  segmentText: string;
  segmentSeq: number;
  sseClients: Set<http.ServerResponse>;
  model?: string;
  startedAt: number;
}

const REPLAY_LIMIT = 500;
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
  "agent:cancelled",
  "agent:error",
  "agent:queued",
  "agent:queued-submit",
  "agent:queued-done",
  "permission:request",
  "ui:info",
  "ui:error",
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
  const meta = { id: session.id, cwd: session.cwd, model: session.model, startedAt: session.startedAt };
  await fs.promises.writeFile(path.join(SESSIONS_DIR, `${session.id}.meta.json`), JSON.stringify(meta));
}

function persistReplayFrame(sessionId: string, frame: string): void {
  try {
    fs.appendFileSync(path.join(SESSIONS_DIR, `${sessionId}.replay.jsonl`), frame);
  } catch {
    // Ignore write errors (e.g. disk full)
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
  cwd: string;
  model?: string;
  startedAt: number;
  replay: string[];
  messages?: unknown[];
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
        results.push({ id: meta.id || id, cwd: meta.cwd, model: meta.model, startedAt: meta.startedAt, replay, messages });
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
      if (req.method === "GET" && rest === "/context") return getContext(res, session);
      if (req.method === "POST" && rest === "/context/rewind") return rewindContext(req, res, session);
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
      console.error(`agent-sh-hub listening on http://${opts.host}:${opts.port}/`);
    });
  });

  return server;
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
  existing?: { id: string; replay: string[]; startedAt: number; messages?: unknown[] },
): Promise<Session> {
  const id = existing?.id ?? randomBytes(3).toString("hex");
  const bridge = opts.makeBridge({ cwd, initialMessages: existing?.messages });

  const session: Session = {
    id,
    cwd,
    bridge,
    replay: existing?.replay ?? [],
    segmentText: "",
    segmentSeq: 0,
    sseClients: new Set(),
    startedAt: existing?.startedAt ?? Date.now(),
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
  if (!existing) await saveSessionMeta(session);
  return session;
}

async function restoreSessions(sessions: Map<string, Session>, opts: HubOpts): Promise<void> {
  const persisted = await loadPersistedSessions();
  if (persisted.length === 0) return;
  console.error(`[hub] restoring ${persisted.length} session(s)…`);
  for (const p of persisted) {
    try {
      await createSession(sessions, opts, p.cwd, { id: p.id, replay: p.replay, startedAt: p.startedAt, messages: p.messages });
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

// ── HTTP handlers ───────────────────────────────────────────────────

function listSessions(res: http.ServerResponse, sessions: Map<string, Session>): void {
  const list = Array.from(sessions.values()).map((s) => ({
    instanceId: s.id,
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

function closeSession(res: http.ServerResponse, sessions: Map<string, Session>, id: string): void {
  const s = sessions.get(id);
  if (s) {
    try { s.bridge.close(); } catch {}
    sessions.delete(id);
  }
  deleteSessionFiles(id);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
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

  const queued = !!session.bridge.isProcessing?.();
  if (!queued) {
    pushFrame(session, "agent:query", sseFrame(meta("agent:query"), { query }));
    pushFrame(session, "agent:processing-start", sseFrame(meta("agent:processing-start"), {}));
  }

  session.bridge.submit(query)
    .then((result) => {
      if (result.stopReason === "queued") {
        pushFrame(session, "agent:queued", sseFrame(meta("agent:queued"), { query }));
        return;
      }
      flushSegment(session);
      pushFrame(session, "agent:processing-done", sseFrame(meta("agent:processing-done"), {}));
      // Persist messages snapshot so restarted sessions restore their
      // conversation state (not just SSE replay frames).
      saveSessionMessages(session).catch(() => {});
    })
    .catch((err) => {
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, stats }));
  } catch (err) {
    res.statusCode = 500;
    res.end(`rewind failed: ${err instanceof Error ? err.message : err}`);
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
