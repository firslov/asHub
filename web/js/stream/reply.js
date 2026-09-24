import { mdToHtml, highlightWithin, renderMathIn, stripAnsi } from "../utils.js";
import { append } from "./tool-group.js";
import { maybeScroll } from "./scroll.js";
import { t } from "../i18n.js";

const COPY_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="7" height="7" rx="1"/><path d="M8 4V2.5A1.5 1.5 0 0 0 6.5 1h-3A1.5 1.5 0 0 0 2 2.5v3A1.5 1.5 0 0 0 3.5 7H4"/></svg>';
const CHECK_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="2 6 5 9 10 2"/></svg>';

export const addReplyCopyBtn = (el, text) => {
  if (el.querySelector(".reply-copy-btn")) return;
  const btn = document.createElement("button");
  btn.className = "reply-copy-btn";
  btn.title = t("copy");
  btn.innerHTML = COPY_ICON_SVG;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.classList.add("copied");
      btn.innerHTML = CHECK_ICON_SVG;
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.innerHTML = COPY_ICON_SVG;
      }, 1200);
    } catch (e) { console.error("clipboard", e); }
  });
  el.appendChild(btn);
};

const HIGHLIGHT_DEBOUNCE_MS = 100; // re-highlight at most 10×/second during streaming

/**
 * Adaptive throttle: longer text benefits from longer intervals since
 * each parse costs more.  50ms for short text keeps the rendering snappy;
 * stepping up for longer text keeps the main thread responsive.  Very long
 * replies (>30k chars) parse 3×/s or less — full-text markdown + math +
 * sanitize is O(n) per flush, so the extra wait is invisible but the saved
 * main-thread time is what keeps typing/scrolling smooth elsewhere.
 */
const throttleFor = (textLen) => {
  if (textLen < 5000) return 50;
  if (textLen < 10000) return 100;
  if (textLen < 30000) return 200;
  if (textLen < 60000) return 350;
  return 500;
};

// marked emits <pre><code class="language-x"> — the language class lives on
// the <code>, the <pre> itself never carries one.
const _blockClass = (b) =>
  b.tagName === "PRE" ? (b.querySelector("code")?.className ?? "") : b.className;

// Just the language token ("language-x"), ignoring extra classes hljs adds
// to already-highlighted live blocks.
const _blockLang = (b) => _blockClass(b).match(/language-[\w+-]+/)?.[0] ?? "";

// Structural class identity between a live and a freshly parsed block.
const _sameBlockClass = (live, fresh) =>
  live.tagName === "PRE" ? _blockLang(live) === _blockLang(fresh) : live.className === fresh.className;

const _structKey = (blocks) => {
  let s = String(blocks.length);
  for (const b of blocks) {
    s += "|" + b.tagName;
    // Distinguish code-block languages so Python→JavaScript IS structural.
    const lang = _blockLang(b);
    if (lang) s += ":" + lang;
  }
  return s;
};

// Content comparison that ignores post-processing artifacts (hljs spans,
// code copy buttons, rendered KaTeX) so already-processed blocks are not
// rewritten — and re-highlighted — on every flush.
const _blockContentEqual = (live, fresh) => {
  if (live.tagName === "PRE") {
    // Highlighting only wraps text in spans and the copy button sits outside
    // <code>, so the raw code text is the stable thing to compare.
    const liveCode = live.querySelector("code");
    const freshCode = fresh.querySelector("code");
    return (liveCode?.textContent ?? "") === (freshCode?.textContent ?? "");
  }
  // Normalize rendered math placeholders back to their pristine form so
  // substituted KaTeX HTML doesn't count as a content change.
  const clone = live.cloneNode(true);
  for (const m of clone.querySelectorAll(".math-tex")) {
    m.innerHTML = "";
    m.classList.remove("math-error");
    delete m.dataset.rendered;
  }
  return clone.innerHTML === fresh.innerHTML;
};

/**
 * Whether the last fenced code block in `text` is still open.
 * Follows CommonMark: an opener is a line starting (after ≤3 spaces) with
 * ≥3 backticks or tildes plus an optional info string (a backtick fence's
 * info string may not contain backticks).  A closer is a line of the SAME
 * fence character, at LEAST as long as the opener, with no info string —
 * so a ``` line inside a ```` fence, or a ```js line inside a ``` fence,
 * is content, not a closer.
 */
const _tailFenceOpen = (text) => {
  let fence = null; // { ch, len } of the open fence
  for (const line of text.split("\n")) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!m) continue;
    const rest = m[2];
    if (!fence) {
      // ```foo`bar — backtick in the info string → not an opener (CommonMark).
      if (m[1][0] === "`" && rest.includes("`")) continue;
      fence = { ch: m[1][0], len: m[1].length };
    } else if (m[1][0] === fence.ch && m[1].length >= fence.len && rest.trim() === "") {
      fence = null;
    }
  }
  return fence !== null;
};

/**
 * highlightWithin wrapper for live streaming.
 *
 * Re-highlighting a still-growing <pre> on every flush is O(block size) per
 * pass — and O(languages × size) for an unannotated fence, where hljs falls
 * back to highlightAuto (measured ~300ms for a single ~100KB block).  Since
 * only the tail block whose fence is still open ever changes (the content
 * fingerprint protects closed blocks), defer exactly that one: it streams in
 * as plain text and is highlighted exactly once its fence closes, or by the
 * final closeReply / onReplayDone pass.  Everything else is highlighted
 * immediately as before.  During replay the behavior is unchanged — replayed
 * blocks are batch-processed async in onReplayDone.
 *
 * The deferral works by temporarily marking the tail <code> as highlighted
 * so highlightWithin (and hljs itself) skips it; the marker is removed right
 * after the synchronous pass so the block stays eligible for later passes.
 */
const highlightStreaming = (session) => {
  const r = session.reply;
  if (session.state.replaying) { highlightWithin(r.current); return; }
  const tail = r.current?.lastElementChild;
  const tailCode = tail?.tagName === "PRE" ? tail.querySelector("code") : null;
  const defer = tailCode && !tailCode.dataset.highlighted && _tailFenceOpen(r.text)
    ? tailCode : null;
  if (!defer) { highlightWithin(r.current); return; }
  defer.dataset.highlighted = "pending";
  try {
    highlightWithin(r.current);
  } finally {
    delete defer.dataset.highlighted;
  }
};

const flushReply = (session) => {
  const r = session?.reply;
  if (!r) return;
  if (!r.current) { r.pendingChunkRender = false; return; }

  const throttleMs = throttleFor(r.text.length);
  const perfNow = performance.now();
  if (r._lastParseTime && perfNow - r._lastParseTime < throttleMs) {
    if (!r._throttleFlushScheduled) {
      r._throttleFlushScheduled = true;
      // Defer until the throttle window has actually elapsed rather than
      // forcing a parse on the next frame — keeps the 100/200ms tiers real.
      const waitMs = throttleMs - (perfNow - r._lastParseTime);
      setTimeout(() => {
        r._throttleFlushScheduled = false;
        flushReply(session);
      }, waitMs);
    }
    return; // pendingChunkRender stays true → closeReply will flush
  }
  r.pendingChunkRender = false;
  // Skip if text hasn't changed since last parse (common during rapid chunks).
  if (r.text === r._lastParsedText) return;

  r._lastParseTime = perfNow;
  r._lastParsedText = r.text;

  const tmp = document.createElement("div");
  tmp.innerHTML = mdToHtml(r.text);

  const newBlocks = Array.from(tmp.children);
  const prevCount = r._renderedBlockCount ?? 0;
  const newStructKey = _structKey(newBlocks);
  let rebuilt = false; // slow path ran → new blocks need highlighting now

  if (newStructKey === r._lastStructKey && prevCount > 0) {
    // ── Fast path: block structure unchanged ────────────────────────
    // The same blocks exist as before — only their inner content grew.
    // Update innerHTML of each block in-place, then append any new ones.
    // This avoids DOM node removal / creation during streaming.
    const existing = r.current.children;
    let codeChanged = false;
    for (let i = 0; i < newBlocks.length; i++) {
      if (i < existing.length) {
        if (!_blockContentEqual(existing[i], newBlocks[i])) {
          existing[i].innerHTML = newBlocks[i].innerHTML;
          if (existing[i].tagName === "PRE") codeChanged = true;
        }
        // When a code block's language is finally resolved by the parser
        // (e.g. ```python), propagate the class to the live block.  For a
        // <pre> the class belongs to its <code>, not the <pre> itself.
        const newLang = _blockLang(newBlocks[i]);
        if (newLang && newLang !== _blockLang(existing[i])) {
          const liveCode = newBlocks[i].tagName === "PRE" ? existing[i].querySelector("code") : null;
          if (liveCode) liveCode.className = _blockClass(newBlocks[i]);
          else existing[i].className = newBlocks[i].className;
        }
      } else {
        r.current.appendChild(newBlocks[i]);
      }
    }
    // Setting innerHTML on a <pre> wipes hljs spans and the copy button.
    // Re-highlight via highlightStreaming, which skips the still-growing
    // tail block (open fence) so hljs never re-processes it per flush —
    // it is highlighted once its fence closes.  Closed blocks changed here
    // are highlighted immediately (highlightWithin re-injects the button).
    // NOTE: do NOT touch r._lastHighlightAt here — the debounced pass below
    // also renders math, and highlightWithin is idempotent (it skips blocks
    // with data-highlighted), so a same-flush re-run is a cheap no-op while
    // starving the debounce would leave KaTeX placeholders unrendered.
    // During REPLAY, skip like the debounced pass below — a growing fenced
    // block would otherwise get a full sync highlight per flush; replayed
    // sessions are batch-processed async in onReplayDone.
    if (codeChanged && !session.state.replaying) highlightStreaming(session);
  } else {
    // ── Slow path: structure changed / first render ────────────────
    r._lastStructKey = newStructKey;
    rebuilt = true;

    if (prevCount === 0 || newBlocks.length < prevCount) {
      // First render, or block count decreased (e.g. unclosed code fence
      // turned into a real <pre> — structural change). Full replace
      // in a single operation to avoid layout thrashing.
      r.current.replaceChildren(...newBlocks);
    } else {
      // Block-level incremental: keep the unchanged PREFIX, rebuild from
      // the first difference onward.  Changes happen at the tail in
      // streaming (earlier blocks are Markdown-immutable once closed), so
      // a closed block that didn't change keeps its highlight/copy button
      // instead of being rebuilt every time a new block appears.  tagName
      // must be compared too: _blockContentEqual only compares inner
      // content, so a setext heading (p → h1, same text) would otherwise
      // keep the stale <p>.
      const existing = r.current.children;
      const limit = Math.min(existing.length, prevCount, newBlocks.length);
      let keepCount = 0;
      while (keepCount < limit &&
             existing[keepCount].tagName === newBlocks[keepCount].tagName &&
             _sameBlockClass(existing[keepCount], newBlocks[keepCount]) &&
             _blockContentEqual(existing[keepCount], newBlocks[keepCount])) {
        keepCount++;
      }
      while (r.current.children.length > keepCount) {
        r.current.lastChild?.remove();
      }
      for (let i = keepCount; i < newBlocks.length; i++) {
        r.current.appendChild(newBlocks[i]);
      }
    }
  }

  r._renderedBlockCount = newBlocks.length;
  r._renderedLen = r.text.length;

  // Debounce syntax highlighting & math rendering during live streaming.
  // Blocks rebuilt by the slow path are highlighted synchronously instead —
  // highlightWithin skips already-highlighted blocks, so only the fresh
  // ones are processed and never hit the screen un-highlighted.  The one
  // exception is the still-growing tail block (open fence), which
  // highlightStreaming defers until its fence closes.  During REPLAY, skip
  // the forced sync pass: every reply's closeReply lands here, and per-reply
  // sync highlight would block the main thread — replayed sessions are
  // batch-processed async in onReplayDone anyway.
  const now = Date.now();
  if (!session.state.replaying && (rebuilt || !r._lastHighlightAt || now - r._lastHighlightAt >= HIGHLIGHT_DEBOUNCE_MS)) {
    renderMathIn(r.current);
    highlightStreaming(session);
    r._lastHighlightAt = now;
  }

  maybeScroll(session);
};

const scheduleReplyRender = (session) => {
  const r = session?.reply;
  if (!r || r.pendingChunkRender) return;
  r.pendingChunkRender = true;
  requestAnimationFrame(() => flushReply(session));
};

export const hasReply = (session) => (session?.reply.current ?? null) != null;
export const sawLiveSegment = (session) => session?.reply.liveSegment ?? false;
export const startNewSegment = (session) => { const r = session?.reply; if (r) r.liveSegment = false; };

export const appendReplyChunk = (session, delta) => {
  if (!delta || !session) return;
  const r = session.reply;
  if (!r.current) {
    r.current = document.createElement("div");
    r.current.className = "agent-reply streaming";
    r.current.dataset.turn = String(session.state.currentTurn);
    r._renderedLen = 0;
    r._renderedBlockCount = 0;
    r._lastStructKey = "";
    append(session, r.current);
  }
  r.text += stripAnsi(delta);
  r.liveSegment = true;
  scheduleReplyRender(session);
};

export const fillFinalReply = (session, text) => {
  const r = session?.reply;
  if (!r?.current || !text) return;
  const full = stripAnsi(text);
  if (full === r.text) return;
  // Final payload wins over accumulated chunks — heals gaps from SSE reopens.
  r.text = full;
  r._lastStructKey = "";
  r.current.replaceChildren();
  const tmp = document.createElement("div");
  tmp.innerHTML = mdToHtml(r.text);
  const blockCount = tmp.children.length;
  while (tmp.firstChild) r.current.appendChild(tmp.firstChild);
  r._renderedLen = full.length;
  r._renderedBlockCount = blockCount;
  renderMathIn(r.current);
};

export const closeReply = (session) => {
  const r = session?.reply;
  if (!r?.current) return;
  // Guaranteed final parse — bypass throttle to render complete text
  r._throttleFlushScheduled = false;
  r._lastParseTime = 0;
  r._lastParsedText = "";
  flushReply(session);
  r.current.classList.remove("streaming");
  if (r.text === "") {
    r.current.remove();
  } else {
    if (!session.state.replaying) highlightWithin(r.current);
    addReplyCopyBtn(r.current, r.text);
  }
  r.current = null;
  r.text = "";
  r._renderedLen = 0;
  r._renderedBlockCount = 0;
};

export const cancelReply = (session) => {
  const el = session?.reply?.current;
  // Stamp AFTER closeReply: it forces a final flushReply whose slow path
  // (trim-to-keepCount / replaceChildren) would remove a stamp appended
  // beforehand whenever unflushed chunks are pending.
  closeReply(session);
  // closeReply removes the bubble entirely when the reply text was empty.
  if (el && el.isConnected) {
    el.classList.add("cancelled");
    const stamp = document.createElement("span");
    stamp.className = "cancelled-stamp";
    stamp.textContent = t("cancelled");
    el.appendChild(stamp);
  }
};
