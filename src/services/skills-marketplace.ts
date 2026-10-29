import type { IncomingMessage, ServerResponse } from "node:http";
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile as nodeExecFile } from "node:child_process";

export interface SkillsMarketplaceDependencies {
  settingsPath(): string;
  getSettings(): { skillPaths?: string[] };
  readBody(req: IncomingMessage): Promise<string>;
  invalidateGlobalSkillsCache(): void;
  fetch?: typeof globalThis.fetch;
  execFile?: typeof nodeExecFile;
  homedir?: () => string;
  now?: () => number;
  onChanged?: () => void;
}

type SkillRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Trusted marketplace implementation with application-owned state and dependencies. */
export function createSkillsMarketplaceService(dependencies: SkillsMarketplaceDependencies) {
  const { settingsPath, getSettings, invalidateGlobalSkillsCache } = dependencies;
  const execFile = dependencies.execFile ?? nodeExecFile;
  const homedir = dependencies.homedir ?? (() => os.homedir());
  const now = dependencies.now ?? (() => Date.now());
  const fetch: typeof globalThis.fetch = (...args) => (dependencies.fetch ?? globalThis.fetch)(...args);
  let pending = 0;
  let closed = false;
  let closeTask: Promise<void> | undefined;
  let resolveDrain: (() => void) | undefined;

  const bodyReaders = new Map<IncomingMessage, () => void>();
  const bodyReadCancelled = new Error("Skills marketplace request body cancelled");

  // Acceptance occurs when this reader resolves. A later close may drain a
  // submitted mutation, but an unfinished reader must never submit one.
  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        bodyReaders.delete(req);
        req.removeListener("aborted", cancel);
        req.removeListener("error", cancel);
        req.removeListener("close", onClose);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(bodyReadCancelled);
      };
      const onClose = () => {
        if (!req.complete && !req.readableEnded) cancel();
      };
      bodyReaders.set(req, cancel);
      req.once("aborted", cancel);
      req.once("error", cancel);
      req.once("close", onClose);
      if (closed || (req.destroyed && !req.complete && !req.readableEnded)) {
        cancel();
        return;
      }
      try {
        Promise.resolve(dependencies.readBody(req)).then(body => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(body);
        }, error => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    });
  }

  const SKILLS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

  interface SkillSource {
    host: "github" | "gitee";
    owner: string;
    repo: string;
    branch: string;
    author: string;
  }

  const SKILL_SOURCES: SkillSource[] = [
    { host: "github", owner: "anthropics", repo: "skills",      branch: "main", author: "anthropics" },
    { host: "github", owner: "affaan-m",   repo: "ECC",         branch: "main", author: "affaan-m" },
    { host: "github", owner: "obra",       repo: "superpowers", branch: "main", author: "obra" },
  ];

  function skillApiUrl(src: SkillSource, subpath: string): string {
    if (src.host === "gitee") return `https://gitee.com/api/v5/repos/${src.owner}/${src.repo}/contents/${subpath}`;
    return `https://api.github.com/repos/${src.owner}/${src.repo}/contents/${subpath}`;
  }

  function skillRawUrl(src: SkillSource, name: string): string {
    if (src.host === "gitee") return `https://gitee.com/${src.owner}/${src.repo}/raw/${src.branch}/skills/${name}/SKILL.md`;
    return `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${src.branch}/skills/${name}/SKILL.md`;
  }

  function skillCloneUrl(host: string, owner: string, repo: string): string {
    if (host === "gitee") return `https://gitee.com/${owner}/${repo}.git`;
    return `https://github.com/${owner}/${repo}.git`;
  }

  function skillAvatarUrl(src: SkillSource): string {
    if (src.host === "gitee") return `https://gitee.com/${src.owner}.png?`;
    return `https://github.com/${src.owner}.png?`;
  }

  /** Process items with limited concurrency to avoid rate-limiting. */
  async function batchFetch<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let idx = 0;
    const worker = async () => {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return results;
  }

  let _skillsCache: Map<string, { data: Array<Record<string, unknown>>; ts: number }> | null = null;

  async function searchSkills(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://${req.headers.host || "localhost"}`);
    const q = url.searchParams.get("q") || "";
    const filterHost = url.searchParams.get("source") || ""; // "github" | "gitee" | ""
    const FETCH_TIMEOUT = 15_000;

    if (filterHost && filterHost !== "gitee" && filterHost !== "github") {
      res.writeHead(400); res.end("unknown skill source"); return;
    }
    if (!_skillsCache) _skillsCache = new Map();
    const hosts = filterHost ? [filterHost] : ["gitee", "github"];
    // A failed source must not prevent other sources from loading. Only a
    // successfully obtained snapshot (including an empty one) is usable.
    const outcomes = await Promise.allSettled(hosts.map(async host => {
      const cached = _skillsCache!.get(host);
      if (cached && now() - cached.ts < SKILLS_CACHE_TTL) return;
      if (host === "gitee") await fetchGiteeSkills(FETCH_TIMEOUT);
      else await fetchGithubSkills(FETCH_TIMEOUT);
    }));
    const failed = outcomes.some(result => result.status === "rejected");
    const snapshots = hosts.flatMap(host => {
      const cached = _skillsCache!.get(host);
      return cached ? [cached] : [];
    });
    if (!snapshots.length) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Skill sources are unavailable. Please retry." }));
      return;
    }
    let list = snapshots.flatMap(snapshot => snapshot.data);
    if (q) list = list.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase()));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ skills: list, ...(failed ? { cached: true } : {}) }));
  }

  async function fetchGiteeSkills(timeout: number): Promise<void> {
    const res = await fetch(
      "https://gitee.com/firslov/ashub_skills/raw/main/skills_index.json",
      { headers: { "User-Agent": "asHub" }, signal: AbortSignal.timeout(timeout) },
    );
    if (!res.ok) throw new Error(`Skill source HTTP ${res.status}`);
    const items = await res.json() as Array<{ name: string; description: string; source: string; origin_tag: string }>;
    if (!Array.isArray(items) || items.some(s => !s || typeof s.name !== "string" || !s.name.trim())) {
      throw new Error("Invalid skill catalog");
    }
    const skills = items.map((s) => ({
      id: `gitee:firslov/ashub_skills/${s.name}`,
      name: s.name,
      displayName: s.name,
      author: s.source || "firslov",
      avatar: "https://gitee.com/firslov.png?",
      source: "gitee",
      description: s.description || "",
      updated: "",
      topics: s.origin_tag ? [s.origin_tag] : [],
    }));
    _skillsCache!.set("gitee", { data: skills as Array<Record<string, unknown>>, ts: now() });
  }

  // Keep source snapshots separately so one unavailable repository cannot
  // erase the rest of the catalog or become a fresh empty cache.
  const _githubSkillsCache = new Map<string, { data: Array<Record<string, unknown>>; ts: number }>();
  async function fetchGithubSkills(timeout: number): Promise<void> {
    const githubSources = SKILL_SOURCES.filter((s) => s.host === "github");
    const allSkills: Array<Record<string, unknown>> = [];
    let complete = true;
    let hasSnapshot = false;
    for (const src of githubSources) {
      const key = `${src.owner}/${src.repo}/${src.branch}`;
      const previous = _githubSkillsCache.get(key);
      if (previous) hasSnapshot = true;
      if (previous && now() - previous.ts < SKILLS_CACHE_TTL) {
        allSkills.push(...previous.data);
        continue;
      }
      try {
        const dirsRes = await fetch(
          skillApiUrl(src, "skills"),
          { headers: { "User-Agent": "asHub", "Accept": "application/vnd.github.v3+json" }, signal: AbortSignal.timeout(timeout) },
        );
        if (!dirsRes.ok) throw new Error(`Skill source HTTP ${dirsRes.status}`);
        const dirs = (await dirsRes.json()) as Array<{ name: string; type: string }>;
        const skillDirs = dirs.filter((d) => d.type === "dir");

        const skills = await batchFetch(skillDirs, 15, async (d) => {
          try {
            const fileRes = await fetch(
              skillRawUrl(src, d.name),
              { headers: { "User-Agent": "asHub" }, signal: AbortSignal.timeout(timeout) },
            );
            if (!fileRes.ok) return null;
            const content = await fileRes.text();
            const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
            let name = d.name;
            let description = "";
            if (fm) {
              const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
              const descMatch = fm[1].match(/^description:\s*(.+)$/m);
              if (nameMatch) name = nameMatch[1].trim();
              if (descMatch) description = descMatch[1].trim().slice(0, 200);
            }
            return {
              id: `github:${src.owner}/${src.repo}/${d.name}`,
              name: d.name,
              displayName: name,
              author: src.author,
              avatar: skillAvatarUrl(src),
              source: "github",
              description,
              updated: "",
              topics: [],
            };
          } catch { return null; }
        });
        const data = skills.filter(Boolean) as Array<Record<string, unknown>>;
        const sourceComplete = skills.every(Boolean);
        const snapshot = !sourceComplete && previous ? previous.data : data;
        const ts = sourceComplete ? now() : now() - SKILLS_CACHE_TTL;
        if (sourceComplete || snapshot.length || previous) {
          _githubSkillsCache.set(key, { data: snapshot, ts });
          hasSnapshot = true;
        }
        allSkills.push(...snapshot);
        if (!sourceComplete) complete = false;
      } catch {
        complete = false;
        if (previous) allSkills.push(...previous.data);
      }
    }
    if (hasSnapshot) _skillsCache!.set("github", { data: allSkills, ts: complete ? now() : now() - SKILLS_CACHE_TTL });
    if (!complete) throw new Error("Some GitHub skill sources are unavailable");
  }

  // Short-TTL cache for installed-skills scans: the frontend panel polls this
  // endpoint frequently and a full scan can walk many directories. Keyed by the
  // scan roots (cwd + configured skill paths).
  function skillSourceId(url: string, subdir = ""): string | undefined {
    try {
      const parsed = new URL(url.replace(/^git@([^:]+):/, "https://$1/"));
      const host = parsed.hostname === "github.com" ? "github" : parsed.hostname === "gitee.com" ? "gitee" : null;
      const repo = parsed.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/, "");
      const parts = repo.split("/");
      if (!host || parts.length !== 2 || parts.some(p => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p))) return;
      if (subdir && !/^skills\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(subdir)) return;
      return `${host}:${repo}${subdir ? "/" + subdir.slice(7) : ""}`;
    } catch { return; }
  }

  async function installedSkillSourceId(dir: string): Promise<string | undefined> {
    try {
      const source = JSON.parse(await fs.promises.readFile(path.join(dir, ".ashub-source.json"), "utf-8"));
      if (typeof source.url !== "string" || typeof source.subdir !== "string") return;
      return skillSourceId(source.url, source.subdir);
    } catch { /* Legacy full-repository installs may only have a git remote. */ }
    if (!fs.existsSync(path.join(dir, ".git"))) return;
    const origin = await new Promise<string>(resolve => {
      execFile("git", ["-C", dir, "config", "--get", "remote.origin.url"], { timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout.trim()));
    });
    return skillSourceId(origin);
  }

  const INSTALLED_SKILLS_CACHE_TTL = 15_000; // 15 seconds
  const _installedSkillsCache = new Map<string, { list: Array<{ name: string; path: string; sourceId?: string }>; ts: number }>();
  let installedSkillsGeneration = 0;

  function invalidateSkillCaches(): void {
    invalidateGlobalSkillsCache();
    ++installedSkillsGeneration;
    _installedSkillsCache.clear();
    try { dependencies.onChanged?.(); } catch { /* Observers cannot undo a completed storage mutation. */ }
  }

  function resolveSkillPath(p: string): string {
    return p.startsWith("~/") || p === "~" ? path.resolve(path.join(homedir(), p.slice(1))) : path.resolve(p);
  }

  async function listInstalledSkills(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://${req.headers.host || "localhost"}`);
    const cwd = url.searchParams.get("cwd") || undefined;
    const settings = getSettings();

    const cacheKey = JSON.stringify([cwd ?? "", settings.skillPaths ?? []]);
    const cached = _installedSkillsCache.get(cacheKey);
    if (cached && now() - cached.ts < INSTALLED_SKILLS_CACHE_TTL) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ installed: cached.list }));
      return;
    }

    const generation = installedSkillsGeneration;
    const list: Array<{ name: string; path: string; sourceId?: string }> = [];
    const seen = new Set<string>();

    const addFromDir = async (dir: string) => {
      // A configured path may itself be a skill, not just a container.
      try {
        if ((await fs.promises.stat(path.join(dir, "SKILL.md"))).isFile()) {
          const name = path.basename(dir);
          if (!seen.has(name)) {
            seen.add(name);
            list.push({ name, path: dir, sourceId: await installedSkillSourceId(dir) });
          }
          return;
        }
      } catch { /* Scan child packages when this is a container. */ }
      let names: string[];
      try {
        names = await fs.promises.readdir(dir);
      } catch { return; } // missing/unreadable dir -> no skills, not an error
      for (const name of names) {
        const skillPath = path.join(dir, name);
        try { if (!(await fs.promises.stat(skillPath)).isDirectory()) continue; } catch { continue; }
        if (await _hasSkillMd(skillPath) && !seen.has(name)) {
          seen.add(name);
          list.push({ name, path: skillPath, sourceId: await installedSkillSourceId(skillPath) });
        }
      }
    };

    // Match kernel precedence: global, configured paths, then cwd ancestors.
    await addFromDir(path.join(path.dirname(settingsPath()), "skills"));

    // Additional skill paths from settings (e.g. custom install locations)
    for (const p of settings.skillPaths ?? []) {
      await addFromDir(resolveSkillPath(p));
    }

    // Project skills: .agents/skills/ in cwd and ancestor dirs (up to home)
    if (cwd) {
      const home = path.resolve(homedir());
      let current = path.resolve(cwd);
      while (true) {
        await addFromDir(path.join(current, ".agents", "skills"));
        if (current === home) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }

    // Mutations invalidate in-flight scans as well as the completed cache.
    if (generation !== installedSkillsGeneration) return listInstalledSkills(req, res);
    _installedSkillsCache.set(cacheKey, { list, ts: now() });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ installed: list }));
  }

  // Depth-limited lookup: a skill normally has SKILL.md at its root, or nested a
  // level or two down; deeper recursion only risks walking huge directory trees.
  const SKILL_MD_MAX_DEPTH = 3;

  async function _hasSkillMd(dir: string, depth = 0): Promise<boolean> {
    try {
      await fs.promises.access(path.join(dir, "SKILL.md"));
      return true;
    } catch { /* no SKILL.md at this level */ }
    if (depth >= SKILL_MD_MAX_DEPTH) return false;
    try {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        if (entry.isDirectory() && await _hasSkillMd(path.join(dir, entry.name), depth + 1)) return true;
      }
    } catch {}
    return false;
  }

  const skillOperations = new Set<string>();

  async function installSkill(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let fullId: string;
    try { fullId = JSON.parse(body).id; } catch { res.statusCode = 400; res.end("invalid JSON"); return; }

    if (typeof fullId !== "string" || !fullId.trim()) { res.writeHead(400); res.end("invalid id"); return; }

    // Parse "host:owner/repo/name" or "owner/repo/name" (legacy)
    let host = "github";
    let rest = fullId;
    if (fullId.includes(":") && !fullId.includes("://")) {
      [host, rest] = fullId.split(":") as [string, string];
    }
    const parts = rest.split("/");
    if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p) || p === "..")) { res.statusCode = 400; res.end("invalid repo id"); return; }

    const isSparseSkills = parts.length === 3;
    const skillName = isSparseSkills ? parts[2]! : parts[1]!;
    const skillDir = path.join(path.dirname(settingsPath()), "skills");
    const dest = path.join(skillDir, skillName);
    const cloneUrl = skillCloneUrl(host, parts[0]!, parts[1]!);
    if (skillOperations.has(dest)) { res.writeHead(409); res.end("skill operation in progress"); return; }
    skillOperations.add(dest);

    try {
      await fs.promises.mkdir(skillDir, { recursive: true });

      // Check git availability on first install
      try {
        await new Promise<void>((resolve, reject) => {
          execFile("git", ["--version"], { timeout: 5_000 }, (err) => {
            err ? reject(err) : resolve();
          });
        });
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Git is not available. Please install Git and add it to your PATH." }));
        return;
      }

      if (fs.existsSync(dest) && (await fs.promises.lstat(dest)).isSymbolicLink()) throw new Error("refusing to replace a symlink");
      if (fs.existsSync(dest)) {
        let source = "";
        try { source = (await fs.promises.readFile(path.join(dest, ".ashub-source.json"), "utf-8")); } catch {}
        const expected = JSON.stringify({ url: cloneUrl, subdir: isSparseSkills ? `skills/${skillName}` : "" });
        let sameSource = source === expected;
        if (!source && !isSparseSkills && fs.existsSync(path.join(dest, ".git"))) {
          const origin = await new Promise<string>((resolve) => {
            execFile("git", ["-C", dest, "config", "--get", "remote.origin.url"], { timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout.trim()));
          });
          const normalize = (url: string) => url.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git\/?$/, "").replace(/\/$/, "");
          sameSource = normalize(origin) === normalize(cloneUrl);
        }
        if (!sameSource) { res.writeHead(409); res.end("A skill with this name already exists from a different or unknown source."); return; }
      }
      if (fs.existsSync(dest) && !isSparseSkills) {
        await new Promise<void>((resolve, reject) => {
          execFile("git", ["-C", dest, "pull", "--ff-only"], { timeout: 30_000 }, (err) => {
            err ? reject(err) : resolve();
          });
        });
      } else if (isSparseSkills) {
        const tmpDir = await fs.promises.mkdtemp(path.join(skillDir, `.tmp-${skillName}-`));
        const runGit = (args: string[]) => new Promise<void>((resolve, reject) => {
          execFile("git", args, { timeout: 60_000 }, err => err ? reject(err) : resolve());
        });
        let safeToCleanup = true;
        try {
          const repo = path.join(tmpDir, "repo");
          await runGit(["clone", "--depth", "1", "--filter=blob:none", "--sparse", cloneUrl, repo]);
          await runGit(["-C", repo, "sparse-checkout", "set", `skills/${skillName}`]);
          const staged = path.join(tmpDir, "skill");
          await fs.promises.cp(path.join(repo, "skills", skillName), staged, { recursive: true });
          if (!await _hasSkillMd(staged)) throw new Error("skill has no SKILL.md");
          await fs.promises.writeFile(path.join(staged, ".ashub-source.json"), JSON.stringify({ url: cloneUrl, subdir: `skills/${skillName}` }));
          const backup = path.join(tmpDir, "previous");
          const existed = fs.existsSync(dest);
          if (existed) await fs.promises.rename(dest, backup);
          try { await fs.promises.rename(staged, dest); }
          catch (err) {
            if (existed) {
              try { await fs.promises.rename(backup, dest); }
              catch { safeToCleanup = false; throw new Error(`Update failed; previous skill retained at ${backup}`); }
            }
            throw err;
          }
        } finally { if (safeToCleanup) await fs.promises.rm(tmpDir, { recursive: true, force: true }); }
      } else {
        await new Promise<void>((resolve, reject) => {
          execFile("git", ["clone", "--depth", "1", cloneUrl, dest], { timeout: 60_000 }, (err) => {
            err ? reject(err) : resolve();
          });
        });
      }
      if (!isSparseSkills) await fs.promises.writeFile(path.join(dest, ".ashub-source.json"), JSON.stringify({ url: cloneUrl, subdir: "" }));
      invalidateSkillCaches();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, path: dest, sourceId: skillSourceId(cloneUrl, isSparseSkills ? `skills/${skillName}` : "") }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } finally { skillOperations.delete(dest); }
  }

  async function uninstallSkill(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let name: string, requestedPath: string | undefined, cwd: string | undefined, sourceId: string | undefined;
    try { ({ name, path: requestedPath, cwd, sourceId } = JSON.parse(body)); } catch { res.statusCode = 400; res.end("invalid JSON"); return; }
    if (typeof name !== "string" || !name.trim() || name === "." || name === ".." || /[\/\\\x00-\x1f<>:"|?*]/.test(name)) { res.statusCode = 400; res.end("invalid name"); return; }
    if (requestedPath !== undefined && typeof requestedPath !== "string") { res.writeHead(400); res.end("invalid path"); return; }
    if (sourceId !== undefined && (typeof sourceId !== "string" || !sourceId)) { res.writeHead(400); res.end("invalid source id"); return; }
    const dest = path.resolve(requestedPath ?? path.join(path.dirname(settingsPath()), "skills", name));
    const roots = [path.join(path.dirname(settingsPath()), "skills"), path.join(homedir(), ".agents", "skills")];
    for (const p of getSettings().skillPaths ?? []) roots.push(resolveSkillPath(p));
    if (typeof cwd === "string" && cwd) {
      let current = path.resolve(cwd);
      while (true) {
        roots.push(path.join(current, ".agents", "skills"));
        const parent = path.dirname(current);
        if (parent === current || current === path.resolve(homedir())) break;
        current = parent;
      }
    }
    const directRoot = roots.some(p => path.resolve(p) === dest) && path.basename(dest) === name
      && fs.existsSync(path.join(dest, "SKILL.md"));
    if (!directRoot && !roots.some(p => path.resolve(p, name) === dest)) { res.writeHead(403); res.end("not an installed skill path"); return; }
    if (skillOperations.has(dest)) { res.writeHead(409); res.end("skill operation in progress"); return; }
    skillOperations.add(dest);
    try {
      if (!fs.existsSync(dest) || !await _hasSkillMd(dest)) { res.writeHead(404); res.end("skill not found"); return; }
      if (sourceId !== undefined && await installedSkillSourceId(dest) !== sourceId) {
        res.writeHead(409); res.end("Skill source changed or does not match. Refresh the installed skills list."); return;
      }
      await fs.promises.rm(dest, { recursive: true });
      invalidateSkillCaches();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } finally { skillOperations.delete(dest); }
  }


  function handle(handler: SkillRequestHandler): SkillRequestHandler {
    return async (req, res) => {
      if (closed) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Skills marketplace service is closed" }));
        return;
      }
      ++pending;
      try { await handler(req, res); }
      catch (error) {
        if (error !== bodyReadCancelled) throw error;
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Skills marketplace request body cancelled" }));
        }
      }
      finally { if (--pending === 0) resolveDrain?.(); }
    };
  }

  function close(): Promise<void> {
    if (!closeTask) {
      closed = true;
      for (const [req, cancel] of bodyReaders) {
        // Reject first: destroy can make a legacy reader resolve an empty body.
        cancel();
        if (!req.complete && !req.readableEnded) req.destroy();
      }
      closeTask = (pending ? new Promise<void>(resolve => { resolveDrain = resolve; }) : Promise.resolve())
        .then(() => {
          _skillsCache?.clear();
          _githubSkillsCache.clear();
          _installedSkillsCache.clear();
        });
    }
    return closeTask;
  }

  return {
    searchSkills: handle(searchSkills),
    listInstalledSkills: handle(listInstalledSkills),
    installSkill: handle(installSkill),
    uninstallSkill: handle(uninstallSkill),
    invalidate: invalidateSkillCaches,
    close,
    get pendingCount() { return pending; },
  };
}

export type SkillsMarketplaceService = ReturnType<typeof createSkillsMarketplaceService>;
