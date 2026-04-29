const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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
let mainWindow = null;

function resolveWebRoot() {
  if (isDev) {
    return path.join(__dirname, "..", "web");
  }
  return path.join(process.resourcesPath, "web");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Agent SH Hub",
    backgroundColor: "#0a0a0a",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`http://127.0.0.1:${HUB_PORT}/`);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
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
}

async function startServer() {
  const webRoot = resolveWebRoot();
  const distRoot = path.join(__dirname, "..", "dist");

  let startHub, AshBridge;
  try {
    ({ startHub } = await import(pathToFileURL(path.join(distRoot, "hub.js")).href));
    ({ AshBridge } = await import(pathToFileURL(path.join(distRoot, "bridges", "ash.js")).href));
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
      makeBridge: (opts) => new AshBridge(opts),
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
    setupIPC();
    startServer();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    if (mainWindow) mainWindow.removeAllListeners("closed");
  });
}
