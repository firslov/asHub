#!/usr/bin/env node
/**
 * Build the per-target ashub-server tarballs a release ships.
 *
 * Targets default to linux-x64 + linux-arm64 (override with
 * ASHUB_SERVER_TARGETS="linux-x64 darwin-arm64" or CLI args).  Each cross
 * target needs its matching @vscode/ripgrep-<platform>-<arch> package; a
 * target whose package is absent is skipped with a loud warning (and the
 * exact install command) rather than failing the whole build — so hooking
 * this into electron:dist can't block a dmg over a missing optional dep.
 * (--force is needed because npm's os/cpu gate refuses a foreign-arch dep.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_TARGETS = ["linux-x64", "linux-arm64"];

const cliTargets = process.argv.slice(2);
const envTargets = (process.env.ASHUB_SERVER_TARGETS ?? "").split(/[\s,]+/).filter(Boolean);
const targets = cliTargets.length ? cliTargets : envTargets.length ? envTargets : DEFAULT_TARGETS;

const ripgrepPkg = (target) => {
  const [platform, archRaw] = target.split("-");
  const arch = archRaw === "x86_64" ? "x64" : archRaw;
  return `ripgrep-${platform}-${arch}`;
};

const built = [];
const skipped = [];
for (const target of targets) {
  const pkg = ripgrepPkg(target);
  if (!fs.existsSync(path.join(ROOT, "node_modules", "@vscode", pkg))) {
    console.warn(`\n⚠ skipping ${target}: missing @vscode/${pkg}\n  install it with:  npm i --no-save --force @vscode/${pkg}`);
    skipped.push(target);
    continue;
  }
  console.log(`\n▶ building ${target}`);
  const r = spawnSync("node", [path.join(__dirname, "build-server-bundle.mjs")], {
    stdio: "inherit",
    env: { ...process.env, TARGET: target },
  });
  if (r.status !== 0) {
    console.error(`✗ ${target} failed (exit ${r.status})`);
    skipped.push(target);
    continue;
  }
  built.push(target);
}

console.log(`\nserver tarballs — built: ${built.join(", ") || "(none)"}${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}`);
if (built.length === 0) {
  console.error("no server tarballs built — releases will have no remote support");
  process.exit(1);
}
