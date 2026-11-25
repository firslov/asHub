// Real Electron windows, preload, tray and renderer; remote RPC/SSE uses a local
// fixture Hub and the production connector. Never reads user sessions or tokens.
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { createBackgroundController, isTrustedDesktopEvent } = require('../electron/background.cjs');
const root = path.resolve(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-background-ui-'));
app.setPath('userData', path.join(tmp, 'profile')); process.env.NODE_ENV = 'test';
const watchdog = setTimeout(() => app.exit(1), 45000);
const wait = async fn => { for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('Condition timed out'); };
app.whenReady().then(async () => {
  let win, detached, acknowledgeNotice, controller, lifecycle, local, connector, stream, streaming, quitting = false;
  let submissions = 0, notices = 0, ready = false;
  let trayActions, target = { plugin: 'chosen-sharing', resource: 'settings' };
  let previousPublisher = false, migrationEnabled = true, addedPublisher = false;
  let pendingCatalogs, enablePublisher, publisherEnabled = true;
  const panel = (id, title) => ({ id, title, components: [{ type: 'resource', id }] });
  const feature = (pluginId, panels, enabled = true) => ({ id: `plugin-${pluginId}`, pluginId, name: pluginId, scope: 'application',
    state: enabled ? 'active' : 'inactive', enabled, capabilities: ['shared-conversations'], ui: { version: 1, panels } });
  try {
    local = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const json = v => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
      if (url.pathname === '/sessions') return json([{ instanceId: 'abcdef', kind: 'agent', cwd: fs.realpathSync(tmp) }]);
      if (url.pathname === '/abcdef/submit') { submissions++; let body = ''; for await (const chunk of req) body += chunk; return json({ accepted: JSON.parse(body).query }); }
      if (url.pathname === '/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); stream = res; return; }
      if (url.pathname === '/api/mobile') return json(connector.status());
      const features = () => ({ version: 1, features: [
        feature('other-sharing', [panel('settings', 'Other publisher')]),
        feature('chosen-sharing', previousPublisher ? [panel('settings', 'Chosen publisher')] : [panel('summary', 'Other panel'), panel('settings', 'Chosen publisher')]),
        { id: 'mobile-access', name: '移动访问', description: '设备互联迁移尚未完成。', scope: 'application',
          enabled: migrationEnabled, state: migrationEnabled ? 'active' : 'inactive' },
        ...(addedPublisher ? [feature('new-sharing', [panel('settings', 'New publisher')], publisherEnabled)] : []),
      ] });
      if (url.pathname === '/api/extensions') {
        if (pendingCatalogs) { pendingCatalogs.push(() => json(features())); return; }
        return json(features());
      }
      if (url.pathname === '/api/extensions/mobile-access/enabled' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) body += chunk;
        migrationEnabled = JSON.parse(body).enabled; return json(features());
      }
      if (url.pathname === '/api/extensions/plugin-new-sharing/enabled' && req.method === 'POST') {
        publisherEnabled = true;
        enablePublisher = () => json(features());
        return;
      }
      if (url.pathname.startsWith('/api/plugin-resources/')) return json({ view: { actions: [], rows: [] } });
      const file = path.join(root, 'web', url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(path.join(root, 'web') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
      let content = fs.readFileSync(file);
      if (file.endsWith('.html')) content = content.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
        .replace('</body>', `<script type="module">
          import '/js/background-settings.js';
          import '/js/plugins-panel.js';
          import { initializeFeatureUI } from '/js/extensions/feature-ui.js';
          initializeFeatureUI();
        </script></body>`);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(content);
    });
    local.listen(0, '127.0.0.1'); await once(local, 'listening');
    const base = `http://127.0.0.1:${local.address().port}`;
    const { RemoteConnector } = await import('../dist/remote/connector.js');
    connector = new RemoteConnector({ gateway: base, dataDir: tmp });
    connector.config = { deviceId: 'fixture', deviceToken: 'fixture', username: 'fixture', deviceName: 'Fixture', roots: [fs.realpathSync(tmp)] };
    connector.localUrl = base; connector.statusText = 'online';
    controller = createBackgroundController({ ...electron,
      Menu: { buildFromTemplate: template => { trayActions = template; return electron.Menu.buildFromTemplate(template); } },
      dialog: { showMessageBox: () => { notices++; return new Promise(resolve => { acknowledgeNotice = resolve; }); }, showErrorBox: (...args) => { throw Error(args.join(' ')); } },
      getWindows: () => [win, detached].filter(w => w && !w.isDestroyed()), showWindow: () => { win.show(); win.focus(); },
      openMobile: () => lifecycle.openMobileAccess(), getRemoteStatus: () => connector.status(), isQuitting: () => quitting,
      onChange: value => win.webContents.send('desktop:background:changed', value),
    });
    controller.start();
    // Exercise the real main-process navigation and tray routing, not a direct send.
    const mainSource = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
    lifecycle = vm.createContext({ background: controller, desktopReady: new WeakSet(), pendingPlugin: new WeakMap(),
      remoteSettingsTargetRef: () => target,
      windowZOrder: [], mainWindow: null, createWindow: () => assert.fail('must reuse the existing window') });
    vm.runInContext(mainSource.slice(mainSource.indexOf('function showMainWindow()'), mainSource.indexOf('// ── Update install capability'))
      + mainSource.slice(mainSource.indexOf('function trackWindow(win)'), mainSource.indexOf('function resolveWebRoot()')), lifecycle);
    const trust = e => { assert(isTrustedDesktopEvent(e, BrowserWindow, base)); };
    ipcMain.handle('desktop:background:get', e => { trust(e); return controller.snapshot(); });
    ipcMain.handle('desktop:background:set', (e, patch) => { trust(e); return controller.update(patch); });
    ipcMain.on('desktop:ready', e => {
      trust(e); ready = true; lifecycle.desktopReady.add(e.sender);
      const pending = lifecycle.pendingPlugin.get(e.sender);
      if (pending) { lifecycle.pendingPlugin.delete(e.sender); e.sender.send('desktop:reveal-plugin-resource', pending); }
    });
    win = new BrowserWindow({ width: 1180, height: 850, show: false, webPreferences: { preload: path.join(root, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false } });
    lifecycle.mainWindow = win; lifecycle.trackWindow(win);
    await win.loadURL(base);
    const js = code => win.webContents.executeJavaScript(code);
    await wait(() => ready);
    await wait(() => js('!document.getElementById("desktop-background-enabled").disabled'));
    await js('window.electronAPI.getBackgroundSettings()'); // Drain boot-time language IPC.
    assert.equal(win.isVisible(), false, 'settings initialization must respect show:false');
    await js(`document.getElementById('query').value = '保留这个草稿'; document.getElementById('desktop-background-enabled').click()`);
    await wait(() => controller.snapshot().enabled);
    assert.equal(await js(`document.getElementById('desktop-background-enabled').checked`), true);
    detached = new BrowserWindow({ width: 600, height: 400, show: false });
    controller.trackWindow(detached);
    await detached.loadURL('data:text/html,<title>Background regression fixture</title>');
    detached.show(); win.show(); win.close();
    await wait(() => acknowledgeNotice);
    detached.close(); acknowledgeNotice();
    await wait(() => !win.isVisible() && !detached.isVisible());
    assert.equal(detached.isDestroyed(), false);
    assert.equal(win.isDestroyed(), false); assert.equal(notices, 1);
    const result = await connector.execute('submit', { session: 'abcdef', requestId: 'background-test-0001', query: '来自远控的消息' });
    assert(['pending', 'done'].includes(result.state));
    await wait(async () => (await connector.execute('request-status', { requestId: 'background-test-0001' })).state === 'done');
    assert.equal(submissions, 1);
    const frames = [];
    streaming = connector.subscribe({ readyState: WebSocket.OPEN, bufferedAmount: 0, send: s => frames.push(JSON.parse(s)), close() {} }, 'stream', 'abcdef');
    await wait(() => stream);
    stream.write('data: ' + JSON.stringify({ meta: { name: 'agent:response-chunk' }, payload: { text: '后台仍在回复' } }) + '\n\n');
    await wait(() => frames.some(f => f.type === 'event' && f.data.includes('后台仍在回复')));
    controller.update({ enabled: false });
    assert.equal(detached.isVisible(), true);
    assert.equal(win.isVisible(), true); assert.equal(await js(`document.getElementById('query').value`), '保留这个草稿');
    await wait(() => js(`!document.getElementById('desktop-background-enabled').checked`));
    await js(`(async()=>{const {setLang}=await import('/js/i18n.js');setLang('zh')})()`);
    assert.equal(await js(`document.querySelector('#desktop-background-settings summary').textContent`), '后台运行');
    await js(`document.getElementById('page-loader').remove();document.getElementById('config-overlay').hidden=false;document.getElementById('desktop-background-settings').open=true;document.documentElement.dataset.theme='light';`);
    await new Promise(r => setTimeout(r, 250));
    fs.writeFileSync(path.join(tmp, 'settings-light.png'), (await win.webContents.capturePage()).toPNG());
    await js(`document.documentElement.dataset.theme='dark'`);
    await new Promise(r => setTimeout(r, 400));
    fs.writeFileSync(path.join(tmp, 'settings-dark.png'), (await win.webContents.capturePage()).toPNG());
    console.log('Screenshots:', tmp);
    await js(`history.pushState({sessionId:'abcdef'}, '', '/abcdef/')`);
    assert.equal(lifecycle.desktopReady.has(win.webContents), true, 'switching conversations must retain the desktop listener');
    controller.update({ enabled: true });
    const openFromTray = () => trayActions.find(item => item.label === '远控设置').click();
    const chosenOpen = () => js(`document.querySelector('.extension-panel:not([hidden]) .p-title')?.textContent === 'Chosen publisher'`);
    openFromTray();
    await wait(chosenOpen);
    const navigating = once(win.webContents, 'did-start-navigation');
    const reloading = win.loadURL(base); await navigating;
    assert.equal(lifecycle.desktopReady.has(win.webContents), false);
    previousPublisher = true;
    openFromTray();
    assert.equal(lifecycle.pendingPlugin.has(win.webContents), true, 'queue the tray action while the new page loads');
    await reloading;
    await wait(chosenOpen);
    assert.equal(lifecycle.pendingPlugin.has(win.webContents), false);
    target = { feature: 'mobile-access' };
    openFromTray();
    await wait(() => js(`document.activeElement.closest('[data-feature-id]')?.dataset.featureId === 'mobile-access'`));
    assert.equal(await js(`document.activeElement.closest('[data-feature-id]').querySelector('.plugin-description').textContent`), '设备互联迁移尚未完成。');
    await js(`document.activeElement.click()`);
    await wait(() => !migrationEnabled);
    await js(`document.getElementById('plugins-close').click()`);
    target = { plugin: 'unavailable-sharing', resource: 'settings' };
    openFromTray();
    await wait(() => js(`!document.getElementById('plugins-overlay').hidden`));
    assert.equal(await chosenOpen(), false);
    await js(`document.getElementById('plugins-close').click()`);
    await js(`import('/js/extensions/feature-state.js').then(m => m.refreshFeatures())`);
    addedPublisher = true;
    pendingCatalogs = [];
    target = { plugin: 'new-sharing', resource: 'settings' };
    openFromTray();
    await wait(() => pendingCatalogs.length > 0);
    const pendingBeforeRefresh = pendingCatalogs.length;
    await js(`document.dispatchEvent(new Event('ash:extensions-changed'))`);
    await wait(() => pendingCatalogs.length > pendingBeforeRefresh);
    const latest = pendingCatalogs.pop();
    for (const send of pendingCatalogs.splice(0)) send();
    await new Promise(resolve => setTimeout(resolve, 80));
    const extra = pendingCatalogs; pendingCatalogs = undefined;
    latest(); for (const send of extra) send();
    const newPublisherOpen = () => js(`document.querySelector('.extension-panel:not([hidden]) .p-title')?.textContent === 'New publisher'`);
    await wait(newPublisherOpen);
    publisherEnabled = false;
    await js(`import('/js/extensions/feature-state.js').then(m => m.refreshFeatures())`);
    const enabling = js(`import('/js/extensions/feature-state.js').then(m => m.features.setEnabled('plugin-new-sharing', true))`);
    await wait(() => enablePublisher);
    openFromTray();
    await new Promise(resolve => setTimeout(resolve, 80));
    enablePublisher();
    await enabling;
    await wait(newPublisherOpen);
    controller.update({ enabled: true }); quitting = true;
    const closed = once(win, 'closed'); win.close(); await closed;
    console.log('PASS: real tray, hidden-window remote work, draft restore, publisher-specific settings, reload and fallback');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    quitting = true; controller?.dispose(); connector?.close(); stream?.end(); await streaming;
    if (win && !win.isDestroyed()) win.destroy();
    if (detached && !detached.isDestroyed()) detached.destroy();
    local?.closeAllConnections(); if (local?.listening) await new Promise(r => local.close(r));
    clearTimeout(watchdog); app.exit(process.exitCode || 0);
  }
});
app.on('window-all-closed', () => {});
