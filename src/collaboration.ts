import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { unicodeSlice } from "./unicode.js";

export type TaskState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface TaskWatch { id: string; afterRevision?: number; afterState?: TaskState }
export interface TaskDelivery {
  summary: string;
  artifacts: Array<{ label: string; path: string }>;
  unresolved: string[];
}
function parseDelivery(value: unknown): TaskDelivery {
  const v = value as TaskDelivery;
  if (!v || typeof v !== "object" || Array.isArray(v) ||
      typeof v.summary !== "string" || !v.summary.trim() || v.summary.length > 2000 ||
      !Array.isArray(v.artifacts) || v.artifacts.length > 8 ||
      !Array.from(v.artifacts).every(a => a && typeof a.label === "string" && a.label.trim() && a.label.length <= 120 &&
        typeof a.path === "string" && a.path.trim() && a.path.length <= 1000) ||
      !Array.isArray(v.unresolved) || v.unresolved.length > 8 ||
      !Array.from(v.unresolved).every(x => typeof x === "string" && x.trim() && x.length <= 300)) {
    throw new Error("Invalid delivery: summary 1–2000 chars, up to 8 artifacts and 8 unresolved items");
  }
  // References are descriptive data, never paths to read or URLs to fetch.
  return { summary: v.summary, artifacts: v.artifacts.map(a => ({ label: a.label, path: a.path })), unresolved: [...v.unresolved] };
}
export interface CollaborationTask {
  id: string; sourceId: string; recipientId: string; message: string; query: string;
  revision?: number; delivery?: TaskDelivery;
  state: TaskState; createdAt: number; updatedAt: number; text: string; error?: string;
}
const taskStates: TaskState[] = ["queued", "running", "completed", "failed", "cancelled", "interrupted"];
function validReceipt(task: unknown): task is CollaborationTask {
  if (!task || typeof task !== "object") return false;
  const value = task as Record<string, unknown>;
  return ["id", "sourceId", "recipientId", "message", "query", "text"].every(k => typeof value[k] === "string")
    && taskStates.includes(value.state as TaskState)
    && [value.createdAt, value.updatedAt].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
    && (value.revision === undefined || (Number.isSafeInteger(value.revision) && (value.revision as number) >= 0))
    && (value.delivery === undefined || validDelivery(value.delivery))
    && (value.error === undefined || typeof value.error === "string");
}
function validDelivery(value: unknown): boolean {
  try { parseDelivery(value); return true; } catch { return false; }
}
export const taskTerminal = (state: TaskState) => state !== "queued" && state !== "running";
/** Local task receipts, independent of conversation compaction and replay. */
export class CollaborationTasks {
  private tasks = new Map<string, CollaborationTask>();
  private active = new Map<string, string>();
  private chunks = new Set<string>();
  private listeners = new Set<() => void>();
  constructor(private directory: string) {
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const task: unknown = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
        if (!validReceipt(task) || task.id + ".json" !== name) throw new Error("Invalid collaboration receipt");
        this.tasks.set(task.id, task);
        if (!taskTerminal(task.state)) {
          task.state = "interrupted"; task.error = "Application restarted before completion";
          task.updatedAt = Date.now(); task.revision = (task.revision ?? 0) + 1; this.save(task);
        }
      } catch (e) { console.error("[collaboration] unreadable receipt retained:", name, e); }
    }
  }
  private save(task: CollaborationTask) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, task.id + ".json"), tmp = file + ".tmp";
    try { fs.writeFileSync(tmp, JSON.stringify(task), { mode: 0o600 }); fs.renameSync(tmp, file); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  create(sourceId: string, recipientId: string, message: string, query: string, id = randomUUID()) {
    const task: CollaborationTask = { id, sourceId, recipientId, message, query, state: "queued", revision: 0, createdAt: Date.now(), updatedAt: Date.now(), text: "" };
    this.save(task); this.tasks.set(id, task); return task;
  }
  get(id: string) { const task = this.tasks.get(id); if (!task) throw new Error("Task not found"); return task; }
  list() { return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt); }
  start(id: string) {
    const task = this.get(id);
    if (taskTerminal(task.state)) return;
    task.state = "running"; task.revision = (task.revision ?? 0) + 1; task.updatedAt = Date.now(); this.active.set(task.recipientId, id);
    try { this.save(task); } catch (e) { console.error("[collaboration] receipt save failed", e); }
    this.notify();
  }
  finish(id: string, state: TaskState, error?: string) {
    const task = this.get(id);
    if (taskTerminal(task.state)) return;
    task.state = state; task.revision = (task.revision ?? 0) + 1; task.error = error; task.updatedAt = Date.now();
    if (this.active.get(task.recipientId) === id) this.active.delete(task.recipientId);
    this.chunks.delete(id);
    // A diagnostics write failure must not interrupt the user's agent output.
    try { this.save(task); } catch (e) { console.error("[collaboration] receipt save failed", e); }
    this.notify();
  }
  stopSession(id: string) {
    for (const t of this.tasks.values()) if (t.recipientId === id && !taskTerminal(t.state)) this.finish(t.id, "cancelled");
    // Lifecycle callers mark/remove the session immediately after stopSession.
    // Recheck waiting callers once those flags are visible, including senders.
    void Promise.resolve().then(() => this.notify());
  }
  event(sessionId: string, name: string, payload: any) {
    if (name === "agent:queued-submit" || (name === "agent:queued-done" && payload?.dropped)) {
      const task = this.list().find(t => t.recipientId === sessionId && t.state === "queued" && t.query === payload?.query);
      if (task) { if (payload?.dropped) this.finish(task.id, "cancelled"); else this.start(task.id); }
      return;
    }
    const id = this.active.get(sessionId); if (!id) return;
    const task = this.get(id);
    if (name === "agent:response-chunk") {
      const text = (payload?.blocks ?? []).filter((b: any) => b.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("");
      if (text) { task.text += text; this.chunks.add(id); }
    } else if (name === "agent:tool-started") {
      // The chat closes its reply at tool boundaries; receipts must preserve
      // that separation too, including bridges that only emit text chunks.
      if (task.text && !task.text.endsWith("\n\n")) task.text += task.text.endsWith("\n") ? "\n" : "\n\n";
    } else if (name === "agent:response-done") {
      if (!this.chunks.has(id) && typeof payload?.response === "string") task.text += payload.response;
      if (task.text && !task.text.endsWith("\n\n")) task.text += "\n\n";
      this.chunks.delete(id);
    } else if (name === "agent:error") this.finish(id, "failed", String(payload?.message ?? "Task failed"));
    else if (name === "agent:cancelled") this.finish(id, "cancelled");
    else if (name === "agent:queued-done") this.finish(id, "completed");
    task.updatedAt = Date.now();
  }
  deliver(id: string, recipientId: string, value: unknown) {
    const task = this.get(id);
    if (task.recipientId !== recipientId || task.state !== "running" || this.active.get(recipientId) !== id) {
      throw new Error("Only the recipient of the currently running task can submit its delivery");
    }
    const delivery = parseDelivery(value);
    if (JSON.stringify(task.delivery) === JSON.stringify(delivery)) return { id, submitted: true };
    const next = { ...task, delivery, revision: (task.revision ?? 0) + 1, updatedAt: Date.now() };
    // Report success only after durable storage; a failed save leaves memory unchanged.
    this.save(next); Object.assign(task, next);
    return { id, submitted: true };
  }
  private status(id: string) {
    const t = this.get(id);
    return { id, sourceId: t.sourceId, recipientId: t.recipientId, state: t.state,
      terminal: taskTerminal(t.state), revision: t.revision ?? 0, updatedAt: t.updatedAt,
      deliverySubmitted: !!t.delivery, totalChars: t.text.length };
  }
  /** Wait for any unseen terminal result; no model wakeups for streamed progress. */
  async waitMany(targets: TaskWatch[], ms = 120000, signal?: AbortSignal,
    validate: () => void = () => {}, subscribeInvalidation?: (check: () => void) => (() => void)) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 16 ||
        targets.some(t => !t || typeof t.id !== "string" || !t.id ||
          (t.afterRevision !== undefined && (!Number.isSafeInteger(t.afterRevision) || t.afterRevision < 0)) ||
          (t.afterState !== undefined && !taskStates.includes(t.afterState))) ||
        new Set(targets.map(t => t.id)).size !== targets.length) throw new Error("Expected 1–16 unique task IDs with valid cursors");
    if (!Number.isInteger(ms) || ms < 0 || ms > 120000) throw new Error("waitMs must be 0–120000");
    // Copy caller input before waiting; plugins must not mutate authorization targets.
    const watched = targets.map(t => ({ id: t.id, afterRevision: t.afterRevision, afterState: t.afterState }));
    const inspect = () => {
      signal?.throwIfAborted(); validate();
      const statuses = watched.map(w => {
        const status = this.status(w.id);
        // A final save can fail without interrupting the agent. On restart the
        // last durable receipt becomes interrupted and may reuse a revision.
        const changedState = status.terminal && w.afterState !== undefined && w.afterState !== status.state;
        if (w.afterRevision !== undefined && w.afterRevision > status.revision && !changedState) throw new Error("Task cursor is ahead of its revision");
        return status;
      });
      const changed = statuses.filter((s, i) => s.terminal &&
        (watched[i]!.afterRevision === undefined || s.revision > watched[i]!.afterRevision! ||
          (watched[i]!.afterState !== undefined && watched[i]!.afterState !== s.state)));
      return { statuses, changed, settled: statuses.every(s => s.terminal) };
    };
    let snapshot = inspect();
    if (ms && !snapshot.changed.length && !snapshot.settled) {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe: (() => void) | undefined;
        let done = false;
        const finish = (error?: unknown) => {
          if (done) return; done = true;
          clearTimeout(timer); this.listeners.delete(check); signal?.removeEventListener("abort", abort); unsubscribe?.();
          if (error !== undefined) reject(error); else resolve();
        };
        const check = () => {
          try { const s = inspect(); if (s.changed.length || s.settled) finish(); }
          catch (e) { finish(e); }
        };
        const abort = () => finish(signal?.reason ?? new Error("Cancelled"));
        this.listeners.add(check); signal?.addEventListener("abort", abort, { once: true });
        try {
          unsubscribe = subscribeInvalidation?.(check);
          if (done) { unsubscribe?.(); return; }
          timer = setTimeout(() => finish(), ms);
          check();
        } catch (e) { finish(e); }
      });
      snapshot = inspect();
    }
    const results = [];
    let resultChars = 0;
    for (const status of snapshot.changed) {
      const task = this.get(status.id);
      const result = { ...status, error: task.error === undefined ? undefined : unicodeSlice(task.error, 0, 1000),
        ...(task.error && task.error.length > 1000 ? { errorTruncated: true } : {}),
        delivery: task.delivery ? parseDelivery(task.delivery) : null,
        transcript: { tool: "conversation_task", id: task.id, offset: 0 } };
      const size = JSON.stringify(result).length;
      // Keep typical batches small. Always include one whole delivery: the
      // per-field limits bound even escaped text below the tool's 128k ceiling.
      if (results.length && resultChars + size > 32000) break;
      results.push(result); resultChars += size;
    }
    const delivered = new Set(results.map(r => r.id));
    const unseen = new Set(snapshot.changed.map(s => s.id));
    return {
      reason: snapshot.changed.length ? "changed" : snapshot.settled ? "settled" : "timeout",
      results, hasMore: results.length < snapshot.changed.length,
      statuses: snapshot.statuses,
      cursors: snapshot.statuses.map((status, i) => {
        // Never acknowledge a result deferred to a later page.
        if (unseen.has(status.id) && !delivered.has(status.id)) return { ...watched[i]! };
        return { id: status.id, afterRevision: status.revision, afterState: status.state };
      }),
    };
  }

  page(id: string, offset = 0, limit = 8000) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 2 || limit > 16000) throw new Error("Invalid result offset/limit");
    const t = this.get(id);
    // Offsets returned below never split an emoji; reject invalid caller offsets.
    if (offset > t.text.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(t.text[offset] ?? "") && /[\uD800-\uDBFF]/.test(t.text[offset - 1]!))) throw new Error("Invalid result offset");
    const text = unicodeSlice(t.text, offset, offset + limit), nextOffset = offset + text.length;
    return { id: t.id, sourceId: t.sourceId, recipientId: t.recipientId, state: t.state, terminal: taskTerminal(t.state), createdAt: t.createdAt, updatedAt: t.updatedAt, error: t.error, text, nextOffset, hasMore: nextOffset < t.text.length, totalChars: t.text.length };
  }
  async wait(id: string, ms: number, signal?: AbortSignal) {
    if (!Number.isInteger(ms) || ms < 0 || ms > 30000) throw new Error("waitMs must be 0–30000");
    signal?.throwIfAborted();
    if (!ms || taskTerminal(this.get(id).state)) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.listeners.delete(check); signal?.removeEventListener("abort", abort); resolve(); };
      const check = () => { if (taskTerminal(this.get(id).state)) finish(); };
      const abort = () => { finish(); reject(signal?.reason ?? new Error("Cancelled")); };
      const timer = setTimeout(finish, ms);
      this.listeners.add(check); signal?.addEventListener("abort", abort, { once: true });
    });
    signal?.throwIfAborted();
  }
  private notify() { for (const listener of [...this.listeners]) listener(); }
}
