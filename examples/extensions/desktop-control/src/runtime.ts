import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ARC_REVISION } from './settings.js';

const exec = promisify(execFile);
const lockTimeout = 15 * 60_000;
const checkVersion = 'import sys; assert sys.version_info >= (3, 12)';
const checkModules = 'import arc_cua, Cocoa, Quartz, ApplicationServices, Vision';
const cancelled = 'Installation cancelled';

interface RuntimeState {
  installed: boolean;
  installing: boolean;
  installError: string;
  cleanupWarning: string;
  revision: string;
}

interface RuntimeHealth extends RuntimeState {
  healthy: boolean;
  healthError: string;
}

function detail(error: unknown): string {
  const failure = error as { stderr?: string; message?: string } | undefined;
  return String(failure?.stderr || failure?.message || error).trim().split(/\r?\n/).slice(-4).join(' | ').slice(-1200);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function execute(command: string, args: string[], options: ExecFileOptions): Promise<void> {
  const pending = exec(command, args, options);
  const child = pending.child;
  try { await pending; }
  finally {
    // Abort rejects execFile before the child exits. Wait before removing its staging directory.
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
        timer.unref();
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
}

export class DesktopRuntime {
  private installing?: Promise<void>;
  private installController?: AbortController;
  private closing?: Promise<void>;
  private closed = false;
  private readonly directory: string;
  private readonly healthTasks = new Map<AbortController, Promise<RuntimeHealth>>();
  error = '';
  private cleanupWarning = '';

  constructor(settingsFile: string, private platform = process.platform, private pythonSearch?: { standardDirectories: string[]; frameworkRoots: string[]; commandFallback: boolean }) {
    this.directory = path.join(path.dirname(settingsFile), 'desktop-control', 'runtimes', ARC_REVISION);
  }

  get python(): string { return path.join(this.directory, 'bin', 'python3'); }
  get installed(): boolean { return fs.existsSync(path.join(this.directory, '.complete')) && fs.existsSync(this.python); }
  get state(): RuntimeState {
    return { installed: this.installed, installing: !!this.installing, installError: this.error, cleanupWarning: this.cleanupWarning, revision: ARC_REVISION };
  }

  private async acquireLock(signal: AbortSignal): Promise<() => void> {
    const lock = this.directory + '.lock';
    const ownerFile = path.join(lock, 'owner');
    const owner = `${process.pid}:${randomUUID()}`;
    const deadline = Date.now() + lockTimeout;
    fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
    for (;;) {
      signal.throwIfAborted();
      if (this.closed) throw Error(cancelled);
      let created = false;
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
        created = true;
        fs.writeFileSync(ownerFile, owner, { mode: 0o600 });
        return () => {
          try {
            if (fs.readFileSync(ownerFile, 'utf8') === owner) fs.rmSync(lock, { recursive: true, force: true });
          } catch (error) { this.cleanupWarning = `Cannot remove installation lock: ${detail(error)}`; }
        };
      } catch (error) {
        if (created) {
          try { fs.rmSync(lock, { recursive: true, force: true }); } catch {}
          throw error;
        }
        if (errorCode(error) !== 'EEXIST') throw error;
        this.reclaimLock(lock, ownerFile);
        if (Date.now() >= deadline) throw Error('Timed out waiting for another desktop runtime installation');
        await delay(100, undefined, { signal });
      }
    }
  }

  private reclaimLock(lock: string, ownerFile: string): void {
    try {
      const owner = fs.readFileSync(ownerFile, 'utf8');
      const pid = Number(owner.split(':')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      try { process.kill(pid, 0); }
      catch (error) {
        if (errorCode(error) === 'ESRCH' && fs.readFileSync(ownerFile, 'utf8') === owner) {
          fs.rmSync(lock, { recursive: true, force: true });
        }
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return;
      // If a process died before writing its owner, allow the full installation timeout to pass.
      try {
        if (!fs.existsSync(ownerFile) && Date.now() - fs.statSync(lock).mtimeMs > lockTimeout) {
          fs.rmSync(lock, { recursive: true, force: true });
        }
      } catch {}
    }
  }

  private async withLock<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock(signal);
    try { return await operation(); }
    finally { release(); }
  }

  private unhealthy(healthError: string): RuntimeHealth {
    return { ...this.state, healthy: false, healthError };
  }

  private async checkHealth(signal: AbortSignal): Promise<RuntimeHealth> {
    if (!this.installed) return this.unhealthy('Desktop runtime is not installed');
    try {
      await execute(this.python, ['-I', '-B', '-c', `${checkVersion}; ${checkModules}`], { timeout: 30_000, maxBuffer: 1024 * 1024, signal });
    } catch (error) {
      if (signal.aborted || this.closed) return this.unhealthy(cancelled);
      return this.unhealthy(`Desktop runtime is damaged or incompatible. Reinstall it. ${detail(error)}`);
    }
    if (signal.aborted || this.closed) return this.unhealthy(cancelled);
    if (!this.installed) return this.unhealthy('Desktop runtime changed during validation; retry');
    return { ...this.state, healthy: true, healthError: '' };
  }

  async health(): Promise<RuntimeHealth> {
    if (this.closed) return this.unhealthy(cancelled);
    if (this.platform !== 'darwin') return this.unhealthy('Desktop control currently supports macOS only');
    if (!this.installed && !fs.existsSync(this.directory + '.lock')) return this.unhealthy('Desktop runtime is not installed');
    const controller = new AbortController();
    const task = this.withLock(controller.signal, () => this.checkHealth(controller.signal))
      .catch(error => this.unhealthy(controller.signal.aborted || this.closed ? cancelled : `Cannot check desktop runtime: ${detail(error)}`))
      .finally(() => this.healthTasks.delete(controller));
    this.healthTasks.set(controller, task);
    return task;
  }

  install(force = false): void {
    if (this.closed) throw Error('Desktop component installer is closed');
    if (this.platform !== 'darwin') throw Error('Desktop control currently supports macOS only');
    if (this.installing || (this.installed && !force)) return;
    this.error = ''; this.cleanupWarning = '';
    const controller = this.installController = new AbortController();
    this.installing = this.prepare(controller.signal)
      .catch(error => { if (!controller.signal.aborted) this.error = error instanceof Error ? error.message : String(error); })
      .finally(() => { this.installing = undefined; this.installController = undefined; });
  }

  async ensureInstalled(): Promise<RuntimeHealth> {
    if (this.installed) {
      const current = await this.health();
      if (current.healthy) { this.error = ''; return { ...current, installError: '' }; }
      if (this.closed) return current;
    }
    this.install(true);
    await this.waitForInstall();
    const result = await this.health();
    if (result.healthy) { this.error = ''; return { ...result, installError: '' }; }
    return result;
  }

  async waitForInstall(): Promise<void> { await this.installing; }

  async close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.installController?.abort();
      for (const controller of this.healthTasks.keys()) controller.abort();
      this.closing = Promise.allSettled([this.installing, ...this.healthTasks.values()]).then(() => undefined);
    }
    return this.closing;
  }

  private removeRuntimeContent(target: string, message: string): void {
    try { fs.rmSync(target, { recursive: true, force: true }); }
    catch (error) { this.cleanupWarning = `${message}: ${detail(error)}`; }
  }

  private cleanupStale(): void {
    const parent = path.dirname(this.directory);
    const base = path.basename(this.directory);
    const cutoff = Date.now() - 24 * 60 * 60_000;
    try {
      for (const name of fs.readdirSync(parent)) {
        if (!name.startsWith(base + '.backup-') && !name.startsWith(base + '.install-')) continue;
        const target = path.join(parent, name);
        try {
          if (fs.statSync(target).mtimeMs < cutoff) this.removeRuntimeContent(target, 'Stale runtime content could not be removed');
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') this.cleanupWarning = `Cannot inspect stale runtime content: ${detail(error)}`;
        }
      }
    } catch (error) { this.cleanupWarning = `Cannot inspect runtime directory: ${detail(error)}`; }
  }

  private async prepare(signal: AbortSignal): Promise<void> {
    // Discover versioned executables independently of the host so the plugin
    // works from a ZIP as well as from the bundled application.
    const home = os.homedir(), discovered: string[] = [];
    for (const root of this.pythonSearch?.frameworkRoots ?? ['/Library/Frameworks/Python.framework/Versions', path.join(home, 'Library/Frameworks/Python.framework/Versions')]) {
      try {
        const versions = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d+\.\d+$/.test(entry.name))
          .map(entry => entry.name).sort().reverse().slice(0, 12);
        for (const version of versions) discovered.push(path.join(root, version, 'bin'));
      } catch {}
    }
    const venv = process.env.VIRTUAL_ENV;
    const inherited = (process.env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir)).slice(0, 64);
    const directories = [...new Set([
      ...(venv && path.isAbsolute(venv) ? [path.join(venv, 'bin')] : []), ...inherited, ...discovered,
      ...(this.pythonSearch?.standardDirectories ?? ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.pyenv/shims'), '/usr/bin', '/bin']),
    ])];
    const choices = [process.env.ASHUB_RUNTIME_PYTHON, process.env.ASHUB_DESKTOP_PYTHON];
    for (const dir of directories) {
      let versioned: string[] = [];
      try { versioned = fs.readdirSync(dir).filter(name => /^python3\.\d+$/.test(name)).sort().reverse().slice(0, 64); } catch {}
      for (const name of ['python3.12', 'python3', 'python', ...versioned]) {
        const candidate = path.join(dir, name);
        try { fs.accessSync(candidate, fs.constants.X_OK); choices.push(candidate); } catch {}
      }
    }
    // Keep legacy command lookup for non-absolute PATH entries.
    if (this.pythonSearch?.commandFallback !== false) choices.push('python3.12', 'python3');
    let python = '';
    const failures: string[] = [];
    for (const candidate of new Set(choices)) {
      if (!candidate) continue;
      signal.throwIfAborted();
      try {
        await execute(candidate, ['-I', '-B', '-c', checkVersion], { timeout: 5000, signal });
        python = candidate;
        break;
      } catch (error) { failures.push(`${candidate}: ${detail(error)}`); }
    }
    if (!python) throw Error(`Python 3.12+ is required. Install Python, then retry. ${failures.slice(0, 3).join('; ')}`.trim());

    const stage = this.directory + '.install-' + randomUUID();
    fs.mkdirSync(path.dirname(stage), { recursive: true, mode: 0o700 });
    try {
      try {
        await execute(python, ['-I', '-B', '-m', 'venv', '--copies', stage], { signal, timeout: 60_000, maxBuffer: 1024 * 1024 });
      } catch (error) { throw Error(`Cannot create an isolated Python environment; check venv/ensurepip support. ${detail(error)}`); }
      const executable = path.join(stage, 'bin', 'python3');
      try {
        await execute(executable, ['-I', '-B', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', `arc-cua[macos] @ https://github.com/shhivv/arc-cua/archive/${ARC_REVISION}.tar.gz`], { signal, timeout: 600_000, maxBuffer: 2 * 1024 * 1024 });
      } catch (error) { throw Error(`Desktop component download or pip installation failed; check network/proxy access and Python compatibility. ${detail(error)}`); }
      try {
        await execute(executable, ['-I', '-B', '-c', `${checkVersion}; ${checkModules}`], { timeout: 30_000, signal });
      } catch (error) { throw Error(`Desktop component validation failed while importing runtime modules. ${detail(error)}`); }
      signal.throwIfAborted();
      fs.writeFileSync(path.join(stage, '.complete'), ARC_REVISION, { mode: 0o600 });

      await this.withLock(signal, async () => {
        if (this.installed && (await this.checkHealth(signal)).healthy) return;
        signal.throwIfAborted();
        const backup = this.directory + '.backup-' + randomUUID();
        const replacing = fs.existsSync(this.directory);
        if (replacing) fs.renameSync(this.directory, backup);
        try { fs.renameSync(stage, this.directory); }
        catch (error) {
          if (replacing && !fs.existsSync(this.directory)) fs.renameSync(backup, this.directory);
          throw error;
        }
        if (replacing) this.removeRuntimeContent(backup, 'Runtime replaced, but an old backup could not be removed');
        this.cleanupStale();
      });
    } finally {
      this.removeRuntimeContent(stage, 'Runtime staging content could not be removed');
    }
  }
}
