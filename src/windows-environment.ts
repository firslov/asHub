import { existsSync } from "node:fs";
import { win32 as path } from "node:path";
import { spawnSync } from "node:child_process";

/** Git's default Windows installer exposes git.exe, but not bash.exe, on PATH. */
export function configureWindowsEnvironment(env = process.env, platform = process.platform): void {
  if (platform !== "win32") return;
  const key = Object.keys(env).find(k => k.toLowerCase() === "path") || "Path";
  const original = env[key] || "";
  const roots: string[] = [];
  const where = path.join(env.SystemRoot || "C:\\Windows", "System32", "where.exe");
  const found = spawnSync(where, ["git.exe"], { env, encoding: "utf8", windowsHide: true, timeout: 3000 });
  if (found.status === 0) {
    for (const file of found.stdout.trim().split(/\r?\n/)) {
      if (file) roots.push(path.resolve(path.dirname(file), ".."));
    }
  }
  for (const base of [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (base) roots.push(path.join(base, "Git"));
  }
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, "Programs", "Git"));
  for (const root of roots) {
    const bin = path.join(root, "bin");
    if (!existsSync(path.join(bin, "bash.exe")) || !existsSync(path.join(root, "cmd", "git.exe"))) continue;
    // Prefer native Git Bash over Windows' optional WSL bash.exe shim.
    const parts = original.split(";").filter(p => p.replace(/^"|"$/g, "").toLowerCase() !== bin.toLowerCase());
    env[key] = [bin, ...parts].join(";");
    return;
  }
}
