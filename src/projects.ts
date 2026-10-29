import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface Project { id: string; name: string; cwd?: string; sessionIds: string[] }
export class ProjectStore {
  private listeners = new Set<() => void>();
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  constructor(private file: string) {}
  list(): Project[] {
    let raw: string;
    try { raw = fs.readFileSync(this.file, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    const data = JSON.parse(raw);
    const ids = new Set<string>(), members = new Set<string>();
    if (!Array.isArray(data)) throw new Error("Invalid project data");
    for (const p of data) {
      if (!p || typeof p.id !== "string" || ids.has(p.id) || typeof p.name !== "string" || !p.name.trim() || !Array.isArray(p.sessionIds)) throw new Error("Invalid project data");
      if (p.cwd !== undefined && (typeof p.cwd !== "string" || !path.isAbsolute(p.cwd))) throw new Error("Invalid project directory");
      ids.add(p.id);
      for (const id of p.sessionIds) {
        if (typeof id !== "string" || members.has(id)) throw new Error("Invalid project membership");
        members.add(id);
      }
    }
    return data;
  }
  update(input: unknown, canAdd: (id: string) => boolean): Project[] {
    const b = input as { action?: string; id?: string; name?: string; cwd?: string; add?: string[]; remove?: string[] };
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("Invalid project request");
    const projects = this.list();
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
      if (b.action === "create") { p = { id: randomUUID(), name: b.name.trim(), cwd, sessionIds: [] }; projects.push(p); }
      else p!.name = b.name.trim();
    } else if (b.action === "delete") projects.splice(projects.indexOf(p!), 1);
    else if (b.action !== "members") throw new Error("Unknown project action");
    if (b.action === "edit" && cwd !== undefined) p!.cwd = cwd;
    if (b.action === "members" || b.action === "edit" || b.action === "create") {
      const add = b.add ?? [], remove = b.remove ?? [];
      if (!Array.isArray(add) || !Array.isArray(remove) || !add.every(id => typeof id === "string" && canAdd(id)) || !remove.every(id => typeof id === "string")) throw new Error("Some conversations are no longer available");
      const moved = new Set(add), removed = new Set(remove);
      for (const group of projects) group.sessionIds = group.sessionIds.filter(id => !moved.has(id) && (group !== p || !removed.has(id)));
      p!.sessionIds.push(...moved);
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + "." + randomUUID() + ".tmp";
    try { fs.writeFileSync(tmp, JSON.stringify(projects, null, 2), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
    for (const listener of [...this.listeners]) listener();
    return projects;
  }
}
