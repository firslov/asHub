import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DesktopRuntime } from '../dist/runtime.js';
import { DesktopService } from '../dist/service.js';

function fixture(t, { broken = false, failPip = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-runtime-health-'));
  const settings = path.join(dir, 'settings.json');
  const runtime = new DesktopRuntime(settings, 'darwin');
  const target = path.dirname(path.dirname(runtime.python));
  const log = path.join(dir, 'invocations');
  const selectedPython = path.join(dir, 'selected-python');
  fs.writeFileSync(settings, '{}');
  fs.mkdirSync(path.dirname(runtime.python), { recursive: true });
  fs.writeFileSync(path.join(target, '.complete'), runtime.state.revision);
  fs.writeFileSync(selectedPython, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const mode = args.includes('venv') ? 'venv' : args.includes('pip') ? 'pip' :
  args.some(arg => arg.includes('import arc_cua')) ? 'health' : 'version';
fs.appendFileSync(${JSON.stringify(log)}, mode + '\\n');
if (mode === 'venv') {
  const bin = path.join(args.at(-1), 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(__filename, path.join(bin, 'python3'));
}
if (mode === 'pip' && ${failPip}) { console.error('simulated pip failure'); process.exitCode = 1; }
`, { mode: 0o700 });
  if (broken) {
    fs.writeFileSync(runtime.python, `#!${process.execPath}
console.error('simulated missing module');
process.exit(9);
`, { mode: 0o700 });
  } else {
    fs.copyFileSync(selectedPython, runtime.python);
  }

  const previous = process.env.ASHUB_RUNTIME_PYTHON;
  process.env.ASHUB_RUNTIME_PYTHON = selectedPython;
  t.after(async () => {
    await runtime.close();
    if (previous === undefined) delete process.env.ASHUB_RUNTIME_PYTHON;
    else process.env.ASHUB_RUNTIME_PYTHON = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { settings, runtime, target, commands: () => fs.readFileSync(log, 'utf8').trim().split('\n') };
}

const posix = { skip: process.platform === 'win32' };

test('retains a healthy installed runtime and skips venv and pip', posix, async t => {
  const { runtime, commands } = fixture(t);
  assert.equal((await runtime.ensureInstalled()).healthy, true);
  assert.deepEqual(commands(), ['health']);
});

test('status diagnoses a damaged runtime without starting the desktop driver', posix, async t => {
  const { settings } = fixture(t, { broken: true });
  const service = new DesktopService(settings, { platform: 'darwin' });
  t.after(() => service.close());
  const state = await service.status(true);
  assert.equal(state.installed, true);
  assert.equal(state.healthy, false);
  assert.match(state.healthError, /simulated missing module/);
  assert.equal(state.driverError, undefined);
});

test('repairs a completed but damaged runtime with the host-selected Python', posix, async t => {
  const { runtime, target, commands } = fixture(t, { broken: true });
  const result = await runtime.ensureInstalled();
  assert.equal(result.healthy, true);
  assert.equal(result.installError, '');
  assert.deepEqual(commands(), ['version', 'venv', 'pip', 'health', 'health']);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
});

test('a failed repair preserves the old runtime and reports the failure', posix, async t => {
  const { runtime, target, commands } = fixture(t, { broken: true, failPip: true });
  const original = fs.readFileSync(runtime.python);
  const result = await runtime.ensureInstalled();
  assert.equal(result.healthy, false);
  assert.match(result.installError, /simulated pip failure/);
  assert.deepEqual(commands(), ['version', 'venv', 'pip']);
  assert.deepEqual(fs.readFileSync(runtime.python), original);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
});

test('discovers a versioned PATH Python, probes its actual version, and never runs real pip', posix, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-versioned-python-'));
  const bin = path.join(dir, 'bin'), log = path.join(dir, 'calls');
  fs.mkdirSync(bin);
  const makePython = (name, valid) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path'), args=process.argv.slice(2);
const mode=args.includes('venv')?'venv':args.includes('pip')?'pip':args.some(a=>a.includes('import arc_cua'))?'health':'version';
fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(name)}+':'+mode+'\\n');
if(mode==='version' && !${valid}) process.exit(1);
if(mode==='venv'){const out=path.join(args.at(-1),'bin');fs.mkdirSync(out,{recursive:true});fs.copyFileSync(__filename,path.join(out,'python3'));}
`, { mode: 0o700 });
  makePython('python3.99', false);
  makePython('python3.14', true);
  const saved = Object.fromEntries(['PATH','HOME','VIRTUAL_ENV','ASHUB_RUNTIME_PYTHON','ASHUB_DESKTOP_PYTHON'].map(key=>[key,process.env[key]]));
  process.env.PATH=bin;process.env.HOME=dir;delete process.env.VIRTUAL_ENV;delete process.env.ASHUB_RUNTIME_PYTHON;delete process.env.ASHUB_DESKTOP_PYTHON;
  const runtime=new DesktopRuntime(path.join(dir,'settings.json'),'darwin',{standardDirectories:[],frameworkRoots:[],commandFallback:false});
  t.after(async()=>{await runtime.close();for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}fs.rmSync(dir,{recursive:true,force:true});});
  const result=await runtime.ensureInstalled();
  assert.equal(result.healthy,true,result.installError);
  assert.deepEqual(fs.readFileSync(log,'utf8').trim().split('\n'),['python3.99:version','python3.14:version','python3.14:venv','python3.14:pip','python3.14:health','python3.14:health']);
});


test('host-selected Python takes precedence over legacy override and discovered paths', posix, async t => {
  const { runtime, commands } = fixture(t, { broken: true });
  const previous=process.env.ASHUB_DESKTOP_PYTHON;
  process.env.ASHUB_DESKTOP_PYTHON='/nonexistent-ashub-audit-legacy-python';
  t.after(()=>{if(previous===undefined)delete process.env.ASHUB_DESKTOP_PYTHON;else process.env.ASHUB_DESKTOP_PYTHON=previous;});
  assert.equal((await runtime.ensureInstalled()).healthy,true);
  assert.deepEqual(commands(),['version','venv','pip','health','health']);
});

test('legacy Python override is used before discovery when host override is absent', posix, async t => {
  const { runtime, commands } = fixture(t, { broken: true });
  const selected=process.env.ASHUB_RUNTIME_PYTHON, previous=process.env.ASHUB_DESKTOP_PYTHON;
  delete process.env.ASHUB_RUNTIME_PYTHON;process.env.ASHUB_DESKTOP_PYTHON=selected;
  t.after(()=>{if(previous===undefined)delete process.env.ASHUB_DESKTOP_PYTHON;else process.env.ASHUB_DESKTOP_PYTHON=previous;});
  assert.equal((await runtime.ensureInstalled()).healthy,true);
  assert.deepEqual(commands(),['version','venv','pip','health','health']);
});
