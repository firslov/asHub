import {
  escape, fmtNum, langForPath, highlightDiffLine,
  diffToText, copyToClipboard,
} from "../utils.js";
import { append } from "./tool-group.js";
import { t } from "../i18n.js";

export const hideUsage = (session) => {
  const strip = session?.usageStripEl;
  if (!strip) return;
  if (strip.closest(".terminal-wrap")?.dataset.uiUsageSticky === "true") return;
  strip.hidden = true;
};

export const renderUsage = (session) => {
  const st = session?.state;
  if (!st?.lastUsage) return;
  const usageEl = session?.usageEl;
  if (!usageEl) return;
  const inTok = st.lastUsage.prompt_tokens ?? 0;
  const outTok = st.lastUsage.completion_tokens ?? 0;
  const cacheHit = st.lastUsage.prompt_cache_hit_tokens ?? 0;
  const cacheMiss = st.lastUsage.prompt_cache_miss_tokens ?? 0;
  let pct = 0;
  let ctxText = `${(inTok / 1000).toFixed(1)}k`;
  if (st.contextWindow > 0) {
    pct = Math.round((inTok / st.contextWindow) * 100);
    ctxText = `${(inTok / 1000).toFixed(1)}k / ${(st.contextWindow / 1000).toFixed(0)}k`;
  }
  const totalTok = st.lastUsage.total_tokens ?? (inTok + outTok);
  const cacheTotal = cacheHit + cacheMiss;
  const cacheRatio = cacheTotal > 0 ? cacheHit / cacheTotal : 0;
  const cacheRatioPct = cacheRatio * 100;
  const cacheRatioClass = cacheRatioPct >= 80 ? "high" : cacheRatioPct >= 40 ? "mid" : "low";
  // Floor to 1 decimal so a near-miss (e.g. 99.85%) never reads as a perfect 100%.
  const cachePctLabel = (Math.floor(cacheRatioPct * 10) / 10).toFixed(1);
  const cacheTooltip = `${t("usage.cache")}: ${fmtNum(cacheHit)} / ${fmtNum(cacheMiss)} (${cachePctLabel}%)`;
  // SVG ring: r=9, circumference ≈ 56.5487
  const ringCircum = 56.5487;
  const ringOffset = ringCircum * (1 - cacheRatio);
  const cacheHtml = (cacheHit > 0 || cacheMiss > 0)
    ? `<span class="usage-chip usage-cache" title="${cacheTooltip}">` +
        `<svg class="cache-ring" viewBox="0 0 24 24" width="16" height="16">` +
          `<circle class="cache-ring-track" cx="12" cy="12" r="9"/>` +
          `<circle class="cache-ring-fill ${cacheRatioClass}" cx="12" cy="12" r="9"` +
            ` stroke-dasharray="${ringCircum}" stroke-dashoffset="${ringOffset.toFixed(2)}"/>` +
        `</svg>` +
        `<span class="cache-pct ${cacheRatioClass}">${cachePctLabel}%</span>` +
      `</span>`
    : "";

  usageEl.innerHTML =
    `<span class="usage-chip usage-total" title="${t("usage.total")}">${fmtNum(totalTok)}</span>` +
    cacheHtml +
    `<span class="usage-chip usage-ctx" title="${t("usage.context")}">` +
      (st.contextWindow > 0
        ? `<span class="usage-bar"><span style="width:${pct}%"></span></span>`
        : "") +
      `${ctxText}` +
    `</span>`;
  usageEl.classList.toggle("warm", pct >= 30 && pct < 70);
  usageEl.classList.toggle("hot", pct >= 70);
};

export const renderTurnSep = (session, ts) => {
  const sep = document.createElement("div");
  sep.className = "turn-sep";
  const date = ts ? new Date(ts) : new Date();
  const timeStr = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dateStr = date.toLocaleDateString([], { month: "short", day: "numeric" });

  // Show date for first turn of a new day
  const today = dateStr;
  let dateLabel = "";
  if (session._lastSepDate !== today) {
    session._lastSepDate = today;
    dateLabel = `${today} · `;
  }

  sep.innerHTML =
    `<span class="turn-line"></span>` +
    `<span class="turn-time">${dateLabel}${timeStr}</span>` +
    `<span class="turn-line"></span>`;
  append(session, sep);
  return sep;
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
  wrap.className = "diff-block wrapped";
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

const TOOL_ICON_PATHS = {
  read: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  execute: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  write: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
};

const renderToolIcon = (kind) => {
  const paths = kind && TOOL_ICON_PATHS[kind];
  if (!paths) return "";
  return `<svg class="tool-icon tool-icon--${escape(kind)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
};

export const buildToolRow = (p) => {
  const row = document.createElement("div");
  row.className = "tool-row";
  if (p?.toolCallId) row.dataset.callId = p.toolCallId;
  if (p?.kind) row.dataset.kind = p.kind;
  // Bare tool name for collapsed group summaries (icon/title markup varies).
  row.dataset.toolName = p?.name ?? p?.title ?? "";

  const iconSvg = renderToolIcon(p?.kind);
  const fallbackIcon = typeof p?.icon === "string" && p.icon.length > 0 ? p.icon : "";
  const hasCustomIcon = iconSvg.length > 0 || fallbackIcon.length > 0;
  const iconHtml = iconSvg || escape(fallbackIcon || "·");
  const raw = (p?.rawInput && typeof p.rawInput === "object") ? p.rawInput : {};
  // agent-loop appends ": <description>" to bash titles; strip it.
  let title = p?.title ?? t("tool");
  if ((raw.command || raw.source) && title.includes(":")) title = title.split(":")[0];
  if (hasCustomIcon) title = "";

  const hasSource = typeof raw.source === "string" && raw.source.trim().length > 0;
  const sourceLanguage = typeof p?.sourceLanguage === "string" ? p.sourceLanguage : "";

  let detail = p?.displayDetail;
  if (hasSource) detail = "";
  if (!detail && Array.isArray(p?.locations) && p.locations[0]?.path) {
    detail = p.locations[0].path + (p.locations[0].line ? `:${p.locations[0].line}` : "");
  }
  if (!detail) {
    if (raw.command) detail = `$ ${raw.command}`;
    else if (hasSource) detail = raw.source;
    else detail = raw.pattern ?? raw.query ?? raw.path ?? "";
  }

  const cmdFull = (raw.command && typeof raw.command === "string" && raw.command.length > CMD_COLLAPSE)
    ? raw.command : "";
  if (cmdFull) raw.command = cmdFull.slice(0, CMD_COLLAPSE).trimEnd() + "…";

  const detailHtml = renderToolDetail(detail, raw, sourceLanguage);
  if (cmdFull) raw.command = cmdFull;

  row.innerHTML =
    `<span class="tool-name">${iconHtml}${title ? " " + escape(title) : ""}</span>` +
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

export const renderToolDetail = (detail, raw, sourceLanguage = "") => {
  if (raw?.source && typeof raw.source === "string") {
    const src = raw.source;
    let html = escape(src);
    let langClass = "";
    if (sourceLanguage && window.hljs && window.hljs.getLanguage(sourceLanguage)) {
      try {
        html = window.hljs.highlight(src, { language: sourceLanguage }).value;
        langClass = ` language-${sourceLanguage}`;
      } catch {}
    }
    return `<code class="tool-detail tool-cmd hljs${langClass}">${html}</code>`;
  }
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
  copyBtn.className = "tool-body-btn copy-btn";
  copyBtn.textContent = t("copy");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(all);
      copyBtn.classList.add("copied");
      copyBtn.textContent = t("copied");
      setTimeout(() => {
        copyBtn.classList.remove("copied");
        copyBtn.textContent = t("copy");
      }, 1200);
    } catch (e) { console.error("clipboard", e); }
  });
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

