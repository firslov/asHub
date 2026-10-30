#!/usr/bin/env node
// Keep the existing kernel pin; apply only the reviewed Windows login fix.
const fs = require('node:fs');
const path = require('node:path');
const patch = require('./patches/codex-windows-login.json');
function apply(root = path.resolve(__dirname, '../node_modules/agent-sh')) {
  // Validate every target before touching any file. Unknown upstream code must
  // fail the build instead of silently shipping an unpatched authentication path.
  const updates = patch.files.map(({ path: relative, before, after }) => {
    const file = path.join(root, relative);
    const source = fs.readFileSync(file, 'utf8');
    if (source.split(after).length === 2 && !source.includes(before)) return null;
    if (source.split(before).length !== 2 || source.includes(after)) {
      throw new Error(`Cannot apply Codex Windows login patch to ${relative}; review the kernel update.`);
    }
    return { file, source: source.replace(before, after) };
  });
  for (const update of updates) if (update) fs.writeFileSync(update.file, update.source);
  return updates.filter(Boolean).length;
}
module.exports = { apply };
if (require.main === module) {
  const count = apply();
  console.log(`Codex Windows login patch: ${count ? 'applied' : 'verified'}`);
}
