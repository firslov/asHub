import { t } from "./i18n.js";
import { extractMath, renderMathIn } from "./math.js";
import { scheduleIdleWork } from "./stream/idle-work.js";

window.marked?.setOptions?.({ breaks: true, gfm: true });

export const escape = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// SGR-only; not a full terminal emulator. Cursor moves, mode sets, OSC are dropped.
const ANSI_SGR_RE = /\x1b\[([0-9;]*)m/g;
const ANSI_OTHER_RE = /\x1b\[[0-9;?]*[A-HJKSTfinsulh]|\x1b\][^\x07]*\x07|\x1b[PX^_].*?\x1b\\|\x1b[()][AB012]/g;
const SGR_FG = {
  30: "black", 31: "red", 32: "green", 33: "yellow",
  34: "blue", 35: "magenta", 36: "cyan", 37: "white",
  90: "bright-black", 91: "bright-red", 92: "bright-green", 93: "bright-yellow",
  94: "bright-blue", 95: "bright-magenta", 96: "bright-cyan", 97: "bright-white",
};
const SGR_BG = {
  40: "black", 41: "red", 42: "green", 43: "yellow",
  44: "blue", 45: "magenta", 46: "cyan", 47: "white",
  100: "bright-black", 101: "bright-red", 102: "bright-green", 103: "bright-yellow",
  104: "bright-blue", 105: "bright-magenta", 106: "bright-cyan", 107: "bright-white",
};
export const ansiToHtml = (raw) => {
  const src = String(raw ?? "").replace(ANSI_OTHER_RE, "");
  if (!src) return "";
  let fg = null, bg = null, bold = false, dim = false, italic = false, underline = false, inverse = false;
  const openSpan = () => {
    const cls = [];
    if (inverse) {
      if (bg) cls.push(`ansi-fg-${bg}`); else cls.push("ansi-fg-inverse");
      if (fg) cls.push(`ansi-bg-${fg}`); else cls.push("ansi-bg-inverse");
    } else {
      if (fg) cls.push(`ansi-fg-${fg}`);
      if (bg) cls.push(`ansi-bg-${bg}`);
    }
    if (bold) cls.push("ansi-bold");
    if (dim) cls.push("ansi-dim");
    if (italic) cls.push("ansi-italic");
    if (underline) cls.push("ansi-underline");
    return cls.length ? `<span class="${cls.join(" ")}">` : "";
  };
  let out = "";
  let spanOpen = "";
  let last = 0;
  const flush = (text) => {
    if (!text) return;
    if (spanOpen) { out += spanOpen + escape(text) + "</span>"; }
    else out += escape(text);
  };
  src.replace(ANSI_SGR_RE, (m, params, idx) => {
    flush(src.slice(last, idx));
    last = idx + m.length;
    const codes = (params || "0").split(";").map((s) => parseInt(s, 10) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { fg = bg = null; bold = dim = italic = underline = inverse = false; }
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 3) italic = true;
      else if (c === 4) underline = true;
      else if (c === 7) inverse = true;
      else if (c === 22) { bold = false; dim = false; }
      else if (c === 23) italic = false;
      else if (c === 24) underline = false;
      else if (c === 27) inverse = false;
      else if (c === 39) fg = null;
      else if (c === 49) bg = null;
      else if (SGR_FG[c]) fg = SGR_FG[c];
      else if (SGR_BG[c]) bg = SGR_BG[c];
      else if (c === 38 || c === 48) {
        // 256-color (skip 2) or truecolor (skip 4) — we don't render these.
        if (codes[i + 1] === 5) i += 2;
        else if (codes[i + 1] === 2) i += 4;
      }
    }
    spanOpen = openSpan();
    return m;
  });
  flush(src.slice(last));
  return out;
};

export const mdToHtml = (raw) => {
  // Fall back to escaped plain text when marked/DOMPurify failed to load.
  if (!window.marked?.parse || !window.DOMPurify?.sanitize) {
    return `<pre>${escape(String(raw ?? ""))}</pre>`;
  }
  return DOMPurify.sanitize(marked.parse(extractMath(String(raw ?? ""))));
};

export { renderMathIn };

/** Highlight a single code element. Extracted so both sync and async paths share it. */
const highlightCodeEl = (el) => {
  try { window.hljs.highlightElement(el); el.dataset.highlighted = "1"; } catch {}
  // Set data-language for CSS badge
  if (!el.dataset.language) {
    for (const c of el.classList) {
      if (c.startsWith("language-")) {
        el.dataset.language = c.slice(9);
        break;
      }
    }
  }
  // Add copy button to code blocks
  const pre = el.parentElement;
  if (pre && pre.tagName === "PRE" && !pre.querySelector(".code-copy-btn")) {
    const btn = document.createElement("button");
    btn.className = "code-copy-btn";
    btn.title = t("copy");
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1"/><path d="M8 4V2.5A1.5 1.5 0 0 0 6.5 1h-3A1.5 1.5 0 0 0 2 2.5v3A1.5 1.5 0 0 0 3.5 7H4"/></svg>`;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(el.textContent || "");
        btn.classList.add("copied");
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6 5 9 10 2"/></svg>`;
        setTimeout(() => {
          btn.classList.remove("copied");
          btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1"/><path d="M8 4V2.5A1.5 1.5 0 0 0 6.5 1h-3A1.5 1.5 0 0 0 2 2.5v3A1.5 1.5 0 0 0 3.5 7H4"/></svg>`;
        }, 1200);
      } catch (e) { console.error("clipboard", e); }
    });
    pre.appendChild(btn);
  }
};

/**
 * Highlight all code blocks within `root`.
 *
 * When `async` is true and there are many blocks (>6), processing is split
 * into small batches via requestIdleCallback so the main thread stays
 * responsive.  Use `async: true` after replay flushes (many blocks at once);
 * use `async: false` (default) for live streaming (one block at a time).
 */
export const highlightWithin = (root, { async: asyncMode = false } = {}) => {
  if (!window.hljs || !root) return;
  const codeBlocks = Array.from(
    root.querySelectorAll("pre code"),
  ).filter((el) => !el.dataset.highlighted);

  if (codeBlocks.length === 0) return;

  if (asyncMode && codeBlocks.length > 6) {
    scheduleIdleWork(codeBlocks, highlightCodeEl, { batchSize: 4 });
  } else {
    codeBlocks.forEach(highlightCodeEl);
  }
};

export const fmtNum = (n) => n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export const HLJS_LANG_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", rs: "rust", go: "go",
  java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cxx: "cpp",
  cs: "csharp", php: "php", lua: "lua", pl: "perl", r: "r",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
  xml: "xml", html: "xml", htm: "xml", svg: "xml",
  css: "css", scss: "scss", less: "less",
  md: "markdown", sql: "sql", dockerfile: "dockerfile",
  vue: "xml", svelte: "xml",
};

export const langForPath = (path) => {
  if (!path) return null;
  const base = path.split(/[\\/]/).pop() ?? "";
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
  return HLJS_LANG_BY_EXT[ext] ?? null;
};

export const highlightDiffLine = (text, lang) => {
  if (!lang || !window.hljs || !text) return escape(text ?? "");
  try { return window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; }
  catch { return escape(text); }
};

export const diffToText = (diff, filePath) => {
  const out = [];
  if (filePath) { out.push(`--- a/${filePath}`); out.push(`+++ b/${filePath}`); }
  for (const hunk of diff.hunks ?? []) {
    out.push("@@");
    for (const line of hunk.lines ?? []) {
      const sign = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
      out.push(sign + (line.text ?? ""));
    }
  }
  return out.join("\n");
};

export const blockToText = (b) => {
  if (!b) return "";
  if (b.type === "text") return b.text ?? "";
  if (b.type === "code-block") return "\n```" + (b.language ?? "") + "\n" + (b.code ?? "") + "\n```\n";
  if (b.type === "raw") return "";
  return "";
};

export const copyToClipboard = async (text, btn) => {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = t("copied");
      setTimeout(() => { btn.textContent = prev; }, 1200);
    }
  } catch (e) { console.error("clipboard", e); }
};

// ── Blob URL helpers ─────────────────────────────────────────────

export function toBlobUrl(data, mimeType) {
  try {
    const bytes = atob(data);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    const blob = new Blob([buf], { type: mimeType });
    return URL.createObjectURL(blob);
  } catch { return ""; }
}
