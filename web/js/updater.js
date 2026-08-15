// Update download card — bottom-right floating card driven by the
// main process's autoUpdater events (see electron/main.cjs).
//
// States:
//   available    "vX.Y.Z is available"          → [Download] [Later]
//   downloading  progress bar + % + MB + speed  → (no buttons, stays open)
//   downloaded   "vX.Y.Z downloaded"            → [Restart & Install] [Later]
//   error        "Download failed"              → [Retry] [Dismiss]

import { t } from "./i18n.js";

let state = "idle"; // idle | available | downloading | downloaded | error
let version = "";
let progress = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };
let errorMsg = "";
let el = null;

const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
};

const ensureCard = () => {
  if (el && el.isConnected) return el;
  el = document.createElement("div");
  el.className = "update-card";
  el.hidden = true;
  document.body.appendChild(el);
  return el;
};

const dismiss = () => {
  if (!el) return;
  el.classList.add("update-card-exit");
  setTimeout(() => {
    if (el) { el.remove(); el = null; }
  }, 200);
  state = "idle";
};

const render = () => {
  const card = ensureCard();
  card.classList.remove("update-card-exit");
  card.hidden = false;

  // Fast path: already showing the downloading card — update only the
  // progress elements instead of rebuilding the DOM on every tick.
  if (state === "downloading" && el.dataset.state === "downloading") {
    const pct = Math.max(0, Math.min(100, progress.percent || 0));
    const speed = fmtBytes(progress.bytesPerSecond) + "/s";
    const fill = card.querySelector(".update-bar-fill");
    const pctEl = card.querySelector(".update-pct");
    const speedEl = card.querySelector(".update-speed");
    const detailEl = card.querySelector(".update-card-detail");
    const titleEl = card.querySelector(".update-card-title");
    if (fill) fill.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct.toFixed(0)}%`;
    if (speedEl) speedEl.textContent = speed;
    if (detailEl) detailEl.textContent = `${fmtBytes(progress.transferred)} / ${fmtBytes(progress.total)} · ${speed}`;
    if (titleEl) titleEl.textContent = t("update.downloading", { ver: version });
    return;
  }
  el.dataset.state = state;

  const actions = (btns) => btns.map(([label, cls, fn]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `update-btn ${cls}`;
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  });

  let icon = "⬇";
  let title = "";
  let detail = "";
  let progressHtml = "";
  let buttons = [];

  switch (state) {
    case "available":
      icon = "✨";
      title = t("update.available", { ver: version });
      detail = t("update.available.hint");
      buttons = [
        [t("update.download"), "primary", onDownload],
        [t("update.later"), "ghost", dismiss],
      ];
      break;
    case "downloading":
      icon = "⬇";
      title = t("update.downloading", { ver: version });
      const pct = Math.max(0, Math.min(100, progress.percent || 0));
      const speed = fmtBytes(progress.bytesPerSecond) + "/s";
      detail = `${fmtBytes(progress.transferred)} / ${fmtBytes(progress.total)} · ${speed}`;
      progressHtml = `
        <div class="update-bar">
          <div class="update-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="update-meta">
          <span class="update-pct">${pct.toFixed(0)}%</span>
          <span class="update-speed">${speed}</span>
        </div>`;
      break;
    case "downloaded":
      icon = "✅";
      title = t("update.downloaded", { ver: version });
      detail = t("update.downloaded.hint");
      buttons = [
        [t("update.restart"), "primary", onRestart],
        [t("update.later"), "ghost", dismiss],
      ];
      break;
    case "error":
      icon = "⚠";
      title = t("update.failed");
      detail = errorMsg || t("update.failed.hint");
      buttons = [
        [t("update.retry"), "primary", onDownload],
        [t("close"), "ghost", dismiss],
      ];
      break;
  }

  card.innerHTML = "";
  const iconEl = document.createElement("span");
  iconEl.className = "update-card-icon";
  iconEl.textContent = icon;
  const body = document.createElement("div");
  body.className = "update-card-body";
  const titleEl = document.createElement("div");
  titleEl.className = "update-card-title";
  titleEl.textContent = title;
  const detailEl = document.createElement("div");
  detailEl.className = "update-card-detail";
  detailEl.textContent = detail;
  body.append(titleEl, detailEl);
  if (progressHtml) {
    const wrap = document.createElement("div");
    wrap.className = "update-progress";
    wrap.innerHTML = progressHtml;
    body.appendChild(wrap);
  }
  const btnRow = document.createElement("div");
  btnRow.className = "update-actions";
  btnRow.append(...actions(buttons));
  card.append(iconEl, body, btnRow);
};

const onDownload = async () => {
  if (!window.electronAPI?.startUpdateDownload) return;
  state = "downloading";
  render();
  try {
    const res = await window.electronAPI.startUpdateDownload();
    if (res && res.ok === false) {
      state = "error";
      errorMsg = res.error || "";
      render();
    }
  } catch (err) {
    state = "error";
    errorMsg = String(err?.message ?? err ?? "");
    render();
  }
};

const onRestart = async () => {
  const api = window.electronAPI;
  if (!api?.quitAndInstall) return;
  try {
    const res = await api.quitAndInstall();
    // quitAndInstall() initiates the quit immediately, so a successful
    // call normally never resolves — but if it does return with an error
    // (e.g. no pending download), surface it instead of doing nothing.
    if (res && res.ok === false) {
      errorMsg = res.error || "";
      state = "error";
      render();
    }
  } catch (err) {
    errorMsg = String(err?.message ?? err ?? "");
    state = "error";
    render();
  }
};

const bindEvents = () => {
  const api = window.electronAPI;
  if (!api) return;

  api.onUpdateAvailable((newVersion) => {
    // A re-check can re-fire update-available while a download is in
    // flight (e.g. the user clicked the version label) — don't clobber
    // the in-progress/downloaded card back to "available".
    if (state === "downloading" || state === "downloaded") return;
    version = String(newVersion ?? "");
    progress = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };
    errorMsg = "";
    state = "available";
    render();
  });

  api.onUpdateDownloadProgress((p) => {
    if (state !== "downloading") state = "downloading";
    progress = {
      percent: p?.percent ?? progress.percent,
      transferred: p?.transferred ?? 0,
      total: p?.total ?? 0,
      bytesPerSecond: p?.bytesPerSecond ?? 0,
    };
    render();
  });

  api.onUpdateDownloaded((ver) => {
    if (ver) version = String(ver);
    state = "downloaded";
    render();
  });

  api.onUpdateError((msg) => {
    // The error event also fires for update CHECK failures (e.g. mirror +
    // GitHub both unreachable at startup) before any card was shown.
    // Stay silent then — the user never started a download.
    if (state === "idle") return;
    errorMsg = String(msg ?? "");
    state = "error";
    render();
  });

  // Re-render on language switch so all text stays localized.
  document.addEventListener("langchange", () => {
    if (state !== "idle" && el?.isConnected) render();
  });

  // All listeners above are registered — tell the main process it can
  // flush any update-available buffered during the startup race.
  api.notifyUpdaterReady?.();
};

bindEvents();
