/**
 * RemoteBridge — proxies Bridge methods to a remote ashub server reached
 * over an SSH-forwarded loopback port.  The remote runs AshBridge in its
 * own process; this is a transport-only shim.
 *
 * Sketch: enough to convey shape.  Production gaps (reconnect/resume on
 * tunnel drop, compact strategy mapping, BridgeOpts.initialMessages on
 * the remote spawn endpoint) are flagged inline.
 */
import { EventEmitter } from "node:events";
import type {
  Bridge, BridgeOpts, BusEvent, ContextSnapshot, ContextStrategy, SessionKind,
} from "./types.js";

// Frames the local hub synthesizes around bridge.submit() / queued submit /
// title flow.  The remote hub already wrote them into its own SSE stream;
// forwarding them through routeEvent would duplicate them on the local
// SSE.  RemoteBridge consumes lifecycle events for turn tracking but
// drops them before emitting to the local hub.
const HUB_SYNTHESIZED = new Set([
  "agent:query",
  "agent:processing-start",
  "agent:processing-done",
  "agent:response-segment",
  "agent:response-done",
  "agent:queued-submit",
  "agent:queued-done",
  "session:title",
  "hub:replay-done",
  "hub:compaction-marker",
]);

export interface RemoteBridgeOpts extends BridgeOpts {
  /** Loopback URL of the forwarded server.  Function form lets the host
   *  registry establish the SSH tunnel lazily on first use. */
  baseUrl: string | (() => Promise<string>);
  /** Existing remote session id; omit to spawn a fresh one. */
  remoteSessionId?: string;
}

export class RemoteBridge extends EventEmitter implements Bridge {
  readonly kind?: SessionKind;
  private baseUrlGetter: () => Promise<string>;
  private baseUrl: string = "";
  private sessionId: string | null = null;
  private initPromise: Promise<void>;
  private closed = false;
  private processing = false;
  private pendingTurn: { resolve: (v: { stopReason: string }) => void; reject: (e: Error) => void } | null = null;
  private sseAbort: AbortController | null = null;

  constructor(opts: RemoteBridgeOpts) {
    super();
    this.kind = opts.kind;
    this.baseUrlGetter = typeof opts.baseUrl === "function"
      ? opts.baseUrl
      : (() => Promise.resolve(opts.baseUrl as string));
    this.initPromise = this.init(opts);
  }

  private async init(opts: RemoteBridgeOpts): Promise<void> {
    this.baseUrl = (await this.baseUrlGetter()).replace(/\/$/, "");
    if (opts.remoteSessionId) {
      this.sessionId = opts.remoteSessionId;
    } else {
      // initialMessages still not plumbed remote-side; restored sessions
      // load from the remote hub's own on-disk store instead.
      const r = await fetch(`${this.baseUrl}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: opts.cwd,
          kind: opts.kind ?? "agent",
          model: opts.model,
          provider: opts.provider,
        }),
      });
      if (!r.ok) throw new Error(`remote /sessions failed: ${r.status} ${await r.text()}`);
      const j = await r.json() as { instanceId: string };
      this.sessionId = j.instanceId;
    }
    this.startSse();
  }

  private startSse(): void {
    if (!this.sessionId) return;
    this.sseAbort = new AbortController();
    void (async () => {
      try {
        const url = `${this.baseUrl}/events?subs=${this.sessionId}:all`;
        const r = await fetch(url, {
          headers: { Accept: "text/event-stream" },
          signal: this.sseAbort!.signal,
        });
        if (!r.ok || !r.body) throw new Error(`SSE connect failed: ${r.status}`);
        await this.consumeSse(r.body);
      } catch (err) {
        if (this.closed) return;
        // TODO: reconnect-with-Last-Event-ID on tunnel drop.  For now the
        // hub surfaces the error and the session goes dead.
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    })();
  }

  private async consumeSse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!this.closed) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        this.dispatchFrame(frame);
      }
    }
  }

  private dispatchFrame(frame: string): void {
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data: ")) data += line.slice(6);
    }
    if (!data) return;
    let parsed: { meta?: { name?: string }; payload?: unknown };
    try { parsed = JSON.parse(data); } catch { return; }
    const name = parsed.meta?.name;
    if (!name) return;
    this.trackTurnLifecycle(name, parsed.payload);
    if (HUB_SYNTHESIZED.has(name)) return;
    this.emit("event", { name, payload: parsed.payload } satisfies BusEvent);
  }

  private trackTurnLifecycle(name: string, payload: unknown): void {
    if (name === "agent:processing-start") {
      this.processing = true;
      return;
    }
    if (name === "agent:processing-done") {
      this.processing = false;
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.resolve({ stopReason: "end_turn" }); }
      return;
    }
    if (name === "agent:cancelled") {
      this.processing = false;
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.resolve({ stopReason: "cancelled" }); }
      return;
    }
    if (name === "agent:error") {
      this.processing = false;
      const t = this.pendingTurn;
      if (t) {
        this.pendingTurn = null;
        const msg = (payload as { message?: string } | undefined)?.message ?? "remote agent error";
        t.reject(new Error(msg));
      }
    }
  }

  ready(): Promise<void> { return this.initPromise; }

  isProcessing(): boolean { return this.processing || !!this.pendingTurn; }

  async submit(text: string): Promise<{ stopReason: string }> {
    await this.initPromise;
    if (!this.sessionId) throw new Error("no remote session");
    return new Promise<{ stopReason: string }>((resolve, reject) => {
      this.pendingTurn = { resolve, reject };
      fetch(`${this.baseUrl}/${this.sessionId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: text }),
      }).then((r) => {
        if (!r.ok) {
          const t = this.pendingTurn; this.pendingTurn = null;
          t?.reject(new Error(`remote submit failed: ${r.status}`));
        }
      }).catch((err) => {
        const t = this.pendingTurn; this.pendingTurn = null;
        t?.reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  cancel(): void {
    if (!this.sessionId) return;
    void fetch(`${this.baseUrl}/${this.sessionId}/cancel`, { method: "POST" }).catch(() => {});
  }

  writePty(data: string): void {
    if (!this.sessionId) return;
    void fetch(`${this.baseUrl}/${this.sessionId}/pty-input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    }).catch(() => {});
  }

  resizePty(cols: number, rows: number): void {
    if (!this.sessionId) return;
    void fetch(`${this.baseUrl}/${this.sessionId}/pty-resize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cols, rows }),
    }).catch(() => {});
  }

  execCommand(name: string, args: string): void {
    if (!this.sessionId) return;
    void fetch(`${this.baseUrl}/${this.sessionId}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    }).catch(() => {});
  }

  setThinking(level: string): void {
    if (!this.sessionId) return;
    void fetch(`${this.baseUrl}/${this.sessionId}/thinking`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level }),
    }).catch(() => {});
  }

  async autocomplete(buffer: string): Promise<Array<{ name: string; description: string }> | null> {
    await this.initPromise;
    if (!this.sessionId) return null;
    const url = `${this.baseUrl}/${this.sessionId}/autocomplete?buffer=${encodeURIComponent(buffer)}`;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      const j = await r.json() as { items?: Array<{ name: string; description: string }> };
      return j.items ?? [];
    } catch { return null; }
  }

  async snapshot(): Promise<ContextSnapshot> {
    await this.initPromise;
    if (!this.sessionId) throw new Error("no remote session");
    const r = await fetch(`${this.baseUrl}/${this.sessionId}/context`);
    if (!r.ok) throw new Error(`remote snapshot failed: ${r.status}`);
    return await r.json() as ContextSnapshot;
  }

  async getModels(): Promise<{ models: Array<{ model: string; provider: string }>; active: { model: string; provider: string } | null }> {
    await this.initPromise;
    // /api/models is global on the remote hub; instance scoping (if any) is
    // a query param — sketch returns the whole catalog.
    const r = await fetch(`${this.baseUrl}/api/models`);
    if (!r.ok) return { models: [], active: null };
    return await r.json() as { models: Array<{ model: string; provider: string }>; active: { model: string; provider: string } | null };
  }

  async compact(strategy: ContextStrategy): Promise<{ before: number; after: number; evictedCount: number } | null> {
    await this.initPromise;
    if (!this.sessionId) throw new Error("no remote session");
    const r = await fetch(`${this.baseUrl}/${this.sessionId}/context/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy }),
    });
    if (!r.ok) throw new Error(`remote compact failed: ${r.status} ${await r.text()}`);
    const j = await r.json() as { stats?: { before: number; after: number; evictedCount: number } | null };
    return j.stats ?? null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.sseAbort?.abort(); } catch {}
    if (this.sessionId) {
      void fetch(`${this.baseUrl}/${this.sessionId}/`, { method: "DELETE" }).catch(() => {});
    }
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
