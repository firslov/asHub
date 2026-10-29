import type * as http from "node:http";
import type { Bridge, SessionKind } from "../bridges/types.js";
import type { SessionStore } from "../history/session-store.js";
import type { Capture } from "../history/capture.js";
import type { CollaborationTasks } from "../collaboration.js";

export interface QueuedMessage { id: string; query: string; images?: Array<{ id?: string; data?: string; mimeType: string }> }

export interface Session {
  /** Host-owned invalidation hook; never passed to extensions. */
  _onHostChange?: (reason: string) => void;
  id: string;
  title: string;
  kind: SessionKind;
  cwd: string;
  bridge: Bridge;
  /** Lazy-init factory — only set for restored sessions; bridge is created
   *  on first SSE subscription.  Once created, this is cleared. */
  _ensureBridge?: () => Promise<void>;
  _cancelRestore?: () => void;
  replay: string[];
  segmentText: string;
  segmentSeq: number;
  sseClients: Set<http.ServerResponse>;
  model?: string;
  provider?: string;
  startedAt: number;
  /** True once the first user→assistant turn has completed (for auto-title). */
  firstTurnDone: boolean;
  /** The first user query text, captured for auto-title generation. */
  firstQuery?: string;
  /** User-set title (empty = auto-generate). */
  userTitle?: string;
  _titleDirty?: boolean;
  /** Timestamp of last agent activity — used by idle-timeout heartbeat. */
  lastActivity: number;
  /** How many tools are currently running (tracked via agent:tool-started / agent:tool-completed). */
  toolsRunning: number;
  /** Timestamp of most recent modification (create, title change, new turn, command). */
  lastModified: number;
  /** Whether the agent is currently processing a turn. */
  isProcessing: boolean;
  /** Whether the session has new output since the user last viewed it. */
  hasUnread: boolean;
  lastAgentInfo: Record<string, unknown> | null;
  lastRequestStatus?: { phase: string };
  backendState?: Record<string, unknown>;
  backendId?: string;
  collaboration?: CollaborationTasks;
  queuedQueries?: string[];
  withdrawnItems?: Map<string, { requestId: string; item: QueuedMessage }>;
  queuedItems?: Map<string, QueuedMessage>;
  lastTurnError?: boolean;
  pendingPermissions?: Map<string, { expiresAt: number }>;
  store?: SessionStore;
  capture?: Capture;
  _cancelled?: boolean;
  /** Set true when the session is closed/archived.  Late bridge events
   *  must be dropped entirely (no replay persistence, no SSE writes) so
   *  they can't recreate the deleted session files. */
  _closed?: boolean;
  _closing?: boolean;
  /** Set only by closeSession (NOT archiveSession — archived sessions
   *  keep their files for unarchive).  Marks that deleteSessionFiles is
   *  in flight, so a meta write completing mid-deletion must clean up
   *  after itself. */
  _deletingFiles?: boolean;
  _contextBroken?: boolean;
  /** Exclusive, explicitly approved host operation in progress. */
  _hostOperation?: boolean;
  /** HTTP commands may await provider setup without starting an agent turn. */
  _commandsRunning?: number;
  _uploads?: Set<Promise<unknown>>;
  /** Idle-watchdog timer handle — see startIdleWatchdog/stopIdleWatchdog. */
  _idleTimer?: ReturnType<typeof setTimeout>;
  /** Timestamp when the idle window was first exceeded (0 = not exceeded). */
  _idleSince?: number;
  /** Token identifying the current idle-watchdog owner (turn). */
  _idleToken?: number;
  /** Watchdog token owned by the currently-running queued turn — stopped
   *  by token on agent:queued-done so a late queued-done can never kill a
   *  newer turn's watchdog (same discipline as submit()'s wdToken). */
  _queuedWdToken?: number;
  contextLock: Promise<void>;
  /** Highest frameSeq ever emitted for this session — persisted in meta. */
  lastFrameSeq: number;
  /** True until the session has been fully restored from disk (lazy Phase 2). */
  _needsRestore?: boolean;
  /** Guards against concurrent _ensureBridge calls (page HTML + SSE arriving together). */
  _restorePromise?: Promise<void>;
  /** Next replay index tagLastQueryFrame has not yet classified.  Incremental
   *  watermark so each frame's JSON.parse happens once per session instead of
   *  once per turn-end flush.  Reset on replay rebuilds. */
  _tagScanIdx?: number;
  /** Untagged non-command query frames awaiting an entryId tag, newest first.
   *  Entries are dropped after MAX_TAG_ATTEMPTS failed flushes. */
  _tagPending?: Array<{ idx: number; query: string; attempts: number }>;
  /** PTY-output coalescing state (terminal sessions): raw chunks accumulated
   *  during the current merge window, flushed as a single shell:pty-data
   *  frame.  _ptyMeta is the meta of the window's first chunk. */
  _ptyChunks?: string[];
  _ptyBuffered?: number;
  _ptyTimer?: ReturnType<typeof setTimeout>;
  _ptyMeta?: { source: string; ts: number; id: string; name: string };
  /** FIFO of transient replay frames (pty-data, ui notices) with size
   *  accounting so the in-memory scrollback stays bounded — transient frames
   *  are never persisted, so without a cap a busy terminal accumulates one
   *  full SSE frame per PTY chunk forever. */
  _transientFrames?: string[];
  _transientSize?: number;
}
