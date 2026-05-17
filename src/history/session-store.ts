import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { summarizeMessage } from "./summarize.js";

export interface ToolCall {
  id?: string;
  function?: { name: string; arguments?: string };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface SessionHeaderEntry {
  type: "session";
  id: string;
  parentId: null;
  timestamp: number;
  cwd: string;
  version: 1;
}

export interface MessageEntry {
  type: "message";
  id: string;
  parentId: string;
  timestamp: number;
  message: AgentMessage;
}

export interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  firstKeptId: string;
  tokensBefore: number;
}

export type SessionEntry = SessionHeaderEntry | MessageEntry | CompactionEntry;

export interface SessionMeta {
  createdAt: number;
  name?: string;
  title?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  startedAt?: number;
  firstQuery?: string;
  userTitle?: string;
  lastModified?: number;
}

export function newEntryId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function renderEvictedSummary(branch: SessionEntry[], firstKeptIdx: number): string {
  const lines: string[] = [];
  for (let i = 0; i < firstKeptIdx; i++) {
    const e = branch[i]!;
    if (e.type === "message") lines.push(`- ${summarizeMessage(e.message)}`);
  }
  return `[Compacted conversation — ${lines.length} message(s) elided]\n${lines.join("\n")}`;
}

export interface SessionStoreOpts {
  create?: { cwd: string; sessionId: string };
  metaPath?: string;
}

export class SessionStore {
  private entriesPath: string;
  private leafPath: string;
  private metaPath: string;
  private entries = new Map<string, SessionEntry>();
  private rootId = "";
  private activeLeaf = "";
  private meta: SessionMeta;
  private pendingHeader: SessionHeaderEntry | null = null;
  readonly id: string;

  constructor(filePath: string, opts?: SessionStoreOpts) {
    this.entriesPath = filePath;
    this.leafPath = filePath + ".leaf";
    this.metaPath = opts?.metaPath ?? filePath + ".meta";
    this.meta = { createdAt: 0 };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (opts?.create) {
      this.id = opts.create.sessionId;
      const header: SessionHeaderEntry = {
        type: "session",
        id: opts.create.sessionId,
        parentId: null,
        timestamp: Date.now(),
        cwd: opts.create.cwd,
        version: 1,
      };
      this.entries.set(header.id, header);
      this.rootId = header.id;
      this.activeLeaf = header.id;
      this.meta = { createdAt: header.timestamp, cwd: opts.create.cwd };
      this.pendingHeader = header;
    } else {
      this.id = "";
      this.load();
      if (!this.rootId) throw new Error(`session file lacks a session header: ${filePath}`);
      this.id = this.rootId;
    }
  }

  private flushHeader(): void {
    if (!this.pendingHeader) return;
    const headerLine = JSON.stringify(this.pendingHeader) + "\n";
    this.pendingHeader = null;
    fs.writeFileSync(this.entriesPath, headerLine);
    this.persistMeta();
    this.persistLeaf();
  }

  getActiveLeaf(): string { return this.activeLeaf; }
  setActiveLeaf(id: string): void {
    if (!this.entries.has(id)) throw new Error(`unknown entry: ${id}`);
    this.activeLeaf = id;
    this.persistLeaf();
  }
  getRootId(): string { return this.rootId; }
  getEntry(id: string): SessionEntry | undefined { return this.entries.get(id); }
  getAllEntries(): SessionEntry[] {
    return [...this.entries.values()];
  }
  getMeta(): SessionMeta { return { ...this.meta }; }
  setName(name: string): void {
    this.meta.name = name;
    this.persistMeta();
  }
  setMeta(patch: Partial<SessionMeta>): void {
    this.meta = { ...this.meta, ...patch };
    this.persistMeta();
  }

  async appendMessages(messages: AgentMessage[]): Promise<string[]> {
    if (messages.length === 0) return [];
    this.flushHeader();
    let parent = this.activeLeaf;
    const lines: string[] = [];
    const newIds: string[] = [];
    for (const m of messages) {
      const e: MessageEntry = {
        type: "message",
        id: newEntryId(),
        parentId: parent,
        timestamp: Date.now(),
        message: m,
      };
      this.entries.set(e.id, e);
      lines.push(JSON.stringify(e));
      newIds.push(e.id);
      parent = e.id;
    }
    this.activeLeaf = parent;
    await fsp.appendFile(this.entriesPath, lines.join("\n") + "\n");
    this.persistLeaf();
    return newIds;
  }

  async appendCompaction(firstKeptId: string, tokensBefore: number = 0): Promise<string> {
    if (!this.entries.has(firstKeptId)) throw new Error(`firstKeptId unknown: ${firstKeptId}`);
    this.flushHeader();
    const e: CompactionEntry = {
      type: "compaction",
      id: newEntryId(),
      parentId: this.activeLeaf,
      timestamp: Date.now(),
      firstKeptId,
      tokensBefore,
    };
    this.entries.set(e.id, e);
    this.activeLeaf = e.id;
    await fsp.appendFile(this.entriesPath, JSON.stringify(e) + "\n");
    this.persistLeaf();
    return e.id;
  }

  getBranch(leafId: string = this.activeLeaf): SessionEntry[] {
    const out: SessionEntry[] = [];
    const seen = new Set<string>();
    let cur: string | null = leafId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const e = this.entries.get(cur);
      if (!e) break;
      out.push(e);
      cur = e.parentId;
    }
    return out.reverse();
  }

  buildMessages(leafId: string = this.activeLeaf): AgentMessage[] {
    return this.buildBranchWithIds(leafId).messages;
  }

  buildBranchWithIds(leafId: string = this.activeLeaf): { messages: AgentMessage[]; entryIds: (string | null)[] } {
    const branch = this.getBranch(leafId);
    let compactionIdx = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i]!.type === "compaction") { compactionIdx = i; break; }
    }
    const messages: AgentMessage[] = [];
    const entryIds: (string | null)[] = [];
    let startIdx = 0;
    if (compactionIdx >= 0) {
      const c = branch[compactionIdx] as CompactionEntry;
      const firstKeptIdx = branch.findIndex((e) => e.id === c.firstKeptId);
      startIdx = firstKeptIdx >= 0 ? firstKeptIdx : 0;
      const summary = renderEvictedSummary(branch, startIdx);
      messages.push({ role: "user", content: summary });
      entryIds.push(null);
    }
    for (let i = startIdx; i < branch.length; i++) {
      const e = branch[i]!;
      if (e.type === "message") {
        messages.push(e.message);
        entryIds.push(e.id);
      }
    }
    return { messages, entryIds };
  }

  getPreview(): string {
    for (const e of this.entries.values()) {
      if (e.type === "message" && e.message.role === "user") {
        const txt = typeof e.message.content === "string" ? e.message.content : "";
        if (txt) return txt.slice(0, 80);
      }
    }
    return "(empty)";
  }

  private load(): void {
    try {
      this.meta = JSON.parse(fs.readFileSync(this.metaPath, "utf-8")) as SessionMeta;
    } catch { this.meta = { createdAt: 0 }; }
    let raw: string;
    try { raw = fs.readFileSync(this.entriesPath, "utf-8"); }
    catch { return; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as SessionEntry;
        if (!e.id) continue;
        this.entries.set(e.id, e);
        if (e.type === "session") this.rootId = e.id;
      } catch { /* skip malformed */ }
    }
    try {
      this.activeLeaf = fs.readFileSync(this.leafPath, "utf-8").trim();
      if (!this.entries.has(this.activeLeaf)) this.activeLeaf = this.rootId;
    } catch { this.activeLeaf = this.lastEntryId(); }
  }

  private lastEntryId(): string {
    let lastId = this.rootId;
    for (const e of this.entries.values()) lastId = e.id;
    return lastId;
  }

  private persistLeaf(): void {
    if (this.pendingHeader) return;
    fs.writeFileSync(this.leafPath, this.activeLeaf);
  }
  private persistMeta(): void {
    if (this.pendingHeader) return;
    let existing: Record<string, unknown> = {};
    try { existing = JSON.parse(fs.readFileSync(this.metaPath, "utf-8")); } catch {}
    fs.writeFileSync(this.metaPath, JSON.stringify({ ...existing, ...this.meta }));
  }
}
