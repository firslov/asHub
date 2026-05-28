#!/usr/bin/env node
/**
 * Build a portable ashub-server tarball.
 *
 * Sketch: builds for the current platform/arch only.  Production wants a
 * matrix (linux-x64, linux-arm64, darwin-arm64) and ideally a pinned Node
 * runtime bundled via Node SEA so the remote doesn't need Node installed.
 *
 * Layout produced:
 *   dist-server/
 *     bin/ashub          launcher (exec node ashub.mjs "$@")
 *     ashub.mjs           bundled JS (cli.ts + agent-sh + all pure-JS deps)
 *     node_modules/
 *       node-pty/        external — native .node files per arch
 *       @vscode/ripgrep/ external — shipped binary
 *       node-addon-api/  node-pty peer
 *     web/                static UI assets
 *     package.json        { "type": "module" }
 */
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "dist-server");

const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
if (!platform || !arch) {
  console.error(`unsupported host: ${process.platform}/${process.arch}`);
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;

console.log(`building ashub-server ${version} for ${platform}-${arch}`);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, "bin"), { recursive: true });
fs.mkdirSync(path.join(OUT, "node_modules"), { recursive: true });

const agentShVersion = JSON.parse(
  fs.readFileSync(path.join(ROOT, "node_modules", "agent-sh", "package.json"), "utf8"),
).version;

// agent-sh's package-version.js does require("../../package.json") relative
// to its own source path; once bundled the path is meaningless.  Inline the
// version at build time instead.
const inlineAgentShVersion = {
  name: "inline-agent-sh-version",
  setup(build) {
    build.onLoad({ filter: /agent-sh\/dist\/utils\/package-version\.js$/ }, () => ({
      contents: `export const PACKAGE_VERSION = ${JSON.stringify(agentShVersion)};`,
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: [path.join(ROOT, "dist", "cli.js")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile: path.join(OUT, "ashub.mjs"),
  external: ["node-pty", "@vscode/ripgrep", "node-addon-api"],
  plugins: [inlineAgentShVersion],
  define: {
    ASHUB_VERSION: JSON.stringify(version),
  },
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

for (const dep of ["node-pty", "node-addon-api"]) {
  copyDir(path.join(ROOT, "node_modules", dep), path.join(OUT, "node_modules", dep));
}
fs.mkdirSync(path.join(OUT, "node_modules", "@vscode"), { recursive: true });
copyDir(path.join(ROOT, "node_modules", "@vscode", "ripgrep"), path.join(OUT, "node_modules", "@vscode", "ripgrep"));
// ripgrep's binary lives in a per-arch sibling package loaded via
// optionalDependencies; only ship the one matching the target.
const rgArchPkg = `ripgrep-${platform}-${arch}`;
const rgArchSrc = path.join(ROOT, "node_modules", "@vscode", rgArchPkg);
if (!fs.existsSync(rgArchSrc)) {
  console.error(`missing ${rgArchSrc} — run npm install on a ${platform}-${arch} host first`);
  process.exit(1);
}
copyDir(rgArchSrc, path.join(OUT, "node_modules", "@vscode", rgArchPkg));

copyDir(path.join(ROOT, "web"), path.join(OUT, "web"));

fs.writeFileSync(
  path.join(OUT, "package.json"),
  JSON.stringify({ name: "ashub-server", version, type: "module", private: true }, null, 2),
);

const launcher = `#!/bin/sh
DIR="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$DIR/ashub.mjs" --web "$DIR/web" "$@"
`;
const launcherPath = path.join(OUT, "bin", "ashub");
fs.writeFileSync(launcherPath, launcher);
fs.chmodSync(launcherPath, 0o755);

const tarName = `ashub-server-${platform}-${arch}-${version}.tar.gz`;
const tarPath = path.join(ROOT, "dist-server-tarballs", tarName);
fs.mkdirSync(path.dirname(tarPath), { recursive: true });
const r = spawnSync("tar", ["-czf", tarPath, "-C", path.dirname(OUT), path.basename(OUT)], { stdio: "inherit" });
if (r.status !== 0) { console.error("tar failed"); process.exit(1); }

const sizeMB = (fs.statSync(tarPath).size / (1024 * 1024)).toFixed(1);
console.log(`\nwrote ${path.relative(ROOT, tarPath)} (${sizeMB} MB)`);
