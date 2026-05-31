import { escape, stripAnsi, mdToHtml, highlightWithin, renderMathIn, blockToText } from "./utils.js";
import { setBusy } from "./state.js";
import { effect } from "../vendor/signals-core.js";
import { t } from "./i18n.js";
import { maybeScroll, forceScrollBottom } from "./stream/scroll.js";
import { append, appendAfterPending, appendToGroup, bumpToolCount } from "./stream/tool-group.js";
import {
  renderUsage, hideUsage, renderTurnSep, renderErrorCard,
  renderDiffBlock, renderToolBody, buildToolRow,
} from "./stream/renderers.js";
import {
  showThinking, hideThinking,
  appendThinkingChunk, finalizeThinking,
  sweepOrphanThinking,
} from "./stream/thinking.js";
import {
  appendReplyChunk, fillFinalReply, closeReply, cancelReply, hasReply,
  sawLiveSegment, startNewSegment, addReplyCopyBtn,
} from "./stream/reply.js";
import {
  appendLiveOutputChunk, finalizeLiveOutput, resetCompletedTools,
  absorbAsToolBody, trackToolRow,
} from "./stream/live-output.js";
import { createUserBox } from "./actions.js";
import { updateSessionTitle, setSessionStatus } from "./sidebar.js";
import { refreshFilesIfOpen } from "./files-panel.js";
import { refreshTreeIfOpen } from "./tree-panel.js";
import { compactReasoning } from "./stream/compact.js";
import { startShellBlock, finishShellBlock, queueShellBlock } from "./stream/shell-block.js";
import { activeSession, globalConnState, sessions } from "./session-manager.js";

// Shared page chrome — reflects the active session, not whatever frame just arrived.
const conn = document.getElementById("conn");
const dot = document.querySelector(".live-dot");
const instanceLabel = document.getElementById("instance");
const spinnerEl = document.getElementById("spinner");
const cancelBtnEl = document.getElementById("cancel-turn");
const pageLoader = document.getElementById("page-loader");
const loaderBar = document.getElementById("page-loader-bar");
const loaderBarFill = document.getElementById("page-loader-bar-fill");

if (loaderBar) loaderBar.classList.add("visible");
if (loaderBarFill) {
  setTimeout(() => { loaderBarFill.style.width = "30%"; }, 100);
  setTimeout(() => { loaderBarFill.style.width = "65%"; }, 1200);
  setTimeout(() => { loaderBarFill.style.width = "90%"; }, 3000);
}

export const hidePageLoader = () => {
  if (loaderBarFill) loaderBarFill.style.width = "100%";
  setTimeout(() => {
    if (pageLoader) pageLoader.classList.add("hidden");
  }, 200);
};

// ── Balance display (DeepSeek) — rendered in each session's usage strip ──

const BALANCE_CACHE_TTL = 120_000;
let _balanceCache = null;
let _balanceCacheTs = 0;

const updateBalanceDisplay = async () => {
  const session = activeSession.peek();
  if (!session?.balanceEl) return;
  const provider = session.agentInfo?.provider ?? "";
  if (provider !== "deepseek") {
    session.balanceEl.hidden = true;
    return;
  }

  if (_balanceCache && Date.now() - _balanceCacheTs < BALANCE_CACHE_TTL) {
    renderBalance(session, _balanceCache);
    return;
  }

  try {
    const r = await fetch("/api/balance?provider=deepseek");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    _balanceCache = data;
    _balanceCacheTs = Date.now();
    renderBalance(session, data);
  } catch {
    session.balanceEl.textContent = "💰 —";
    session.balanceEl.title = "Balance unavailable";
    session.balanceEl.hidden = false;
  }
};

function renderBalance(session, data) {
  if (!session?.balanceEl) return;
  if (!data?.is_available || !Array.isArray(data?.balance_infos) || !data.balance_infos.length) {
    session.balanceEl.textContent = "💰 —";
    session.balanceEl.title = "Balance unavailable";
    session.balanceEl.hidden = false;
    return;
  }
  const info = data.balance_infos[0];
  const currency = info.currency === "CNY" ? "¥" : (info.currency ?? "");
  const total = info.total_balance ?? "—";
  session.balanceEl.textContent = `💰 ${currency}${total}`;
  session.balanceEl.title = data.balance_infos.map((bi) => {
    const c = bi.currency === "CNY" ? "¥" : (bi.currency ?? "");
    return `Total: ${c}${bi.total_balance ?? "—"}  |  Top-up: ${c}${bi.topped_up_balance ?? "—"}  |  Grant: ${c}${bi.granted_balance ?? "—"}`;
  }).join("\n");
  session.balanceEl.hidden = false;
}

// Hide balance on session switch, then re-show if DeepSeek.
effect(() => {
  activeSession.value;
  const s = activeSession.peek();
  if (s?.balanceEl) {
    s.balanceEl.hidden = true;
    // For cached sessions (SPA switch-back), agent:info won't re-fire.
    // Use the already-loaded agentInfo to decide whether to show.
    if (s.agentInfo?.provider === "deepseek") updateBalanceDisplay();
  }
});

// Hide balance on session switch — agent:info will re-show for supported providers.
effect(() => {
  activeSession.value;
  const s = activeSession.peek();
  if (s?.balanceEl) s.balanceEl.hidden = true;
});

effect(() => {
  const cs = globalConnState.value;
  if (conn) switch (cs) {
    case "connected":     conn.textContent = ""; break;
    case "connecting":    conn.textContent = t("connecting"); break;
    case "reconnecting":  conn.textContent = t("reconnecting"); break;
    case "nosession":     conn.textContent = t("no.session"); break;
  }
  if (dot) dot.classList.toggle("stale", cs !== "connected");
});

export const renderInstanceLabel = () => {
  if (!instanceLabel) return;
  const ai = activeSession.peek()?.agentInfo;
  const showThink = ai?.thinkingSupported && ai?.thinkingLevel && ai.thinkingLevel !== "off";
  const inner = [ai?.model, showThink ? ai.thinkingLevel : ""].filter(Boolean).join(" • ");
  const tag = inner ? `[${inner}]` : "";
  instanceLabel.textContent = [ai?.name, tag].filter(Boolean).join(" ");
};

// On active-session switch, chrome catches up to the new session's state.
effect(() => {
  const s = activeSession.value;
  renderInstanceLabel();
  const busy = !!s?.state?.isProcessing;
  if (spinnerEl) spinnerEl.hidden = !busy;
  if (cancelBtnEl) cancelBtnEl.hidden = !busy;
});

export const REPLAY_FLUSH_DELAY = 12;  // ms

// Handlers run with `this` bound to the owning SessionView.
export const handlers = {
  "agent:info"(p) {
    if (p?.name === "web-renderer") return;
    if (p?.name) this.agentInfo.name = p.name;
    if (p?.model) this.agentInfo.model = p.model;
    if (p?.provider) this.agentInfo.provider = p.provider;
    if (typeof p?.thinkingLevel === "string") this.agentInfo.thinkingLevel = p.thinkingLevel;
    if (typeof p?.thinkingSupported === "boolean") this.agentInfo.thinkingSupported = p.thinkingSupported;
    if (Array.isArray(p?.modalities)) this.agentInfo.modalities = p.modalities;
    // Update image upload button visibility for the active session.
    if (this === activeSession.peek()) {
      const btn = document.getElementById("vision-indicator");
      if (btn) {
        const hasVision = this.agentInfo.modalities?.includes("image") || modelSupportsImages(this.agentInfo.model, this.agentInfo.provider);
        btn.hidden = !hasVision;
      }
    }
    if (typeof p?.contextWindow === "number" && p.contextWindow > 0) {
      this.state.contextWindow = p.contextWindow;
      if (this.state.lastUsage) renderUsage(this);
    }
    refreshModelChip(this);
    if (this === activeSession.peek()) {
      renderInstanceLabel();
      updateBalanceDisplay();
    }
  },

  "shell:cwd-change"(p) {
    this.state.cwd = p?.cwd ?? "";
    refreshCwdChip(this);
    if (this === activeSession.peek()) refreshFilesIfOpen();
  },

  // Queue-lifecycle: when the hub enqueues a message (agent is busy),
  // it pushes agent:queued with the user's submission timestamp.  We
  // render the same optimistic separator + pending box that composer.js
  // does for live viewers, so that replay/reconnect renders queued turns
  // with the correct submission timestamp rather than the dequeue time.
  //
  // We use appendAfterPending so queued messages stack in submission
  // order at the end rather than inverting during replay.
  "agent:queued"(p, meta) {
    const queryText = p?.query ?? "";
    if (!queryText) return;
    // Don't create duplicate optimistic boxes — composer.js may have
    // already done so for live viewers.
    const existing = this.streamEl?.querySelector(
      `.agent-box.pending[data-queued="${CSS.escape(queryText)}"]`
    ) ?? Array.from(this.streamEl?.querySelectorAll(".agent-box.pending") ?? [])
      .find((pb) => pb._queryText === queryText);
    if (existing) return;
    // Build turn-separator manually (same as renderTurnSep) but append
    // after any pending boxes to preserve submission order.
    const cwd = this.state.cwd ?? "";
    const date = meta?.ts ? new Date(meta.ts) : new Date();
    const sep = document.createElement("div");
    sep.className = "turn-sep";
    sep.innerHTML =
      `<span class="turn-line"></span>` +
      (cwd ? `<span class="turn-cwd">${escape(cwd)}</span>` : "") +
      `<span class="turn-time">${date.toLocaleTimeString()}</span>` +
      `<span class="turn-line"></span>`;
    appendAfterPending(this, sep);
    const box = createUserBox(queryText);
    box.classList.add("pending");
    box.dataset.queued = queryText;
    box._queryText = queryText;
    appendAfterPending(this, box);
  },

  "agent:query"(p, meta) {
    closeReply(this);
    finalizeThinking(this);
    finalizeLiveOutput(this);
    resetCompletedTools(this);
    startNewSegment(this);
    const queryText = p?.query ?? "";
    // Match optimistic boxes: first by data-queued (replay), then by
    // _queryText (composer.js live path).
    let matched = this.streamEl?.querySelector(`.agent-box.pending[data-queued="${CSS.escape(queryText)}"]`) ?? null;
    if (!matched) {
      for (const pb of this.streamEl?.querySelectorAll(".agent-box.pending") ?? []) {
        if (pb._queryText === queryText) { matched = pb; break; }
      }
    }
    if (matched) {
      this.state.currentTurn++;
      matched.dataset.turn = String(this.state.currentTurn);
      matched.classList.remove("pending");
      delete matched.dataset.queued;
      return;
    }
    this.state.currentTurn++;
    renderTurnSep(this, meta?.ts);
    const box = createUserBox(queryText);
    box.dataset.turn = String(this.state.currentTurn);
    append(this, box);
  },

  "agent:processing-start"() {
    this.state.lastUsage = null;
    hideUsage(this);
    setBusy(this, true);
    if (!this.state.replaying) setSessionStatus(this.id, "session-streaming");
    hideThinking(this);
    sweepOrphanThinking(this);
    finalizeThinking(this);
    finalizeLiveOutput(this);
    resetCompletedTools(this);
    startNewSegment(this);
    showThinking(this);
  },

  "agent:response-chunk"(p) {
    const blocks = Array.isArray(p?.blocks) ? p.blocks : [];
    const delta = blocks.map(blockToText).join("");
    if (!delta) return;
    finalizeThinking(this);
    appendReplyChunk(this, delta);
  },

  // Replay-only: live chunks already covered the segment.
  "agent:response-segment"(p) {
    if (hasReply(this) || sawLiveSegment(this)) return;
    if (!p?.text) return;
    finalizeThinking(this);
    const block = document.createElement("div");
    block.className = "agent-reply";
    block.dataset.turn = String(this.state.currentTurn);
    block.innerHTML = mdToHtml(stripAnsi(p.text));
    append(this, block);
    renderMathIn(block);
    if (!this.state.replaying) highlightWithin(block);
    addReplyCopyBtn(block, stripAnsi(p.text ?? ""));
  },

  "agent:thinking-chunk"(p) {
    appendThinkingChunk(this, stripAnsi(p?.text ?? ""));
  },

  "agent:response-done"(p) {
    if (p?.response) fillFinalReply(this, p.response);
    closeReply(this);
  },

  "agent:processing-done"() {
    closeReply(this);
    hideThinking(this);
    finalizeThinking(this);
    finalizeLiveOutput(this);
    renderUsage(this);
    if (this.usageStripEl) this.usageStripEl.hidden = false;
    setBusy(this, false);
    if (!this.state.replaying) setSessionStatus(this.id, "");
    if (!this.state.replaying && this.streamEl) compactReasoning(this.streamEl);
    this.scheduleReplayFlush();
    if (!this.state.replaying && this === activeSession.peek()) {
      refreshTreeIfOpen();
      updateBalanceDisplay();
    }
    if (!this.state.replaying) refreshGitBranch(this);
  },

  "agent:cancelled"() {
    cancelReply(this);
    hideThinking(this);
    finalizeThinking(this);
    finalizeLiveOutput(this);
    setBusy(this, false);
    if (!this.state.replaying) setSessionStatus(this.id, "");
    if (!this.state.replaying && this.streamEl) compactReasoning(this.streamEl);
    this.scheduleReplayFlush();
  },

  "agent:error"(p) {
    closeReply(this);
    hideThinking(this);
    finalizeThinking(this);
    finalizeLiveOutput(this);
    append(this, renderErrorCard(p?.message ?? "", p?.detail ?? p?.stack));
    setBusy(this, false);
    if (!this.state.replaying) setSessionStatus(this.id, "");
    if (!this.state.replaying && this.streamEl) compactReasoning(this.streamEl);
    this.scheduleReplayFlush();
  },

  "agent:usage"(p) { this.state.lastUsage = p; renderUsage(this); },

  "shell:command-start"(p) { startShellBlock(this, p ?? {}); },
  "shell:command-done"(p) { finishShellBlock(this, p ?? {}); },
  "shell:queued"(p) { queueShellBlock(this, p ?? {}); },

  "session:title"(p) {
    updateSessionTitle(this.id, p?.title ?? "");
  },

  "hub:branch-switched"() {
    this.resetForBranchSwitch?.();
    if (this === activeSession.peek()) refreshTreeIfOpen();
  },

  "hub:compaction-marker"(p) {
    if (!this.streamEl) return;
    const evicted = Number(p?.evictedCount ?? 0);
    const pill = document.createElement("div");
    pill.className = "compaction-marker";
    pill.innerHTML =
      `<span class="cm-line"></span>` +
      `<span class="cm-pill">📦 ${evicted} message(s) compacted</span>` +
      `<span class="cm-line"></span>`;
    const target = (this.state.replaying && this._replayFrag) || this.streamEl;
    if (target) target.appendChild(pill);
  },

  "agent:tool-started"(p) {
    closeReply(this);
    finalizeThinking(this);
    finalizeLiveOutput(this);
    startNewSegment(this);
    const row = buildToolRow(p);
    appendToGroup(this, row);
    trackToolRow(this, row);
    bumpToolCount(this);
  },

  "agent:tool-completed"(p) {
    const id = p?.toolCallId ?? "";
    const row = id ? this.streamEl?.querySelector(`.tool-row[data-call-id="${CSS.escape(id)}"]`) : null;
    if (!row) return;
    const ok = p?.exitCode === 0 || p?.exitCode == null;
    row.classList.add(ok ? "ok" : "err");
    const summary = p?.resultDisplay?.summary ?? "";
    const mark = ok ? "✓" : `✗ exit ${p?.exitCode}`;
    const tail = document.createElement("span");
    tail.className = "tool-mark";
    tail.textContent = (summary ? ` ${summary} ` : "  ") + mark;
    row.appendChild(tail);

    if (!absorbAsToolBody(this, id)) {
      const body = p?.resultDisplay?.body;
      if (body?.kind === "lines" && Array.isArray(body.lines) && body.lines.length) {
        const block = renderToolBody(body.lines);
        row.parentNode.insertBefore(block, row.nextSibling);
      } else if (body?.kind === "diff" && body.diff) {
        let preview = row.previousElementSibling;
        while (preview && !preview.classList.contains("diff-preview")) {
          preview = preview.previousElementSibling;
        }
        if (preview) {
          preview.classList.remove("diff-preview");
          row.parentNode.insertBefore(preview, row.nextSibling);
        } else {
          const block = renderDiffBlock(body.diff, body.filePath);
          row.parentNode.insertBefore(block, row.nextSibling);
        }
      }
    }
    maybeScroll(this);
  },

  "agent:tool-output-chunk"(p) {
    appendLiveOutputChunk(this, p?.chunk ?? "");
  },

  "permission:request"(p) {
    if (p?.kind === "file-write" && p?.metadata?.diff) {
      closeReply(this);
      const block = renderDiffBlock(p.metadata.diff, p.title ?? p.metadata.filePath ?? "");
      block.classList.add("diff-preview");
      appendToGroup(this, block);
    }
  },

  "ui:info"(p) {
    const row = document.createElement("div");
    row.className = "ui-info";
    row.textContent = String(p?.message ?? "");
    append(this, row);
  },
  "ui:error"(p) {
    append(this, renderErrorCard(p?.message || t("command.failed"), null));
  },

  // Hub sentinel: fired synchronously after the replay loop so the client
  // can exit batching mode deterministically, even when live events from
  // an active turn arrive immediately after replay.
  "hub:replay-done"() {
    if (this.state.replaying) this.exitReplayMode();
  },
};

// Heavy work deferred until replay batch completes — invoked by
// SessionView.exitReplayMode().
export const onReplayDone = (session) => {
  if (!session?.streamEl) return;
  sweepOrphanThinking(session);
  compactReasoning(session.streamEl);
  highlightWithin(session.streamEl);
  renderMathIn(session.streamEl);
  forceScrollBottom(session);
  refreshGitBranch(session);
  refreshModelChip(session);
  refreshCwdChip(session);
};

export const seedSessionInfo = (session, info) => {
  if (!session || !info) return;
  if (info.cwd && !session.state.cwd) session.state.cwd = info.cwd;
  if (info.model && !session.agentInfo.model) session.agentInfo.model = info.model;
  if (info.provider && !session.agentInfo.provider) session.agentInfo.provider = info.provider;
  if (session.usageStripEl) session.usageStripEl.hidden = false;
  refreshModelChip(session);
  refreshCwdChip(session);
  refreshGitBranch(session);
};

const refreshModelChip = (session) => {
  if (!session?.modelEl) return;
  const wrap = session.modelEl.closest(".terminal-wrap");
  if (wrap?.dataset.uiUsageModelShow !== "true") { session.modelEl.hidden = true; return; }
  const ai = session.agentInfo;
  const showThink = ai?.thinkingSupported && ai?.thinkingLevel && ai.thinkingLevel !== "off";
  const modelLabel = ai?.provider ? `${ai.model}@${ai.provider}` : ai?.model;
  const text = [modelLabel, showThink ? `[${ai.thinkingLevel}]` : ""].filter(Boolean).join(" ");
  if (text) { session.modelEl.textContent = text; session.modelEl.hidden = false; }
  else { session.modelEl.hidden = true; }

  // Attach model-picker click handler (once per session)
  if (session.modelPickerEl && !session._modelPickerAttached) {
    session._modelPickerAttached = true;
    session.modelEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleModelDropdown(session);
    });
  }
};

// ── Model picker dropdown ───────────────────────────────────────────

let _allModelsCache = null;  // { providers: [{ name, models: [{id, modalities}] }] }

// Build a quick lookup: "provider:model" -> modalities or undefined.
const getModelCapabilities = () => {
  if (!_allModelsCache) return null;
  const caps = new Map();
  for (const p of _allModelsCache.providers || []) {
    for (const m of p.models || []) {
      if (m.modalities) caps.set(`${p.name}:${m.id}`, m.modalities);
    }
  }
  return caps;
};

// Check if the given model+provider supports image input.
export const modelSupportsImages = (model, provider) => {
  const caps = getModelCapabilities();
  if (!caps) return false;
  return caps.get(`${provider}:${model}`)?.includes("image") ?? false;
};

const toggleModelDropdown = async (session) => {
  const dropdown = session.modelDropdownEl;
  if (!dropdown) return;

  // Close if already open
  if (!dropdown.hidden) {
    dropdown.hidden = true;
    // Clean up the stale document click handler
    if (dropdown._closeHandler) {
      document.removeEventListener("click", dropdown._closeHandler);
      dropdown._closeHandler = null;
    }
    return;
  }

  // Close any other open dropdowns
  document.querySelectorAll(".model-dropdown").forEach((d) => {
    d.hidden = true;
    if (d._closeHandler) {
      document.removeEventListener("click", d._closeHandler);
      d._closeHandler = null;
    }
  });

  // Fetch all models if not cached
  if (!_allModelsCache) {
    try {
      const r = await fetch("/api/models");
      _allModelsCache = await r.json();
    } catch {
      return;
    }
  }

  const providers = _allModelsCache.providers || [];
  if (!providers.length) return;

  const currentModel = session.agentInfo?.model;
  const currentProvider = session.agentInfo?.provider;

  // Build dropdown HTML with search and provider groups
  dropdown.innerHTML =
    `<div class="model-dropdown-search">` +
      `<input type="text" class="model-search-input" placeholder="${t("search.models") || "Search models…"}" autocomplete="off">` +
    `</div>` +
    `<div class="model-dropdown-list">` +
      providers.map((p) => {
        const models = p.models || [];
        if (!models.length) return "";
        const isCurrent = p.name === currentProvider;
        return `<div class="model-group" data-provider="${escapeAttr(p.name)}">` +
          `<div class="model-group-head">${escapeAttr(p.name)}${isCurrent ? ` <span class="model-group-badge">current</span>` : ""}</div>` +
          models.map((m) => {
            const id = m.id;
            const sel = (id === currentModel && isCurrent) ? " selected" : "";
            return `<div class="model-option${sel}" data-model="${escapeAttr(id)}" data-provider="${escapeAttr(p.name)}">${escapeAttr(id)}</div>`;
          }).join("") +
        `</div>`;
      }).join("") +
    `</div>`;

  // Click handlers
  dropdown.querySelectorAll(".model-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      const modelId = opt.dataset.model;
      const provider = opt.dataset.provider;
      if (modelId) selectModel(session, modelId, provider);
      dropdown.hidden = true;
      if (dropdown._closeHandler) {
        document.removeEventListener("click", dropdown._closeHandler);
        dropdown._closeHandler = null;
      }
    });
  });

  // Search filter
  const searchInput = dropdown.querySelector(".model-search-input");
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.toLowerCase().trim();
      dropdown.querySelectorAll(".model-group").forEach((group) => {
        let visible = false;
        group.querySelectorAll(".model-option").forEach((opt) => {
          const match = !q || opt.dataset.model.toLowerCase().includes(q);
          opt.hidden = !match;
          if (match) visible = true;
        });
        group.hidden = !visible;
      });
    });
    // Focus the search input after a tick
    setTimeout(() => searchInput.focus(), 50);
  }

  // Position dropdown above the model chip — append to body to escape overflow:hidden
  if (dropdown.parentNode !== document.body) {
    document.body.appendChild(dropdown);
  }
  const chipRect = session.modelEl.getBoundingClientRect();
  dropdown.style.left = `${chipRect.left}px`;
  dropdown.style.top = `${chipRect.top}px`;
  dropdown.style.transform = "translateY(-100%) translateY(-6px)";

  dropdown.hidden = false;

  // Remove stale handler before adding new one
  if (dropdown._closeHandler) {
    document.removeEventListener("click", dropdown._closeHandler);
  }
  const close = (e) => {
    if (!dropdown.contains(e.target) && e.target !== session.modelEl) {
      dropdown.hidden = true;
      document.removeEventListener("click", close);
      dropdown._closeHandler = null;
    }
  };
  dropdown._closeHandler = close;
  setTimeout(() => document.addEventListener("click", close), 0);
};

const selectModel = (session, modelId, provider) => {
  session.agentInfo.model = modelId;
  if (provider) session.agentInfo.provider = provider;
  refreshModelChip(session);
  fetch(`/${session.id}/model`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelId, provider: provider || undefined }),
  }).catch(() => {});
};

const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const refreshCwdChip = (session) => {
  if (!session?.cwdEl) return;
  const wrap = session.cwdEl.closest(".terminal-wrap");
  if (wrap?.dataset.uiUsageCwdShow !== "true") { session.cwdEl.hidden = true; return; }
  const cwd = session.state?.cwd ?? "";
  if (!cwd) { session.cwdEl.hidden = true; return; }
  if (session.cwdEl.title === cwd) return;
  const base = cwd.split("/").filter(Boolean).pop() ?? cwd;
  session.cwdEl.textContent = base;
  session.cwdEl.title = cwd;
  session.cwdEl.hidden = false;
};

const refreshGitBranch = async (session) => {
  if (!session?.branchEl || !session.id) return;
  const wrap = session.branchEl.closest(".terminal-wrap");
  if (wrap?.dataset.uiUsageGitBranch === "false") { session.branchEl.hidden = true; return; }
  try {
    const r = await fetch(`/${session.id}/git-branch`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { branch } = await r.json();
    if (branch) {
      session.branchEl.textContent = branch;
      session.branchEl.hidden = false;
    } else {
      session.branchEl.hidden = true;
    }
  } catch { session.branchEl.hidden = true; }
};
