import { currentSessionId } from "./state.js";
import { attachAutocomplete } from "./autocomplete.js";

const getActiveAtToken = (el) => {
  const v = el.value;
  const cur = el.selectionStart ?? v.length;
  let i = cur;
  while (i > 0) {
    const ch = v[i - 1];
    if (/\s/.test(ch)) return null;
    if (ch === "@") {
      const before = i - 2 >= 0 ? v[i - 2] : "";
      if (i - 2 < 0 || /\s/.test(before)) {
        return { start: i - 1, end: cur, query: v.slice(i, cur) };
      }
      return null;
    }
    i--;
  }
  return null;
};

// Directory listings keyed by `${sessionId}:${subdir}`.  Typing a path like
// "@src/comp" refetches the same subdir listing on every keystroke without
// this; the debounce + abort in attachAutocomplete only thin the request
// rate.  Bounded LRU — a session switch naturally changes the key prefix.
// Entries expire after TTL so files created mid-session show up without a
// full page reload.
const DIR_CACHE_MAX = 50;
const DIR_CACHE_TTL = 30 * 1000;
const dirCache = new Map();

// Turn boundary: the agent may have written files this turn, so drop that
// session's cached listings — the next @ refetches them. The event carries
// no detail today; fall back to the current session (the only one @ reads).
document.addEventListener("sse:processing-change", (ev) => {
  const sid = ev.detail?.sessionId ?? ev.detail?.sid ?? currentSessionId();
  if (!sid) { dirCache.clear(); return; }
  const prefix = `${sid}:`;
  for (const key of dirCache.keys()) {
    if (key.startsWith(prefix)) dirCache.delete(key);
  }
});

const fetchEntries = async (subdir) => {
  const sid = currentSessionId();
  const key = `${sid}:${subdir}`;
  if (dirCache.has(key)) {
    const cached = dirCache.get(key);
    if (Date.now() - cached.ts <= DIR_CACHE_TTL) {
      // Re-insert to mark as most-recently-used.
      dirCache.delete(key);
      dirCache.set(key, cached);
      return cached.files;
    }
    dirCache.delete(key);
  }
  const url = subdir
    ? `/${sid}/files?subdir=${encodeURIComponent(subdir)}`
    : `/${sid}/files`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  const files = data.files || [];
  dirCache.set(key, { files, ts: Date.now() });
  while (dirCache.size > DIR_CACHE_MAX) {
    dirCache.delete(dirCache.keys().next().value);
  }
  return files;
};

export const attachAtMentionAutocomplete = (inputEl) => {
  return attachAutocomplete({
    inputEl,
    listEl: document.getElementById("autocomplete"),
    shouldOpen: () => {
      if (!currentSessionId()) return false;
      if (inputEl.value.trimStart().startsWith("/")) return false;
      return getActiveAtToken(inputEl) != null;
    },
    fetcher: async () => {
      const tok = getActiveAtToken(inputEl);
      if (!tok) return [];
      const lastSlash = tok.query.lastIndexOf("/");
      const subdir = lastSlash === -1 ? "" : tok.query.slice(0, lastSlash);
      const prefix = (lastSlash === -1 ? tok.query : tok.query.slice(lastSlash + 1)).toLowerCase();
      const files = await fetchEntries(subdir);
      const toItem = (f) => ({
        name: f.name + (f.kind === "dir" ? "/" : ""),
        description: f.kind === "dir" ? "dir" : "",
        kind: f.kind,
        rawName: f.name,
        subdir,
      });
      if (!prefix) return files.slice(0, 50).map(toItem);
      // Partial (substring) match so a query like "成绩" surfaces
      // "张三的成绩单.xlsx".  Rank prefix matches first, then by earliest
      // match position, then alphabetically for a stable order.
      return files
        .map((f) => ({ f, lower: f.name.toLowerCase() }))
        .filter((x) => x.lower.includes(prefix))
        .sort((a, b) => {
          const sa = a.lower.startsWith(prefix) ? 0 : 1;
          const sb = b.lower.startsWith(prefix) ? 0 : 1;
          if (sa !== sb) return sa - sb;
          const pa = a.lower.indexOf(prefix);
          const pb = b.lower.indexOf(prefix);
          if (pa !== pb) return pa - pb;
          return a.lower.localeCompare(b.lower);
        })
        .slice(0, 50)
        .map((x) => toItem(x.f));
    },
    accept: (it) => {
      const tok = getActiveAtToken(inputEl);
      if (!tok) return;
      const path = (it.subdir ? it.subdir + "/" : "") + it.rawName;
      const trail = it.kind === "dir" ? "/" : " ";
      const insertion = "@" + path + trail;
      const v = inputEl.value;
      inputEl.value = v.slice(0, tok.start) + insertion + v.slice(tok.end);
      const newCur = tok.start + insertion.length;
      inputEl.setSelectionRange(newCur, newCur);
    },
  });
};
