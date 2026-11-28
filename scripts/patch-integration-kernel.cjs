const fs = require('node:fs');
const path = require('node:path');
const { integrations } = require('./builtin-integrations.cjs');

function discover(project) {
  return integrations(project).flatMap(item => {
    const directory = path.join(item.source, 'kernel-patches');
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name).sort()
      .map(name => ({ enabled: item.enabled, label: `${item.name}/${name}`,
        spec: JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) }));
  });
}

function target(kernel, relative) {
  const file = path.resolve(kernel, relative);
  const inside = path.relative(kernel, file);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error(`Invalid integration patch path: ${relative}`);
  }
  return file;
}

function plan(kernel, patches, reverse = false) {
  const edits = new Map();
  for (const { label, spec } of patches) {
    for (const { path: relative, hunks } of spec.files) {
      if (!edits.has(relative)) {
        const before = fs.readFileSync(target(kernel, relative), 'utf8');
        edits.set(relative, { relative, before, after: before });
      }
      const edit = edits.get(relative);
      for (const { before, after } of reverse ? [...hunks].reverse() : hunks) {
        const from = reverse ? after : before;
        const to = reverse ? before : after;
        const matches = edit.after.split(from).length - 1;
        if (reverse && !matches) continue;
        if (!reverse && edit.after.split(to).length === 2) continue;
        if (matches !== 1) throw new Error(`Cannot ${reverse ? 'undo' : 'apply'} ${label} patch to ${relative}; review the kernel update.`);
        edit.after = edit.after.replace(from, () => to);
      }
    }
  }
  return [...edits.values()].filter(edit => edit.before !== edit.after);
}

function configure(project, kernel, applyRequired) {
  const patches = discover(project);
  // Keep rollback data alongside (not inside) the packaged kernel. It survives
  // removal of an integration source directory but not a fresh npm ci.
  const journal = path.join(path.dirname(kernel), '.ashub-integration-kernel.json');
  if (fs.existsSync(journal)) {
    const previous = JSON.parse(fs.readFileSync(journal, 'utf8'));
    const restore = previous.filter(({ relative, before, after }) => {
      const current = fs.readFileSync(target(kernel, relative), 'utf8');
      if (current === before) return false; // Also handles interrupted writes.
      if (current === after) return true;
      throw new Error(`Cannot restore modified kernel file ${relative}; reinstall dependencies with npm ci.`);
    });
    for (const edit of restore) fs.writeFileSync(target(kernel, edit.relative), edit.before);
  } else {
    // Adopt legacy installs that applied optional hunks before rollback data
    // existed. Undo in reverse order, then let the required patches revalidate.
    for (const edit of plan(kernel, [...patches].reverse(), true)) {
      fs.writeFileSync(target(kernel, edit.relative), edit.after);
    }
  }
  const count = applyRequired();
  const edits = plan(kernel, patches.filter(patch => patch.enabled));
  // Record the complete plan before writing any patched file. Existing required
  // hunks, including ones shared by optional patches, remain in the baseline.
  if (edits.length || fs.existsSync(journal)) {
    const temporary = `${journal}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(edits));
    fs.renameSync(temporary, journal);
  }
  for (const edit of edits) fs.writeFileSync(target(kernel, edit.relative), edit.after);
  return count;
}

module.exports = { configure };
