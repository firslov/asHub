// Prepare both macOS optional packages before electron-builder collects dependencies.
// npm ci installs only the host architecture; npmRebuild:false cannot supply the other.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const arches = { x64: 0x01000007, arm64: 0x0100000c };
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function checkPackage(directory, arch, version) {
  const pkg = readJSON(path.join(directory, 'package.json'));
  if (pkg.name !== `@vscode/ripgrep-darwin-${arch}` || pkg.version !== version) throw Error(`Incorrect macOS ripgrep package: ${directory}`);
  const binary = path.join(directory, 'bin', 'rg');
  const fd = fs.openSync(binary, 'r'), header = Buffer.alloc(8);
  try { if (fs.readSync(fd, header, 0, 8, 0) !== 8) throw Error('Truncated ripgrep binary'); }
  finally { fs.closeSync(fd); }
  if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== arches[arch]) throw Error(`Wrong ripgrep binary architecture: expected ${arch}`);
  if (!(fs.statSync(binary).mode & 0o111)) throw Error(`ripgrep is not executable: ${binary}`);
  return binary;
}

function requirements(root) {
  const wrapper = readJSON(path.join(root, 'node_modules/@vscode/ripgrep/package.json'));
  const declared = readJSON(path.join(root, 'package.json'));
  return Object.keys(arches).map(arch => {
    const name = `@vscode/ripgrep-darwin-${arch}`, version = wrapper.optionalDependencies?.[name];
    if (!version || declared.optionalDependencies?.[name] !== version) throw Error(`Pin ${name} to the installed @vscode/ripgrep requirement (${version}) before packaging`);
    return { arch, name, version };
  });
}

function prepare(root, run = execFileSync) {
  for (const { arch, name, version } of requirements(root)) {
    const dest = path.join(root, 'node_modules', name);
    try { checkPackage(dest, arch, version); continue; } catch { /* Restore missing/stale packages. */ }
    const entry = readJSON(path.join(root, 'package-lock.json')).packages?.[`node_modules/${name}`];
    if (entry?.version !== version || !/^sha512-[A-Za-z0-9+/=]+$/.test(entry.integrity ?? '')) throw Error(`Missing locked integrity for ${name}`);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-mac-ripgrep-'));
    try {
      const args = ['pack', `${name}@${version}`, '--json', '--ignore-scripts'];
      const npm = process.env.npm_execpath;
      const output = npm ? run(process.execPath, [npm, ...args], { cwd: temp, encoding: 'utf8' })
        : run('npm', args, { cwd: temp, encoding: 'utf8' });
      const archive = JSON.parse(output)[0]?.filename;
      if (!archive || archive !== path.basename(archive)) throw Error('Invalid npm archive name');
      const file = path.join(temp, archive);
      const integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
      if (integrity !== entry.integrity) throw Error(`Integrity mismatch for ${name}`);
      run('tar', ['-xzf', file, '-C', temp], { stdio: 'pipe' });
      const extracted = path.join(temp, 'package');
      checkPackage(extracted, arch, version);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(extracted, dest, { recursive: true });
      checkPackage(dest, arch, version);
      console.log(`[mac-ripgrep] ${name}@${version} ready`);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
}

function verify(appRoot, arch) {
  appRoot = fs.realpathSync(appRoot);
  if (!Object.hasOwn(arches, arch)) throw Error(`Unsupported macOS architecture: ${arch}`);
  // Resolve from the packaged wrapper, not the development checkout.
  const appRequire = createRequire(path.join(appRoot, 'package.json'));
  const wrapperEntry = appRequire.resolve('@vscode/ripgrep');
  if (!wrapperEntry.startsWith(appRoot + path.sep)) throw Error('ripgrep resolved outside packaged app');
  const wrapper = readJSON(path.join(path.dirname(wrapperEntry), '../package.json'));
  const name = `@vscode/ripgrep-darwin-${arch}`;
  const binary = createRequire(wrapperEntry).resolve(`${name}/bin/rg`);
  if (!binary.startsWith(appRoot + path.sep)) throw Error('ripgrep binary resolved outside packaged app');
  checkPackage(path.dirname(path.dirname(binary)), arch, wrapper.optionalDependencies[name]);
  return binary;
}

async function beforePack(context) {
  if (context.electronPlatformName === 'darwin') prepare(context.packager.info.appDir);
}
async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = ({ 1: 'x64', 3: 'arm64' })[context.arch];
  const root = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Resources/app');
  verify(root, arch);
  console.log(`[mac-ripgrep] packaged ${arch} dependency verified`);
}
module.exports = { prepare, verify, checkPackage, beforePack, afterPack };
