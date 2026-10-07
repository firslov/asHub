import { currentSessionId } from "./state.js";
import { attachAutocomplete } from "./autocomplete.js";

import { getActiveAtToken, formatFileMention } from "./file-mention.js";

// Directory listings keyed by `${sessionId}:${subdir}`.  Typing a path like
// "@src/comp" refetches the same subdir listing on every keystroke without
// this; the debounce + abort in attachAutocomplete only thin the request
// rate.  Bounded LRU — a session switch naturally changes the key prefix.
// Entries expire after TTL so files created mid-session show up without a
// full page reload.
const DIR_CACHE_MAX = 50;
const DIR_CACHE_TTL = 30 * 1000;
const dirCache = new Map();
const directoryGenerations = new Map();
const generationFor = sid => directoryGenerations.get(sid) ?? 0;

// Turn boundary: the agent may have written files this turn, so drop that
// session's cached listings — the next @ refetches them. Legacy callers
// without a session ID fall back to the current session.
const invalidateDirectories = (ev) => {
  const sid = ev.detail?.sessionId ?? ev.detail?.sid ?? currentSessionId();
  if (!sid) { dirCache.clear(); directoryGenerations.clear(); return; }
  directoryGenerations.set(sid, generationFor(sid) + 1);
  const prefix = `${sid}:`;
  for (const key of dirCache.keys()) {
    if (key.startsWith(prefix)) dirCache.delete(key);
  }
};
document.addEventListener("sse:processing-change", invalidateDirectories);
document.addEventListener("ash:cwd-change", invalidateDirectories);

const fetchEntries = async (subdir) => {
  const sid = currentSessionId();
  const generation = generationFor(sid);
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
  if (sid !== currentSessionId() || generation !== generationFor(sid)) return [];
  const files = data.files || [];
  dirCache.set(key, { files, ts: Date.now() });
  while (dirCache.size > DIR_CACHE_MAX) {
    dirCache.delete(dirCache.keys().next().value);
  }
  return files;
};

export const attachAtMentionAutocomplete = (inputEl) => {
  const autocomplete = attachAutocomplete({
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
      const sid = currentSessionId();
      const generation = generationFor(sid);
      const files = await fetchEntries(subdir);
      const toItem = (f) => ({
        name: f.name + (f.kind === "dir" ? "/" : ""),
        description: f.kind === "dir" ? "dir" : "",
        kind: f.kind,
        rawName: f.name,
        subdir, sid, generation,
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
      if (it.sid !== currentSessionId() || it.generation !== generationFor(it.sid)) return;
      const tok = getActiveAtToken(inputEl);
      if (!tok) return;
      const path = (it.subdir ? it.subdir + "/" : "") + it.rawName;
      const { text, cursor } = formatFileMention(path, it.kind === "dir");
      const v = inputEl.value;
      inputEl.value = v.slice(0, tok.start) + text + v.slice(tok.end);
      inputEl.setSelectionRange(tok.start + cursor, tok.start + cursor);
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    },
  });
  const refresh = (event) => {
    const sid = event.detail?.sessionId ?? event.detail?.sid ?? currentSessionId();
    if (sid && sid !== currentSessionId()) return;
    autocomplete.close?.();
    if (getActiveAtToken(inputEl)) inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  };
  document.addEventListener("ash:cwd-change", refresh);
  document.addEventListener("sse:processing-change", refresh);
  return autocomplete;
};
