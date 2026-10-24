import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface Project { id: string; name: string; sessionIds: string[] }
export class ProjectStore {
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
      ids.add(p.id);
      for (const id of p.sessionIds) {
        if (typeof id !== "string" || members.has(id)) throw new Error("Invalid project membership");
        members.add(id);
      }
    }
    return data;
  }
  update(input: unknown, canAdd: (id: string) => boolean): Project[] {
    const b = input as { action?: string; id?: string; name?: string; add?: string[]; remove?: string[] };
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error("Invalid project request");
    const projects = this.list();
    let p = projects.find(p => p.id === b.id);
    if (b.action !== "create" && !p) throw new Error("Project no longer exists");
    if (b.action === "create" || b.action === "rename" || b.action === "edit") {
      if (typeof b.name !== "string" || !b.name.trim() || b.name.trim().length > 80) throw new Error("Project name must be 1–80 characters");
      if (b.action === "create") { p = { id: randomUUID(), name: b.name.trim(), sessionIds: [] }; projects.push(p); }
      else p!.name = b.name.trim();
    } else if (b.action === "delete") projects.splice(projects.indexOf(p!), 1);
    else if (b.action !== "members") throw new Error("Unknown project action");
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
    return projects;
  }
}
