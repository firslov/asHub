/**
 * AcpBridge — spawns an ACP-speaking subprocess (e.g. agent-sh-acp,
 * Claude Code's ACP server) and translates `session/update` notifications
 * into BusEvents the hub broadcasts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Translator } from "./translator.js";
import type { Bridge, BridgeOpts, BusEvent, ContextSnapshot, ContextStrategy } from "./types.js";

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
  id: string;
  label: string;
  kind?: string;
}

/** Parsed ACP session/request_permission params. */
interface AcpPermissionRequest {
  sessionId?: string;
  kind?: string;
  description?: string;
  options?: AcpPermissionOption[];
}

/** Stored state for a pending permission request. */
interface PendingPermission {
  resolve: (optionId: string) => void;
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
  if (!raw) return "file-write";
  return ACP_KIND_MAP[raw] ?? raw.replace(/_/g, "-");
}

// ── Permission option classification ──
// The ACP spec vocabulary is allow_once / allow_always / reject_once /
// reject_always, and ids usually mirror the kind (no "deny" substring).
// Classify by option.kind first, then by id prefix, and only then fall back
// to the legacy "deny"-substring heuristic.

type OptionClass = "allow" | "reject" | "unknown";

function classifyOption(o: AcpPermissionOption): OptionClass {
  const kind = o.kind ?? "";
  if (kind.startsWith("allow_")) return "allow";
  if (kind.startsWith("reject_")) return "reject";
  if (/^allow([_-]|$)/.test(o.id)) return "allow";
  if (/^reject([_-]|$)/.test(o.id)) return "reject";
  if (o.id.includes("deny")) return "reject";
  return "unknown";
}

function isAlwaysOption(o: AcpPermissionOption): boolean {
  return o.kind?.endsWith("_always") === true || o.id.includes("always");
}

/** Option id to answer a denial with: reject_once, else any reject variant. */
function pickRejectOption(options: AcpPermissionOption[]): string {
  const rejects = options.filter((o) => classifyOption(o) === "reject");
  return rejects.find((o) => !isAlwaysOption(o))?.id ?? rejects[0]?.id ?? "reject_once";
}

/** Option id to answer an approval with. */
function pickAllowOption(options: AcpPermissionOption[], sessionWide?: boolean): string {
  const allows = options.filter((o) => classifyOption(o) === "allow");
  if (sessionWide) {
    const always = allows.find((o) => isAlwaysOption(o));
    if (always) return always.id;
  }
  const once = allows.find((o) => !isAlwaysOption(o));
  if (once) return once.id;
  if (allows[0]) return allows[0].id;
  // Legacy fallback: first option that doesn't look like a denial.
  return options.find((o) => classifyOption(o) !== "reject")?.id
    ?? (sessionWide ? "allow_always" : "allow_once");
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
  private child: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private pendingAcpPermissions = new Map<number | string, PendingPermission>();
  private sessionId: string | null = null;
  private initPromise: Promise<void>;
  private translator = new Translator();

  constructor(opts: BridgeOpts) {
    super();
    const extra = (opts.extra ?? {}) as Partial<AcpBridgeExtra>;
    if (!extra.command) throw new Error("AcpBridge requires extra.command");

    this.child = spawn(extra.command, extra.args ?? [], {
      cwd: opts.cwd ?? process.cwd(),
      env: extra.env ?? process.env,
      stdio: ["pipe", "pipe", "inherit"],
      // On Windows, globally installed npm commands are .cmd shims that can
      // only run through a shell. Node quotes each arg correctly when
      // shell:true is used, so args with spaces still survive.
      shell: process.platform === "win32",
    });

    this.child.stdout!.setEncoding("utf-8");
    this.child.stdout!.on("data", (chunk: string) => this.onChunk(chunk));
    this.child.on("close", () => {
      this.emit("closed");
      for (const p of this.pending.values()) p.reject(new Error("child closed"));
      this.pending.clear();
    });
    this.child.on("error", (err) => this.emit("error", err));

    this.initPromise = withTimeout(this.initialize(opts.cwd), INIT_TIMEOUT_MS, "ACP initialize/session/new")
      .catch((err) => {
        // A child that never answers initialize is not an ACP server; don't
        // leave it running after the hub gives up on the bridge.
        try { this.child.kill(); } catch {}
        throw err;
      });
  }

  private async initialize(cwd?: string): Promise<void> {
    await this.request("initialize", { protocolVersion: "0.1.0" });
    const newRes = await this.request("session/new", {
      cwd: cwd ?? process.cwd(),
      mcpServers: [],
    }) as { sessionId: string };
    this.sessionId = newRes.sessionId;
  }

  ready(): Promise<void> { return this.initPromise; }

  async submit(text: string): Promise<{ stopReason: string }> {
    await this.initPromise;
    if (!this.sessionId) throw new Error("session not initialized");

    // The hub encodes multimodal submissions as JSON { query, images } (see
    // hub.ts submit()). ACP children have no universally-supported image
    // block — the reference ash-acp-bridge extracts only text/resource
    // blocks and silently drops everything else. Forwarding the raw JSON
    // verbatim would corrupt the prompt with an escaped object literal, so
    // parse it, keep only the query, and let the child ignore the images.
    let query = text;
    try {
      const parsed = JSON.parse(text) as { query?: unknown; images?: unknown };
      if (typeof parsed.query === "string" && Array.isArray(parsed.images)) {
        query = parsed.query;
      }
    } catch { /* plain text */ }

    return this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text: query }],
    }) as Promise<{ stopReason: string }>;
  }

  cancel(): void {
    if (!this.sessionId) return;
    this.notify("session/cancel", { sessionId: this.sessionId });
  }

  close(): void {
    for (const p of this.pendingAcpPermissions.values()) {
      p.resolve(pickRejectOption(p.options));
    }
    this.pendingAcpPermissions.clear();
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
      this.dispatch(msg);
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
        for (const e of this.translator.translateUpdate(params.update)) {
          this.emit("event", e);
        }
      }
    }
  }

  private handleRequest(msg: JsonRpcMessage): void {
    if (msg.method === "session/request_permission") {
      const requestId = msg.id!;
      const params = (msg.params ?? {}) as AcpPermissionRequest;
      const options = params.options ?? [];
      const kind = mapAcpKind(params.kind);
      const title = params.description?.trim()
        || params.options?.map((o) => o.label).join(" / ")
        || "ACP permission request";
      const description = params.description?.trim() || "";

      // Public id the hub round-trips back to decidePermission. The raw ACP
      // id may itself contain ":", so the pending map is keyed by this exact
      // string — no delimiter-based decoding on the way back.
      const publicRequestId = `${this.sessionId}:${requestId}`;
      this.emit("event", {
        name: "permission:request",
        payload: {
          requestId: publicRequestId,
          kind,
          title,
          description,
        },
      });

      // 30-second timeout: auto-deny if no response from the hub.
      const timer = setTimeout(() => {
        const p = this.pendingAcpPermissions.get(publicRequestId);
        if (p) {
          p.resolve(pickRejectOption(options));
          this.pendingAcpPermissions.delete(publicRequestId);
        }
      }, 30_000);

      this.pendingAcpPermissions.set(publicRequestId, {
        resolve: (optionId) => {
          clearTimeout(timer);
          const chosen = options.find((o) => o.id === optionId);
          this.send({
            jsonrpc: "2.0",
            id: requestId,
            result: {
              outcome: {
                outcome: chosen && classifyOption(chosen) === "reject" ? "denied" : "selected",
                optionId,
              },
            },
          });
        },
        options,
      });
      return;
    }
    this.send({ jsonrpc: "2.0", id: msg.id!, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }

  decidePermission(requestId: string, outcome: string, sessionWide?: boolean): void {
    // Keyed by the exact public id emitted in permission:request — the raw
    // ACP id may contain ":", so delimiter-based decoding would rebuild the
    // wrong key.
    let key: number | string = requestId;
    let pending = this.pendingAcpPermissions.get(key);
    if (!pending) {
      // Tolerate callers that pass the raw ACP id.
      const raw: number | string = Number.isNaN(Number(requestId)) ? requestId : Number(requestId);
      pending = this.pendingAcpPermissions.get(raw);
      if (pending) key = raw;
    }
    if (!pending) return;

    pending.resolve(outcome === "approved"
      ? pickAllowOption(pending.options, sessionWide)
      : pickRejectOption(pending.options));
    this.pendingAcpPermissions.delete(key);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: JsonRpcMessage): void {
    if (!this.child.stdin?.writable) return;
    try { this.child.stdin.write(JSON.stringify(msg) + "\n"); } catch {}
  }
}
