const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function install(t, { previous = false, failure = '', arch = 'arm64', lookup = '' } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub installer-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const applications = path.join(sandbox, 'Applications');
  const downloads = path.join(sandbox, 'downloads');
  const bin = path.join(sandbox, 'bin');
  const app = path.join(applications, 'asHub.app');
  const events = path.join(sandbox, 'events');
  for (const dir of [applications, downloads, bin]) fs.mkdirSync(dir);
  fs.writeFileSync(events, '');
  if (previous) {
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'old-marker'), 'original');
  }

  // The executed script differs only in its fixed destination and xattr path.
  // No system installation command, network, or inherited PATH is used.
  const source = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
  assert.match(source, /^DEST="\/Applications"$/m);
  assert.match(source, /^\/usr\/bin\/xattr /m);
  const isolated = source.replace(/^DEST="\/Applications"$/m, 'DEST="$TEST_DEST"')
    .replace(/^\/usr\/bin\/xattr /m, 'xattr ');
  assert(!isolated.includes('/Applications'), 'the fixture must not contain a real install path');
  const script = path.join(sandbox, 'install.sh');
  fs.writeFileSync(script, isolated);
  const mock = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  for (const name of ['basename', 'grep', 'head', 'mkdir', 'mktemp', 'rm', 'rmdir', 'sed']) {
    const executable = [`/usr/bin/${name}`, `/bin/${name}`].find(file => fs.existsSync(file));
    assert(executable, `Missing test prerequisite: ${name}`);
    fs.symlinkSync(executable, path.join(bin, name));
  }
  mock('uname', 'case "$1" in -s) echo Darwin ;; -m) echo "$CPU" ;; *) exit 64 ;; esac');
  mock('curl', `
if [ "$1" = -fsSL ]; then
  case "$LOOKUP" in
    partial)
      printf '%s\n' '{"assets":[{"browser_download_url":"https://fixture.invalid/asHub-1.2.3-arm64.zip",'
      echo 'curl: (18) transfer closed with outstanding read data remaining' >&2
      exit 18 ;;
    timeout) echo 'curl: (28) operation timed out' >&2; exit 28 ;;
    empty) printf '%s\n' '{"assets":[]}'; exit 0 ;;
  esac
  printf '%s\n' '{"assets":[{"browser_download_url":"https://fixture.invalid/asHub-1.2.3-arm64.zip"},{"browser_download_url":"https://fixture.invalid/asHub-1.2.3-x64.zip"}]}'
  exit 0
fi
case "$CPU" in arm64) arch=arm64 ;; x86_64) arch=x64 ;; esac
[ "$3" = "https://fixture.invalid/asHub-1.2.3-$arch.zip" ]
[ "$4" = -o ]
printf 'synthetic zip' > "$5"`);
  mock('unzip', `
[ -s "$2" ] && [ "$3" = -d ]
/bin/mkdir "$4/asHub.app"
printf '%s' "$VERSION_LABEL" > "$4/asHub.app/new-marker"`);
  mock('ditto', `
printf 'ditto:%s\n' "$2" >> "$TEST_EVENTS"
[ -f "$1/new-marker" ]
/bin/mkdir "$2"
if [ "$FAILURE" = copy ]; then
  printf 'partial' > "$2/partial-marker"
  exit 31
fi
/bin/cp "$1/new-marker" "$2/new-marker"`);
  mock('mv', `
printf 'mv:%s -> %s\n' "$1" "$2" >> "$TEST_EVENTS"
if [ "$2" = "$TEST_DEST/asHub.app" ]; then
  if [ -f "$1/new-marker" ] && [ "$FAILURE" = terminate ]; then kill -TERM "$PPID"; exit 32; fi
  if [ -f "$1/new-marker" ] && [ "$FAILURE" = terminate-after-rename ]; then
    /bin/mv "$@"
    kill -TERM "$PPID"
    exit 0
  fi
  if [ -f "$1/new-marker" ] && [ "$FAILURE" = concurrent ]; then
    code=0
    FAILURE='' VERSION_LABEL='competing version' /bin/bash "$TEST_SCRIPT" > "$TEST_SCRIPT.contender" 2>&1 || code=$?
    printf 'contender:%s\n' "$code" >> "$TEST_EVENTS"
  elif [ -f "$1/new-marker" ] && [ -n "$FAILURE" ]; then exit 32; fi
  if [ -f "$1/old-marker" ] && [ "$FAILURE" = restore ]; then exit 33; fi
fi
exec /bin/mv "$@"`);
  mock('xattr', `
[ "$1" = -dr ] && [ "$2" = com.apple.quarantine ] && [ "$3" = "$TEST_DEST/asHub.app" ]
[ -f "$3/new-marker" ]
printf 'xattr\n' >> "$TEST_EVENTS"`);

  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', script], {
    cwd: sandbox, timeout: 5000, encoding: 'utf8',
    env: { PATH: bin, TMPDIR: downloads, TEST_DEST: applications, TEST_EVENTS: events, TEST_SCRIPT: script,
      VERSION_LABEL: 'new version', FAILURE: failure, CPU: arch, LOOKUP: lookup },
  });
  assert.ifError(result.error);
  return { ...result, applications, downloads, app, events: fs.readFileSync(events, 'utf8').trim().split('\n') };
}

function assertClean({ applications, downloads }) {
  assert.deepEqual(fs.readdirSync(applications), ['asHub.app']);
  assert.deepEqual(fs.readdirSync(downloads), []);
}

const needsBash = { skip: process.platform === 'win32' };
test('failed release lookup never upgrades from partial output', needsBash, t => {
  for (const lookup of ['partial', 'timeout']) {
    const result = install(t, { previous: true, lookup });
    assert.notEqual(result.status, 0, `lookup ${lookup} must not install anything`);
    assert.match(result.stderr, /could not fetch the latest asHub release/);
    assert.doesNotMatch(result.stderr, /no arm64 \.zip asset/);
    assert.doesNotMatch(result.stdout, /Downloading/);
    assert.equal(fs.readFileSync(path.join(result.app, 'old-marker'), 'utf8'), 'original');
    assertClean(result);
  }
});

test('a successful lookup without the architecture asset reports the missing asset', needsBash, t => {
  const result = install(t, { previous: true, lookup: 'empty' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no arm64 \.zip asset found/);
  assert.doesNotMatch(result.stdout, /Downloading/);
  assert.equal(fs.readFileSync(path.join(result.app, 'old-marker'), 'utf8'), 'original');
  assertClean(result);
});

test('a partial ditto failure leaves the existing app untouched', needsBash, t => {
  const result = install(t, { previous: true, failure: 'copy' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(result.app, 'old-marker'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(result.app), ['old-marker']);
  assert.equal(result.events.length, 1);
  assertClean(result);
});

test('replacement installs the staged bundle before clearing quarantine and removes the backup on success', needsBash, t => {
  const result = install(t, { previous: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(result.app), ['new-marker']);
  const stagedApp = result.events[0].slice('ditto:'.length);
  assert.equal(path.dirname(path.dirname(stagedApp)), result.applications);
  assert.match(result.events[1], /^mv:/);
  assert.equal(result.events[2], `mv:${stagedApp} -> ${result.app}`);
  assert.equal(result.events[3], 'xattr');
  assertClean(result);
});

test('Intel first install publishes the staged app without a backup', needsBash, t => {
  const result = install(t, { arch: 'x86_64' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(result.app), ['new-marker']);
  const stagedApp = result.events[0].slice('ditto:'.length);
  assert.notEqual(stagedApp, result.app);
  assert.deepEqual(result.events.slice(1), [`mv:${stagedApp} -> ${result.app}`, 'xattr']);
  assertClean(result);
});

test('a concurrent installer cannot publish inside or replace the app during activation', needsBash, t => {
  const result = install(t, { failure: 'concurrent' });
  assert.equal(result.status, 0, result.stderr);
  assert(result.events.includes('contender:1'), result.events.join('\n'));
  assert.deepEqual(fs.readdirSync(result.app), ['new-marker']);
  assert.equal(fs.readFileSync(path.join(result.app, 'new-marker'), 'utf8'), 'new version');
  assertClean(result);
});

test('a failed rename of the staged bundle restores the previous install', needsBash, t => {
  const result = install(t, { previous: true, failure: 'activate' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(result.app, 'old-marker'), 'utf8'), 'original');
  assert(!result.events.includes('xattr'));
  assertClean(result);
});

test('SIGTERM during the switch still restores the previous install', needsBash, t => {
  const result = install(t, { previous: true, failure: 'terminate' });
  assert.equal(result.status, 143, result.stderr);
  assert.equal(fs.readFileSync(path.join(result.app, 'old-marker'), 'utf8'), 'original');
  assert(!result.events.includes('xattr'));
  assertClean(result);
});

test('SIGTERM immediately after activation keeps the new install and preserves signal status', needsBash, t => {
  for (const previous of [false, true]) {
    const result = install(t, { previous, failure: 'terminate-after-rename' });
    assert.equal(result.status, 143, result.stderr);
    assert.deepEqual(fs.readdirSync(result.app), ['new-marker']);
    assert(result.events.includes('xattr'), 'an activated install must be finalized');
    assert.doesNotMatch(result.stderr, /could not restore/);
    assertClean(result);
  }
});

test('if rollback also fails, the only good copy is retained and its path is reported', needsBash, t => {
  const result = install(t, { previous: true, failure: 'restore' });
  assert.notEqual(result.status, 0);
  assert(!fs.existsSync(result.app));
  assert(!result.events.includes('xattr'));
  const [stash, ...others] = fs.readdirSync(result.applications);
  assert(stash && others.length === 0);
  const staging = path.join(result.applications, stash);
  const backup = fs.readdirSync(staging).map(name => path.join(staging, name))
    .find(dir => fs.existsSync(path.join(dir, 'old-marker')));
  assert(backup, 'previous app backup must not be cleaned');
  assert.equal(fs.readFileSync(path.join(backup, 'old-marker'), 'utf8'), 'original');
  assert(result.stderr.includes(backup), `backup path missing from diagnostic: ${result.stderr}`);
  assert.deepEqual(fs.readdirSync(result.downloads), []);
});
