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
import * as fs from "node:fs";
import path from "node:path";
import * as os from "node:os";
import { createCore, type AgentShellCore, NoopHistory } from "agent-sh";
import { activateAgent } from "agent-sh/agent";
import { loadExtensions } from "agent-sh/extension-loader";
import { loadBuiltinExtensions } from "agent-sh/extensions";
import { getSettings, resolveProvider, getProviderNames } from "agent-sh/settings";
import { resolveApiKey } from "agent-sh/auth";
import type { Bridge, BridgeOpts, BusEvent, ContextSnapshot, ContextStrategy } from "./types.js";
import { Shell } from "agent-sh/shell";
import { registerShellHandlers } from "agent-sh/shell/host";
import { type Terminal, BridgedTerminal, headlessTerminal, surfaceFromTerminal } from "agent-sh/shell/terminal";
import { palette as p } from "agent-sh/utils/palette.js";
import { spillOutput } from "agent-sh/utils/shell-output-spill.js";

interface ShellExchange {
  id: number;
  command: string;
  output: string;
  cwd: string;
  exitCode: number | null;
  outputLines: number;
  spillPath?: string;
}

function formatShellExchange(ex: ShellExchange): string {
  let s = `#${ex.id} [shell cwd:${ex.cwd}] $ ${ex.command}\n`;
  if (ex.output) s += indentLines(ex.output, "  ") + "\n";
  if (ex.exitCode !== null) s += `  exit ${ex.exitCode}\n`;
  return s;
}

function indentLines(text: string, prefix: string): string {
  return text.split("\n").map((line) => prefix + line).join("\n");
}

function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "powershell.exe";
  }
  return process.env.SHELL ?? "/bin/bash";
}

// Bus events to forward verbatim. Names line up with what the web client
// already handles (see web/js/client.js handler map).
const FORWARDED = [
  "agent:info",
  "agent:response-chunk",
  "agent:thinking-chunk",
  "agent:tool-batch",
  "agent:tool-started",
  "agent:tool-completed",
  "agent:tool-output-chunk",
  "agent:usage",
  "agent:error",
  "agent:cancelled",
  // Slash-commands extension reports model/thinking/etc state and errors via these.
  "ui:info",
  "ui:error",
  "shell:command-start",
  "shell:command-done",
  "shell:cwd-change",
  "shell:queued",
];

export class AshBridge extends EventEmitter implements Bridge {
  private core: AgentShellCore | null = null;
  private initPromise: Promise<void>;
  private opts: BridgeOpts;
  private pendingTurn: { resolve: (v: { stopReason: string }) => void; reject: (e: Error) => void } | null = null;
  private queryQueue: string[] = [];
  private shellQueue: string[] = [];
  private closed = false;
  private backendRegistered = false;
  private shell: Shell | null = null;
  private bridgedTerminal: BridgedTerminal | null = null;
  private agentInfoSnapshot: { name?: string; model?: string } | null = null;
  private liveCwd: string = "";
  private shellExchanges: ShellExchange[] = [];
  private shellLastInjected = 0;
  private shellNextId = 1;
  private fallbackCandidates: string[] = [];
  private currentProvider: string | undefined;
  private firstTurnPending = true;
  private pendingTurnQuery: string | null = null;
  private retryInFlight = false;

  constructor(opts: BridgeOpts) {
    super();
    this.opts = opts;
    this.initPromise = this.init();
  }

  /**
   * Builtin agent-sh providers that supply their own baseURL via an
   * activator (or use the OpenAI SDK's default).  Used by
   * isProviderViable() so settings-only entries that lack baseURL (e.g.
   * a "zai-coding-plan" stub the user added without endpoint info) are
   * skipped from the fallback chain instead of routing to api.openai.com.
   */
  private static readonly BUILTIN_PROVIDERS_WITH_BASE_URL = new Set([
    "openrouter",
    "deepseek",
    "openai",
  ]);

  private lookupProviderConfig(name: string): { apiKey: string; baseURL?: string; model: string } | null {
    if (!this.core) return null;
    const emitPipe = this.core.bus.emitPipe.bind(this.core.bus) as unknown as (
      n: string,
      p: { providers: Array<{ id: string; apiKey?: string; baseURL?: string; defaultModel?: string; models?: Array<string | { id: string }> }> },
    ) => { providers: Array<{ id: string; apiKey?: string; baseURL?: string; defaultModel?: string; models?: Array<string | { id: string }> }> };
    const { providers } = emitPipe("agent:providers", { providers: [] });
    const p = providers.find((x) => x.id === name);
    // Prefer the registered apiKey; fall back to keys.json for settings-only entries.
    const apiKey = p?.apiKey ?? resolveApiKey(name).key ?? undefined;
    const baseURL = p?.baseURL ?? resolveProvider(name)?.baseURL;
    const persisted = getSettings().providers?.[name]?.defaultModel;
    const firstModel = p?.models?.[0];
    const fallbackModel = typeof firstModel === "string" ? firstModel : firstModel?.id;
    const model = persisted ?? p?.defaultModel ?? fallbackModel;
    if (!apiKey || !model) return null;
    return { apiKey, baseURL, model };
  }

  private isProviderViable(name: string): boolean {
    if (!resolveApiKey(name).key) return false;
    if (AshBridge.BUILTIN_PROVIDERS_WITH_BASE_URL.has(name)) return true;
    const p = resolveProvider(name);
    return !!p?.baseURL;
  }

  /**
   * Build an ordered candidate list of viable providers (have key AND a
   * reachable baseURL): the preferred one first, then the rest.  Stashed
   * tail is consumed by wire()'s agent:error handler to hot-swap on
   * first-turn failure — bypassing config:switch-provider so we don't
   * persist the transient fallback as the new default.
   */
  private resolveEffectiveProvider(): string | undefined {
    const settings = getSettings();
    const ordered: string[] = [];
    const preferred = this.opts.provider ?? settings.defaultProvider;
    if (preferred && this.isProviderViable(preferred)) ordered.push(preferred);
    for (const name of getProviderNames()) {
      if (name === preferred) continue;
      if (this.isProviderViable(name)) ordered.push(name);
    }
    const first = ordered[0];
    this.fallbackCandidates = ordered.slice(1);
    this.currentProvider = first;
    if (preferred && first && first !== preferred) {
      queueMicrotask(() => {
        this.emit("event", {
          name: "ui:info",
          payload: { message: `Provider "${preferred}" not viable (missing key or baseURL); falling back to "${first}".` },
        } satisfies BusEvent);
      });
    }
    return first;
  }

  private async init(): Promise<void> {
    const provider = this.resolveEffectiveProvider();
    const core = createCore({ model: this.opts.model, provider, history: new NoopHistory() });
    this.core = core;

    this.wire(core);

    // Signal to extensions (e.g. ember) that this session uses ephemeral
    // history so they should not hijack history handlers to a file backend.
    core.handlers.define("config:get-history-mode", () => "none");

    const extCtx = core.extensionContext({ quit: () => this.close() });
    // Activate the ash agent backend so backends can register themselves
    // before core:extensions-loaded fires and activateBackend() runs.
    // This matches the CLI init order in agent-sh/dist/cli/index.js.
    const exposeTerminal = this.opts.kind === "ash-terminal";
    // registerShellHandlers must precede activateAgent + loadBuiltinExtensions
    // so ctx.shell.compositor + tui-renderer are wired before the input mode prompt fires.
    if (exposeTerminal) registerShellHandlers(extCtx);
    activateAgent(extCtx);
    this.registerUserProviders(extCtx);
    const settings = getSettings();
    const headlessDisabled = [
      "file-autocomplete",
      "overlay-agent",
      ...(settings.disabledBuiltins ?? []),
    ];
    const builtinNames = await loadBuiltinExtensions(extCtx, headlessDisabled);

    // In Electron (ASHUB_UNDER), tsx's module.register() spawns a
    // worker thread that can race with Chromium init.  Yield once so the
    // event loop drains before the first .ts extension import triggers tsx.
    if (process.env.ASHUB_UNDER) {
      await new Promise<void>((r) => setTimeout(r, 200));
    }

    // User extensions (~/.agent-sh/extensions/) load too. Extensions that
    // would conflict with the hub (e.g. web-renderer binding 7878) should
    // check `process.env.ASHUB_UNDER` and bail early.
    const TIMEOUT_MS = 10_000;
    const userNames = await Promise.race([
      loadExtensions(extCtx),
      new Promise<string[]>((_, reject) =>
        setTimeout(() => reject(new Error(`extension load timeout (${TIMEOUT_MS}ms)`)), TIMEOUT_MS),
      ),
    ]).catch((err) => {
      process.stderr.write(`[ash-bridge] ${err instanceof Error ? err.message : err}\n`);
      return [] as string[];
    });

    // AgentLoop (constructed by activateAgent) defines its own
    // history:read-recent in its constructor, and ember may advise it.
    // Stub both the read and the format renderer as the last step
    // before core:extensions-loaded, so wire() sees empty history.
    core.handlers.define("history:read-recent", () => []);
    core.handlers.define("conversation:format-prior-history", () => null);

    core.bus.emit("core:extensions-loaded", { names: [...builtinNames, ...userNames] });
    await core.activateBackend();

    const startCwd = this.opts.cwd ? path.resolve(this.opts.cwd) : os.homedir();
    this.liveCwd = startCwd;

    // agent-sh Shell only supports zsh/bash/fish — skip on Windows.
    if (process.platform !== "win32") {
      let terminal: Terminal;
      if (exposeTerminal) {
        this.bridgedTerminal = new BridgedTerminal((data) => {
          this.emit("event", { name: "shell:pty-data", payload: { raw: data } } satisfies BusEvent);
        });
        terminal = this.bridgedTerminal;
        const surface = surfaceFromTerminal(terminal);
        const compositor = extCtx.shell?.compositor;
        if (compositor) {
          compositor.setDefault("agent", surface);
          compositor.setDefault("query", surface);
          compositor.setDefault("status", surface);
        }
        core.bus.on("agent:info", (info) => {
          const i = info as { name?: string; model?: string } | null;
          if (i) this.agentInfoSnapshot = { name: i.name, model: i.model };
          core.bus.emit("config:changed", {});
        });
      } else {
        terminal = headlessTerminal();
      }
      try {
        this.shell = new Shell({
          bus: core.bus,
          handlers: core.handlers,
          cols: 100,
          rows: 30,
          shell: defaultShell(),
          cwd: startCwd,
          instanceId: extCtx.instanceId,
          terminal,
          onShowAgentInfo: exposeTerminal ? () => {
            const info = this.agentInfoSnapshot;
            if (!info?.name) return { info: "" };
            return { info: `${p.dim}${info.name}${info.model ? ` (${info.model})` : ""}${p.reset}` };
          } : undefined,
        });
        this.shell.onExit(() => { this.shell = null; });
      } catch (err) {
        process.stderr.write(`[ash-bridge] shell spawn failed: ${err instanceof Error ? err.message : err}\n`);
      }
      if (exposeTerminal) {
        core.bus.emit("input-mode:register", {
          id: "agent",
          trigger: ">",
          label: "agent",
          promptIcon: "❯",
          indicator: "●",
          onSubmit(query, b) { b.emit("agent:submit", { query }); },
          returnToSelf: true,
        });
      }
      const onAnyBus = core.bus.on.bind(core.bus) as unknown as (n: string, fn: (p: unknown) => void) => void;
      onAnyBus("shell:cwd-change", (payload) => {
        const next = (payload as { cwd?: string })?.cwd;
        if (typeof next === "string" && next) this.liveCwd = next;
      });
      onAnyBus("shell:command-done", (payload) => {
        this.recordShellExchange(payload as { command?: string; output?: string; cwd?: string; exitCode?: number | null });
      });
    }
    core.handlers.advise("cwd", () => this.liveCwd);

    core.handlers.advise("system-prompt:build", (next: () => string) => {
      const base = next();
      const cwd = core.handlers.call("cwd");
      if (typeof cwd !== "string" || !cwd) return base;
      return `${base}\n\n# Working Directory\n\nCurrent working directory: ${cwd}`;
    });

    core.handlers.advise("query-context:build", (next: () => string) => {
      const base = (next() ?? "").trim();
      const fresh = this.shellExchanges.filter((e) => e.id > this.shellLastInjected);
      if (fresh.length === 0) return base;
      this.shellLastInjected = fresh[fresh.length - 1].id;
      const eventsText = fresh.map(formatShellExchange).filter(Boolean).join("\n");
      if (!eventsText) return base;
      const tail = `<shell_events>\n${eventsText}\n</shell_events>`;
      return base ? `${base}\n\n${tail}` : tail;
    });

    if (this.opts.compactionStrategy) {
      const strategy = this.opts.compactionStrategy;
      const helpers = {
        getMessages: () => core.handlers.call("conversation:get-messages") as unknown[],
        replaceMessages: (msgs: unknown[]) => { core.handlers.call("conversation:replace-messages", msgs); },
        estimatePromptTokens: () => (core.handlers.call("conversation:estimate-prompt-tokens") as number) ?? 0,
      };
      core.handlers.advise("conversation:compact", async (next: (o: unknown) => unknown, opts: unknown) => {
        return await strategy(helpers, opts, next);
      });
    }

    if (this.opts.initialMessages?.length) {
      try {
        core.handlers.call("conversation:replace-messages", this.opts.initialMessages);
      } catch (err) {
        process.stderr.write(`[ash-bridge] failed to inject restored messages: ${err instanceof Error ? err.message : err}\n`);
      }
    }
  }

  // Re-register settings-only providers (no built-in activator) so their
  // keys.json key flows into resolvedProviders.  Skip entries without a
  // baseURL: those are either built-ins (which register themselves with
  // the correct baseURL via activateAgent — re-registering here would
  // overwrite it with undefined, sending traffic to api.openai.com) or
  // genuinely under-configured custom providers that can't work anyway.
  private registerUserProviders(extCtx: ReturnType<AgentShellCore["extensionContext"]>): void {
    const ctxAgent = (extCtx as unknown as { agent?: { providers?: { register: (reg: Record<string, unknown>) => unknown } } }).agent;
    if (!ctxAgent?.providers?.register) return;
    for (const name of getProviderNames()) {
      const p = resolveProvider(name);
      if (!p) continue;
      if (p.apiKey) continue;
      if (!p.baseURL) continue;
      const resolved = resolveApiKey(name);
      if (!resolved.key) continue;
      ctxAgent.providers.register({
        id: name,
        apiKey: resolved.key,
        baseURL: p.baseURL,
        defaultModel: p.defaultModel,
        models: p.models ?? [],
      });
    }
  }

  private wire(core: AgentShellCore): void {
    const { bus } = core;

    // Bus event names are typed; bridge forwards a curated string list,
    // so we cast through `any` rather than maintain a parallel union.
    const onAny = bus.on.bind(bus) as unknown as (name: string, fn: (p: unknown) => void) => void;

    // Track the latest cache-hit/miss tokens from raw LLM chunks so we can
    // enrich the forwarded `agent:usage` event (agent-sh core drops these
    // fields when it emits its own agent:usage).
    //
    // We accumulate across chunks because some providers (e.g. Anthropic)
    // stream usage as partial updates across multiple chunks, not a single
    // final chunk. We reset to zero at the start of each turn (agent:submit)
    // and also after `agent:usage` is consumed so stale values don't leak
    // into future turns.
    let lastCacheHit = 0;
    let lastCacheMiss = 0;
    onAny("agent:submit", () => {
      lastCacheHit = 0;
      lastCacheMiss = 0;
    });
    onAny("llm:chunk", (payload) => {
      const chunk = (payload as { chunk?: { usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number } } })?.chunk;
      if (chunk?.usage) {
        // Overwrite rather than accumulate: Anthropic's streaming usage is
        // cumulative (not delta), and OpenAI SDK normally sends usage only
        // in the final chunk. A later chunk may only contain one of the two
        // fields, so we only update when the field is present.
        if (typeof chunk.usage.prompt_cache_hit_tokens === "number") {
          lastCacheHit = chunk.usage.prompt_cache_hit_tokens;
        }
        if (typeof chunk.usage.prompt_cache_miss_tokens === "number") {
          lastCacheMiss = chunk.usage.prompt_cache_miss_tokens;
        }
      }
    });

    const readThinking = (): { level: string; supported: boolean } | null => {
      try {
        const emitPipe = bus.emitPipe.bind(bus) as unknown as (
          n: string,
          p: { level: string; levels: string[]; supported: boolean },
        ) => { level: string; levels: string[]; supported: boolean };
        const r = emitPipe("config:get-thinking", { level: "", levels: [], supported: false });
        return { level: r?.level ?? "off", supported: !!r?.supported };
      } catch { return null; }
    };

    for (const name of FORWARDED) {
      onAny(name, (payload) => {
        if (name === "agent:info") {
          const think = readThinking();
          const enriched = {
            ...(payload as Record<string, unknown>),
            ...(think ? { thinkingLevel: think.level, thinkingSupported: think.supported } : {}),
          };
          this.emit("event", { name, payload: enriched } satisfies BusEvent);
          return;
        }
        // Enrich agent:usage with cache fields that agent-sh core drops.
        if (name === "agent:usage") {
          // Always attach cache fields if we have accumulated any; this
          // ensures the usage bar shows cache info even when one of the
          // two counters happens to be zero. Reset immediately after so
          // values never leak into the next turn.
          if (lastCacheHit > 0 || lastCacheMiss > 0) {
            const enriched = {
              ...(payload as Record<string, unknown>),
              prompt_cache_hit_tokens: lastCacheHit,
              prompt_cache_miss_tokens: lastCacheMiss,
            };
            this.emit("event", { name, payload: enriched } satisfies BusEvent);
          } else {
            this.emit("event", { name, payload } satisfies BusEvent);
          }
          lastCacheHit = 0;
          lastCacheMiss = 0;
          return;
        }
        this.emit("event", { name, payload } satisfies BusEvent);
      });
    }

    onAny("config:changed", () => {
      const think = readThinking();
      if (!think) return;
      this.emit("event", {
        name: "agent:info",
        payload: { thinkingLevel: think.level, thinkingSupported: think.supported },
      } satisfies BusEvent);
    });

    // Track whether any agent backend registered. Without one, submit()
    // must reject so the UI doesn't spin forever (e.g. missing API key).
    onAny("agent:register-backend", () => { this.backendRegistered = true; });

    // Turn boundaries — consumed internally to resolve submit() promises;
    // NOT forwarded as BusEvents. The hub synthesizes its own
    // processing-start/done frames around submit() so the start/done pair
    // is well-ordered with the user's query and the segment flush. If we
    // also forwarded the kernel's, the kernel's done would arrive before
    // the segment flush and re-open a fresh reply, doubling the text.
    onAny("agent:processing-done", () => {
      // agent-loop emits processing-done in `finally` even after errors.
      // If the error handler just queued a fallback retry, swallow this
      // settle — the next submit() is still in flight on the same turn.
      if (this.retryInFlight) {
        this.retryInFlight = false;
        return;
      }
      this.firstTurnPending = false;
      this.pendingTurnQuery = null;
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.resolve({ stopReason: "end_turn" }); }
      setTimeout(() => { this.drainShellQueue(); this.drainQueue(); }, 0);
    });
    onAny("agent:error", (payload) => {
      const message = (payload as { message?: string })?.message ?? "agent error";
      // First-turn auto-fallback: hot-swap to the next keyed provider and
      // resubmit the same query.  This catches "key present but auth fails"
      // and "key present but configured model is wrong" — cases the
      // pre-init fallback in resolveEffectiveProvider can't detect because
      // they only surface during the first LLM call.
      if (
        this.firstTurnPending &&
        this.fallbackCandidates.length > 0 &&
        this.pendingTurn &&
        this.pendingTurnQuery &&
        this.core
      ) {
        const next = this.fallbackCandidates.shift()!;
        const cfg = this.lookupProviderConfig(next);
        if (cfg) {
          const prev = this.currentProvider;
          this.currentProvider = next;
          this.retryInFlight = true;
          const query = this.pendingTurnQuery;
          this.emit("event", {
            name: "ui:info",
            payload: { message: `Provider "${prev}" failed (${message}); retrying with "${next}".` },
          } satisfies BusEvent);
          const bus = this.core.bus;
          setTimeout(() => {
            // Reconfigure llmClient directly instead of emitting
            // config:switch-provider — the latter triggers
            // config:switch-model whose handler calls
            // updateSettings({defaultProvider}), which would persist
            // this transient fallback as the user's new default.
            try {
              const llm = this.core!.handlers.call("llm:get-client") as { reconfigure: (c: { apiKey: string; baseURL?: string; model: string }) => void } | undefined;
              llm?.reconfigure({ apiKey: cfg.apiKey, baseURL: cfg.baseURL, model: cfg.model });
            } catch (e) {
              process.stderr.write(`[ash-bridge] llm reconfigure failed: ${e instanceof Error ? e.message : e}\n`);
            }
            bus.emit("agent:submit", { query });
          }, 0);
          return;
        }
      }
      this.firstTurnPending = false;
      this.pendingTurnQuery = null;
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.reject(new Error(message)); }
      setTimeout(() => { this.drainShellQueue(); this.drainQueue(); }, 0);
    });
    onAny("agent:cancelled", () => {
      this.pendingTurnQuery = null;
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.resolve({ stopReason: "cancelled" }); }
      setTimeout(() => { this.drainShellQueue(); this.drainQueue(); }, 0);
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
    if (!this.backendRegistered) throw new Error("No agent backend configured. Check your API key and model in Settings.");
    if (this.pendingTurn || this.queryQueue.length > 0) {
      this.queryQueue.push(text);
      return { stopReason: "queued" };
    }
    this.pendingTurnQuery = text;
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
    // If no agent backend is registered (e.g. missing API key), the
    // cancel-request has no listener and pendingTurn would never settle.
    // Force-resolve so the hub can push a processing-done frame and the
    // UI stops showing the spinner.
    if (!this.backendRegistered) {
      const t = this.pendingTurn;
      if (t) {
        this.pendingTurn = null;
        this.emit("event", { name: "agent:cancelled", payload: {} } satisfies BusEvent);
        t.resolve({ stopReason: "cancelled" });
        this.queryQueue.length = 0;
      }
    }
  }

  execCommand(name: string, args: string): void {
    this.core?.bus.emit("command:execute", { name, args });
  }

  setThinking(level: string): void {
    this.core?.bus.emit("config:set-thinking", { level });
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
    const snap = emitPipe("context:snapshot", { messages: [], contextWindow: 0, activeTokens: 0 });

    // Filter system notes from the live conversation — they are
    // internal metadata that shouldn't appear in the context panel
    // or be persisted across save/restore cycles.
    snap.messages = (snap.messages as Array<{ isSystemNote?: boolean }>)
      .filter((m) => !m.isSystemNote);

    return snap;
  }

  async getModels() {
    await this.initPromise;
    if (!this.core) throw new Error("core not initialized");
    // `config:get-models` only registers once AgentLoop activates; `agent:get-modes` is always live.
    const modes = (this.core.handlers.call("agent:get-modes") ?? []) as Array<{ model: string; provider?: string }>;
    const models = modes.map((m) => ({ model: m.model, provider: m.provider ?? "" }));
    return { models, active: null };
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

  private recordShellExchange(e: { command?: string; output?: string; cwd?: string; exitCode?: number | null }): void {
    const command = e.command ?? "";
    const rawOutput = e.output ?? "";
    if (!command) return;
    const cwd = e.cwd ?? this.liveCwd;
    const exitCode = e.exitCode ?? null;
    const id = this.shellNextId++;
    const {
      shellTruncateThreshold: threshold = 20,
      shellHeadLines: head = 10,
      shellTailLines: tail = 10,
    } = getSettings() as {
      shellTruncateThreshold?: number;
      shellHeadLines?: number;
      shellTailLines?: number;
    };
    const lines = rawOutput.split("\n");
    let output = rawOutput;
    let spillPath: string | undefined;
    if (lines.length > threshold) {
      try {
        spillPath = spillOutput(id, rawOutput);
        const omitted = lines.length - head - tail;
        output = [
          ...lines.slice(0, head),
          `[... ${omitted} lines truncated — full output at ${spillPath}; use read_file to expand ...]`,
          ...lines.slice(-tail),
        ].join("\n");
      } catch {}
    }
    this.shellExchanges.push({
      id, command, output, cwd, exitCode,
      outputLines: lines.length,
      spillPath,
    });
    while (this.shellExchanges.length > 100) {
      const evicted = this.shellExchanges.shift();
      if (evicted?.spillPath) {
        try { fs.rmSync(evicted.spillPath, { force: true }); } catch {}
      }
    }
  }

  writePty(data: string): void {
    if (this.closed || !this.shell) return;
    if (this.bridgedTerminal) {
      this.bridgedTerminal.pushInput(data);
      return;
    }
    if (this.pendingTurn) {
      this.shellQueue.push(data);
      const command = data.replace(/\r?\n$/, "");
      this.emit("event", { name: "shell:queued", payload: { command } } satisfies BusEvent);
      return;
    }
    try { this.shell.writeToPty(data); } catch {}
  }

  private drainShellQueue(): void {
    if (!this.shell || this.closed) { this.shellQueue.length = 0; return; }
    while (this.shellQueue.length > 0) {
      const next = this.shellQueue.shift()!;
      try { this.shell.writeToPty(next); } catch {}
    }
  }

  resizePty(cols: number, rows: number): void {
    if (this.closed || !this.shell) return;
    if (this.bridgedTerminal) this.bridgedTerminal.pushResize(cols, rows);
    try { this.shell.resize(cols, rows); } catch {}
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.core?.kill(); } catch {}
    if (this.shell) {
      try { this.shell.kill(); } catch {}
      this.shell = null;
    }
    for (const ex of this.shellExchanges) {
      if (ex.spillPath) {
        try { fs.rmSync(ex.spillPath, { force: true }); } catch {}
      }
    }
    this.shellExchanges.length = 0;
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
