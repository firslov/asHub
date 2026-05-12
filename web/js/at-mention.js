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
      return files
        .filter((f) => f.name.toLowerCase().startsWith(prefix))
        .slice(0, 50)
        .map((f) => ({
          name: f.name + (f.kind === "dir" ? "/" : ""),
          description: f.kind === "dir" ? "dir" : "",
          kind: f.kind,
          rawName: f.name,
          subdir,
        }));
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
