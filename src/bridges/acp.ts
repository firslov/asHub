/**
 * AcpBridge — spawns an ACP-speaking subprocess (e.g. agent-sh-acp,
 * Claude Code's ACP server) and translates `session/update` notifications
 * into BusEvents the hub broadcasts.
 *
 * Permission requests auto-approve until the web UI grows a prompt; that
 * decision lives here, not in the hub.
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
      this.send({ jsonrpc: "2.0", id: msg.id!, result: { outcome: { outcome: "selected", optionId: "accepted" } } });
      return;
    }
    this.send({ jsonrpc: "2.0", id: msg.id!, error: { code: -32601, message: `Method not found: ${msg.method}` } });
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
