const { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, screen } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

process.env.ASHUB_UNDER = "1";
// Legacy compat: extensions may still check the old variable name.
process.env.AGENT_SH_UNDER_HUB = "1";

// =============================================================================
// CRITICAL FIX: Pre-load tsx and patch module system before ANY imports
// =============================================================================
// tsx's ESM loader (registered by agent-sh/extension-loader) runs TypeScript
// through esbuild which transpiles `import.meta.dirname` to
// `import_meta.dirname` where `import_meta` is an empty object. This causes
// extensions using `import.meta.dirname` to get `undefined`, leading to
// `path.join(undefined, ...)` → `TypeError: The "path" argument must be of type string`.
//
// Additionally, tsx's CJS extension handler (`createExtensions` in
// tsx/dist/register-*.cjs) intercepts `Module._extensions['.js']` and calls
// `module._compile(transformedCode, filename)`. Our patch below hooks
// `_compile` AFTER tsx's hook, so we see the already-transformed code and
// can fix the `import_meta.dirname` reference.
// =============================================================================

// Step 1: Register tsx CJS support so require() can load .ts/.tsx files.
// This must happen BEFORE we patch Module.prototype._compile because tsx
// installs its own _compile wrapper via Module._extensions['.js'].
require("tsx/cjs/api").register();

// Step 2: Patch Module.prototype._compile to fix tsx's broken import.meta.dirname
const Module = require("module");
const originalCompile = Module.prototype._compile;

Module.prototype._compile = function (content, filename) {
  // Handle data: URLs from tsx's ESM loader
  if (filename.startsWith("data:text/javascript,")) {
    const filePathMatch = filename.match(/\?filePath=([^&]+)/);
    if (filePathMatch) {
      const realPath = decodeURIComponent(filePathMatch[1]);
      const dirname = path.dirname(realPath);
      // Fix import_meta.url references
      if (content.includes("import_meta.url")) {
        content = content.replace(
          /import_meta\.url/g,
          JSON.stringify(pathToFileURL(realPath).href)
        );
      }
      // Also fix dirname if present
      if (content.includes("import_meta.dirname")) {
        content = content.replace(/import_meta\.dirname/g, JSON.stringify(dirname));
      }
    }
    return originalCompile.call(this, content, filename);
  }

  // Only patch files that tsx processes (TypeScript files or .js files
  // that tsx has transformed)
  const isTsFile = filename.endsWith(".ts") ||
    filename.endsWith(".tsx") ||
    filename.endsWith(".mts") ||
    filename.endsWith(".cts");

  // tsx transforms `import.meta.dirname` to `import_meta.dirname`
  // where `import_meta = { url: ... }` (no dirname property)
  if ((isTsFile || content.includes("import_meta")) &&
    content.includes("import_meta.dirname")) {
    const dirname = path.dirname(filename);
    // Replace all occurrences of `import_meta.dirname` with the actual dirname string
    content = content.replace(/import_meta\.dirname/g, JSON.stringify(dirname));
  }

  return originalCompile.call(this, content, filename);
};

// =============================================================================
// CRITICAL FIX: Patch require.resolve to fix broken symlinks in extension node_modules
// =============================================================================
// Extensions like haoai-backend have:
//   node_modules/agent-sh -> ../../../..  (relative to extension dir)
// When the extension is loaded from ~/.agent-sh/extensions/haoai-backend/,
// the symlink resolves to ~/.agent-sh/ which is NOT a node_modules directory
// and does NOT contain agent-sh. This causes require('agent-sh/...') to fail
// with MODULE_NOT_FOUND or spawn ENOTDIR.
//
// We intercept require.resolve and redirect any resolution under an extension's
// node_modules/agent-sh to the actual agent-sh package in the hub's node_modules.
// =============================================================================

const hubNodeModules = path.join(__dirname, "..", "node_modules");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  // Check if this is a request for agent-sh from an extension's node_modules
  if (request.startsWith("agent-sh") && parent && parent.filename) {
    const parentDir = path.dirname(parent.filename);
    // Check if the parent is inside ~/.agent-sh/extensions/
    if (parentDir.includes(path.join(".agent-sh", "extensions"))) {
      // Try to resolve from the hub's node_modules first
      try {
        return originalResolveFilename.call(this, request, {
          ...parent,
          paths: [hubNodeModules, ...(parent.paths || [])],
        }, isMain, options);
      } catch {
        // Fall through to normal resolution
      }
    }
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const isDev = !app.isPackaged;
const HUB_PORT = 7878;

// ── Download mirror ────────────────────────────────────────────────────
// Route auto-updater traffic through a mirror for faster GitHub access.
// Falls back to GitHub directly if the mirror is unreachable.
const MIRROR_URL = "https://mirror.aihao.world";
const GITHUB_OWNER = "firslov";
const GITHUB_REPO = "ashub";

let mirrorFailed = false;

const fs = require("fs");
const crypto = require("crypto");

function getInstallId() {
  const file = path.join(app.getPath("userData"), ".install-id");
  try {
    const id = fs.readFileSync(file, "utf-8").trim();
    if (id.length >= 16) return id;
  } catch {}
  const id = crypto.randomUUID();
  try { fs.writeFileSync(file, id); } catch {}
  return id;
}

function setupMirrorFeed() {
  if (!MIRROR_URL || isDev) return;
  mirrorFailed = false;
  const feedUrl = `${MIRROR_URL}?clientId=${getInstallId()}`;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: feedUrl,
  });
  console.log("[updater] using mirror:", MIRROR_URL);
}

function fallbackToGitHub() {
  if (mirrorFailed) return; // already on GitHub
  mirrorFailed = true;
  autoUpdater.setFeedURL({
    provider: "github",
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
  });
  console.log("[updater] mirror unreachable, fell back to GitHub");
  autoUpdater.checkForUpdates().catch((err) => {
    console.error("[updater] GitHub fallback check failed:", err.message);
  });
}

let mainWindow = null;
let shutdownHub = null;
let _shuttingDown = false;

// MRU order so cross-window drag hit-tests pick the topmost window.
const windowZOrder = [];
function trackWindow(win) {
  windowZOrder.unshift(win);
  win.on("focus", () => {
    const i = windowZOrder.indexOf(win);
    if (i >= 0) windowZOrder.splice(i, 1);
    windowZOrder.unshift(win);
  });
  win.on("closed", () => {
    const i = windowZOrder.indexOf(win);
    if (i >= 0) windowZOrder.splice(i, 1);
  });
}

function resolveWebRoot() {
  if (isDev) {
    return path.join(__dirname, "..", "web");
  }
  return path.join(process.resourcesPath, "web");
}

// Independent of `mainWindow` so theme/update handlers stay scoped to the primary window.
function createTearOutWindow(loadPath, screenPos) {
  const isDark = nativeTheme.shouldUseDarkColors;
  const opts = {
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "asHub",
    backgroundColor: isDark ? "#18181c" : "#fafaf7",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    titleBarOverlay: process.platform === "darwin" ? {
      color: isDark ? "#18181c" : "#fafaf7",
      symbolColor: isDark ? "#e8e8ec" : "#1d1d22",
    } : undefined,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  };
  if (screenPos && Number.isFinite(screenPos.x) && Number.isFinite(screenPos.y)) {
    // Offset so the title-bar lands roughly under the cursor where the drop happened.
    opts.x = Math.round(screenPos.x - 80);
    opts.y = Math.round(screenPos.y - 20);
  }
  const win = new BrowserWindow(opts);
  trackWindow(win);
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win.show());
  win.loadURL(`http://127.0.0.1:${HUB_PORT}${loadPath}`);
  if (process.platform === "darwin") {
    win.webContents.on("did-finish-load", () => {
      if (win.isDestroyed()) return;
      win.webContents.executeJavaScript(
        `document.querySelector('.title-bar').style.paddingLeft = '80px'`
      ).catch(() => {});
    });
  }
  return win;
}

function createWindow() {
  const isDark = nativeTheme.shouldUseDarkColors;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "asHub",
    backgroundColor: isDark ? "#18181c" : "#fafaf7",
    // hiddenInset: traffic-light buttons overlay content; titleBarOverlay
    // lets us style the native toolbar background through CSS.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    titleBarOverlay: process.platform === "darwin" ? {
      color: isDark ? "#18181c" : "#fafaf7",
      symbolColor: isDark ? "#e8e8ec" : "#1d1d22",
    } : undefined,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  trackWindow(mainWindow);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${HUB_PORT}/`);

  // Inject traffic-light safe area on macOS hiddenInset windows
  if (process.platform === "darwin") {
    mainWindow.webContents.on("did-finish-load", () => {
      mainWindow.webContents.executeJavaScript(
        `document.querySelector('.title-bar').style.paddingLeft = '80px'`
      ).catch(() => {});
    });
  }

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
}

const { autoUpdater } = require("electron-updater");

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: console.log };

  autoUpdater.on("update-available", (info) => {
    console.log("[updater] update available:", info.version);
    if (mainWindow) {
      mainWindow.webContents.send("update-available", info.version);
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "发现新版本",
        message: `asHub ${info.version} 已发布`,
        detail: "是否立即下载更新？",
        buttons: ["下载更新", "稍后提醒"],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          autoUpdater.downloadUpdate();
        }
      });
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    if (mainWindow) {
      mainWindow.setProgressBar(progress.percent / 100);
    }
  });

  autoUpdater.on("update-downloaded", () => {
    if (mainWindow) {
      mainWindow.setProgressBar(-1);
      dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "更新已就绪",
        message: "新版本已下载完成，重启应用即可安装。",
        detail: "是否立即重启？",
        buttons: ["立即重启", "稍后"],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
    }
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[updater] 当前已是最新版本");
  });

	autoUpdater.on("error", (err) => {
	    console.error("[updater] error:", err.message);
	    // If mirror fails, silently fall back to GitHub and retry
	    if (!mirrorFailed && MIRROR_URL) {
	      fallbackToGitHub();
	      return;
	    }
	    dialog.showErrorBox(
	      "更新检测失败",
	      `无法检查更新：\n\n${err.message}`
	    );
	  });
}

function setupIPC() {
  ipcMain.handle("pick-directory", async () => {
    if (!mainWindow) return { cancelled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "Select working directory",
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { cancelled: true };
    }
    return { cwd: result.filePaths[0] };
  });

  ipcMain.handle("check-for-update", async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { updateAvailable: !!result?.updateInfo, version: result?.updateInfo?.version };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle("open-session-window", (_event, sessionId, screenPos) => {
    if (typeof sessionId !== "string" || !/^[0-9a-f]{4,32}$/i.test(sessionId)) {
      return { ok: false };
    }
    createTearOutWindow(`/${sessionId}/`, screenPos);
    return { ok: true };
  });

  const isValidSessionId = (s) => typeof s === "string" && /^[0-9a-f]{4,32}$/i.test(s);
  let dragHoverWin = null;
  let dragPoll = null;
  let dragSender = null;
  let dragLabel = "";
  let lastSentX = NaN, lastSentY = NaN;
  const findWinAt = (sender, x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const w of windowZOrder) {
      try {
        if (!w || w.isDestroyed() || w.webContents === sender) continue;
        if (!w.isVisible() || w.isMinimized()) continue;
        const b = w.getBounds();
        if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) return w;
      } catch { /* destroyed mid-iteration */ }
    }
    return null;
  };
  const sendHover = (win, payload) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send("tab-drag-hover", payload);
  };
  const stopDragPoll = () => {
    if (dragPoll) { clearInterval(dragPoll); dragPoll = null; }
    if (dragHoverWin) { sendHover(dragHoverWin, { hovering: false }); dragHoverWin = null; }
    dragSender = null;
    lastSentX = lastSentY = NaN;
  };
  ipcMain.on("tab-drag-update", (event, payload, phase) => {
    if (phase === "end") { stopDragPoll(); dragLabel = ""; return; }
    if (phase === "start") {
      stopDragPoll();
      dragSender = event.sender;
      dragLabel = typeof payload?.label === "string" ? payload.label : "";
      dragPoll = setInterval(() => {
        try {
          const pt = screen.getCursorScreenPoint();
          const target = findWinAt(dragSender, pt.x, pt.y);
          if (target !== dragHoverWin) {
            if (dragHoverWin) sendHover(dragHoverWin, { hovering: false });
            dragHoverWin = target;
            lastSentX = lastSentY = NaN;
          }
          if (target && (pt.x !== lastSentX || pt.y !== lastSentY)) {
            sendHover(target, { hovering: true, screenPos: pt, label: dragLabel });
            lastSentX = pt.x; lastSentY = pt.y;
          }
        } catch (err) {
          console.error("[tab-drag poll]", err);
          stopDragPoll();
        }
      }, 50);
    }
  });

  ipcMain.handle("move-tab-to-window-at", (event, sessionId) => {
    if (!isValidSessionId(sessionId)) return { ok: false, moved: false };
    const pt = screen.getCursorScreenPoint();
    const target = findWinAt(event.sender, pt.x, pt.y);
    if (!target) return { ok: true, moved: false };
    target.webContents.send("accept-tab", sessionId);
    target.focus();
    return { ok: true, moved: true };
  });

  ipcMain.handle("open-external", async (_event, url) => {
    // Block dangerous protocols, allow everything else (http, https, mailto, etc.)
    const BLOCKED = new Set(["javascript:", "file:", "data:", "vbscript:"]);
    try {
      const parsed = new URL(url);
      if (!BLOCKED.has(parsed.protocol)) {
        await shell.openExternal(url);
      }
    } catch {
      // Invalid URL — ignore
    }
  });

  // Sync native title bar with web UI theme changes
  ipcMain.on("theme-changed", (_event, theme) => {
    if (mainWindow) {
      const isDark = theme === "dark";
      mainWindow.setBackgroundColor(isDark ? "#18181c" : "#fafaf7");
      if (process.platform === "darwin") {
        try {
          if (typeof mainWindow.setTitleBarOverlay === "function") {
            mainWindow.setTitleBarOverlay({
              color: isDark ? "#18181c" : "#fafaf7",
              symbolColor: isDark ? "#e8e8ec" : "#1d1d22",
            });
          }
        } catch {}
      }
    }
  });
}

async function startServer() {
  const webRoot = resolveWebRoot();
  const distRoot = path.join(__dirname, "..", "dist");

  let startHub, AshBridge, TerminalBridge;
  try {
    const hubMod = await import(pathToFileURL(path.join(distRoot, "hub.js")).href);
    startHub = hubMod.startHub;
    shutdownHub = hubMod.shutdownHub;
    ({ AshBridge } = await import(pathToFileURL(path.join(distRoot, "bridges", "ash.js")).href));
    ({ TerminalBridge } = await import(pathToFileURL(path.join(distRoot, "bridges", "terminal.js")).href));
  } catch (err) {
    console.error("[electron] failed to import dist modules:", err);
    dialog.showErrorBox(
      "Startup Error",
      `Failed to load application modules:\n\n${err.message}\n\nDist path: ${distRoot}`
    );
    app.quit();
    return;
  }

  let server;
  try {
    server = startHub({
      port: HUB_PORT,
      host: "127.0.0.1",
      webRoot,
      makeBridge: (opts) => opts.kind === "terminal" ? new TerminalBridge(opts) : new AshBridge(opts),
    });
  } catch (err) {
    console.error("[electron] failed to start hub:", err);
    dialog.showErrorBox(
      "Startup Error",
      `Failed to start hub server:\n\n${err.message}`
    );
    app.quit();
    return;
  }

  server.on("error", (err) => {
    console.error("[electron] hub server error:", err);
    dialog.showErrorBox(
      "Server Error",
      `Hub server encountered an error:\n\n${err.message}`
    );
    app.quit();
  });

  server.on("listening", () => {
    createWindow();
  });

  const fallbackTimeout = setTimeout(() => {
    if (!mainWindow) {
      console.warn("[electron] listening event not received after 10s, creating window anyway");
      createWindow();
    }
  }, 10000);

  mainWindow = null;
  const origCreate = createWindow;
  createWindow = function () {
    clearTimeout(fallbackTimeout);
    origCreate();
  };
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Custom menu omits Cmd+W so the renderer can intercept it for tab close.
    const isMac = process.platform === "darwin";
    const template = [
      ...(isMac ? [{ role: "appMenu" }] : []),
      { role: "editMenu" },
      { role: "viewMenu" },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          ...(isMac ? [{ type: "separator" }, { role: "front" }] : []),
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    setupIPC();
    startServer();

    // Sync window background with system theme
    nativeTheme.on("updated", () => {
      if (mainWindow) {
        const isDark = nativeTheme.shouldUseDarkColors;
        mainWindow.setBackgroundColor(isDark ? "#18181c" : "#fafaf7");
        if (process.platform === "darwin") {
          try {
            if (typeof mainWindow.setTitleBarOverlay === "function") {
              mainWindow.setTitleBarOverlay({
                color: isDark ? "#18181c" : "#fafaf7",
                symbolColor: isDark ? "#e8e8ec" : "#1d1d22",
              });
            }
          } catch {}
        }
      }
    });

    if (!isDev) {
      setupAutoUpdater();
      setupMirrorFeed();
      autoUpdater.checkForUpdates().catch((err) => {
        console.error("[updater] initial check failed:", err.message);
      });
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (mainWindow) mainWindow.removeAllListeners("closed");
    if (_shuttingDown || !shutdownHub) return;
    _shuttingDown = true;
    event.preventDefault();
    Promise.resolve()
      .then(() => shutdownHub())
      .catch((err) => console.error("[electron] shutdownHub failed:", err))
      .finally(() => app.exit(0));
  });
}
