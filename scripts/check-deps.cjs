#!/usr/bin/env node
/**
 * Fail fast when node_modules does not match package.json.
 *
 * `git pull` never updates node_modules, so after a pull that bumps a
 * dependency the build can fail with errors that look like bugs in our own
 * source. A missing field in a dependency's .d.ts surfaces as, say:
 *
 *   src/bridges/ash.ts:608:11 - error TS2353: Object literal may only specify
 *   known properties, and 'reasoningParams' does not exist in type
 *   'SubagentOptions'.
 *
 * when the only problem is a stale install. Running this from `prebuild` puts
 * the real fix in front of the reader before tsc gets a chance to mislead.
 *
 * Only exact pins are version-checked (agent-sh is pinned); every declared
 * dependency must at least be present. Ranges are left to npm — reimplementing
 * semver here risks false positives that would block every build.
 */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const declared = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies ?? {};
const problems = [];

for (const [name, spec] of Object.entries(declared)) {
  let installed = null;
  try {
    installed = JSON.parse(
      readFileSync(join(root, "node_modules", name, "package.json"), "utf8"),
    ).version;
  } catch {
    // Not installed — reported below.
  }
  if (!installed) {
    problems.push(`${name}: not installed (package.json wants ${spec})`);
  } else if (/^\d+\.\d+\.\d+$/.test(spec) && installed !== spec) {
    problems.push(`${name}: installed ${installed}, package.json pins ${spec}`);
  }
}

if (problems.length > 0) {
  console.error("\nnode_modules does not match package.json:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nRun `npm install` (or `npm ci` for a clean install), then build again.\n");
  process.exit(1);
}
