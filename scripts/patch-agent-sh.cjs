#!/usr/bin/env node
// agent-sh 0.16.1 still needs the Windows login and steering compatibility fixes.
const fs = require('node:fs');
const path = require('node:path');
const patch = require('./patches/codex-windows-login.json');
function apply(root = path.resolve(__dirname, '../node_modules/agent-sh'), spec = patch, label = 'Codex Windows login') {
  // Validate every target before touching any file. Unknown upstream code must
  // fail the build instead of silently shipping an unpatched authentication path.
  const updates = spec.files.map(({ path: relative, before, after, previous }) => {
    const file = path.join(root, relative);
    const source = fs.readFileSync(file, 'utf8');
    if (source.split(after).length === 2 && !source.includes(before)) return null;
    const candidates = Array.isArray(previous) ? previous : previous ? [previous] : [];
    const from = candidates.find(version => source.includes(version)) ?? before;
    if (source.split(from).length !== 2 || source.includes(after)) {
      throw new Error(`Cannot apply ${label} patch to ${relative}; review the kernel update.`);
    }
    return { file, source: source.replace(from, after) };
  });
  for (const update of updates) if (update) fs.writeFileSync(update.file, update.source);
  return updates.filter(Boolean).length;
}
module.exports = { apply };
if (require.main === module) {
  const count = apply();
  apply(undefined, require('./patches/provider-startup.json'), 'provider startup');
  const hunks = require('./patch-steering.cjs');
  hunks.apply();
  hunks.apply(undefined, require('./patches/provider-refresh.json'), 'provider refresh');
  console.log(`Codex Windows login patch: ${count ? 'applied' : 'verified'}`);
}
