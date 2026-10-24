import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { unicodeSlice } from "./unicode.js";

export type TaskState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface CollaborationTask {
  id: string; sourceId: string; recipientId: string; message: string; query: string;
  state: TaskState; createdAt: number; updatedAt: number; text: string; error?: string;
}
const taskStates: TaskState[] = ["queued", "running", "completed", "failed", "cancelled", "interrupted"];
function validReceipt(task: unknown): task is CollaborationTask {
  if (!task || typeof task !== "object") return false;
  const value = task as Record<string, unknown>;
  return ["id", "sourceId", "recipientId", "message", "query", "text"].every(k => typeof value[k] === "string")
    && taskStates.includes(value.state as TaskState)
    && [value.createdAt, value.updatedAt].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
    && (value.error === undefined || typeof value.error === "string");
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
          task.updatedAt = Date.now(); this.save(task);
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
    const task: CollaborationTask = { id, sourceId, recipientId, message, query, state: "queued", createdAt: Date.now(), updatedAt: Date.now(), text: "" };
    this.save(task); this.tasks.set(id, task); return task;
  }
  get(id: string) { const task = this.tasks.get(id); if (!task) throw new Error("Task not found"); return task; }
  list() { return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt); }
  start(id: string) {
    const task = this.get(id);
    if (taskTerminal(task.state)) return;
    task.state = "running"; task.updatedAt = Date.now(); this.active.set(task.recipientId, id);
    try { this.save(task); } catch (e) { console.error("[collaboration] receipt save failed", e); }
    this.notify();
  }
  finish(id: string, state: TaskState, error?: string) {
    const task = this.get(id);
    if (taskTerminal(task.state)) return;
    task.state = state; task.error = error; task.updatedAt = Date.now();
    if (this.active.get(task.recipientId) === id) this.active.delete(task.recipientId);
    this.chunks.delete(id);
    // A diagnostics write failure must not interrupt the user's agent output.
    try { this.save(task); } catch (e) { console.error("[collaboration] receipt save failed", e); }
    this.notify();
  }
  stopSession(id: string) {
    for (const t of this.tasks.values()) if (t.recipientId === id && !taskTerminal(t.state)) this.finish(t.id, "cancelled");
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
