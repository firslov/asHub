// Math extraction & rendering.
//
// Delimiter pairs supported:
//   Inline  : $...$        — pandoc-strict pairing rules (see below).
//   Inline  : \( ... \)    — permissive.
//   Display : $$ ... $$    — permissive (may span lines).
//   Display : \[ ... \]    — permissive (may span lines).
//
// Math inside fenced (```...```) and inline (`...`) code is left untouched.
//
// Pipeline:
//   1. extractMath(raw) replaces each math span with an empty placeholder
//      <span class="math-tex" data-tex="...">.  Placeholders survive marked
//      + DOMPurify untouched (no markdown-significant chars in attributes).
//   2. renderMathIn(root) walks the DOM and substitutes KaTeX HTML.
//
// Pairing rules for $...$:
//   - Opener `$`:  char before must NOT be alphanumeric/underscore (rules
//                  out `0.31$)` becoming a stray opener after a real
//                  closer).  Char after must NOT be whitespace (pandoc).
//                  (Pandoc also forbids digit-after, but that drops
//                  legit math like `$0.87 \pm 0.31$`; we let KaTeX
//                  validation be the arbiter instead.)
//   - Closer `$`:  char before must NOT be whitespace (pandoc).
//                  Char after must NOT be a digit (pandoc).
//   - Content on one line, non-empty, ≤ MAX_INLINE_LEN chars.
//
// To prevent stray `$` symbols from swallowing prose into "math", every
// candidate is validated by KaTeX (throwOnError: true).  If KaTeX rejects
// the content the candidate is dropped and the leading `$` is emitted as
// literal text — the walker then re-tries the remaining input, so a real
// math span later in the same line still gets a chance to match.
//
// Validation results are cached so chunk-by-chunk streaming doesn't pay
// the render cost on every frame.

const MAX_INLINE_LEN = 250;
const MAX_DISPLAY_LEN = 2000;

const escapeAttr = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const findCloseDollarDollar = (src, start) => {
  for (let i = start; i < src.length - 1; i++) {
    if (src[i] === "\\") { i++; continue; }
    if (src[i] === "$" && src[i + 1] === "$") return i;
  }
  return -1;
};

const findCloseInlineDollar = (src, start) => {
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "\n") return -1;
    if (c === "\\") { i++; continue; }
    if (c === "$") {
      if (src[i + 1] === "$") return -1;
      if (/\s/.test(src[i - 1] || "")) continue;
      if (/\d/.test(src[i + 1] || "")) continue;
      if (i === start) return -1;
      return i;
    }
  }
  return -1;
};

const findCloseEscape = (src, start, closeCh) => {
  for (let i = start; i < src.length - 1; i++) {
    if (src[i] === "\\" && src[i + 1] === closeCh) return i;
  }
  return -1;
};

const inlinePlaceholder = (tex) =>
  `<span class="math-tex" data-tex="${escapeAttr(tex)}"></span>`;

const displayPlaceholder = (tex) =>
  `\n\n<span class="math-tex" data-display="1" data-tex="${escapeAttr(tex)}"></span>\n\n`;

const skipFencedCode = (src, i) => {
  let runLen = 0;
  const runStart = i;
  while (i < src.length && src[i] === "`") { runLen++; i++; }
  if (runLen >= 3) {
    const closeRe = new RegExp("\\n[ \\t]{0,3}`{" + runLen + ",}[ \\t]*(?:\\n|$)");
    const m = closeRe.exec(src.slice(i));
    const end = m ? i + m.index + m[0].length : src.length;
    return { text: src.slice(runStart, end), next: end };
  }
  let j = i;
  while (j < src.length) {
    if (src[j] === "`") {
      let k = j;
      while (k < src.length && src[k] === "`") k++;
      if (k - j === runLen) { j = k; break; }
      j = k;
    } else j++;
  }
  return { text: src.slice(runStart, j), next: j };
};

// Cache key: "D|<tex>" or "I|<tex>".  Value: rendered HTML string, or null
// (KaTeX rejected the input — treat as not-math).
const renderCache = new Map();

const cacheKey = (tex, display) => (display ? "D|" : "I|") + tex;

// Returns: html string on success, null on KaTeX rejection, undefined if
// KaTeX is not available (caller may decide whether to accept without
// validation — used by unit tests in node).
const tryRender = (tex, display) => {
  if (typeof window === "undefined" || !window.katex) return undefined;
  const key = cacheKey(tex, display);
  if (renderCache.has(key)) return renderCache.get(key);
  let html;
  try {
    html = window.katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
    });
  } catch {
    html = null;
  }
  renderCache.set(key, html);
  return html;
};

const validateCandidate = (tex, display) => {
  const maxLen = display ? MAX_DISPLAY_LEN : MAX_INLINE_LEN;
  if (tex.length === 0 || tex.length > maxLen) return false;
  const result = tryRender(tex, display);
  if (result === undefined) return true;  // no validator available — accept
  return result !== null;
};

export const extractMath = (src) => {
  if (!src) return "";
  let out = "";
  let i = 0;
  const len = src.length;

  while (i < len) {
    const ch = src[i];

    if (ch === "`") {
      const { text, next } = skipFencedCode(src, i);
      out += text;
      i = next;
      continue;
    }

    if (ch === "\\") {
      const next = src[i + 1];
      if (next === "(") {
        const end = findCloseEscape(src, i + 2, ")");
        if (end !== -1) {
          const content = src.slice(i + 2, end);
          if (validateCandidate(content, false)) {
            out += inlinePlaceholder(content);
            i = end + 2;
            continue;
          }
        }
      }
      if (next === "[") {
        const end = findCloseEscape(src, i + 2, "]");
        if (end !== -1) {
          const content = src.slice(i + 2, end);
          if (validateCandidate(content, true)) {
            out += displayPlaceholder(content);
            i = end + 2;
            continue;
          }
        }
      }
      out += ch;
      if (next != null) { out += next; i += 2; } else { i++; }
      continue;
    }

    if (ch === "$") {
      if (src[i + 1] === "$") {
        const end = findCloseDollarDollar(src, i + 2);
        if (end !== -1) {
          const content = src.slice(i + 2, end);
          if (validateCandidate(content, true)) {
            out += displayPlaceholder(content);
            i = end + 2;
            continue;
          }
        }
      }
      const before = src[i - 1];
      const after = src[i + 1];
      const openerOk =
        after && after !== "$" &&
        !/\s/.test(after) &&
        !/[A-Za-z0-9_]/.test(before || "");
      if (openerOk) {
        const end = findCloseInlineDollar(src, i + 1);
        if (end !== -1) {
          const content = src.slice(i + 1, end);
          if (validateCandidate(content, false)) {
            out += inlinePlaceholder(content);
            i = end + 1;
            continue;
          }
        }
      }
      out += ch;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
};

export const renderMathIn = (root) => {
  if (!root || typeof window === "undefined" || !window.katex) return;
  const nodes = root.querySelectorAll(".math-tex[data-tex]");
  for (const node of nodes) {
    if (node.dataset.rendered === "1") continue;
    const tex = node.dataset.tex || "";
    const display = node.dataset.display === "1";
    const cached = renderCache.get(cacheKey(tex, display));
    if (typeof cached === "string") {
      node.innerHTML = cached;
      node.dataset.rendered = "1";
      continue;
    }
    if (cached === null) {
      // Validator rejected — extractMath shouldn't have emitted a
      // placeholder.  Bail to literal as a defensive fallback.
      node.classList.add("math-error");
      node.textContent = display ? `$$${tex}$$` : `$${tex}$`;
      continue;
    }
    try {
      const html = window.katex.renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml",
      });
      renderCache.set(cacheKey(tex, display), html);
      node.innerHTML = html;
      node.dataset.rendered = "1";
    } catch {
      node.classList.add("math-error");
      node.textContent = display ? `$$${tex}$$` : `$${tex}$`;
    }
  }
};
