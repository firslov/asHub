const { lstatSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function run(script, args = []) {
  const { error, status, signal } = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
  if (error) throw error;
  if (signal) console.error(`[ashub] ${path.basename(script)} terminated by ${signal}`);
  if (status !== 0) process.exit(status ?? 1);
}

run(path.join(__dirname, 'patch-agent-sh.cjs'));

// A production install has no local builder; an ancestor/PATH builder may
// belong to an unrelated project. NODE_ENV is not proof that dev deps were omitted.
const builder = path.join(root, 'node_modules', 'electron-builder');
if (!lstatSync(builder, { throwIfNoEntry: false })) {
  console.log('[ashub] electron-builder not installed locally; skipping desktop native dependency rebuild.');
} else {
  // A present but broken package must fail, not look like an omitted dev dependency.
  const { bin } = require(path.join(builder, 'package.json'));
  const entry = typeof bin === 'string' ? bin : bin?.['electron-builder'];
  if (typeof entry !== 'string' || !entry) throw Error('Local electron-builder package has no CLI entry.');
  // Execute the same CLI as the original npm script, without POSIX or .cmd shims.
  run(path.resolve(builder, entry), ['install-app-deps']);
}
