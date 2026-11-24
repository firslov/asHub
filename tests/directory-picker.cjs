const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { env, Res } = require('./harness.cjs');

function picker(execFile) {
  const e = env({ modules: { 'node:child_process': { ...childProcess, execFile } } });
  return e.load('src/hub.ts', 'export const audit = { pickDir };').audit.pickDir;
}

test('directory picker reports missing tools instead of a user cancellation', () => {
  const res = new Res();
  picker((command, args, options, callback) => callback(Object.assign(Error('not found'), { code: 'ENOENT' }), '', ''))(res);
  assert.equal(res.statusCode, 500); assert.match(res.json().error, /No directory picker/);
});

test('directory picker preserves timeout errors', () => {
  const res = new Res();
  picker((command, args, options, callback) => callback(Object.assign(Error('timed out'), { code: null, killed: true }), '', ''))(res);
  assert.equal(res.statusCode, 500); assert.match(res.json().error, /timed out/);
});

test('directory picker only treats an explicit empty-selection exit as cancellation', () => {
  const res = new Res();
  picker((command, args, options, callback) => callback(Object.assign(Error('exit 1'), { code: 1 }), '', ''))(res);
  assert.equal(res.statusCode, 200); assert.equal(res.json().cancelled, true);
});
