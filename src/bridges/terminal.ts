import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as pty from "node-pty";
import type { Bridge, BridgeOpts, BusEvent, ContextSnapshot, ContextStrategy } from "./types.js";

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

function defaultShell(): { path: string; args: string[] } {
  if (process.platform === "win32") {
    const comspec = process.env.COMSPEC;
    if (comspec) return { path: comspec, args: [] };
    return { path: "powershell.exe", args: ["-NoLogo", "-NoExit"] };
  }
  return { path: process.env.SHELL ?? "/bin/bash", args: [] };
}

export class TerminalBridge extends EventEmitter implements Bridge {
  readonly kind = "terminal" as const;
  private proc: pty.IPty | null = null;
  private closed = false;
  private initPromise: Promise<void>;
  private cols = DEFAULT_COLS;
  private rows = DEFAULT_ROWS;

  constructor(opts: BridgeOpts) {
    super();
    const extra = (opts.extra ?? {}) as { cols?: number; rows?: number; shell?: string };
    if (typeof extra.cols === "number" && extra.cols > 0) this.cols = extra.cols;
    if (typeof extra.rows === "number" && extra.rows > 0) this.rows = extra.rows;
    const shell = extra.shell ?? defaultShell();
    if (typeof shell === "string") {
      this.initPromise = this.spawn(shell, [], opts.cwd ?? os.homedir());
    } else {
      this.initPromise = this.spawn(shell.path, shell.args, opts.cwd ?? os.homedir());
    }
  }

  private async spawn(shellPath: string, shellArgs: string[], cwd: string): Promise<void> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    // On Windows, TERM=xterm-256color can confuse cmd.exe; use a safe default.
    if (process.platform === "win32") {
      env.TERM = "xterm-256color";
    } else {
      env.TERM = env.TERM && env.TERM !== "dumb" ? env.TERM : "xterm-256color";
    }
    env.COLORTERM = env.COLORTERM ?? "truecolor";

    const proc = pty.spawn(shellPath, shellArgs, {
      name: env.TERM,
      cols: this.cols,
      rows: this.rows,
      cwd,
      env,
      ...(process.platform === "win32" ? { conptyInheritCursor: false } : {}),
    });
    this.proc = proc;

    proc.onData((data: string) => {
      this.emit("event", { name: "shell:pty-data", payload: { raw: data } } satisfies BusEvent);
    });
    proc.onExit(({ exitCode, signal }) => {
      this.emit("event", { name: "shell:exit", payload: { exitCode, signal } } satisfies BusEvent);
      this.closed = true;
      this.emit("closed");
    });
  }

  ready(): Promise<void> {
    return this.initPromise;
  }

  isProcessing(): boolean {
    return false;
  }

  submit(_text: string): Promise<{ stopReason: string }> {
    return Promise.reject(new Error("terminal sessions do not accept agent submissions"));
  }

  cancel(): void {}

  writePty(data: string): void {
    if (this.closed || !this.proc) return;
    this.proc.write(data);
  }

  resizePty(cols: number, rows: number): void {
    if (this.closed || !this.proc) return;
    this.cols = cols;
    this.rows = rows;
    try { this.proc.resize(cols, rows); } catch {}
  }

  snapshot(): Promise<ContextSnapshot> {
    return Promise.resolve({ messages: [], contextWindow: 0, activeTokens: 0 });
  }

  compact(_strategy: ContextStrategy): Promise<{ before: number; after: number; evictedCount: number } | null> {
    return Promise.resolve(null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.proc?.kill(); } catch {}
    this.emit("closed");
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
}
