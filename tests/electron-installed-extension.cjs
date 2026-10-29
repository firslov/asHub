// Cross-layer acceptance: real ZIP installer -> host catalog -> Chromium UI -> persisted config.
const { app, BrowserWindow } = require('electron');
const { env, Bridge, fs, path, root } = require('./harness.cjs');
const { zip } = require('./plugin-zip-fixture.cjs');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const e = env({ globals: { setTimeout, clearTimeout, setInterval, clearInterval } });
app.setPath('userData', path.join(e.dir, 'browser'));
let hub, win;
// Keep Electron alive through async cleanup so failures determine the exit code.
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('Installed-extension test timed out'); app.exit(1); }, 40000);
app.whenReady().then(async () => {
  try {
    hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: options => new Bridge(options) });
    await once(hub.server, 'listening');
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    const call = async (route, init = {}) => {
      const response = await fetch(base + route, init);
      const raw = await response.text(); assert.equal(response.status, 200, raw); return JSON.parse(raw);
    };
    const manifest = {
      schemaVersion: 2, id: 'delivery-ui', name: 'Delivery UI', configNamespaces: ['delivery'],
      defaults: { delivery: { label: 'Review', retained: 'keep' } },
      configSchema: { delivery: { type: 'object', properties: { label: { type: 'string', maxLength: 80 } } } },
      ui: { version: 1, panels: [{ id: 'settings', title: 'Delivery preferences', components: [
        { type: 'text', text: 'Installed from a real ZIP' },
        { type: 'form', id: 'config', mode: 'config', namespace: 'delivery', fields: [{ id: 'label', label: 'Name', type: 'text', value: 'Review' }] },
        { type: 'action', label: 'Prepare review', action: 'composer.insert', value: 'Review this project' },
      ] }] },
    };
    const archive = zip({ 'package.json': JSON.stringify({ name: manifest.id, version: '1.0.0', type: 'module' }), 'ashub-plugin.json': JSON.stringify(manifest) });
    const preview = await call('/api/plugins/install?action=preview', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: archive });
    assert.equal(preview.canInstall, true);
    const job = await call('/api/plugins/install?action=confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: preview.token }) });
    let outcome;
    for (let n = 0; n < 100; n++) { outcome = await call('/api/plugins/install?id=' + job.id); if (outcome.state !== 'running') break; await new Promise(r => setTimeout(r, 20)); }
    assert.equal(outcome.state, 'succeeded', JSON.stringify(outcome));
    const catalog = await call('/api/extensions');
    const feature = catalog.features.find(f => f.name === 'Delivery UI'); assert(feature?.pluginId); assert.equal(feature.state, 'active');
    win = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadURL(base);
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async code => { for (let n = 0; n < 150; n++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 25)); } throw Error('Timed out: ' + code); };
    await wait(`!!document.querySelector('.extension-menu')`);
    await js(`document.querySelector('.extension-menu').click()`);
    await wait(`(()=>{const input=document.querySelector('.extension-panel input'),save=document.querySelector('.extension-panel .p-btn-primary');return input?.value==='Review'&&!input.disabled&&save&&!save.disabled})()`);
    await js(`(()=>{const input=document.querySelector('.extension-panel input');input.value='Verified';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.extension-panel .p-btn-primary').click()})()`);
    await wait(`(()=>{const panel=document.querySelector('.extension-panel'),save=panel?.querySelector('.p-btn-primary'),message=panel?.querySelector('.plugins-message')?.textContent;return save&&!save.disabled&&['Configuration saved','配置已保存'].includes(message)&&panel.querySelector('input').value==='Verified'})()`);
    const settingsFile = path.join(e.dir, 'settings.json');
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); assert.deepEqual(saved.delivery, { label: 'Verified', retained: 'keep' });
    await js(`document.querySelector('.extension-action').click()`);
    assert.equal(await js(`document.getElementById('query').value`), 'Review this project');
    assert.deepEqual(await call('/sessions'), [], 'composer insertion must never create or submit a conversation');
    const toggle = enabled => call(`/api/extensions/${feature.id}/enabled`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ashub-Local': '1' }, body: JSON.stringify({ enabled }) });
    await toggle(false); await js(`document.dispatchEvent(new CustomEvent('ash:extensions-changed'))`);
    await wait(`!document.querySelector('.extension-menu') && !document.querySelector('.extension-panel')`);
    await toggle(true); await js(`document.dispatchEvent(new CustomEvent('ash:extensions-changed'))`);
    await wait(`!!document.querySelector('.extension-menu')`);
    await js(`document.querySelector('.extension-menu').click()`);
    await wait(`document.querySelector('.extension-panel input')?.value === 'Verified'`);
    for (const width of [390, 320]) { win.setContentSize(width, 850); await new Promise(r => setTimeout(r, 80)); assert.equal(await js(`(()=>{const p=document.querySelector('.extension-panel'),r=p.getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1&&p.scrollWidth<=p.clientWidth+1})()`), true, 'panel overflow at ' + width); }
    console.log('PASS real installed UI: ZIP confirmation, host discovery, full app mount, durable form save, draft-only action, disable/reenable and 320/390px layout');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win?.destroy(); await hub?.shutdown(); clearTimeout(watchdog); app.exit(process.exitCode || 0); }
});
