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

const fetchEntries = async (subdir) => {
  const sid = currentSessionId();
  const url = subdir
    ? `/${sid}/files?subdir=${encodeURIComponent(subdir)}`
    : `/${sid}/files`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const data = await r.json();
  return data.files || [];
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
