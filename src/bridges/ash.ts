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
import { getSettings, reloadSettings, resolveProvider, getProviderNames, CONFIG_DIR } from "agent-sh/settings";
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

// AbortSignal.timeout() aborts with a TimeoutError reason. runSubagent only
// breaks its loop on signal.aborted and returns partial text, so callers
// must check this to tell a wall-clock timeout apart from a normal finish.
function isTimeoutSignal(signal: AbortSignal): boolean {
  return signal.aborted && (signal.reason as { name?: string } | undefined)?.name === "TimeoutError";
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
  // agent:error is NOT forwarded: the wire handler below rejects the
  // pendingTurn and the hub's submit() catch synthesizes the error frame.
  // Forwarding it too would render the same error card twice.
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
  // todolist tool state — payload {todos:[{title,status}]}, full replacement
  // each time, so the frontend just swaps its TODO card contents.
  "agent:todo",
  // Subagent token usage — forwarded for observability, but kept off the
  // "agent:usage" path so it never steals the main turn's cache stats.
  "subagent:usage",
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

You start with zero context beyond this prompt and the task — if critical information is missing, state your assumptions explicitly instead of stalling.

- Break the task into numbered phases with concrete, ordered steps
- Consider dependencies between steps
- Note any assumptions or prerequisites
- Keep the plan actionable and focused
- Do NOT execute anything — only plan
- Return ONLY the plan text: the caller sees nothing but your final message, so make it self-contained — no meta-commentary`,
    tools: [],
    maxIterations: 1,
    budgetTokens: 4000,
  },
  explore: {
    description: "Explore and search the codebase to answer a question. Use when asked to 'explore', 'search', 'find', 'locate', or 'look up' code. Read-only.",
    systemPrompt: `You are a codebase explorer. Your job is to search, read, and understand code to answer questions.

You start with zero context beyond this prompt and the task.

- Use glob, grep, and read_file to investigate
- Never modify or create files
- Cite file paths and line numbers for every finding
- Be thorough but concise
- Return a self-contained answer: the caller sees nothing but your final message — give conclusions and key evidence, not a log of your search steps`,
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 15,
    budgetTokens: 8000,
  },
  review: {
    description: "Review code for bugs, style issues, and improvement opportunities. Use when user asks to 'review', 'check', 'audit', or 'inspect' code. Read-only.",
    systemPrompt: `You are a code reviewer. Your job is to examine code and provide actionable feedback.

You start with zero context beyond this prompt and the task.

- Read the relevant files thoroughly before commenting — never report a problem you haven't verified in the code
- Identify bugs, logic errors, edge cases, and performance issues
- Check for adherence to conventions and best practices
- Organize findings by severity: critical, important, nice-to-have
- Cite exact file paths and line numbers for each finding
- Be constructive — suggest concrete fixes, not just problems
- Return a self-contained report: the caller sees nothing but your final message`,
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 30,
    budgetTokens: 16000,
  },
  research: {
    description: "Deep investigation of code structure and dependencies. Use when asked to 'research', 'investigate', 'trace', 'analyze' or 'understand how' code works. Read-only.",
    systemPrompt: `You are a code archaeologist. Your job is to deeply understand how code works.

You start with zero context beyond this prompt and the task.

- Trace function calls across files — follow the chain
- Map dependencies between modules
- Identify patterns, anti-patterns, and architectural decisions
- Explain WHY the code works the way it does, not just HOW
- Structure your report: overview → details → implications
- Cite every file path and line number
- Return a self-contained report: the caller sees nothing but your final message`,
    tools: ["glob", "grep", "read_file", "ls"],
    maxIterations: 20,
    budgetTokens: 10000,
  },
  implement: {
    description: "Implement a feature or change end-to-end. Use when asked to 'implement', 'build', 'create', 'add', 'write code for', or 'develop' something. Can read, write, and edit files.",
    systemPrompt: `You are an implementation specialist. Your job is to write working code.

You start with zero context beyond this prompt and the task.

- Plan before you type — understand what needs to change
- Read existing code first and follow its patterns and conventions
- Make focused, minimal changes — no unnecessary refactoring or reformatting
- Deliver complete code: never stub out work with placeholders like "// rest unchanged"
- Verify your changes with the project's own tests or build when available
- File-modifying tool calls may trigger a user approval prompt — that is expected, wait for it
- Return a self-contained summary of what you changed and why: the caller sees nothing but your final message`,
    tools: ["*"],
    maxIterations: 25,
    budgetTokens: 12000,
  },
};

/** Names of the five subagent preset tools — stripped from subagent tool
 *  lists so a subagent can never spawn another subagent (unbounded nesting). */
const SUBAGENT_TOOL_NAMES = new Set(Object.keys(SUBAGENT_TYPES));
/** Max subagents running at once; excess runs are rejected with a retry hint. */
const MAX_CONCURRENT_SUBAGENTS = 3;
/** Wall-clock cap per subagent run, merged with any caller/cancel signal. */
const SUBAGENT_TIMEOUT_MS = 20 * 60 * 1000;

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

// ── todolist tool ─────────────────────────────────────────────────

type TodoStatus = "pending" | "in_progress" | "done";
interface TodoItem {
  title: string;
  status: TodoStatus;
}
const TODO_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "done"]);

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return "No todos.";
  return todos.map((t, i) => `${i + 1}. [${t.status}] ${t.title}`).join("\n");
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
  private pendingPermissions = new Map<string, { resolve: (d: { outcome: string; reason?: string }) => void; timer: ReturnType<typeof setTimeout>; kind: string }>();
  private permissionSessionApproved = new Set<string>();
  private autoApprove = false;
  private _contextProducerUnsubscribe: (() => void) | null = null;
  private _subagents: Map<string, SubagentEntry> = new Map();
  private _todos: TodoItem[] = [];
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
    // Read auto-approve setting from disk
    try {
      const raw = await fs.promises.readFile(path.join(os.homedir(), ".agent-sh", "settings.json"), "utf-8");
      const data = JSON.parse(raw);
      this.autoApprove = !!data["ashub.permissions.autoApprove"];
    } catch {}

    const core = createCore({ model: this.opts.model, provider: this.opts.provider });
    this.core = core;

    this.wire(core);

    // Signal to extensions (e.g. ember) that this session uses ephemeral
    // history so they should not hijack history handlers to a file backend.
    core.handlers.define("config:get-history-mode", () => "none");

    // Tell the LLM it's running inside asHub — the web-hosted agent runtime.
    core.handlers.define("system-prompt:frontend", () =>
      `# asHub Runtime\n\n` +
      `You are running inside **asHub**, a desktop agent host. The user talks to you ` +
      `through a browser chat UI that renders your replies as rich Markdown (code ` +
      `highlighting, math, diffs). You act through your tools — never instruct the ` +
      `user to run terminal commands themselves.\n\n` +
      `## Principles\n\n` +
      `- Be helpful, concise, accurate, and candid. Skip flattery and filler — a ` +
      `correct, plainly-stated answer respects the user. When you are unsure, or the ` +
      `user is wrong, say so and show your reasoning.\n` +
      `- Reply in the user's language; keep code, identifiers, and paths in their original form.\n` +
      `- Make minimal, targeted changes that match the project's existing conventions ` +
      `and style. Do not refactor, reformat, or rename beyond what the task requires.\n` +
      `- Default to action: once the goal is clear, carry it through and work around ` +
      `blockers yourself. Ask only when the answer would change your next step.\n` +
      `- Verify before you claim done: run the tests or builds that cover your change ` +
      `and look at the result. If you could not verify something, say so plainly.\n\n` +
      `## Tools and safety\n\n` +
      `- Prefer a dedicated tool over a raw shell command when one fits the job; batch ` +
      `independent tool calls together instead of issuing them one at a time.\n` +
      `- Before destructive or hard-to-reverse actions (deleting files or branches, ` +
      `dropping data, force-pushing, killing processes), confirm with the user first ` +
      `— unless they clearly asked for exactly that.\n\n` +
      `## Delegating to subagents\n\n` +
      `You have five subagent tools: \`plan\` (step-by-step plan), \`explore\` (locate ` +
      `code, answer where-is-X), \`review\` (audit for bugs), \`research\` (trace how ` +
      `something works), \`implement\` (write code end-to-end).\n` +
      `- Delegate substantial, well-scoped work: it keeps long file dumps out of your ` +
      `own context, and you get back only the conclusion.\n` +
      `- Subagents start with zero context. Brief them like a colleague who just walked ` +
      `in: the goal, exact file paths, and what you already know.\n` +
      `- Do not delegate understanding you need yourself — read the code you must reason about.\n` +
      `- When delegating several tasks at once, give each a distinct, non-overlapping scope.`
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
      `FILE MODIFICATION POLICY:

When the user directly asks you to modify, create, or edit files, make those
changes immediately with the appropriate tools.

When the user does NOT ask for file changes (a question, analysis, review, or
explanation), do not modify any files. Describe what you would change and why,
and ask for confirmation first: "I could modify X to achieve Y. Shall I proceed?"

This applies to all file-modifying tools: write_file, edit_file, and bash used
for destructive operations (rm, mv, sed, git mutations). Depending on the user's
settings, such tool calls may trigger an approval prompt — that is expected.`
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

    // runSubagent emits its own tool-started/completed/chunk events when
    // given a bus. Our execute wrapper below already routes every call
    // through the kernel's "tool:execute" handler (which emits those same
    // events), so runSubagent gets a muted bus to avoid double rendering.
    const mutedSubagentBus = {
      emit: () => {},
      emitTransform: (_name: string, payload: unknown) => payload,
    } as unknown as NonNullable<Parameters<typeof runSubagent>[0]["bus"]>;

    // Wrap each tool so execution goes through core.handlers "tool:execute"
    // — the same path the main agent loop takes — instead of runSubagent's
    // direct tool.execute(). This makes the permission gate (file-write
    // approval) and the image gate apply to subagents too. The wrapper
    // re-emits output chunks itself since runSubagent's bus is muted.
    const wrapSubagentTools = (tools: ToolDefinition[], signal: AbortSignal, prefix: string): ToolDefinition[] => {
      let toolCallSeq = 0;
      return tools.map((tool) => ({
        ...tool,
        execute: (args: Record<string, unknown>) => {
          // Prefix with the launch's subagentId (matches subagent:started) so
          // concurrent subagents can't emit colliding toolCallIds — the
          // frontend pairs tool events by data-call-id.
          const toolCallId = `${prefix}-tool-${++toolCallSeq}`;
          return core.handlers.call("tool:execute", {
            name: tool.name,
            id: toolCallId,
            args,
            tool,
            onChunk: (chunk: string) => {
              (core.bus.emit as (name: string, payload: unknown) => void)(
                "agent:tool-output-chunk", { chunk, toolCallId });
            },
            signal,
          }) as ReturnType<ToolDefinition["execute"]>;
        },
      }));
    };

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
      // Cancel sources: our own controller (main-turn cancel via the
      // agent:cancelled listener / bridge close) and the wall-clock timeout.
      // The caller's (turn-scoped) signal is deliberately NOT merged here:
      // the kernel aborts the previous turn's controller on every new query,
      // which would silently kill fire-and-forget subagents on the user's
      // next message — exactly when their results are due to be injected.
      const signal = AbortSignal.any([abortController.signal, AbortSignal.timeout(SUBAGENT_TIMEOUT_MS)]);
      _runningSubagents++;

      (core.bus.emit as (name: string, payload: unknown) => void)(
        "subagent:started", { task, subagentId: id, type });

      const promise = runSubagent({
        llmClient: llmClient as Parameters<typeof runSubagent>[0]["llmClient"],
        tools: wrapSubagentTools(tools, signal, id),
        systemPrompt,
        task,
        model,
        bus: mutedSubagentBus,
        maxIterations,
        budgetTokens,
        onUsage: (u) => (core.bus.emit as (name: string, payload: unknown) => void)(
          "subagent:usage", { ...(u as Record<string, unknown>), type }),
        signal,
      });

      const entry: SubagentEntry = { id, type, task, startedAt: Date.now(), promise, controller: abortController };
      _subagents.set(id, entry);

      promise.then((result) => {
        if (isTimeoutSignal(signal)) {
          // Wall-clock timeout: runSubagent broke out silently and returned
          // partial text — mark it so it isn't presented as a success.
          const minutes = SUBAGENT_TIMEOUT_MS / 60000;
          entry.result = `${result}\n\n[subagent terminated: timeout after ${minutes}min]`;
          entry.error = `timeout after ${minutes}min`;
        } else {
          entry.result = result;
        }
      }).catch((err) => {
        entry.error = String(err);
      }).finally(() => {
        _runningSubagents--;
        (core.bus.emit as (name: string, payload: unknown) => void)(
          "subagent:done", { task, subagentId: id, ...(entry.error ? { error: entry.error } : {}) });
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
                // Prefer the error narrative: a timeout/error entry may also
                // carry partial result text — don't label it "Completed".
                const body = e.error
                  ? `Error: ${e.error}${e.result ? `\nPartial: ${e.result.slice(0, 2000)}` : ""}`
                  : (e.result ?? "").slice(0, 2000);
                completed.push(
                  `<subagent_result id="${eid}" type="${e.type}">\n` +
                  `${e.error ? "Failed" : "Completed"}: "${e.task.slice(0, 80)}"\n` +
                  body +
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
      // Bypass updateSettings(): its deepMerge only ever adds keys, so an
      // 'inherit' delete would resurrect from disk on the next read.
      // Read-modify-write the subagentModels field wholesale instead,
      // then drop the getSettings() cache so it re-reads.
      const settingsPath = path.join(CONFIG_DIR, "settings.json");
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>; } catch {}
      const current = { ...((data.subagentModels as Record<string, string> | undefined) ?? {}) };
      if (opts.model === "inherit" || !opts.model) {
        delete current[opts.type];
      } else {
        current[opts.type] = opts.model;
      }
      data.subagentModels = current;
      try {
        fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
        reloadSettings();
      } catch (err) {
        process.stderr.write(`[ash-bridge] failed to persist subagent model override: ${err instanceof Error ? err.message : err}\n`);
      }
    });

    // Type metadata for the frontend subagent panel (contract C3).
    core.handlers.define("subagent:get-types", () =>
      Object.entries(SUBAGENT_TYPES).map(([type, cfg]) => ({
        type,
        description: cfg.description,
        tools: cfg.tools,
        maxIterations: cfg.maxIterations,
        budgetTokens: cfg.budgetTokens,
        async: cfg.async === true,
      })),
    );

    const _subagents = this._subagents;
    let _subagentSeq = 0;
    let _runningSubagents = 0;
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
      // Concurrency cap — tell the model to retry later rather than queue.
      // Returned as a tagged object (not a string) so registerSubagentTool
      // can surface it as an isError tool result instead of fake success.
      if (_runningSubagents >= MAX_CONCURRENT_SUBAGENTS) {
        return { concurrencyLimited: true as const, message: `Error: subagent concurrency limit reached (${MAX_CONCURRENT_SUBAGENTS} running). Wait for a running subagent to finish, then retry.` };
      }
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
      // Never hand a subagent the subagent tools themselves — `["*"]`
      // (implement) would otherwise allow unbounded nesting.
      tools = tools.filter((t) => !SUBAGENT_TOOL_NAMES.has(t.name));

      // Async fire-and-forget: launch subagent in background, return immediately.
      // The turn-scoped opts.signal is intentionally not forwarded — a
      // background subagent must outlive the turn that launched it.
      if (opts.async) {
        const type = opts.type ?? "generic";
        const id = launchSubagent(opts.task, type, systemPrompt, tools, model, maxIterations, budgetTokens);
        return `subagent:${id}`;
      }

      // Synchronous: block until subagent completes.
      const llmClient = core.handlers.call("llm:get-client");
      const syncId = `sync-${_subagentSeq++}`;
      // Merge the caller's cancel signal with a wall-clock timeout.
      const syncSignals = [AbortSignal.timeout(SUBAGENT_TIMEOUT_MS)];
      if (opts.signal) syncSignals.push(opts.signal);
      const signal = AbortSignal.any(syncSignals);

      (core.bus.emit as (name: string, payload: unknown) => void)("subagent:started", { task: opts.task, systemPrompt, type: opts.type, subagentId: syncId });

      try {
        // Increment inside the try so an emit/launch failure above can't leak
        // the concurrency counter (finally always decrements).
        _runningSubagents++;
        const result = await runSubagent({
          llmClient: llmClient as Parameters<typeof runSubagent>[0]["llmClient"],
          tools: wrapSubagentTools(tools, signal, syncId),
          systemPrompt,
          task: opts.task,
          model,
          bus: mutedSubagentBus,
          signal,
          maxIterations,
          budgetTokens,
          onUsage: (u) => (core.bus.emit as (name: string, payload: unknown) => void)(
            "subagent:usage", { ...(u as Record<string, unknown>), type: opts.type }),
        });
        if (isTimeoutSignal(signal)) {
          // Wall-clock timeout: runSubagent broke out silently and returned
          // partial text — surface as an error so neither the model nor the
          // UI treats truncated output as success.
          const minutes = SUBAGENT_TIMEOUT_MS / 60000;
          (core.bus.emit as (name: string, payload: unknown) => void)("subagent:done", { task: opts.task, subagentId: syncId, error: `timeout after ${minutes}min` });
          return { subagentTimedOut: true as const, message: `${result}\n\n[subagent terminated: timeout after ${minutes}min]` };
        }
        (core.bus.emit as (name: string, payload: unknown) => void)("subagent:done", { task: opts.task, subagentId: syncId });
        return result;
      } catch (err) {
        (core.bus.emit as (name: string, payload: unknown) => void)("subagent:done", { task: opts.task, error: String(err), subagentId: syncId });
        throw err;
      } finally {
        _runningSubagents--;
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
        async execute(args, _onChunk, toolCtx) {
          const isAsync = cfg.async === true;
          const result = await core.handlers.call("subagent:run", {
            task: (args as { task: string }).task,
            type,
            async: isAsync,
            // Forward the kernel's abort signal so cancelling the main
            // turn also cancels a running synchronous subagent.
            signal: toolCtx?.signal,
          }) as string | { concurrencyLimited: true; message: string } | { subagentTimedOut: true; message: string };
          if (typeof result !== "string") {
            // Concurrency-cap / timeout — surface as a real tool error so
            // the model doesn't have to sniff the text.
            return { exitCode: 1, content: result.message, isError: true };
          }
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

    // ── todolist tool ─────────────────────────────────────────────
    // Session-scoped TODO list, modelled on Kimi Code's TodoList: full
    // replacement semantics, omit `todos` to query, `[]` to clear. State
    // lives on the bridge (one per session); every update is broadcast as
    // an "agent:todo" bus event so the web UI can mirror it.
    (extCtx as unknown as { agent: { registerTool(t: ToolDefinition): void } }).agent.registerTool({
      name: "todolist",
      description:
        `Maintain a structured TODO list to track progress on multi-step tasks. ` +
        `Each call REPLACES the whole list — always pass the complete list, not just the changed items. ` +
        `Omit the 'todos' argument to query the current list; pass an empty array to clear it. ` +
        `Guidelines: keep exactly one item in_progress while work is underway; mark an item done ` +
        `immediately when finished instead of batching completions at the end; keep titles short and actionable.`,
      input_schema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "Full replacement TODO list. Omit to query; pass [] to clear.",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Short, actionable title." },
                status: { type: "string", enum: ["pending", "in_progress", "done"] },
              },
              required: ["title"],
            },
          },
        },
      },
      // List state only — never touches files, so skip the permission gate.
      modifiesFiles: false,
      execute: async (args) => {
        const raw = (args as { todos?: unknown }).todos;
        if (raw === undefined) {
          return { exitCode: 0, content: renderTodos(this._todos), isError: false };
        }
        if (!Array.isArray(raw)) {
          return { exitCode: 1, content: "Error: 'todos' must be an array of {title, status} items.", isError: true };
        }
        const next: TodoItem[] = [];
        for (let i = 0; i < raw.length; i++) {
          const item = raw[i] as Record<string, unknown> | null;
          const title = typeof item?.title === "string" ? item.title.trim() : "";
          if (!title) {
            return { exitCode: 1, content: `Error: todos[${i}] must have a non-empty string 'title'.`, isError: true };
          }
          const status = (item?.status ?? "pending") as TodoStatus;
          if (!TODO_STATUSES.has(status)) {
            return { exitCode: 1, content: `Error: todos[${i}].status '${String(item?.status)}' is invalid — use 'pending', 'in_progress', or 'done'.`, isError: true };
          }
          next.push({ title, status });
        }
        // At most one in_progress: first one wins, the rest drop to pending.
        let demoted = 0;
        let seenActive = false;
        for (const t of next) {
          if (t.status !== "in_progress") continue;
          if (seenActive) { t.status = "pending"; demoted++; }
          else seenActive = true;
        }
        this._todos = next;
        (core.bus.emit as (name: string, payload: unknown) => void)("agent:todo", { todos: next });
        let text = renderTodos(next);
        if (demoted > 0) {
          text += `\n(Note: ${demoted} extra in_progress item(s) demoted to pending — only one task may be in progress at a time.)`;
        }
        return { exitCode: 0, content: text, isError: false };
      },
      formatResult(_args, result) {
        const text = String((result as { content?: unknown })?.content ?? "");
        return { summary: text.split("\n")[0]?.slice(0, 200) ?? "", body: { kind: "lines" as const, lines: text.split("\n") } };
      },
    });

    core.bus.emit("core:extensions-loaded", { names: [...builtinNames, ...userNames] });

    // Permission gate for file-modifying tools
    core.handlers.advise("tool:execute", async (next: (ctx: unknown) => Promise<unknown>, ctx) => {
      const args = (ctx as { args?: Record<string, unknown> }).args || {};
      const tool = (ctx as { tool?: ToolDefinition }).tool;
      const name = (ctx as { name?: string }).name || "unknown";
      if (!tool?.modifiesFiles) return next(ctx);
      if (this.autoApprove) return next(ctx);

      const metaPath = (args.path || args.command || "") as string;
      const permPayload = { kind: "file-write", title: `${name}: ${metaPath}`, description: (args.description || "") as string, metadata: { filePath: args.path || metaPath, diff: args.diff } };
      const result = await (core.bus.emitPipeAsync as (name: string, payload: unknown) => Promise<unknown>)("permission:request", permPayload) as Record<string, unknown>;
      const decision = result?.decision as { outcome: string; reason?: string } | undefined;

      if (decision?.outcome !== "approved") {
        return { content: `Permission denied: ${decision?.reason || "denied by user"}`, exitCode: 1, isError: true };
      }
      return next(ctx);
    });

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
          onSubmit: (query, _b) => {
            // Route through submit() so '>' queries join the same
            // pendingTurn/queryQueue serialization as hub-submitted turns
            // instead of emitting agent:submit directly and interrupting
            // a turn already in progress.
            this.submit(query).catch((err) => {
              process.stderr.write(`[ash-bridge] '>' mode submit failed: ${err instanceof Error ? err.message : err}\n`);
            });
          },
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
      let base = next();
      const cwd = core.handlers.call("cwd");
      if (typeof cwd !== "string" || !cwd) return base;

      // ── Deduplicate "Available Skills" headings ───────────────────
      // agent-sh's system-prompt:build emits two "# Available Skills"
      // blocks (global skills then project skills). Merge them into one.
      const skillsHeading = "# Available Skills";
      const skillsSections: string[] = [];
      let cleaned = base;
      const headingRegex = /^# Available Skills\n\n/m;
      let match = headingRegex.exec(cleaned);
      while (match) {
        const start = match.index;
        // Find the next top-level heading or end of string
        const rest = cleaned.slice(start + skillsHeading.length);
        const nextHeading = rest.search(/^# /m);
        const end = nextHeading === -1
          ? cleaned.length
          : start + skillsHeading.length + nextHeading;
        skillsSections.push(cleaned.slice(start + skillsHeading.length, end).trim());
        cleaned = cleaned.slice(0, start) + cleaned.slice(end);
        match = headingRegex.exec(cleaned);
      }
      if (skillsSections.length > 1) {
        // Rebuild: insert a single merged Available Skills block
        const merged = skillsSections.join("\n\n");
        const insertionPoint = cleaned.indexOf("# Extension Instructions");
        if (insertionPoint !== -1) {
          cleaned = cleaned.slice(0, insertionPoint)
            + `${skillsHeading}\n\n${merged}\n\n`
            + cleaned.slice(insertionPoint);
        } else {
          cleaned += `\n\n${skillsHeading}\n\n${merged}`;
        }
        base = cleaned;
      }

      // ── Condense agent-sh source paths ────────────────────────────
      // The STATIC_GUIDE includes verbose paths to agent-sh's own
      // source/docs/examples. Replace with a single compact line.
      base = base.replace(
        /^agent-sh source and documentation live at [^\n]+\n(?:- [^\n]+\n){3}\n/gm,
        "agent-sh documentation is at the `docs/` directory inside the agent-sh package; "
        + "source and examples live in `src/` and `examples/extensions/`. "
        + "Read them when you need to understand how the runtime works.\n\n",
      );

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
      // Stop means stop: discard queued queries instead of draining into
      // the next one. Pair each drop with queued-done (mirroring the
      // queued-submit/queued-done pair) so hub-side queue state settles.
      this.dropQueued();
      setTimeout(() => { this.drainShellQueue(); }, 0);
    });

    // Permission gate — forward to UI as an event (so the diff preview
    // renders) and auto-approve. When the web UI grows a prompt, swap the
    // approval for a routed decision.
    const onPipe = bus.onPipeAsync.bind(bus) as unknown as (
      name: string,
      fn: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => void;
    onPipe("permission:request", async (payload) => {
      // Session-level auto-approve (user clicked "Approve All")
      const kind = (payload.kind || "") as string;
      if (this.permissionSessionApproved.has(kind)) {
        payload.decision = { outcome: "approved" };
        return payload;
      }

      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const p = payload as Record<string, unknown>;
      p.requestId = requestId;

      // Forward to client for user approval
      this.emit("event", { name: "permission:request", payload: p });

      // Wait for user decision (30s timeout → auto-deny)
      const decision = await new Promise<{ outcome: string; reason?: string }>((resolve) => {
        const timer = setTimeout(() => resolve({ outcome: "denied", reason: "timeout" }), 30_000);
        this.pendingPermissions.set(requestId, { resolve, timer, kind });
      });

      payload.decision = decision;
      return payload;
    });
  }

  /** Called by hub when user clicks Approve/Deny/ApproveAll on permission prompt. */
  decidePermission(requestId: string, outcome: string, sessionWide?: boolean): void {
    const entry = this.pendingPermissions.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.resolve({ outcome });
    if (sessionWide && outcome === "approved") {
      this.permissionSessionApproved.add(entry.kind);
    }
    this.pendingPermissions.delete(requestId);
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApprove = enabled;
    if (enabled) {
      for (const [, entry] of this.pendingPermissions) {
        clearTimeout(entry.timer);
        entry.resolve({ outcome: "approved" });
      }
      this.pendingPermissions.clear();
    }
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
      reject: (err: unknown) => {
        // agent:error is NOT forwarded (see FORWARDED): direct turns surface
        // it via the hub's submit() catch, but a queued turn has no such
        // path — emit it here or the error would be swallowed entirely.
        const message = err instanceof Error ? err.message : String(err ?? "agent error");
        this.emit("event", { name: "agent:error", payload: { message } } satisfies BusEvent);
        this.emit("event", { name: "agent:queued-done", payload: {} } satisfies BusEvent);
      },
    };
    this.emit("event", { name: "agent:queued-submit", payload: { query: next } } satisfies BusEvent);
    this.core.bus.emit("agent:submit", { query: next });
  }

  // Discard all queued queries, emitting queued-done for each so every
  // queued message still gets its queued-submit/queued-done pair. The
  // payload carries the dropped query text + dropped flag so the hub can
  // push a frame the frontend uses to clear its pending box (otherwise
  // the box lingers forever and reappears on replay).
  private dropQueued(): void {
    while (this.queryQueue.length > 0) {
      const dropped = this.queryQueue.shift()!;
      this.emit("event", { name: "agent:queued-done", payload: { query: dropped, dropped: true } } satisfies BusEvent);
    }
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
        this.dropQueued();
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

  getSubagentTypes(): Array<Record<string, unknown>> {
    return (this.core?.handlers.call("subagent:get-types") ?? []) as Array<Record<string, unknown>>;
  }

  /** Relay a hub-side event into the agent's internal bus so subsystems
   *  that subscribe to lifecycle events (e.g. shell:cwd-change) stay in
   *  sync when the user changes settings through the UI. */
  relayEvent(name: string, payload: unknown): void {
    if (!this.core) return;
    (this.core.bus.emit as (n: string, p: unknown) => void)(name, payload);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Abort and clean up any async subagents still running.
    for (const [, entry] of (this as any)._subagents as Map<any, any>) {
      try { entry.controller?.abort(); } catch {}
    }
    (this as any)._subagents.clear();
    this._todos = [];
    // Deny any pending permission requests
    for (const [, entry] of this.pendingPermissions) {
      clearTimeout(entry.timer);
      entry.resolve({ outcome: "denied", reason: "bridge closed" });
    }
    this.pendingPermissions.clear();
    this.permissionSessionApproved.clear();
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
