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
    });

    this.child.stdout!.setEncoding("utf-8");
    this.child.stdout!.on("data", (chunk: string) => this.onChunk(chunk));
    this.child.on("close", () => {
      this.emit("closed");
      for (const p of this.pending.values()) p.reject(new Error("child closed"));
      this.pending.clear();
    });
    this.child.on("error", (err) => this.emit("error", err));

    this.initPromise = this.initialize(opts.cwd);
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
    return this.request("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }],
    }) as Promise<{ stopReason: string }>;
  }

  cancel(): void {
    if (!this.sessionId) return;
    this.notify("session/cancel", { sessionId: this.sessionId });
  }

  close(): void {
    for (const p of this.pendingAcpPermissions.values()) {
      p.resolve(p.options.find((o) => o.id.includes("deny"))?.id ?? "deny");
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

      this.emit("event", {
        name: "permission:request",
        payload: {
          requestId: `${this.sessionId}:${requestId}`,
          kind,
          title,
          description,
        },
      });

      // 30-second timeout: auto-deny if no response from the hub.
      const timer = setTimeout(() => {
        const p = this.pendingAcpPermissions.get(requestId);
        if (p) {
          p.resolve(options.find((o) => o.id.includes("deny"))?.id ?? "deny");
          this.pendingAcpPermissions.delete(requestId);
        }
      }, 30_000);

      this.pendingAcpPermissions.set(requestId, {
        resolve: (optionId) => {
          clearTimeout(timer);
          this.send({
            jsonrpc: "2.0",
            id: requestId,
            result: {
              outcome: {
                outcome: optionId.includes("deny") ? "denied" : "selected",
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
    const acpId = requestId.includes(":") ? requestId.split(":").pop()! : requestId;
    const key = Number.isNaN(Number(acpId)) ? acpId : Number(acpId);
    const pending = this.pendingAcpPermissions.get(key);
    if (!pending) return;

    if (outcome === "approved") {
      // Pick the first non-deny option, preferring session-wide ("always") variants.
      const always = sessionWide
        ? pending.options.find((o) => o.id.includes("always"))
        : undefined;
      const allow = pending.options.find((o) => !o.id.includes("deny"));
      pending.resolve(always?.id ?? allow?.id ?? "allow_once");
    } else {
      pending.resolve(pending.options.find((o) => o.id.includes("deny"))?.id ?? "deny");
    }
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
