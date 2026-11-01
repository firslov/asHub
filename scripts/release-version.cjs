#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

function validateVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Release version must be X.Y.Z without a prefix or suffix');
  }
  return version;
}
// Every validation and packaging job applies this same metadata-only change.
// No npm lifecycle hooks, dependency updates, git writes or network access.
function applyVersion(root, version) {
  validateVersion(version);
  const packageFile = path.join(root, 'package.json'), lockFile = path.join(root, 'package-lock.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  if (!lock.packages?.[''] || lock.name !== pkg.name) throw new Error('Package lock does not match the release package');
  pkg.version = lock.version = lock.packages[''].version = version;
  fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
}
module.exports = { validateVersion, applyVersion };
if (require.main === module) {
  const version = validateVersion(process.env.ASHUB_RELEASE_VERSION);
  if (!process.argv.includes('--check')) applyVersion(process.cwd(), version);
  console.log(`Release version: ${version}`);
}
