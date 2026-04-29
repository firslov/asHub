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

export interface BridgeOpts {
  cwd?: string;
  /** Optional model override. Backends free to ignore. */
  model?: string;
  /** Optional provider override. */
  provider?: string;
  /** Backend-specific extras (e.g. spawn command/args for AcpBridge). */
  extra?: Record<string, unknown>;
}

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
  /** Resolves once the underlying agent is initialized and ready for prompts. */
  ready(): Promise<void>;

  /** Submit a prompt; resolves at end of turn. */
  submit(text: string): Promise<{ stopReason: string }>;

  /** Best-effort cancel of the current turn. */
  cancel(): void;

  /** Dispatch a slash command (e.g. "/model", "gpt-5"). Backends free to no-op. */
  execCommand?(name: string, args: string): void;

  /** Resolve completions for a partial input. Returns suggestions or null if unsupported. */
  autocomplete?(buffer: string): Promise<Array<{ name: string; description: string }> | null>;

  /** True while a turn is in flight (used to detect queueing before submit). */
  isProcessing?(): boolean;

  /** Tear down. */
  close(): void;

  /** Snapshot the current message array. May throw if backend doesn't support it. */
  snapshot(): Promise<ContextSnapshot>;

  /** Mutate the context. May throw if backend doesn't support it. */
  compact(strategy: ContextStrategy): Promise<{ before: number; after: number; evictedCount: number } | null>;

  /** Subscribe to BusEvents the bridge produces. Returns an unsubscriber. */
  onEvent(fn: (e: BusEvent) => void): () => void;

  /** Lifecycle hooks. */
  onClose(fn: () => void): () => void;
  onError(fn: (err: Error) => void): () => void;
}

/** Factory: a function the hub uses to create one Bridge per session. */
export type BridgeFactory = (opts: BridgeOpts) => Bridge;
