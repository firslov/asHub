import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface ProjectNameInterval { name: string; from: number; to: number }
export interface Project {
  id: string; name: string; cwd?: string; sessionIds: string[]; pinnedSessionIds?: string[];
  /** UTC milliseconds. An observation never attests to an earlier name. */
  nameSince?: number;
  nameHistory?: ProjectNameInterval[];
  /** Detect a rename saved by an older version that did not update the intervals. */
  nameObserved?: string;
}
const nameHistoryLimit = 16;
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const normalizedName = (name: string) => name.normalize('NFKC').trim().toLocaleLowerCase();
// Once a longer CJK name is lost, text that also contains a shorter name
// cannot safely be attributed to the surviving project during that interval.
const affectedName = (lost: string, remaining: string) => lost === remaining ||
  (/^[\p{Script=Han}]+$/u.test(lost) && /^[\p{Script=Han}]+$/u.test(remaining) && lost.includes(remaining));
const publicProjects = (projects: Project[]): Project[] =>
  projects.map(({nameSince: _since, nameHistory: _history, nameObserved: _observed, ...project}) => project);

function discardNameIntervals(projects: Project[], discarded: ProjectNameInterval[]): void {
  if (!discarded.length) return;
  // Losing a candidate must never make an overlapping name unique. Subtract
  // those windows from the survivors without retaining the deleted names.
  const evicted: ProjectNameInterval[] = [];
  for (const project of projects) {
    let intervals = [...(project.nameHistory ?? []), {name: project.name, from: project.nameSince!, to: Infinity}];
    for (const removed of discarded) {
      const key = normalizedName(removed.name);
      intervals = intervals.flatMap(span => {
        if (removed.to < span.from || removed.from > span.to || !affectedName(key, normalizedName(span.name))) return [span];
        const kept: ProjectNameInterval[] = [];
        if (span.from < removed.from) kept.push({...span, to: removed.from});
        if (removed.to < span.to) kept.push({...span, from: removed.to});
        return kept;
      });
    }
    project.nameSince = intervals.pop()!.from;
    if (project.nameHistory || intervals.length) {
      evicted.push(...intervals.splice(0, Math.max(0, intervals.length - nameHistoryLimit)));
      project.nameHistory = intervals;
    }
  }
  if (!evicted.length) return;
  // A split can exceed capacity. Keep the verifiable suffix for those evicted
  // names without recursively splitting or exposing additional history.
  const cutoffs = new Map<string, number>();
  for (const span of evicted) {
    const name = normalizedName(span.name);
    cutoffs.set(name, Math.max(span.to, cutoffs.get(name) ?? 0));
  }
  const verifiedFrom = (name: string, from: number) => {
    const remaining = normalizedName(name);
    for (const [lost, cutoff] of cutoffs) if (affectedName(lost, remaining)) from = Math.max(from, cutoff);
    return from;
  };
  for (const project of projects) {
    project.nameSince = verifiedFrom(project.name, project.nameSince!);
    if (project.nameHistory) {
      project.nameHistory = project.nameHistory.map(span => ({...span, from: verifiedFrom(span.name, span.from)}))
        .filter(span => span.from < span.to);
    }
  }
}
export class ProjectStore {
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  constructor(private file: string) {}
  list(): Project[] { return publicProjects(this.readProjects()); }
  /** History is for in-process host consumers, not public project HTTP payloads. */
  listWithNameHistory(): Project[] {
    const projects = this.readProjects();
    if (this.observeNames(projects)) this.writeProjects(projects);
    return projects;
  }
  private readProjects(): Project[] {
    let raw: string;
    try { raw = fs.readFileSync(this.file, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    const data = JSON.parse(raw);
    const ids = new Set<string>(), members = new Set<string>();
    if (!Array.isArray(data)) throw new Error("Invalid project data");
    for (const p of data) {
      if (!p || typeof p.id !== "string" || ids.has(p.id) || typeof p.name !== "string" || !p.name.trim() || !Array.isArray(p.sessionIds)) throw new Error("Invalid project data");
      if (p.cwd !== undefined && (typeof p.cwd !== "string" || !path.isAbsolute(p.cwd))) throw new Error("Invalid project directory");
      if (p.pinnedSessionIds !== undefined) {
        if (!Array.isArray(p.pinnedSessionIds) || !p.pinnedSessionIds.every((id: unknown) => typeof id === "string") ||
            new Set(p.pinnedSessionIds).size !== p.pinnedSessionIds.length) throw new Error("Invalid project pins");
        // Older clients update membership without removing pins for departed members.
        p.pinnedSessionIds = p.pinnedSessionIds.filter((id: string) => p.sessionIds.includes(id));
      }
      ids.add(p.id);
      for (const id of p.sessionIds) {
        if (typeof id !== "string" || members.has(id)) throw new Error("Invalid project membership");
        members.add(id);
      }
    }
    return data;
  }
  private observeNames(projects: Project[]): boolean {
    const now = Date.now();
    let changed = false;
    const discarded: ProjectNameInterval[] = [];
    for (const p of projects) {
      // Older writers preserve unknown JSON fields on rename. A mismatch
      // cannot donate the previous name's start time to the new name.
      const history = p.nameHistory;
      if (!(p.nameObserved === p.name && time(p.nameSince)) ||
          (history !== undefined && (!Array.isArray(history) || history.length > nameHistoryLimit ||
            !history.every((span, i) => span && typeof span.name === "string" && span.name.trim() &&
              time(span.from) && time(span.to) && span.from < span.to && span.to <= p.nameSince! &&
              (i === 0 || history[i - 1]!.to <= span.from))))) {
        // An older writer may rename a project while leaving the last
        // observed name and intervals behind. Once those intervals are
        // discarded, overlapping names must not become falsely unique.
        if (typeof p.nameObserved === 'string' && p.nameObserved.trim() && time(p.nameSince)) {
          discarded.push({name:p.nameObserved, from:p.nameSince, to:Math.max(p.nameSince, now)});
        }
        if (Array.isArray(history)) for (const span of history) {
          if (span && typeof span.name === 'string' && span.name.trim() && time(span.from) && time(span.to) && span.from < span.to) discarded.push(span);
        }
        p.nameSince = Math.max(time(p.nameSince) ? p.nameSince : 0, now);
        p.nameObserved = p.name;
        delete p.nameHistory;
        changed = true;
      }
    }
    if (discarded.length) discardNameIntervals(projects, discarded);
    return changed;
  }
  private writeProjects(projects: Project[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + "." + randomUUID() + ".tmp";
    try { fs.writeFileSync(tmp, JSON.stringify(projects, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  update(input: unknown, canAdd: (id: string) => boolean): Project[] {
    const b = input as { action?: string; id?: string; name?: string; cwd?: string; add?: string[]; remove?: string[]; sessionId?: string; pinned?: boolean };
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("Invalid project request");
    const projects = this.readProjects();
    this.observeNames(projects);
    let p = projects.find(p => p.id === b.id);
    if (b.action !== "create" && !p) throw new Error("Project no longer exists");
    let cwd: string | undefined;
    if (b.action === "create" || (b.action === "edit" && b.cwd !== undefined)) {
      if (typeof b.cwd !== "string" || !path.isAbsolute(b.cwd.trim())) throw new Error("Choose an existing absolute project directory");
      cwd = path.resolve(b.cwd.trim());
      if ((b.action === "create" || cwd !== p?.cwd) && !fs.statSync(cwd).isDirectory()) throw new Error("Project directory must be a folder");
    }
    if (b.action === "create" || b.action === "rename" || b.action === "edit") {
      if (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 80) throw new Error("Project name must be 1–80 characters");
      const name = b.name.trim();
      if (b.action === "create") { p = { id: randomUUID(), name, nameObserved: name, nameSince: Date.now(), cwd, sessionIds: [] }; projects.push(p); }
      else if (p!.name !== name) {
        const prior = p!, to = Math.max(prior.nameSince!, Date.now());
        let discarded: ProjectNameInterval[] = [];
        if (prior.nameSince! < to) {
          const history = [...(prior.nameHistory ?? []), {name: prior.name, from: prior.nameSince!, to}];
          discarded = history.splice(0, Math.max(0, history.length - nameHistoryLimit));
          prior.nameHistory = history;
        }
        prior.name = prior.nameObserved = name;
        prior.nameSince = to;
        discardNameIntervals(projects, discarded);
      }
    } else if (b.action === "delete") {
      const [deleted] = projects.splice(projects.indexOf(p!), 1);
      const from = deleted!.nameSince!;
      discardNameIntervals(projects, [...(deleted!.nameHistory ?? []), {name: deleted!.name, from, to: Math.max(from, Date.now())}]);
    }
    else if (b.action === "pin") {
      const id = b.sessionId;
      if (typeof id !== "string" || typeof b.pinned !== "boolean" || !p!.sessionIds.includes(id) || !canAdd(id)) {
        throw new Error("Invalid project pin");
      }
      const pins = p!.pinnedSessionIds ?? [];
      if (b.pinned && !pins.includes(id)) p!.pinnedSessionIds = [id, ...pins];
      if (!b.pinned) p!.pinnedSessionIds = pins.filter(pin => pin !== id);
    }
    else if (b.action !== "members") throw new Error("Unknown project action");
    if (b.action === "edit" && cwd !== undefined) p!.cwd = cwd;
    if (b.action === "members" || b.action === "edit" || b.action === "create") {
      const add = b.add ?? [], remove = b.remove ?? [];
      if (!Array.isArray(add) || !Array.isArray(remove) || !add.every(id => typeof id === "string" && canAdd(id)) || !remove.every(id => typeof id === "string")) throw new Error("Some conversations are no longer available");
      const moved = new Set(add), removed = new Set(remove);
      for (const group of projects) group.sessionIds = group.sessionIds.filter(id => !moved.has(id) && (group !== p || !removed.has(id)));
      p!.sessionIds.push(...moved);
      for (const group of projects) {
        if (group.pinnedSessionIds) group.pinnedSessionIds = group.pinnedSessionIds.filter(id => group.sessionIds.includes(id));
      }
    }
    this.writeProjects(projects);
    for (const listener of [...this.listeners]) listener();
    return publicProjects(projects);
  }
}
