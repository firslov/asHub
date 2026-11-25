import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

interface TimeRange { from: number; to: number }
export interface ProjectNameInterval extends TimeRange { name: string }
export interface Project { id: string; name: string; cwd?: string; sessionIds: string[]; pinnedSessionIds?: string[] }
interface StoredProject extends Project {
  /** UTC milliseconds. An observation never attests to an earlier name. */
  nameSince?: number;
  nameHistory?: ProjectNameInterval[];
  /** Detect a rename saved by an older version that did not update the intervals. */
  nameObserved?: string;
  nameCoverage?: "tracked" | "unavailable";
}
export interface ProjectNameHistory {
  projects: { id: string; name: string; nameSince: number; nameHistory: ProjectNameInterval[] }[];
  /** Closed time ranges for which some name facts have been lost. Contains no names or project identifiers. */
  gaps: TimeRange[];
}
const nameHistoryLimit = 16;
const gapLimit = 32;
interface NameCoverage { gaps: TimeRange[]; observations: { id: string; from: number }[] }
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timeRange = (value: unknown): value is TimeRange => {
  const span = value as Partial<TimeRange> | null;
  return !!span && time(span.from) && time(span.to) && span.from <= span.to;
};
const publicProjects = (projects: StoredProject[]): Project[] =>
  projects.map(({nameSince: _since, nameHistory: _history, nameObserved: _observed, nameCoverage: _coverage, ...project}) => project);
const firstNameObservation = (project: StoredProject) => project.nameHistory?.[0]?.from ?? project.nameSince!;
const sameObservations = (a: NameCoverage["observations"], b: NameCoverage["observations"]) =>
  a.length === b.length && a.every((item, i) => item.id === b[i]!.id && item.from === b[i]!.from);

function mergeGaps(ranges: TimeRange[]): TimeRange[] {
  const gaps: TimeRange[] = [];
  for (const { from, to } of ranges.sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = gaps.at(-1);
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else gaps.push({ from, to });
  }
  if (gaps.length > gapLimit) {
    const oldest = gaps.splice(0, gaps.length - gapLimit + 1);
    gaps.unshift({ from: oldest[0]!.from, to: oldest.at(-1)!.to });
  }
  return gaps;
}
export class ProjectStore {
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  constructor(private file: string) {}
  list(): Project[] { return publicProjects(this.readProjects()); }
  /** Record the earliest verified observation of legacy names at host startup. */
  observeNameHistory(): void {
    this.observedProjects();
  }
  private observedProjects(): { projects: StoredProject[]; coverage: NameCoverage } {
    const projects = this.readProjects();
    const coverage = this.readCoverage(projects);
    const gaps: TimeRange[] = [];
    const changed = this.observeNames(projects, coverage, gaps);
    const current = this.updatedCoverage(projects, coverage, gaps);
    if (current !== coverage) this.writeJSON(this.coverageFile, current);
    if (changed) this.writeJSON(this.file, projects);
    return { projects, coverage: current };
  }
  /** Name facts are available only to authorized in-process consumers. */
  nameHistory(): ProjectNameHistory {
    const { projects, coverage } = this.observedProjects();
    return {
      gaps: coverage.gaps,
      projects: projects.map(p => ({ id: p.id, name: p.name, nameSince: p.nameSince!, nameHistory: p.nameHistory ?? [] })),
    };
  }
  private get coverageFile() { return this.file + ".name-coverage"; }
  private readCoverage(projects: StoredProject[]): NameCoverage {
    const unverified = () => ({ gaps: [{ from: 0, to: Date.now() }], observations: [] });
    // The main project file may have committed while history storage was
    // unavailable. Ignore any older checkpoint until conservative recovery.
    if (projects.some(project => project.nameCoverage === "unavailable")) return unverified();
    let data: unknown;
    try { data = JSON.parse(fs.readFileSync(this.coverageFile, "utf8")); }
    catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") return unverified(); }
    const coverage = data as Partial<NameCoverage> | undefined;
    if (Array.isArray(coverage?.gaps) && coverage.gaps.length <= gapLimit && coverage.gaps.every(timeRange) &&
        Array.isArray(coverage.observations) && coverage.observations.every(o => o && typeof o.id === "string" && time(o.from))) {
      return { gaps: coverage.gaps.map(({from,to}) => ({from,to})), observations: coverage.observations };
    }
    // Legacy project files predate coverage tracking. If a tracked file has
    // lost its checkpoint, none of the preceding intervals can be certified.
    return projects.some(project => project.nameCoverage === "tracked") ? unverified() : { gaps: [], observations: [] };
  }
  private readProjects(): StoredProject[] {
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
  private observeNames(projects: StoredProject[], coverage: NameCoverage, gaps: TimeRange[]): boolean {
    const now = Date.now();
    let changed = false;
    for (const p of projects) {
      // Older writers preserve unknown JSON fields on rename. A mismatch
      // cannot donate the previous name's start time to the new name.
      const history = p.nameHistory;
      if (!(p.nameObserved === p.name && time(p.nameSince)) ||
          (history !== undefined && (!Array.isArray(history) || history.length > nameHistoryLimit ||
            !history.every((span, i) => span && typeof span.name === "string" && span.name.trim() &&
              time(span.from) && time(span.to) && span.from < span.to && span.to <= p.nameSince! &&
              (i === 0 || history[i - 1]!.to <= span.from))))) {
        // A legacy writer may retain stale history while editing the name.
        // Preserve only the dates of discarded observations.
        const observed = time(p.nameSince) ? p.nameSince : 0;
        gaps.push({ from: observed, to: Math.max(observed, now) });
        if (Array.isArray(history)) for (const span of history) if (timeRange(span)) gaps.push(span);
        p.nameSince = Math.max(observed, now);
        p.nameObserved = p.name;
        delete p.nameHistory;
        changed = true;
      }
      if (p.nameCoverage !== "tracked") { p.nameCoverage = "tracked"; changed = true; }
    }
    const observed = new Map(projects.map(p => [p.id, firstNameObservation(p)]));
    for (const previous of coverage.observations) {
      const current = observed.get(previous.id);
      // External legacy writers can drop a whole project or its older aliases.
      if (current === undefined) gaps.push({from: previous.from, to: Math.max(previous.from, now)});
      else if (current > previous.from) gaps.push({from: previous.from, to: current});
    }
    return changed;
  }
  private writeJSON(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + "." + randomUUID() + ".tmp";
    try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flush: true }); fs.renameSync(tmp, file); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  private updatedCoverage(projects: StoredProject[], coverage: NameCoverage, gaps: TimeRange[]): NameCoverage {
    const observations = projects.map(p => ({id: p.id, from: firstNameObservation(p)}));
    if (!gaps.length && sameObservations(observations, coverage.observations)) return coverage;
    return { gaps: mergeGaps([...coverage.gaps, ...gaps]), observations };
  }
  private commitProjects(projects: StoredProject[], coverage: NameCoverage, gaps: TimeRange[]): void {
    const current = this.updatedCoverage(projects, coverage, gaps);
    if (current === coverage) { this.writeJSON(this.file, projects); return; }
    // Record gaps before changing the project file, while retaining the
    // previous observations until the main commit actually succeeds.
    const observed = new Map(current.observations.map(o => [o.id, o]));
    for (const prior of coverage.observations) {
      const next = observed.get(prior.id);
      if (!next || prior.from < next.from) observed.set(prior.id, prior);
    }
    const staged = [...observed.values()];
    try { this.writeJSON(this.coverageFile, { gaps: current.gaps, observations: staged }); }
    catch {
      // Project management remains available. The primary file records that
      // the history checkpoint cannot be relied on, including after restart.
      for (const p of projects) p.nameCoverage = "unavailable";
      this.writeJSON(this.file, projects);
      return;
    }
    this.writeJSON(this.file, projects);
    if (!sameObservations(staged, current.observations)) {
      // On failure the staged checkpoint retains all needed dates. A later
      // observation will reconcile it with the committed project list.
      try { this.writeJSON(this.coverageFile, current); } catch {}
    }
  }
  update(input: unknown, canAdd: (id: string) => boolean): Project[] {
    const b = input as { action?: string; id?: string; name?: string; cwd?: string; add?: string[]; remove?: string[]; sessionId?: string; pinned?: boolean };
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("Invalid project request");
    const projects = this.readProjects();
    const coverage = this.readCoverage(projects);
    const gaps: TimeRange[] = [];
    this.observeNames(projects, coverage, gaps);
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
      if (b.action === "create") { p = { id: randomUUID(), name, nameObserved: name, nameSince: Date.now(), nameCoverage: "tracked", cwd, sessionIds: [] }; projects.push(p); }
      else if (p!.name !== name) {
        const prior = p!, to = Math.max(prior.nameSince!, Date.now());
        if (prior.nameSince! < to) {
          const history = [...(prior.nameHistory ?? []), {name: prior.name, from: prior.nameSince!, to}];
          gaps.push(...history.splice(0, Math.max(0, history.length - nameHistoryLimit)));
          prior.nameHistory = history;
        } else gaps.push({from: to, to});
        prior.name = prior.nameObserved = name;
        prior.nameSince = to;
      }
    } else if (b.action === "delete") {
      const [deleted] = projects.splice(projects.indexOf(p!), 1);
      const from = deleted!.nameSince!;
      gaps.push(...(deleted!.nameHistory ?? []), {from, to: Math.max(from, Date.now())});
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
    this.commitProjects(projects, coverage, gaps);
    for (const listener of [...this.listeners]) listener();
    return publicProjects(projects);
  }
}
