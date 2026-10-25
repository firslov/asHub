const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { createBackgroundController, isTrustedDesktopEvent } = require('../electron/background.cjs');
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-background-'));
  const windows = [], trays = [], blocks = new Set();
  const state = { quitting: false, remote: {}, quit: 0, mobile: 0, notices: 0, errors: 0, trayFails: false, changes: [] };
  const app = { getPath: () => dir, getLocale: () => 'zh-CN', quit: () => { state.quitting = true; state.quit++; } };
  function window() {
    const win = new EventEmitter(); win.visible = true; win.destroyed = false;
    win.isVisible = () => win.visible; win.isDestroyed = () => win.destroyed;
    win.hide = () => { win.visible = false; }; win.show = () => { win.visible = true; };
    win.close = () => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; win.emit('close', e); if (!e.prevented) { win.destroyed = true; win.visible = false; } return e.prevented; };
    windows.push(win); return win;
  }
  class Tray extends EventEmitter {
    constructor() { super(); if (state.trayFails) throw Error('no tray'); trays.push(this); }
    setToolTip(s) { this.tooltip = s; } setContextMenu(menu) { this.menu = menu; } destroy() { this.destroyed = true; }
  }
  const args = { app, Tray, Menu: { buildFromTemplate: v => v },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage() {} }) },
    dialog: { showMessageBox: async () => { state.notices++; }, showErrorBox: () => state.errors++ },
    powerSaveBlocker: { start: type => { assert.equal(type, 'prevent-app-suspension'); blocks.add(1); return 1; }, stop: id => blocks.delete(id) },
    getWindows: () => windows, showWindow: () => windows[0]?.show(), openMobile: () => state.mobile++,
    getRemoteStatus: () => state.remote, isQuitting: () => state.quitting,
    onChange: s => state.changes.push(s), ...options };
  const controller = createBackgroundController(args);
  t.after(() => { controller.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { controller, args, dir, window, state, trays, blocks };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('default close exits normally; opting in hides without destroying; quitting bypasses hiding', async t => {
  const f = fixture(t); f.controller.start();
  assert.deepEqual(f.controller.snapshot(), { enabled: false, preventSleep: false });
  let win = f.window(); f.controller.trackWindow(win);
  assert.equal(win.close(), false); assert.equal(win.destroyed, true);
  win = f.window(); f.controller.trackWindow(win);
  assert.equal(f.controller.update({ enabled: true }).ok, true);
  assert.equal(win.close(), true); await settle();
  assert.equal(win.destroyed, false); assert.equal(win.visible, false); assert.equal(f.state.notices, 1);
  win.show(); win.close(); await settle(); assert.equal(f.state.notices, 1);
  f.state.quitting = true; assert.equal(win.close(), false); assert.equal(win.destroyed, true);
});

test('tray restores every detached window; mobile action and quit are explicit', async t => {
  const f = fixture(t); const first = f.window(), second = f.window();
  for (const win of [first, second]) f.controller.trackWindow(win);
  f.controller.update({ enabled: true }); first.close(); await settle(); second.close();
  f.trays[0].menu[0].click(); assert.equal(first.visible, true); assert.equal(second.visible, true);
  f.trays[0].menu[3].click(); assert.equal(f.state.mobile, 1);
  f.trays[0].menu[5].click(); assert.equal(first.close(), false); assert.equal(second.close(), false);
});

test('preferences persist; disabling background reveals hidden windows and stops keeping awake', async t => {
  const f = fixture(t); const win = f.window(); f.controller.trackWindow(win);
  f.state.remote = { enabled: true, status: 'online' };
  f.controller.update({ enabled: true, preventSleep: true }); win.close(); await settle();
  assert.equal(f.blocks.size, 1);
  const restarted = createBackgroundController(f.args);
  assert.deepEqual(restarted.snapshot(), { enabled: true, preventSleep: true }); restarted.dispose();
  f.controller.update({ enabled: false });
  assert.equal(win.visible, true); assert.equal(f.blocks.size, 0); assert.equal(f.trays[0].destroyed, true);
});

test('remote status is localized; sleep prevention requires opt-in and paired remote access', t => {
  const f = fixture(t); f.controller.update({ enabled: true });
  assert.match(f.trays[0].tooltip, /未开启/); assert.equal(f.blocks.size, 0);
  f.state.remote = { enabled: true, status: 'online' }; f.controller.refresh(); assert.equal(f.blocks.size, 0);
  f.controller.update({ preventSleep: true, language: 'en' }); assert.equal(f.blocks.size, 1);
  assert.match(f.trays[0].tooltip, /connected/);
  f.state.remote.status = 'connecting'; f.controller.refresh(); assert.match(f.trays[0].tooltip, /connecting/);
  f.state.remote.status = 'revoked'; f.controller.refresh(); assert.equal(f.blocks.size, 0);
  f.state.remote.status = 'connecting'; f.controller.refresh(); assert.equal(f.blocks.size, 1);
  f.state.remote.enabled = false; f.controller.refresh(); assert.equal(f.blocks.size, 0);
});

test('tray or persistence failures cannot strand an invisible window', t => {
  const f = fixture(t); const win = f.window(); f.controller.trackWindow(win);
  f.state.trayFails = true;
  assert.equal(f.controller.update({ enabled: true }).ok, false); assert.equal(f.controller.shouldHide(), false);
  f.state.trayFails = false;
  fs.mkdirSync(path.join(f.dir, 'background.json'));
  assert.equal(f.controller.update({ enabled: true }).ok, false); assert.equal(f.controller.shouldHide(), false);
  assert.equal(f.trays[0].destroyed, true); assert.equal(win.visible, true);
});

test('unavailable tray after relaunch keeps startup window accessible', t => {
  const f = fixture(t); f.controller.update({ enabled: true }); f.controller.dispose();
  f.state.trayFails = true;
  const next = createBackgroundController(f.args); next.start();
  assert.equal(next.shouldHide(), false); assert.equal(next.snapshot().enabled, false); assert.equal(f.state.errors, 1);
  next.dispose();
});

test('first-close notice resolving after disabling or quitting does not hide the window', async t => {
  let resolve; const dialog = { showMessageBox: () => new Promise(r => resolve = r) };
  const f = fixture(t, { dialog }); const win = f.window(); f.controller.trackWindow(win);
  f.controller.update({ enabled: true }); win.close();
  f.controller.update({ enabled: false }); resolve(); await settle(); assert.equal(win.visible, true);
});

test('only a local top-level desktop frame may change lifecycle preferences', () => {
  const frame = { url: 'http://127.0.0.1:7878/' }, sender = { mainFrame: frame };
  const BrowserWindow = { fromWebContents: w => w === sender ? { isDestroyed: () => false } : null };
  const trusted = event => isTrustedDesktopEvent(event, BrowserWindow, 'http://127.0.0.1:7878');
  assert.equal(trusted({ sender, senderFrame: frame }), true);
  assert.equal(trusted({ sender, senderFrame: { url: frame.url } }), false);
  frame.url = 'https://example.com/'; assert.equal(trusted({ sender, senderFrame: frame }), false);
  frame.url = 'http://127.0.0.1:7879/'; assert.equal(trusted({ sender, senderFrame: frame }), false);
  assert.equal(trusted({}), false);
});

test('main process marks explicit quits before windows close and awaits Hub shutdown once', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const block = source.slice(source.indexOf('  app.on("before-quit"'), source.lastIndexOf('\n}'));
  let count = 0, quits = 0; const app = new EventEmitter(); app.quit = () => quits++;
  const context = { app, mainWindow: null, _shuttingDown: false, shutdownHubRef: () => {}, prepareShutdown: async () => { count++; }, console };
  vm.runInNewContext(block, context);
  const event = { preventDefault() { this.prevented = true; } };
  app.emit('before-quit', event); assert.equal(context._shuttingDown, true); assert.equal(event.prevented, true);
  await settle(); assert.equal(count, 1); assert.equal(quits, 1);
  app.emit('before-quit', { preventDefault() { assert.fail('second quit must proceed'); } });
  assert.equal(count, 1);
  context._shuttingDown = false; context.shutdownHubRef = null;
  app.emit('before-quit', {}); assert.equal(context._shuttingDown, true);
});

test('installer bypass is active before quitAndInstall and is cleared on failed install', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const block = source.slice(source.indexOf('  ipcMain.handle("quit-and-install"'), source.indexOf('  // Manual-install helper'));
  let handler, restarts = 0;
  const app = new EventEmitter();
  const context = { ipcMain: { handle: (_, f) => handler = f }, app, hasDownloadedUpdate: () => true, isAdhocSigned: false,
    prepareShutdown: async () => {}, _installOnQuit: false, restartHubRef: () => restarts++,
    autoUpdater: { quitAndInstall: () => { assert.equal(context._installOnQuit, true); } }, console: { log() {}, error() {} }, setTimeout: cb => cb() };
  vm.runInNewContext(block, context); const result = await handler();
  assert.equal(result.ok, false); assert.equal(context._installOnQuit, false); assert.equal(restarts, 1);
});

for (const [platform, asset] of [['darwin', 'trayTemplate.png'], ['win32', 'tray.ico'], ['linux', 'tray.png']]) {
  test(`${platform} uses its packaged tray asset`, t => {
    let selected, template = false;
    const f = fixture(t, { platform, nativeImage: { createFromPath: file => {
      selected = file;
      return { isEmpty: () => !fs.existsSync(file), setTemplateImage: value => { template = value; } };
    } } });
    assert.equal(f.controller.update({ enabled: true }).ok, true);
    assert.equal(path.basename(selected), asset);
    assert.equal(template, platform === 'darwin');
  });
}

test('language sync and dormant preferences never reveal hidden windows', t => {
  let restored = 0;
  const f = fixture(t, { showWindow: () => restored++ });
  const win = f.window(); win.hide();
  assert.equal(f.controller.update({ language: 'en' }).ok, true);
  assert.equal(win.visible, false, 'boot-time language sync must not bypass ready-to-show');
  f.controller.update({ preventSleep: true });
  f.controller.update({ enabled: false });
  assert.equal(win.visible, false); assert.equal(restored, 0);
  f.controller.update({ enabled: true });
  f.controller.update({ language: 'zh' });
  assert.equal(win.visible, false);
  f.controller.update({ enabled: false });
  assert.equal(win.visible, true, 'explicitly leaving background mode still recovers windows');
  assert.equal(restored, 1);
});

test('tray starts after the local Hub listens, including when the fallback window exists', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const readyBlock = source.slice(source.indexOf('  app.whenReady().then'), source.indexOf('  app.on("window-all-closed"'));
  const listenBlock = source.slice(source.indexOf('  server.on("listening", () => {\n    // The 10s fallback'), source.indexOf('  const fallbackTimeout'));
  for (const hasWindow of [false, true]) {
    const calls = [], app = new EventEmitter(), server = new EventEmitter();
    app.whenReady = () => ({ then: fn => fn() });
    const context = {
      app, server, process: { platform: 'darwin' }, isDev: true,
      Menu: { buildFromTemplate: () => [], setApplicationMenu() {} },
      Tray: {}, nativeImage: {}, dialog: {}, powerSaveBlocker: {},
      BrowserWindow: { getAllWindows: () => [] },
      createBackgroundController: () => ({ start: () => calls.push('tray'), dispose() {} }),
      background: null, showMainWindow() {}, openMobileAccess() {}, remoteStatusRef() {},
      setupIPC() {}, startServer: () => calls.push('starting-server'),
      nativeTheme: { on() {} }, powerMonitor: { on() {} },
      mainWindow: hasWindow ? {} : null, createWindow: () => calls.push('window'),
    };
    vm.runInNewContext(readyBlock, context);
    assert.deepEqual(calls, ['starting-server'], 'tray must not expose links before imports and server startup complete');
    vm.runInNewContext(listenBlock, context); server.emit('listening');
    assert.deepEqual(calls, hasWindow ? ['starting-server', 'tray'] : ['starting-server', 'tray', 'window']);
  }
});

test('temporary tray failure does not erase the saved background preference during language sync', t => {
  const f = fixture(t);
  f.controller.update({ enabled: true, preventSleep: true }); f.controller.dispose();
  f.state.trayFails = true; f.state.remote = { enabled: true, status: 'online' };
  const next = createBackgroundController(f.args); t.after(() => next.dispose()); next.start();
  assert.equal(next.snapshot().enabled, false); assert.equal(f.blocks.size, 0);
  assert.equal(next.update({ language: 'en' }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'background.json'))).enabled, true,
    'an automatic language update must not permanently disable an opted-in background mode');
  assert.equal(next.shouldHide(), false); assert.equal(f.blocks.size, 0);
  next.dispose(); f.state.trayFails = false;
  const recovered = createBackgroundController(f.args); t.after(() => recovered.dispose()); recovered.start();
  assert.equal(recovered.snapshot().enabled, true); assert.equal(recovered.shouldHide(), true);
  assert.equal(f.blocks.size, 1);
});

test('after tray failure, explicit retry enables the tray and explicit disable remains saved', t => {
  const f = fixture(t); f.controller.update({ enabled: true, preventSleep: true }); f.controller.dispose();
  f.state.trayFails = true; f.state.remote = { enabled: true, status: 'online' };
  const next = createBackgroundController(f.args); t.after(() => next.dispose()); next.start();
  assert.equal(next.update({ enabled: true }).ok, false);
  assert.equal(next.snapshot().enabled, false); assert.equal(f.blocks.size, 0);
  f.state.trayFails = false;
  assert.equal(next.update({ enabled: true }).ok, true);
  assert.equal(next.shouldHide(), true); assert.equal(f.blocks.size, 1);
  next.dispose(); f.state.trayFails = true;
  const fallback = createBackgroundController(f.args); t.after(() => fallback.dispose()); fallback.start();
  assert.equal(fallback.update({ enabled: false }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'background.json'))).enabled, false);
  assert.equal(fallback.shouldHide(), false); assert.equal(f.blocks.size, 0);
});

test('closing multiple windows while the first background notice is open preserves every close request', async t => {
  let acknowledge, notices = 0;
  const f = fixture(t, { dialog: { showMessageBox: () => { notices++; return new Promise(resolve => acknowledge = resolve); } } });
  const first = f.window(), second = f.window(), untouched = f.window();
  for (const win of [first, second, untouched]) f.controller.trackWindow(win);
  f.controller.update({ enabled: true });
  assert.equal(first.close(), true); assert.equal(second.close(), true);
  assert.equal(notices, 1);
  acknowledge(); await settle();
  assert.equal(first.visible, false);
  assert.equal(second.visible, false, 'second close must not be swallowed while the notice is pending');
  assert.equal(untouched.visible, true, 'windows the user did not close must stay visible');
  assert.equal(first.destroyed, false); assert.equal(second.destroyed, false);
});

for (const action of ['disable-and-enable', 'dispose', 'destroy-first', 'dialog-failure']) {
  test(`queued background closes handle ${action} without hiding unrelated windows`, async t => {
    let acknowledge, reject;
    const f = fixture(t, { dialog: { showMessageBox: () => new Promise((resolve, fail) => { acknowledge = resolve; reject = fail; }) } });
    const first = f.window(), second = f.window();
    for (const win of [first, second]) f.controller.trackWindow(win);
    f.controller.update({ enabled: true }); first.close(); second.close();
    if (action === 'disable-and-enable') { f.controller.update({ enabled: false }); f.controller.update({ enabled: true }); }
    if (action === 'dispose') f.controller.dispose();
    if (action === 'destroy-first') first.destroyed = true;
    if (action === 'dialog-failure') reject(Error('dialog unavailable')); else acknowledge();
    await settle();
    assert.equal(second.visible, action !== 'destroy-first');
    if (action === 'dialog-failure') {
      second.close(); acknowledge(); await settle();
      assert.equal(second.visible, false); assert.equal(first.visible, true, 'a failed notice must clear its old close requests');
    }
  });
}

test('desktop readiness survives in-page and child-frame navigation but resets on full main-frame navigation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  const block = source.slice(source.indexOf('function trackWindow(win)'), source.indexOf('function resolveWebRoot()'));
  const win = new EventEmitter(); win.webContents = new EventEmitter();
  const ready = new WeakSet([win.webContents]);
  const context = { background: { trackWindow() {} }, desktopReady: ready, windowZOrder: [] };
  vm.runInNewContext(block + '; globalThis.track = trackWindow;', context); context.track(win);
  win.webContents.emit('did-start-navigation', {}, 'http://127.0.0.1:7878/abcdef/', true, true);
  assert.equal(ready.has(win.webContents), true, 'pushState/popstate keeps the renderer and its listeners');
  win.webContents.emit('did-start-navigation', {}, 'http://127.0.0.1:7878/frame', false, false);
  assert.equal(ready.has(win.webContents), true, 'child-frame loading does not replace the desktop renderer');
  win.webContents.emit('did-start-navigation', {}, 'http://127.0.0.1:7878/', false, true);
  assert.equal(ready.has(win.webContents), false, 'a fresh page must register its desktop listeners again');
});
