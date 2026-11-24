import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
if (process.platform !== 'darwin' || Number(os.release().split('.')[0]) < 23 || !['arm64', 'x64'].includes(process.arch)) {
  throw Error('Desktop control requires macOS 14 or later on Apple Silicon or Intel.');
}
const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--home')) throw Error('Usage: node scripts/install.mjs [--home <agent-sh home>]');
const home = path.resolve(args[1] || process.env.AGENT_SH_HOME || path.join(os.homedir(), '.agent-sh'));
const root = path.join(home, 'extensions');
const target = path.join(root, 'ashub-desktop-control');
const marker = '.ashub-desktop-control';
if (!fs.existsSync(path.join(source, 'dist/index.js'))) throw Error('Use the built release archive, or run npm run build first.');
try { fs.accessSync(path.join(source, 'native/capture'), fs.constants.X_OK); }
catch { throw Error('The macOS capture helper is missing or not executable. Use the complete release archive.'); }
fs.mkdirSync(root, { recursive: true });
if (fs.existsSync(target) && !fs.existsSync(path.join(target, marker))) throw Error('Destination already exists and is not owned by this installer; nothing was changed.');
// Keep staged and backup copies outside extensions so a running host cannot
// discover a half-installed or duplicate plugin. Final placement is a rename.
const stagingRoot = path.join(home, 'desktop-control', 'packages');
fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
const stage = path.join(stagingRoot, '.install-' + randomUUID());
const backup = path.join(stagingRoot, '.backup-' + randomUUID());
let moved = false;
try {
  fs.mkdirSync(stage);
  for (const name of ['ashub-plugin.json', 'index.js', 'dist', 'package.json', 'README.md', 'LICENSE', 'docs', 'scripts', 'native']) {
    fs.cpSync(path.join(source, name), path.join(stage, name), { recursive: true });
  }
  fs.writeFileSync(path.join(stage, marker), 'ashub-desktop-control\n');
  if (fs.existsSync(target)) { fs.renameSync(target, backup); moved = true; }
  fs.renameSync(stage, target);
  if (moved) fs.rmSync(backup, { recursive: true, force: true });
  console.log(`Installed: ${target}\nRestart asHub (including its tray process). Enable the plugin if previously disabled, then run /desktop install.`);
} catch (e) {
  if (moved && !fs.existsSync(target)) fs.renameSync(backup, target);
  throw e;
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
