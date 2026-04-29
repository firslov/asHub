#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "..", "src", "cli.ts");
const tsxBin = path.join(here, "..", "node_modules", ".bin", "tsx");

const r = spawnSync(tsxBin, [cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
