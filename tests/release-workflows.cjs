const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const yaml = require('js-yaml');
const { validateVersion, applyVersion } = require('../scripts/release-version.cjs');
const { plan } = require('../scripts/check-remote-release.cjs');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const workflow = name => yaml.load(read(`.github/workflows/${name}.yml`));
const needs = job => Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
function ancestors(jobs, name, result = new Set(), active = new Set()) {
  assert(jobs[name], `Missing job ${name}`);
  assert(!active.has(name), `Job dependency cycle at ${name}`);
  active.add(name);
  for (const dependency of needs(jobs[name])) {
    result.add(dependency); ancestors(jobs, dependency, result, active);
  }
  active.delete(name);
  return result;
}

test('all published releases and artifact builds require the shared verification gates', () => {
  const release = workflow('release'), artifacts = workflow('build');
  for (const [name, document, target] of [['release', release, 'release'], ['build', artifacts, 'build-mac'], ['build', artifacts, 'build-win'], ['build', artifacts, 'build-linux']]) {
    const dependencies = ancestors(document.jobs, target);
    for (const gate of ['core-checks', 'kernel-compat', 'windows-compat']) {
      assert(dependencies.has(gate), `${name}/${target} must wait for ${gate}`);
      assert.equal(document.jobs[gate].uses, `./.github/workflows/${gate}.yml`);
    }
  }
  assert.equal(release.concurrency['cancel-in-progress'], false);
  assert.equal(release.concurrency.group, 'ashub-release');
  assert.equal(artifacts.permissions.contents, 'read');
  assert(!Object.values(artifacts.jobs).some(job => (job.steps || []).some(step => /action-gh-release|gh release|releases\//.test(JSON.stringify(step)))), 'artifact workflow must not publish');
});

test('validation and tagging use the same immutable source and version; builds use the resulting commit', () => {
  const { jobs } = workflow('release');
  for (const gate of ['core-checks', 'kernel-compat', 'windows-compat']) {
    assert.equal(jobs[gate].with.ref, '${{ needs.prepare.outputs.source }}');
    assert.equal(jobs[gate].with.version, '${{ inputs.version }}');
  }
  assert.equal(jobs.tag.steps.find(s => s.uses === 'actions/checkout@v4').with.ref, '${{ needs.prepare.outputs.source }}');
  assert.equal(jobs.build.steps.find(s => s.uses === 'actions/checkout@v4').with.ref, '${{ needs.tag.outputs.commit }}');
  const publicationCheck = jobs.release.steps.find(s => s.env?.EXPECTED_COMMIT);
  assert.equal(publicationCheck.env.EXPECTED_COMMIT, '${{ needs.tag.outputs.commit }}');
  assert.match(publicationCheck.run, /refusing to publish mismatched artifacts/);
  assert(jobs.tag.steps.some(s => s.run === 'node scripts/release-version.cjs'));
  const tagScript = jobs.tag.steps.find(s => s.id === 'commit').run;
  assert.match(tagScript, /git push origin HEAD:refs\/heads\/main/);
  assert.doesNotMatch(tagScript, /git (?:pull|merge|rebase)\b/);
  for (const name of ['core-checks', 'kernel-compat', 'windows-compat']) {
    for (const job of Object.values(workflow(name).jobs)) {
      assert.equal(job.steps.find(s => s.uses === 'actions/checkout@v4').with.ref, '${{ inputs.ref || github.sha }}');
      assert(job.steps.some(s => s.run === 'node scripts/release-version.cjs'));
    }
  }
  assert.match(read('.github/workflows/release-on-tag.yml'), /-f "source_sha=\$\{source_sha\}"/);
  assert.doesNotMatch(read('.github/workflows/release.yml'), /run: \|[\s\S]*?git (?:tag|commit)[^\n]*\$\{\{ inputs\.version/);
});

test('the core gate includes existing integration and plugin suites, and the desktop UI gate is mandatory', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const command of ['npm test', 'npm run test:http', 'npm run test:scheduled-tasks', 'npm run test:network', 'tests/release-workflows.cjs', 'tests/replay-writer.cjs', 'tests/replay-recovery.cjs', 'tests/replay-frame.cjs', 'tests/sse-writer.cjs', 'tests/http-replay-flow.cjs']) {
    assert(scripts['check:core'].includes(command), `Core gate is missing ${command}`);
  }
  assert(scripts.test.includes('npm run test:architecture'));
  const core = workflow('core-checks');
  assert(core.jobs.core.steps.some(s => s.run === 'npm run check:core'));
  for (const command of ['npm run test:architecture:ui', 'npm run test:steering:ui', 'npm run test:scheduled-tasks:ui']) {
    assert(core.jobs['desktop-ui'].steps.some(s => s.run === command));
  }
});

test('release version changes only package metadata, remains repeatable, and rejects invalid inputs before writes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-release-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkg = { name: 'fixture', version: '0.1.0', scripts: { install: 'must not execute' }, dependencies: { example: '1.2.3' } };
  const lock = { name: 'fixture', version: '0.1.0', lockfileVersion: 3, packages: { '': { name: 'fixture', version: '0.1.0', dependencies: pkg.dependencies }, 'node_modules/example': { version: '1.2.3', integrity: 'keep' } } };
  for (const [name, value] of [['package.json', pkg], ['package-lock.json', lock]]) fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  for (const value of [undefined, '', 'v1.2.3', '1.2', '01.2.3', '1.2.3\n', '1.2.3; touch unsafe', '${{ secrets.TOKEN }}']) assert.throws(() => validateVersion(value));
  assert.throws(() => applyVersion(dir, '1.2.3;echo nope'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))), pkg);
  applyVersion(dir, '1.2.3'); applyVersion(dir, '1.2.3');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'))), { ...pkg, version: '1.2.3' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'))), { ...lock, version: '1.2.3', packages: { ...lock.packages, '': { ...lock.packages[''], version: '1.2.3' } } });
});

test('remote predeployment fails closed without an independent baseline and can include real browser checks', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-remote-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const current = path.join(dir, 'current'), baseline = path.join(dir, 'released');
  for (const file of ['remote/package.json', 'remote/server.mjs', 'remote/hub-test.cjs', 'dist/remote/replay.js']) {
    fs.mkdirSync(path.dirname(path.join(current, file)), { recursive: true }); fs.writeFileSync(path.join(current, file), '');
  }
  for (const file of ['package.json', 'src/hub.ts', 'web/index.html', 'node_modules/typescript/package.json']) {
    fs.mkdirSync(path.dirname(path.join(baseline, file)), { recursive: true }); fs.writeFileSync(path.join(baseline, file), file === 'package.json' ? '{"version":"0.21.0"}' : '');
  }
  assert.throws(() => plan(current, []), /--baseline/);
  assert.throws(() => plan(current, ['--baseline', current]), /separate/);
  assert.throws(() => plan(current, ['--baseline', baseline, '--unexpected']), /Unknown option/);
  // A remote deployment may never pass by silently skipping missing web UI.
  assert.throws(() => plan(current, ['--baseline', baseline, '--ui']), /remote\/public\/index\.html/);
  fs.mkdirSync(path.join(current, 'remote/public'), { recursive: true });
  fs.writeFileSync(path.join(current, 'remote/public/index.html'), '<!doctype html>');
  const checks = plan(current, ['--baseline', baseline, '--ui']);
  assert.equal(checks.steps.find(s => s.env).env.ASHUB_TEST_ROOT, fs.realpathSync(baseline));
  assert(checks.steps.some(s => s.args.includes('remote/hub-test.cjs') && !s.env));
  assert(checks.steps.some(s => s.electron));
  assert(checks.steps.some(s => s.electron && s.args.includes('tests/electron-queue-actions.cjs') && s.args.includes('--require-remote')), 'remote deployment must verify queue editing, withdrawal and promotion');
  assert(checks.steps.some(s => s.args.includes('remote/render-scroll-webkit.cjs')));
  assert.equal(checks.steps.some(s => s.args.some(a => /deploy|ssh|scp/.test(a))), false);
});
