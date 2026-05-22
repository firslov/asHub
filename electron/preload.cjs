const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  pickDirectory: () => ipcRenderer.invoke("pick-directory"),
  checkForUpdate: () => ipcRenderer.invoke("check-for-update"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  onUpdateAvailable: (callback) => {
    ipcRenderer.removeAllListeners("update-available");
    ipcRenderer.on("update-available", (_event, version) => callback(version));
  },
  /** Send theme change to main process to update native title bar */
  onThemeChange: (theme) => ipcRenderer.send("theme-changed", theme),
});
