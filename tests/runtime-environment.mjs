import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { RuntimeEnvironment } from '../dist/services/runtime-environment.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-runtime-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = (name, mode = 0o755) => {
    const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// fixture'); fs.chmodSync(target, mode); return fs.realpathSync(target);
  };
  return { root, file };
}

test('finds npm CLI in a standard Homebrew layout when it is absent from PATH', async t => {
  const f = fixture(t), cli = f.file('homebrew/lib/node_modules/npm/bin/npm-cli.js');
  fs.mkdirSync(path.join(f.root, 'homebrew/bin'), { recursive: true }); fs.symlinkSync(cli, path.join(f.root, 'homebrew/bin/npm'));
  const calls = [], runtime = new RuntimeEnvironment({
    env: { PATH: '/usr/bin' }, platform: 'darwin', homedir: f.root,
    standardDirectories: [path.join(f.root, 'homebrew/bin')], execPath: '/Applications/asHub.app/Contents/MacOS/asHub', nodeVersion: '24.15.0',
    run: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: '12.0.2\n', stderr: '' }; },
  });
  const result = await runtime.probeNpm();
  assert(result.ok, result.detail); assert.equal(result.path, cli); assert.equal(result.version, '12.0.2');
  assert.equal(calls[0].file, '/Applications/asHub.app/Contents/MacOS/asHub'); assert.deepEqual(calls[0].args, [cli, '--version']);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
});

test('reports missing, invalid and non-executable npm CLI explicitly', async t => {
  const f = fixture(t);
  const missing = new RuntimeEnvironment({ env: { PATH: '' }, standardDirectories: [path.join(f.root, 'missing')], run: async () => { throw Error('must not run'); } });
  assert.match((await missing.probeNpm()).detail, /not found/);
  const badOverride = new RuntimeEnvironment({ env: { ASHUB_NPM_CLI: 'relative/npm-cli.js' } });
  assert.match((await badOverride.probeNpm()).detail, /absolute path/);
  const cli = f.file('node_modules/npm/bin/npm-cli.js');
  const incompatible = new RuntimeEnvironment({ env: { ASHUB_NPM_CLI: cli }, nodeVersion: '24.15.0', run: async () => { throw Error('npm requires Node 26'); } });
  const result = await incompatible.probeNpm(); assert(!result.ok); assert.match(result.detail, /Node 24\.15\.0.*npm requires Node 26/);
});

test('npm discovery skips an incompatible earlier CLI and a foreign package-manager hint', async t => {
  const f = fixture(t);
  const first = f.file('first/node_modules/npm/bin/npm-cli.js');
  const second = f.file('second/node_modules/npm/bin/npm-cli.js');
  const foreign = f.file('pnpm.cjs'), attempted = [];
  const runtime = new RuntimeEnvironment({
    env: { PATH: [path.join(f.root, 'first'), path.join(f.root, 'second')].join(path.delimiter), npm_execpath: foreign },
    standardDirectories: [],
    run: async (_file, [cli]) => {
      attempted.push(cli);
      if (cli === first) throw Error('incompatible Node');
      return { stdout: '11.6.0', stderr: '' };
    },
  });
  const result = await runtime.probeNpm();
  assert(result.ok, result.detail); assert.equal(result.path, second);
  assert.deepEqual(attempted, [first, second]);
});

test('npm discovery checks its Node engine even when the version command would succeed', async t => {
  const f = fixture(t), attempted = [];
  const first = f.file('first/node_modules/npm/bin/npm-cli.js');
  const second = f.file('second/node_modules/npm/bin/npm-cli.js');
  fs.writeFileSync(path.resolve(path.dirname(first), '..', 'package.json'), JSON.stringify({ engines: { node: '>=26' } }));
  const runtime = new RuntimeEnvironment({
    env: { PATH: [path.join(f.root, 'first'), path.join(f.root, 'second')].join(path.delimiter) },
    standardDirectories: [], nodeVersion: '24.15.0',
    run: async (_file, [cli]) => { attempted.push(cli); return { stdout: '11.6.0', stderr: '' }; },
  });
  const result = await runtime.probeNpm();
  assert.equal(result.path, second);
  assert.deepEqual(attempted, [second]);
});

test('selects a compatible Python by executing candidates with isolated fixed arguments', async t => {
  const f = fixture(t), oldPython = f.file('old/python3'), newPython = f.file('new/python3'), calls = [];
  const runtime = new RuntimeEnvironment({
    env: { PATH: '' }, standardDirectories: [path.join(f.root, 'old'), path.join(f.root, 'new')],
    run: async (file, args) => {
      calls.push({ file, args }); const version = file === oldPython ? '3.11.9' : '3.12.8';
      return { stdout: JSON.stringify({ version, executable: file }), stderr: '' };
    },
  });
  const result = await runtime.probePython('>=3.12.0');
  assert(result.ok, result.detail); assert.equal(result.path, newPython); assert.equal(result.version, '3.12.8');
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].args.slice(0, 3), ['-I', '-B', '-c']);
  const override = new RuntimeEnvironment({ env: { ASHUB_RUNTIME_PYTHON: 'python3' } });
  assert.match((await override.probePython('>=3.12')).detail, /absolute path/);
});

test('checks Git and macOS versions without a shell', async t => {
  const f = fixture(t), git = f.file('bin/git');
  const runtime = new RuntimeEnvironment({
    env: { PATH: path.join(f.root, 'bin') }, platform: 'darwin', standardDirectories: [],
    run: async (file, args) => file === git ? { stdout: 'git version 2.51.0\n', stderr: '' } : { stdout: '14.4\n', stderr: '' },
  });
  const gitResult = await runtime.probeGit('>=2.50'); assert(gitResult.ok, gitResult.detail); assert.equal(gitResult.path, git);
  const mac = await runtime.probeMacOS('14.0.0'); assert(mac.ok, mac.detail); assert.equal(mac.version, '14.4.0');
  assert(!(await runtime.probeMacOS('14.5.0')).ok);
});

test('Git preflight checks later candidates when the first is too old or fails to start', async t => {
  const f = fixture(t), old = f.file('old/git'), broken = f.file('broken/git'), compatible = f.file('compatible/git');
  const attempted = [];
  const runtime = new RuntimeEnvironment({
    env: { PATH: [old, broken, compatible].map(file => path.dirname(file)).join(path.delimiter) },
    standardDirectories: [],
    run: async file => {
      attempted.push(file);
      if (file === broken) throw Error('cannot start Git');
      return { stdout: file === old ? 'git version 2.43.0' : 'git version 2.51.0', stderr: '' };
    },
  });
  const result = await runtime.probeGit('>=2.50');
  assert(result.ok, result.detail); assert.equal(result.path, compatible);
  assert.deepEqual(attempted, [old, broken, compatible]);
});

test('child environments add standard executable locations after explicit PATH without changing the parent', t => {
  const f = fixture(t), custom = path.join(f.root, 'custom'), standard = path.join(f.root, 'standard');
  const parent = { Path: custom, KEEP: 'yes' };
  const runtime = new RuntimeEnvironment({env:parent,platform:'win32',standardDirectories:[standard,custom]});
  const child = runtime.commandEnvironment();
  assert.equal(child.Path,[custom,standard].join(path.delimiter));
  assert.equal(child.KEEP,'yes');assert.equal(child.PATH,undefined);assert.equal(parent.Path,custom);
  const duplicate = { Path:custom, PATH:path.join(f.root, 'effective') };
  const merged = new RuntimeEnvironment({env:duplicate,platform:'win32',standardDirectories:[standard]}).commandEnvironment();
  assert.equal(merged.PATH,[duplicate.PATH,standard].join(path.delimiter));
  assert.equal(merged.Path,undefined);assert.equal(duplicate.Path,custom);
});

test('a script with an env shebang can find its interpreter on the child PATH', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t);
  const interpreter = f.file('standard/ashub-test-interpreter');
  fs.writeFileSync(interpreter, '#!/bin/sh\nprintf "interpreter reached"\n');
  const command = f.file('bin/launcher');
  fs.writeFileSync(command, '#!/usr/bin/env ashub-test-interpreter\n');
  const runtime = new RuntimeEnvironment({env:{PATH:'/usr/bin:/bin'},standardDirectories:[path.dirname(interpreter)]});
  assert.equal(execFileSync(command,{env:runtime.commandEnvironment(),encoding:'utf8'}),'interpreter reached');
});

test('preserves a venv Python launcher symlink instead of replacing its environment', async t => {
  const f = fixture(t), base = f.file('base/python3'), launcher = path.join(f.root, 'venv/bin/python');
  fs.mkdirSync(path.dirname(launcher), { recursive: true }); fs.symlinkSync(base, launcher);
  const runtime = new RuntimeEnvironment({ env: { ASHUB_RUNTIME_PYTHON: launcher }, run: async file => ({ stdout: JSON.stringify({ version: '3.12.8', executable: file }), stderr: '' }) });
  const result = await runtime.probePython('>=3.12'); assert(result.ok, result.detail); assert.equal(result.path, launcher); assert.notEqual(result.path, base);
});

test('discovers a per-user Python.org installation on Windows without inherited PATH', async t => {
  const f = fixture(t), python = path.join(f.root, 'local/Programs/Python/Python312/python.exe'); f.file('local/Programs/Python/Python312/python.exe');
  const runtime = new RuntimeEnvironment({
    env: { LOCALAPPDATA: path.join(f.root, 'local'), Path: '' }, platform: 'win32', standardDirectories: [],
    run: async file => ({ stdout: JSON.stringify({ version: '3.12.8', executable: file }), stderr: '' }),
  });
  const result = await runtime.probePython('>=3.12'); assert(result.ok, result.detail); assert.equal(result.path, python);
});

test('Python uses the active virtual environment before installed global interpreters', async t => {
  const f = fixture(t), global = f.file('local/Programs/Python/Python312/python.exe');
  const environment = path.join(f.root, 'venv'), launcher = f.file('venv/Scripts/python.exe');
  const attempted = [];
  const runtime = new RuntimeEnvironment({
    env: { LOCALAPPDATA: path.join(f.root, 'local'), VIRTUAL_ENV: environment, Path: path.dirname(global) },
    platform: 'win32', standardDirectories: [],
    run: async file => { attempted.push(file); return { stdout: JSON.stringify({ version: '3.12.8' }), stderr: '' }; },
  });
  const result = await runtime.probePython('>=3.12');
  assert(result.ok, result.detail); assert.equal(result.path, launcher);
  assert.deepEqual(attempted, [launcher]);
});

test('discovers versioned Python launchers when the default interpreter is incompatible', async t => {
  const f=fixture(t), newer=f.file('bin/python3.13'), older=f.file('bin/python3'), calls=[];
  const runtime=new RuntimeEnvironment({platform:'linux',env:{PATH:path.dirname(older)},standardDirectories:[],run:async file=>{
    calls.push(file);return {stdout:JSON.stringify({version:file===newer?'3.13.7':'3.12.3'}),stderr:''};
  }});
  const result=await runtime.probePython('>=3.13');
  assert.equal(result.ok,true,result.detail);assert.equal(result.path,newer);assert(calls.includes(newer));
});
test('Windows git resolution skips cmd shims for direct execFile and agrees with Git preflight', async t => {
  const f=fixture(t), shim=f.file('shim/git.cmd'), native=f.file('standard/git.exe');
  const runtime=new RuntimeEnvironment({platform:'win32',env:{Path:path.dirname(shim)},standardDirectories:[path.dirname(native)],run:async()=>({stdout:'git version 2.50.1.windows.1',stderr:''})});
  assert.equal(runtime.resolveCommand('git'),native);
  assert.equal((await runtime.probeGit()).path,native);
});

test('an active native Git probe is cancelled rather than waiting for its timeout', {skip:process.platform==='win32'}, async t=>{
  const f=fixture(t),git=f.file('bin/git');fs.writeFileSync(git,'#!/bin/sh\nexec /bin/sleep 30\n',{mode:0o755});
  const runtime=new RuntimeEnvironment({env:{PATH:path.dirname(git)},standardDirectories:[]});
  const controller=new AbortController(),pending=runtime.probeGit('*',controller.signal);
  setTimeout(()=>controller.abort(),30);
  await assert.rejects(pending,e=>e.name==='AbortError');
});
