// Run with Node after packaging; launches the native packaged Electron runtime.
// Cross-architecture validation can also run this file with that app's executable
// and ELECTRON_RUN_AS_NODE=1, passing its resources/app path and architecture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync, execFileSync } = require('node:child_process');
async function main() {
  if (!process.versions.electron) {
    const dir = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
    const app = path.resolve(process.argv[2] || 'release', dir, 'asHub.app');
    const result = spawnSync(path.join(app, 'Contents/MacOS/asHub'), [__filename, path.join(app, 'Contents/Resources/app'), process.arch], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 60000,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Packaged ${process.arch} runtime failed (${result.signal || result.status})`);
    return;
  }
  const root = fs.realpathSync(process.argv[2]), expected = process.argv[3];
  assert.equal(process.arch, expected);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-mac-runtime-'));
  process.env.AGENT_SH_HOME = home;
  delete process.env.npm_config_arch;
  try {
    const req = createRequire(path.join(root, 'package.json'));
    const rg = await import(pathToFileURL(req.resolve('@vscode/ripgrep')).href);
    assert(rg.rgPath.startsWith(root + path.sep));
    assert.match(execFileSync(rg.rgPath, ['--version'], { encoding: 'utf8', timeout: 10000 }), /^ripgrep /);
    for (const name of ['hub.js', 'bridges/ash.js', 'bridges/terminal.js']) await import(pathToFileURL(path.join(root, 'dist', name)).href);
    const pty = req('node-pty');
    await new Promise((resolve, reject) => {
      const term = pty.spawn('/bin/sh', ['-c', 'printf ASHUB_PTY_OK'], { cwd: home, env: process.env });
      let output = '';
      const timer = setTimeout(() => { term.kill(); reject(Error('PTY timeout')); }, 10000);
      term.onData(s => { output += s; });
      term.onExit(e => {
        clearTimeout(timer);
        e.exitCode === 0 && output.includes('ASHUB_PTY_OK') ? resolve() : reject(Error('Packaged PTY execution failed'));
      });
    });
    console.log(JSON.stringify({ arch: process.arch, electron: process.versions.electron, modules: 'loaded', ripgrep: 'executed', pty: 'executed' }));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
