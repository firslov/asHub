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
import { createCore, type AgentShellCore, runSubagent, type ToolDefinition } from "agent-sh";
import { activateAgent } from "agent-sh/agent";
import { loadExtensions } from "agent-sh/extension-loader";
import { loadBuiltinExtensions } from "agent-sh/extensions";
import { getSettings, updateSettings, resolveProvider, getProviderNames } from "agent-sh/settings";
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
  "subagent:started",
  "subagent:done",
];

// ── Subagent type definitions ─────────────────────────────────────

interface SubagentType {
  /** System prompt for this subagent type. */
  systemPrompt: string;
  /** Tool names allowed. Empty = no tools. `["*"]` = all tools. */
  tools: string[];
  /** Max LLM iterations (tool call loops). */
  maxIterations: number;
  /** Completion-token budget. */
  budgetTokens?: number;
  /** Model override. `undefined` = inherit from parent. */
  model?: string;
  /** Short description shown in tool schema. */
  description: string;
  /** Run fire-and-forget? false = agent waits for result before continuing. */
  async?: boolean;
}

const SUBAGENT_TYPES: Record<string, SubagentType> = {
  plan: {
    description: "Create a detailed step-by-step plan for a complex task. Use when user asks to 'plan', 'design', or 'outline' something. No tools.",
    systemPrompt: `You are a planning specialist. Your only job is to create clear, structured plans.

- Break the task into numbered phases
- Each phase should have concrete, ordered steps
- Consider dependencies between steps
- Note any assumptions or prerequisites
- Keep the plan actionable and focused
- Do NOT execute anything — only plan
- Return ONLY the plan text, no meta-commentary`,
    tools: [],
    maxIterations: 1,
    budgetTokens: 4000,
  },
  explore: {
    description: "Explore and search the codebase to answer a question. Use when asked to 'explore', 'search', 'find', 'locate', or 'look up' code. Read-only.",
    systemPrompt: `You are a codebase explorer. Your job is to search, read, and understand code to answer questions.

- Use glob, grep, and read_file to investigate
- Never modify or create files
- Summarize findings clearly
- Cite file paths and line numbers
- Be thorough but concise`,
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 15,
    budgetTokens: 8000,
  },
  review: {
    description: "Review code for bugs, style issues, and improvement opportunities. Use when user asks to 'review', 'check', 'audit', or 'inspect' code. Read-only.",
    systemPrompt: `You are a code reviewer. Your job is to examine code and provide actionable feedback.

- Read the relevant files thoroughly before commenting
- Identify bugs, logic errors, edge cases, and performance issues
- Check for adherence to conventions and best practices
- Suggest concrete improvements with code examples
- Organize findings by severity: critical, important, nice-to-have
- Cite exact file paths and line numbers for each finding
- Be constructive — suggest fixes, not just problems`,
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 10,
    budgetTokens: 12000,
  },
  research: {
    description: "Deep investigation of code structure and dependencies. Use when asked to 'research', 'investigate', 'trace', 'analyze' or 'understand how' code works. Read-only.",
    systemPrompt: `You are a code archaeologist. Your job is to deeply understand how code works.

- Trace function calls across files — follow the chain
- Map dependencies between modules
- Identify patterns, anti-patterns, and architectural decisions
- Explain WHY the code works the way it does, not just HOW
- Provide a structured report: overview → details → implications
- Cite every file path and line number`,
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 20,
    budgetTokens: 10000,
  },
  implement: {
    description: "Implement a feature or change end-to-end. Use when asked to 'implement', 'build', 'create', 'add', 'write code for', or 'develop' something. Can read, write, and edit files.",
    systemPrompt: `You are an implementation specialist. Your job is to write working code.

- Plan before you type — understand what needs to change
- Read existing code to understand patterns and conventions
- Make focused, minimal changes — avoid unnecessary refactoring
- Write clear, idiomatic code that follows the project's style
- Test your changes if appropriate
- Report what you changed and why`,
    tools: ["*"],
    maxIterations: 25,
    budgetTokens: 12000,
  },
};

// Guard to ensure the Electron tsx-worker/Chromium init race is
// yielded only once — on the first bridge — not on every session.
let _firstBridge = true;


    interface SubagentEntry {
      id: string;
      type: string;
      task: string;
      startedAt: number;
      promise: Promise<string>;
      controller?: AbortController;
      result?: string;
      error?: string;
    }


export class AshBridge extends EventEmitter implements Bridge {
  private core: AgentShellCore | null = null;
  private initPromise: Promise<void>;
  private opts: BridgeOpts;
  private extCtx: ReturnType<AgentShellCore["extensionContext"]> | null = null;
  private pendingTurn: { resolve: (v: { stopReason: string }) => void; reject: (e: Error) => void } | null = null;
  private queryQueue: string[] = [];
  private shellQueue: string[] = [];
  private closed = false;
  private backendRegistered = false;
  private _contextProducerUnsubscribe: (() => void) | null = null;
  private _subagents: Map<string, SubagentEntry> = new Map();
  private shell: Shell | null = null;
  private bridgedTerminal: BridgedTerminal | null = null;
  private agentInfoSnapshot: { name?: string; model?: string } | null = null;
  private liveCwd: string = "";
  private shellExchanges: ShellExchange[] = [];
  private shellLastInjected = 0;
  private shellNextId = 1;

  constructor(opts: BridgeOpts) {
    super();
    this.opts = opts;
    this.initPromise = this.init();
  }

  private async init(): Promise<void> {
    const core = createCore({ model: this.opts.model, provider: this.opts.provider });
    this.core = core;

    this.wire(core);

    // Signal to extensions (e.g. ember) that this session uses ephemeral
    // history so they should not hijack history handlers to a file backend.
    core.handlers.define("config:get-history-mode", () => "none");

    // Tell the LLM it's running inside asHub — the web-hosted agent runtime.
    core.handlers.define("system-prompt:frontend", () =>
      `# asHub Runtime\n\n` +
      `You are running inside **asHub**, a web-based agent host that provides a chat ` +
      `interface, session management, and subagent delegation. Your responses are ` +
      `rendered as rich Markdown in a browser-based UI. You have full access to ` +
      `the filesystem via standard tools. The user interacts with you through the ` +
      `asHub web interface — do not instruct them to use a terminal or CLI.`
    );

    const extCtx = core.extensionContext({ quit: () => this.close() });
    this.extCtx = extCtx;
    // Activate the ash agent backend so backends can register themselves
    // before core:extensions-loaded fires and activateBackend() runs.
    // This matches the CLI init order in agent-sh/dist/cli/index.js.
    const exposeTerminal = this.opts.kind === "ash-terminal";
    // registerShellHandlers must precede activateAgent + loadBuiltinExtensions
    // so ctx.shell.compositor + tui-renderer are wired before the input mode prompt fires.
    if (exposeTerminal) registerShellHandlers(extCtx);
    activateAgent(extCtx);
    this.registerUserProviders(extCtx);

    // ── File modification safety ─────────────────────────────────────
    // Prevent the model from silently modifying files without consent.
    (extCtx as unknown as { agent: { registerInstruction(name: string, text: string): void } }).agent.registerInstruction(
      "file-modification-safety",
      `CRITICAL — FILE MODIFICATION POLICY:

1. EXPLICIT USER REQUEST: When the user directly asks you to modify, create,
   or edit a file (e.g. "edit X", "write Y", "fix the bug in Z"), you may
   immediately use edit_file, write_file, or bash to make those changes.

2. NO EXPLICIT REQUEST: When the user does NOT ask for file changes (e.g.
   they ask a question, request analysis, code review, or explanation), you
   MUST NOT modify any files. Instead:
   — Describe what you propose to change and why
   — Present it as a suggestion: "I could modify X to achieve Y. Shall I proceed?"
   — Wait for the user to confirm before making any changes

This applies to ALL file-modifying tools: write_file, edit_file, and bash
(invoked with rm, mv, sed, git, or any destructive operation).`
    );

    this.gateImageToolResults(extCtx);
    const settings = getSettings();
    const headlessDisabled = [
      "file-autocomplete",
      "overlay-agent",
      ...(settings.disabledBuiltins ?? []),
    ];
    const builtinNames = await loadBuiltinExtensions(extCtx, headlessDisabled);

    // In Electron (ASHUB_UNDER), tsx's module.register() spawns a
    // worker thread that can race with Chromium init.  Yield once on
    // the first bridge so the event loop drains before any .ts
    // extension import triggers tsx.
    if (process.env.ASHUB_UNDER && _firstBridge) {
      _firstBridge = false;
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

    // ── Subagent support ────────────────────────────────────────────
    // Expose agent-sh's subagent runner so tools can delegate focused
    // tasks to a child agent loop.  Tool calls inside the subagent are
    // rendered in the UI via core.bus, and token usage is forwarded.
    //
    // Accepts either raw opts OR a `type` string that selects a preset
    // from SUBAGENT_TYPES (raw opts override type defaults).
    //
    // In async mode (fire-and-forget), the subagent runs in the background
    // and results are injected into the main conversation via a dynamic
    // context producer on the next LLM iteration.
    const launchSubagent = (
      task: string,
      type: string,
      systemPrompt: string,
      tools: ToolDefinition[],
      model: string | undefined,
      maxIterations: number,
      budgetTokens: number | undefined,
    ) => {
      const id = `sa${++_subagentSeq}`;
      const llmClient = core.handlers.call("llm:get-client");
      const abortController = new AbortController();

      (core.bus.emit as (name: string, payload: unknown) => void)(
        "subagent:started", { task, subagentId: id, type });

      const promise = runSubagent({
        llmClient: llmClient as Parameters<typeof runSubagent>[0]["llmClient"],
        tools,
        systemPrompt,
        task,
        model,
        bus: core.bus,
        maxIterations,
        budgetTokens,
        onUsage: (u) => core.bus.emit("agent:usage", u),
        signal: abortController.signal,
      });

      const entry: SubagentEntry = { id, type, task, startedAt: Date.now(), promise, controller: abortController };
      _subagents.set(id, entry);

      promise.then((result) => {
        entry.result = result;
      }).catch((err) => {
        entry.error = String(err);
      }).finally(() => {
        (core.bus.emit as (name: string, payload: unknown) => void)(
          "subagent:done", { task, subagentId: id });
      });

      // Register context producer once (idempotent) to surface completed
      // subagent results in the next LLM iteration.
      if (!this._contextProducerUnsubscribe) {
        this._contextProducerUnsubscribe = (extCtx as unknown as {
          agent: { registerContextProducer(name: string, producer: () => string | null, opts?: { mode?: string }): () => void }
        }).agent.registerContextProducer(
          "subagent-results",
          () => {
            const completed: string[] = [];
            for (const [eid, e] of _subagents) {
              if (e.result || e.error) {
                completed.push(
                  `<subagent_result id="${eid}" type="${e.type}">\n` +
                  `Completed: "${e.task.slice(0, 80)}"\n` +
                  (e.result ?? `Error: ${e.error}`).slice(0, 2000) +
                  `\n</subagent_result>`
                );
                _subagents.delete(eid);
              }
            }
            if (completed.length === 0) return null;
            return `\nSubagent results available:\n${completed.join("\n")}`;
          },
          { mode: "per-request" }
        );
      }

      return id;
    };

    // ── Subagent model overrides ────────────────────────────────
    // Persisted globally via agent-sh settings so all sessions share them.

    core.handlers.define("subagent:get-models", () => {
      return ((getSettings() as any).subagentModels ?? {}) as Record<string, string>;
    });

    core.handlers.define("subagent:set-model", (opts: { type: string; model: string }) => {
      const current = (getSettings() as any).subagentModels ?? {};
      if (opts.model === "inherit" || !opts.model) {
        delete current[opts.type];
      } else {
        current[opts.type] = opts.model;
      }
      updateSettings({ subagentModels: current } as any);
    });

    const _subagents = this._subagents;
    let _subagentSeq = 0;
    core.handlers.define("subagent:run", async (opts: {
      task: string;
      type?: string;
      async?: boolean;
      systemPrompt?: string;
      model?: string;
      budgetTokens?: number;
      maxIterations?: number;
      signal?: AbortSignal;
      tools?: ToolDefinition[];
    }) => {
      // Resolve type preset
      const preset = opts.type ? SUBAGENT_TYPES[opts.type] : null;
      const systemPrompt = opts.systemPrompt ?? preset?.systemPrompt ?? "";
      const maxIterations = opts.maxIterations ?? preset?.maxIterations ?? 20;
      const budgetTokens = opts.budgetTokens ?? preset?.budgetTokens;
      const rawModel = opts.model ?? (opts.type ? (getSettings() as any).subagentModels?.[opts.type] : undefined) ?? preset?.model;
      // Strip @provider suffix — subagent reuses the main session's provider.
      const model = typeof rawModel === "string" ? rawModel.replace(/@.+$/, "") : rawModel;

      // Tool filtering
      let tools: ToolDefinition[];
      if (opts.tools) {
        tools = opts.tools;
      } else if (preset) {
        if (preset.tools.length === 0) {
          tools = [];
        } else if (preset.tools[0] !== "*") {
          const allTools: ToolDefinition[] = (extCtx as unknown as { agent: { getTools(): ToolDefinition[] } }).agent?.getTools?.() ?? [];
          tools = allTools.filter(t => preset.tools.includes(t.name));
        } else {
          tools = (extCtx as unknown as { agent: { getTools(): ToolDefinition[] } }).agent?.getTools?.() ?? [];
        }
      } else {
        tools = (extCtx as unknown as { agent: { getTools(): ToolDefinition[] } }).agent?.getTools?.() ?? [];
      }

      // Async fire-and-forget: launch subagent in background, return immediately.
      if (opts.async) {
        const type = opts.type ?? "generic";
        const id = launchSubagent(opts.task, type, systemPrompt, tools, model, maxIterations, budgetTokens);
        return `subagent:${id}`;
      }

      // Synchronous: block until subagent completes.
      const llmClient = core.handlers.call("llm:get-client");
      const syncId = `sync-${_subagentSeq++}`;

      (core.bus.emit as (name: string, payload: unknown) => void)("subagent:started", { task: opts.task, systemPrompt, type: opts.type, subagentId: syncId });

      try {
        const result = await runSubagent({
          llmClient: llmClient as Parameters<typeof runSubagent>[0]["llmClient"],
          tools,
          systemPrompt,
          task: opts.task,
          model,
          bus: core.bus,
          signal: opts.signal,
          maxIterations,
          budgetTokens,
          onUsage: (u) => core.bus.emit("agent:usage", u),
        });
        (core.bus.emit as (name: string, payload: unknown) => void)("subagent:done", { task: opts.task, subagentId: syncId });
        return result;
      } catch (err) {
        (core.bus.emit as (name: string, payload: unknown) => void)("subagent:done", { task: opts.task, error: String(err), subagentId: syncId });
        throw err;
      }
    });

    // ── Subagent tools ──────────────────────────────────────────────
    // Each subagent type gets its own tool for optimal LLM discovery.
    const registerSubagentTool = (type: string, cfg: SubagentType) => {
      (extCtx as unknown as { agent: { registerTool(t: ToolDefinition): void } }).agent.registerTool({
        name: type,
        description: cfg.description,
        input_schema: {
          type: "object",
          properties: {
            task: { type: "string", description: "The task for this subagent." },
          },
          required: ["task"],
        },
        async execute(args) {
          const isAsync = cfg.async === true;
          const result = await core.handlers.call("subagent:run", {
            task: (args as { task: string }).task,
            type,
            async: isAsync,
          }) as string;
          return {
            exitCode: 0,
            content: isAsync
              ? `Subagent '${type}' launched. Results will appear in the next turn.`
              : result,
            isError: false,
          };
        },
        formatResult(_args, result) {
          const text = String((result as { content?: unknown })?.content ?? "");
          return { summary: text.slice(0, 200), body: { kind: "lines" as const, lines: text.split("\n") } };
        },
      });
    };
    for (const [name, cfg] of Object.entries(SUBAGENT_TYPES)) {
      registerSubagentTool(name, cfg);
    }

    core.bus.emit("core:extensions-loaded", { names: [...builtinNames, ...userNames] });

    // Strip image_url from conversation when model lacks image support.
    // agent-sh 0.14.11 handles user-submitted images but tool results
    // (read_file on a PNG) still inject image_url unconditionally.
    core.handlers.advise("conversation:prepare", (next, messages) => {
      try {
        const modeInfo = core.handlers.call("agent:get-model") as { model?: string } | undefined;
        const modes = (core.handlers.call("agent:get-models") ?? []) as Array<{ id: string; modalities?: string[] }>;
        const activeMode = modes.find((m) => m.id === modeInfo?.model);
        if (activeMode?.modalities?.includes("image")) return next(messages);
      } catch { /* fall through — strip to be safe */ }
      // Fast path: only mutate messages with array content.
      const msgs = messages as Array<Record<string, unknown>>;
      for (let i = 0; i < msgs.length; i++) {
        const c = msgs[i]!.content;
        if (!Array.isArray(c)) continue;
        const parts = (c as Array<Record<string, unknown>>).filter(
          (p) => p.type !== "image_url"
        );
        if (parts.length !== c.length) {
          msgs[i] = { ...msgs[i], content: parts };
        }
      }
      return next(messages);
    });

    // OpenRouter fetches models asynchronously. When it completes,
    // push a fresh agent:info so the frontend picks up updated modalities.
    core.bus.on("agent:providers:changed", () => {
      setTimeout(() => {
        try {
          const modes = (core.handlers.call("agent:get-models") ?? []) as Array<{ id: string; modalities?: string[]; provider?: string; contextWindow?: number }>;
          const modeInfo = core.handlers.call("agent:get-model") as { model?: string } | undefined;
          const m = modes.find((x) => x.id === modeInfo?.model);
          if (!m || !m.modalities?.length) return;
          this.emit("event", {
            name: "agent:info",
            payload: {
              name: "ash",
              model: m.id,
              provider: m.provider ?? "",
              contextWindow: m.contextWindow,
              modalities: m.modalities,
            },
          } satisfies BusEvent);
        } catch { /* ignore */ }
      }, 0);
    });

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

  // Built-in provider activators inject keys.json keys themselves; user-defined providers have no such activator.
  private registerUserProviders(extCtx: ReturnType<AgentShellCore["extensionContext"]>): void {
    const ctxAgent = (extCtx as unknown as { agent?: { providers?: { register: (reg: Record<string, unknown>) => unknown } } }).agent;
    if (!ctxAgent?.providers?.register) return;
    // register() replaces the whole contribution, so merge over a built-in's prior registration.
    const prior = this.core?.bus.emitPipe("agent:providers", { providers: [] }).providers ?? [];
    const priorById = new Map(prior.map((reg) => [reg.id, reg] as const));
    for (const name of getProviderNames()) {
      const p = resolveProvider(name);
      if (!p) continue;
      if (p.apiKey) continue;
      const resolved = resolveApiKey(name);
      if (!resolved.key) continue;
      const base = priorById.get(name);
      ctxAgent.providers.register({
        id: name,
        apiKey: resolved.key,
        baseURL: p.baseURL ?? base?.baseURL,
        defaultModel: p.defaultModel ?? base?.defaultModel,
        models: p.modelsExplicit ? p.models : (base?.models ?? p.models),
      });
    }
  }

  private activeModelSupportsImage(): boolean {
    if (!this.core) return false;
    const model = (this.core.handlers.call("llm:get-client") as { model?: string } | undefined)?.model;
    if (!model) return false;
    const modes = (this.core.handlers.call("agent:get-models") ?? []) as Array<{ id: string; modalities?: string[] }>;
    return modes.some((m) => m.id === model && m.modalities?.includes("image"));
  }

  // Fail closed for kernels lacking the gate: non-vision models error on image content.
  private gateImageToolResults(extCtx: ReturnType<AgentShellCore["extensionContext"]>): void {
    extCtx.advise("tool:execute", async (next, toolCtx) => {
      const result = await next(toolCtx) as { content?: unknown } | undefined;
      if (result && Array.isArray(result.content) && !this.activeModelSupportsImage()) {
        const name = (toolCtx as { name?: string })?.name ?? "tool";
        return { ...result, content: `[${name} returned image content, but the current model has no image input support, so the image was not loaded.]` };
      }
      return result;
    });
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
      const usage = (payload as { chunk?: { usage?: {
        prompt_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      } } })?.chunk?.usage;
      if (!usage) return;
      // Overwrite, don't accumulate: usage may arrive partially across chunks.
      if (typeof usage.prompt_cache_hit_tokens === "number") {
        lastCacheHit = usage.prompt_cache_hit_tokens;
      }
      if (typeof usage.prompt_cache_miss_tokens === "number") {
        lastCacheMiss = usage.prompt_cache_miss_tokens;
      }
      // OpenAI-standard caching (OpenRouter): derive hit/miss from cached_tokens.
      const cached = usage.prompt_tokens_details?.cached_tokens;
      if (typeof usage.prompt_cache_hit_tokens !== "number"
        && typeof cached === "number" && typeof usage.prompt_tokens === "number") {
        lastCacheHit = cached;
        lastCacheMiss = Math.max(0, usage.prompt_tokens - cached);
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
          // Query multimodal capabilities from agent-sh's mode system.
          let modalities: string[] | undefined;
          try {
            const modes = (core.handlers.call("agent:get-models") ?? []) as Array<{ id: string; modalities?: string[] }>;
            const info = payload as Record<string, unknown>;
            const currentMode = modes.find((m) => m.id === info.model);
            modalities = currentMode?.modalities;
          } catch { /* not available yet */ }
          const enriched = {
            ...(payload as Record<string, unknown>),
            ...(think ? { thinkingLevel: think.level, thinkingSupported: think.supported } : {}),
            ...(modalities ? { modalities } : {}),
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
        }        this.emit("event", { name, payload } satisfies BusEvent);
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
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.resolve({ stopReason: "end_turn" }); }
      setTimeout(() => { this.drainShellQueue(); this.drainQueue(); }, 0);
    });
    onAny("agent:error", (payload) => {
      const message = (payload as { message?: string })?.message ?? "agent error";
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.reject(new Error(message)); }
      setTimeout(() => { this.drainShellQueue(); this.drainQueue(); }, 0);
    });
    onAny("agent:cancelled", () => {
      const t = this.pendingTurn;
      if (t) { this.pendingTurn = null; t.resolve({ stopReason: "cancelled" }); }
      // Abort all running async subagents — their tool calls are still
      // pumping events into the bus even after main cancel.
      for (const [eid, entry] of (this as any)._subagents as Map<string, SubagentEntry>) {
        entry.controller?.abort();
      }
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
    // Check for multimodal payload: { query, images: [{ data, mimeType }] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let images: any;
    let query = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed.query && Array.isArray(parsed.images)) {
        query = parsed.query;
        images = parsed.images.map((img: { data: string; mimeType: string }) => ({
          type: "image" as const, data: img.data, mimeType: img.mimeType,
        }));
      }
    } catch { /* plain text */ }
    return new Promise<{ stopReason: string }>((resolve, reject) => {
      this.pendingTurn = { resolve, reject };
      // agent-sh 0.14.11+ handles images natively: auto-drops for
      // non-multimodal models and builds multimodal content from images.
      this.core!.bus.emit("agent:submit", { query, images });
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
    if (name === "/model" && args) {
      // Bypass slash-commands; resolve the string (id or id@provider) to the
      // (id, provider) pair the switch event now carries.
      const models = (this.core?.handlers.call("agent:get-models") ?? []) as Array<{ id: string; provider: string }>;
      const at = args.lastIndexOf("@");
      const id = at > 0 ? args.slice(0, at) : args;
      const providerHint = at > 0 ? args.slice(at + 1) : undefined;
      const found = models.find((m) => m.id === id && (!providerHint || m.provider === providerHint));
      this.core?.bus.emit("config:switch-model", found
        ? { id: found.id, provider: found.provider }
        : { id, provider: providerHint ?? "" });
      return;
    }
    if (name === "/sa-model" && args) {
      try {
        const parsed = JSON.parse(args) as { type: string; model: string };
        this.core?.handlers.call("subagent:set-model", parsed);
      } catch { /* ignore parse error */ }
      return;
    }
    this.core?.bus.emit("command:execute", { name, args });
  }

  setThinking(level: string): void {
    this.core?.bus.emit("config:set-thinking", { level });
  }

  reloadProviders(): void {
    // agent-sh 0.15.3 calls refreshSettingsProviders() on
    // providers:changed, which re-reads settings.json and
    // merges fresh apiKey/baseURL with the existing provider
    // contributions (which retain the async-fetched model list).
    // config:switch-model then forces agent-loop to re-resolve
    // activeEndpoint and reconfigure llmClient immediately.
    if (!this.core) return;
    // For OpenRouter, re-fetch the full model catalog with the
    // new apiKey so the model list updates without restart.
    try {
      const mode = this.core.handlers.call("agent:get-model") as { model?: string; provider?: string } | undefined;
      if (mode?.provider === "openrouter") {
        const key = resolveApiKey(mode.provider).key ?? "";
        if (key) {
          const ctxAgent = (this.extCtx as unknown as { agent?: { providers?: { register: (reg: Record<string, unknown>) => unknown } } }).agent;
          if (ctxAgent?.providers?.register) {
            this.refetchOpenRouterModels(ctxAgent, key);
          }
        }
      }
    } catch { /* ignore */ }
    this.core.bus.emit("agent:providers:changed", {});
    try {
      const mode = this.core.handlers.call("agent:get-model") as { model?: string; provider?: string } | undefined;
      if (mode?.model && mode?.provider) {
        this.core.bus.emit("config:switch-model", { id: mode.model, provider: mode.provider });
      }
    } catch { /* ignore */ }
  }

  private async refetchOpenRouterModels(
    ctxAgent: { providers?: { register: (reg: Record<string, unknown>) => unknown } },
    apiKey: string,
  ): Promise<void> {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok || !ctxAgent.providers?.register) return;
      const data = (await res.json()) as { data?: Array<{ id: string; supported_parameters?: string[]; context_length?: number; architecture?: { input_modalities?: string[] } }> };
      const models = data.data ?? [];
      if (models.length === 0) return;
      ctxAgent.providers.register({
        id: "openrouter",
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
        defaultModel: "deepseek/deepseek-v4-flash",
        supportsReasoningEffort: true,
        models: models.map((m) => {
          const inputMods = (m.architecture?.input_modalities ?? []) as string[];
          const mods = inputMods.filter((v: string) => v === "text" || v === "image");
          return {
            id: m.id,
            reasoning: m.supported_parameters?.includes("reasoning") ?? false,
            contextWindow: m.context_length,
            modalities: mods.length ? mods : undefined,
          };
        }),
      });
      this.core!.bus.emit("agent:providers:changed", {});
      const modes = (this.core!.handlers.call("agent:get-models") ?? []) as Array<{ id: string; modalities?: string[]; provider?: string; contextWindow?: number }>;
      const modeInfo = this.core!.handlers.call("agent:get-model") as { model?: string } | undefined;
      const m = modes.find((x) => x.id === modeInfo?.model);
      if (m) {
        this.emit("event", {
          name: "agent:info",
          payload: {
            name: "ash",
            model: m.id,
            provider: m.provider ?? "",
            contextWindow: m.contextWindow,
            modalities: m.modalities,
          },
        } satisfies BusEvent);
      }
    } catch { /* ignore */ }
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
    const modes = (this.core.handlers.call("agent:get-models") ?? []) as Array<{ id: string; provider?: string; modalities?: string[] }>;
    const models = modes.map((m) => ({ model: m.id, provider: m.provider ?? "", modalities: m.modalities }));
    return { models, active: null };
  }

  async complete(
    messages: Array<{ role: string; content: string }>,
    opts?: { maxTokens?: number; model?: string },
  ): Promise<string | null> {
    await this.initPromise;
    if (!this.core) return null;
    try {
      const text = (await this.core.handlers.call("llm:invoke", messages, opts)) as string;
      return text?.trim() ? text : null;
    } catch (err) {
      console.error(`[ash-bridge] complete error:`, err);
      return null;
    }
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

  getSubagentModels(): Record<string, string> {
    return (this.core?.handlers.call("subagent:get-models") ?? {}) as Record<string, string>;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Abort and clean up any async subagents still running.
    for (const [, entry] of (this as any)._subagents as Map<any, any>) {
      try { entry.controller?.abort(); } catch {}
    }
    (this as any)._subagents.clear();
    try { this._contextProducerUnsubscribe?.(); } catch {}
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
