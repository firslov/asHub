const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function dependencyFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-dependency-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.copyFileSync(path.join(__dirname, '../scripts/check-deps.cjs'), path.join(root, 'scripts/check-deps.cjs'));
  const write = (file, value) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
  };
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/check-deps.cjs')], { encoding: 'utf8' });
  return { root, write, run };
}

test('dependency check rejects stale Git installs even when the package version matches', (t) => {
  const { write, run } = dependencyFixture(t);
  const commit = 'a'.repeat(40);
  const spec = `git+https://github.com/guanyilun/agent-sh.git#${commit}`;
  write('package.json', { dependencies: { 'agent-sh': spec } });
  write('node_modules/agent-sh/package.json', { version: '0.15.17' });
  assert.equal(run().status, 1, 'no installed commit record');
  write('node_modules/.package-lock.json', { packages: { 'node_modules/agent-sh': { resolved: spec.replace(commit, 'b'.repeat(40)) } } });
  assert.equal(run().status, 1, 'different commit with the same version');
  write('node_modules/.package-lock.json', { packages: { 'node_modules/agent-sh': { resolved: spec } } });
  assert.equal(run().status, 0, 'matching commit');
  write('package.json', { dependencies: { 'agent-sh': `github:guanyilun/agent-sh#${commit}` } });
  assert.equal(run().status, 0, 'npm-normalized GitHub shorthand');
  write('node_modules/.package-lock.json', { packages: {} });
  assert.equal(run().status, 1, 'GitHub shorthand must also reject an unrecorded install');
  write('package.json', { dependencies: { 'agent-sh': '0.15.18' } });
  assert.equal(run().status, 1, 'exact npm version remains checked');
  write('node_modules/agent-sh/package.json', { version: '0.15.18' });
  assert.equal(run().status, 0);
});

test('dependency check catches an omitted TypeScript package or missing npm launcher', (t) => {
  const { root, write, run } = dependencyFixture(t);
  write('package.json', { devDependencies: { typescript: '^6.0.3' } });

  const missingPackage = run();
  assert.equal(missingPackage.status, 1);
  assert.match(missingPackage.stderr, /typescript: not installed/);
  assert.match(missingPackage.stderr, /npm ci --include=dev --bin-links/);

  write('node_modules/typescript/package.json', { version: '6.0.3' });
  const missingLauncher = run();
  assert.equal(missingLauncher.status, 1);
  assert.match(missingLauncher.stderr, /typescript: .*tsc/);

  const bin = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(bin);
  const launcher = path.join(bin, process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  fs.writeFileSync(launcher, '', { mode: 0o755 });
  assert.equal(run().status, 0);
});

test('TypeScript launcher must resolve to an executable file, not a directory', t => {
  const {root,write,run}=dependencyFixture(t);
  write('package.json',{devDependencies:{typescript:'^6.0.3'}});
  write('node_modules/typescript/package.json',{version:'6.0.3'});
  const bin=path.join(root,'node_modules','.bin');fs.mkdirSync(bin);
  const launcher=path.join(bin,process.platform==='win32'?'tsc.cmd':'tsc');
  fs.mkdirSync(launcher);
  assert.equal(run().status,1,'an executable directory is not a TypeScript launcher');
  fs.rmSync(launcher,{recursive:true});
  const target=path.join(root,'node_modules','typescript','launcher');fs.writeFileSync(target,'',{mode:0o755});
  if(process.platform==='win32')fs.copyFileSync(target,launcher);else fs.symlinkSync(target,launcher);
  assert.equal(run().status,0,'a symlink to an executable file is valid');
});
