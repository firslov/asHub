const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const yaml = require('js-yaml');
const { assetNames } = require('../scripts/resync-cos.cjs');
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
  const guardIndex = jobs.tag.steps.findIndex(s => s.name === 'Refuse an existing GitHub Release');
  assert(guardIndex >= 0 && guardIndex < jobs.tag.steps.findIndex(s => s.id === 'commit'));
  assert.equal(jobs.release.steps.find(s => s.uses === 'actions/checkout@v4').with.ref, '${{ github.workflow_sha }}');
  assert.doesNotMatch(JSON.stringify(jobs.release), /gh release (?:edit|delete|upload)|action-gh-release/);
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


test('COS resync is isolated from release publication and shares its upload lock', () => {
  const sync = workflow('sync-cos');
  assert.equal(sync.permissions.contents, 'read');
  assert.equal(sync.concurrency.group, workflow('release').concurrency.group);
  assert.equal(sync.concurrency['cancel-in-progress'], false);
  assert.deepEqual(sync.on.push.tags, ['cos-sync-v*']);
  assert.deepEqual(workflow('release-on-tag').on.push.tags, ['v*']);
  assert(sync.jobs.sync.steps.some(s => s.run === 'node --test tests/cos-release.cjs'));
  const command = sync.jobs.sync.steps.find(s => s.run === 'node scripts/resync-cos.cjs');
  assert.equal(command.env.RELEASE_VERSION, '${{ steps.version.outputs.version }}');
  assert.doesNotMatch(JSON.stringify(sync), /action-gh-release|gh release delete|git tag|electron-builder/);
});

const mirrorVersion = '1.2.3';
const mirrorAssets = assetNames(mirrorVersion);
const mirrorPayloads = mirrorAssets.filter(name => !name.startsWith('latest'));
const mirrorMetadata = mirrorAssets.filter(name => name.startsWith('latest'));

function mirrorFixture(t, { missing, empty, alreadyPublished = false, remote = {}, githubTags = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-first-mirror-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const release = path.join(dir, 'release');
  const mocks = path.join(dir, 'bin');
  const log = path.join(dir, 'uploads');
  const bucket = path.join(dir, 'bucket');
  const github = path.join(dir, 'github-release');
  const sdk = path.join(mocks, 'qcloud_cos');
  fs.mkdirSync(release);
  fs.mkdirSync(mocks);
  fs.mkdirSync(sdk);
  fs.mkdirSync(bucket);
  fs.mkdirSync(path.join(dir, 'release-tools/scripts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/check-cos-mirror.py'), path.join(dir, 'release-tools/scripts/check-cos-mirror.py'));
  const metadata = {
    'latest.yml': [`asHub-Setup-${mirrorVersion}.exe`],
    'latest-mac.yml': mirrorPayloads.filter(name => /\.(zip|dmg)$/.test(name)),
    'latest-linux.yml': [`asHub-${mirrorVersion}.AppImage`],
  };
  const payload = (name, generation) => `${generation} synthetic payload: ${name}`;
  const sha512 = bytes => createHash('sha512').update(bytes).digest('base64');
  const assetBytes = (name, generation, version = mirrorVersion) => metadata[name]
    ? yaml.dump({ version, files: metadata[name].map(url => ({ url, sha512: sha512(payload(url, generation)) })) })
    : payload(name, generation);
  for (const name of mirrorAssets) {
    if (name !== missing) fs.writeFileSync(path.join(release, name), name === empty ? '' : assetBytes(name, 'new'));
    if (alreadyPublished) fs.writeFileSync(path.join(bucket, name), assetBytes(name, 'old'));
  }
  for (const [name, body] of Object.entries(remote)) fs.writeFileSync(path.join(bucket, name), body);
  fs.writeFileSync(path.join(release, 'builder-debug.yml'), 'not an update asset');
  fs.mkdirSync(path.join(release, 'linux-unpacked'));
  fs.writeFileSync(log, '');
  // PATH contains only local shims. Neither pip nor coscmd can reach a network.
  fs.writeFileSync(path.join(mocks, 'pip'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(mocks, 'coscmd'), '#!/bin/sh\nexec "$TEST_NODE" "$COS_SHIM" "$@"\n', { mode: 0o755 });
  const shim = path.join(dir, 'cos.cjs');
  fs.writeFileSync(shim, `
    const fs = require('node:fs'), path = require('node:path');
    const [command, ...args] = process.argv.slice(2);
    if (command === 'config' || command === 'delete') process.exit(0);
    if (command === 'download') {
      fs.copyFileSync(path.join(process.env.COS_BUCKET_FIXTURE, args.at(-2)), args.at(-1));
      process.exit(0);
    }
    if (command !== 'upload') process.exit(64);
    const source = args.at(-2), name = path.basename(source);
    fs.appendFileSync(process.env.COS_LOG, name + '\\n');
    if (name === process.env.FAIL_AT) process.exit(23);
    fs.copyFileSync(source, path.join(process.env.COS_BUCKET_FIXTURE, name));
  `);
  const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  assert.ifError(python.error);
  assert.equal(python.status, 0, python.stderr);
  fs.writeFileSync(path.join(mocks, 'python3'), '#!/bin/sh\nexec "$TEST_PYTHON" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(sdk, 'cos_exception.py'), `
class CosServiceError(Exception):
    def __init__(self, status, code=None): self.status, self.code = status, code
    def get_status_code(self): return self.status
    def get_error_code(self): return self.code
`);
  fs.writeFileSync(path.join(sdk, '__init__.py'), `
import os
from pathlib import Path
from .cos_exception import CosServiceError

class CosConfig:
    def __init__(self, **kwargs): pass

class Body:
    def __init__(self, file): self.file = file
    def get_raw_stream(self): return self.file.open('rb')

class CosS3Client:
    def __init__(self, config): pass
    def object(self, bucket, key, is_head):
        assert bucket == 'ashub-release-1258678103'
        if key == os.environ.get('FAIL_LOOKUP'):
            raise CosServiceError(403, 'AccessDenied')
        file = Path(os.environ['COS_BUCKET_FIXTURE']) / key
        if not file.is_file(): raise CosServiceError(404, None if is_head else 'NoSuchKey')
        return {} if is_head else {'Body': Body(file)}
    def get_object(self, Bucket, Key): return self.object(Bucket, Key, False)
    def head_object(self, Bucket, Key): return self.object(Bucket, Key, True)
`);
  const gh = path.join(dir, 'gh.cjs');
  fs.writeFileSync(path.join(mocks, 'gh'), '#!/bin/sh\nexec "$TEST_NODE" "$GH_SHIM" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(gh, `
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
    const args = process.argv.slice(2), dir = process.env.GITHUB_RELEASE_FIXTURE;
    if (args[0] === 'api' && args[1] === '--paginate') {
      assert.deepEqual(args.slice(1), ['--paginate', 'repos/mock-owner/mock-repo/releases?per_page=100', '--jq', '.[].tag_name']);
      if (process.env.GH_ERROR) process.exit(29);
      console.log(process.env.GH_TAGS);
      if (fs.existsSync(dir)) console.log('v${mirrorVersion}');
    } else if (args[0] === 'api') {
      assert(['repos/mock-owner/mock-repo/releases/latest', 'repos/mock-owner/mock-repo/releases/tags/v${mirrorVersion}'].includes(args[1]));
      const { createHash } = require('node:crypto');
      const assets = fs.readdirSync(dir).map((name, i) => {
        const contents = fs.readFileSync(path.join(dir, name));
        return { name, id: i + 1, state: 'uploaded', size: contents.length, digest: 'sha256:' + createHash('sha256').update(contents).digest('hex') };
      });
      console.log(JSON.stringify({ id: 1, tag_name: 'v${mirrorVersion}', assets }));
    } else if (args[1] === 'download') {
      assert.deepEqual(args.slice(0, 6), ['release', 'download', 'v${mirrorVersion}', '--repo', 'mock-owner/mock-repo', '--dir']);
      for (const file of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, file), path.join(args[6], file));
    } else {
      assert.deepEqual(args.slice(0, 10), ['release', 'create', 'v${mirrorVersion}', '--repo', 'mock-owner/mock-repo', '--verify-tag', '--title', 'v${mirrorVersion}', '--notes', '']);
      if (fs.existsSync(dir) || process.env.GH_ERROR) process.exit(29);
      fs.mkdirSync(dir);
      for (const file of args.slice(10)) fs.copyFileSync(file, path.join(dir, path.basename(file)));
    }
  `);
  const { jobs } = workflow('release');
  function run(step, extra) {
    assert(step);
    fs.writeFileSync(log, '');
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
      cwd: dir,
      env: { PATH: mocks, TEST_NODE: process.execPath, TEST_PYTHON: python.stdout.trim(), PYTHONPATH: mocks,
        COS_SHIM: shim, COS_BUCKET_FIXTURE: bucket, COS_LOG: log, COS_SECRET_ID: 'fixture', COS_SECRET_KEY: 'fixture',
        RELEASE_VERSION: mirrorVersion, GH_SHIM: gh, GITHUB_RELEASE_FIXTURE: github, GH_TAGS: githubTags,
        SYNC_SCRIPT: path.join(root, 'scripts/resync-cos.cjs'), GITHUB_REPOSITORY: 'mock-owner/mock-repo', ...extra },
      encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    return { ...result, uploads: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), created: fs.existsSync(github) };
  }
  return {
    publish: extra => run(jobs.release.steps.find(s => s.name === 'Publish GitHub release and upload to COS'), extra),
    checkTag: extra => run(jobs.tag.steps.find(s => s.name === 'Refuse an existing GitHub Release'), extra),
    sync: extra => run({ run: '"$TEST_NODE" "$SYNC_SCRIPT"' }, extra),
    bucket, github, sha512,
  };
}

const needsBash = { skip: process.platform === 'win32' };
test('first COS mirror uploads the full resync payload set before exposing any platform metadata', needsBash, t => {
  const old = { 'latest-mac.yml': 'version: "1.2.2"\r\n', 'asHub-1.2.2-x64.dmg': 'earlier download' };
  const { publish, bucket, github } = mirrorFixture(t, { remote: old });
  const { status, stderr, uploads, created } = publish();
  assert.equal(status, 0, stderr);
  assert.equal(created, true);
  assert.deepEqual(uploads.slice(0, mirrorPayloads.length).sort(), [...mirrorPayloads].sort());
  assert.deepEqual(uploads.slice(mirrorPayloads.length).sort(), [...mirrorMetadata].sort());
  for (const name of mirrorAssets) assert.deepEqual(fs.readFileSync(path.join(bucket, name)), fs.readFileSync(path.join(github, name)));
  assert.equal(fs.readFileSync(path.join(bucket, 'asHub-1.2.2-x64.dmg'), 'utf8'), old['asHub-1.2.2-x64.dmg']);
});

test('a failed final payload preserves older metadata and resync fills only missing files', needsBash, t => {
  const failAt = mirrorPayloads.at(-1);
  const oldPayload = 'asHub-Setup-1.2.2.exe', oldBytes = 'older payload';
  const oldMetadata = yaml.dump({ version: '1.2.2', files: [{ url: oldPayload, sha512: createHash('sha512').update(oldBytes).digest('base64') }] });
  const { publish, sync, checkTag, bucket, github } = mirrorFixture(t, { remote: { 'latest.yml': oldMetadata, [oldPayload]: oldBytes } });
  const { status, uploads, stderr, created } = publish({ FAIL_AT: failAt });
  assert.equal(status, 23);
  assert.match(stderr, /Retry with Sync release to COS/);
  assert.equal(created, true);
  assert.equal(uploads.at(-1), failAt);
  assert.deepEqual(uploads.sort(), [...mirrorPayloads].sort());
  assert.equal(fs.readFileSync(path.join(bucket, 'latest.yml'), 'utf8'), oldMetadata);
  assert.equal(checkTag().status, 1, 'do not retag or rebuild an existing release');
  assert.deepEqual(publish().uploads, [], 'even a release-job-only rerun may not overwrite');
  const resumed = sync();
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(resumed.uploads, [failAt, ...mirrorMetadata]);
  for (const name of mirrorAssets) assert.deepEqual(fs.readFileSync(path.join(bucket, name)), fs.readFileSync(path.join(github, name)));
  const repeat = sync();
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.deepEqual(repeat.uploads, []);
});

test('same-version publication cannot invalidate any existing COS manifest, even if the final payload upload would fail', needsBash, t => {
  const { publish, bucket, sha512 } = mirrorFixture(t, { alreadyPublished: true });
  const { status, uploads, created, stderr } = publish({ FAIL_AT: mirrorPayloads.at(-1) });
  assert.notEqual(status, 0);
  assert.equal(created, false);
  assert.match(stderr, /latest\.yml already advertises v1\.2\.3/);
  for (const name of mirrorMetadata) {
    const manifest = yaml.load(fs.readFileSync(path.join(bucket, name), 'utf8'));
    for (const file of manifest.files) {
      assert.equal(sha512(fs.readFileSync(path.join(bucket, file.url))), file.sha512, `${name} still refers to ${file.url}`);
    }
  }
  assert.deepEqual(uploads, []);
});

test('publication refuses orphaned payloads, unknown metadata and unsuccessful lookups before creating a Release', needsBash, async t => {
  for (const [message, remote, env] of [
    [/payload .* already exists/, { [mirrorPayloads.at(-1)]: 'orphan' }],
    [/latest-linux.yml already advertises v1\.2\.3/, { 'latest-linux.yml': 'version: 1.2.3\n' }],
    [/latest-mac.yml already advertises v1\.2\.10/, { 'latest-mac.yml': 'version: 1.2.10\n' }],
    [/Cannot determine .* latest.yml/, { 'latest.yml': 'invalid manifest' }],
    [/HTTP 403/, {}, { FAIL_LOOKUP: mirrorPayloads.at(-1) }],
  ]) {
    await t.test(message.source, sub => {
      const result = mirrorFixture(sub, { remote }).publish(env);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
      assert.equal(result.created, false);
      assert.deepEqual(result.uploads, []);
    });
  }
});

test('an existing GitHub release or a failed API lookup stops before retagging', needsBash, t => {
  const { checkTag, publish } = mirrorFixture(t, { githubTags: 'v1.2.30\nv1.2.3\nv1.2.2' });
  const conflict = checkTag();
  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout, /GitHub Release v1\.2\.3 already exists/);
  assert.equal(checkTag({ GH_ERROR: 'api failed' }).status, 29);
  const rejected = publish({ GH_ERROR: 'release create failed' });
  assert.equal(rejected.status, 29);
  assert.deepEqual(rejected.uploads, []);
});

test('partial metadata upload is resumable, but existing different GitHub/COS bytes never get overwritten', needsBash, t => {
  const { publish, sync, bucket } = mirrorFixture(t);
  const partial = publish({ FAIL_AT: 'latest-mac.yml' });
  assert.equal(partial.status, 23);
  assert.equal(partial.created, true);
  assert.deepEqual(partial.uploads.slice(-2), ['latest.yml', 'latest-mac.yml']);
  const payload = path.join(bucket, mirrorPayloads.at(-1));
  const original = fs.readFileSync(payload);
  fs.writeFileSync(payload, Buffer.alloc(original.length, 0x41));
  const mismatch = sync();
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /differs from the GitHub release/);
  assert.deepEqual(mismatch.uploads, []);
  assert.deepEqual(fs.readFileSync(payload), Buffer.alloc(original.length, 0x41));
  fs.writeFileSync(payload, original);
  const manifest = path.join(bucket, 'latest.yml');
  const originalManifest = fs.readFileSync(manifest);
  fs.appendFileSync(manifest, '# different manifest, same version\n');
  const manifestMismatch = sync();
  assert.notEqual(manifestMismatch.status, 0);
  assert.match(manifestMismatch.stderr, /already advertises v1\.2\.3/);
  assert.deepEqual(manifestMismatch.uploads, []);
  fs.writeFileSync(manifest, originalManifest);
  const retry = sync();
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(retry.uploads, ['latest-mac.yml', 'latest-linux.yml']);
});

test('publishing without COS credentials leaves GitHub as the source for a later sync', needsBash, t => {
  const { publish, sync, checkTag } = mirrorFixture(t, { githubTags: 'v1.2.30\nv1.2.2' });
  assert.equal(checkTag().status, 0);
  const published = publish({ COS_SECRET_ID: '', COS_SECRET_KEY: '' });
  assert.equal(published.status, 0, published.stderr);
  assert.equal(published.created, true);
  assert.deepEqual(published.uploads, []);
  const resumed = sync();
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.deepEqual(resumed.uploads, mirrorAssets);
});

test('first COS mirror refuses to upload incomplete update sets', needsBash, async t => {
  for (const fixture of [{ missing: `asHub-${mirrorVersion}.AppImage` }, { empty: 'latest-linux.yml' }]) {
    const asset = fixture.missing || fixture.empty;
    await t.test(asset, test => {
      const { status, stdout, stderr, uploads } = mirrorFixture(test, fixture).publish();
      assert.notEqual(status, 0);
      assert((stdout + stderr).includes(asset), `The diagnostic should name the invalid asset: ${stdout}${stderr}`);
      assert.deepEqual(uploads, []);
    });
  }
});
