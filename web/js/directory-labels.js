// Show the shortest suffix that distinguishes the directories in this view.
export function directoryLabels(paths) {
  const entries = [...new Set(paths.filter(Boolean))].map((path) => {
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path);
    const parts = path.split(windows ? /[\\/]+/ : /\/+/).filter(Boolean);
    return { path, parts, label: parts.at(-1) || path };
  });
  const maxDepth = entries.reduce((max, entry) => Math.max(max, entry.parts.length), 0);
  for (let depth = 1; depth <= maxDepth; depth++) {
    const counts = new Map();
    for (const e of entries) counts.set(e.label, (counts.get(e.label) || 0) + 1);
    if (counts.size === entries.length) break;
    for (const e of entries)
      if (counts.get(e.label) > 1)
        e.label = e.parts.length > depth ? e.parts.slice(-depth - 1).join('/') : e.path;
  }
  return new Map(entries.map((e) => [e.path, e.label]));
}
