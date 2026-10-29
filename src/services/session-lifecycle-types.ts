import type { Bridge, BridgeFactory, BusEvent, ConversationAccess, SessionKind } from "../bridges/types.js";
import type { HostAccess } from "../host-operations.js";
import type { CollaborationTasks } from "../collaboration.js";
import type { SessionStore } from "../history/session-store.js";
import type { createCapture } from "../history/capture.js";
import type { createCompactionStrategy } from "../history/compaction-strategy.js";
import type { Session } from "./session-types.js";

export interface SessionLifecycleOptions {
  makeBridge: BridgeFactory;
  signal?: AbortSignal;
  conversationAccess?: (id: string) => ConversationAccess;
  hostAccess?: (id: string) => HostAccess;
  collaboration?: CollaborationTasks;
}
export interface RestoredSession {
  id: string; title?: string; kind?: SessionKind; replay: string[]; startedAt: number;
  messages?: unknown[]; firstQuery?: string; userTitle?: string; model?: string;
  provider?: string; lastModified?: number; lastFrameSeq?: number;
  backendState?: Record<string, unknown>; backendId?: string;
}
export interface PersistedLifecycleSession extends RestoredSession { cwd: string }
export interface PendingSessionInitialization { cancel(): void; done: Promise<void> }

/** Ports intentionally expose operations rather than copies of hub lock maps. */
export interface SessionLifecycleAdapters {
  persistence: {
    directory: string;
    metadataPath(id: string): string;
    saveMetadata(session: Session): Promise<void>;
    deleteFiles(id: string): Promise<void>;
    persistReplay(id: string, frames: string[]): Promise<void>;
    claimReplay(session: Session): void;
    /** Cancel both write timers, await existing replay/meta locks, release replay
     * ownership. Must use the same queues as archive/delete/shutdown. */
    settleFailedInitialization(id: string): Promise<void>;
    migrateLegacy(): Promise<void>;
    loadFrameSequence(): Promise<void>;
    loadPersisted(): Promise<PersistedLifecycleSession[]>;
    loadArchived(): Promise<Map<string, number>>;
    /** Monotonic max update; mark dirty only when a higher value is observed. */
    advanceFrameSequence(value: number, dirty: boolean): void;
  };
  history: {
    Store: typeof SessionStore;
    createCapture: typeof createCapture;
    createCompactionStrategy: typeof createCompactionStrategy;
    withContextLock<T>(session: Session, fn: () => Promise<T>): Promise<T>;
    rebuildReplay(session: Session, messages: unknown[], entryIds?: (string | null)[]): Promise<void>;
    synthesizeBranchFrames(session: Session, messages: unknown[], entryIds?: (string | null)[]): string[];
    migrateLegacyQueryTags(session: Session): boolean;
    tagLastQueryFrame(session: Session): Promise<void>;
  };
  events: {
    routeEvent(session: Session, event: BusEvent): void;
    pushFrame(session: Session, name: string, frame: string, options?: { transient?: boolean }): void;
    sseFrame(meta: object, payload: unknown): string;
    isDroppedRestoreFrame(frame: string): boolean;
    parseFrameName(frame: string): string;
    replayFrameId(frame: string): number | null;
  };
  configuration: {
    syncAutoApprove(bridge: Bridge): void;
    writeNetworkPolicy(enabled: boolean | null, id: string): unknown;
  };
  runtime: {
    /** Return a disposer; shutdown must cancel and await these same pending
     * records, keyed by the identity of the supplied session registry. */
    trackInitialization(sessions: Map<string, Session>, pending: PendingSessionInitialization): () => void;
    stopIdleWatchdog(session: Session): void;
    releaseClosedReplay(session: Session): void;
  };
}
