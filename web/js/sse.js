import { escape, stripAnsi, mdToHtml, highlightWithin, renderMathIn, blockToText } from "./utils.js";
import { setBusy } from "./state.js";
import { effect } from "../vendor/signals-core.js";
import { t } from "./i18n.js";
import { maybeScroll, forceScrollBottom } from "./stream/scroll.js";
import { append, appendAfterPending, appendToGroup, bumpToolCount, insertStreamNode, closeToolGroup } from "./stream/tool-group.js";
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
import { startShellBlock, finishShellBlock, queueShellBlock } from "./stream/shell-block.js";
import { createTodoBlock, updateTodoBlock, settleTodoBlock } from "./stream/todo-block.js";

// Lazy file panel — only loaded when shell cwd changes
const refreshFilesIfOpen = async () => {
  const panel = document.getElementById("files-panel");
  if (!panel || panel.hasAttribute("hidden")) return;
  try {
    const m = await import("./files-panel.js");
    m.refreshFilesIfOpen();
  } catch {}
};

// Lazy tree panel — only loaded when needed by processing-done
const refreshTreeIfOpen = async () => {
  const panel = document.getElementById("tree-panel");
  if (!panel || panel.hasAttribute("hidden")) return;
  try {
    const m = await import("./tree-panel.js");
    m.refreshTreeIfOpen();
  } catch {}
};

// ── System notifications (backgrounded window) ───────────────────
// Agents often run in the background; a hidden window would miss the
// 30s permission window or a finished reply.  Opt-in via the toggle in
// config-panel.js (localStorage "ash.notify"), default off.

const notifyEnabled = () => {
  try { return localStorage.getItem("ash.notify") === "1"; } catch { return false; }
};

const sendSystemNotification = (title, body) => {
  if (!document.hidden) return;
  if (typeof Notification === "undefined") return;
  if (!notifyEnabled() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      try { window.electronAPI?.focusWindow?.(); } catch {}
      n.close();
    };
  } catch {}
};

// Best-effort label for the notification body: sidebar title first,
// then the session's last query.
const sessionLabel = (session) => {
  try {
    const el = document.querySelector(
      `li[data-session-id="${CSS.escape(session?.id ?? "")}"] .session-title`
    );
    const text = el?.textContent?.trim();
    if (text) return text;
  } catch {}
  const q = session?.state?.lastQuery ?? "";
  return q.length > 60 ? q.slice(0, 60) + "…" : q;
};

// Subagent tool-name → type mapping (must match ash.ts SUBAGENT_TYPES keys)
const SUBAGENT_TOOL_NAMES = { plan: "plan", explore: "explore", review: "review", research: "research", implement: "implement" };
// The todolist tool renders as a single TODO card driven by agent:todo
// events — its tool-started/completed frames must not build tool-rows.
const TODO_TOOL_NAME = "todolist";
const SWARM_TOOL_NAME = "agentswarm";

// Parallel subagent block tracking: launch toolCallId → block and
// subagentId → block, so nested tool events route to the right block when
// several subagents run in one batch.  Lazily created on the SessionView
// instance (its own fields live in session-view.js).
const saMaps = (sv) => {
  if (!sv._saBlocksByCallId) sv._saBlocksByCallId = new Map();
  if (!sv._saBlocksBySaId) sv._saBlocksBySaId = new Map();
};
const clearSaMaps = (sv) => {
  sv._saBlocksByCallId?.clear();
  sv._saBlocksBySaId?.clear();
};
// Swarm progress blocks: swarmId → block element.  Lazily created on the
// SessionView instance; cleared on branch switch alongside the sa maps.
const swarms = (sv) => {
  if (!sv._swarms) sv._swarms = new Map();
  return sv._swarms;
};
// Update a swarm progress block's N/M counter in place.
const updateSwarmCount = (block, p) => {
  const count = block.querySelector(".swarm-count");
  if (!count) return;
  const done = Number(p?.done ?? 0);
  const total = block._swarmTotal || done;
  count.textContent = `${done}/${total}`;
  if (Number(p?.failed ?? 0) > 0) count.classList.add("swarm-failed");
};
// Owning subagentId of a nested tool id (`${subagentId}-tool-${n}`), or "".
const saIdFromToolId = (id) => {
  if (typeof id !== "string") return "";
  const i = id.lastIndexOf("-tool-");
  return i > 0 ? id.slice(0, i) : "";
};
import { compactReasoning } from "./stream/compact.js";
import { activeSession, globalConnState, sessions, forceReconnect } from "./session-manager.js";

// Shared page chrome — reflects the active session, not whatever frame just arrived.
const conn = document.getElementById("conn");
const dot = document.querySelector(".live-dot");
const instanceLabel = document.getElementById("instance");
const spinnerEl = document.getElementById("spinner");
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

// ── Balance display (DeepSeek, OpenRouter) ─────────────────────────
// Per-provider cache shared across all sessions. Refreshed at startup
// and after each agent response for the active session's provider.

const BALANCE_PROVIDERS = new Set(["deepseek", "openrouter"]);
const _balanceCache = new Map();  // provider -> { data, ts }

async function fetchProviderBalance(provider) {
  try {
    const r = await fetch(`/api/balance?provider=${provider}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    _balanceCache.set(provider, { data, ts: Date.now() });
    return data;
  } catch {
    return null;
  }
}

function renderBalance(el, data) {
  if (!el) return;
  if (!data?.is_available || !Array.isArray(data?.balance_infos) || !data.balance_infos.length) {
    el._balanceLabel = "";
    return;
  }
  const curSym = (cur) => cur === "CNY" ? "¥" : cur === "USD" ? "$" : (cur ?? "");
  const info = data.balance_infos[0];
  const total = info.total_balance ?? "—";
  el._balanceLabel = `💰 ${curSym(info.currency)}${total}`;
}

// Sync every session's balance chip: show cached data for supported
// providers, hide for unsupported ones.
function syncAllBalanceChips() {
  for (const [_, s] of sessions) {
    const el = s.balanceEl;
    if (!el) continue;
    const provider = s.agentInfo?.provider ?? "";
    if (!BALANCE_PROVIDERS.has(provider)) {
      el.hidden = true;
      continue;
    }
    const cached = _balanceCache.get(provider);
    if (cached?.data) {
      renderBalance(el, cached.data);
      refreshModelChip(s);
    } else {
      el._balanceLabel = "";
    }
  }
}

// Refresh a provider's balance and sync all chips for that provider.
async function refreshProviderBalance(provider) {
  const data = await fetchProviderBalance(provider);
  if (!data) return;
  for (const [_, s] of sessions) {
    if ((s.agentInfo?.provider ?? "") === provider && s.balanceEl) {
      renderBalance(s.balanceEl, data);
      refreshModelChip(s);
    }
  }
}

// On session switch, sync chips and usage-strip toggle.
effect(() => {
  activeSession.value;
  syncAllBalanceChips();
  const s = activeSession.peek();
  const btn = document.getElementById("usage-strip-toggle");
  if (btn && s?.usageStripEl) {
    btn.classList.toggle("collapsed", s.usageStripEl.classList.contains("collapsed"));
  }
});

// On agent response, refresh the active provider's balance.
effect(() => {
  const cs = globalConnState.value;
  if (conn) switch (cs) {
    case "connected":     conn.textContent = ""; break;
    case "connecting":    conn.textContent = t("connecting"); break;
    case "reconnecting":  conn.textContent = t("reconnecting"); break;
    case "failed":        conn.textContent = t("conn.failed"); break;
    case "nosession":     conn.textContent = t("no.session"); break;
  }
  if (dot) dot.classList.toggle("stale", cs !== "connected");
  if (conn) conn.style.cursor = cs === "failed" ? "pointer" : "";
});

// Click "failed" indicator to force reconnect
if (dot) dot.parentElement?.addEventListener("click", () => {
  if (globalConnState.peek() === "failed") forceReconnect();
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
});

export const REPLAY_FLUSH_DELAY = 12;  // ms

// ── Error classification (agent:error path only) ────────────────────
// Hub error messages are raw String(err) values ('fetch failed',
// '402 Payment Required', provider JSON…).  Map them to a friendly i18n
// category so the card headline is actionable; the original message is
// kept in the collapsible details.  Returns "auth" | "quota" |
// "network" | null (null = keep the raw message as the headline).
const classifyError = (raw) => {
  const msg = String(raw ?? "").toLowerCase();
  if (!msg) return null;
  if (/\b(401|403)\b/.test(msg) || msg.includes("unauthorized")
      || msg.includes("invalid api key") || msg.includes("forbidden")
      || msg.includes("authentication")) return "auth";
  if (/\b402\b/.test(msg) || msg.includes("balance") || msg.includes("quota")
      || msg.includes("余额不足")
      // "insufficient" alone is ambiguous — "insufficient permissions" is
      // an auth error, not a balance problem.
      || (msg.includes("insufficient") && /quota|balance|余额/.test(msg))) return "quota";
  if (msg.includes("fetch failed") || msg.includes("econnrefused")
      || msg.includes("enotfound") || msg.includes("etimedout")
      || msg.includes("network") || msg.includes("timeout")) return "network";
  return null;
};

// Open the config panel via its registered toggle button (avoids
// importing config-panel.js here).  No-op if already open — the toggle
// would otherwise close it.
const openConfigPanel = () => {
  const overlay = document.getElementById("config-overlay");
  if (overlay && !overlay.hidden && !overlay.hasAttribute("hidden")) return;
  document.getElementById("config-toggle")?.click();
};

// Resubmit a query through the composer: fill the textarea and go
// through the form's own submit path (same as pressing Enter).
const retryLastQuery = (query) => {
  const form = document.getElementById("form");
  const input = document.getElementById("query");
  if (!form || !input || !query) return;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  form.requestSubmit();
};

// Measure a permission card's diff preview and toggle the clipped state.
// Must run when the card has layout — during replay the card sits in a
// DocumentFragment (scrollHeight 0), and a hidden view has no layout
// either.  A 0 height keeps the _needsClipMeasure flag so onReplayDone /
// the visibilitychange listener below can retry.  Threshold matches the
// CSS max-height of .permission-diff-wrap (130px, live.css).
const measureDiffClip = (card) => {
  if (!card?._needsClipMeasure) return;
  const wrap = card.querySelector(".permission-diff-wrap");
  const preview = wrap?.querySelector(".permission-diff");
  if (!wrap || !preview) { card._needsClipMeasure = false; return; }
  const h = preview.scrollHeight;
  if (h === 0) return; // no layout yet — retry later
  card._needsClipMeasure = false;
  const toggle = wrap.querySelector(".permission-diff-toggle");
  if (h > 130) wrap.classList.add("clipped");
  else if (toggle) toggle.hidden = true;
};

// Re-measure flagged cards when the tab comes back to the foreground
// (live frames that arrived while the view had no layout).
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  const el = activeSession.peek()?.streamEl;
  if (!el) return;
  for (const card of el.querySelectorAll(".permission-card")) measureDiffClip(card);
});

const SA_ICONS = { plan: "✦", explore: "◈", review: "◆", research: "⚗", implement: "⚒" };

// Build a subagent block (head + collapsible body + result area). Used by
// the agent:tool-started interception (sync launches) and by
// subagent:started (swarm/async launches that have no launch tool call).
const createSubagentBlock = (session, type, taskText) => {
  const icon = SA_ICONS[type] || "⟡";
  const block = document.createElement("div");
  block.className = "subagent-block";
  block.innerHTML =
    `<div class="subagent-head">` +
      `<span class="subagent-type-badge">${escape(type)}</span>` +
      `<span class="subagent-icon">${icon}</span>` +
      `<span class="subagent-label">${escape(String(taskText).slice(0, 80))}</span>` +
      `<span class="subagent-tools-count"></span>` +
      `<span class="subagent-spinner"></span>` +
    `</div>` +
    `<div class="subagent-body" hidden></div>` +
    `<div class="subagent-result" hidden></div>`;
  block.querySelector(".subagent-head")?.addEventListener("click", () => {
    // Mark manual toggles so subagent:done won't force-expand later.
    block.dataset.userToggled = "1";
    const body = block.querySelector(".subagent-body");
    const result = block.querySelector(".subagent-result");
    if (body && body.children.length > 0) body.hidden = !body.hidden;
    if (result && body && !body.hidden) result.hidden = false;
  });
  return block;
};

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
      if (btn) btn.hidden = !this.agentInfo.modalities?.includes("image");
    }
    if (typeof p?.contextWindow === "number" && p.contextWindow > 0) {
      this.state.contextWindow = p.contextWindow;
      if (this.state.lastUsage) renderUsage(this);
    }
    refreshModelChip(this);
    if (this === activeSession.peek()) {
      renderInstanceLabel();
      syncAllBalanceChips();
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
    // already done so for live viewers.  During replay the boxes live in
    // the replay fragment, so search the container they were appended to.
    const pendRoot = (this.state.replaying && this._replayFrag) || this.streamEl;
    const existing = pendRoot?.querySelector(
      `.agent-box.pending[data-queued="${CSS.escape(queryText)}"]`
    ) ?? Array.from(pendRoot?.querySelectorAll(".agent-box.pending") ?? [])
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
    const box = createUserBox(queryText, null, meta?.ts);
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
    // Track last query here too (not just composer.js) so error-card
    // retry works after reconnect/replay as well.
    if (queryText) this.state.lastQuery = queryText;
    const images = Array.isArray(p?.images) ? p.images : null;
    // Match optimistic boxes: first by data-queued (replay), then by
    // _queryText (composer.js live path).  During replay the boxes live
    // in the replay fragment rather than streamEl.
    const pendRoot = (this.state.replaying && this._replayFrag) || this.streamEl;
    let matched = pendRoot?.querySelector(`.agent-box.pending[data-queued="${CSS.escape(queryText)}"]`) ?? null;
    if (!matched) {
      for (const pb of pendRoot?.querySelectorAll(".agent-box.pending") ?? []) {
        if (pb._queryText === queryText) { matched = pb; break; }
      }
    }
    // Slash commands (payload.command === true) are not conversation
    // turns: don't bump the turn counter, and pass turn=null so
    // createUserBox renders no rewind/fork actions for them (contract G).
    const isCommand = p?.command === true;
    if (matched) {
      if (!isCommand) {
        this.state.currentTurn++;
        matched.dataset.turn = String(this.state.currentTurn);
      }
      matched.classList.remove("pending");
      delete matched.dataset.queued;
      return;
    }
    if (!isCommand) this.state.currentTurn++;
    renderTurnSep(this, meta?.ts);
    const box = createUserBox(queryText, images, meta?.ts, isCommand ? null : this.state.currentTurn);
    if (!isCommand) box.dataset.turn = String(this.state.currentTurn);
    append(this, box);
  },

  // A queued message was cancelled and dropped before it ran — remove its
  // optimistic pending box (same two-level match as agent:query above).
  "agent:queued-done"(p) {
    if (!p?.dropped) return;
    const queryText = p?.query ?? "";
    if (!queryText) return;
    const pendRoot = (this.state.replaying && this._replayFrag) || this.streamEl;
    let matched = pendRoot?.querySelector(`.agent-box.pending[data-queued="${CSS.escape(queryText)}"]`) ?? null;
    if (!matched) {
      for (const pb of pendRoot?.querySelectorAll(".agent-box.pending") ?? []) {
        if (pb._queryText === queryText) { matched = pb; break; }
      }
    }
    if (matched) matched.remove();
  },

  "agent:processing-start"() {
    this.state.lastUsage = null;
    hideUsage(this);
    setBusy(this, true);
    if (!this.state.replaying) setSessionStatus(this.id, "session-streaming");
    if (!this.state.replaying) document.dispatchEvent(new CustomEvent("sse:processing-change"));
    hideThinking(this);
    sweepOrphanThinking(this);
    finalizeThinking(this);
    finalizeLiveOutput(this);
    resetCompletedTools(this);
    startNewSegment(this);
    this._subagent = null;
    // Sa maps are NOT cleared at turn boundaries: async subagents outlive the
    // turn and still need them for block attribution. Entries self-clean on
    // launch tool-completed (callId map) and subagent:done (saId map).
    // _subagentBlock survives — async subagents need it to find their block on completion.
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
    settleTodoBlock(this);
    if (this.usageStripEl) this.usageStripEl.hidden = false;
    setBusy(this, false);
    if (!this.state.replaying) setSessionStatus(this.id, "");
    document.dispatchEvent(new CustomEvent("sse:processing-change"));
    this._subagent = null;
    if (!this.state.replaying && this.streamEl) compactReasoning(this.streamEl);
    this.scheduleReplayFlush();
    if (!this.state.replaying && this === activeSession.peek()) {
      refreshTreeIfOpen();
      const p = this.agentInfo?.provider;
      if (p && BALANCE_PROVIDERS.has(p)) refreshProviderBalance(p);
    }
    if (!this.state.replaying) refreshGitBranch(this);
    if (!this.state.replaying) {
      sendSystemNotification(t("notify.done.title"), sessionLabel(this));
    }
  },

  "agent:cancelled"() {
    cancelReply(this);
    hideThinking(this);
    finalizeThinking(this);
    finalizeLiveOutput(this);
    setBusy(this, false);
    settleTodoBlock(this);
    if (!this.state.replaying) setSessionStatus(this.id, "");
    if (!this.state.replaying) document.dispatchEvent(new CustomEvent("sse:processing-change"));
    this._subagent = null;
    if (!this.state.replaying && this.streamEl) compactReasoning(this.streamEl);
    this.scheduleReplayFlush();
  },

  "agent:error"(p) {
    closeReply(this);
    hideThinking(this);
    finalizeThinking(this);
    finalizeLiveOutput(this);
    settleTodoBlock(this);
    const raw = String(p?.message ?? "");
    const kind = classifyError(raw);
    // Friendly headline for known categories; the original message is
    // kept in the collapsible details alongside any stack/detail.
    const headline = kind ? t(`error.${kind}`) : raw;
    const detail = kind
      ? [raw, p?.detail ?? p?.stack].filter((x) => String(x ?? "").trim()).join("\n\n")
      : (p?.detail ?? p?.stack);
    const card = renderErrorCard(headline, detail);
    // Action row: open settings for auth errors; retry the query that
    // produced this error (captured now, so replayed cards retry their
    // own turn's query, not the latest one).
    const actions = [];
    if (kind === "auth") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "err-card-toggle";
      btn.textContent = t("error.open.settings");
      btn.addEventListener("click", openConfigPanel);
      actions.push(btn);
    }
    const lastQuery = this.state.lastQuery;
    if (lastQuery) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "err-card-toggle";
      btn.textContent = t("error.retry");
      btn.addEventListener("click", () => retryLastQuery(lastQuery));
      actions.push(btn);
    }
    if (actions.length) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; gap:0.5rem; padding:0.5rem 0.85rem; border-top:1px solid rgba(199,106,100,0.15);";
      for (const b of actions) row.appendChild(b);
      card.appendChild(row);
    }
    append(this, card);
    setBusy(this, false);
    if (!this.state.replaying) setSessionStatus(this.id, "");
    if (!this.state.replaying) document.dispatchEvent(new CustomEvent("sse:processing-change"));
    this._subagent = null;
    if (!this.state.replaying && this.streamEl) compactReasoning(this.streamEl);
    this.scheduleReplayFlush();
  },

  "agent:usage"(p) { this.state.lastUsage = p; renderUsage(this); },

  // todolist tool: each call carries the full list. First event creates
  // the card (replay-safe via insertStreamNode), later ones update it in
  // place — replayed sequences therefore settle on the latest state.
  "agent:todo"(p) {
    const todos = Array.isArray(p?.todos) ? p.todos : [];
    createTodoBlock(this);
    updateTodoBlock(this, todos);
  },

  // Contract C1: subagent token usage arrives on its own event.  Deliberately
  // NOT folded into state.lastUsage — that's the main-turn metric rendered by
  // agent:usage (replay path unaffected).  Dropped for now; no per-block
  // usage UI yet.
  "subagent:usage"() {},

  "shell:command-start"(p) { startShellBlock(this, p ?? {}); },
  "shell:command-done"(p) { finishShellBlock(this, p ?? {}); },
  "shell:queued"(p) { queueShellBlock(this, p ?? {}); },

  "session:title"(p) {
    updateSessionTitle(this.id, p?.title ?? "");
    document.dispatchEvent(new CustomEvent("sse:title"));
  },

  "hub:branch-switched"() {
    // During replay, this is the first synthetic frame and NOT a real
    // branch switch.  Only reset when this fires in a live session.
    if (!this.state.replaying) {
      this.resetForBranchSwitch?.();
      // Contract A: rebuildReplay pushes the synthetic branch frames
      // directly to live SSE clients, terminated by a hub:replay-done
      // frame.  Enter replay mode so they take the batched fragment path
      // instead of being handled as live frames (each synthetic
      // processing-done would otherwise fire a system notification,
      // balance/git fetches, busy flips and a full compactReasoning scan).
      this.enterReplayMode?.();
      clearSaMaps(this);
      this._swarms?.clear();
      this._pendingSwarmCalls?.clear();
    }
    // Contract H: panels holding index-based state (context panel)
    // re-fetch on this event — stale indices would drop wrong messages.
    // Only the active session's switch affects what those panels show; a
    // background session must not clobber the user's current selection.
    if (this === activeSession.peek()) {
      document.dispatchEvent(new CustomEvent("ash:branch-switched"));
      refreshTreeIfOpen();
    }
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
    // todolist / agentswarm tools — suppress the tool-row.  The TODO card /
    // swarm block (driven by their own events) are the visuals instead.
    // IMPORTANT: close the open reply bubble first, or the post-tool summary
    // text keeps appending to a bubble that now sits ABOVE the new block.
    if (p?.name === TODO_TOOL_NAME || p?.name === SWARM_TOOL_NAME) {
      closeReply(this);
      closeToolGroup(this);
      finalizeThinking(this);
      startNewSegment(this);
      // Remember the swarm launch call id so tool-completed can render the
      // aggregated output into the swarm block (covers branch rebuilds,
      // where no swarm/subagent frames exist).
      if (p?.name === SWARM_TOOL_NAME && p?.toolCallId) {
        (this._pendingSwarmCalls ??= new Set()).add(p.toolCallId);
      }
      return;
    }
    // Subagent tool — intercept BEFORE creating a tool-row.
    const isSa = !!(p?.name && p.name in SUBAGENT_TOOL_NAMES);    if (isSa) {
      closeReply(this);
      closeToolGroup(this);
      const type = SUBAGENT_TOOL_NAMES[p.name];
      const taskText = (typeof p?.rawInput === "object" ? p.rawInput?.task : null) ?? p.name;
      const block = createSubagentBlock(this, type, taskText);
      // Remember the launch call id so agent:tool-completed can tell the
      // subagent tool's own completion apart from nested/parallel tools.
      block.dataset.callId = p?.toolCallId ?? "";
      insertStreamNode(this, block);
      this._subagent = block;
      this._subagentBlock = block;
      saMaps(this);
      if (p?.toolCallId) this._saBlocksByCallId.set(p.toolCallId, block);
      return; // Don't create a tool-row.
    }

    closeReply(this);
    finalizeThinking(this);
    finalizeLiveOutput(this);
    startNewSegment(this);
    const row = buildToolRow(p);
    // Nested subagent tool (`${subagentId}-tool-${n}`): route the row into
    // its owning block's body — parallel launches each get their own rows.
    // _subagent stays the fallback for id-less frames.
    const saBlock = this._saBlocksBySaId?.get(saIdFromToolId(p?.toolCallId));
    const nest = saBlock || this._subagent;
    if (nest) {
      const body = nest.querySelector(".subagent-body");
      // Keep the body collapsed — subagents can run dozens of tools, and
      // expanding them inline floods the stream.  Show a live counter in
      // the head instead; the user can click the head to expand.
      if (body) {
        body.appendChild(row);
        nest._toolCount = (nest._toolCount ?? 0) + 1;
        const counter = nest.querySelector(".subagent-tools-count");
        if (counter) counter.textContent = t("subagent.tools", { n: nest._toolCount });
      }
    } else {
      appendToGroup(this, row);
      bumpToolCount(this);
    }
    trackToolRow(this, row);
  },

  "agent:tool-completed"(p) {
    const id = p?.toolCallId ?? "";
    // A suppressed agentswarm launch completing: render the aggregated
    // rawOutput into the linked swarm block's result area.  This is also
    // the only place swarm results survive a branch rebuild, whose
    // synthesized replay contains no swarm/subagent frames at all.
    if (id) {
      const root = (this.state.replaying && this._replayFrag) || this.streamEl;
      const swarmBlock = [...(root?.querySelectorAll(".subagent-swarm") ?? [])]
        .find((b) => b._swarmCallId === id);
      if (swarmBlock) {
        const result = swarmBlock.querySelector(".subagent-result");
        const text = typeof p?.rawOutput === "string" ? p.rawOutput : "";
        if (result && text.trim()) {
          result.hidden = false;
          const rendered = renderToolBody(text.split("\n"));
          if (rendered) result.appendChild(rendered);
        }
        this._pendingSwarmCalls?.delete(id);
        return;
      }
      // Branch-rebuild / truncated-replay fallback: no swarm block exists
      // (synthesized replays carry no swarm frames), but this completion
      // belongs to a suppressed agentswarm call — render the aggregation
      // as a standalone result block instead of dropping it entirely.
      if (this._pendingSwarmCalls?.has(id)) {
        this._pendingSwarmCalls.delete(id);
        const text = typeof p?.rawOutput === "string" ? p.rawOutput : "";
        if (text.trim()) {
          const block = document.createElement("div");
          block.className = "subagent-block subagent-swarm";
          block.innerHTML =
            `<div class="subagent-head subagent-done">` +
              `<span class="subagent-icon">⚡</span>` +
              `<span class="subagent-label">${escape(t("swarm.title"))}</span>` +
            `</div>` +
            `<div class="subagent-result"></div>`;
          const rendered = renderToolBody(text.split("\n"));
          if (rendered) block.querySelector(".subagent-result")?.appendChild(rendered);
          insertStreamNode(this, block);
        }
        return;
      }
    }
    // The subagent tool's own completion: the id matches the launch call id
    // recorded on the block.  Append the result, then release the nesting
    // slot — later main-agent tools/thinking must render outside the
    // finished block.  The launch map keeps this parallel-safe; the
    // single-slot pointers are the fallback for frames handled before the
    // maps existed.
    const launchBlock = id
      ? (this._saBlocksByCallId?.get(id)
        ?? (this._subagent?.dataset.callId === id ? this._subagent : null)
        ?? (this._subagentBlock?.dataset.callId === id ? this._subagentBlock : null))
      : null;
    if (launchBlock) {
      const result = launchBlock.querySelector(".subagent-result");
      if (result && p?.resultDisplay?.body) {
        result.hidden = false;
        const body = p.resultDisplay.body;
        if (body.kind === "lines" && Array.isArray(body.lines) && body.lines.length) {
          const block = renderToolBody(body.lines);
          if (block) result.appendChild(block);
        }
      }
      if (this._subagent === launchBlock) this._subagent = null;
      this._saBlocksByCallId?.delete(id);
      return;
    }
    // Find the tool row.  Nested subagent tools search their owning block
    // so the completion mark lands on the right row under parallel
    // launches; everything else searches the whole stream root (replay
    // fragment or streamEl): the subagent block lives inside it, so nested
    // rows match too, and a main-agent tool completing in a parallel batch
    // is found instead of leaking into the subagent result area.
    const saBlock = this._saBlocksBySaId?.get(saIdFromToolId(id));
    const root = saBlock || ((this.state.replaying && this._replayFrag) || this.streamEl);
    const row = id ? root?.querySelector(`.tool-row[data-call-id="${CSS.escape(id)}"]`) : null;
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
    closeReply(this);
    if (!this.streamEl) return;

    const requestId = p?.requestId || "";
    const title = p?.title || "File operation";
    const kind = p?.kind || "unknown";
    const filePath = p?.metadata?.filePath || "";
    const description = p?.description || "";
    const diff = p?.metadata?.diff || "";

    const card = document.createElement("div");
    card.className = "permission-card";
    card.dataset.requestId = requestId;
    card.dataset.sessionId = this.id ?? "";
    card.setAttribute("role", "alertdialog");
    card.setAttribute("aria-live", "assertive");

    // Shield icon SVG
    const shieldIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s7 4 7 10v5.5a1 1 0 0 1-.6.9l-6.4 3-6.4-3a1 1 0 0 1-.6-.9V12c0-6 7-10 7-10z"/><line x1="12" y1="8" x2="12" y2="13"/><circle cx="12" cy="15.5" r="0.8" fill="currentColor" stroke="none"/></svg>`;

    card.innerHTML =
      `<div class="permission-left-bar"></div>` +
      `<div class="permission-main">` +
        `<div class="permission-head">` +
          `<span class="permission-icon">${shieldIcon}</span>` +
          `<span class="permission-label">${escape(title)}</span>` +
          `<span class="permission-kind-badge">${escape(kind)}</span>` +
        `</div>` +
        (filePath || description ? `<div class="permission-body">` +
          (filePath ? `<div class="permission-path">${escape(filePath)}</div>` : "") +
          (description ? `<div class="permission-desc">${escape(description)}</div>` : "") +
        `</div>` : "") +
        `<div class="permission-actions">` +
          `<div class="permission-actions-left">` +
            `<button class="permission-btn deny">` +
              `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="7" y1="7" x2="17" y2="17"/><line x1="17" y1="7" x2="7" y2="17"/></svg>` +
              `<span>${escape(t("permission.deny"))}</span>` +
            `</button>` +
          `</div>` +
          `<div class="permission-actions-right">` +
            `<span class="permission-countdown"><svg width="18" height="18" viewBox="0 0 24 24" class="perm-ring"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.15"/><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="62.83" stroke-dashoffset="0" class="perm-ring-fill"/></svg><span class="perm-count-text">30</span></span>` +
            `<span class="permission-timeout-note">${escape(t("permission.timeout_note"))}</span>` +
            `<button class="permission-btn approve-all" title="${escape(t("permission.approve_all_hint"))}">` +
              `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 13 10 18 19 6"/><polyline points="5 13 10 18 19 6" opacity="0.4" transform="translate(-3,-2)"/></svg>` +
              `<span>${escape(t("permission.approve_all"))}</span>` +
            `</button>` +
            `<button class="permission-btn approve">` +
              `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 13 10 18 19 6"/></svg>` +
              `<span>${escape(t("permission.approve"))}</span>` +
            `</button>` +
          `</div>` +
        `</div>` +
      `</div>`;

    // Diff preview appended after main (collapsed with fade + expand toggle)
    let diffWrap = null;
    let diffPreview = null;
    let diffToggle = null;
    if (diff) {
      const preview = renderDiffBlock(diff, filePath || title);
      preview.classList.add("permission-diff");
      diffPreview = preview;
      diffWrap = document.createElement("div");
      diffWrap.className = "permission-diff-wrap";
      diffWrap.appendChild(preview);
      diffToggle = document.createElement("button");
      diffToggle.type = "button";
      diffToggle.className = "permission-diff-toggle";
      diffToggle.textContent = t("permission.expand_diff");
      diffToggle.addEventListener("click", () => {
        const expanded = diffWrap.classList.toggle("expanded");
        diffToggle.textContent = expanded ? t("permission.collapse_diff") : t("permission.expand_diff");
      });
      diffWrap.appendChild(diffToggle);
      card.querySelector(".permission-main")?.appendChild(diffWrap);
    }

    // Replayed requests are history, not actionable: render the card as
    // already handled — no countdown, no decide listeners.  A live 30s
    // timer here would wrongly auto-deny an old request (and a click
    // would send a stale decide that can wake a sleeping bridge).
    if (this.state.replaying) {
      card.classList.add("decided");
      card.querySelectorAll(".permission-btn").forEach((b) => b.disabled = true);
      card.querySelector(".permission-countdown")?.remove();
      card.querySelector(".permission-timeout-note")?.remove();
      const status = document.createElement("span");
      status.className = "permission-status";
      status.textContent = t("permission.handled");
      card.querySelector(".permission-actions-right")?.appendChild(status);
      insertStreamNode(this, card);
      // Fragment has no layout — measure the diff clip in onReplayDone.
      if (diffWrap) card._needsClipMeasure = true;
      return;
    }

    // Approve All is session-wide: require a two-step confirm (~3s arm window)
    const approveAllBtn = card.querySelector(".approve-all");
    let confirmTimer = null;
    const disarmApproveAll = () => {
      if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
      if (approveAllBtn) {
        approveAllBtn.classList.remove("confirming");
        const label = approveAllBtn.querySelector("span");
        if (label) label.textContent = t("permission.approve_all");
      }
    };
    card._disarm = disarmApproveAll;

    // Countdown
    const ringCircle = card.querySelector(".perm-ring-fill");
    const countText = card.querySelector(".perm-count-text");
    let remaining = 30;
    const tick = () => {
      remaining--;
      if (countText) countText.textContent = String(remaining);
      if (ringCircle) {
        const offset = 62.83 * (1 - remaining / 30);
        ringCircle.setAttribute("stroke-dashoffset", String(offset));
      }
      if (remaining <= 5) {
        card.classList.add("countdown-urgent");
        if (ringCircle) ringCircle.setAttribute("stroke", "#ef4444");
      }
      if (remaining <= 0) {
        clearInterval(timer);
        disarmApproveAll();
        // Keep the card as a greyed terminal state (audit trail) instead of removing it
        card.classList.add("decided", "timeout");
        card.querySelectorAll(".permission-btn").forEach((b) => b.disabled = true);
        card.querySelector(".permission-countdown")?.remove();
        card.querySelector(".permission-timeout-note")?.remove();
        const status = document.createElement("span");
        status.className = "permission-status";
        status.textContent = t("permission.timed_out");
        card.querySelector(".permission-actions-right")?.appendChild(status);
      }
    };
    const timer = setInterval(tick, 1000);
    card._timer = timer;

    const decide = (outcome, sessionWide) => {
      if (!card.isConnected) return; // expired
      clearInterval(timer);
      disarmApproveAll();
      card.classList.add("decided");
      card.classList.add(outcome === "approved" ? "allowed" : "blocked");
      card.querySelectorAll(".permission-btn").forEach(b => b.disabled = true);
      // Same terminal-state cleanup as the timeout/cleanup paths.
      card.querySelector(".permission-countdown")?.remove();
      card.querySelector(".permission-timeout-note")?.remove();
      fetch("/api/permission/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, outcome, sessionId: this.id, sessionWide }),
      }).catch(() => {});
    };

    card.querySelector(".deny")?.addEventListener("click", () => decide("denied", false));
    card.querySelector(".approve")?.addEventListener("click", () => decide("approved", false));
    approveAllBtn?.addEventListener("click", () => {
      if (approveAllBtn.classList.contains("confirming")) {
        decide("approved", true);
        return;
      }
      approveAllBtn.classList.add("confirming");
      const label = approveAllBtn.querySelector("span");
      if (label) label.textContent = t("permission.approve_all_confirm");
      confirmTimer = setTimeout(disarmApproveAll, 3000);
    });

    insertStreamNode(this, card);
    // Live requests only — replayed frames are history, not actionable.
    if (!this.state.replaying) {
      const label = sessionLabel(this);
      const detail = description || title;
      sendSystemNotification(
        t("notify.permission.title"),
        [label, detail].filter(Boolean).join(" — ")
      );
    }
    // Only offer expand when the diff is actually clipped.  Measure after
    // layout (rAF): replay frames are deferred to onReplayDone since the
    // fragment has no layout; a 0 height means no layout yet (hidden
    // view) — flagged for re-measure on visibilitychange / onReplayDone.
    if (diffPreview && diffWrap) {
      card._needsClipMeasure = true;
      requestAnimationFrame(() => measureDiffClip(card));
    }
  },

  "permission:request-cleanup"() {
    // Mark stale permission cards as handled (when tool finishes); keep them as audit trail
    if (this.streamEl) {
      for (const card of this.streamEl.querySelectorAll(".permission-card")) {
        if (card.classList.contains("decided")) continue;
        clearInterval(card._timer);
        card._disarm?.();
        card.classList.add("decided", "timeout");
        card.querySelectorAll(".permission-btn").forEach((b) => b.disabled = true);
        card.querySelector(".permission-countdown")?.remove();
        card.querySelector(".permission-timeout-note")?.remove();
        const right = card.querySelector(".permission-actions-right");
        if (right && !right.querySelector(".permission-status")) {
          const status = document.createElement("span");
          status.className = "permission-status";
          status.textContent = t("permission.handled");
          right.appendChild(status);
        }
      }
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

  "subagent:started"(p) {
    // Sync launches: block already created by the agent:tool-started
    // interception — link the earliest un-linked block to this subagentId
    // (launches and starts arrive in the same order) so nested tool events
    // can find their block.
    const saId = p?.subagentId;
    if (!saId) return;
    saMaps(this);
    for (const block of this._saBlocksByCallId.values()) {
      if (block._saId) continue;
      block._saId = saId;
      this._saBlocksBySaId.set(saId, block);
      break;
    }
    if (this._saBlocksBySaId.has(saId)) return;
    // Swarm / async launches have no launch tool call, hence no block —
    // create one from the event itself, or this subagent's inner tools
    // would spill into the main stream as a flat tool-group.
    const block = createSubagentBlock(this, p?.type ?? "explore", p?.task ?? "");
    block._saId = saId;
    this._saBlocksBySaId.set(saId, block);
    this._subagent = block;
    // Nest into the owning swarm's body — only when the payload names a
    // swarm (backend tags every swarm item).  Non-swarm async launches go
    // to the stream directly; a latest-swarm fallback would mis-nest them.
    const swarmBlock = p?.swarmId ? this._swarms?.get(p.swarmId) : null;
    const swarmBody = swarmBlock?.querySelector(".subagent-body");
    if (swarmBody) {
      swarmBody.hidden = false;
      swarmBody.appendChild(block);
    } else {
      insertStreamNode(this, block);
    }
  },

  "subagent:done"(p) {
    // Parallel-safe lookup: prefer the block linked to this subagentId so
    // one subagent's done can't mark another's block complete; the
    // single-slot pointers remain the fallback for no-id frames.
    const saId = p?.subagentId ?? "";
    const block = (saId && this._saBlocksBySaId?.get(saId)) || this._subagent || this._subagentBlock;
    if (!block) return;
    const head = block.querySelector(".subagent-head");
    const spinner = head?.querySelector(".subagent-spinner");
    if (spinner) spinner.remove();
    const icon = head?.querySelector(".subagent-icon");
    const err = typeof p?.error === "string" && p.error ? p.error : null;
    if (icon) {
      icon.textContent = err ? "✗" : "✓";
      if (err) icon.style.color = "var(--error)";
    }
    head?.classList.add("subagent-done");
    // Id badge for resume reference (e.g. #sa1).  Falls back to the id the
    // block was linked with when the done frame carries none.
    const badgeId = saId || block._saId || "";
    if (badgeId && head && !head.querySelector(".subagent-id")) {
      const badge = document.createElement("span");
      badge.className = "subagent-id";
      badge.textContent = `#${badgeId}`;
      head.appendChild(badge);
    }
    if (err) {
      const result = block.querySelector(".subagent-result");
      if (result) {
        const el = document.createElement("div");
        el.style.color = "var(--error)";
        el.textContent = `${t("subagent.failed")}: ${err.slice(0, 200)}`;
        result.appendChild(el);
      }
    }
    // Auto-expand the result area (not the tool body — that stays collapsed
    // behind the counter) only if the user hasn't toggled manually.
    if (!block.dataset.userToggled) {
      const result = block.querySelector(".subagent-result");
      if (result && result.children.length > 0) result.hidden = false;
    }
    // _subagentBlock survives for the async path where _subagent gets nulled.
    // Release only the saId link and the _subagent slot so later main-agent
    // tools don't nest into this finished block. The _saBlocksByCallId entry
    // and _subagentBlock must survive: on the sync path the launch's
    // agent:tool-completed arrives AFTER done and needs them to append the
    // result (it self-cleans the callId entry when it finalizes the block).
    if (saId) this._saBlocksBySaId?.delete(saId);
    if (this._subagent === block) this._subagent = null;
  },

  // Swarm progress block: one card per AgentSwarm launch, updated in place
  // by progress/done frames (replay receives them in order, so the block
  // settles on its terminal state).
  "subagent:swarm-started"(p) {
    const swarmId = p?.swarmId;
    if (!swarmId) return;
    const block = document.createElement("div");
    block.className = "subagent-block subagent-swarm";
    block._swarmTotal = Number(p?.total ?? 0);
    block.innerHTML =
      `<div class="subagent-head">` +
        `<span class="subagent-icon">⚡</span>` +
        `<span class="subagent-label">${escape(t("swarm.title"))}</span>` +
        `<span class="swarm-count">0/${block._swarmTotal}</span>` +
        `<span class="swarm-status"></span>` +
        `<span class="subagent-spinner"></span>` +
      `</div>` +
      `<div class="subagent-body" hidden></div>` +
      `<div class="subagent-result" hidden></div>`;
    // Link the suppressed agentswarm tool call so its tool-completed can
    // render the aggregated output into this block's result area.  FIFO:
    // tool-started and swarm-started fire in the same order, so the oldest
    // pending call belongs to this swarm.
    if (this._pendingSwarmCalls?.size) {
      block._swarmCallId = this._pendingSwarmCalls.values().next().value;
      this._pendingSwarmCalls.delete(block._swarmCallId);
    }
    // Per-item subagent blocks are nested into the body by subagent:started —
    // click toggles the whole swarm open/closed.
    block.querySelector(".subagent-head")?.addEventListener("click", () => {
      block.dataset.userToggled = "1";
      const body = block.querySelector(".subagent-body");
      if (body && body.children.length > 0) body.hidden = !body.hidden;
    });
    insertStreamNode(this, block);
    swarms(this).set(swarmId, block);
  },

  "subagent:swarm-progress"(p) {
    const block = p?.swarmId && this._swarms?.get(p.swarmId);
    if (!block) return;
    updateSwarmCount(block, p);
  },

  "subagent:swarm-done"(p) {
    const swarmId = p?.swarmId;
    const block = swarmId && this._swarms?.get(swarmId);
    if (!block) return;
    updateSwarmCount(block, p);
    const head = block.querySelector(".subagent-head");
    head?.classList.add("subagent-done");
    head?.querySelector(".subagent-spinner")?.remove();
    const failed = Number(p?.failed ?? 0);
    const status = head?.querySelector(".swarm-status");
    if (status) {
      status.textContent = failed > 0 ? t("swarm.failed", { n: failed }) : t("swarm.done");
      if (failed > 0) status.classList.add("swarm-failed");
    }
    // Collapse the per-item body on completion (unless the user toggled it).
    if (!block.dataset.userToggled) {
      const body = block.querySelector(".subagent-body");
      if (body) body.hidden = true;
    }
    // Terminal: release the map entry; the DOM block stays in the stream.
    this._swarms.delete(swarmId);
  },

  // Keepalive sent by server before _ensureBridge to prevent the 500ms
  // safety timer from firing during lazy session restore.
  // Resets the safety timer directly; receiveFrame skips scheduleReplayFlush
  // for this event to avoid the 12ms debounce (since _ensureBridge may take
  // 200ms+ before real replay frames arrive).
  "hub:replay-starting"() {
    if (!this.state.replaying) return;
    if (this.replayFlushTimer) clearTimeout(this.replayFlushTimer);
    this.replayFlushTimer = setTimeout(() => this.exitReplayMode(), 500);
  },
};

// Heavy work deferred until replay batch completes — invoked by
// SessionView.exitReplayMode().
export const onReplayDone = (session) => {
  if (!session?.streamEl) return;
  sweepOrphanThinking(session);
  // Diff previews rendered during replay lived in a DocumentFragment with
  // no layout — measure their clipped state now that they're mounted.
  for (const card of session.streamEl.querySelectorAll(".permission-card")) measureDiffClip(card);
  // compactReasoning is already done on the fragment before appending
  // (see SessionView.exitReplayMode).  Schedule the heavy async work.
  highlightWithin(session.streamEl, { async: true });
  renderMathIn(session.streamEl, { async: true });
  forceScrollBottom(session);
  refreshGitBranch(session);
  refreshModelChip(session);
  refreshCwdChip(session);
  syncAllBalanceChips();
  // Sync vision indicator on cached session switches.
  const btn = document.getElementById("vision-indicator");
  if (btn) btn.hidden = !session.agentInfo?.modalities?.includes("image");
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
  const modelText = [modelLabel, showThink ? `[${ai.thinkingLevel}]` : ""].filter(Boolean).join(" ");

  // Combined model + balance
  const balanceText = session.modelEl?._balanceLabel ?? "";
  const text = [modelText, balanceText].filter(Boolean).join(" · ");
  if (text) { session.modelEl.textContent = text; session.modelEl.hidden = false; }
  else { session.modelEl.hidden = true; }

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

// Exposed for config panel to invalidate after provider changes.
export const invalidateModelCache = () => { _allModelsCache = null; };
export const setModelCache = (data) => { _allModelsCache = data; };

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

  // Fetch all models if not cached, or if cache seems stale (OpenRouter
  // only has 1 model — its async catalog fetch likely completed since
  // the last time we cached).
  const needsRefresh = !_allModelsCache || (
    _allModelsCache.providers?.some((p) => p.name === "openrouter" && (p.models?.length || 0) <= 1)
  );
  if (needsRefresh) {
    try {
      const r = await fetch("/api/models");
      _allModelsCache = await r.json();
    } catch {
      if (!_allModelsCache) return;
    }
  }

  const providers = _allModelsCache.providers || [];
  if (!providers.length) return;

  const currentModel = session.agentInfo?.model;
  const currentProvider = session.agentInfo?.provider;

  // Build dropdown HTML with search and provider groups
  dropdown.innerHTML =
    `<div class="model-dropdown-search">` +
      `<div class="model-search-wrap">` +
        `<svg class="model-search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="6" cy="6" r="4.5"/><line x1="9.5" y1="9.5" x2="13" y2="13"/></svg>` +
        `<input type="text" class="model-search-input" placeholder="${t("search.models") || "Search models…"}" autocomplete="off">` +
      `</div>` +
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
  // Clear modalities until agent:info confirms the new model's capabilities.
  session.agentInfo.modalities = undefined;
  refreshModelChip(session);
  // Update vision indicator immediately while waiting for backend.
  const btn = document.getElementById("vision-indicator");
  if (btn) btn.hidden = true;
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
  if (wrap?.dataset.uiUsageCwdShow !== "true") { session._cwdText = ""; refreshLocationChip(session); return; }
  const cwd = session.state?.cwd ?? "";
  if (!cwd) { session._cwdText = ""; refreshLocationChip(session); return; }
  if (session._cwdPath === cwd) return;
  const base = cwd.split("/").filter(Boolean).pop() ?? cwd;
  session._cwdText = base;
  session._cwdPath = cwd;
  refreshLocationChip(session);
};

const refreshGitBranch = async (session) => {
  if (!session?.branchEl || !session.id) return;
  const wrap = session.branchEl.closest(".terminal-wrap");
  if (wrap?.dataset.uiUsageGitBranch === "false") { session._branchText = ""; refreshLocationChip(session); return; }
  try {
    const r = await fetch(`/${session.id}/git-branch`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { branch } = await r.json();
    session._branchText = branch || "";
  } catch { session._branchText = ""; }
  refreshLocationChip(session);
};

const refreshLocationChip = (session) => {
  if (!session?.cwdEl) return;
  const text = [session._cwdText, session._branchText].filter(Boolean).join(" · ");
  if (text) {
    session.cwdEl.textContent = text;
    session.cwdEl.title = session._cwdPath ?? "";
    session.cwdEl.hidden = false;
  } else {
    session.cwdEl.hidden = true;
  }
};

// Fetch balance for all supported providers on startup.
for (const p of BALANCE_PROVIDERS) fetchProviderBalance(p);

// Global usage strip toggle on the input row.
document.getElementById("usage-strip-toggle")?.addEventListener("click", () => {
  const s = activeSession.peek();
  if (!s?.usageStripEl) return;
  s.usageStripEl.classList.toggle("collapsed");
  const btn = document.getElementById("usage-strip-toggle");
  if (btn) btn.classList.toggle("collapsed", s.usageStripEl.classList.contains("collapsed"));
});
