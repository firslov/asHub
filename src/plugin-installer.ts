import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { satisfies, validRange } from 'semver';
import { updateSettingsFile } from './settings-store.js';
import { pluginCatalog, validatePluginNamespace, PLUGIN_ENTRY_FILES } from './plugins.js';

export const MAX_PLUGIN_ZIP = 32 * 1024 * 1024;
const MAX_EXPANDED = 128 * 1024 * 1024, TTL = 30 * 60_000;
const safeId = /^[a-z][a-z0-9-]{1,79}$/;
const version = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, max = 300): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\0-\x1f]/.test(v)) throw Error('Invalid plugin metadata');
  return v;
}
function relative(v: unknown): string {
  const name = text(v, 500);
  // Enforce portable names, including case-insensitive Windows/macOS targets.
  if (name.includes('\\') || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..'
    || /[:<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Error('Unsafe archive path');
  return name;
}
function atLeast(actual: string, minimum: string) {
  if (!version.test(actual) || !/^\d+\.\d+\.\d+$/.test(minimum)) return false;
  const a = actual.split(/[.+-]/).slice(0, 3).map(Number), b = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i]! > b[i]!; }
  return !actual.includes('-');
}
async function extractZip(data: Buffer, dest: string) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(data, { lazyEntries: true, strictFileNames: true }, (e, z) => e ? reject(e) : resolve(z!)));
  const seen = new Set<string>(); let count = 0, total = 0;
  await new Promise<void>((resolve, reject) => {
    let stopped = false;
    const fail = (e: unknown) => { if (!stopped) { stopped = true; zip.close(); reject(e); } };
    zip.on('error', fail); zip.on('end', () => { stopped = true; resolve(); });
    zip.on('entry', (entry: yauzl.Entry) => { void (async () => {
      if (++count > 4000 || entry.isEncrypted()) throw Error('Unsupported or oversized archive');
      const dir = entry.fileName.endsWith('/'), name = relative(dir ? entry.fileName.slice(0, -1) : entry.fileName);
      const key = name.normalize('NFC').toLowerCase();
      if (seen.has(key)) throw Error('Duplicate archive path'); seen.add(key);
      const mode = entry.externalFileAttributes >>> 16, kind = mode & 0o170000;
      if (kind && kind !== (dir ? 0o040000 : 0o100000)) throw Error('Links and special files are not allowed');
      if (name.split('/').some(p => p === 'node_modules' || p === '.git')) throw Error('Do not include node_modules or .git in a plugin package');
      total += entry.uncompressedSize;
      if (total > MAX_EXPANDED || entry.uncompressedSize > 32 * 1024 * 1024) throw Error('Expanded archive is too large');
      if (name.startsWith('__MACOSX/') || name.split('/').at(-1) === '.DS_Store') { if (!stopped) zip.readEntry(); return; }
      const file = path.join(dest, name);
      if (dir) fs.mkdirSync(file, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const input = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (e, stream) => e ? rej(e) : res(stream!)));
        await pipeline(input, fs.createWriteStream(file, { flags: 'wx', mode: mode & 0o111 ? 0o755 : 0o644 }));
      }
      if (!stopped) zip.readEntry();
    })().catch(fail); });
    zip.readEntry();
  });
}
interface Manifest {
  schemaVersion: 1; id: string; name?: string; platforms?: string[]; minNode?: string;
  dependencies?: Array<{ id: string; minVersion: string }>;
  setup?: { script: string; description: string };
  permissions?: string[];
  defaults?: Record<string, Record<string, unknown>>;
}
interface Check { label: string; ok: boolean; detail: string }
interface Plan {
  token: string; directory: string; packageRoot: string; id: string; name: string; version: string; entry: string;
  manifest?: Manifest; nodeRange?: string; npm: boolean; target: string; previous: string; expiresAt: number; checks: Check[];
}
interface Job { id: string; name: string; version: string; state: 'running' | 'succeeded' | 'failed'; step: string; error?: string; backup?: string; restartRequired: boolean }
function json(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function fingerprint(target: string): string {
  if (!fs.existsSync(target)) return '';
  const st = fs.lstatSync(target);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('Existing installation is not a managed directory');
  return createHash('sha256').update(`${st.dev}:${st.ino}:`).update(fs.readFileSync(path.join(target, 'package.json'))).digest('hex');
}
function npmCLI(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const file of [path.join(dir, 'node_modules/npm/bin/npm-cli.js'), path.join(dir, '../lib/node_modules/npm/bin/npm-cli.js'), path.join(dir, 'npm')]) {
      try { const real = fs.realpathSync(file); if (real.endsWith('npm-cli.js') && fs.statSync(real).isFile()) return real; } catch {}
    }
  }
}
export async function runPluginSetup(script: string, args: string[], cwd: string, home: string, dataDir: string, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let failure: Error | null = null;
    const child = execFile(process.execPath, [script, ...args], { cwd, windowsHide: true, timeout: 15 * 60_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENT_SH_HOME: home, ASHUB_PLUGIN_DATA: dataDir }, signal }, (e, _stdout, stderr) => {
      if (e) failure = Error((stderr || e.message).slice(-2000));
    });
    // Do not remove staging until the child has actually exited after abort.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { killTimer = setTimeout(() => child.kill('SIGKILL'), 3000); killTimer.unref(); };
    const deadline = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000 + 3000); deadline.unref();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('close', () => {
      clearTimeout(deadline); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
      if (failure || signal.aborted) reject(failure ?? Error('Installation cancelled')); else resolve();
    });
  });
}
export class PluginInstaller {
  private plans = new Map<string, Plan>();
  private jobs = new Map<string, Job>();
  private active?: Promise<void>;
  private previews = 0;
  private controller = new AbortController();
  private base: string;
  constructor(private settingsFile: string, private run = runPluginSetup, private platform: string = process.platform, private inUse: (target: string) => boolean = () => false) {
    this.base = path.join(path.dirname(settingsFile), 'plugin-install');
  }
  private cleanup() {
    for (const [token, p] of this.plans) if (p.expiresAt < Date.now() && this.jobs.get(token)?.state !== 'running') {
      fs.rmSync(p.directory, { recursive: true, force: true }); this.plans.delete(token); this.jobs.delete(token);
    }
  }
  private target(id: string, packageName: string): string {
    const root = path.join(path.dirname(this.settingsFile), 'extensions');
    const candidates = new Set<string>();
    for (const p of pluginCatalog(this.settingsFile)) {
      const dir = path.dirname(p.source);
      try { if (json(path.join(dir, 'package.json')).name === packageName) candidates.add(dir); } catch {}
    }
    if (candidates.size > 1) throw Error('Multiple copies of this plugin are installed; remove duplicates first');
    const target = [...candidates][0] ?? path.join(root, id);
    if (path.dirname(target) !== root) throw Error('This plugin is installed outside the extensions directory; update it manually');
    if (fs.existsSync(target) && json(path.join(target, 'package.json')).name !== packageName) throw Error('Destination belongs to a different plugin');
    fingerprint(target);
    return target;
  }
  private checks(p: Plan): Check[] {
    const m = p.manifest, checks: Check[] = [];
    if (p.previous) checks.push({ label: 'inUse', ok: !this.inUse(p.target), detail: 'Finish active tasks using this plugin before upgrading' });
    checks.push({ label: 'platform', ok: !m?.platforms || m.platforms.includes(this.platform), detail: m?.platforms?.join(', ') ?? 'Any' });
    checks.push({ label: 'node', ok: atLeast(process.versions.node, m?.minNode ?? '22.12.0') && (!p.nodeRange || satisfies(process.versions.node, p.nodeRange)), detail: `Node ${process.versions.node} / ${p.nodeRange ?? '>= ' + (m?.minNode ?? '22.12.0')}` });
    for (const dep of m?.dependencies ?? []) {
      let ok = false, found = '';
      const file = path.join(path.dirname(this.settingsFile), 'extensions', dep.id, 'package.json');
      try {
        found = json(file).version;
        const entry = pluginCatalog(this.settingsFile).find(e => path.dirname(e.source) === path.dirname(file));
        ok = !!entry?.enabled && atLeast(found, dep.minVersion);
      } catch {}
      checks.push({ label: 'dependency', ok, detail: `${dep.id} >= ${dep.minVersion}${found ? ` (${found})` : ''}` });
    }
    if (p.npm) checks.push({ label: 'npm', ok: !!npmCLI(), detail: 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund' });
    return checks;
  }
  async preview(data: Buffer) {
    this.controller.signal.throwIfAborted(); this.cleanup();
    if (!data.length || data.length > MAX_PLUGIN_ZIP) throw Error('ZIP must be between 1 byte and 32 MB');
    if (this.plans.size + this.previews >= 3) throw Error('Close an existing installation preview first');
    const token = randomUUID(), directory = path.join(this.base, 'staging', token), unpack = path.join(directory, 'unpack');
    this.previews++;
    try {
      fs.mkdirSync(unpack, { recursive: true, mode: 0o700 });
      await extractZip(data, unpack); this.controller.signal.throwIfAborted();
      let root = unpack;
      if (!fs.existsSync(path.join(root, 'package.json'))) {
        const children = fs.readdirSync(root).filter(n => n !== '__MACOSX' && n !== '.DS_Store');
        if (children.length !== 1 || !fs.statSync(path.join(root, children[0]!)).isDirectory()) throw Error('ZIP must contain one plugin with package.json');
        root = path.join(root, children[0]!);
      }
      const pkg = json(path.join(root, 'package.json'));
      if (!object(pkg) || !safeId.test(pkg.name) || !version.test(pkg.version)) throw Error('Plugin requires a valid package name and version');
      const nodeRange = pkg.engines?.node;
      if (nodeRange !== undefined && (typeof nodeRange !== 'string' || !validRange(nodeRange))) throw Error('Invalid Node version requirement');
      let manifest: Manifest | undefined;
      const mf = path.join(root, 'ashub-plugin.json');
      if (fs.existsSync(mf)) {
        const m = json(mf);
        if (!object(m) || m.schemaVersion !== 1 || !safeId.test(m.id) || m.id !== pkg.name) throw Error('Invalid installation manifest');
        if (m.name !== undefined) text(m.name, 100);
        if (m.platforms !== undefined && (!Array.isArray(m.platforms) || !m.platforms.length || !m.platforms.every((v: string) => ['darwin', 'win32', 'linux'].includes(v)))) throw Error('Invalid platforms');
        if (m.minNode !== undefined && !/^\d+\.\d+\.\d+$/.test(m.minNode)) throw Error('Invalid minimum Node version');
        if (m.dependencies !== undefined && (!Array.isArray(m.dependencies) || m.dependencies.length > 10 || !m.dependencies.every((d: any) => object(d) && safeId.test(d.id) && d.id !== m.id && /^\d+\.\d+\.\d+$/.test(d.minVersion)))) throw Error('Invalid plugin dependencies');
        if (m.permissions !== undefined && (!Array.isArray(m.permissions) || m.permissions.length > 10 || !m.permissions.every((v: unknown) => { text(v); return true; }))) throw Error('Invalid permission hints');
        if (m.setup) { relative(m.setup.script); text(m.setup.description, 500); if (!m.setup.script.endsWith('.mjs') && !m.setup.script.endsWith('.js')) throw Error('Setup must be a Node script'); }
        if (m.defaults !== undefined) {
          if (!object(m.defaults) || Object.keys(m.defaults).length > 5 || JSON.stringify(m.defaults).length > 16000) throw Error('Invalid configuration defaults');
          for (const [namespace, config] of Object.entries(m.defaults)) { validatePluginNamespace(namespace); if (!object(config)) throw Error('Default configuration must be an object'); }
        }
        manifest = m;
      }
      const entry = PLUGIN_ENTRY_FILES.find(n => fs.existsSync(path.join(root, n)));
      if (!entry || (pkg.main && (typeof pkg.main !== 'string' || pkg.main.replace(/^\.\//, '') !== entry))) throw Error('Plugin must expose its entry as index.js, index.mjs or index.ts');
      if (manifest?.setup && !fs.statSync(path.join(root, manifest.setup.script)).isFile()) throw Error('Missing setup script');
      for (const key of ['dependencies', 'optionalDependencies']) if (pkg[key] !== undefined && (!object(pkg[key]) || !Object.values(pkg[key]).every(v => typeof v === 'string'))) throw Error('Invalid npm dependencies');
      const npm = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).length > 0;
      if (npm && !fs.existsSync(path.join(root, 'package-lock.json'))) throw Error('Plugins with npm dependencies must include package-lock.json');
      const target = this.target(pkg.name, pkg.name);
      if (fs.existsSync(target)) {
        const previousEntry = PLUGIN_ENTRY_FILES.find(n => fs.existsSync(path.join(target, n)));
        // Existing settings and plugin IDs are bound to the entry path.
        if (previousEntry && previousEntry !== entry) throw Error('Plugin entry changed; update this package manually to preserve its settings and enable state');
      }
      const p: Plan = { token, directory, packageRoot: root, id: pkg.name, name: manifest?.name ?? pkg.name, version: pkg.version, entry, manifest, nodeRange, npm,
        target, previous: fingerprint(target), expiresAt: Date.now() + TTL, checks: [] };
      p.checks = this.checks(p); this.plans.set(token, p);
      return this.previewStatus(token);
    } catch (e) { this.plans.delete(token); fs.rmSync(directory, { recursive: true, force: true }); throw e; }
    finally { this.previews--; }
  }
  previewStatus(token: string) {
    this.cleanup();
    if (this.jobs.has(token)) throw Object.assign(Error('Installation already submitted'), { status: 409 });
    const p = this.plans.get(token);
    if (!p) throw Object.assign(Error('Preview expired; select the ZIP again'), { status: 404 });
    if (fingerprint(p.target) !== p.previous) throw Error('Installed plugin changed; select the ZIP again');
    p.checks = this.checks(p);
    return { token, name: p.name, version: p.version, target: p.target, previousVersion: p.previous ? json(path.join(p.target, 'package.json')).version : null,
      legacy: !p.manifest, checks: p.checks, canInstall: p.checks.every(c => c.ok), npm: p.npm, setup: p.manifest?.setup ?? null,
      permissions: p.manifest?.permissions ?? [], defaults: p.manifest?.defaults ?? {}, expiresAt: p.expiresAt };
  }
  discard(token: string) {
    if (this.jobs.get(token)?.state === 'running') throw Error('Installation is running');
    const p = this.plans.get(token); if (p) fs.rmSync(p.directory, { recursive: true, force: true });
    this.plans.delete(token); this.jobs.delete(token);
  }
  status(id: string) { this.cleanup(); const j = this.jobs.get(id); if (!j) throw Object.assign(Error('Installation not found; refresh the plugin list'), { status: 404 }); return { ...j }; }
  confirm(token: string) {
    this.controller.signal.throwIfAborted(); this.cleanup();
    const existing = this.jobs.get(token); if (existing) return { ...existing };
    const p = this.plans.get(token); if (!p) throw Error('Preview expired; select the ZIP again');
    if (this.active) throw Error('Another plugin is being installed');
    if (fingerprint(p.target) !== p.previous) throw Error('Installed plugin changed; select the ZIP again');
    if (!this.checks(p).every(c => c.ok)) throw Error('Resolve the prerequisites and select the ZIP again');
    const job: Job = { id: token, name: p.name, version: p.version, state: 'running', step: 'preparing', restartRequired: true };
    this.jobs.set(token, job);
    this.active = this.install(p, job).finally(() => { this.active = undefined; });
    return { ...job };
  }
  private async install(p: Plan, job: Job) {
    const home = path.dirname(this.settingsFile), signal = this.controller.signal;
    let backup: string | undefined, placed = false;
    try {
      const data = path.join(home, 'plugin-data', p.id); fs.mkdirSync(data, { recursive: true, mode: 0o700 });
      if (p.npm) {
        job.step = 'dependencies'; const cli = npmCLI(); if (!cli) throw Error('npm is unavailable');
        await this.run(cli, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], p.packageRoot, home, data, signal);
      }
      if (p.manifest?.setup) {
        job.step = 'setup'; await this.run(path.join(p.packageRoot, p.manifest.setup.script), [], p.packageRoot, home, data, signal);
      }
      signal.throwIfAborted(); job.step = 'validating';
      // Setup may generate another index file. Discovery priority must still
      // match the approved entry, whose path also identifies disabled plugins.
      if (PLUGIN_ENTRY_FILES.find(n => fs.existsSync(path.join(p.packageRoot, n))) !== p.entry) throw Error('Plugin entry changed during setup');
      if (/\.m?js$/.test(p.entry)) await this.run('--check', [path.join(p.packageRoot, p.entry)], p.packageRoot, home, data, signal);
      signal.throwIfAborted(); job.step = 'installing';
      if (!fs.statSync(path.join(p.packageRoot, p.entry)).isFile()) throw Error('Plugin entry missing after setup');
      if (fingerprint(p.target) !== p.previous) throw Error('Installed plugin changed during setup');
      if (!this.checks(p).every(c => c.ok)) throw Error('A plugin dependency changed during setup');
      fs.mkdirSync(path.dirname(p.target), { recursive: true });
      if (p.previous) {
        backup = path.join(this.base, 'backups', p.id + '-' + p.token); fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.renameSync(p.target, backup);
      }
      try { fs.renameSync(p.packageRoot, p.target); placed = true; }
      catch (e) { if (backup) fs.renameSync(backup, p.target); throw e; }
      if (p.manifest?.defaults) updateSettingsFile(this.settingsFile, settings => {
        for (const [key, value] of Object.entries(p.manifest!.defaults!)) if (!Object.hasOwn(settings, key)) settings[key] = value;
        return settings;
      });
      job.backup = backup; job.state = 'succeeded'; job.step = 'done';
    } catch (e) {
      job.state = 'failed'; job.error = String(e); job.step = 'failed';
      if (placed) {
        try { fs.renameSync(p.target, p.packageRoot); placed = false; if (backup) fs.renameSync(backup, p.target); }
        catch (recovery) { job.error += `; recovery failed: ${String(recovery)}; backup: ${backup ?? 'none'}`; }
      }
    }
    finally {
      // Backups are outside discovery and retained for manual recovery. Settings
      // are never replaced, including enable/disable choices and credentials.
      p.expiresAt = Date.now() + TTL;
      try { fs.rmSync(p.directory, { recursive: true, force: true }); } catch {}
    }
  }
  async close() { this.controller.abort(); await this.active; for (const key of this.plans.keys()) this.discard(key); }
}
