import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { reasoningProfile } from "../providers/reasoning.js";
import { workspaceInfo, createIsolatedWorkspace } from "../worktrees.js";
import { writeNetworkPolicy } from "../network-policy.js";
import { unicodeSlice } from "../unicode.js";
import { selectSessionModel, selectSessionThinking } from "../services/session-configuration.js";
import type { Session } from "../services/session-types.js";
import type { ProjectService } from "../services/project-service.js";
import type { CollaborationTasks } from "../collaboration.js";

export interface ProjectHttpRuntime {
  sessions: Map<string, Session>;
  projects: ProjectService;
  collaboration: CollaborationTasks;
  worktreesDirectory: string;
  readBody(req: http.IncomingMessage): Promise<string>;
  create(cwd: string): Promise<Session>;
  saveSessionMetaDebounced(session: Session): void;
  setSessionTitle(session: Session, title: string, user?: boolean): Promise<void>;
}

/** Compatibility adapters; mutations and membership are owned by core services. */
export async function handleProjectRequest(req: http.IncomingMessage, res: http.ServerResponse, runtime: ProjectHttpRuntime): Promise<boolean> {
  const { sessions, projects, readBody, saveSessionMetaDebounced, setSessionTitle } = runtime;
  const url = req.url ?? "/";
    if (req.method === "POST" && (url === "/api/projects/worktree" || url === "/api/projects/session")) {
      let workspace: Awaited<ReturnType<typeof createIsolatedWorkspace>> | undefined;
      let created: Session | undefined;
      try {
        const input = JSON.parse(await readBody(req));
        if (!input || typeof input.projectId !== 'string' || (input.isolated !== undefined && typeof input.isolated !== 'boolean')) throw new Error("Invalid project conversation request");
        if (input.title !== undefined && (typeof input.title !== "string" || input.title.trim().length > 100)) throw new Error("Invalid conversation title");
        if (input.proxyEnabled !== undefined && input.proxyEnabled !== null && typeof input.proxyEnabled !== "boolean") throw new Error("Invalid VPN setting");
        if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim() || /[\s@]/.test(input.model)
          || typeof input.provider !== "string" || !input.provider || /[\s@]/.test(input.provider))) throw new Error("Invalid model");
        if (input.thinking !== undefined && (typeof input.thinking !== "string" || (!input.model && input.thinking !== "default")
          || (input.thinking !== "default" && !reasoningProfile({ id: input.model, provider: input.provider })?.levels.includes(input.thinking)))) throw new Error("Unsupported thinking level for this model");
        const legacy = url === "/api/projects/worktree";
        const projectRoot = projects.list().find(p => p.id === input.projectId)?.cwd;
        const check = () => {
          if (projects.isDeleting()) throw new Error("Project deletion in progress; retry shortly");
          const project = projects.list().find(p => p.id === input.projectId);
          if (!project) throw new Error("Project no longer exists");
          if (!legacy && project.cwd !== projectRoot) throw new Error("Project directory changed; retry with the updated project");
          const source = legacy ? sessions.get(input.sourceId) : undefined;
          if (legacy && (!project.sessionIds.includes(input.sourceId) || !source || source.kind !== "agent" || source._closed || source._closing)) throw new Error("Source conversation unavailable");
          return source;
        };
        const source = check();
        const directory = source?.cwd ?? projectRoot ?? '';
        if (!legacy) projects.directory(input.projectId, input.cwd);
        if (!directory || !path.isAbsolute(directory) || !(await fs.promises.stat(directory)).isDirectory()) throw new Error("Choose an existing absolute working directory");
        check();
        if (legacy || input.isolated) workspace = await createIsolatedWorkspace(directory, runtime.worktreesDirectory);
        check();
        created = await runtime.create(workspace?.cwd ?? directory);
        if (typeof input.proxyEnabled === "boolean") writeNetworkPolicy(input.proxyEnabled, created.id);
        if (input.model) {
          await selectSessionModel(created, input.model, input.provider, () => { check(); });
        }
        if (input.thinking) {
          selectSessionThinking(created, input.thinking, () => { check(); });
        }
        saveSessionMetaDebounced(created);
        check();
        projects.update({ action: "members", id: input.projectId, add: [created.id] }, id => sessions.has(id));
        if (input.title?.trim()) await setSessionTitle(created, input.title.trim(), true);
        else if (workspace) await setSessionTitle(created, `${source?.title || path.basename(directory)} · ${workspace.branch}`, true);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ instanceId: created.id, cwd: created.cwd, kind: created.kind, ...workspace }));
      } catch (e) {
        // Preserve any checkout/session created before a later failure; never
        // delete files that extensions or the user may already have touched.
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e), ...(workspace ? { workspace } : {}), ...(created ? { instanceId: created.id, cwd: created.cwd } : {}) }));
      }
      return true;
    }
    if (req.method === "GET" && url === "/api/projects/workspaces") {
      const dirs = [...new Set([...sessions.values()].filter(s => s.kind === "agent").map(s => s.cwd))];
      const values: Array<[string, Awaited<ReturnType<typeof workspaceInfo>>]> = [];
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, dirs.length) }, async () => {
        while (next < dirs.length) { const cwd = dirs[next++]!; values.push([cwd, await workspaceInfo(cwd)]); }
      }));
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(Object.fromEntries(values))); return true;
    }
    if (req.method === "GET" && url.startsWith("/api/projects/tasks?")) {
      try {
        const params = new URLSearchParams(url.split("?")[1]);
        const project = projects.list().find(p => p.id === params.get("projectId"));
        if (!project) throw new Error("Project unavailable");
        const permitted = runtime.collaboration.list().filter(t => project.sessionIds.includes(t.sourceId) && project.sessionIds.includes(t.recipientId));
        const id = params.get("taskId");
        if (id) {
          if (!permitted.some(t => t.id === id)) throw new Error("Task unavailable");
          if (params.get("download") === "1") {
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="task-${id}.txt"` });
            res.end(runtime.collaboration.get(id).text); return true;
          }
          const body = JSON.stringify(runtime.collaboration.page(id, Number(params.get("offset") ?? 0)));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
        } else {
          const body = JSON.stringify(permitted.slice(0, 100).map(({ query, text, ...t }) => ({ ...t, message: unicodeSlice(t.message, 0, 160), totalChars: text.length })));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
        }
      } catch (e) { res.writeHead(400); res.end(String(e)); }
      return true;
    }
    if (url === "/api/projects") {
      try {
        if (req.method !== "GET" && req.method !== "POST") { res.writeHead(405); res.end(); return true; }
        let result;
        if (req.method === "GET") result = projects.list();
        else {
          const input = JSON.parse(await readBody(req));
          result = await projects.change(input);
        }
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result));
      } catch (e) { res.writeHead(req.method === "GET" ? 500 : 400); res.end(String(e)); }
      return true;
    }
  return false;
}
