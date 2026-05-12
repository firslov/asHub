import { t } from "./i18n.js";
import { extractMath, renderMathIn } from "./math.js";

marked.setOptions({ breaks: true, gfm: true });

export const escape = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

export const mdToHtml = (raw) =>
  DOMPurify.sanitize(marked.parse(extractMath(String(raw ?? ""))));

export { renderMathIn };

export const highlightWithin = (root) => {
  if (!window.hljs || !root) return;
  root.querySelectorAll("pre code").forEach((el) => {
    if (el.dataset.highlighted) return;
    try { window.hljs.highlightElement(el); el.dataset.highlighted = "1"; } catch {}
    // Add copy button to code blocks
    const pre = el.parentElement;
    if (pre && pre.tagName === "PRE" && !pre.querySelector(".code-copy-btn")) {
      const btn = document.createElement("button");
      btn.className = "code-copy-btn";
      btn.title = t("copy");
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1"/><path d="M8 4V2.5A1.5 1.5 0 0 0 6.5 1h-3A1.5 1.5 0 0 0 2 2.5v3A1.5 1.5 0 0 0 3.5 7H4"/></svg>`;
      btn.addEventListener("click", () => copyToClipboard(el.textContent || "", btn));
      pre.appendChild(btn);
    }
  });
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
