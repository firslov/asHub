const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function directories(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  }
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

function integrations(root = projectRoot, exclude = process.env.ASHUB_EXCLUDE_INTEGRATIONS ?? '') {
  const excluded = new Set(exclude.split(',').map(name => name.trim()).filter(Boolean));
  const source = path.join(root, 'src/builtin-plugins');
  return directories(source).map(name => ({ name, source: path.join(source, name), enabled: !excluded.has(name) }));
}

function pruneDisabledIntegrations(root = projectRoot) {
  const enabled = new Set(integrations(root).filter(item => item.enabled).map(item => item.name));
  const output = path.join(root, 'dist/builtin-plugins');
  for (const name of directories(output)) {
    if (!enabled.has(name)) fs.rmSync(path.join(output, name), { recursive: true, force: true });
  }
}

module.exports = { integrations, projectRoot, pruneDisabledIntegrations };
