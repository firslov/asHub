const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { configure } = require('../scripts/patch-integration-kernel.cjs');
const { pruneDisabledIntegrations } = require('../scripts/builtin-integrations.cjs');
const { apply } = require('../scripts/patch-kernel-hunks.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-optional-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  return { root, write, read: relative => fs.readFileSync(path.join(root, relative), 'utf8'),
    exists: relative => fs.existsSync(path.join(root, relative)) };
}

test('optional hunks can share required hunks and be toggled or removed in a reused install', t => {
  const { root, write, read } = fixture(t);
  const kernel = path.join(root, 'node_modules/agent-sh');
  const runtime = 'node_modules/agent-sh/runtime.js';
  const plugin = 'src/builtin-plugins/sample';
  const spec = hunks => ({ files: [{ path: 'runtime.js', hunks }] });
  const required = { before: 'const required = false;', after: 'const required = true;' };
  const optional = { before: 'const optional = false;', after: 'const optional = true;' };
  const baseline = `${required.after}\n${optional.before}\n// unrelated`;
  const patched = baseline.replace(optional.before, optional.after);
  write(`${plugin}/kernel-patches/runtime.json`, JSON.stringify(spec([required, optional])));
  write(runtime, patched); // Legacy install, no rollback journal yet.
  const run = exclude => {
    const previous = process.env.ASHUB_EXCLUDE_INTEGRATIONS;
    process.env.ASHUB_EXCLUDE_INTEGRATIONS = exclude;
    try {
      configure(root, kernel, () => apply(kernel, spec([required]), 'required fixture'));
    } finally {
      if (previous === undefined) delete process.env.ASHUB_EXCLUDE_INTEGRATIONS;
      else process.env.ASHUB_EXCLUDE_INTEGRATIONS = previous;
    }
  };
  run(' sample , nonexistent ');
  assert.equal(read(runtime), baseline);
  run('');
  run('');
  assert.equal(read(runtime), patched);
  run('sample');
  assert.equal(read(runtime), baseline);
  run('');
  fs.rmSync(path.join(root, plugin), { recursive: true });
  run('');
  assert.equal(read(runtime), baseline);
});

test('build skips excluded TS inputs and leaves no old modules, assets, or kernel specs in dist', t => {
  const { root, write, exists } = fixture(t);
  write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'ES2022', rootDir: 'src', outDir: 'dist', types: [] }, include: ['src/**/*.ts'] }));
  write('src/main.ts', 'export const value = 1;');
  write('src/builtin-plugins/sample/integration.ts', 'export const integration = 1;');
  write('src/builtin-plugins/sample/assets/sample.txt', 'asset');
  write('src/builtin-plugins/sample/kernel-patches/runtime.json', '{}');
  write('examples/extensions/desktop-control/tsconfig.json', JSON.stringify({ compilerOptions: { types: [] }, files: ['index.ts'] }));
  write('examples/extensions/desktop-control/index.ts', 'export {};');
  for (const file of ['build.cjs', 'builtin-integrations.cjs']) {
    write(`scripts/${file}`, fs.readFileSync(path.join(__dirname, '../scripts', file)));
  }
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(root, 'node_modules/typescript'), 'junction');
  const run = exclude => spawnSync(process.execPath, ['scripts/build.cjs'], {
    cwd: root, env: { ...process.env, ASHUB_EXCLUDE_INTEGRATIONS: exclude }, encoding: 'utf8',
  });
  const integration = 'dist/builtin-plugins/sample';
  let result = run('');
  assert.equal(result.status, 0, result.stderr);
  assert(exists(`${integration}/integration.js`));
  assert(exists(`${integration}/assets/sample.txt`));
  assert(!exists(`${integration}/kernel-patches`));
  write('src/builtin-plugins/sample/integration.ts', 'import { onlyOptional } from "not-installed"; export { onlyOptional };');
  write('dist/former-core-integration.js', 'stale output');
  result = run('sample');
  assert.equal(result.status, 0, result.stderr);
  assert(exists('dist/main.js'));
  assert(!exists(integration));
  assert(!exists('dist/former-core-integration.js'));
  write('src/main.ts', 'export * from "./builtin-plugins/sample/integration.js";');
  result = run('sample');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /imports an excluded integration/);
  write('src/main.ts', 'export const value = 1;');
  fs.rmSync(path.join(root, 'src/builtin-plugins'), { recursive: true });
  write(`${integration}/integration.js`, 'old output');
  pruneDisabledIntegrations(root);
  assert(!exists(integration));
  result = run('');
  assert.equal(result.status, 0, result.stderr);
});
