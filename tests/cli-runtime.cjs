const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { satisfies } = require('semver');
const ts = require('typescript');

const requiredNode = '>=22.12.0 <26';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-cli-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, contents) => fs.writeFileSync(path.join(dir, name), contents);
  const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
  write('package.json', '{"type":"module"}');
  const { outputText } = ts.transpileModule(source('src/cli.ts'), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    fileName: 'cli.ts',
  });
  write('cli.js', outputText);
  write('version.cjs', 'Object.defineProperty(process.versions, "node", { value: process.env.FIXTURE_NODE_VERSION });');
  // The only possible startup effects are these local probes, not the real
  // bootstraps, listeners, providers, or network settings.
  write('windows-bootstrap.js', 'console.error("windows-bootstrap");');
  write('network-bootstrap.js', 'console.error("network-bootstrap");');
  write('hub.js', 'console.error("hub-loaded"); export const startHub = () => { console.log("hub started"); return {}; };');
  fs.mkdirSync(path.join(dir, 'bridges'));
  for (const [file, symbol] of [['ash', 'AshBridge'], ['acp', 'AcpBridge'], ['terminal', 'TerminalBridge']]) {
    write(`bridges/${file}.js`, `export class ${symbol} {}`);
  }
  return ({ version, args = ['--help'] } = {}) => {
    const preload = version ? ['--require', path.join(dir, 'version.cjs')] : [];
    const result = spawnSync(process.execPath, [...preload, path.join(dir, 'cli.js'), ...args], {
      cwd: dir,
      env: { FIXTURE_NODE_VERSION: version || '', SystemRoot: process.env.SystemRoot },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(result.error);
    return result;
  };
}

function assertUnsupported(result, version) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert(result.stderr.includes(version), result.stderr);
  assert(result.stderr.includes(requiredNode), result.stderr);
  assert.match(result.stderr, /Node\.js 22 or 24/);
  assert.doesNotMatch(result.stderr, /bootstrap|hub-loaded/);
}

function assertHelp(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Usage:\s*ashub/);
}

test('the package and its lockfile declare the guarded CLI range', () => {
  assert.equal(require('../package.json').engines.node, requiredNode);
  assert.equal(require('../package-lock.json').packages[''].engines.node, requiredNode);
});

test('the CLI refuses versions outside the engine range before bootstrapping, even for help', t => {
  const run = fixture(t);
  for (const version of ['22.11.0', '26.0.0', '27.0.0']) {
    assertUnsupported(run({ version }), version);
  }
  assertUnsupported(run({ version: '26.0.0', args: [] }), '26.0.0');
});

test('help works without starting a hub or loading network configuration', t => {
  const run = fixture(t);
  for (const version of ['22.12.0', '24.22.3']) assertHelp(run({ version }));
});

test('supported startup keeps Windows and network bootstraps ahead of the hub', t => {
  const result = fixture(t)({ version: '22.12.0', args: [] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stderr.trim().split(/\r?\n/), ['windows-bootstrap', 'network-bootstrap', 'hub-loaded']);
  assert.equal(result.stdout.trim(), 'hub started');
});

test('the actual running Node release obeys the guarded CLI range', t => {
  const result = fixture(t)();
  const version = process.versions.node;
  if (satisfies(version, requiredNode)) assertHelp(result);
  else assertUnsupported(result, version);
});
