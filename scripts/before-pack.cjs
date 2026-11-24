const path = require('node:path');
const { execFileSync } = require('node:child_process');
const prepared = new WeakSet();

module.exports = async context => {
  const project = context.packager.projectDir;
  require('./patch-agent-sh.cjs').apply(path.join(project, 'node_modules/agent-sh'));
  await require('./mac-ripgrep.cjs').beforePack(context);
  // Both macOS architectures use the same universal helper. Build once per
  // electron-builder run, before either architecture copies its app files.
  const build = context.packager.info;
  if (context.electronPlatformName !== 'darwin' || prepared.has(build)) return;
  const plugin = path.join(project, 'examples/extensions/desktop-control');
  execFileSync(process.execPath, [path.join(plugin, 'scripts/build-capture.mjs')], { cwd: plugin, stdio: 'inherit' });
  prepared.add(build);
};
