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
 * Exact versions and Git commits are checked; every declared dependency must
 * at least be present. Also check the local TypeScript launcher used by build.
 * Ranges are left to npm to avoid false positives.
 */
const { accessSync, constants, readFileSync, statSync } = require("node:fs");
const { join } = require("node:path");

const root = join(__dirname, "..");
const { dependencies = {}, devDependencies = {} } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const declared = { ...dependencies };
if (devDependencies.typescript) declared.typescript = devDependencies.typescript;
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
  } else {
    const commit = /^(?:github:|git\+(?:https|ssh):\/\/).+#([a-f0-9]{40})$/i.exec(spec)?.[1];
    if (commit) {
      // Unreleased upstream commits can retain the previous npm version.
      // The install lock records what npm actually put in node_modules.
      let resolved = "";
      try {
        const lock = JSON.parse(readFileSync(join(root, "node_modules", ".package-lock.json"), "utf8"));
        resolved = lock.packages?.[`node_modules/${name}`]?.resolved ?? "";
      } catch { /* A missing install record must not pass as the pinned commit. */ }
      if (!resolved.endsWith(`#${commit}`)) {
        problems.push(`${name}: installed Git commit is missing or stale (expected ${commit.slice(0, 7)})`);
      }
    }
    if (name === "typescript") {
      const launcher = process.platform === "win32" ? "tsc.cmd" : "tsc";
      try {
        const executable = join(root, "node_modules", ".bin", launcher);
        if (!statSync(executable).isFile()) throw Error("TypeScript launcher is not a file");
        accessSync(executable, constants.X_OK);
      } catch {
        problems.push(`${name}: npm launcher node_modules/.bin/${launcher} is missing or unusable`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error("\nnode_modules does not match package.json:\n");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nRun `npm ci --include=dev --bin-links`, then build again.\n");
  process.exit(1);
}
