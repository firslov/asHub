import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { satisfies, validRange } from 'semver';
import { updateSettingsFile } from './settings-store.js';
import { PLUGIN_AUTO_APPROVE } from './plugin-approvals.js';
import { pluginCatalog, readPluginSettings, bundledPluginId, includedPackageIds, restorableApps, BUNDLED_ENABLED, BUNDLED_REMOVED, PLUGIN_DISABLED, PLUGIN_ENTRY_FILES } from './plugins.js';
import { readPluginManifest, pluginCompatibility, packageMetadataCompatibility, validatePluginEntries, type NormalizedPluginManifest } from './extensions/manifest.js';
import { RuntimeEnvironment, type RuntimeProvider } from './services/runtime-environment.js';

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
  // Keep preview checks consistent with the catalog's SemVer constraints:
  // build metadata does not lower a release, and prereleases need explicit opt-in.
  return satisfies(actual, `>=${minimum}`);
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
interface Check { label: string; ok: boolean; detail: string }
interface EnvironmentCheck {
  checks: Check[];
  setupEnv: NodeJS.ProcessEnv;
  revision: string;
}
interface Plan {
  token: string; requestId?: string; directory: string; packageRoot: string; id: string; name: string; version: string; entry?: string; manifestFingerprint?: string; packageMetadata: string;
  manifest?: NormalizedPluginManifest; nodeRange?: string; packageOs?: unknown; packageCpu?: unknown;
  npm: boolean; target: string; previous: string; expiresAt: number; environment: EnvironmentCheck; environmentRefresh: number;
}
export interface PluginInstalledNotice { readonly jobId: string; readonly packageId: string; readonly name: string; readonly version: string; readonly target: string }
interface Job { notificationError?: string; id: string; name: string; version: string; state: 'running' | 'succeeded' | 'failed'; step: string; error?: string; backup?: string; restartRequired: boolean }
function json(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
// Keep approved identity, entry resolution and runtime requirements stable.
// Setup may generate build outputs and update non-runtime descriptive metadata.
const approvedPackageKeys = ['name', 'version', 'main', 'type', 'exports', 'imports', 'engines', 'os', 'cpu', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta'];
function stableMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableMetadata);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableMetadata((value as Record<string, unknown>)[key])]));
  return value;
}
function packageMetadata(pkg: Record<string, unknown>): string {
  return JSON.stringify(stableMetadata(Object.fromEntries(approvedPackageKeys.filter(key => Object.hasOwn(pkg, key)).map(key => [key, pkg[key]]))));
}
function validateApprovedPackage(plan: Plan): void {
  const pkg = json(path.join(plan.packageRoot, 'package.json'));
  if (!object(pkg) || packageMetadata(pkg) !== plan.packageMetadata) throw Error('Plugin package identity, entry or runtime requirements changed during setup');
}

function fingerprint(target: string): string {
  if (!fs.existsSync(target)) return '';
  const st = fs.lstatSync(target);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('Existing installation is not a managed directory');
  return createHash('sha256').update(`${st.dev}:${st.ino}:`).update(fs.readFileSync(path.join(target, 'package.json'))).digest('hex');
}
// Runtime providers may be injected or take time to terminate. Cancellation
// ends the preview promptly while the real provider also receives the signal.
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    task.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
export async function runPluginSetup(script: string, args: string[], cwd: string, home: string, dataDir: string, signal: AbortSignal, extraEnv: NodeJS.ProcessEnv = {}) {
  signal.throwIfAborted();
  const env = { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1', AGENT_SH_HOME: home, ASHUB_PLUGIN_DATA: dataDir };
  const childEnv = new RuntimeEnvironment({ env }).commandEnvironment();
  // npm 12 rejects inherited CLI script policies for project installs, even
  // with --ignore-scripts. This invocation deliberately runs no lifecycle
  // scripts; retain registry/proxy settings and leave the parent env untouched.
  if (path.basename(script) === 'npm-cli.js' && args[0] === 'ci' && args.includes('--ignore-scripts')) {
    for (const key of Object.keys(childEnv)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete childEnv[key];
  }
  await new Promise<void>((resolve, reject) => {
    let failure: Error | null = null;
    const child = execFile(process.execPath, [script, ...args], { cwd, windowsHide: true, timeout: 15 * 60_000, maxBuffer: 1024 * 1024,
      env: childEnv, signal }, (e, _stdout, stderr) => {
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
  private previewRefreshSequence = 0;
  private previewTasks = new Set<Promise<unknown>>();
  private previewRequests = new Map<string, ReturnType<PluginInstaller['previewStatus']>>();
  private closing?: Promise<void>;
  private controller = new AbortController();
  private base: string;
  constructor(private settingsFile: string, private run = runPluginSetup, private platform: string = process.platform, private inUse: (target: string) => boolean = () => false,
    private onInstalled?: (notice: PluginInstalledNotice) => void | Promise<void>, private notificationTimeoutMs = 10_000,
    private runtimes: RuntimeProvider = new RuntimeEnvironment()) {
    if (!Number.isFinite(notificationTimeoutMs) || notificationTimeoutMs <= 0) throw new Error('Invalid installation notification timeout');
    this.base = path.join(path.dirname(settingsFile), 'plugin-install');
  }
  private cleanup() {
    for (const [token, p] of this.plans) if (p.expiresAt < Date.now() && this.jobs.get(token)?.state !== 'running') this.removePlan(token);
  }
  private target(id: string, packageName: string): string {
    const root = path.join(path.dirname(this.settingsFile), 'extensions');
    const candidates = new Set<string>();
    for (const p of pluginCatalog(this.settingsFile)) {
      if (p.bundled) continue;
      if (p.damagedAppId === packageName && p.packageName !== packageName) throw Error('Repair or remove the damaged manual installation before updating');
      const dir = p.packageRoot ?? path.dirname(p.source);
      try { if (json(path.join(dir, 'package.json')).name === packageName) candidates.add(dir); }
      catch {
        if (p.includedApp && p.packageName === packageName) throw Error('Repair or remove the damaged manual installation before updating');
      }
    }
    if (candidates.size > 1) throw Error('Multiple copies of this plugin are installed; remove duplicates first');
    const target = [...candidates][0] ?? path.join(root, id);
    if (path.dirname(target) !== root) throw Error('This plugin is installed outside the extensions directory; update it manually');
    if (fs.existsSync(target) && json(path.join(target, 'package.json')).name !== packageName) throw Error('Destination belongs to a different plugin');
    fingerprint(target);
    return target;
  }
  private staticChecks(p: Plan): Check[] {
    const m = p.manifest, checks: Check[] = [];
    const included = p.previous ? undefined : pluginCatalog(this.settingsFile).find(app => app.bundled && app.packageName === p.id);
    const previousSource = p.previous ? p.target : included?.packageRoot;
    if (previousSource) checks.push({ label: 'inUse', ok: !this.inUse(previousSource), detail: 'Finish active tasks using this plugin before upgrading' });
    checks.push({ label: 'platform', ok: !m?.platforms || m.platforms.includes(this.platform), detail: m?.platforms?.join(', ') ?? 'Any' });
    checks.push({ label: 'node', ok: atLeast(process.versions.node, m?.minNode ?? '22.12.0') && (!p.nodeRange || satisfies(process.versions.node, p.nodeRange)), detail: `Node ${process.versions.node} / ${p.nodeRange ?? '>= ' + (m?.minNode ?? '22.12.0')}` });
    if (m) {
      const compatibility = pluginCompatibility(m, { platform: this.platform, nodeRange: p.nodeRange, packageOs: p.packageOs, packageCpu: p.packageCpu });
      checks.push({ label: 'host', ok: compatibility.compatible, detail: compatibility.errors.join('; ') || 'Host API and requested capabilities supported' });
    } else if (p.packageOs !== undefined || p.packageCpu !== undefined) {
      const compatibility = packageMetadataCompatibility({ platform: this.platform, packageOs: p.packageOs, packageCpu: p.packageCpu });
      checks.push({ label: 'host', ok: compatibility.compatible, detail: compatibility.errors.join('; ') || 'Package platform requirements supported' });
    }
    const installed = m?.dependencies.length ? pluginCatalog(this.settingsFile, { platform: this.platform }) : [];
    for (const dep of m?.dependencies ?? []) {
      let ok = false, found = '';
      const entries = installed.filter(entry => {
        if (entry.manifest?.id === dep.id) return true;
        try { return json(path.join(entry.packageRoot ?? path.dirname(entry.source), 'package.json')).name === dep.id; } catch { return false; }
      });
      if (entries.length && new Set(entries.map(entry => entry.packageRoot ?? path.dirname(entry.source))).size === 1) {
        const entry = entries.find(entry => entry.enabled && entry.compatibility?.compatible !== false) ?? entries[0]!; found = entry.version ?? '';
        ok = entry.enabled && entry.compatibility?.compatible !== false && atLeast(found, dep.minVersion);
      }
      checks.push({ label: 'dependency', ok, detail: `${dep.id} >= ${dep.minVersion}${found ? ` (${found})` : ''}` });
    }
    return checks;
  }
  private async checkEnvironment(p: Plan): Promise<EnvironmentCheck> {
    const signal=this.controller.signal; signal.throwIfAborted();
    const checks = this.staticChecks(p), setupEnv: NodeJS.ProcessEnv = {};
    const runtimes: Array<[kind: string, location: string | undefined, version: string | undefined]> = [];
    if (p.npm) {
      const npm = await abortable(this.runtimes.probeNpm(signal),signal);
      checks.push({ label: 'npm', ok: npm.ok, detail: npm.detail });
      if (npm.ok && npm.path) setupEnv.ASHUB_NPM_CLI = npm.path;
      runtimes.push(['npm', npm.path, npm.version]);
    }
    if (p.manifest?.system?.minMacOS && this.platform === 'darwin') {
      const system = await abortable(this.runtimes.probeMacOS(p.manifest.system.minMacOS,signal),signal);
      checks.push({ label: 'system', ok: system.ok, detail: system.detail });
    }
    for (const requirement of p.manifest?.runtimes ?? []) {
      const runtime = await abortable(requirement.kind === 'python' ? this.runtimes.probePython(requirement.version,signal) : this.runtimes.probeGit(requirement.version,signal),signal);
      checks.push({ label: 'runtime', ok: runtime.ok, detail: `${requirement.kind} ${requirement.version}: ${runtime.detail}` });
      if (runtime.ok && runtime.path) setupEnv[requirement.kind === 'python' ? 'ASHUB_RUNTIME_PYTHON' : 'ASHUB_RUNTIME_GIT'] = runtime.path;
      runtimes.push([requirement.kind, runtime.path, runtime.version]);
    }
    const revision = createHash('sha256').update(JSON.stringify(runtimes)).digest('hex');
    return { checks, setupEnv, revision };
  }
  private prerequisites(p: Plan) {
    const dynamic = p.environment.checks.filter(check => check.label === 'npm' || check.label === 'runtime' || check.label === 'system');
    return [...this.staticChecks(p), ...dynamic].every(check => check.ok);
  }
  preview(data: Buffer, requestId?: string) {
    if (requestId !== undefined && !/^[A-Za-z0-9-]{16,80}$/.test(requestId)) throw Error('Invalid preview request ID');
    if (requestId) {
      const existing = [...this.plans.values()].find(plan => plan.requestId === requestId);
      if (existing) return this.previewStatus(existing.token, false);
      const pending = this.previewRequests.get(requestId);
      if (pending) return pending;
    }
    const task = this.createPreview(data, requestId);
    this.previewTasks.add(task);
    if (requestId) {
      this.previewRequests.set(requestId, task);
      void task.then(() => this.previewRequests.delete(requestId), () => this.previewRequests.delete(requestId));
    }
    void task.then(() => this.previewTasks.delete(task), () => this.previewTasks.delete(task));
    return task;
  }
  private async createPreview(data: Buffer, requestId?: string) {
    this.controller.signal.throwIfAborted(); this.cleanup();
    if (!data.length || data.length > MAX_PLUGIN_ZIP) throw Error('ZIP must be between 1 byte and 32 MB');
    // Keep finished jobs available for polling without reserving staging slots.
    let staged = this.previews;
    for (const token of this.plans.keys()) {
      const job = this.jobs.get(token);
      if (!job || job.state === 'running') staged++;
    }
    if (staged >= 3) throw Error('Close an existing installation preview first');
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
      const manifest = readPluginManifest(root, pkg.name);
      const mf = path.join(root, 'ashub-plugin.json');
      const manifestFingerprint = manifest ? createHash('sha256').update(fs.readFileSync(mf)).digest('hex') : undefined;
      const entry = manifest ? (manifest.entries.session ?? manifest.entries.application) : PLUGIN_ENTRY_FILES.find(n => fs.existsSync(path.join(root, n)));
      if ((!entry && !manifest?.ui) || (pkg.main && (typeof pkg.main !== 'string' || pkg.main.replace(/^\.\//, '') !== entry))) throw Error('Plugin must expose its declared entry, or index.js, index.mjs or index.ts for legacy packages');
      if (entry && !fs.statSync(path.join(root, entry)).isFile()) throw Error('Missing plugin entry');
      for (const key of ['dependencies', 'optionalDependencies']) if (pkg[key] !== undefined && (!object(pkg[key]) || !Object.values(pkg[key]).every(v => typeof v === 'string'))) throw Error('Invalid npm dependencies');
      const npm = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).length > 0;
      if (npm && !fs.existsSync(path.join(root, 'package-lock.json'))) throw Error('Plugins with npm dependencies must include package-lock.json');
      const target = this.target(pkg.name, pkg.name);
      if (fs.existsSync(target)) {
        const previousManifest = readPluginManifest(target, pkg.name);
        const previousEntry = previousManifest ? (previousManifest.entries.session ?? previousManifest.entries.application ?? 'index.mjs') : PLUGIN_ENTRY_FILES.find(n => fs.existsSync(path.join(target, n)));
        // The catalog ID and disabled setting are bound to the canonical entry.
        if (previousEntry && previousEntry !== (entry ?? 'index.mjs')) throw Error('Plugin entry changed; update this package manually to preserve its settings and enable state');
      }
      const p: Plan = { token, requestId, directory, packageRoot: root, id: pkg.name, name: manifest?.name ?? pkg.name, version: pkg.version, entry, manifestFingerprint, packageMetadata: packageMetadata(pkg), manifest, nodeRange, packageOs: pkg.os, packageCpu: pkg.cpu, npm,
        target, previous: fingerprint(target), expiresAt: Date.now() + TTL, environment: { checks: [], setupEnv: {}, revision: '' }, environmentRefresh: 0 };
      p.environment = await this.checkEnvironment(p); this.controller.signal.throwIfAborted(); this.plans.set(token, p);
      return await this.previewStatus(token, false);
    } catch (e) { this.plans.delete(token); fs.rmSync(directory, { recursive: true, force: true }); throw e; }
    finally { this.previews--; }
  }
  previewStatus(token: string, refresh = true) {
    const task = this.readPreviewStatus(token, refresh);
    this.previewTasks.add(task);
    void task.then(() => this.previewTasks.delete(task), () => this.previewTasks.delete(task));
    return task;
  }
  private async readPreviewStatus(token: string, refresh = true) {
    this.cleanup();
    if (this.jobs.has(token)) throw Object.assign(Error('Installation already submitted'), { status: 409 });
    const p = this.plans.get(token);
    if (!p) throw Object.assign(Error('Preview expired; select the ZIP again'), { status: 404 });
    if (fingerprint(p.target) !== p.previous) throw Error('Installed plugin changed; select the ZIP again');
    if (refresh) {
      const sequence = ++this.previewRefreshSequence;
      const environment = await this.checkEnvironment(p);
      this.cleanup();
      if (this.jobs.has(token)) throw Object.assign(Error('Installation already submitted'), { status: 409 });
      if (this.plans.get(token) !== p) throw Object.assign(Error('Preview expired; select the ZIP again'), { status: 404 });
      if (fingerprint(p.target) !== p.previous) throw Error('Installed plugin changed; select the ZIP again');
      // A slower probe may have started before another window's completed refresh.
      if (sequence > p.environmentRefresh) {
        p.environment = environment;
        p.environmentRefresh = sequence;
      }
    }
    const { checks, revision: environmentRevision } = p.environment;
    return { token, requestId: p.requestId, name: p.name, version: p.version, target: p.target, previousVersion: p.previous ? json(path.join(p.target, 'package.json')).version : null,
      legacy: !p.manifest, checks, environmentRevision, canInstall: checks.every(c => c.ok), npm: p.npm, setup: p.manifest?.setup ?? null,
      manifest: p.manifest, compatibility: p.manifest ? pluginCompatibility(p.manifest, { platform: this.platform, nodeRange: p.nodeRange, packageOs: p.packageOs, packageCpu: p.packageCpu }) : undefined,
      permissions: p.manifest?.permissions ?? [], defaults: p.manifest?.defaults ?? {}, expiresAt: p.expiresAt };
  }
  async listPreviews(requestId: string) {
    if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId)) return [];
    // The upload may still be checking runtimes after its window reloads.
    await this.previewRequests.get(requestId);
    this.cleanup();
    return [...this.plans.values()].filter(plan => plan.requestId === requestId && !this.jobs.has(plan.token))
      .map(plan => ({ token: plan.token, requestId: plan.requestId, name: plan.name, version: plan.version, expiresAt: plan.expiresAt }));
  }
  discard(token: string) {
    const job = this.jobs.get(token);
    if (job?.state === 'running') throw Error('Installation is running');
    // Closing a finished result in one window must not stop polling in others.
    if (!job) this.removePlan(token);
  }
  private removePlan(token: string) {
    const p = this.plans.get(token); if (p) fs.rmSync(p.directory, { recursive: true, force: true });
    this.plans.delete(token); this.jobs.delete(token);
  }
  status(id: string) { this.cleanup(); const j = this.jobs.get(id); if (!j) throw Object.assign(Error('Installation not found; refresh the plugin list'), { status: 404 }); return { ...j }; }
  confirm(token: string, environmentRevision?: string) {
    this.controller.signal.throwIfAborted(); this.cleanup();
    const p = this.plans.get(token); if (!p) throw Error('Preview expired; select the ZIP again');
    if (environmentRevision !== undefined && environmentRevision !== p.environment.revision) {
      throw Object.assign(Error('Installation preview changed; refresh the preview and confirm again'), { status: 409 });
    }
    const existing = this.jobs.get(token); if (existing) return { ...existing };
    if (this.active) throw Error('Another plugin is being installed');
    if (fingerprint(p.target) !== p.previous) throw Error('Installed plugin changed; select the ZIP again');
    if (!this.prerequisites(p)) throw Error('Resolve the prerequisites and refresh the installation preview');
    const job: Job = { id: token, name: p.name, version: p.version, state: 'running', step: 'preparing', restartRequired: true };
    this.jobs.set(token, job);
    this.active = this.install(p, job, p.environment).finally(() => { this.active = undefined; });
    return { ...job };
  }
  restore(id: string): void {
    this.controller.signal.throwIfAborted();
    if (this.active) throw Error('A plugin installation is in progress');
    if (!restorableApps(this.settingsFile).some(app => app.id === id)) throw Error('This included extension is not available to reinstall');
    const pluginId = bundledPluginId(id);
    updateSettingsFile(this.settingsFile, settings => {
      settings[BUNDLED_REMOVED] = settings[BUNDLED_REMOVED].filter((name: string) => name !== id);
      for (const key of [BUNDLED_ENABLED, PLUGIN_AUTO_APPROVE]) {
        if (Array.isArray(settings[key])) settings[key] = settings[key].filter((value: string) => value !== pluginId);
      }
      return settings;
    });
  }
  uninstall(id: string): void {
    this.controller.signal.throwIfAborted();
    if (this.active) throw Error('A plugin installation is in progress');
    const catalog = pluginCatalog(this.settingsFile);
    const entry = catalog.find(plugin => plugin.id === id);
    if (!entry) throw Error('Plugin no longer installed');
    let target: string | undefined, backup: string | undefined;
    if (entry.directoryNames.length) {
      const root = path.join(path.dirname(this.settingsFile), 'extensions');
      const relative = path.relative(root, entry.source);
      if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || relative === '..')
        throw Error('Cannot identify the installed plugin directory');
      // Move only the discovered direct child (a symlink is moved as a link).
      target = path.join(root, relative.split(path.sep)[0]!);
      if (catalog.some(other => other.id !== id && (other.source === target || other.source.startsWith(target + path.sep))))
        throw Error('Remove other registrations for this plugin directory first');
      backup = path.join(this.base, 'backups', 'uninstalled-' + id + '-' + randomUUID());
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.renameSync(target, backup);
    }
    try {
      updateSettingsFile(this.settingsFile, settings => {
        const remove = (key: string, values: readonly string[]) => {
          if (Array.isArray(settings[key])) settings[key] = settings[key].filter((value: string) => !values.includes(value));
        };
        remove('extensions', entry.configuredSpecs ?? []);
        remove('disabledExtensions', entry.directoryNames.filter(name => !catalog.some(other => other.id !== id && other.directoryNames.includes(name))));
        remove(PLUGIN_DISABLED, [id]);
        const included = includedPackageIds(entry);
        if (included.length) {
          settings[BUNDLED_REMOVED] = [...new Set([...(settings[BUNDLED_REMOVED] ?? []), ...included])];
          remove(BUNDLED_ENABLED, included.map(bundledPluginId));
        }
        remove(PLUGIN_AUTO_APPROVE, [id, ...included.map(bundledPluginId)]);
        return settings;
      });
    } catch (error) {
      if (backup && target) fs.renameSync(backup, target);
      throw error;
    }
    // Upgrade plans refer to the previous target fingerprint. Once removed,
    // retire only affected plans so they no longer consume preview slots.
    if (target) for (const [token, plan] of this.plans) {
      if (plan.target !== target || this.jobs.has(token)) continue;
      plan.expiresAt = 0;
      try { this.removePlan(token); } catch { /* Expired cleanup can retry. */ }
    }
  }
  private async install(p: Plan, job: Job, approved: EnvironmentCheck) {
    const home = path.dirname(this.settingsFile), signal = this.controller.signal;
    let backup: string | undefined, placed = false, committed = false;
    try {
      job.step = 'checking'; const current = await this.checkEnvironment(p);
      signal.throwIfAborted();
      if (!current.checks.every(check => check.ok)) throw Error('External runtime prerequisites are no longer available; refresh the preview and retry');
      if (current.revision !== approved.revision) throw Error('External runtime selection changed; select the ZIP again and confirm the new preview');
      if (fingerprint(p.target) !== p.previous) throw Error('Installed plugin changed before setup');
      if (!this.staticChecks(p).every(c => c.ok)) throw Error('A plugin dependency or active task changed before setup');
      const data = path.join(home, 'plugin-data', p.id); fs.mkdirSync(data, { recursive: true, mode: 0o700 });
      if (p.npm) {
        job.step = 'dependencies'; const cli = approved.setupEnv.ASHUB_NPM_CLI; if (!cli) throw Error('npm is unavailable');
        await this.run(cli, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], p.packageRoot, home, data, signal, approved.setupEnv);
      }
      if (p.manifest?.setup) {
        job.step = 'setup'; await this.run(path.join(p.packageRoot, p.manifest.setup.script), [], p.packageRoot, home, data, signal, approved.setupEnv);
      }
      signal.throwIfAborted(); job.step = 'validating';
      validateApprovedPackage(p);
      // Revalidate declarations after setup as well as before it. A build must
      // not replace the approved entry, scope, capabilities or UI metadata.
      if (p.manifest) {
        const fingerprint = createHash('sha256').update(fs.readFileSync(path.join(p.packageRoot, 'ashub-plugin.json'))).digest('hex');
        if (fingerprint !== p.manifestFingerprint) throw Error('Plugin manifest changed during setup');
        validatePluginEntries(p.packageRoot, p.manifest);
        if (p.manifest.schemaVersion === 1 && PLUGIN_ENTRY_FILES.find(n => fs.existsSync(path.join(p.packageRoot, n))) !== p.entry) throw Error('Plugin entry changed during setup');
      } else if (fs.existsSync(path.join(p.packageRoot, 'ashub-plugin.json')) || PLUGIN_ENTRY_FILES.find(n => fs.existsSync(path.join(p.packageRoot, n))) !== p.entry) throw Error('Plugin entry or manifest changed during setup');
      for (const entry of p.manifest ? Object.values(p.manifest.entries) : [p.entry!]) {
        if (/\.m?js$/.test(entry)) await this.run('--check', [path.join(p.packageRoot, entry)], p.packageRoot, home, data, signal);
        if (!fs.statSync(path.join(p.packageRoot, entry)).isFile()) throw Error('Plugin entry missing after setup');
      }
      signal.throwIfAborted(); job.step = 'installing';
      const final = await this.checkEnvironment(p);
      if (!final.checks.every(c => c.ok)) throw Error('A plugin dependency or external runtime changed during setup');
      if (final.revision !== approved.revision) throw Error('External runtime selection changed during setup');
      // Recheck the package after the final awaited probes, immediately before placement.
      signal.throwIfAborted();
      validateApprovedPackage(p);
      if (p.manifest) {
        if (createHash('sha256').update(fs.readFileSync(path.join(p.packageRoot, 'ashub-plugin.json'))).digest('hex') !== p.manifestFingerprint) throw Error('Plugin manifest changed during setup');
        validatePluginEntries(p.packageRoot, p.manifest);
        if (p.manifest.schemaVersion === 1 && PLUGIN_ENTRY_FILES.find(n => fs.existsSync(path.join(p.packageRoot, n))) !== p.entry) throw Error('Plugin entry changed during setup');
      } else if (fs.existsSync(path.join(p.packageRoot, 'ashub-plugin.json')) || PLUGIN_ENTRY_FILES.find(n => fs.existsSync(path.join(p.packageRoot, n))) !== p.entry) throw Error('Plugin entry or manifest changed during setup');
      if (fingerprint(p.target) !== p.previous) throw Error('Installed plugin changed during final runtime checks');
      if (!this.staticChecks(p).every(c => c.ok)) throw Error('A plugin dependency or active task changed during final runtime checks');
      const replacedBundle = !p.previous && pluginCatalog(this.settingsFile).find(app => app.bundled && app.packageName === p.id);
      fs.mkdirSync(path.dirname(p.target), { recursive: true });
      if (p.previous) {
        backup = path.join(this.base, 'backups', p.id + '-' + p.token); fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.renameSync(p.target, backup);
      }
      try { fs.renameSync(p.packageRoot, p.target); placed = true; }
      catch (e) { if (backup) fs.renameSync(backup, p.target); throw e; }
      const replacesIncluded = !!replacedBundle || (!p.previous && (readPluginSettings(this.settingsFile)[BUNDLED_REMOVED] ?? []).includes(p.id));
      if (p.manifest?.defaults || replacesIncluded) updateSettingsFile(this.settingsFile, settings => {
        if (replacesIncluded) {
          const installed = pluginCatalog(this.settingsFile).find(plugin => plugin.packageRoot === p.target);
          if (!installed) throw Error('Cannot identify the installed extension');
          if (!replacedBundle || !replacedBundle.enabled) settings[PLUGIN_DISABLED] = [...new Set([...(settings[PLUGIN_DISABLED] ?? []), installed.id])];
          // The new copy owns its own consent. Keep the replaced resource off
          // the catalog even if this manual installation later disappears.
          settings[BUNDLED_REMOVED] = [...new Set([...(settings[BUNDLED_REMOVED] ?? []), p.id])];
          for (const [key, ids] of [[BUNDLED_ENABLED, [bundledPluginId(p.id)]], [PLUGIN_AUTO_APPROVE, [installed.id, bundledPluginId(p.id)]]] as const) {
            if (Array.isArray(settings[key])) settings[key] = settings[key].filter((value: string) => !ids.some(id => id === value));
          }
        }
        for (const [key, value] of Object.entries(p.manifest?.defaults ?? {})) if (!Object.hasOwn(settings, key)) settings[key] = value;
        return settings;
      });
      job.backup = backup; committed = true;
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
    if (committed) {
      for (const [token, obsolete] of this.plans) {
        if (obsolete.target !== p.target || this.jobs.has(token)) continue;
        obsolete.expiresAt = 0;
        try { this.removePlan(token); } catch { /* Retry when expired plans are cleaned up. */ }
      }
      // Package and settings are already committed. Notification failure must
      // never roll back the package or turn a successful installation into failure.
      if (this.onInstalled) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const notice = Object.freeze({ jobId: job.id, packageId: p.id, name: p.name, version: p.version, target: p.target });
          await Promise.race([
            Promise.resolve().then(() => this.onInstalled!(notice)),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Installation notification timed out')), this.notificationTimeoutMs); }),
          ]);
        } catch (error) { job.notificationError = String(error); }
        finally { if (timer) clearTimeout(timer); }
      }
      job.state = 'succeeded'; job.step = 'done';
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort();
    this.closing = (async () => {
      // Preview extraction owns staging writes too. Wait for its abort check
      // and finally cleanup before announcing that installer shutdown is done.
      const active = this.active;
      const results = await Promise.allSettled([active ?? Promise.resolve(), ...this.previewTasks]);
      const errors: unknown[] = results[0]?.status === 'rejected' ? [results[0].reason] : [];
      for (const key of [...this.plans.keys()]) {
        try { this.removePlan(key); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Plugin installer cleanup failed');
    })();
    return this.closing;
  }
}
