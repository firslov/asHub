import {
  escape, fmtNum, langForPath, highlightDiffLine,
  diffToText, copyToClipboard,
} from "../utils.js";
import { state } from "../state.js";
import { append } from "./tool-group.js";
import { t } from "../i18n.js";
import { activeSession } from "../session-manager.js";

const sess = () => activeSession.peek();

export const hideUsage = () => {
  const strip = sess()?.usageStripEl;
  if (strip) strip.hidden = true;
};

export const renderUsage = () => {
  if (!state.lastUsage) return;
  const session = sess();
  const usageEl = session?.usageEl;
  const usageStrip = session?.usageStripEl;
  if (!usageEl) return;
  const inTok = state.lastUsage.prompt_tokens ?? 0;
  const outTok = state.lastUsage.completion_tokens ?? 0;
  const cacheHit = state.lastUsage.prompt_cache_hit_tokens ?? 0;
  const cacheMiss = state.lastUsage.prompt_cache_miss_tokens ?? 0;
  let pct = 0;
  let ctxText = `${(inTok / 1000).toFixed(1)}k`;
  if (state.contextWindow > 0) {
    pct = Math.round((inTok / state.contextWindow) * 100);
    ctxText = `${(inTok / 1000).toFixed(1)}k / ${(state.contextWindow / 1000).toFixed(0)}k`;
  }
  const totalTok = state.lastUsage.total_tokens ?? (inTok + outTok);
  const cacheHtml = (cacheHit > 0 || cacheMiss > 0)
    ? `<span class="usage-chip usage-cache" title="${t("usage.cache")}">` +
        `<span class="cache-dot hit"></span>${fmtNum(cacheHit)}` +
        `<span class="cache-sep">/</span>` +
        `<span class="cache-dot miss"></span>${fmtNum(cacheMiss)}` +
      `</span>`
    : "";
  usageEl.innerHTML =
    `<span class="usage-chip" title="${t("usage.input")}">↑ ${fmtNum(inTok)}</span>` +
    `<span class="usage-chip" title="${t("usage.output")}">↓ ${fmtNum(outTok)}</span>` +
    `<span class="usage-chip" title="${t("usage.total")}">Σ ${fmtNum(totalTok)}</span>` +
    cacheHtml +
    `<span class="usage-chip usage-ctx" title="${t("usage.context")}">` +
      (state.contextWindow > 0
        ? `<span class="usage-bar"><span style="width:${pct}%"></span></span>`
        : "") +
      `${ctxText}${state.contextWindow > 0 ? ` (${pct}%)` : ""}` +
    `</span>`;
  usageEl.classList.toggle("warm", pct >= 30 && pct < 70);
  usageEl.classList.toggle("hot", pct >= 70);
  if (usageStrip) usageStrip.hidden = false;
};

export const renderTurnSep = () => {
  const sep = document.createElement("div");
  sep.className = "turn-sep";
  sep.innerHTML =
    `<span class="turn-line"></span>` +
    (state.cwd ? `<span class="turn-cwd">${escape(state.cwd)}</span>` : "") +
    `<span class="turn-time">${new Date().toLocaleTimeString()}</span>` +
    `<span class="turn-line"></span>`;
  append(sep);
  return sep;
};

export const renderPromptRow = () => {
  if (!state.cwd) return;
  const row = document.createElement("div");
  row.className = "pl-row";
  row.innerHTML =
    `<span class="pl-left"><span class="pl-path">${escape(state.cwd)}</span></span>` +
    `<span class="pl-right"><span class="pl-seg pl-time">${new Date().toLocaleTimeString()}</span></span>`;
  append(row);
};

export const renderErrorCard = (message, detail) => {
  const card = document.createElement("div");
  card.className = "err-card";
  const head = document.createElement("div");
  head.className = "err-card-head";
  head.innerHTML =
    `<span class="err-card-icon">!</span>` +
    `<span class="err-card-title">${escape(message || t("error"))}</span>`;
  card.appendChild(head);
  const detailText = String(detail ?? "").trim();
  if (detailText) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "err-card-toggle";
    toggle.textContent = t("show.details");
    head.appendChild(toggle);
    const body = document.createElement("pre");
    body.className = "err-card-body";
    body.textContent = detailText;
    body.hidden = true;
    toggle.addEventListener("click", () => {
      body.hidden = !body.hidden;
      toggle.textContent = body.hidden ? t("show.details") : t("hide.details");
    });
    card.appendChild(body);
  }
  return card;
};

export const renderDiffBlock = (diff, filePath) => {
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
      `<button class="diff-btn diff-wrap" title="${t("diff.toggle.wrap")}">${t("wrap")}</button>` +
      `<button class="diff-btn diff-copy" title="${t("diff.copy.patch")}">${t("copy")}</button>` +
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

const CMD_COLLAPSE = 100;

export const buildToolRow = (p) => {
  const row = document.createElement("div");
  row.className = "tool-row";
  if (p?.toolCallId) row.dataset.callId = p.toolCallId;

  const icon = p?.icon ?? "·";
  const raw = (p?.rawInput && typeof p.rawInput === "object") ? p.rawInput : {};
  // agent-loop appends ": <description>" to bash titles; strip it.
  let title = p?.title ?? t("tool");
  if (raw.command && title.includes(":")) title = title.split(":")[0];

  let detail = p?.displayDetail;
  if (!detail && Array.isArray(p?.locations) && p.locations[0]?.path) {
    detail = p.locations[0].path + (p.locations[0].line ? `:${p.locations[0].line}` : "");
  }
  if (!detail) {
    if (raw.command) detail = `$ ${raw.command}`;
    else detail = raw.pattern ?? raw.query ?? raw.path ?? "";
  }

  const cmdFull = (raw.command && typeof raw.command === "string" && raw.command.length > CMD_COLLAPSE)
    ? raw.command : "";
  if (cmdFull) raw.command = cmdFull.slice(0, CMD_COLLAPSE).trimEnd() + "…";
  const detailHtml = renderToolDetail(detail, raw);
  if (cmdFull) raw.command = cmdFull;

  row.innerHTML =
    `<span class="tool-name">${escape(icon)} ${escape(title)}</span>` +
    (detailHtml ? ` ${detailHtml}` : "");

  if (cmdFull) {
    const detailEl = row.querySelector(".tool-detail");
    if (detailEl) {
      detailEl.classList.add("tool-cmd-collapsed");
      detailEl.title = t("click.expand.cmd");
      detailEl.style.cursor = "pointer";
      detailEl.addEventListener("click", () => {
        const expanded = detailEl.classList.toggle("tool-cmd-expanded");
        detailEl.textContent = expanded
          ? "$ " + cmdFull
          : "$ " + cmdFull.slice(0, CMD_COLLAPSE).trimEnd() + "…";
        detailEl.title = expanded ? t("click.collapse.cmd") : t("click.expand.cmd");
      });
    }
  }
  return row;
};

export const renderToolDetail = (detail, raw) => {
  if (!detail) return "";
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

export const renderToolBody = (lines) => {
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
      ? t("show.less")
      : t("show.n.more", { n: lines.length - TOOL_BODY_COLLAPSE });
    wrap.classList.toggle("expanded", on);
  };

  const actions = document.createElement("div");
  actions.className = "tool-body-actions";
  const copyBtn = document.createElement("button");
  copyBtn.className = "tool-body-btn";
  copyBtn.textContent = t("copy");
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
