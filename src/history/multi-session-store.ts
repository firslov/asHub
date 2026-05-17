import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SessionStore } from "./session-store.js";

export interface SessionInfo {
  id: string;
  filePath: string;
  createdAt: number;
  name?: string;
  preview: string;
  entryCount: number;
}

export interface MultiSessionStoreOpts {
  metaPathFor?(treeFilePath: string): string;
  lazy?: boolean;
}

export class MultiSessionStore {
  private dir: string;
  private cwd: string;
  private metaPathFor: (treeFile: string) => string;
  private currentStore: SessionStore | null;

  constructor(dir: string, cwd: string, opts?: MultiSessionStoreOpts) {
    this.dir = dir;
    this.cwd = cwd;
    this.metaPathFor = opts?.metaPathFor ?? ((p) => p + ".meta");
    fs.mkdirSync(dir, { recursive: true });
    this.currentStore = opts?.lazy ? null : this.createFreshSession();
  }

  current(): SessionStore {
    if (!this.currentStore) throw new Error("no current session — call newSession() or openSession() first");
    return this.currentStore;
  }
  hasCurrent(): boolean { return this.currentStore !== null; }

  newSession(): SessionStore {
    this.currentStore = this.createFreshSession();
    return this.currentStore;
  }

  openSession(id: string): SessionStore {
    const filePath = this.sessionFile(id);
    if (!fs.existsSync(filePath)) throw new Error(`session not found: ${id}`);
    this.currentStore = new SessionStore(filePath, { metaPath: this.metaPathFor(filePath) });
    return this.currentStore;
  }

  createSessionWithId(id: string): SessionStore {
    const filePath = this.sessionFile(id);
    const store = new SessionStore(filePath, {
      create: { cwd: this.cwd, sessionId: id },
      metaPath: this.metaPathFor(filePath),
    });
    this.currentStore = store;
    return store;
  }

  listSessions(): SessionInfo[] {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const result: SessionInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      const filePath = path.join(this.dir, name);
      try {
        const store = new SessionStore(filePath, { metaPath: this.metaPathFor(filePath) });
        const meta = store.getMeta();
        result.push({
          id,
          filePath,
          createdAt: meta.createdAt,
          name: meta.name,
          preview: store.getPreview(),
          entryCount: store.getAllEntries().length,
        });
      } catch { /* skip unreadable */ }
    }
    result.sort((a, b) => b.createdAt - a.createdAt);
    return result;
  }

  sessionFile(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  private createFreshSession(): SessionStore {
    const id = newSessionFileId();
    const filePath = this.sessionFile(id);
    return new SessionStore(filePath, {
      create: { cwd: this.cwd, sessionId: id },
      metaPath: this.metaPathFor(filePath),
    });
  }
}

export function newSessionFileId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${ts}_${suffix}`;
}
