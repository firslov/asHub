const path = require('node:path');
const { execFileSync } = require('node:child_process');
const prepared = new WeakSet();
const configured = new WeakSet();

module.exports = async context => {
  const project = context.packager.projectDir;
  const build = context.packager.info;
  if (!configured.has(build)) {
    require('./patch-agent-sh.cjs').applyAll(project);
    require('./builtin-integrations.cjs').pruneDisabledIntegrations(project);
    configured.add(build);
  }
  await require('./mac-ripgrep.cjs').beforePack(context);
  // Both macOS architectures use the same universal helper. Build once per
  // electron-builder run, before either architecture copies its app files.
  if (context.electronPlatformName !== 'darwin' || prepared.has(build)) return;
  const plugin = path.join(project, 'examples/extensions/desktop-control');
  execFileSync(process.execPath, [path.join(plugin, 'scripts/build-capture.mjs')], { cwd: plugin, stdio: 'inherit' });
  prepared.add(build);
};
