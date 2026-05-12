import { escape } from "./utils.js";
import { currentSessionId } from "./state.js";
import { setFilesOpen } from "./files-panel.js";
import { setConfigOpen } from "./config-panel.js";
import { t } from "./i18n.js";

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

const tokensOf = (m) => Math.ceil(JSON.stringify(m ?? null).length / 4);
const fmtTok = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

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
      return `→ ${fn.name ?? t("tool")}(\n${args}\n)`;
    }).join("\n\n");
  }
  if (m?.role === "tool") return String(m.content ?? "");
  return JSON.stringify(m ?? {});
};

import { activeSession } from "./session-manager.js";

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

const applyCtxFilter = () => {
  const roles = activeRolesSet();
  const all = roles.has("all");
  ctxBody.querySelectorAll(".ctx-msg").forEach((el) => {
    const role = el.dataset.role ?? "";
    el.hidden = !all && !roles.has(role);
  });
};

const renderContext = async () => {
  const c = ctx();
  if (c) c.selected.clear();
  const sid = currentSessionId();
  if (!sid) { ctxBody.innerHTML = `<div class="ctx-empty">${t("ctx.no.session")}</div>`; updateDropButton(); return; }
  ctxBody.innerHTML = `<div class="ctx-empty">${t("ctx.loading")}</div>`;
  let data;
  try {
    const res = await fetch(`/${sid}/context`);
    if (!res.ok) throw new Error(await res.text());
    data = await res.json();
  } catch (e) {
    ctxBody.innerHTML = `<div class="ctx-empty">${escape(String(e.message ?? e))}</div>`;
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
    ctxBody.innerHTML = `<div class="ctx-empty">${t("ctx.empty")}</div>`;
    updateDropButton();
    return;
  }
  const groupSizes = new Map();
  for (const g of groups) groupSizes.set(g, (groupSizes.get(g) ?? 0) + 1);

  msgs.forEach((m, i) => {
    const wrap = document.createElement("div");
    wrap.className = "ctx-msg";
    wrap.dataset.idx = String(i);
    if ((groupSizes.get(groups[i]) ?? 1) > 1) wrap.classList.add("paired");
    const role = String(m?.role ?? "?");
    const text = messageText(m);
    const tok = tokensOf(m);

    wrap.dataset.role = role;

    const head = document.createElement("div");
    head.className = "ctx-msg-head";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", () => setGroupSelected(groups[i], cb.checked));
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
    chev.textContent = t("ctx.expand");
    chev.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const on = !body.classList.contains("expanded");
      body.classList.toggle("expanded", on);
      chev.textContent = on ? t("ctx.collapse") : t("ctx.expand");
    });
    body.appendChild(chev);
    wrap.appendChild(body);

    requestAnimationFrame(() => {
      if (textNode.scrollHeight <= textNode.clientHeight + 4) chev.hidden = true;
    });

    ctxBody.appendChild(wrap);
  });
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
    alert(t("ctx.drop.failed", { msg: e.message ?? e }));
    return;
  }
  renderContext();
});

ctxRefresh?.addEventListener("click", () => renderContext());

ctxFilters?.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".ctx-chip");
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
  ctxFilters.querySelectorAll(".ctx-chip").forEach((c) => {
    c.dataset.active = roles.has(c.dataset.role) ? "1" : "0";
  });
  applyCtxFilter();
});

const setCtxOpen = (on) => {
  if (on) {
    // 互斥：关闭其他面板
    setFilesOpen(false);
    setConfigOpen(false);
    const promptOverlay = document.getElementById("prompt-overlay");
    if (promptOverlay && !promptOverlay.hasAttribute("hidden")) {
      promptOverlay.setAttribute("hidden", "");
      promptOverlay.classList.remove("open");
      document.getElementById("prompt-toggle")?.classList.remove("active");
    }
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

ctxToggle?.addEventListener("click", () => setCtxOpen(ctxPanel.hasAttribute("hidden")));
ctxClose?.addEventListener("click", () => setCtxOpen(false));

// Refresh context panel content when language changes while panel is open
document.addEventListener("langchange", () => {
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
