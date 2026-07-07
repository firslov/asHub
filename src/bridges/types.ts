/**
 * A Bridge is the hub's view of a single conversation backend. The hub
 * doesn't care whether the agent runs in-process (AshBridge) or behind a
 * JSON-RPC subprocess (AcpBridge) — it only consumes BusEvents and
 * dispatches submit/cancel/close.
 *
 * New backends (e.g. claude-code) just implement this interface.
 */

export interface BusEvent {
  /** Event name as the web client sees it (e.g. "agent:tool-started"). */
  name: string;
  payload: unknown;
}

export type SessionKind = "agent" | "terminal" | "ash-terminal";

export interface BridgeOpts {
  cwd?: string;
  /** What kind of session to spawn. Defaults to "agent". */
  kind?: SessionKind;
  /** Optional model override. Backends free to ignore. */
  model?: string;
  provider?: string;
  /** Backend-specific extras (e.g. spawn command/args for AcpBridge). */
  extra?: Record<string, unknown>;
  /** Messages to seed into the conversation on startup (session restore). */
  initialMessages?: unknown[];
  /** Optional compaction strategy that intercepts conversation:compact. */
  compactionStrategy?: CompactionStrategyHook;
}

export type CompactionStrategyHook = (
  helpers: {
    getMessages(): unknown[];
    replaceMessages(msgs: unknown[]): void;
    estimatePromptTokens(): number;
  },
  opts: unknown,
  next: (opts: unknown) => unknown,
) => Promise<unknown> | unknown;

export type ContextStrategy =
  | { kind: "two-tier-pin"; target: number; keepRecent?: number; force?: boolean }
  | { kind: "rewind"; toIndex: number }
  | { kind: "replace"; messages: unknown[] };

export interface ContextSnapshot {
  messages: unknown[];
  contextWindow: number;
  activeTokens: number;
}

export interface Bridge {
  /** What kind of session this bridge implements. Defaults to "agent". */
  readonly kind?: SessionKind;

  /** Resolves once the underlying agent is initialized and ready for prompts. */
  ready(): Promise<void>;

  /** Submit a prompt; resolves at end of turn. */
  submit(text: string): Promise<{ stopReason: string }>;

  /** Best-effort cancel of the current turn. */
  cancel(): void;

  /** Write raw bytes to the bridge's PTY (both terminal and agent bridges expose one). */
  writePty?(data: string): void;

  /** Forward terminal size to the bridge's PTY. */
  resizePty?(cols: number, rows: number): void;

  /** Dispatch a slash command (e.g. "/model", "gpt-5"). Backends free to no-op. */
  execCommand?(name: string, args: string): void;

  /** Set thinking level silently (no echo, no toast). */
  setThinking?(level: string): void;

  /** Resolve completions for a partial input. Returns suggestions or null if unsupported. */
  autocomplete?(buffer: string): Promise<Array<{ name: string; description: string }> | null>;

  /** True while a turn is in flight (used to detect queueing before submit). */
  isProcessing?(): boolean;

  /** Called by hub when user responds to a permission prompt. */
  decidePermission?(requestId: string, outcome: string, sessionWide?: boolean): void;

  /** Tear down. */
  close(): void;

  /** Snapshot the current message array. May throw if backend doesn't support it. */
  snapshot(): Promise<ContextSnapshot>;

  /** Mutate the context. May throw if backend doesn't support it. */
  compact(strategy: ContextStrategy): Promise<{ before: number; after: number; evictedCount: number } | null>;

  getModels?(): Promise<{
    models: Array<{ model: string; provider: string; modalities?: string[] }>;
    active: { model: string; provider: string } | null;
  }>;

  /** One-off LLM completion via the session's resolved provider (key/baseURL/model). Returns text, or null if unsupported. */
  complete?(
    messages: Array<{ role: string; content: string }>,
    opts?: { maxTokens?: number; model?: string },
  ): Promise<string | null>;

  /** Notify the backend that provider settings have changed (e.g. new API key saved).
   *  The bridge should re-resolve provider registrations. */
  reloadProviders?(): void;

  /** Subscribe to BusEvents the bridge produces. Returns an unsubscriber. */
  onEvent(fn: (e: BusEvent) => void): () => void;

  /** Lifecycle hooks. */
  onClose(fn: () => void): () => void;
  onError(fn: (err: Error) => void): () => void;
}

/** Factory: a function the hub uses to create one Bridge per session. */
export type BridgeFactory = (opts: BridgeOpts) => Bridge;
