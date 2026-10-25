const fs = require('node:fs');
const path = require('node:path');

// Desktop-only preferences and lifecycle. No renderer is needed to keep the Hub alive.
function createBackgroundController({ app, Tray, Menu, nativeImage, dialog, powerSaveBlocker,
  getWindows, showWindow, openMobile, getRemoteStatus, isQuitting, onChange = () => {},
  platform = process.platform, preferencesPath = path.join(app.getPath('userData'), 'background.json'),
}) {
  let settings = { enabled: false, preventSleep: false, language: app.getLocale().startsWith('zh') ? 'zh' : 'en', notified: false };
  try {
    const saved = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
    for (const key of ['enabled', 'preventSleep', 'notified']) if (typeof saved[key] === 'boolean') settings[key] = saved[key];
    if (saved.language === 'zh' || saved.language === 'en') settings.language = saved.language;
  } catch {}
  let tray = null, timer = null, blocker = null, menuKey = '', noticePending = false, disposed = false;
  const pendingCloseWindows = new Set();
  const text = (zh, en) => settings.language === 'zh' ? zh : en;
  // Runtime fallback must not overwrite the user's persisted opt-in.
  let trayUnavailable = false;
  const snapshot = () => ({ enabled: settings.enabled && !trayUnavailable, preventSleep: settings.preventSleep });
  function save(next) {
    fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
    const tmp = `${preferencesPath}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(tmp, preferencesPath);
    } catch (error) { try { fs.unlinkSync(tmp); } catch {} throw error; }
  }
  function restoreWindows() {
    for (const win of getWindows()) {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    }
    showWindow();
  }
  function stopBlocker() {
    if (blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
  }
  function refresh() {
    if (disposed) return;
    let remote = {};
    try { remote = getRemoteStatus() || {}; } catch {}
    // A display may sleep; the machine must stay awake only with explicit opt-in
    // and an enabled, paired remote connector (including while reconnecting).
    const awake = snapshot().enabled && settings.preventSleep && remote.enabled
      && ['online', 'connecting'].includes(remote.status) && !isQuitting();
    if (awake && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    else if (!awake) stopBlocker();
    if (!tray) return;
    const status = !remote.enabled ? text('远控未开启', 'Remote access off')
      : remote.status === 'online' ? text('远控已连接', 'Remote connected')
      : remote.status === 'connecting' ? text('远控正在连接', 'Remote connecting')
      : text('远控未连接', 'Remote disconnected');
    const key = `${settings.language}:${status}`;
    if (key === menuKey) return;
    tray.setToolTip(`asHub · ${status}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: text('打开 asHub', 'Open asHub'), click: restoreWindows },
      { type: 'separator' },
      { label: status, enabled: false },
      { label: text('移动访问', 'Mobile access'), click: () => { restoreWindows(); openMobile(); } },
      { type: 'separator' },
      { label: text('退出 asHub', 'Quit asHub'), click: () => app.quit() },
    ]));
    menuKey = key;
  }
  function createTray() {
    if (tray) return;
    const file = platform === 'darwin' ? 'trayTemplate.png' : platform === 'win32' ? 'tray.ico' : 'tray.png';
    const icon = nativeImage.createFromPath(path.join(__dirname, file));
    if (icon.isEmpty()) throw new Error('Tray icon unavailable');
    if (platform === 'darwin') icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.on('click', restoreWindows);
    menuKey = '';
    refresh();
  }
  function destroyTray() {
    if (tray) tray.destroy();
    tray = null; menuKey = '';
  }
  function update(patch) {
    if (disposed) return { ok: false, ...snapshot() };
    const next = { ...settings };
    for (const key of ['enabled', 'preventSleep']) if (typeof patch?.[key] === 'boolean') next[key] = patch[key];
    if (patch?.language === 'zh' || patch?.language === 'en') next.language = patch.language;
    const hadTray = !!tray;
    const retryTray = patch?.enabled === true;
    try {
      if (next.enabled && (!trayUnavailable || retryTray)) createTray(); // Never hide a window without a working tray.
      save(next);
    } catch {
      if (!hadTray) destroyTray();
      return { ok: false, ...snapshot() };
    }
    const disabling = settings.enabled && !next.enabled;
    settings = next;
    if (!settings.enabled || retryTray) trayUnavailable = false;
    if (!settings.enabled) {
      pendingCloseWindows.clear();
      destroyTray();
      if (disabling && getWindows().some(win => !win.isDestroyed() && !win.isVisible())) restoreWindows();
    }
    refresh();
    onChange(snapshot());
    return { ok: true, ...snapshot() };
  }
  function shouldHide() { return !disposed && settings.enabled && !!tray && !isQuitting(); }
  function trackWindow(win) {
    win.on('close', event => {
      if (!shouldHide()) return;
      event.preventDefault();
      if (settings.notified) { win.hide(); return; }
      pendingCloseWindows.add(win);
      if (noticePending) return;
      noticePending = true;
      dialog.showMessageBox(win, { type: 'info', title: 'asHub',
        message: text('asHub 将继续在后台运行', 'asHub will keep running in the background'),
        detail: text('可从状态栏图标重新打开窗口或退出应用。远控需要电脑保持联网且不休眠。',
          'Use the tray icon to reopen or quit asHub. Remote access requires the computer to stay online and awake.')
          + (platform === 'linux' ? text('\n若桌面不显示托盘图标，重新启动 asHub 即可找回窗口，也可在设置中关闭后台运行。',
            '\nIf your desktop hides tray icons, launch asHub again to restore the window. Background mode can be disabled in Settings.') : ''),
        buttons: [text('知道了', 'Got it')], noLink: true,
      }).then(() => {
        const next = { ...settings, notified: true };
        try { save(next); settings = next; } catch { /* Retry the notice next time. */ }
        if (shouldHide()) {
          for (const pending of pendingCloseWindows) if (!pending.isDestroyed()) pending.hide();
        }
      }).catch(() => {}).finally(() => { pendingCloseWindows.clear(); noticePending = false; });
    });
  }
  function start() {
    if (settings.enabled) {
      try { createTray(); }
      catch {
        destroyTray(); trayUnavailable = true;
        dialog.showErrorBox('asHub', text('无法创建状态栏图标，本次启动已关闭后台运行', 'Could not create a tray icon. Background mode is off for this launch.'));
      }
    }
    refresh();
    timer = setInterval(refresh, 5000);
    timer.unref?.();
  }
  function dispose() { disposed = true; pendingCloseWindows.clear(); clearInterval(timer); destroyTray(); stopBlocker(); }
  return { start, update, snapshot, trackWindow, shouldHide, refresh, dispose };
}

function isTrustedDesktopEvent(event, BrowserWindow, origin) {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    return !!win && !win.isDestroyed() && event.senderFrame === event.sender.mainFrame
      && new URL(event.senderFrame.url).origin === origin;
  } catch { return false; }
}
module.exports = { createBackgroundController, isTrustedDesktopEvent };
