import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { satisfies, valid, validRange } from 'semver';

export interface RuntimeProbe {
  kind: 'npm' | 'python' | 'git' | 'macos';
  ok: boolean;
  path?: string;
  version?: string;
  detail: string;
  searched?: string[];
}
export interface RuntimeEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  homedir?: string;
  standardDirectories?: string[];
  execPath?: string;
  nodeVersion?: string;
  run?: RuntimeRunner;
}
export interface RuntimeRunOptions { env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number; signal?: AbortSignal }
export type RuntimeRunner = (file: string, args: string[], options?: RuntimeRunOptions) => Promise<{ stdout: string; stderr: string }>;
export interface RuntimeProvider {
  probeNpm(signal?: AbortSignal): Promise<RuntimeProbe>;
  probePython(range: string, signal?: AbortSignal): Promise<RuntimeProbe>;
  probeGit(range?: string, signal?: AbortSignal): Promise<RuntimeProbe>;
  probeMacOS(minimum?: string, signal?: AbortSignal): Promise<RuntimeProbe>;
  resolveCommand(command: string): string | undefined;
}

const run: RuntimeRunner = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, {
    env: options.env ?? process.env, timeout: options.timeout ?? 5_000,
    maxBuffer: options.maxBuffer ?? 64 * 1024, windowsHide: true, signal: options.signal,
  }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr }));
});
const absolute = (value: unknown) => typeof value === 'string' && !!value && path.isAbsolute(value);
const unique = <T,>(values: T[]) => [...new Set(values)];
const cleanError = (error: unknown) => {
  const e = error as { stderr?: string; message?: string };
  return String(e.stderr || e.message || error).trim().split(/\r?\n/).slice(-3).join(' | ').slice(-600);
};
function pathKey(env: NodeJS.ProcessEnv, platform: string) {
  if (platform !== 'win32') return 'PATH';
  // Follow Node's child-process precedence for duplicate Windows env keys.
  return Object.keys(env).filter(key => key.toLowerCase() === 'path').sort()[0] ?? 'Path';
}
function realFile(file: string) {
  try { const real = fs.realpathSync(file); return fs.statSync(real).isFile() ? real : undefined; } catch { return undefined; }
}
function executable(file: string, platform: string) {
  const real = realFile(file);
  if (!real) return undefined;
  if (platform !== 'win32') { try { fs.accessSync(real, fs.constants.X_OK); } catch { return undefined; } }
  return real;
}
function versionSatisfies(actual: string, range?: string) {
  return !range || (!!valid(actual) && !!validRange(range) && satisfies(actual, range));
}
function npmNodeRange(cli: string): string | undefined {
  try {
    const range = JSON.parse(fs.readFileSync(path.resolve(path.dirname(cli), '..', 'package.json'), 'utf8'))?.engines?.node;
    return typeof range === 'string' ? range : undefined;
  } catch { return undefined; }
}

/** External tool discovery without changing the application-wide PATH. */
export class RuntimeEnvironment implements RuntimeProvider {
  private env: NodeJS.ProcessEnv;
  private platform: string;
  private arch: string;
  private home: string;
  private standardDirectories?: string[];
  private execPath: string;
  private nodeVersion: string;
  private run: RuntimeRunner;
  constructor(options: RuntimeEnvironmentOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.home = options.homedir ?? os.homedir();
    this.standardDirectories = options.standardDirectories;
    this.execPath = options.execPath ?? process.execPath;
    this.nodeVersion = options.nodeVersion ?? process.versions.node;
    this.run = options.run ?? run;
  }
  private directories(extra: string[] = [], discovered: string[] = []) {
    const key = pathKey(this.env, this.platform), inherited = (this.env[key] ?? '').split(path.delimiter).filter(absolute);
    const home = this.home;
    let standard: string[];
    if (this.standardDirectories) standard = this.standardDirectories;
    else if (this.platform === 'darwin') standard = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.pyenv/shims'), '/usr/bin', '/bin'];
    else if (this.platform === 'win32') standard = [this.env.ProgramW6432, this.env.ProgramFiles, this.env.LOCALAPPDATA && path.join(this.env.LOCALAPPDATA, 'Programs')].filter(Boolean).flatMap(root => [path.join(root!, 'nodejs'), path.join(root!, 'Git/cmd'), path.join(root!, 'Git/bin')]);
    else standard = ['/usr/local/bin', path.join(home, '.local/bin'), path.join(home, '.pyenv/shims'), '/usr/bin', '/bin'];
    return unique([...extra, ...inherited, ...discovered, ...standard].filter(absolute).map(dir => path.normalize(dir)));
  }
  private npmCandidates() {
    const override = this.env.ASHUB_NPM_CLI;
    if (override) {
      if (!absolute(override)) return { paths: [], error: `npm CLI override is not an absolute path: ${override}`, searched: [override] };
      const real = realFile(override);
      if (!real || !real.toLowerCase().endsWith('npm-cli.js')) return { paths: [], error: `npm CLI override is not a readable npm-cli.js: ${override}`, searched: [override] };
      return { paths: [real], searched: [override] };
    }
    const inheritedHint = this.env.npm_execpath;
    const searched = [
      ...(absolute(inheritedHint) ? [inheritedHint!] : []),
      ...this.directories().flatMap(dir => [
        path.join(dir, 'node_modules/npm/bin/npm-cli.js'), path.join(dir, '../lib/node_modules/npm/bin/npm-cli.js'), path.join(dir, 'npm'),
      ]),
    ];
    const paths = unique(searched.map(realFile).filter((file): file is string => !!file && file.toLowerCase().endsWith('npm-cli.js')));
    return { paths, searched };
  }
  async probeNpm(signal?: AbortSignal): Promise<RuntimeProbe> {
    signal?.throwIfAborted();
    const found = this.npmCandidates();
    if (!found.paths.length) return { kind: 'npm', ok: false, detail: found.error ?? 'npm CLI was not found in PATH or standard installation locations', searched: found.searched };
    const env = { ...this.commandEnvironment(), ELECTRON_RUN_AS_NODE: '1' };
    const failures: string[] = [];
    for (const candidate of found.paths) {
      try {
        const requiredNode = npmNodeRange(candidate);
        if (!versionSatisfies(this.nodeVersion, requiredNode)) throw Error(`npm requires Node ${requiredNode}`);
        const { stdout } = await this.run(this.execPath, [candidate, '--version'], { env, signal });
        signal?.throwIfAborted();
        const version = stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? '';
        if (!valid(version)) throw Error(`Unrecognised npm version: ${version || '(empty)'}`);
        return { kind: 'npm', ok: true, path: candidate, version, detail: `npm ${version} (${candidate}); Node ${this.nodeVersion}` };
      } catch (error) {
        signal?.throwIfAborted();
        failures.push(`npm CLI at ${candidate} cannot run with Node ${this.nodeVersion}: ${cleanError(error)}`);
      }
    }
    return { kind: 'npm', ok: false, path: found.paths[0], detail: failures.slice(0, 3).join('; '), searched: found.searched };
  }
  private commandCandidates(command: string) {
    const names = this.platform === 'win32' && !/\.(?:exe|cmd|bat)$/i.test(command) ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command] : [command];
    return this.directories().flatMap(dir => names.map(name => path.join(dir, name)));
  }
  commandEnvironment(): NodeJS.ProcessEnv {
    const key = pathKey(this.env, this.platform);
    const inherited = this.env[key] ? this.env[key]!.split(path.delimiter) : [];
    const alreadyPresent = new Set(inherited.filter(absolute).map(dir => path.normalize(dir)));
    const extra = this.directories().filter(dir => !alreadyPresent.has(dir));
    const child = { ...this.env, [key]: [...inherited, ...extra].join(path.delimiter) };
    if (this.platform === 'win32') {
      for (const alias of Object.keys(child)) if (alias !== key && alias.toLowerCase() === 'path') delete child[alias];
    }
    return child;
  }
  resolveCommand(command: string) {
    if (absolute(command)) return executable(command, this.platform);
    if (command.includes('/') || command.includes('\\')) return undefined;
    // execFile cannot execute Windows batch wrappers without a shell. Git
    // callers use direct execFile; choose the same native executable as preflight.
    const name = this.platform === 'win32' && command.toLowerCase() === 'git' ? 'git.exe' : command;
    for (const candidate of this.commandCandidates(name)) { const found = executable(candidate, this.platform); if (found) return found; }
    return undefined;
  }
  private pythonCandidates() {
    const override = this.env.ASHUB_RUNTIME_PYTHON || this.env.ASHUB_DESKTOP_PYTHON;
    if (override) return { override, candidates: [override], searched: [override] };
    const discovered: string[] = [];
    if (this.platform === 'darwin') {
      for (const root of ['/Library/Frameworks/Python.framework/Versions', path.join(this.home, 'Library/Frameworks/Python.framework/Versions')]) {
        try {
          const versions = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d+\.\d+$/.test(entry.name)).map(entry => entry.name).sort().reverse().slice(0, 12);
          for (const version of versions) discovered.push(path.join(root, version, 'bin'));
        } catch {}
      }
    } else if (this.platform === 'win32') {
      const roots = [this.env.LOCALAPPDATA && path.join(this.env.LOCALAPPDATA, 'Programs/Python'),
        this.env.ProgramW6432 && path.join(this.env.ProgramW6432, 'Python'), this.env.ProgramFiles && path.join(this.env.ProgramFiles, 'Python')].filter(Boolean);
      for (const root of roots) {
        let versions = ['Python314', 'Python313', 'Python312'];
        try {
          versions = [...new Set([...versions, ...fs.readdirSync(root!, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^Python\d{3}$/.test(entry.name)).map(entry => entry.name)])].sort().reverse().slice(0, 12);
        } catch {}
        for (const version of versions) discovered.push(path.join(root!, version));
      }
    }
    const venv = this.env.VIRTUAL_ENV;
    const dirs = this.directories(venv && absolute(venv) ? [path.join(venv, this.platform === 'win32' ? 'Scripts' : 'bin')] : [], discovered);
    const names = this.platform === 'win32' ? ['python3.12.exe', 'python3.exe', 'python.exe'] : ['python3.12', 'python3', 'python'];
    const candidates = unique(dirs.filter(absolute).flatMap(dir => {
      // Distribution packages may expose only python3.N alongside an older
      // python3. Discover bounded versioned names, then probe their real version.
      let versioned: string[] = [];
      try { versioned = fs.readdirSync(dir).filter(name => this.platform === 'win32' ? /^python3\.\d+\.exe$/i.test(name) : /^python3\.\d+$/.test(name)).sort().reverse().slice(0, 64); } catch {}
      return [...names, ...versioned].map(name => path.join(dir, name));
    }));
    return { candidates, searched: candidates };
  }
  async probePython(range: string, signal?: AbortSignal): Promise<RuntimeProbe> {
    signal?.throwIfAborted();
    if (!validRange(range)) return { kind: 'python', ok: false, detail: `Invalid Python version requirement: ${range}` };
    const found = this.pythonCandidates(), failures: string[] = [];
    if (found.override && !absolute(found.override)) return { kind: 'python', ok: false, detail: `Python override is not an absolute path: ${found.override}`, searched: found.searched };
    const env = this.commandEnvironment();
    for (const candidate of found.candidates) {
      // Validate the real target, but execute the original absolute path. A venv
      // launcher is commonly a symlink and must retain its environment prefix.
      const launch = executable(candidate, this.platform) ? candidate : undefined;
      if (!launch) continue;
      try {
        const script = 'import json,sys;print(json.dumps({"version":".".join(map(str,sys.version_info[:3])),"executable":sys.executable}))';
        const { stdout } = await this.run(launch, ['-I', '-B', '-c', script], { env, signal });
        signal?.throwIfAborted();
        const data = JSON.parse(stdout.trim());
        if (typeof data.version !== 'string' || !valid(data.version)) throw Error('Unrecognised Python version output');
        if (!versionSatisfies(data.version, range)) { failures.push(`${data.version} at ${candidate}`); continue; }
        return { kind: 'python', ok: true, path: launch, version: data.version, detail: `Python ${data.version} (${launch})`, searched: found.searched };
      } catch (error) { signal?.throwIfAborted(); failures.push(`${candidate}: ${cleanError(error)}`); }
    }
    if (found.override) return { kind: 'python', ok: false, detail: `Configured Python does not satisfy ${range}: ${failures.join('; ') || found.override}`, searched: found.searched };
    const detail = failures.length ? `No Python satisfies ${range}; ${failures.slice(0, 3).join('; ')}` : `Python ${range} was not found in PATH or standard installation locations`;
    return { kind: 'python', ok: false, detail, searched: found.searched };
  }
  async probeGit(range = '*', signal?: AbortSignal): Promise<RuntimeProbe> {
    signal?.throwIfAborted();
    const searched = this.commandCandidates(this.platform === 'win32' ? 'git.exe' : 'git');
    const candidates = unique(searched.map(file => executable(file, this.platform)).filter((file): file is string => !!file));
    const failures: string[] = [], env = this.commandEnvironment();
    for (const candidate of candidates) {
      try {
        const { stdout } = await this.run(candidate, ['--version'], { env, signal });
        signal?.throwIfAborted();
        const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? '';
        if (!valid(version)) throw Error(`Unrecognised Git version: ${stdout.trim()}`);
        if (!versionSatisfies(version, range)) {
          failures.push(`Git ${version} at ${candidate} does not satisfy ${range}`);
          continue;
        }
        return { kind: 'git', ok: true, path: candidate, version, detail: `Git ${version} (${candidate})` };
      } catch (error) { signal?.throwIfAborted(); failures.push(`Git at ${candidate} could not run: ${cleanError(error)}`); }
    }
    const detail = failures.length ? failures.slice(0, 3).join('; ') : 'Git was not found in PATH or standard installation locations';
    return { kind: 'git', ok: false, detail, searched };
  }
  async probeMacOS(minimum = '0.0.0', signal?: AbortSignal): Promise<RuntimeProbe> {
    signal?.throwIfAborted();
    if (this.platform !== 'darwin') return { kind: 'macos', ok: true, detail: 'Not required on this platform' };
    const file = '/usr/bin/sw_vers';
    try {
      const { stdout } = await this.run(file, ['-productVersion'], { env: this.env, signal });
      signal?.throwIfAborted();
      const reported = stdout.trim(), version = /^\d+\.\d+$/.test(reported) ? `${reported}.0` : reported;
      if (!valid(version)) throw Error(`Unrecognised macOS version: ${reported}`);
      return { kind: 'macos', ok: versionSatisfies(version, `>=${minimum}`), version, detail: `macOS ${version} / >=${minimum}` };
    } catch (error) { signal?.throwIfAborted(); return { kind: 'macos', ok: false, detail: `Cannot determine macOS version: ${cleanError(error)}` }; }
  }
}
