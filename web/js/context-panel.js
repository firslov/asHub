import { escape } from "./utils.js";
import { currentSessionId } from "./state.js";
import { activeSession } from "./session-manager.js";
import { effect } from "../vendor/signals-core.js";
import { t } from "./i18n.js";
import { toast } from "./toast.js";

const app = document.querySelector(".app");
const ctxPanel = document.getElementById("ctx-panel");
const ctxToggle = document.getElementById("ctx-toggle");
const ctxClose = document.getElementById("ctx-close");
const ctxRefresh = document.getElementById("ctx-refresh");
const ctxBody = document.getElementById("ctx-body");
const ctxMeta = document.getElementById("ctx-meta");
const ctxDrop = document.getElementById("ctx-drop");
const ctxFilters = document.getElementById("ctx-filters");

// Set initial text (JS manages this dynamically, so no data-i18n in HTML)
if (ctxDrop) ctxDrop.textContent = t("drop");

const LS_CTX = "ash.ctx-open";

// Pair each assistant tool_call with its tool result so they drop as a unit.
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
      groupOf[i] = g++;
    } else {
      groupOf[i] = g++;
    }
  }
  return groupOf;
};

// Token estimate is O(JSON.stringify(msg)) — expensive for long messages and
// recomputed on every selection change.  Cache per message object reference
// (a WeakMap lets old messages GC once the panel refetches a fresh array).
const _tokCache = new WeakMap();
const tokensOf = (m) => {
  if (m == null) return 0;
  let v = _tokCache.get(m);
  if (v === undefined) {
    v = Math.ceil(JSON.stringify(m).length / 4);
    _tokCache.set(m, v);
  }
  return v;
};
const fmtTok = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

// DOM 注入截断阈值：完整文本常驻 currentMsgs 内存，DOM 只放前 N 字符的
// 预览，避免长会话里 MB 级文本节点造成的布局阻塞与内存占用。
const CTX_TEXT_MAX = 2048;

const stripContextWrappers = (s) => {
  let out = String(s ?? "");
  for (;;) {
    const next = out.replace(/^\s*<(query_context|dynamic_context)>[\s\S]*?<\/\1>\s*/, "");
    if (next === out) return out;
    out = next;
  }
};

const messageText = (m) => {
  const raw = (() => {
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
        return `→ ${fn.name ?? t("tool")}(\n${args}\n)`;
      }).join("\n\n");
    }
    if (m?.role === "tool") return String(m.content ?? "");
    return JSON.stringify(m ?? {});
  })();
  return m?.role === "user" ? stripContextWrappers(raw) : raw;
};

const ctx = () => activeSession.peek()?.context;
const selectedSet = () => ctx()?.selected ?? new Set();
const activeRolesSet = () => ctx()?.activeRoles ?? new Set(["all"]);
const currentMsgsArr = () => ctx()?.currentMsgs ?? [];
const currentGroupsArr = () => ctx()?.currentGroups ?? [];

const updateDropButton = () => {
  const selected = selectedSet();
  ctxDrop.disabled = selected.size === 0;
  if (selected.size > 0) {
    let tok = 0;
    const msgs = currentMsgsArr();
    for (const i of selected) tok += tokensOf(msgs[i]);
    ctxDrop.textContent = `${t("ctx.drop.n", { n: selected.size })} · ~${fmtTok(tok)}`;
  } else {
    ctxDrop.textContent = t("drop");
  }
};

const setGroupSelected = (group, on) => {
  const selected = selectedSet();
  const groups = currentGroupsArr();
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] !== group) continue;
    if (on) selected.add(i); else selected.delete(i);
    const row = ctxBody.querySelector(`[data-idx="${i}"]`);
    const cb = row?.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = on;
    row?.classList.toggle("selected", on);
  }
  updateDropButton();
};

// Hide the expand chevron on rows whose text already fits the two-line clamp.
// Two-phase on purpose: every layout read happens before any write, so N rows
// cost one reflow instead of N interleaved ones.
//
// Rows without layout are skipped.  A row the role filter has hidden reports
// scrollHeight and clientHeight as 0, which reads as "fits in two lines" — the
// chevron would be hidden permanently while the text stays clamped to 3em
// (css/panels/context.css), leaving the content unreadable once the filter
// shows the row again.  A truncated preview always overflows the clamp, and an
// expanded row must keep its collapse button.
const measureChevrons = (rows) => {
  requestAnimationFrame(() => {
    const targets = rows
      .map((el) => [
        el.querySelector(".ctx-text-inner"),
        el.querySelector(".ctx-chevron"),
        el.querySelector(".ctx-text"),
      ])
      .filter(([tn, chev, body]) =>
        !!tn && !!chev && !!body &&
        !chev.hidden &&
        !body.classList.contains("expanded") &&
        !tn.querySelector(".ctx-ellipsis") &&
        tn.offsetParent !== null);
    const fit = targets.map(([tn]) => tn.scrollHeight <= tn.clientHeight + 4);
    targets.forEach(([, chev], i) => { if (fit[i]) chev.hidden = true; });
  });
};

const applyCtxFilter = () => {
  const roles = activeRolesSet();
  const all = roles.has("all");
  const revealed = [];
  ctxBody.querySelectorAll(".ctx-msg").forEach((el) => {
    const role = el.dataset.role ?? "";
    const hide = !all && !roles.has(role);
    // A row coming back had no layout while hidden, so render-time
    // measurement skipped it — measure just the ones revealed here.
    if (!hide && el.hidden) revealed.push(el);
    el.hidden = hide;
  });
  if (revealed.length) measureChevrons(revealed);
};

let ctxFetchSeq = 0;
let ctxFetchAbort = null;

const renderContext = async () => {
  const c = ctx();
  if (c) c.selected.clear();
  const sid = currentSessionId();
  if (!sid) { ctxBody.innerHTML = `<div class="p-empty">${t("ctx.no.session")}</div>`; updateDropButton(); return; }
  ctxFetchAbort?.abort();
  const ac = new AbortController();
  ctxFetchAbort = ac;
  const mySeq = ++ctxFetchSeq;
  ctxBody.innerHTML = `<div class="p-empty">${t("ctx.loading")}</div>`;
  let data;
  try {
    const res = await fetch(`/${sid}/context`, { signal: ac.signal });
    if (!res.ok) throw new Error(await res.text());
    data = await res.json();
    if (mySeq !== ctxFetchSeq) return;
  } catch (e) {
    if (e?.name === "AbortError" || mySeq !== ctxFetchSeq) return;
    ctxBody.innerHTML = `<div class="p-empty">${escape(String(e.message ?? e))}</div>`;
    updateDropButton();
    return;
  }
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  if (c) {
    c.currentMsgs = msgs;
    c.currentGroups = computeGroups(msgs);
  }
  const groups = currentGroupsArr();
  ctxMeta.textContent = `${t("ctx.n.msgs", { n: msgs.length })} · ${fmtTok(data.activeTokens ?? 0)}/${fmtTok(data.contextWindow ?? 0)}`;

  ctxBody.innerHTML = "";
  if (msgs.length === 0) {
    ctxBody.innerHTML = `<div class="p-empty">${t("ctx.empty")}</div>`;
    updateDropButton();
    return;
  }
  const groupSizes = new Map();
  const groupFirst = new Map();
  const groupLast = new Map();
  groups.forEach((g, i) => {
    groupSizes.set(g, (groupSizes.get(g) ?? 0) + 1);
    if (!groupFirst.has(g)) groupFirst.set(g, i);
    groupLast.set(g, i);
  });

  const chevMeasure = [];
  msgs.forEach((m, i) => {
    // System notes (project-skills discovery) are invisible to the UI — skip
    // rendering them. The forEach index stays the true kernel index, so the
    // checkbox/drop mapping remains aligned.
    if (m?.systemNote) return;
    const wrap = document.createElement("div");
    wrap.className = "ctx-msg";
    wrap.dataset.idx = String(i);
    const g = groups[i];
    if ((groupSizes.get(g) ?? 1) > 1) {
      wrap.classList.add("paired");
      if (groupFirst.get(g) === i) wrap.classList.add("pair-start");
      if (groupLast.get(g) === i) wrap.classList.add("pair-end");
    }
    const role = String(m?.role ?? "?");
    const text = messageText(m);
    const tok = tokensOf(m);

    wrap.dataset.role = role;

    const head = document.createElement("div");
    head.className = "ctx-msg-head";
    const check = document.createElement("label");
    check.className = "ctx-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", () => setGroupSelected(groups[i], cb.checked));
    const box = document.createElement("span");
    box.className = "ctx-box";
    check.appendChild(cb);
    check.appendChild(box);
    head.appendChild(check);
    const roleSpan = document.createElement("span");
    roleSpan.className = `p-badge ctx-role ${escape(role)}`;
    roleSpan.textContent = role;
    head.appendChild(roleSpan);
    const tokSpan = document.createElement("span");
    tokSpan.className = "ctx-tokens";
    tokSpan.textContent = `~${fmtTok(tok)}`;
    head.appendChild(tokSpan);
    const idxSpan = document.createElement("span");
    idxSpan.className = "ctx-idx";
    idxSpan.textContent = `#${i}`;
    head.appendChild(idxSpan);
    wrap.appendChild(head);

    const body = document.createElement("div");
    body.className = "ctx-text";
    const textNode = document.createElement("div");
    textNode.className = "ctx-text-inner";
    // 截断渲染：完整文本仅通过闭包引用 currentMsgs 里的字符串（无拷贝），
    // DOM 初始只放预览；展开时注入全文，折叠时恢复预览，长文本不常驻 DOM。
    const truncated = text.length > CTX_TEXT_MAX;
    const preview = truncated ? text.slice(0, CTX_TEXT_MAX) : text;
    const setText = (full) => {
      if (full || !truncated) {
        textNode.textContent = text;
        return;
      }
      textNode.textContent = preview;
      const more = document.createElement("span");
      more.className = "ctx-ellipsis";
      more.textContent = " …";
      textNode.appendChild(more);
    };
    setText(false);
    body.appendChild(textNode);
    const chev = document.createElement("button");
    chev.type = "button";
    chev.className = "ctx-chevron";
    chev.textContent = t("ctx.expand");
    chev.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const on = !body.classList.contains("expanded");
      body.classList.toggle("expanded", on);
      setText(on);
      chev.textContent = on ? t("ctx.collapse") : t("ctx.expand");
    });
    body.appendChild(chev);
    wrap.appendChild(body);

    chevMeasure.push(wrap);
    ctxBody.appendChild(wrap);
  });
  measureChevrons(chevMeasure);
  applyCtxFilter();
  updateDropButton();
};

ctxDrop?.addEventListener("click", async () => {
  const selected = selectedSet();
  if (selected.size === 0) return;
  const indices = [...selected].sort((a, b) => a - b);
  try {
    const res = await fetch(`/${currentSessionId()}/context/drop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ indices }),
    });
    if (!res.ok) throw new Error(await res.text());
  } catch (e) {
    // Server error bodies can be whole HTML pages — keep the main message
    // short and stash the full text behind the expandable detail.
    const msg = String(e?.message ?? e);
    const short = msg.length > 120 ? `${msg.slice(0, 120)}…` : msg;
    toast(t("ctx.drop.failed", { msg: short }), {
      type: "error",
      detail: msg.length > 120 ? msg : undefined,
    });
    return;
  }
  renderContext();
});

ctxRefresh?.addEventListener("click", () => renderContext());

ctxFilters?.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".p-seg-item");
  if (!btn) return;
  const role = btn.dataset.role;
  const roles = activeRolesSet();
  if (role === "all") {
    roles.clear();
    roles.add("all");
  } else {
    roles.delete("all");
    if (roles.has(role)) roles.delete(role);
    else roles.add(role);
    if (roles.size === 0) roles.add("all");
  }
  ctxFilters.querySelectorAll(".p-seg-item").forEach((c) => {
    c.classList.toggle("active", roles.has(c.dataset.role));
  });
  applyCtxFilter();
});

const setCtxOpen = (on) => {
  if (on) {
    ctxPanel.removeAttribute("hidden"); app.classList.add("ctx-open"); renderContext(); ctxToggle?.classList.add("active");
  }
  else { ctxPanel.setAttribute("hidden", ""); app.classList.remove("ctx-open"); ctxToggle?.classList.remove("active"); }
  try { localStorage.setItem(LS_CTX, on ? "1" : "0"); } catch {}
};

// 延迟初始化，避免循环依赖导致的 TDZ 错误
setTimeout(() => {
  try {
    if (localStorage.getItem(LS_CTX) === "1") setCtxOpen(true);
  } catch {}
}, 0);

ctxClose?.addEventListener("click", () => setCtxOpen(false));

// Refresh context panel content when language changes while panel is open
document.addEventListener("langchange", () => {
  if (ctxPanel && !ctxPanel.hasAttribute("hidden")) renderContext();
});

// Rewind/fork rebuilds the context server-side (contract H): indices
// rendered before the switch are stale and would drop the wrong messages,
// so re-fetch while the panel is open.  renderContext also clears the
// selection, discarding any stale checked rows.
document.addEventListener("ash:branch-switched", () => {
  if (ctxPanel && !ctxPanel.hasAttribute("hidden")) renderContext();
});

// Re-render when the active session changes (Phase 3 SPA switching).
effect(() => {
  activeSession.value;
  if (ctxPanel && !ctxPanel.hasAttribute("hidden")) renderContext();
});

export { setCtxOpen };

document.addEventListener("keydown", (ev) => {
  const meta = ev.metaKey || ev.ctrlKey;
  if (meta && ev.key === "\\") {
    ev.preventDefault();
    setCtxOpen(ctxPanel.hasAttribute("hidden"));
  }
});

import { registerPanel } from './panel-manager.js';
registerPanel('ctx', { toggleBtnId: 'ctx-toggle', panelId: 'ctx-panel', open: () => setCtxOpen(true), close: () => setCtxOpen(false) });
