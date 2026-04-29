/**
 * AshBridge — runs agent-sh's kernel in-process and forwards bus events.
 *
 * Skips the JSON-RPC trampoline AcpBridge needs: agent-sh's bus events
 * already match what the web client renders, so we just subscribe and
 * forward. Each bridge instance owns one core; the hub creates one bridge
 * per session.
 *
 * Permission auto-approval mirrors ash-acp-bridge — until the web UI
 * grows a yes/no prompt, the hub can't gate, so we approve and let the
 * built-in tools' own safety checks handle anything dangerous.
 */
import { EventEmitter } from "node:events";
import path from "node:path";
import { createCore, type AgentShellCore, NoopHistory } from "agent-sh";
import { loadExtensions } from "agent-sh/extension-loader";
import { loadBuiltinExtensions } from "agent-sh/extensions";
import { getSettings } from "agent-sh/settings";
import type { Bridge, BridgeOpts, BusEvent, ContextSnapshot, ContextStrategy } from "./types.js";

// Bus events to forward verbatim. Names line up with what the web client
// already handles (see web/js/client.js handler map).
const FORWARDED = [
  "agent:info",
  "agent:response-chunk",
  "agent:thinking-chunk",
  "agent:tool-started",
  "agent:tool-completed",
  "agent:tool-output-chunk",
  "agent:usage",
  "agent:error",
  "agent:cancelled",
  // Slash-commands extension reports model/thinking/etc state and errors via these.
  "ui:info",
  "ui:error",
];

export class AshBridge extends EventEmitter implements Bridge {
  private core: AgentShellCore | null = null;
  private initPromise: Promise<void>;
  private opts: BridgeOpts;
  private pendingTurn: { resolve: (v: { stopReason: string }) => void; reject: (e: Error) => void } | null = null;
  private queryQueue: string[] = [];
  private closed = false;
  private seedMessages: unknown[] | null = null;

  constructor(opts: BridgeOpts) {
    super();
    this.opts = opts;
    this.initPromise = this.init();
  }

  private async init(): Promise<void> {
    const core = createCore({ model: this.opts.model, provider: this.opts.provider, history: new NoopHistory() });
    this.core = core;

    this.wire(core);

    // Signal to extensions (e.g. ember) that this session uses ephemeral
    // history so they should not hijack history handlers to a file backend.
    core.handlers.define("config:get-history-mode", () => "none");

    const extCtx = core.extensionContext({ quit: () => this.close() });
    const settings = getSettings();
    const headlessDisabled = [
      "tui-renderer",
      "file-autocomplete",
      "overlay-agent",
      ...(settings.disabledBuiltins ?? []),
    ];
    await loadBuiltinExtensions(extCtx, headlessDisabled);

    // In Electron (AGENT_SH_UNDER_HUB), tsx's module.register() spawns a
    // worker thread that can race with Chromium init.  Yield once so the
    // event loop drains before the first .ts extension import triggers tsx.
    if (process.env.AGENT_SH_UNDER_HUB) {
      await new Promise<void>((r) => setTimeout(r, 200));
    }

    // User extensions (~/.agent-sh/extensions/) load too. Extensions that
    // would conflict with the hub (e.g. web-renderer binding 7878) should
    // check `process.env.AGENT_SH_UNDER_HUB` and bail early.
    const TIMEOUT_MS = 10_000;
    await Promise.race([
      loadExtensions(extCtx),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`extension load timeout (${TIMEOUT_MS}ms)`)), TIMEOUT_MS),
      ),
    ]).catch((err) => {
      process.stderr.write(`[ash-bridge] ${err instanceof Error ? err.message : err}\n`);
    });

    // AgentLoop (from agent-backend builtin) defines its own
    // history:read-recent in its constructor, and ember may advise it.
    // Stub both the read and the format renderer as the last step
    // before core:extensions-loaded, so wire() sees empty history.
    core.handlers.define("history:read-recent", () => []);
    core.handlers.define("conversation:format-prior-history", () => null);

    core.bus.emit("core:extensions-loaded", {});
    core.activateBackend();

    if (this.opts.cwd) {
      core.bus.emit("shell:cwd-change", { cwd: path.resolve(this.opts.cwd) });
    }

    // Cache initialMessages for injection into snapshot() — context:compact
    // has async microtask races with other conversation mutations during
    // init.  snapshot() injects them on first read instead.
    this.seedMessages = this.opts.initialMessages?.length ? [...this.opts.initialMessages] : null;
  }

  private wire(core: AgentShellCore): void {
    const { bus } = core;

    // Bus event names are typed; bridge forwards a curated string list,
    // so we cast through `any` rather than maintain a parallel union.
    const onAny = bus.on.bind(bus) as unknown as (name: string, fn: (p: unknown) => void) => void;

    for (const name of FORWARDED) {
      onAny(name, (payload) => {
        this.emit("event", { name, payload } satisfies BusEvent);
      });
    }

    // Turn boundaries — consumed internally to resolve submit() promises;
    // NOT forwarded as BusEvents. The hub synthesizes its own
    // processing-start/done frames around submit() so the start/done pair
    // is well-ordered with the user's query and the segment flush. If we
    // also forwarded the kernel's, the kernel's done would arrive before
    // the segment flush and re-open a fresh reply, doubling the text.
    onAny("agent:processing-done", () => {
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.resolve({ stopReason: "end_turn" }); }
      setTimeout(() => this.drainQueue(), 0);
    });
    onAny("agent:error", (payload) => {
      const message = (payload as { message?: string })?.message ?? "agent error";
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.reject(new Error(message)); }
      setTimeout(() => this.drainQueue(), 0);
    });
    onAny("agent:cancelled", () => {
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.resolve({ stopReason: "cancelled" }); }
      this.queryQueue.length = 0;
    });

    // Permission gate — forward to UI as an event (so the diff preview
    // renders) and auto-approve. When the web UI grows a prompt, swap the
    // approval for a routed decision.
    const onPipe = bus.onPipeAsync.bind(bus) as unknown as (
      name: string,
      fn: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => void;
    onPipe("permission:request", async (payload) => {
      this.emit("event", { name: "permission:request", payload });
      payload.decision = { outcome: "approved" };
      return payload;
    });
  }

  ready(): Promise<void> {
    return this.initPromise;
  }

  isProcessing(): boolean {
    return !!this.pendingTurn || this.queryQueue.length > 0;
  }

  async submit(text: string): Promise<{ stopReason: string }> {
    await this.initPromise;
    if (!this.core) throw new Error("core not initialized");
    if (this.pendingTurn || this.queryQueue.length > 0) {
      this.queryQueue.push(text);
      return { stopReason: "queued" };
    }
    return new Promise<{ stopReason: string }>((resolve, reject) => {
      this.pendingTurn = { resolve, reject };
      this.core!.bus.emit("agent:submit", { query: text });
    });
  }

  private drainQueue(): void {
    if (this.pendingTurn) return;
    const next = this.queryQueue.shift();
    if (!next || this.closed || !this.core) return;
    this.pendingTurn = {
      resolve: () => {
        this.emit("event", { name: "agent:queued-done", payload: {} } satisfies BusEvent);
      },
      reject: () => {
        this.emit("event", { name: "agent:queued-done", payload: {} } satisfies BusEvent);
      },
    };
    this.emit("event", { name: "agent:queued-submit", payload: { query: next } } satisfies BusEvent);
    this.core.bus.emit("agent:submit", { query: next });
  }

  cancel(): void {
    this.core?.bus.emit("agent:cancel-request", {});
  }

  execCommand(name: string, args: string): void {
    this.core?.bus.emit("command:execute", { name, args });
  }

  async autocomplete(buffer: string): Promise<Array<{ name: string; description: string }> | null> {
    if (!this.core) return null;
    // Arg-completion handlers in slash-commands.ts gate on `payload.command`
    // (e.g. only fire for `/model`), so we must populate it ourselves — the
    // command-name handler reads `buffer` directly but arg handlers won't.
    const trimmed = buffer.trimStart();
    let command: string | null = null;
    let commandArgs: string | null = null;
    if (trimmed.startsWith("/")) {
      const space = trimmed.indexOf(" ");
      if (space !== -1) {
        command = trimmed.slice(0, space);
        commandArgs = trimmed.slice(space + 1);
      }
    }
    const r = this.core.bus.emitPipe("autocomplete:request", {
      buffer, command, commandArgs, items: [],
    });
    return Array.isArray(r.items) ? r.items : [];
  }

  async snapshot(): Promise<ContextSnapshot> {
    await this.initPromise;
    if (!this.core) throw new Error("core not initialized");

    const emitPipe = this.core.bus.emitPipe.bind(this.core.bus) as unknown as (
      name: string,
      payload: ContextSnapshot,
    ) => ContextSnapshot;

    // On first snapshot after session restore, seed the previous
    // conversation into the real ConversationState.  Must merge with
    // any messages the current session has already produced (users can
    // send messages before the context panel is ever opened).
    if (this.seedMessages) {
      const seed = this.seedMessages;
      this.seedMessages = null;
      const current = emitPipe("context:snapshot", { messages: [], contextWindow: 0, activeTokens: 0 });
      // Keep only non-system messages from the current session (seed
      // already carries its own system notes).  Append them after seed
      // so chronology is preserved.
      const currentNonSystem = (current.messages as Array<{ role?: string; isSystemNote?: boolean }>)
        .filter((m) => !(m as { isSystemNote?: boolean }).isSystemNote);
      const merged = [...seed, ...currentNonSystem];
      try {
        const emitPipeAsync = this.core.bus.emitPipeAsync.bind(this.core.bus) as unknown as (
          name: string,
          payload: { strategy: ContextStrategy; stats?: { before: number; after: number; evictedCount: number } },
        ) => Promise<{ stats?: { before: number; after: number; evictedCount: number } }>;
        await emitPipeAsync("context:compact", {
          strategy: { kind: "replace", messages: merged },
        });
      } catch {
        // If compact fails, return merged messages directly.
      }
    }

    return emitPipe("context:snapshot", { messages: [], contextWindow: 0, activeTokens: 0 });
  }

  async compact(strategy: ContextStrategy) {
    await this.initPromise;
    if (!this.core) throw new Error("core not initialized");
    const emitPipeAsync = this.core.bus.emitPipeAsync.bind(this.core.bus) as unknown as (
      name: string,
      payload: { strategy: ContextStrategy; stats?: { before: number; after: number; evictedCount: number } },
    ) => Promise<{ stats?: { before: number; after: number; evictedCount: number } }>;
    const r = await emitPipeAsync("context:compact", { strategy });
    return r.stats ?? null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.core?.kill(); } catch {}
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
