const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function install(t, { builder, nodeEnv, patchStatus = 0, builderStatus = 0 } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub postinstall-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'app');
  const log = path.join(sandbox, 'events.jsonl');
  const write = (relative, contents) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  const entry = /^node (scripts\/postinstall\.cjs)$/.exec(require('../package.json').scripts.postinstall);
  assert(entry, 'npm postinstall should launch the shell-free Node entry');
  write(entry[1], fs.readFileSync(path.join(__dirname, '..', entry[1]), 'utf8'));
  const report = name => `require('node:fs').appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({
    name: ${JSON.stringify(name)}, cwd: process.cwd(), args: process.argv.slice(2), execPath: process.execPath,
  }) + '\\n');`;
  write('scripts/patch-agent-sh.cjs', `${report('patch')} process.exit(${patchStatus});`);
  // A CLI installer must not run an unrelated packaging tool from the consuming project.
  write('../node_modules/electron-builder/package.json', JSON.stringify({ bin: { 'electron-builder': './wrong.cjs' } }));
  write('../node_modules/electron-builder/wrong.cjs', `${report('ancestor builder')} process.exit(47);`);
  if (builder) {
    const base = 'node_modules/electron-builder';
    write(`${base}/package.json`, JSON.stringify({ bin: { 'electron-builder': './tools/mock cli.cjs' } }));
    if (builder !== 'broken') write(`${base}/tools/mock cli.cjs`, `${report('builder')} process.exit(${builderStatus});`);
  }

  const env = { FIXTURE_LOG: log, SystemRoot: process.env.SystemRoot };
  if (nodeEnv) env.NODE_ENV = nodeEnv;
  const result = spawnSync(process.execPath, [path.join(root, entry[1])], {
    cwd: sandbox, env, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  return { ...result, root: fs.realpathSync(root), events: fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
}

test('production and CLI consumer installs run patches without a locally installed builder', async t => {
  for (const nodeEnv of ['production', undefined]) {
    await t.test(nodeEnv || 'consumer without NODE_ENV', subtest => {
      const { status, stderr, events } = install(subtest, { nodeEnv });
      assert.equal(status, 0, stderr);
      assert.deepEqual(events.map(event => event.name), ['patch']);
    });
  }
});

test('development installs run the packaged builder CLI after patches without shell shims', t => {
  // npm can include devDependencies even when NODE_ENV is explicitly production.
  const { status, stderr, root, events } = install(t, { builder: 'installed', nodeEnv: 'production' });
  assert.equal(status, 0, stderr);
  assert.deepEqual(events.map(({ name, cwd, args, execPath }) => ({ name, cwd: fs.realpathSync(cwd), args, execPath })), [
    { name: 'patch', cwd: root, args: [], execPath: process.execPath },
    { name: 'builder', cwd: root, args: ['install-app-deps'], execPath: process.execPath },
  ]);
});

test('a compatibility patch error is propagated and native rebuild does not run', t => {
  const { status, events } = install(t, { builder: 'installed', patchStatus: 19 });
  assert.equal(status, 19);
  assert.deepEqual(events.map(event => event.name), ['patch']);
});

test('an installed electron-builder nonzero status is propagated', t => {
  const { status, events } = install(t, { builder: 'installed', builderStatus: 31 });
  assert.equal(status, 31);
  assert.deepEqual(events.map(event => event.name), ['patch', 'builder']);
});

test('a present but broken development builder fails rather than being treated as omitted', t => {
  const { status, stderr, events } = install(t, { builder: 'broken' });
  assert.notEqual(status, 0);
  assert.match(stderr, /Cannot find module.*mock cli\.cjs/);
  assert.deepEqual(events.map(event => event.name), ['patch']);
});
