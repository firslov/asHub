import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

const git = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile("git", ["-C", cwd, ...args], { timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim() || error.message)); else resolve(stdout.trim());
  });
});
export interface WorkspaceInfo { root: string; branch?: string; git: boolean }
const cache = new Map<string, { until: number; value: Promise<WorkspaceInfo> }>();
export function workspaceInfo(cwd: string): Promise<WorkspaceInfo> {
  const found = cache.get(cwd); if (found && found.until > Date.now()) return found.value;
  const value = (async () => {
    const root = await fs.realpath(cwd).catch(() => path.resolve(cwd));
    try {
      const repo = await git(cwd, ["rev-parse", "--show-toplevel"]);
      const branch = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "HEAD (detached)");
      return { root: await fs.realpath(repo), branch, git: true };
    } catch { return { root, git: false }; }
  })();
  cache.set(cwd, { until: Date.now() + 30000, value });
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
  return value;
}
/** A new branch from HEAD; never resets, cleans or copies the source checkout. */
export async function createIsolatedWorkspace(cwd: string, directory: string) {
  const root = await fs.realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  await git(root, ["rev-parse", "--verify", "HEAD"]); // unborn repositories have no base commit
  const id = randomUUID(), branch = `ashub/${id.slice(0, 8)}`;
  const target = path.join(directory, id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await git(root, ["-c", `core.hooksPath=${path.join(directory, ".no-hooks")}`, "worktree", "add", "-b", branch, target, "HEAD"]);
  // Keep a nested working directory when it exists in the committed snapshot.
  const nested = path.join(target, path.relative(root, await fs.realpath(cwd)));
  const targetRoot = await fs.realpath(target);
  const nestedIsLocal = await fs.realpath(nested).then(async resolved => {
    // HEAD may contain a symlink where the source has an uncommitted directory.
    // Never select a starting directory outside the newly created checkout.
    const relative = path.relative(targetRoot, resolved);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) return false;
    return (await fs.stat(resolved)).isDirectory();
  }).catch(() => false);
  return { cwd: nestedIsLocal ? nested : target, root: target, branch };
}
