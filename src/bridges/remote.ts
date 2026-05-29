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
   *  registry establish the SSH tunnel lazily on first use; passing
   *  `{reconnect:true}` forces it to drop and re-establish a dead tunnel. */
  baseUrl: string | ((opts?: { reconnect?: boolean }) => Promise<string>);
  /** Existing remote session id; omit to spawn a fresh one. */
  remoteSessionId?: string;
}

const MAX_SSE_ATTEMPTS = 8;
const sseBackoffMs = (attempt: number): number => Math.min(500 * 2 ** (attempt - 1), 8000);
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RemoteBridge extends EventEmitter implements Bridge {
  readonly kind?: SessionKind;
  private baseUrlGetter: (opts?: { reconnect?: boolean }) => Promise<string>;
  private baseUrl: string = "";
  private sessionId: string | null = null;
  private initPromise: Promise<void>;
  private closed = false;
  private processing = false;
  private pendingTurn: { resolve: (v: { stopReason: string }) => void; reject: (e: Error) => void } | null = null;
  private sseAbort: AbortController | null = null;
  // Highest remote SSE frame id seen, used as Last-Event-ID to resume after a
  // drop so the remote replays only what we missed instead of the whole
  // history.  Numeric string (the remote hub's frameSeq).
  private lastEventId: string | null = null;
  private sseAttempt = 0;

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
    void this.runSseLoop();
  }

  private emitInfo(message: string): void {
    this.emit("event", { name: "ui:info", payload: { message } } satisfies BusEvent);
  }

  // Maintain the SSE subscription across drops.  The remote process is
  // tethered to its launching SSH channel, so a tunnel death also kills the
  // remote process — but its session is persisted, so on reconnect we
  // relaunch (fresh process restores it) and resume via Last-Event-ID.
  private async runSseLoop(): Promise<void> {
    if (!this.sessionId) return;
    while (!this.closed) {
      const attempt = this.sseAttempt;
      try {
        // First retry reuses the current tunnel (cheap, covers transient
        // blips); later attempts force a tunnel reconnect (relaunch + new
        // forward) to recover from a dead remote process.
        if (attempt >= 2) {
          this.baseUrl = (await this.baseUrlGetter({ reconnect: true })).replace(/\/$/, "");
        }
        const resume = !!this.lastEventId;
        const tail = resume ? "0" : "all";
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (resume) headers["Last-Event-ID"] = this.lastEventId!;
        this.sseAbort = new AbortController();
        const r = await fetch(`${this.baseUrl}/events?subs=${this.sessionId}:${tail}`, {
          headers,
          signal: this.sseAbort.signal,
        });
        if (!r.ok || !r.body) throw new Error(`SSE connect failed: ${r.status}`);
        if (attempt > 0) this.emitInfo("Reconnected to remote.");
        this.sseAttempt = 0;
        await this.consumeSse(r.body);
        if (this.closed) return;
        // Clean stream end while we're still open counts as a drop.
        throw new Error("remote stream ended");
      } catch (err) {
        if (this.closed) return;
        this.sseAttempt = attempt + 1;
        if (this.sseAttempt > MAX_SSE_ATTEMPTS) {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (this.sseAttempt === 1) this.emitInfo("Connection to remote lost; reconnecting…");
        await delay(sseBackoffMs(this.sseAttempt));
      }
    }
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
    let evId = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data: ")) data += line.slice(6);
      else if (line.startsWith("id: ")) evId = line.slice(4).trim();
    }
    if (evId) this.lastEventId = evId;
    if (!data) return;
    let parsed: { meta?: { name?: string }; payload?: unknown };
    try { parsed = JSON.parse(data); } catch { return; }
    const name = parsed.meta?.name;
    if (!name) return;
    // A local submit() is in flight iff pendingTurn is set.  Capture it
    // BEFORE trackTurnLifecycle, which clears it on processing-done.
    const hadPending = !!this.pendingTurn;
    // trackTurnLifecycle returns true when forwarding would duplicate the
    // frame the local hub synthesizes off submit().catch — a foreground
    // agent:error.  cancelled/processing-done don't suppress (cancelled
    // forwards as a UI signal; processing-done is hub-synthesized via the
    // filter below).  A queued error (no pending turn) forwards normally.
    const suppress = this.trackTurnLifecycle(name, parsed.payload);
    // The local hub emits its own replay-done to local clients.
    if (name === "hub:replay-done") return;
    if (suppress) return;
    // HUB_SYNTHESIZED frames (agent:query, response-segment, processing-*)
    // are dropped ONLY while a local submit is in flight — there the local
    // hub synthesizes its own around submit().  With no local submit (initial
    // history replay, resume catch-up, or activity from another client) they
    // ARE the real conversation and must be forwarded.
    if (HUB_SYNTHESIZED.has(name) && hadPending) return;
    this.emit("event", { name, payload: parsed.payload } satisfies BusEvent);
  }

  private trackTurnLifecycle(name: string, payload: unknown): boolean {
    if (name === "agent:processing-start") {
      this.processing = true;
      return false;
    }
    if (name === "agent:processing-done") {
      this.processing = false;
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.resolve({ stopReason: "end_turn" }); }
      return false;
    }
    if (name === "agent:cancelled") {
      this.processing = false;
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.resolve({ stopReason: "cancelled" }); }
      return false;
    }
    if (name === "agent:error") {
      this.processing = false;
      const t = this.pendingTurn;
      if (t) {
        this.pendingTurn = null;
        const msg = (payload as { message?: string } | undefined)?.message ?? "remote agent error";
        t.reject(new Error(msg));
        return true; // foreground: local hub synthesizes the frame
      }
    }
    return false;
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
