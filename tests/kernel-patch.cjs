const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { apply } = require('../scripts/patch-agent-sh.cjs');
const { apply: applyHunks } = require('../scripts/patch-kernel-hunks.cjs');
const patch = require('../scripts/patches/codex-windows-login.json');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-kernel-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of patch.files) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `// unrelated code\n${file.before}\n`);
  }
  return root;
}
test('patch updates source and compiled runtime, preserving unrelated code and remaining idempotent', t => {
  const root = fixture(t);
  assert.equal(apply(root), 2);
  for (const file of patch.files) assert.equal(fs.readFileSync(path.join(root, file.path), 'utf8'), `// unrelated code\n${file.after}\n`);
  assert.equal(apply(root), 0);
});
test('unknown runtime fails before modifying the source', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, patch.files[1].path), 'unknown upstream code');
  assert.throws(() => apply(root), /review the kernel update/);
  assert.equal(fs.readFileSync(path.join(root, patch.files[0].path), 'utf8'), `// unrelated code\n${patch.files[0].before}\n`);
});
test('partial prior patch can be completed safely', t => {
  const root = fixture(t);
  const file = patch.files[0];
  fs.writeFileSync(path.join(root, file.path), file.after);
  assert.equal(apply(root), 1);
  assert.equal(apply(root), 0);
});

test('subagent retry patch validates every target before writing and is idempotent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-kernel-retry-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = require('../scripts/patches/subagent-request-retry.json');
  const originals = spec.files.map(({ path: relative, hunks }) => {
    const file = path.join(root, relative);
    const source = hunks.map(({ before }) => before).join('\n// unrelated code\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return { file, source };
  });
  const last = originals.at(-1);
  fs.writeFileSync(last.file, 'unknown upstream code');
  const retryPatch = () => applyHunks(root, spec, 'subagent request retry');
  assert.throws(retryPatch, /review the kernel update/);
  for (const { file, source } of originals.slice(0, -1)) assert.equal(fs.readFileSync(file, 'utf8'), source);
  fs.writeFileSync(last.file, last.source);
  assert.equal(retryPatch(), originals.length);
  assert.equal(retryPatch(), 0);
});
