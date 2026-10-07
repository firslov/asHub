// Quoted mentions keep whitespace inside a path distinct from prose:
// @src/app.js, @"My Project/read me.md".
export const getActiveAtToken = (el) => {
  const value = el.value;
  const cursor = el.selectionStart ?? value.length;
  for (let start = 0; start < cursor; start++) {
    if (value[start] !== "@" || (start > 0 && !/\s/.test(value[start - 1]))) continue;
    const quoted = value[start + 1] === '"';
    const from = start + (quoted ? 2 : 1);
    let end = from;
    while (end < value.length) {
      if (quoted && value[end] === "\\" && end + 1 < value.length) { end += 2; continue; }
      if (quoted ? value[end] === '"' : /\s/.test(value[end])) break;
      end++;
    }
    if (cursor >= from && cursor <= end) {
      const prefix = value.slice(from, cursor);
      let query = prefix;
      if (quoted) {
        try { query = JSON.parse('"' + prefix + '"'); }
        catch { return null; } // An unfinished escape is not a filesystem path yet.
      }
      return { start, end: quoted && value[end] === '"' ? end + 1 : end, query };
    }
    start = end;
  }
  return null;
};

export const formatFileMention = (path, directory = false) => {
  const target = path + (directory ? "/" : "");
  const quoted = /[\s"\\]/.test(target);
  const text = "@" + (quoted ? JSON.stringify(target) : target) + (directory ? "" : " ");
  return { text, cursor: text.length - (directory && quoted ? 1 : 0) };
};
