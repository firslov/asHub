#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "..", "src", "cli.ts");
// Resolve tsx's loader entry directly so we can launch via `node --import`
// instead of the node_modules/.bin/tsx shim — the shim has no extension on
// POSIX (shell script) and fails with ENOENT on Windows when spawned without
// a shell. Resolving from this file works regardless of the caller's cwd.
const require = createRequire(import.meta.url);
const tsxImport = pathToFileURL(require.resolve("tsx")).href;

const r = spawnSync(process.execPath, ["--import", tsxImport, cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (r.error) {
  console.error(`[ashub] failed to launch: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
