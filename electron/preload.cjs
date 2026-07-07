const { contextBridge, ipcRenderer } = require("electron");

const onChannel = (channel, callback) => {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_event, ...args) => callback(...args));
};

contextBridge.exposeInMainWorld("electronAPI", {
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  checkForUpdate: () => ipcRenderer.invoke("check-for-update"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  focusWindow: () => ipcRenderer.invoke("focus-window"),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  onUpdateAvailable: (cb) => onChannel("update-available", cb),
  /** Send theme change to main process to update native title bar */
  onThemeChange: (theme) => ipcRenderer.send("theme-changed", theme),
  openSessionWindow: (sessionId, pos) => ipcRenderer.invoke("open-session-window", sessionId, pos),
  moveTabToWindowAt: (sessionId, pos) => ipcRenderer.invoke("move-tab-to-window-at", sessionId, pos),
  onAcceptTab: (cb) => onChannel("accept-tab", cb),
  tabDragUpdate: (pos, phase) => ipcRenderer.send("tab-drag-update", pos, phase),
  onTabDragHover: (cb) => onChannel("tab-drag-hover", (payload) => cb(payload || {})),
  onSuspend: (cb) => onChannel("app:suspend", cb),
  onResume: (cb) => onChannel("app:resume", cb),
});
