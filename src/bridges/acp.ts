/**
 * AcpBridge — spawns an ACP-speaking subprocess (e.g. agent-sh-acp,
 * Claude Code's ACP server) and translates `session/update` notifications
 * into BusEvents the hub broadcasts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { Translator } from "./translator.js";
import type { Bridge, BridgeOpts, BusEvent, ContextSnapshot, ContextStrategy, PermissionOutcome } from "./types.js";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** ACP permission option as sent by the child process. */
interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

/** Parsed ACP session/request_permission params. */
interface AcpPermissionRequest {
  sessionId?: string;
  kind?: string;
  description?: string;
  toolCall?: { title?: string; kind?: string };
  options?: AcpPermissionOption[];
}

/** Stored state for a pending permission request. */
interface PendingPermission {
  resolve: (optionId: string | null, approved?: boolean) => PermissionOutcome | Promise<PermissionOutcome>;
  options: AcpPermissionOption[];
}

/** Maps ACP kind strings to the normalized kind sent in BusEvents. */
const ACP_KIND_MAP: Record<string, string> = {
  file_write: "file-write",
  file_read: "file-read",
  command_execute: "command-execute",
  network: "network",
};

function mapAcpKind(raw: string | undefined): string {
  if (typeof raw !== "string" || !raw) return "file-write";
  return ACP_KIND_MAP[raw] ?? raw.replace(/_/g, "-");
}

// ── Permission option classification ──
// The ACP spec vocabulary is allow_once / allow_always / reject_once /
// reject_always, and ids usually mirror the kind (no "deny" substring).
// Classify by option.kind first, then by id prefix, and only then fall back
// to the legacy "deny"-substring heuristic.

type OptionClass = "allow" | "reject" | "unknown";

function classifyOption(o: AcpPermissionOption): OptionClass {
  const kind = typeof o.kind === "string" ? o.kind : "";
  if (kind.startsWith("allow_")) return "allow";
  if (kind.startsWith("reject_")) return "reject";
  if (/^allow([_-]|$)/.test(o.optionId)) return "allow";
  if (/^reject([_-]|$)/.test(o.optionId)) return "reject";
  if (o.optionId.includes("deny")) return "reject";
  return "unknown";
}

// Only a declared once kind (or its standard ID for older agents) proves the scope.
function onceOption(options: AcpPermissionOption[], kind: "allow_once" | "reject_once") {
  return options.find(o => (o.kind ?? o.optionId) === kind);
}

function pickRejectOption(options: AcpPermissionOption[]): string | null {
  // Cancellation declines this request even if the agent only offers a permanent denial.
  return onceOption(options, "reject_once")?.optionId ?? null;
}

/** Keep the advertised desktop choice and the wire decision in sync. */
function extendedOption(options: AcpPermissionOption[]) {
  const always = options.find(o => (o.kind ?? o.optionId) === "allow_always");
  if (always || onceOption(options, "allow_once")) return always;
  // Some older agents only expose a label. Show their actual option on desktop
  // and require explicit confirmation rather than treating it as a one-time grant.
  return options.find(o => classifyOption(o) === "allow") ?? options.find(o => classifyOption(o) === "unknown");
}

const INIT_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms — the child process is not speaking ACP`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface AcpBridgeExtra {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

export class AcpBridge extends EventEmitter implements Bridge {
  readonly readOnlyContext = true;
  readonly backendId = "acp";
  readonly supportsImages = false;
  private transportError: Error | null = null;
  private child: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private pendingAcpPermissions = new Map<string, PendingPermission>();
  private approvalWrites = new Map<string, (outcome: PermissionOutcome) => void>();
  private sessionId: string | null = null;
  private initPromise: Promise<void>;
  private loading = false;
  private processing = false;
  private translator = new Translator();

  constructor(opts: BridgeOpts) {
    super();
    if (opts.restoreBackend && opts.restoreBackend !== this.backendId) throw new Error("This session belongs to another backend; restart with its original backend.");
    const extra = (opts.extra ?? {}) as Partial<AcpBridgeExtra>;
    if (!extra.command) throw new Error("AcpBridge requires extra.command");

    // Windows .cmd shims need cmd.exe escaping; native executables take an argument vector.
    const launch: typeof spawn = process.platform === "win32" ? createRequire(import.meta.url)("cross-spawn") : spawn;
    this.child = launch(extra.command, extra.args ?? [], {
      cwd: opts.cwd ?? process.cwd(),
      env: extra.env ?? process.env,
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.child.stdout!.setEncoding("utf-8");
    this.child.stdout!.on("data", (chunk: string) => this.onChunk(chunk));
    this.child.on("close", () => {
      this.transportError ??= new Error("ACP child closed");
      for (const p of this.pending.values()) p.reject(this.transportError);
      this.pending.clear();
      this.settlePermissions();
      this.emit("closed");
    });
    const transportFailed = (err: Error) => this.failTransport(err);
    this.child.on("error", transportFailed);
    this.child.stdin?.on?.("error", transportFailed);
    this.child.stdout?.on?.("error", transportFailed);

    this.initPromise = withTimeout(this.initialize(opts), INIT_TIMEOUT_MS, "ACP initialize/session/new")
      .catch((err) => {
        // A child that never answers initialize is not an ACP server; don't
        // leave it running after the hub gives up on the bridge.
        try { this.child.kill(); } catch {}
        throw err;
      });
  }

  private async initialize(opts: BridgeOpts): Promise<void> {
    const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} }) as {
      protocolVersion: number; agentCapabilities?: { loadSession?: boolean };
    };
    if (init.protocolVersion !== 1) throw new Error(`Unsupported ACP protocol version: ${init.protocolVersion}`);
    const cwd = opts.cwd ?? process.cwd();
    const oldId = opts.restoreState?.acpSessionId;
    if (opts.isRestored || opts.initialMessages?.length || oldId) {
      if (typeof oldId !== "string" || !init.agentCapabilities?.loadSession) {
        throw new Error("This ACP session cannot be resumed: no saved session ID or the agent does not support session/load. Create a new session to continue.");
      }
      this.loading = true;
      try {
        await this.request("session/load", { sessionId: oldId, cwd, mcpServers: [] });
        this.sessionId = oldId;
      } finally { this.loading = false; }
    } else {
      const result = await this.request("session/new", { cwd, mcpServers: [] }) as { sessionId: string };
      this.sessionId = result.sessionId;
    }
  }

  getRestoreState(): Record<string, unknown> { return { acpSessionId: this.sessionId }; }
  isProcessing(): boolean { return this.processing; }

  ready(): Promise<void> { return this.initPromise; }

  async submit(text: string): Promise<{ stopReason: string }> {
    await this.initPromise;
    if (!this.sessionId) throw new Error("session not initialized");
    if (this.processing) throw new Error("ACP turn already in progress");

    // Reject unsupported attachments instead of silently sending only text.
    let query = text;
    let parsed: { query?: unknown; images?: unknown } | null = null;
    try { parsed = JSON.parse(text); } catch { /* plain text */ }
    if (parsed && typeof parsed.query === "string" && Array.isArray(parsed.images)) {
      if (parsed.images.length) throw new Error("This ACP backend does not support image submissions");
      query = parsed.query;
    }

    this.processing = true;
    try { return await this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: query }],
    }) as { stopReason: string };
    } finally { this.processing = false; }
  }

  cancel(): void {
    if (this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
    // A turn cancellation cannot retract a decision already submitted to the pipe.
    this.cancelPendingPermissions();
  }

  settlePermissions(): void {
    for (const finish of this.approvalWrites.values()) finish("unconfirmed");
    this.cancelPendingPermissions();
  }

  private cancelPendingPermissions(): void {
    const pending = [...this.pendingAcpPermissions.values()];
    this.pendingAcpPermissions.clear();
    for (const p of pending) p.resolve(null);
  }

  close(): void {
    this.settlePermissions();
    try { this.child.stdin?.end(); } catch {}
    try { this.child.kill(); } catch {}
  }

  async snapshot(): Promise<ContextSnapshot> {
    throw new Error("ACP backend does not support context snapshot");
  }

  async compact(_strategy: ContextStrategy): Promise<{ before: number; after: number; evictedCount: number } | null> {
    throw new Error("ACP backend does not support context mutation");
  }

  onEvent(fn: (e: BusEvent) => void): () => void {
    this.on("event", fn);
    return () => this.off("event", fn);
  }
  onClose(fn: () => void): () => void {
    this.on("closed", fn);
    return () => this.off("closed", fn);
  }
  onError(fn: (err: Error) => void): () => void {
    this.on("error", fn);
    return () => this.off("error", fn);
  }

  // ── Wire ──

  private onChunk(chunk: string): void {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try { msg = JSON.parse(line); } catch { continue; }
      // A child owns only its own protocol stream, never the Hub process.
      if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0"
        || (msg.id !== undefined && typeof msg.id !== "string" && typeof msg.id !== "number")
        || (msg.method !== undefined && typeof msg.method !== "string")) continue;
      try { this.dispatch(msg); }
      catch (err) {
        this.emit("event", { name: "ui:error", payload: { message: `Invalid ACP message: ${String(err)}` } });
      }
    }
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      return;
    }

    if (msg.method && msg.id !== undefined) {
      this.handleRequest(msg);
      return;
    }

    if (msg.method === "session/update") {
      const params = msg.params as { update?: Record<string, unknown> };
      if (params?.update) {
        for (const e of this.loading ? [] : this.translator.translateUpdate(params.update)) {
          this.emit("event", e);
        }
      }
    }
  }

  private handleRequest(msg: JsonRpcMessage): void {
    if (msg.method === "session/request_permission") {
      const requestId = msg.id!;
      const params = (msg.params ?? {}) as AcpPermissionRequest;
      const options = (Array.isArray(params.options) ? params.options : []).filter(o => o && typeof o.optionId === "string" && typeof o.name === "string" && (o.kind === undefined || typeof o.kind === "string"));
      const kind = mapAcpKind(params.toolCall?.kind ?? params.kind);
      const title = (typeof params.toolCall?.title === "string" ? params.toolCall.title : "") || (typeof params.description === "string" ? params.description.trim() : "")
        || options.map((o) => o.name).join(" / ")
        || "ACP permission request";
      const description = typeof params.description === "string" ? params.description.trim() : "";

      // JSON-RPC IDs may be reused after a response. Each visible approval needs its own identity.
      const publicRequestId = randomUUID();

      // 30-second timeout: auto-deny if no response from the hub.
      const timer = setTimeout(() => {
        const p = this.pendingAcpPermissions.get(publicRequestId);
        if (p) {
          this.pendingAcpPermissions.delete(publicRequestId);
          p.resolve(pickRejectOption(options));
        } else this.approvalWrites.get(publicRequestId)?.("unconfirmed");
      }, 30_000);

      this.pendingAcpPermissions.set(publicRequestId, {
        resolve: (optionId, approved = false) => {
          const chosen = options.find(o => o.optionId === optionId);
          const outcome = chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" };
          const reply: JsonRpcMessage = { jsonrpc: "2.0", id: requestId, result: { outcome } };
          const report = (result: PermissionOutcome) => {
            clearTimeout(timer);
            this.emit("event", { name: "permission:resolved", payload: {
              requestId: publicRequestId, outcome: result,
            } });
            return result;
          };
          if (!approved || !chosen || this.transportError) {
            this.send(reply); return report("denied");
          }
          return new Promise<PermissionOutcome>(resolve => {
            const finish = (result: PermissionOutcome) => {
              if (!this.approvalWrites.delete(publicRequestId)) return;
              report(result); resolve(result);
            };
            this.approvalWrites.set(publicRequestId, finish);
            this.send(reply, err => finish(err ? "denied" : "approved"));
          });
        },
        options,
      });
      const extended = extendedOption(options);
      this.emit("event", {
        name: "permission:request",
        payload: {
          requestId: publicRequestId,
          kind,
          title,
          description,
          expiresAt: Date.now() + 30_000,
          requiresDesktop: !onceOption(options, "allow_once"),
          acpExtendedOption: extended?.name || extended?.optionId || null,
        },
      });
      return;
    }
    this.send({ jsonrpc: "2.0", id: msg.id!, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }

  decidePermission(requestId: string, outcome: string, sessionWide?: boolean): void | PermissionOutcome | Promise<PermissionOutcome> {
    const pending = this.pendingAcpPermissions.get(requestId);
    if (!pending) return;
    this.pendingAcpPermissions.delete(requestId);
    const allowed = sessionWide ? extendedOption(pending.options) : onceOption(pending.options, "allow_once");
    return pending.resolve(outcome === "approved" ? allowed?.optionId ?? null : pickRejectOption(pending.options), outcome === "approved");
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.transportError) return Promise.reject(this.transportError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private failTransport(err: Error): void {
    if (this.transportError) return;
    this.transportError = err;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
    // Initialization can fail before the Hub has installed its listener.
    if (this.listenerCount("error")) this.emit("error", err);
    this.close();
  }

  private send(msg: JsonRpcMessage, written?: (err?: Error | null) => void): void {
    if (this.transportError) { written?.(this.transportError); return; }
    try {
      if (!this.child.stdin?.writable) throw new Error("ACP input closed");
      this.child.stdin.write(JSON.stringify(msg) + "\n", written);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      written?.(error); this.failTransport(error);
    }
  }
}
