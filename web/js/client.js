/**
 * Live view of one ash session. Reads its id from /<id>/, subscribes to
 * /<id>/events (SSE), POSTs queries to /<id>/submit, and polls /sessions
 * for the sidebar.
 */
(() => {
  const stream = document.getElementById("stream");
  const conn = document.getElementById("conn");
  const dot = document.querySelector(".live-dot");
  const instanceLabel = document.getElementById("instance");
  const usageEl = document.getElementById("usage");
  const sessionList = document.getElementById("sessions");
  const spinner = document.getElementById("spinner");
  const cancelBtn = document.getElementById("cancel-turn");
  const versionLabel = document.getElementById("version-label");
  let isProcessing = false;
  let isSubmitting = false;
  let currentTurn = -1;       // incremented on each agent:query, used to tag DOM elements

  const setBusy = (b) => {
    isProcessing = b;
    if (spinner) spinner.hidden = !b;
    if (cancelBtn) cancelBtn.hidden = !b;
  };

  const sessionId = (location.pathname.match(/^\/([0-9a-f]{4,32})\/?$/) ?? [])[1] ?? "";
  const eventsUrl = `/${sessionId}/events`;
  const submitUrl = `/${sessionId}/submit`;

  const escape = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

  marked.setOptions({ breaks: true, gfm: true });
  const mdToHtml = (raw) => DOMPurify.sanitize(marked.parse(String(raw ?? "")));
  const highlightWithin = (root) => {
    if (!window.hljs || !root) return;
    root.querySelectorAll("pre code").forEach((el) => {
      if (el.dataset.highlighted) return;
      try { window.hljs.highlightElement(el); el.dataset.highlighted = "1"; } catch {}
    });
  };

  // Auto-scroll only when the user is already pinned to the bottom; otherwise
  // surface a "new output" pill so reading further up isn't yanked away.
  const SCROLL_SLOP = 40;
  const isAtBottom = () =>
    stream.scrollHeight - stream.scrollTop - stream.clientHeight <= SCROLL_SLOP;
  const pill = document.getElementById("scroll-pill");
  let stickToBottom = true;
  const jumpToBottom = () => {
    stream.scrollTo({ top: stream.scrollHeight, behavior: "instant" });
  };
  const scrollToBottom = () => {
    stream.scrollTo({ top: stream.scrollHeight, behavior: "smooth" });
    stickToBottom = true;
    if (pill) pill.hidden = true;
  };
  stream.addEventListener("scroll", () => {
    stickToBottom = isAtBottom();
    if (pill && stickToBottom) pill.hidden = true;
  });
  pill?.addEventListener("click", scrollToBottom);
  const maybeScroll = () => {
    if (stickToBottom) {
      jumpToBottom();
    } else if (pill) {
      pill.hidden = false;
    }
  };

  const emptyState = document.getElementById("stream-empty");
  const hideEmptyState = () => {
    if (emptyState && !emptyState.hidden) emptyState.hidden = true;
  };

  // Clicking the empty-state prompt pill focuses the input.
  document.getElementById("stream-empty-prompt")?.addEventListener("click", () => {
    const inp = document.getElementById("query");
    if (inp) inp.focus();
  });

  const append = (node) => {
    closeToolGroup();
    hideEmptyState();
    stream.appendChild(node);
    maybeScroll();
  };

  // Consecutive tool activity (tool-started rows, tool result bodies,
  // permission diff previews) accumulates into one `.tool-group`. The group
  // closes when text resumes, and once it holds 3+ tool rows it folds behind
  // a "▸ N tools" header (unless the user expanded it).
  const TOOL_GROUP_COLLAPSE = 2;
  const groupState = new WeakMap();
  let currentToolGroup = null;

  const toolCount = (g) => g.querySelectorAll(".tool-row").length;
  const updateToolGroupHead = (g) => {
    const { head } = groupState.get(g);
    const arrow = g.classList.contains("collapsed") ? "▸" : "▾";
    head.textContent = `${arrow} ${toolCount(g)} tools`;
  };
  const openToolGroup = () => {
    if (currentToolGroup) return currentToolGroup;
    const g = document.createElement("div");
    g.className = "tool-group";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "tool-group-head";
    head.hidden = true;
    head.addEventListener("click", () => {
      g.dataset.userToggled = "1";
      g.classList.toggle("collapsed");
      updateToolGroupHead(g);
    });
    const body = document.createElement("div");
    body.className = "tool-group-body";
    g.append(head, body);
    groupState.set(g, { head, body });
    hideEmptyState();
    stream.appendChild(g);
    currentToolGroup = g;
    maybeScroll();
    return g;
  };
  const appendToGroup = (node) => {
    const g = openToolGroup();
    groupState.get(g).body.appendChild(node);
    maybeScroll();
  };
  const bumpToolCount = () => {
    const g = openToolGroup();
    if (toolCount(g) >= TOOL_GROUP_COLLAPSE) {
      groupState.get(g).head.hidden = false;
      if (!g.dataset.userToggled) g.classList.add("collapsed");
      updateToolGroupHead(g);
    }
  };
  const closeToolGroup = () => {
    const g = currentToolGroup;
    if (!g) return;
    currentToolGroup = null;
    // Empty groups (no tools, no diff previews) get garbage-collected.
    // A permission-only group still has the diff in its body; preserve it.
    if (groupState.get(g).body.children.length === 0) { g.remove(); return; }
    if (toolCount(g) >= TOOL_GROUP_COLLAPSE) updateToolGroupHead(g);
  };

  let cwd = "";
  let lastUsage = null;
  let lastQuery = "";
  let contextWindow = 0;
  let currentReply = null;
  let currentReplyText = "";

  // Live tool output: buffer chunks between tool-started and tool-completed
  // so long-running commands (bash, write_file diffs) show real-time progress.
  let liveToolOutput = null;  // { callId, lines, blockEl, rafPending }
  let completedTools = new Set(); // toolCallIds that have completed; ignore stray chunks
  let thinkingBlock = null;   // dim block for agent:thinking-chunk streaming

  // CSS can't transition between an unbounded height and 0, so measure
  // the body's current scrollHeight and animate max-height to/from that.
  const setThinkingCollapsed = (block, collapsed) => {
    const body = block.querySelector(".thinking-block-body");
    if (!body) return;
    const isCollapsed = block.classList.contains("collapsed");
    if (collapsed === isCollapsed) return;
    if (collapsed) {
      body.style.maxHeight = body.scrollHeight + "px";
      body.offsetHeight;
      block.classList.add("collapsed");
      body.style.maxHeight = "0";
    } else {
      body.style.maxHeight = "0";
      block.classList.remove("collapsed");
      body.offsetHeight;
      body.style.maxHeight = body.scrollHeight + "px";
      const onEnd = (ev) => {
        if (ev.propertyName !== "max-height") return;
        body.style.maxHeight = "";
        body.removeEventListener("transitionend", onEnd);
      };
      body.addEventListener("transitionend", onEnd);
    }
  };

  const finalizeThinking = () => {
    if (!thinkingBlock) return;
    const inner = thinkingBlock.querySelector(".thinking-block-inner");
    if (!inner || !inner.textContent?.trim()) {
      thinkingBlock.remove();
    } else {
      const head = thinkingBlock.querySelector(".thinking-block-head");
      if (head) head.textContent = "thought";
      setThinkingCollapsed(thinkingBlock, true);
    }
    thinkingBlock = null;
  };

  const flushLiveOutput = () => {
    if (!liveToolOutput) return;
    liveToolOutput.rafPending = false;
    const el = liveToolOutput.blockEl;
    el.textContent = liveToolOutput.lines.join("\n");
    el.scrollTop = el.scrollHeight;
    maybeScroll();
  };
  const scheduleLiveOutput = () => {
    if (!liveToolOutput || liveToolOutput.rafPending) return;
    liveToolOutput.rafPending = true;
    requestAnimationFrame(flushLiveOutput);
  };

  // Streaming markdown is re-parsed on every chunk, which gets pricey for long
  // replies (O(N²) over the chunk count). RAF-coalesce so we re-render at most
  // once per frame regardless of how fast chunks arrive.
  let pendingChunkRender = false;
  const flushReply = () => {
    pendingChunkRender = false;
    if (!currentReply) return;
    currentReply.innerHTML = mdToHtml(currentReplyText);
    maybeScroll();
  };
  const scheduleReplyRender = () => {
    if (pendingChunkRender) return;
    pendingChunkRender = true;
    requestAnimationFrame(flushReply);
  };

  const closeReply = () => {
    if (!currentReply) return;
    if (pendingChunkRender) flushReply();
    currentReply.classList.remove("streaming");
    if (currentReplyText === "") {
      currentReply.remove();
    } else {
      highlightWithin(currentReply);
    }
    currentReply = null;
    currentReplyText = "";
  };

  const fmtNum = (n) => n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const renderUsage = () => {
    if (!lastUsage) return;
    const inTok = lastUsage.prompt_tokens ?? 0;
    const outTok = lastUsage.completion_tokens ?? 0;
    const cacheHit = lastUsage.prompt_cache_hit_tokens ?? 0;
    const cacheMiss = lastUsage.prompt_cache_miss_tokens ?? 0;
    let pct = 0;
    let ctxText = `${(inTok / 1000).toFixed(1)}k`;
    if (contextWindow > 0) {
      pct = Math.round((inTok / contextWindow) * 100);
      ctxText = `${(inTok / 1000).toFixed(1)}k / ${(contextWindow / 1000).toFixed(0)}k`;
    }
    const totalTok = lastUsage.total_tokens ?? (inTok + outTok);
    const cacheHtml = (cacheHit > 0 || cacheMiss > 0)
      ? `<span class="usage-chip usage-cache" title="cache hit / miss">` +
          `<span class="cache-dot hit"></span>${fmtNum(cacheHit)}` +
          `<span class="cache-sep">/</span>` +
          `<span class="cache-dot miss"></span>${fmtNum(cacheMiss)}` +
        `</span>`
      : "";
    usageEl.innerHTML =
      `<span class="usage-chip" title="input tokens">↑ ${fmtNum(inTok)}</span>` +
      `<span class="usage-chip" title="output tokens">↓ ${fmtNum(outTok)}</span>` +
      `<span class="usage-chip" title="total tokens">Σ ${fmtNum(totalTok)}</span>` +
      cacheHtml +
      `<span class="usage-chip usage-ctx" title="context usage">` +
        (contextWindow > 0
          ? `<span class="usage-bar"><span style="width:${pct}%"></span></span>`
          : "") +
        `${ctxText}${contextWindow > 0 ? ` (${pct}%)` : ""}` +
      `</span>`;
    usageEl.classList.toggle("warm", pct >= 30 && pct < 70);
    usageEl.classList.toggle("hot", pct >= 70);
    const strip = document.getElementById("usage-strip");
    if (strip) strip.hidden = false;
  };

  const renderTurnSep = () => {
    const sep = document.createElement("div");
    sep.className = "turn-sep";
    sep.innerHTML =
      `<span class="turn-line"></span>` +
      (cwd ? `<span class="turn-cwd">${escape(cwd)}</span>` : "") +
      `<span class="turn-time">${new Date().toLocaleTimeString()}</span>` +
      `<span class="turn-line"></span>`;
    append(sep);
    return sep;
  };

  let thinkingEl = null;
  const showThinking = () => {
    if (thinkingEl) return;
    thinkingEl = document.createElement("div");
    thinkingEl.className = "thinking";
    thinkingEl.innerHTML =
      `<span class="thinking-dot"></span>` +
      `<span class="thinking-dot"></span>` +
      `<span class="thinking-dot"></span>` +
      `<span class="thinking-label">thinking…</span>`;
    // Insert directly into stream — don't use append(), which would
    // close the current tool group and break grouping of consecutive tools.
    hideEmptyState();
    stream.appendChild(thinkingEl);
    maybeScroll();
  };
  const hideThinking = () => {
    if (!thinkingEl) return;
    thinkingEl.remove();
    thinkingEl = null;
  };

  const renderErrorCard = (message, detail) => {
    const card = document.createElement("div");
    card.className = "err-card";
    const head = document.createElement("div");
    head.className = "err-card-head";
    head.innerHTML =
      `<span class="err-card-icon">!</span>` +
      `<span class="err-card-title">${escape(message || "Error")}</span>`;
    card.appendChild(head);
    const detailText = String(detail ?? "").trim();
    if (detailText) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "err-card-toggle";
      toggle.textContent = "show details";
      head.appendChild(toggle);
      const body = document.createElement("pre");
      body.className = "err-card-body";
      body.textContent = detailText;
      body.hidden = true;
      toggle.addEventListener("click", () => {
        body.hidden = !body.hidden;
        toggle.textContent = body.hidden ? "show details" : "hide details";
      });
      card.appendChild(body);
    }
    return card;
  };

  const renderPromptRow = () => {
    if (!cwd) return;
    const row = document.createElement("div");
    row.className = "pl-row";
    row.innerHTML =
      `<span class="pl-left"><span class="pl-path">${escape(cwd)}</span></span>` +
      `<span class="pl-right"><span class="pl-seg pl-time">${new Date().toLocaleTimeString()}</span></span>`;
    append(row);
  };

  const copyToClipboard = async (text, btn) => {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const prev = btn.textContent;
        btn.textContent = "copied";
        setTimeout(() => { btn.textContent = prev; }, 1200);
      }
    } catch (e) { console.error("clipboard", e); }
  };

  const diffToText = (diff, filePath) => {
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

  const HLJS_LANG_BY_EXT = {
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
  const langForPath = (path) => {
    if (!path) return null;
    const base = path.split(/[\\/]/).pop() ?? "";
    if (base.toLowerCase() === "dockerfile") return "dockerfile";
    const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
    return HLJS_LANG_BY_EXT[ext] ?? null;
  };
  const highlightDiffLine = (text, lang) => {
    if (!lang || !window.hljs || !text) return escape(text ?? "");
    try { return window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; }
    catch { return escape(text); }
  };

  const renderDiffBlock = (diff, filePath) => {
    const wrap = document.createElement("div");
    wrap.className = "diff-block";
    const lang = langForPath(filePath);
    const head = document.createElement("div");
    head.className = "diff-head";
    const sign = `+${diff.added ?? 0} -${diff.removed ?? 0}`;
    head.innerHTML =
      `<span class="diff-path">${escape(filePath ?? "")}</span>` +
      `<span class="diff-stat">${sign}</span>` +
      `<span class="diff-actions">` +
        `<button class="diff-btn diff-wrap" title="toggle wrap">wrap</button>` +
        `<button class="diff-btn diff-copy" title="copy patch">copy</button>` +
      `</span>`;
    wrap.appendChild(head);
    head.querySelector(".diff-wrap").addEventListener("click", () => {
      wrap.classList.toggle("wrapped");
    });
    head.querySelector(".diff-copy").addEventListener("click", (ev) => {
      copyToClipboard(diffToText(diff, filePath), ev.currentTarget);
    });
    const body = document.createElement("div");
    body.className = "diff-body";
    const rows = document.createElement("div");
    rows.className = "diff-rows";
    body.appendChild(rows);
    wrap.appendChild(body);
    const hunks = Array.isArray(diff.hunks) ? diff.hunks : [];
    for (let h = 0; h < hunks.length; h++) {
      const hunk = hunks[h];
      if (h > 0) {
        const sep = document.createElement("div");
        sep.className = "diff-sep";
        sep.textContent = "⋯";
        rows.appendChild(sep);
      }
      for (const line of hunk.lines ?? []) {
        const row = document.createElement("div");
        row.className = `diff-line diff-${line.type}`;
        const oldNo = line.oldNo == null ? "" : String(line.oldNo);
        const newNo = line.newNo == null ? "" : String(line.newNo);
        const sign = line.type === "added" ? "+" : line.type === "removed" ? "-" : " ";
        row.innerHTML =
          `<span class="diff-no diff-old">${oldNo}</span>` +
          `<span class="diff-no diff-new">${newNo}</span>` +
          `<span class="diff-sign">${sign}</span>` +
          `<span class="diff-text hljs">${highlightDiffLine(line.text, lang)}</span>`;
        rows.appendChild(row);
      }
    }
    return wrap;
  };

  const renderToolDetail = (detail, raw) => {
    if (!detail) return "";
    // Bash command — highlight as shell so $ git status reads at a glance.
    if (raw?.command && typeof raw.command === "string") {
      const cmd = raw.command;
      let html = escape(cmd);
      if (window.hljs) {
        try { html = window.hljs.highlight(cmd, { language: "bash" }).value; } catch {}
      }
      return `<code class="tool-detail tool-cmd hljs language-bash">$ ${html}</code>`;
    }
    return `<span class="tool-detail">${escape(detail)}</span>`;
  };

  const TOOL_BODY_COLLAPSE = 12;
  const renderToolBody = (lines) => {
    const all = lines.join("\n");
    const wrap = document.createElement("div");
    wrap.className = "tool-body";
    const pre = document.createElement("pre");
    pre.className = "tool-body-text";
    wrap.appendChild(pre);

    const hasMore = lines.length > TOOL_BODY_COLLAPSE;
    const setExpanded = (on) => {
      pre.textContent = on ? all : lines.slice(0, TOOL_BODY_COLLAPSE).join("\n");
      if (toggle) toggle.textContent = on
        ? "show less"
        : `show ${lines.length - TOOL_BODY_COLLAPSE} more`;
      wrap.classList.toggle("expanded", on);
    };

    const actions = document.createElement("div");
    actions.className = "tool-body-actions";
    const copyBtn = document.createElement("button");
    copyBtn.className = "tool-body-btn";
    copyBtn.textContent = "copy";
    copyBtn.addEventListener("click", () => copyToClipboard(all, copyBtn));
    let toggle = null;
    if (hasMore) {
      toggle = document.createElement("button");
      toggle.className = "tool-body-btn";
      actions.appendChild(toggle);
      toggle.addEventListener("click", () =>
        setExpanded(!wrap.classList.contains("expanded"))
      );
    }
    actions.appendChild(copyBtn);
    wrap.appendChild(actions);
    setExpanded(false);
    return wrap;
  };

  const blockToText = (b) => {
    if (!b) return "";
    if (b.type === "text") return b.text ?? "";
    if (b.type === "code-block") return "\n```" + (b.language ?? "") + "\n" + (b.code ?? "") + "\n```\n";
    if (b.type === "raw") return "";
    return "";
  };

  const createUserBox = (queryText) => {
    const box = document.createElement("div");
    box.className = "agent-box";
    box.innerHTML = `
      <div class="agent-box-head">
        <span class="abh-l">&gt;</span>
        <span class="abh-r">you</span>
      </div>
      <div class="q-text">${escape(queryText)}</div>`;
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    actions.innerHTML = `
      <button class="msg-action-btn" data-action="edit" title="Edit message">✎</button>
      <button class="msg-action-btn" data-action="regen" title="Regenerate response">↻</button>
      <button class="msg-action-btn danger" data-action="delete" title="Delete turn">✕</button>`;
    actions.querySelector('[data-action="edit"]')?.addEventListener("click", () => editUserMsg(box));
    actions.querySelector('[data-action="regen"]')?.addEventListener("click", () => regenTurn(box));
    actions.querySelector('[data-action="delete"]')?.addEventListener("click", () => deleteTurn(box));
    box.appendChild(actions);
    box._queryText = queryText;
    return box;
  };

  const handlers = {
    "agent:info": (p) => {
      if (p?.name === "web-renderer") return;
      const bits = [p?.name, p?.model && `[${p.model}]`].filter(Boolean);
      instanceLabel.textContent = "agent-sh · " + bits.join(" ");
      if (typeof p?.contextWindow === "number" && p.contextWindow > 0) {
        contextWindow = p.contextWindow;
      }
    },

    "shell:cwd-change": (p) => {
      cwd = p?.cwd ?? "";
    },

    "agent:query": (p) => {
      closeReply();
      finalizeThinking();
      if (liveToolOutput) {
        if (liveToolOutput.rafPending) flushLiveOutput();
        liveToolOutput.blockEl.classList.add("final");
        liveToolOutput = null;
      }
      completedTools = new Set();
      stream.querySelectorAll(".queued-hint").forEach((el) => el.remove());
      const queryText = p?.query ?? "";
      const pending = stream.querySelector(".agent-box.pending");
      if (pending && pending._queryText === queryText) {
        currentTurn++;
        pending.dataset.turn = String(currentTurn);
        pending.classList.remove("pending");
        return;
      }
      currentTurn++;
      renderTurnSep();
      append(createUserBox(queryText));
    },

    "agent:processing-start": () => {
      lastUsage = null;
      const strip = document.getElementById("usage-strip");
      if (strip) strip.hidden = true;
      setBusy(true);
      // Close any lingering thinking block from previous turn.
      finalizeThinking();
      // Close any lingering live tool output from previous turn.
      if (liveToolOutput) {
        if (liveToolOutput.rafPending) flushLiveOutput();
        liveToolOutput.blockEl.classList.add("final");
        liveToolOutput = null;
      }
      completedTools = new Set();
      showThinking();
    },

    "agent:queued": (p) => {
      const row = document.createElement("div");
      row.className = "ui-info queued-hint";
      const q = p?.query ?? "";
      row.textContent = q
        ? `queued: "${q.length > 60 ? q.slice(0, 57) + "…" : q}"`
        : "queued — will send after current response";
      append(row);
    },

    "agent:response-chunk": (p) => {
      const blocks = Array.isArray(p?.blocks) ? p.blocks : [];
      const delta = blocks.map(blockToText).join("");
      if (!delta) return;
      hideThinking();
      finalizeThinking();
      if (!currentReply) {
        currentReply = document.createElement("div");
        currentReply.className = "agent-reply streaming";
        currentReply.dataset.turn = String(currentTurn);
        append(currentReply);
      }
      currentReplyText += stripAnsi(delta);
      scheduleReplyRender();
    },

    // Synthesized by the hub: a snapshot of accumulated text since the
    // previous tool boundary. Live clients ignore this (they got the live
    // response-chunks); replay clients use it to reconstruct interleaved
    // text+tool ordering that response-done's combined text would lose.
    "agent:response-segment": (p) => {
      if (currentReply) return;  // live: chunks already rendered this segment
      if (!p?.text) return;
      const block = document.createElement("div");
      block.className = "agent-reply";
      block.dataset.turn = String(currentTurn);
      block.innerHTML = mdToHtml(stripAnsi(p.text));
      append(block);
      highlightWithin(block);
    },

    // Streaming reasoning/thinking text — shown in a dim collapsible block
    // during long pauses so the user can see the agent is still working.
    "agent:thinking-chunk": (p) => {
      const text = stripAnsi(p?.text ?? "");
      if (!text) return;
      hideThinking();
      if (!thinkingBlock) {
        const block = document.createElement("div");
        block.className = "thinking-block";
        thinkingBlock = block;
        const head = document.createElement("div");
        head.className = "thinking-block-head";
        head.textContent = "thinking…";
        head.addEventListener("click", () => {
          setThinkingCollapsed(block, !block.classList.contains("collapsed"));
        });
        const body = document.createElement("div");
        body.className = "thinking-block-body";
        const inner = document.createElement("div");
        inner.className = "thinking-block-inner";
        body.appendChild(inner);
        thinkingBlock.append(head, body);
        // Insert directly into stream — don't use append(), which would
        // close the current tool group and break grouping of consecutive tools.
        hideEmptyState();
        stream.appendChild(thinkingBlock);
        maybeScroll();
      }
      const inner = thinkingBlock.querySelector(".thinking-block-inner");
      inner.textContent = (inner.textContent ?? "") + text;
      inner.scrollTop = inner.scrollHeight;
      maybeScroll();
    },

    "agent:response-done": (p) => {
      // The full-turn response. In live, `currentReply` already has the
      // last segment's text. In replay, segments cover everything before
      // the final tool boundary; this only fills in trailing text after
      // the last tool (if any).
      if (currentReply && currentReplyText === "" && p?.response) {
        currentReplyText = stripAnsi(p.response);
        currentReply.innerHTML = mdToHtml(currentReplyText);
      }
      closeReply();
    },

    "agent:processing-done": () => {
      closeReply();
      hideThinking();
      finalizeThinking();
      if (liveToolOutput) {
        if (liveToolOutput.rafPending) flushLiveOutput();
        liveToolOutput.blockEl.classList.add("final");
        liveToolOutput = null;
      }
      renderUsage();
      setBusy(false);
    },
    "agent:cancelled": () => {
      if (currentReply) {
        currentReply.classList.add("cancelled");
        const stamp = document.createElement("span");
        stamp.className = "cancelled-stamp";
        stamp.textContent = "cancelled";
        currentReply.appendChild(stamp);
      }
      closeReply();
      hideThinking();
      finalizeThinking();
      if (liveToolOutput) {
        if (liveToolOutput.rafPending) flushLiveOutput();
        liveToolOutput.blockEl.classList.add("final");
        liveToolOutput = null;
      }
      setBusy(false);
    },

    "agent:error": (p) => {
      closeReply();
      hideThinking();
      finalizeThinking();
      if (liveToolOutput) {
        if (liveToolOutput.rafPending) flushLiveOutput();
        liveToolOutput.blockEl.classList.add("final");
        liveToolOutput = null;
      }
      append(renderErrorCard(p?.message ?? "", p?.detail ?? p?.stack));
      setBusy(false);
    },

    "agent:usage": (p) => { lastUsage = p; },

    // Session title changes arrive via SSE; update the sidebar inline
    // without a full re-render to avoid disturbing in-progress edits.
    "session:title": (p) => {
      const title = p?.title ?? "";
      if (!title) return;
      // Update the sidebar item for this session
      const sid = sessionId; // current session
      const items = sessionList.querySelectorAll("li");
      for (const li of items) {
        const a = li.querySelector("a");
        const href = a?.getAttribute("href") ?? "";
        if (href === `/${sid}/`) {
          const titleSpan = li.querySelector(".session-title");
          if (titleSpan) titleSpan.textContent = title;
          break;
        }
      }
    },

    "agent:tool-started": (p) => {
      // Close the in-progress reply so the next text chunk opens a new one
      // — preserves text/tool/text interleaving from the agent's narrative.
      closeReply();
      finalizeThinking();
      if (liveToolOutput) {
        if (liveToolOutput.rafPending) flushLiveOutput();
        liveToolOutput.blockEl.classList.add("final");
        liveToolOutput = null;
      }
      const row = document.createElement("div");
      row.className = "tool-row";
      if (p?.toolCallId) row.dataset.callId = p.toolCallId;

      const icon = p?.icon ?? "·";
      const raw = (p?.rawInput && typeof p.rawInput === "object") ? p.rawInput : {};
      // agent-loop suffixes "bash" with ": <description>" when the model
      // passes one. Strip it so the title stays clean and the actual
      // command shows in detail (matches the TUI's extractDetail behavior).
      let title = p?.title ?? "tool";
      if (raw.command && title.includes(":")) title = title.split(":")[0];

      let detail = p?.displayDetail;
      if (!detail && Array.isArray(p?.locations) && p.locations[0]?.path) {
        detail = p.locations[0].path + (p.locations[0].line ? `:${p.locations[0].line}` : "");
      }
      if (!detail) {
        if (raw.command) detail = `$ ${raw.command}`;
        else detail = raw.pattern ?? raw.query ?? raw.path ?? "";
      }

      // Collapse long shell commands so they don't span 5+ lines in the tool row.
      const CMD_COLLAPSE = 100;
      let cmdCollapsed = false;
      let cmdFull = "";
      if (raw.command && typeof raw.command === "string" && raw.command.length > CMD_COLLAPSE) {
        cmdCollapsed = true;
        cmdFull = raw.command;
        // Temporarily swap raw.command to a truncated version for renderToolDetail.
        raw.command = raw.command.slice(0, CMD_COLLAPSE).trimEnd() + "…";
      }
      const detailHtml = renderToolDetail(detail, raw);
      // Restore full command so attaching it to the row works.
      if (cmdCollapsed) raw.command = cmdFull;

      row.innerHTML =
        `<span class="tool-name">${escape(icon)} ${escape(title)}</span>` +
        (detailHtml ? ` ${detailHtml}` : "");
      appendToGroup(row);

      // Attach expand/collapse for long commands.
      if (cmdCollapsed && cmdFull) {
        const detailEl = row.querySelector(".tool-detail");
        if (detailEl) {
          detailEl.classList.add("tool-cmd-collapsed");
          detailEl.title = "click to expand command";
          const toggleCmd = () => {
            const expanded = detailEl.classList.toggle("tool-cmd-expanded");
            if (expanded) {
              detailEl.textContent = "$ " + cmdFull;
              detailEl.title = "click to collapse command";
            } else {
              detailEl.textContent = "$ " + cmdFull.slice(0, CMD_COLLAPSE).trimEnd() + "…";
              detailEl.title = "click to expand command";
            }
          };
          detailEl.addEventListener("click", toggleCmd);
          detailEl.style.cursor = "pointer";
        }
      }

      bumpToolCount();

      // Re-show the animated thinking indicator in the body while the tool
      // runs — the spinner is in the bar, but this gives local feedback if
      // the user has scrolled down past the first few rows.
      if (isProcessing && !currentReply && !thinkingBlock && !thinkingEl) {
        showThinking();
      }
    },

    "agent:tool-completed": (p) => {
      const id = p?.toolCallId ?? "";
      const row = id ? stream.querySelector(`.tool-row[data-call-id="${CSS.escape(id)}"]`) : null;
      if (!row) return;
      const ok = p?.exitCode === 0 || p?.exitCode == null;
      row.classList.add(ok ? "ok" : "err");
      const summary = p?.resultDisplay?.summary ?? "";
      const mark = ok ? "✓" : `✗ exit ${p?.exitCode}`;
      const tail = document.createElement("span");
      tail.className = "tool-mark";
      tail.textContent = (summary ? ` ${summary} ` : "  ") + mark;
      row.appendChild(tail);

      // Track completed tools so stray output-chunk events after completion
      // don't spawn orphaned live-output blocks.
      if (id) completedTools.add(id);

      // If we accumulated live output during the tool's execution,
      // finalize it as the tool body (overrides resultDisplay.body).
      if (liveToolOutput && liveToolOutput.callId === id) {
        if (liveToolOutput.rafPending) flushLiveOutput();
        // Capture references locally — liveToolOutput will be nulled below,
        // but the toggle click handler (a closure) would otherwise throw.
        const blockEl = liveToolOutput.blockEl;
        blockEl.classList.add("final");
        const lines = liveToolOutput.lines;
        const all = lines.join("\n");
        const LIMIT = 6;

        // Use a dedicated text container so toggle doesn't wipe the buttons.
        const textEl = document.createElement("span");
        textEl.className = "tool-body-text";
        textEl.textContent = all;
        blockEl.textContent = "";
        blockEl.appendChild(textEl);

        // Add controls bar (show more/less only; copy is overkill for tool output).
        const actions = document.createElement("div");
        actions.className = "tool-body-actions";

        if (lines.length > LIMIT) {
          textEl.textContent = lines.slice(0, LIMIT).join("\n");
          const toggle = document.createElement("button");
          toggle.className = "tool-body-btn";
          toggle.textContent = `show ${lines.length - LIMIT} more`;
          let expanded = false;
          toggle.addEventListener("click", () => {
            expanded = !expanded;
            textEl.textContent = expanded ? all : lines.slice(0, LIMIT).join("\n");
            toggle.textContent = expanded
              ? "show less"
              : `show ${lines.length - LIMIT} more`;
            blockEl.classList.toggle("expanded", expanded);
          });
          actions.appendChild(toggle);
        }
        if (actions.children.length > 0) {
          blockEl.appendChild(actions);
        }
        liveToolOutput = null;
      } else {
        // No live streaming — use resultDisplay body if present.
        const body = p?.resultDisplay?.body;
        if (body?.kind === "lines" && Array.isArray(body.lines) && body.lines.length) {
          const block = renderToolBody(body.lines);
          row.parentNode.insertBefore(block, row.nextSibling);
        } else if (body?.kind === "diff" && body.diff) {
          const block = renderDiffBlock(body.diff, body.filePath);
          row.parentNode.insertBefore(block, row.nextSibling);
        }
      }
      maybeScroll();
    },

    // Stream tool output in real-time — bash stdout, write_file diffs, etc.
    // Replaces the "no progress" gap between tool-started and tool-completed.
    // Note: agent:tool-output-chunk events do not include toolCallId, so we
    // track output for whichever tool was most recently started.
    "agent:tool-output-chunk": (p) => {
      const chunk = p?.chunk ?? "";
      if (!chunk) return;

      // Row lookup: use the latest tool-row in the stream (most recent tool-started).
      const rows = stream.querySelectorAll(".tool-row");
      const row = rows.length > 0 ? rows[rows.length - 1] : null;
      const callId = row?.dataset.callId ?? "";

      // Ignore chunks for tools that already completed.
      if (callId && completedTools.has(callId)) return;

      if (!liveToolOutput || liveToolOutput.callId !== callId) {
        // Start a new live output block for this tool.
        const block = document.createElement("pre");
        block.className = "tool-body tool-body-live";
        liveToolOutput = { callId, lines: [], blockEl: block, rafPending: false };
        // Insert after the tool row (or append to the current tool-group body).
        const parent = row ? row.parentNode : null;
        if (parent && row) {
          parent.insertBefore(block, row.nextSibling);
        }
      }

      // Split on newlines; last element is the partial line (may be "").
      const parts = chunk.split("\n");
      if (liveToolOutput.lines.length > 0) {
        liveToolOutput.lines[liveToolOutput.lines.length - 1] += parts[0];
      } else {
        liveToolOutput.lines.push(parts[0]);
      }
      for (let i = 1; i < parts.length; i++) {
        liveToolOutput.lines.push(parts[i]);
      }
      scheduleLiveOutput();
    },

    "permission:request": (p) => {
      // The TUI uses this event's metadata.diff to preview file edits before
      // the tool runs. We do the same — render the diff inline so it stays
      // visible alongside the tool-started/-completed rows that follow.
      // Future: prompt the user for an approve/deny decision here.
      if (p?.kind === "file-write" && p?.metadata?.diff) {
        closeReply();
        const block = renderDiffBlock(p.metadata.diff, p.title ?? p.metadata.filePath ?? "");
        block.classList.add("diff-preview");
        appendToGroup(block);
      }
    },

    "ui:info": (p) => {
      const row = document.createElement("div");
      row.className = "ui-info";
      row.textContent = String(p?.message ?? "");
      append(row);
    },
    "ui:error": (p) => {
      append(renderErrorCard(p?.message ?? "command failed", null));
    },

    "shell:command-start": (p) => {
      closeReply();
      cwd = p?.cwd ?? cwd;
      renderPromptRow();
      const row = document.createElement("div");
      row.className = "t-input";
      row.innerHTML = `<span class="t-prompt">&gt;</span>${escape(p?.command ?? "")}`;
      append(row);
    },

    "shell:command-done": (p) => {
      const text = stripAnsi(p?.output ?? "");
      const isErr = p?.exitCode != null && p.exitCode !== 0;
      if (isErr) {
        append(renderErrorCard(`shell command failed (exit ${p.exitCode})`, text));
        return;
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        const row = document.createElement("div");
        row.className = "t-out";
        row.textContent = line;
        append(row);
      }
    },
  };

  // Shorten an absolute path for sidebar display: strip the home prefix, then
  // keep at most the last two segments. /Users/yilun/Workspace/ashub
  // becomes ~/…/ashub. Keeps the column readable at 220px.
  let homeDir = "";
  const shortenCwd = (cwd) => {
    if (!cwd) return "";
    let path = cwd;
    if (homeDir && path.startsWith(homeDir)) path = "~" + path.slice(homeDir.length);
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 2) return path;
    return (path.startsWith("~") ? "~/…/" : "…/") + parts.slice(-2).join("/");
  };
  let sessionsCache = null;
  let sessionsHash = "";

  const renderSessions = async () => {
    try {
      const res = await fetch("/sessions");
      const list = await res.json();
      const hash = JSON.stringify(list);
      if (hash === sessionsHash) return;  // 5s poll: skip rebuild when nothing changed
      sessionsHash = hash;
      if (!homeDir && list[0]?.cwd) {
        const m = list[0].cwd.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
        if (m) homeDir = m[1];
      }
      sessionsCache = list;
      sessionList.innerHTML = "";
      for (const s of list) {
        const li = document.createElement("li");
        if (s.instanceId === sessionId) li.className = "current";
        const a = document.createElement("a");
        a.href = `/${s.instanceId}/`;
        const title = escape(s.title || s.instanceId);
        const modelText = s.model ? ` <span class="session-model">${escape(s.model)}</span>` : "";
        const cwdText = s.cwd ? ` <span class="session-cwd" title="${escape(s.cwd)}">${escape(shortenCwd(s.cwd))}</span>` : "";
        a.innerHTML = `<span class="session-title">${title}</span>${modelText}${cwdText}`;
        li.appendChild(a);

        // Inline edit button
        const editBtn = document.createElement("button");
        editBtn.className = "session-edit";
        editBtn.title = "edit title";
        editBtn.textContent = "✎";
        editBtn.addEventListener("click", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          startTitleEdit(li, s.instanceId, s.title || s.instanceId);
        });
        li.appendChild(editBtn);

        const close = document.createElement("button");
        close.className = "session-close";
        close.title = "close session";
        close.textContent = "×";
        close.addEventListener("click", async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (!confirm(`Close session ${escape(s.title || s.instanceId)}?`)) return;
          try {
            await fetch(`/${s.instanceId}/`, { method: "DELETE" });
          } catch {}
          if (s.instanceId === sessionId) {
            window.location.href = "/";
          } else {
            renderSessions();
          }
        });
        li.appendChild(close);

        sessionList.appendChild(li);
      }
    } catch {}
  };
  renderSessions();
  setInterval(renderSessions, 5000);

  // ── Session title inline editing ────────────────────────────────────
  const startTitleEdit = (li, instanceId, currentTitle) => {
    // Remove any existing inline edit on other items
    sessionList.querySelectorAll(".session-title-edit").forEach((el) => el.remove());
    sessionList.querySelectorAll(".session-title").forEach((el) => el.style.display = "");

    const titleSpan = li.querySelector(".session-title");
    if (!titleSpan) return;
    titleSpan.style.display = "none";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "session-title-edit";
    input.value = currentTitle;
    input.maxLength = 100;
    titleSpan.insertAdjacentElement("afterend", input);
    input.focus();
    input.select();

    const commit = async () => {
      const val = input.value.trim();
      input.remove();
      titleSpan.style.display = "";
      if (val && val !== currentTitle) {
        titleSpan.textContent = val;
        try {
          await fetch(`/${instanceId}/title`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: val }),
          });
        } catch {}
      }
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      if (ev.key === "Escape") { input.value = currentTitle; input.blur(); }
    });
  };

  // ── New-session form ─────────────────────────────────────────────
  const LS_LAST_CWD = "ash.last-cwd";
  const newForm = document.getElementById("new-session-form");
  const newCwd = document.getElementById("new-session-cwd");
  const newErr = document.getElementById("new-session-err");
  const newBtn = document.getElementById("new-session");

  const openNewForm = () => {
    if (!newForm) return;
    newForm.hidden = false;
    newErr.hidden = true;
    // Seed with: the current session's cwd, last-used cwd, or blank.
    const current = sessionsCache?.find((s) => s.instanceId === sessionId)?.cwd;
    const seed = current ?? localStorage.getItem(LS_LAST_CWD) ?? "";
    newCwd.value = seed;
    newCwd.focus();
    newCwd.setSelectionRange(seed.length, seed.length);
  };
  const closeNewForm = () => {
    if (!newForm) return;
    newForm.hidden = true;
    newErr.hidden = true;
    newCwd.value = "";
  };

  newBtn?.addEventListener("click", async () => {
    newBtn.disabled = true;
    try {
      let cwd = null;
      if (window.electronAPI?.pickDirectory) {
        const data = await window.electronAPI.pickDirectory();
        if (data.cancelled || !data.cwd) { newBtn.disabled = false; return; }
        cwd = data.cwd;
      } else {
        const r = await fetch("/pick-dir");
        if (!r.ok) { newBtn.disabled = false; return; }
        const data = await r.json();
        if (!data.cwd || data.cancelled) { newBtn.disabled = false; return; }
        cwd = data.cwd;
      }
      try {
        const res = await fetch("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd }),
        });
        if (!res.ok) {
          const text = await res.text();
          if (newErr) { newErr.textContent = text || `failed (${res.status})`; newErr.hidden = false; newForm.hidden = false; }
          return;
        }
        const sess = await res.json();
        try { localStorage.setItem(LS_LAST_CWD, cwd); } catch {}
        if (sess.instanceId) window.location.href = `/${sess.instanceId}/`;
      } catch (e) {
        if (newErr) { newErr.textContent = String(e?.message ?? e); newErr.hidden = false; newForm.hidden = false; }
      }
    } catch {
    } finally {
      newBtn.disabled = false;
    }
  });

  newCwd?.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      closeNewForm();
    }
  });

  newForm?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    // Enter completes a highlighted suggestion first; second Enter submits.
    if (cwdAc?.hasSelection()) {
      cwdAc.acceptCurrent();
      return;
    }
    const cwd = newCwd.value.trim();
    try {
      const res = await fetch("/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cwd ? { cwd } : {}),
      });
      if (!res.ok) {
        const text = await res.text();
        newErr.textContent = text || `failed (${res.status})`;
        newErr.hidden = false;
        return;
      }
      const data = await res.json();
      if (cwd) try { localStorage.setItem(LS_LAST_CWD, cwd); } catch {}
      if (data.instanceId) window.location.href = `/${data.instanceId}/`;
    } catch (e) {
      newErr.textContent = String(e?.message ?? e);
      newErr.hidden = false;
    }
  });

  const connect = () => {
    const es = new EventSource(eventsUrl);
    es.onopen = () => { conn.textContent = ""; dot.classList.remove("stale"); };
    es.onerror = () => { conn.textContent = "reconnecting…"; dot.classList.add("stale"); };
    es.onmessage = (ev) => {
      let frame;
      try { frame = JSON.parse(ev.data); } catch { return; }
      const fn = handlers[frame?.meta?.name];
      if (fn) {
        try { fn(frame.payload); } catch (e) { console.error(frame.meta.name, e); }
      }
    };
  };

  const form = document.getElementById("form");
  const input = document.getElementById("query");

  if (sessionId) {
    connect();
  } else {
    conn.textContent = "no session — click + to create";
    dot.classList.add("stale");
    if (input) input.disabled = true;
    if (form) form.style.opacity = "0.5";
  }
  const submitSlash = async (raw) => {
    const trimmed = raw.trim();
    const space = trimmed.indexOf(" ");
    const name = space === -1 ? trimmed : trimmed.slice(0, space);
    const args = space === -1 ? "" : trimmed.slice(space + 1);
    await fetch(`/${sessionId}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args }),
    });
  };

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    // If the autocomplete popover has a highlighted item, accept it instead
    // of submitting — Enter "completes" first, then a second Enter submits.
    if (slashAc.hasSelection()) {
      slashAc.acceptCurrent();
      return;
    }
    const query = input.value.trim();
    if (!query) return;
    if (isSubmitting) return;
    lastQuery = query;
    isSubmitting = true;
    input.value = "";
    input.style.height = "";
    slashAc.close();
    let optimisticBox = null;
    let optimisticSep = null;
    if (!query.startsWith("/")) {
      optimisticSep = renderTurnSep();
      optimisticBox = createUserBox(query);
      optimisticBox.classList.add("pending");
      append(optimisticBox);
    }
    input.disabled = true;
    try {
      if (query.startsWith("/")) {
        await submitSlash(query);
      } else {
        await fetch(submitUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });
      }
    } catch (e) {
      console.error("submit failed", e);
      optimisticBox?.remove();
      optimisticSep?.remove();
    } finally {
      isSubmitting = false;
      input.disabled = false;
      input.focus();
    }
  });

  // Shift+Enter inserts a newline; Enter alone submits.
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      // Let the form submit handler take over, but only if autocomplete
      // isn't open with a selection.
      if (!slashAc.hasSelection()) {
        ev.preventDefault();
        form.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    }
  });

  // ── Autocomplete popover (shared) ────────────────────────────────
  // Creates a self-contained popover bound to `inputEl` + list `listEl`.
  // `fetcher(buffer)` returns items; `accept(item)` mutates the input.
  // Returns { close } so callers can dismiss programmatically.
  const attachAutocomplete = ({ inputEl, listEl, fetcher, accept, shouldOpen }) => {
    const state = { open: false, items: [], index: 0, token: 0, timer: null };

    const render = () => {
      if (!state.open || state.items.length === 0) {
        listEl.hidden = true;
        listEl.innerHTML = "";
        return;
      }
      listEl.innerHTML = "";
      state.items.forEach((it, i) => {
        const li = document.createElement("li");
        li.className = "autocomplete-item" + (i === state.index ? " active" : "");
        li.innerHTML =
          `<span class="ac-name">${escape(it.name)}</span>` +
          (it.description ? `<span class="ac-desc">${escape(it.description)}</span>` : "");
        li.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          state.index = i;
          doAccept();
        });
        listEl.appendChild(li);
      });
      listEl.hidden = false;
    };
    const close = () => {
      state.open = false;
      state.items = [];
      state.index = 0;
      render();
    };
    const doAccept = () => {
      const it = state.items[state.index];
      if (!it) return;
      accept(it);
      close();
      request();  // surface follow-up suggestions
    };
    const request = () => {
      const buffer = inputEl.value;
      if (!shouldOpen(buffer)) { close(); return; }
      const my = ++state.token;
      clearTimeout(state.timer);
      state.timer = setTimeout(async () => {
        try {
          const items = await fetcher(buffer);
          if (my !== state.token) return;
          state.items = Array.isArray(items) ? items : [];
          state.index = 0;
          state.open = state.items.length > 0;
          render();
        } catch {}
      }, 60);
    };

    inputEl.addEventListener("input", request);
    inputEl.addEventListener("blur", () => setTimeout(close, 100));
    inputEl.addEventListener("keydown", (ev) => {
      if (!state.open) return;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        state.index = (state.index + 1) % state.items.length;
        render();
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        state.index = (state.index - 1 + state.items.length) % state.items.length;
        render();
      } else if (ev.key === "Tab") {
        ev.preventDefault();
        doAccept();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        close();
      }
      // Enter falls through to the form submit handler, which calls
      // acceptCurrent() if the popover has a highlighted item.
    });

    return {
      close,
      hasSelection: () => state.open && state.items[state.index] != null,
      acceptCurrent: doAccept,
    };
  };

  // Slash-command popover for the main query input.
  const slashAc = attachAutocomplete({
    inputEl: input,
    listEl: document.getElementById("autocomplete"),
    shouldOpen: (b) => b.trimStart().startsWith("/"),
    fetcher: async (buffer) => {
      const r = await fetch(`/${sessionId}/autocomplete?buffer=${encodeURIComponent(buffer)}`);
      if (!r.ok) return [];
      const data = await r.json();
      return data.items;
    },
    accept: (it) => {
      const trailing = it.name.includes(" ") ? "" : " ";
      input.value = it.name + trailing;
    },
  });

  // Directory popover for the new-session cwd input.
  const cwdAc = attachAutocomplete({
    inputEl: newCwd,
    listEl: document.getElementById("cwd-autocomplete"),
    shouldOpen: (b) => b.length > 0,
    fetcher: async (buffer) => {
      const r = await fetch(`/fs?prefix=${encodeURIComponent(buffer)}`);
      if (!r.ok) return [];
      const data = await r.json();
      return data.items;
    },
    accept: (it) => { newCwd.value = it.name; },
  });

  // ── Context panel ────────────────────────────────────────────────
  const app = document.querySelector(".app");
  const ctxPanel = document.getElementById("ctx-panel");
  const ctxToggle = document.getElementById("ctx-toggle");
  const ctxClose = document.getElementById("ctx-close");
  const ctxRefresh = document.getElementById("ctx-refresh");
  const ctxBody = document.getElementById("ctx-body");
  const ctxMeta = document.getElementById("ctx-meta");
  const ctxDrop = document.getElementById("ctx-drop");

  // Compute pairing groups: each assistant with tool_calls is grouped with
  // the immediately-following tool messages whose tool_call_id matches.
  // Selecting any member of a group toggles the whole group.
  const computeGroups = (msgs) => {
    const groupOf = new Array(msgs.length).fill(-1);
    let g = 0;
    for (let i = 0; i < msgs.length; i++) {
      if (groupOf[i] !== -1) continue;
      const m = msgs[i];
      if (m?.role === "assistant" && Array.isArray(m?.tool_calls) && m.tool_calls.length > 0) {
        const ids = new Set(m.tool_calls.map((tc) => tc?.id).filter(Boolean));
        groupOf[i] = g;
        for (let j = i + 1; j < msgs.length; j++) {
          const t = msgs[j];
          if (t?.role !== "tool") break;
          if (ids.has(t.tool_call_id)) groupOf[j] = g;
          else break;
        }
        g++;
      } else if (m?.role === "tool") {
        // orphan tool result without preceding assistant — group alone
        groupOf[i] = g++;
      } else {
        groupOf[i] = g++;
      }
    }
    return groupOf;
  };

  const tokensOf = (m) => Math.ceil(JSON.stringify(m ?? null).length / 4);

  const selected = new Set();

  const messageText = (m) => {
    if (typeof m?.content === "string") return m.content;
    if (Array.isArray(m?.content)) {
      return m.content
        .map((p) => (typeof p === "string" ? p : p?.text ?? p?.content ?? JSON.stringify(p)))
        .join("\n");
    }
    if (m?.role === "assistant" && Array.isArray(m?.tool_calls)) {
      return m.tool_calls.map((tc) => {
        const fn = tc?.function ?? {};
        let args = fn.arguments ?? "";
        try {
          const parsed = typeof args === "string" ? JSON.parse(args) : args;
          args = JSON.stringify(parsed, null, 2);
        } catch {}
        return `→ ${fn.name ?? "tool"}(\n${args}\n)`;
      }).join("\n\n");
    }
    if (m?.role === "tool") return String(m.content ?? "");
    return JSON.stringify(m ?? {});
  };

  let currentMsgs = [];
  let currentGroups = [];

  const fmtTok = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  const updateDropButton = () => {
    ctxDrop.disabled = selected.size === 0;
    if (selected.size > 0) {
      let tok = 0;
      for (const i of selected) tok += tokensOf(currentMsgs[i]);
      ctxDrop.textContent = `drop ${selected.size} · ~${fmtTok(tok)}`;
    } else {
      ctxDrop.textContent = "drop";
    }
  };

  const setGroupSelected = (group, on) => {
    for (let i = 0; i < currentGroups.length; i++) {
      if (currentGroups[i] !== group) continue;
      if (on) selected.add(i); else selected.delete(i);
      const row = ctxBody.querySelector(`[data-idx="${i}"]`);
      const cb = row?.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = on;
      row?.classList.toggle("selected", on);
    }
    updateDropButton();
  };

  const renderContext = async () => {
    selected.clear();
    if (!sessionId) { ctxBody.innerHTML = '<div class="ctx-empty">no session</div>'; updateDropButton(); return; }
    ctxBody.innerHTML = '<div class="ctx-empty">loading…</div>';
    let data;
    try {
      const res = await fetch(`/${sessionId}/context`);
      if (!res.ok) throw new Error(await res.text());
      data = await res.json();
    } catch (e) {
      ctxBody.innerHTML = `<div class="ctx-empty">${escape(String(e.message ?? e))}</div>`;
      updateDropButton();
      return;
    }
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    currentMsgs = msgs;
    currentGroups = computeGroups(msgs);
    ctxMeta.textContent = `${msgs.length} msgs · ${fmtTok(data.activeTokens ?? 0)}/${fmtTok(data.contextWindow ?? 0)}`;

    ctxBody.innerHTML = "";
    if (msgs.length === 0) {
      ctxBody.innerHTML = '<div class="ctx-empty">empty</div>';
      updateDropButton();
      return;
    }
    const groupSizes = new Map();
    for (const g of currentGroups) groupSizes.set(g, (groupSizes.get(g) ?? 0) + 1);

    msgs.forEach((m, i) => {
      const wrap = document.createElement("div");
      wrap.className = "ctx-msg";
      wrap.dataset.idx = String(i);
      if ((groupSizes.get(currentGroups[i]) ?? 1) > 1) wrap.classList.add("paired");
      const role = String(m?.role ?? "?");
      const text = messageText(m);
      const tok = tokensOf(m);

      wrap.dataset.role = role;

      const head = document.createElement("div");
      head.className = "ctx-msg-head";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.addEventListener("change", () => setGroupSelected(currentGroups[i], cb.checked));
      const left = document.createElement("span");
      left.appendChild(cb);
      const dot = document.createElement("span");
      dot.className = `ctx-dot ${escape(role)}`;
      left.appendChild(dot);
      const roleSpan = document.createElement("span");
      roleSpan.className = `ctx-role ${escape(role)}`;
      roleSpan.textContent = role;
      left.appendChild(roleSpan);
      const tokSpan = document.createElement("span");
      tokSpan.className = "ctx-tokens";
      tokSpan.textContent = `~${fmtTok(tok)}`;
      left.appendChild(tokSpan);
      const right = document.createElement("span");
      right.textContent = `#${i}`;
      head.appendChild(left);
      head.appendChild(right);
      wrap.appendChild(head);

      const body = document.createElement("div");
      body.className = "ctx-text";
      const textNode = document.createElement("div");
      textNode.className = "ctx-text-inner";
      textNode.textContent = text;
      body.appendChild(textNode);
      const chev = document.createElement("button");
      chev.type = "button";
      chev.className = "ctx-chevron";
      chev.textContent = "▾ expand";
      chev.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const on = !body.classList.contains("expanded");
        body.classList.toggle("expanded", on);
        chev.textContent = on ? "▴ collapse" : "▾ expand";
      });
      body.appendChild(chev);
      wrap.appendChild(body);

      // Hide chevron if content fits within the collapsed cap.
      requestAnimationFrame(() => {
        if (textNode.scrollHeight <= textNode.clientHeight + 4) chev.hidden = true;
      });

      ctxBody.appendChild(wrap);
    });
    applyCtxFilter();
    updateDropButton();
  };

  ctxDrop?.addEventListener("click", async () => {
    if (selected.size === 0) return;
    const indices = [...selected].sort((a, b) => a - b);
    try {
      const res = await fetch(`/${sessionId}/context/drop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ indices }),
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (e) {
      alert(`drop failed: ${e.message ?? e}`);
      return;
    }
    renderContext();
  });

  ctxRefresh?.addEventListener("click", () => renderContext());

  // ── Context filter chips ─────────────────────────────────────────
  const ctxFilters = document.getElementById("ctx-filters");
  const activeRoles = new Set(["all"]);
  const applyCtxFilter = () => {
    const all = activeRoles.has("all");
    ctxBody.querySelectorAll(".ctx-msg").forEach((el) => {
      const role = el.dataset.role ?? "";
      el.hidden = !all && !activeRoles.has(role);
    });
  };
  ctxFilters?.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".ctx-chip");
    if (!btn) return;
    const role = btn.dataset.role;
    if (role === "all") {
      activeRoles.clear();
      activeRoles.add("all");
    } else {
      activeRoles.delete("all");
      if (activeRoles.has(role)) activeRoles.delete(role);
      else activeRoles.add(role);
      if (activeRoles.size === 0) activeRoles.add("all");
    }
    ctxFilters.querySelectorAll(".ctx-chip").forEach((c) => {
      c.dataset.active = activeRoles.has(c.dataset.role) ? "1" : "0";
    });
    applyCtxFilter();
  });

  // ── Persistence: ctx panel + sidebar collapsed state ────────────
  const LS_CTX = "ash.ctx-open";
  const LS_SIDEBAR = "ash.sidebar-collapsed";
  const setCtxOpen = (on) => {
    if (on) { ctxPanel.removeAttribute("hidden"); app.classList.add("ctx-open"); renderContext(); }
    else { ctxPanel.setAttribute("hidden", ""); app.classList.remove("ctx-open"); }
    try { localStorage.setItem(LS_CTX, on ? "1" : "0"); } catch {}
  };
  // Restore on load.
  try {
    if (localStorage.getItem(LS_CTX) === "1") setCtxOpen(true);
  } catch {}

  const sidebarToggle = document.getElementById("sidebar-toggle");
  const setSidebarCollapsed = (on) => {
    app.classList.toggle("sidebar-collapsed", on);
    if (sidebarToggle) sidebarToggle.textContent = on ? "›" : "‹";
    try { localStorage.setItem(LS_SIDEBAR, on ? "1" : "0"); } catch {}
  };
  try {
    if (localStorage.getItem(LS_SIDEBAR) === "1") setSidebarCollapsed(true);
  } catch {}
  sidebarToggle?.addEventListener("click", () => {
    setSidebarCollapsed(!app.classList.contains("sidebar-collapsed"));
  });

  // ── Theme toggle ──────────────────────────────────────────────────
  const LS_THEME = "ash-theme";
  const themeToggle = document.getElementById("theme-toggle");
  const themeIconSun = document.getElementById("theme-icon-sun");
  const themeIconMoon = document.getElementById("theme-icon-moon");
  const hljsDark = document.getElementById("hljs-dark");
  const hljsLight = document.getElementById("hljs-light");

  const setTheme = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    if (hljsDark) hljsDark.disabled = theme === "light";
    if (hljsLight) hljsLight.disabled = theme === "dark";
    if (themeIconSun) themeIconSun.hidden = theme !== "light";
    if (themeIconMoon) themeIconMoon.hidden = theme !== "dark";
    try { localStorage.setItem(LS_THEME, theme); } catch {}
  };

  const toggleTheme = () => {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    setTheme(current === "light" ? "dark" : "light");
  };

  // Init: respect stored preference, default light
  try {
    const stored = localStorage.getItem(LS_THEME);
    setTheme(stored === "dark" ? "dark" : "light");
  } catch { setTheme("light"); }

  themeToggle?.addEventListener("click", toggleTheme);

  ctxToggle?.addEventListener("click", () => setCtxOpen(ctxPanel.hasAttribute("hidden")));
  ctxClose?.addEventListener("click", () => setCtxOpen(false));

  // ── Keyboard shortcuts ───────────────────────────────────────────
  input?.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowUp" && !ev.shiftKey && !input.value && lastQuery) {
      ev.preventDefault();
      input.value = lastQuery;
      // Move caret to end.
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });

  // Auto-resize textarea as content grows
  const autoResize = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 12 * 16) + "px"; // 12em max
  };
  input?.addEventListener("input", autoResize);

  document.addEventListener("keydown", (ev) => {
    const meta = ev.metaKey || ev.ctrlKey;
    if (meta && (ev.key === "k" || ev.key === "K")) {
      ev.preventDefault();
      input?.focus();
      return;
    }
    if (meta && ev.key === "\\") {
      ev.preventDefault();
      setCtxOpen(ctxPanel.hasAttribute("hidden"));
      return;
    }
    if (ev.key === "Escape") {
      // Dismiss any open inline edit
      const editingBox = stream.querySelector(".agent-box.editing");
      if (editingBox && editingBox._cancelEdit) { editingBox._cancelEdit(); return; }
      const configOverlay = document.getElementById("config-overlay");
      if (configOverlay && !configOverlay.hidden) { setConfigOpen(false); return; }
      if (spinner && !spinner.hidden && sessionId) {
        // Brief flash feedback on cancel button
        if (cancelBtn && !cancelBtn.hidden) {
          cancelBtn.classList.add("flash");
          setTimeout(() => cancelBtn.classList.remove("flash"), 200);
        }
        fetch(`/${sessionId}/cancel`, { method: "POST" }).catch(() => {});
      }
    }
  });

  // Interrupt / cancel button — visible while the agent is processing.
  cancelBtn?.addEventListener("click", () => {
    if (!sessionId) return;
    cancelBtn.classList.add("flash");
    setTimeout(() => cancelBtn.classList.remove("flash"), 200);
    fetch(`/${sessionId}/cancel`, { method: "POST" }).catch(() => {});
  });

  // ── Config panel ──────────────────────────────────────────────────
  const configOverlay = document.getElementById("config-overlay");
  const configToggle = document.getElementById("config-toggle");
  const configClose = document.getElementById("config-close");
  const configReset = document.getElementById("config-reset");

  // Simple mode elements
  const configBodySimple = document.getElementById("config-body-simple");
  const configProvider = document.getElementById("config-provider");
  const configProviderDesc = document.getElementById("config-provider-desc");
  const configApikey = document.getElementById("config-apikey");
  const configApikeyToggle = document.getElementById("config-apikey-toggle");
  const configSaveSimple = document.getElementById("config-save-simple");

  // Advanced mode elements
  const configBodyAdvanced = document.getElementById("config-body-advanced");
  const configEditor = document.getElementById("config-editor");
  const configSave = document.getElementById("config-save");
  const configFormat = document.getElementById("config-format");
  const configValid = document.getElementById("config-valid");
  const configInvalid = document.getElementById("config-invalid");

  // Mode tabs
  const configModeTabs = document.getElementById("config-mode-tabs");

  let configMode = "simple";
  let originalConfig = "";
  let originalApiKey = "";

  // ── Provider definitions ──────────────────────────────────────────
  const PROVIDERS = {
    deepseek: {
      name: "DeepSeek",
      description: "DeepSeek V4 models with 1M context window",
      baseURL: "https://api.deepseek.com",
      defaultModel: "deepseek-v4-flash",
      models: [
        {
          id: "deepseek-v4-pro",
          contextWindow: 1000000,
          maxTokens: 300000,
          echoReasoning: true,
        },
        {
          id: "deepseek-v4-flash",
          contextWindow: 1000000,
          maxTokens: 300000,
          echoReasoning: true,
        },
      ],
    },
  };

  // ── Build config from simple form ───────────────────────────────
  const buildConfig = () => {
    const providerId = configProvider.value;
    const apiKey = configApikey.value.trim();
    const providerDef = PROVIDERS[providerId];
    if (!providerDef) return null;

    // Parse original config so we can preserve non-simple fields
    // (extensions, defaultBackend, other providers, etc.)
    let existing = {};
    try { existing = JSON.parse(originalConfig || "{}"); } catch {}

    const config = {
      providers: {
        [providerId]: {
          baseURL: providerDef.baseURL,
          apiKey: apiKey || "YOUR_API_KEY",
          defaultModel: providerDef.defaultModel,
          models: providerDef.models,
        },
      },
      defaultProvider: providerId,
    };

    // Preserve all top-level fields from originalConfig that aren't
    // providers/defaultProvider (e.g. extensions, defaultBackend, etc.)
    for (const [key, val] of Object.entries(existing)) {
      if (key !== "providers" && key !== "defaultProvider") {
        config[key] = val;
      }
    }

    // Merge providers from originalConfig that aren't the selected one
    if (existing.providers && typeof existing.providers === "object") {
      for (const [key, val] of Object.entries(existing.providers)) {
        if (!(key in config.providers)) {
          config.providers[key] = val;
        }
      }
    }

    return config;
  };

  // ── Parse existing config into simple form ──────────────────────
  const parseConfigToSimple = (config) => {
    if (!config || typeof config !== "object" || Object.keys(config).length === 0) {
      configProvider.value = "deepseek";
      configApikey.value = "";
      return;
    }

    // Detect provider from defaultProvider or providers keys
    const dp = config.defaultProvider;
    let detectedProvider = null;
    let detectedApiKey = "";

    if (dp && PROVIDERS[dp]) {
      detectedProvider = dp;
    } else if (config.providers && typeof config.providers === "object") {
      // Find the first known provider
      for (const key of Object.keys(config.providers)) {
        if (PROVIDERS[key]) {
          detectedProvider = key;
          break;
        }
      }
    }

    if (detectedProvider) {
      configProvider.value = detectedProvider;
      if (config.providers && config.providers[detectedProvider]) {
        const p = config.providers[detectedProvider];
        if (typeof p.apiKey === "string" && p.apiKey !== "YOUR_API_KEY") {
          detectedApiKey = p.apiKey;
        }
      }
    } else {
      configProvider.value = "deepseek";
    }

    configApikey.value = detectedApiKey;
  };

  // ── Mode switching ───────────────────────────────────────────────
  const switchConfigMode = (mode) => {
    configMode = mode;

    // Update tab active states
    configModeTabs.querySelectorAll(".config-mode-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.mode === mode);
    });

    if (mode === "simple") {
      configBodySimple.removeAttribute("hidden");
      configBodyAdvanced.setAttribute("hidden", "");
      // Parse current JSON editor content into simple form
      try {
        const parsed = JSON.parse(configEditor.value || "{}");
        parseConfigToSimple(parsed);
      } catch {
        parseConfigToSimple({});
      }
      updateProviderDesc();
    } else {
      configBodySimple.setAttribute("hidden", "");
      configBodyAdvanced.removeAttribute("hidden");
      // buildConfig() already merges existing providers and preserves
      // extensions / defaultBackend / other fields from originalConfig.
      const config = buildConfig();
      configEditor.value = config
        ? JSON.stringify(config, null, 2)
        : originalConfig || "{}";
      validateJson();
      configEditor.focus();
    }
  };

  // ── Provider description ─────────────────────────────────────────
  const updateProviderDesc = () => {
    const providerId = configProvider.value;
    const def = PROVIDERS[providerId];
    if (def && configProviderDesc) {
      configProviderDesc.textContent = def.description;
    }
  };

  // ── Toggle API key visibility ────────────────────────────────────
  let apiKeyVisible = false;
  configApikeyToggle?.addEventListener("click", () => {
    apiKeyVisible = !apiKeyVisible;
    configApikey.type = apiKeyVisible ? "text" : "password";
    configApikeyToggle.classList.toggle("showing", apiKeyVisible);
  });

  // ── Provider change ──────────────────────────────────────────────
  configProvider?.addEventListener("change", () => {
    updateProviderDesc();
  });

  // ── Open / close ─────────────────────────────────────────────────
  const setConfigOpen = async (on) => {
    if (on) {
      configOverlay.removeAttribute("hidden");
      // Load existing config from server
      let rawConfig = {};
      try {
        const r = await fetch("/api/config");
        rawConfig = await r.json();
      } catch {}
      originalConfig = JSON.stringify(rawConfig, null, 2);
      configEditor.value = originalConfig;

      // Preserve original API key in case user re-saves without re-entering it
      originalApiKey = "";
      if (rawConfig.providers && rawConfig.defaultProvider && rawConfig.providers[rawConfig.defaultProvider]) {
        const pk = rawConfig.providers[rawConfig.defaultProvider].apiKey;
        if (typeof pk === "string" && pk !== "YOUR_API_KEY") {
          originalApiKey = pk;
        }
      }

      // Detect mode: if there's more than just one known provider, go advanced
      const hasExtraProviders = rawConfig.providers &&
        typeof rawConfig.providers === "object" &&
        Object.keys(rawConfig.providers).some((k) => !(k in PROVIDERS));
      const hasExtensions = Array.isArray(rawConfig.extensions) && rawConfig.extensions.length > 0;
      const hasExtraFields = Object.keys(rawConfig).some(
        (k) => !["providers", "defaultProvider", "extensions", "defaultBackend"].includes(k)
      );

      if (hasExtraProviders || hasExtensions || hasExtraFields) {
        switchConfigMode("advanced");
      } else {
        switchConfigMode("simple");
      }

      if (configMode === "simple") {
        parseConfigToSimple(rawConfig);
      } else {
        validateJson();
      }
    } else {
      configOverlay.setAttribute("hidden", "");
    }
  };

  // ── Mode tab clicks ──────────────────────────────────────────────
  configModeTabs?.addEventListener("click", (ev) => {
    const tab = ev.target.closest(".config-mode-tab");
    if (!tab) return;
    switchConfigMode(tab.dataset.mode);
  });

  // ── Advanced: JSON validation ────────────────────────────────────
  const validateJson = () => {
    const val = configEditor.value;
    try {
      JSON.parse(val);
      configValid.hidden = false;
      configInvalid.hidden = true;
      configEditor.classList.remove("config-error");
      return true;
    } catch {
      configValid.hidden = true;
      configInvalid.hidden = false;
      configEditor.classList.add("config-error");
      return false;
    }
  };

  configEditor?.addEventListener("input", validateJson);

  configEditor?.addEventListener("keydown", (ev) => {
    if (ev.key === "Tab") {
      ev.preventDefault();
      const start = configEditor.selectionStart;
      const end = configEditor.selectionEnd;
      configEditor.value = configEditor.value.substring(0, start) + "  " + configEditor.value.substring(end);
      configEditor.selectionStart = configEditor.selectionEnd = start + 2;
    }
    if (ev.key === "s" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      configSave?.click();
    }
  });

  // ── Save (shared logic) ──────────────────────────────────────────
  const doSave = async (jsonStr) => {
    try {
      const r = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: jsonStr,
      });
      if (!r.ok) throw new Error(await r.text());
      originalConfig = jsonStr;
      setConfigOpen(false);
    } catch (e) {
      alert(`save failed: ${e.message ?? e}`);
    }
  };

  // ── Advanced: save button ────────────────────────────────────────
  configSave?.addEventListener("click", async () => {
    if (!validateJson()) return;
    await doSave(configEditor.value);
  });

  // ── Simple: save button ──────────────────────────────────────────
  configSaveSimple?.addEventListener("click", async () => {
    const config = buildConfig();
    if (!config) return;

    // Replace placeholder if user didn't enter a key but one already existed
    if (!configApikey.value.trim() && originalApiKey) {
      const providerId = configProvider.value;
      config.providers[providerId].apiKey = originalApiKey;
    }

    await doSave(JSON.stringify(config, null, 2) + "\n");
  });

  // ── Advanced: format button ──────────────────────────────────────
  configFormat?.addEventListener("click", () => {
    try {
      const parsed = JSON.parse(configEditor.value);
      configEditor.value = JSON.stringify(parsed, null, 2);
      validateJson();
    } catch {}
  });

  // ── Reset ────────────────────────────────────────────────────────
  configReset?.addEventListener("click", () => {
    if (configMode === "advanced") {
      configEditor.value = originalConfig;
      validateJson();
    } else {
      parseConfigToSimple(JSON.parse(originalConfig || "{}"));
    }
  });

  configToggle?.addEventListener("click", () => setConfigOpen(configOverlay.hasAttribute("hidden")));
  configClose?.addEventListener("click", () => setConfigOpen(false));
  configOverlay?.addEventListener("click", (ev) => {
    if (ev.target === configOverlay) setConfigOpen(false);
  });

  // ── Message action helpers ──────────────────────────────────────────
  // All turn-targeting operations use the atomic /context/rewind-to-turn
  // endpoint so the snapshot→rewind gap is server-side and race-free.

  // Rewind to before a given turn number (atomic server-side operation).
  const rewindToTurn = async (turn) => {
    const res = await fetch(`/${sessionId}/context/rewind-to-turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turn }),
    });
    if (!res.ok) {
      const msg = await res.text();
      throw new Error(msg || `rewind failed (${res.status})`);
    }
  };

  // Submit a query string (routes /slash commands correctly).
  const submitAndReload = async (text) => {
    const trimmed = text.trim();
    let endpoint, body;
    if (trimmed.startsWith("/")) {
      const space = trimmed.indexOf(" ");
      endpoint = `/${sessionId}/command`;
      body = JSON.stringify({
        name: space === -1 ? trimmed : trimmed.slice(0, space),
        args: space === -1 ? "" : trimmed.slice(space + 1),
      });
    } else {
      endpoint = submitUrl;
      body = JSON.stringify({ query: trimmed });
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(await res.text());
  };

  // ── Action: delete turn ─────────────────────────────────────────────
  // Rewinds to before the turn's user message, dropping it and everything
  // after.  Uses the atomic server-side endpoint.
  const deleteTurn = async (el) => {
    if (isProcessing) return;
    const turn = Number(el.dataset.turn);
    if (!Number.isInteger(turn) || turn < 0) return;
    if (!confirm("Delete this turn and everything after it?")) return;
    try {
      await rewindToTurn(turn);
      location.reload();
    } catch (e) {
      alert(`Delete failed: ${e.message ?? e}`);
    }
  };

  // ── Action: regenerate response ─────────────────────────────────────
  // Rewinds to before the turn, then resubmits the original query.
  const regenTurn = async (box) => {
    if (isProcessing) return;
    const turn = Number(box.dataset.turn);
    const query = box._queryText;
    if (!Number.isInteger(turn) || turn < 0 || !query) return;

    // Phase 1: rewind.  If this fails, nothing changed — stay on page.
    try {
      await rewindToTurn(turn);
    } catch (e) {
      alert(`Regenerate failed: ${e.message ?? e}`);
      return; // don't reload — context is unchanged
    }

    // Phase 2: resubmit.  Context was already rewound, so we always
    // reload afterwards to keep the UI consistent.
    try {
      await submitAndReload(query);
    } catch (e) {
      alert(`Regenerate: message resubmit failed.\n${e.message ?? e}`);
    }
    location.reload();
  };

  // ── Action: edit user message ───────────────────────────────────────
  // Replaces the q-text with an inline textarea.  On save: rewinds to
  // before this message, submits the edited text, and reloads.
  const editUserMsg = (box) => {
    if (isProcessing) return;
    if (box.classList.contains("editing")) return;
    if (box._editingLocked) return;

    const qText = box.querySelector(".q-text");
    if (!qText) return;

    // Replace action buttons with save/cancel
    const actions = box.querySelector(".msg-actions");
    if (actions) {
      actions.innerHTML = `
        <button class="msg-action-btn" data-action="save" title="Save (Enter)">✓</button>
        <button class="msg-action-btn" data-action="cancel" title="Cancel (Esc)">✗</button>`;
      actions.querySelector('[data-action="save"]')?.addEventListener("click", () => saveEdit(box));
      actions.querySelector('[data-action="cancel"]')?.addEventListener("click", () => cancelEdit(box));
    }

    // Switch to edit mode
    box.classList.add("editing");
    const orig = box._queryText ?? "";
    const textarea = document.createElement("textarea");
    textarea.className = "msg-edit-area";
    textarea.value = orig;
    textarea.rows = Math.max(1, Math.min(12, orig.split("\n").length));

    // Store the old content for cancel
    const oldHTML = qText.innerHTML;
    box._oldQTextHTML = oldHTML;

    qText.innerHTML = "";
    qText.appendChild(textarea);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Enter saves, Shift+Enter inserts newline, Escape cancels
    textarea.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); cancelEdit(box); }
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); saveEdit(box); }
    });

    // Auto-resize as user types
    const resize = () => {
      textarea.style.height = "auto";
      textarea.style.height = textarea.scrollHeight + "px";
    };
    textarea.addEventListener("input", resize);
    resize();
  };

  const cancelEdit = (box) => {
    if (box._editingLocked) return;
    box._editingLocked = true;
    try {
      const qText = box.querySelector(".q-text");
      if (qText && box._oldQTextHTML != null) qText.innerHTML = box._oldQTextHTML;
      box.classList.remove("editing");
      box._oldQTextHTML = null;
      // Restore original action buttons
      const actions = box.querySelector(".msg-actions");
      if (actions) {
        actions.innerHTML = `
          <button class="msg-action-btn" data-action="edit" title="Edit message">✎</button>
          <button class="msg-action-btn" data-action="regen" title="Regenerate response">↻</button>
          <button class="msg-action-btn danger" data-action="delete" title="Delete turn">✕</button>`;
        actions.querySelector('[data-action="edit"]')?.addEventListener("click", () => editUserMsg(box));
        actions.querySelector('[data-action="regen"]')?.addEventListener("click", () => regenTurn(box));
        actions.querySelector('[data-action="delete"]')?.addEventListener("click", () => deleteTurn(box));
      }
    } finally {
      box._editingLocked = false;
    }
  };

  const saveEdit = async (box) => {
    if (isProcessing) return;
    if (box._editingLocked) return;
    const textarea = box.querySelector(".msg-edit-area");
    const newText = textarea?.value?.trim() ?? "";
    if (!newText) {
      // Show feedback that empty input is not allowed
      if (textarea) {
        textarea.classList.add("error");
        setTimeout(() => textarea.classList.remove("error"), 800);
      }
      return;
    }
    const turn = Number(box.dataset.turn);
    if (!Number.isInteger(turn) || turn < 0) return;

    box._editingLocked = true;

    // Phase 1: rewind.  If this fails, stay in edit mode.
    try {
      await rewindToTurn(turn);
    } catch (e) {
      box._editingLocked = false;
      alert(`Edit failed: ${e.message ?? e}`);
      return; // don't reload — context is unchanged, keep edit state
    }

    // Phase 2: resubmit.  Context was already rewound, so we always
    // reload afterwards to keep the UI consistent.
    try {
      await submitAndReload(newText);
    } catch (e) {
      alert(`Edit: message resubmit failed.\n${e.message ?? e}`);
    }
    location.reload();
  };

  // ── External link interception ────────────────────────────────────────
  // Agent responses may contain hyperlinks. Clicks on external URLs
  // must never navigate the app window away — instead open them in the
  // system default browser (Electron) or a new tab (browser).
  document.addEventListener("click", (ev) => {
    const a = ev.target.closest("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

    let isExternal = false;
    try {
      const u = new URL(href, location.origin);
      isExternal = u.origin !== location.origin;
    } catch {
      // Relative paths, root-relative paths, etc. — let them through
      return;
    }

    if (!isExternal) return; // same-origin link, allow normal navigation

    ev.preventDefault();
    const url = href;
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url).catch(() => {});
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  });

  // ── Version & update check ───────────────────────────────────────────
  (async () => {
    if (!versionLabel) return;

    // Fetch current version from the hub API
    try {
      const resp = await fetch("/api/version");
      const data = await resp.json();
      const current = data.version || "0.0.0";
      // Guard: if an update event already fired while we were fetching,
      // don't overwrite the update notification.
      if (!versionLabel.classList.contains("has-update")) {
        versionLabel.textContent = `v${current}`;
        versionLabel.classList.add("visible", "up-to-date");
        versionLabel.title = `asHub v${current}`;
      }
    } catch {
      if (!versionLabel.classList.contains("has-update")) {
        versionLabel.textContent = "";
        versionLabel.title = "";
      }
    }

    // Listen for update events from Electron
    if (window.electronAPI?.onUpdateAvailable) {
      let updateClickBound = false;
      window.electronAPI.onUpdateAvailable((newVersion) => {
        if (!versionLabel) return;
        versionLabel.textContent = `v${newVersion} available`;
        versionLabel.classList.add("visible");
        versionLabel.classList.remove("up-to-date");
        versionLabel.classList.add("has-update");
        versionLabel.title = `Update to v${newVersion} — click to download`;
        if (!updateClickBound) {
          updateClickBound = true;
          let checking = false;
          versionLabel.addEventListener("click", async () => {
            if (checking) return;
            checking = true;
            try {
              await window.electronAPI.checkForUpdate?.();
            } finally {
              checking = false;
            }
          });
        }
      });
    }
  })();
})();
