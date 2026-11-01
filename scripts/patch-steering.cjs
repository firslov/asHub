// Identity-aware withdrawal for the pinned kernel's existing safe-boundary steering.
const fs = require('node:fs'), path = require('node:path');
const patch = require('./patches/steering-ids.json');
function apply(root = path.resolve(__dirname, '../node_modules/agent-sh')) {
  const updates = patch.files.map(entry => {
    const file = path.join(root, entry.path); let source = fs.readFileSync(file, 'utf8'), changed = false;
    for (const {before, after, previous} of entry.hunks) {
      if (source.split(after).length === 2) continue;
      const from = previous && source.split(previous).length === 2 ? previous : before;
      if (source.split(from).length !== 2) throw Error(`Cannot apply steering patch to ${entry.path}; review the kernel update.`);
      source = source.replace(from, after); changed = true;
    }
    return changed ? {file, source} : null;
  });
  for (const update of updates) if (update) fs.writeFileSync(update.file, update.source);
  return updates.filter(Boolean).length;
}
module.exports = {apply};
if (require.main === module) console.log(`Steering identity patch: ${apply() ? 'applied' : 'verified'}`);
