const { contextBridge, ipcRenderer } = require("electron");

// Append-style subscription: multiple renderer modules may listen on the
// same channel (e.g. "update-available" is used by both version.js and
// updater.js).  Dedup by callback reference so re-registering the same
// handler doesn't stack duplicates.
const _ipcListeners = new Map(); // channel -> Set<callback>
const onChannel = (channel, callback) => {
  let set = _ipcListeners.get(channel);
  if (!set) { set = new Set(); _ipcListeners.set(channel, set); }
  if (set.has(callback)) return;
  set.add(callback);
  ipcRenderer.on(channel, (_event, ...args) => callback(...args));
};

contextBridge.exposeInMainWorld("electronAPI", {
  /** process.platform ("win32" | "darwin" | "linux") — the renderer's platform
   *  source of truth.  navigator.platform is deprecated in Chromium and the
   *  Windows custom title bar depends on this value being right. */
  platform: process.platform,
  getBackgroundSettings: () => ipcRenderer.invoke('desktop:background:get'),
  setBackgroundSettings: (patch) => ipcRenderer.invoke('desktop:background:set', patch),
  onBackgroundSettings: (cb) => onChannel('desktop:background:changed', cb),
  onOpenMobileAccess: (cb) => onChannel('desktop:open-mobile', cb),
  notifyDesktopReady: () => ipcRenderer.send('desktop:ready'),
  browserStatus: id => ipcRenderer.invoke('desktop:browser-status', id),
  browserLayout: (id, bounds) => ipcRenderer.send('desktop:browser-layout', id, bounds),
  browserControl: (id, action, pageId) => ipcRenderer.send('desktop:browser-control', id, action, pageId),
  onBrowserChanged: cb => onChannel('desktop:browser-changed', cb),
  fileAction: (request) => ipcRenderer.invoke("desktop:file", request),
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  checkForUpdate: () => ipcRenderer.invoke("check-for-update"),
  startUpdateDownload: () => ipcRenderer.invoke("start-update-download"),
  quitAndInstall: () => ipcRenderer.invoke("quit-and-install"),
  openUpdateDownload: () => ipcRenderer.invoke("open-update-download"),
  getUpdateMode: () => ipcRenderer.invoke("get-update-mode"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  focusWindow: () => ipcRenderer.invoke("focus-window"),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  onUpdateAvailable: (cb) => onChannel("update-available", cb),
  onUpdateDownloadProgress: (cb) => onChannel("update-download-progress", cb),
  onUpdateDownloaded: (cb) => onChannel("update-downloaded", cb),
  onUpdateError: (cb) => onChannel("update-error", cb),
  notifyUpdaterReady: () => ipcRenderer.send("updater-ready"),
  /** Send theme change to main process to update native title bar */
  onThemeChange: (theme) => ipcRenderer.send("theme-changed", theme),
  openSessionWindow: (sessionId, pos) => ipcRenderer.invoke("open-session-window", sessionId, pos),
  moveTabToWindowAt: (sessionId, kind) => ipcRenderer.invoke("move-tab-to-window-at", sessionId, kind),
  onAcceptTab: (cb) => onChannel("accept-tab", cb),
  tabDragUpdate: (pos, phase) => ipcRenderer.send("tab-drag-update", pos, phase),
  onTabDragHover: (cb) => onChannel("tab-drag-hover", (payload) => cb(payload || {})),
  onSuspend: (cb) => onChannel("app:suspend", cb),
  onResume: (cb) => onChannel("app:resume", cb),
});

// Keep macOS window controls centered when title-bar preferences change.
if (process.platform === 'darwin') {
  window.addEventListener('DOMContentLoaded', () => {
    const titleBar = document.querySelector('.title-bar');
    if (!titleBar) return;
    const sync = () => ipcRenderer.send('desktop:titlebar-height', titleBar.getBoundingClientRect().height);
    const observer = new ResizeObserver(sync);
    observer.observe(titleBar);
    window.addEventListener('resize', sync);
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    sync();
  }, { once: true });
}
