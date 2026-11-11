// Reupload published bytes without rebuilding, retagging or replacing a Release.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateVersion } = require('./release-version.cjs');

function assetNames(version) {
  validateVersion(version);
  const mac = ['arm64', 'x64'].flatMap(arch => ['dmg', 'zip'].map(ext => `asHub-${version}-${arch}.${ext}`));
  const windows = `asHub-Setup-${version}.exe`;
  return [...mac, windows, `asHub-${version}.AppImage`, ...[...mac, windows].map(name => `${name}.blockmap`),
    'latest.yml', 'latest-mac.yml', 'latest-linux.yml'];
}
function planRelease(version, release, latest) {
  validateVersion(version);
  if (!release || release.draft || release.prerelease || release.tag_name !== `v${version}` ||
      !Number.isSafeInteger(release.id) || latest?.id !== release.id || latest?.tag_name !== release.tag_name ||
      latest?.draft || latest?.prerelease) throw Error('Only the latest published stable release can update COS metadata');
  return assetNames(version).map(name => {
    const found = release.assets?.filter(a => a.name === name) || [];
    if (found.length !== 1) throw Error(`Missing or duplicate release asset: ${name}`);
    const a = found[0];
    if (a.state !== 'uploaded' || !Number.isSafeInteger(a.size) || a.size <= 0 ||
        !Number.isSafeInteger(a.id) || !/^sha256:[a-f0-9]{64}$/.test(a.digest || '')) throw Error(`Invalid release asset: ${name}`);
    return { name, id: a.id, size: a.size, sha256: a.digest.slice(7), metadata: name.startsWith('latest') };
  });
}
async function verifyFile(file, asset) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size !== asset.size) throw Error(`Size or file type mismatch: ${asset.name}`);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  if (hash.digest('hex') !== asset.sha256) throw Error(`SHA-256 mismatch: ${asset.name}`);
}
async function synchronize(plan, { upload, verify, assertCurrent }) {
  // No update metadata is exposed until every installer and blockmap verifies.
  await assertCurrent();
  for (const asset of plan.filter(a => !a.metadata)) { await upload(asset); await verify(asset); }
  await assertCurrent();
  for (const asset of plan.filter(a => a.metadata)) { await upload(asset); await verify(asset); }
}
async function main() {
  const version = validateVersion(process.env.RELEASE_VERSION);
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')) throw Error('Invalid repository');
  const run = (command, args, capture = false) => execFileSync(command, args, {
    encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', maxBuffer: 8 * 1024 * 1024,
  });
  const get = route => JSON.parse(run('gh', ['api', `repos/${repository}/${route}`], true));
  const release = get(`releases/tags/v${version}`);
  const plan = planRelease(version, release, get('releases/latest'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-cos-sync-'));
  try {
    const source = path.join(dir, 'release'), checked = path.join(dir, 'verify');
    fs.mkdirSync(source); fs.mkdirSync(checked);
    run('gh', ['release', 'download', `v${version}`, '--repo', repository, '--dir', source]);
    for (const asset of plan) await verifyFile(path.join(source, asset.name), asset);
    await synchronize(plan, {
      assertCurrent: () => {
        const current = planRelease(version, get(`releases/tags/v${version}`), get('releases/latest'));
        if (JSON.stringify(current) !== JSON.stringify(plan)) throw Error('Release assets changed during synchronization');
      },
      upload: asset => run('coscmd', ['upload', '-f', '-y', path.join(source, asset.name), '/']),
      verify: async asset => {
        const file = path.join(checked, asset.name);
        run('coscmd', ['download', '-f', '-y', asset.name, file]);
        await verifyFile(file, asset);
        fs.unlinkSync(file);
        console.log(`Verified ${asset.name}: ${asset.size} bytes, SHA-256 ${asset.sha256}`);
      },
    });
    console.log(`Reuploaded and verified ${plan.length} files for v${version}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
module.exports = { assetNames, planRelease, verifyFile, synchronize };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
