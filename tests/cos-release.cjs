const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assetNames, planRelease, verifyFile, synchronize } = require('../scripts/resync-cos.cjs');
const version = '0.21.5';
function release() {
  return { id: 1, tag_name: `v${version}`, draft: false, prerelease: false,
    assets: assetNames(version).map((name, id) => ({ name, id: id + 1, state: 'uploaded', size: 4, digest: 'sha256:' + 'a'.repeat(64) })) };
}
test('only the complete latest stable release can be mirrored', () => {
  const r = release(), p = planRelease(version, r, r);
  assert.equal(p.length, 14); assert.equal(p.filter(a => a.metadata).length, 3);
  for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.21.4' }, { assets: r.assets.slice(1) },
    { assets: [...r.assets, r.assets[0]] }, { assets: r.assets.map(a => ({ ...a, digest: null })) },
    { assets: r.assets.map(a => ({ ...a, state: 'new' })) }]) assert.throws(() => planRelease(version, { ...r, ...patch }, r));
  assert.throws(() => planRelease(version, r, { ...r, id: 2, tag_name: 'v0.21.6' }));
  for (const invalid of ['../0.21.5', '0.21.5;echo bad', 'v0.21.5']) assert.throws(() => assetNames(invalid));
});
test('download verification rejects same-size corruption and wrong sizes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-cos-test-'));t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'asset');fs.writeFileSync(file, 'good');
  const asset = { name: 'asset', size: 4, sha256: createHash('sha256').update('good').digest('hex') };
  await verifyFile(file, asset);
  fs.writeFileSync(file, 'evil');await assert.rejects(verifyFile(file, asset), /SHA-256/);
  fs.writeFileSync(file, 'shorter');await assert.rejects(verifyFile(file, asset), /Size/);
});
test('metadata waits for every payload verification and a fresh release check', async () => {
  const r = release(), plan = planRelease(version, r, r), events = [];
  await synchronize(plan, { assertCurrent: () => events.push('current'), upload: a => events.push('upload:' + a.name), verify: a => events.push('verify:' + a.name) });
  const lastPayload = events.indexOf('verify:' + plan.filter(a => !a.metadata).at(-1).name);
  assert.equal(events[lastPayload + 1], 'current');assert.equal(events[lastPayload + 2], 'upload:latest.yml');
  for (const failAt of ['upload', 'verify', 'current']) {
    const uploaded = [];let checks = 0;
    await assert.rejects(synchronize(plan, {
      assertCurrent() { if (++checks === 2 && failAt === 'current') throw Error('changed'); },
      upload(a) { uploaded.push(a.name);if (failAt === 'upload') throw Error('upload failed'); },
      verify() { if (failAt === 'verify') throw Error('corrupt'); },
    }));
    assert(!uploaded.some(n => n.startsWith('latest')), failAt + ' must prevent metadata publication');
  }
});
