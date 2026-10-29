// Real Chromium integration against isolated HTTP/config fixtures only.
const { app, BrowserWindow } = require('electron');
// Do not let window destruction bypass asynchronous cleanup and failure exit.
app.on('window-all-closed', () => {});
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-feature-ui-'));
app.setPath('userData', directory);
const root = path.resolve(__dirname, '../web');
const watchdog = setTimeout(() => app.exit(1), 40000);
app.whenReady().then(async () => {
  let window, server;
  let legacy = false, revision = '1', stored = { label: 'Fixture', limit: 4, enabled: true, choice: 'one', keep: { token: 'fixture-preserved' } };
  const writes = [];
  const builtins = ['quick-prompts', 'skills-marketplace', 'provider-balance', 'mobile-access'].map(id => ({ id, name: id, scope: id === 'mobile-access' ? 'application' : 'frontend', enabled: true, state: 'active' }));
  const declaration = { id: 'fixture-ui', name: 'Fixture UI', scope: 'frontend', enabled: true, state: 'active', pluginId: 'fixture-bound-id', configNamespaces: ['fixture-settings'], ui: { version: 1, panels: [{ id: 'overview', title: 'Project helper', components: [
    { type: 'text', text: '<img src=x onerror=alert(1)> is plain text' },
    { type: 'status', text: 'Ready', tone: 'success' }, { type: 'list', items: ['First item', 'Second item'] },
    { type: 'form', id: 'preferences', mode: 'config', namespace: 'fixture-settings', fields: [
      { id: 'label', label: 'Name', type: 'text', value: 'Default' },
      { id: 'limit', label: 'Limit', type: 'number', value: 5, min: -10, max: 10 },
      { id: 'enabled', label: 'Enabled', type: 'boolean', value: true },
      { id: 'choice', label: 'Mode', type: 'select', value: 'one', options: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }] },
    ] },
    { type: 'form', id: 'a-b', fields: [{ id: 'c', label: 'First collision draft', type: 'text', value: 'first' }] },
    { type: 'form', id: 'a', fields: [{ id: 'b-c', label: 'Second collision draft', type: 'text', value: 'second' }] },
    { type: 'action', action: 'composer.insert', label: 'Insert review prompt', value: 'Please review this project' },
  ] },
    { id: 'a', title: 'Cross panel first', components: [{ type: 'form', id: 'b-form-1-c', fields: [{ id: 'd', label: 'First cross panel draft', type: 'text', value: 'first cross' }] }] },
    { id: 'a-form-10-b', title: 'Cross panel second', components: [{ type: 'form', id: 'c', fields: [{ id: 'd', label: 'Second cross panel draft', type: 'text', value: 'second cross' }] }] },
  ] } };
  const malicious = { id: 'malicious-ui', name: 'Blocked metadata', scope: 'frontend', enabled: true, state: 'active', ui: { version: 1, panels: [{ id: 'bad', title: 'Bad', components: [{ type: 'html', html: '<script>window.pwned=true</script>' }] }] } };
  const features = [...builtins, declaration, malicious];
  try {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (url.pathname === '/api/extensions') { json(legacy ? {} : { version: 1, features }, legacy ? 404 : 200); return; }
      if (url.pathname.startsWith('/api/extensions/') && req.method === 'POST') {
        assert.equal(req.headers['x-ashub-local'], '1');
        let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw);
        const id = decodeURIComponent(url.pathname.split('/')[3]); const feature = features.find(value => value.id === id);
        assert.ok(feature); assert.equal(typeof body.enabled, 'boolean'); feature.enabled = body.enabled; feature.state = body.enabled ? 'active' : 'inactive';
        writes.push({ type: 'feature', id, ...body }); json({ version: 1, features }); return;
      }
      if (url.pathname === '/api/plugins/config') {
        let input;
        if (req.method === 'PUT') { let raw = ''; for await (const part of req) raw += part; input = JSON.parse(raw); }
        assert.equal(input?.id || url.searchParams.get('id'), 'fixture-bound-id'); assert.equal(input?.namespace || url.searchParams.get('namespace'), 'fixture-settings');
        if (input) {
          writes.push({ type: 'config', ...input });
          if (input.revision !== revision) { json({ error: 'changed elsewhere' }, 409); return; }
          stored = input.config; revision = String(Number(revision) + 1);
        }
        json({ namespace: 'fixture-settings', config: stored, revision }); return;
      }
      if (url.pathname === '/api/plugins') { json({ plugins: [] }); return; }
      if (url.pathname.startsWith('/api/')) { json({ providers: [], plugins: [], installed: [], skills: [] }); return; }
      const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      let content = fs.readFileSync(file);
      if (file.endsWith('.html')) content = content.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(content);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    window = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    window.webContents.on('console-message', (_event, ...args) => console.log('renderer:', ...args));
    await window.loadURL(`http://127.0.0.1:${server.address().port}`);
    const run = code => window.webContents.executeJavaScript(`(async()=>{${code}})()`);
    const js = code => run(`return (${code});`);
    const wait = async (code, label) => { for (let i = 0; i < 150; i++) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw Error(`Timed out: ${label}`); };
    await run(`localStorage.setItem('ash.prompts',JSON.stringify([{id:'fixture-prompt',name:'Review',content:'Review this fixture'}]));
      document.querySelector('.page-loader')?.classList.add('hidden');
      await import('/js/extensions/feature-ui.js').then(m=>m.initializeFeatureUI());
      await import('/js/plugins-panel.js'); await import('/js/composer.js');
      await import('/js/prefs.js');
      await import('/js/extensions/feature-state.js').then(m=>m.featuresReady());`);
    await wait(`document.querySelectorAll('#features-list [data-feature-id]').length === 6`, 'feature controls');
    assert.equal(await js(`document.querySelectorAll('.extension-menu').length`), 3);
    assert.equal(await js(`Boolean(window.pwned)`), false);
    await run(`document.getElementById('mobile-access-toggle').click()`);
    await wait(`document.getElementById('mobile-access-toggle').getAttribute('aria-expanded') === 'true'`, 'lazy-created mobile drawer accessible state');
    await run(`document.getElementById('mobile-close').click()`);
    await run(`document.getElementById('prompt-toggle').click()`);
    await wait(`!document.getElementById('prompt-overlay').hidden && document.getElementById('prompt-list').textContent.includes('Review')`, 'lazy prompts');
    await run(`document.querySelector('[data-feature-id="quick-prompts"] button').click()`);
    await wait(`document.getElementById('prompt-toggle').hidden && document.getElementById('prompt-overlay').hidden`, 'disable prompts');
    assert.equal(await js(`getComputedStyle(document.getElementById('prompt-toggle')).display`), 'none', 'disabled prompt toolbar button must actually disappear, not only set hidden');
    assert.equal(await js(`document.getElementById('prompt-toggle').getClientRects().length`), 0, 'disabled prompt must not leave an empty toolbar slot');
    assert.equal(await js(`JSON.parse(localStorage.getItem('ash.prompts'))[0].content`), 'Review this fixture');
    await run(`document.getElementById('prompt-toggle').click(); document.getElementById('query').value='#';document.getElementById('query').dispatchEvent(new Event('input',{bubbles:true}));`);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js(`document.getElementById('prompt-overlay').hidden && document.getElementById('autocomplete').hidden`), true);
    await run(`document.querySelector('.extension-menu').click()`);
    await wait(`document.querySelector('.extension-panel input[type="number"]')?.value === '4'`, 'config read');
    assert.equal(await js(`document.querySelector('.extension-panel img') === null && document.querySelector('.extension-text').textContent.includes('<img')`), true);
    await run(`const number=document.querySelector('.extension-panel input[type="number"]');number.focus();number.select();`);
    await window.webContents.insertText('-');
    assert.equal(await js(`document.querySelector('.extension-panel input[type="number"]').validity.badInput`), true, 'negative-sign intermediate state must survive repaint');
    await window.webContents.insertText('2');
    assert.equal(await js(`document.querySelector('.extension-panel input[type="number"]').value`), '-2', 'key-by-key negative input must not become positive');
    await run(`document.querySelector('.extension-panel .p-btn-primary').click()`);
    await wait(`document.querySelector('.extension-panel .plugins-message').textContent === 'Configuration saved' || document.querySelector('.extension-panel .plugins-message').textContent === '配置已保存'`, 'negative config save');
    assert.equal(stored.limit, -2);

    await run(`const number=document.querySelector('.extension-panel input[type="number"]');number.value='7';number.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.extension-panel .p-btn-primary').click();`);
    await wait(`document.querySelector('.extension-panel .plugins-message').textContent === 'Configuration saved' || document.querySelector('.extension-panel .plugins-message').textContent === '配置已保存'`, 'config save');
    assert.equal(stored.limit, 7); assert.deepEqual(stored.keep, { token: 'fixture-preserved' });
    revision = String(Number(revision) + 1);
    await run(`const number=document.querySelector('.extension-panel input[type="number"]');number.value='9';number.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.extension-panel .p-btn-primary').click();`);
    await wait(`document.querySelector('.extension-panel .plugins-message').textContent.includes('changed') || document.querySelector('.extension-panel .plugins-message').textContent.includes('修改')`, 'revision conflict');
    assert.equal(await js(`document.querySelector('.extension-panel input[type="number"]').value`), '9'); assert.equal(stored.limit, 7);
    await run(`document.querySelector('.extension-panel .plugin-config-actions .p-btn').click()`);
    assert.equal(await js(`document.querySelector('.extension-panel input[type="number"]').value`), '9');
    await run(`document.querySelector('.extension-panel .plugin-config-actions .p-btn').click()`);
    await wait(`document.querySelector('.extension-panel input[type="number"]').value === '7'`, 'explicit reload');
    await run(`document.querySelector('.extension-action').click()`);
    assert.equal(await js(`document.getElementById('query').value`), 'Please review this project');
    const draftFields = await js(`['First collision draft','Second collision draft','First cross panel draft','Second cross panel draft'].map(text=>{const label=[...document.querySelectorAll('.extension-panel label')].find(label=>label.textContent===text);return {id:label.htmlFor,value:document.getElementById(label.htmlFor).value}})`);
    assert.equal(new Set(draftFields.map(field=>field.id)).size, 4, 'legal panel/form/field tuples must produce distinct control IDs');
    assert.deepEqual(draftFields.map(field=>field.value), ['first','second','first cross','second cross']);
    await run(`['First collision draft','Second collision draft','First cross panel draft','Second cross panel draft'].forEach((text,index)=>{const label=[...document.querySelectorAll('.extension-panel label')].find(label=>label.textContent===text);const input=document.getElementById(label.htmlFor);input.value=['first edited','second edited','first cross edited','second cross edited'][index];input.dispatchEvent(new Event('input',{bubbles:true}));});`);
    const desktop = await window.webContents.capturePage(); fs.writeFileSync(path.join(os.tmpdir(), 'ashub-feature-ui-desktop.png'), desktop.toPNG());
    await run(`document.querySelector('[data-feature-id="fixture-ui"] button').click()`);
    await wait(`document.querySelector('.extension-menu') === null && document.querySelector('.extension-panel') === null`, 'remove disabled UI');
    await run(`document.querySelector('[data-feature-id="fixture-ui"] button').click()`);
    await wait(`document.querySelector('.extension-menu') !== null`, 'remount UI');
    window.setSize(390, 844); await wait(`innerWidth === 390`, 'mobile viewport'); await js(`document.querySelector('.extension-menu').click()`);
    await wait(`!document.querySelector('.extension-panel').hidden`, 'mobile panel');
    const remountedDrafts = await js(`['First collision draft','Second collision draft','First cross panel draft','Second cross panel draft'].map(text=>{const label=[...document.querySelectorAll('.extension-panel label')].find(label=>label.textContent===text);return document.getElementById(label.htmlFor).value})`);
    assert.deepEqual(remountedDrafts, ['first edited','second edited','first cross edited','second cross edited'], 'disable/reenable must preserve independent draft tuples');
    await wait(`getComputedStyle(document.querySelector('.extension-panel')).opacity === '1' && document.querySelector('.app').classList.contains('sidebar-collapsed')`, 'mobile panel foreground');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(await js(`(()=>{const r=document.querySelector('.extension-panel').getBoundingClientRect();return r.left>=-1&&r.right<=innerWidth+1})()`), true);
    const mobile = await window.webContents.capturePage(); fs.writeFileSync(path.join(os.tmpdir(), 'ashub-feature-ui-mobile.png'), mobile.toPNG());
    const composerDisabled = await js(`document.getElementById('query').disabled`);
    for (const feature of builtins) feature.enabled = false;
    await run(`await import('/js/extensions/feature-state.js').then(m=>m.refreshFeatures())`);
    assert.equal(await js(`document.getElementById('query').disabled`), composerDisabled);
    assert.equal(await js(`['prompt-toggle','skills-toggle','mobile-access-toggle'].every(id=>document.getElementById(id).hidden)`), true);
    for (const theme of ['light', 'dark']) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      assert.equal(await js(`['prompt-toggle','skills-toggle','mobile-access-toggle'].every(id=>{const button=document.getElementById(id);return button.hidden&&button.disabled&&getComputedStyle(button).display==='none'&&button.getClientRects().length===0})`), true, `disabled toolbar buttons take no space in ${theme} mobile layout`);
      assert.equal(await js(`getComputedStyle(document.getElementById('plugins-toggle')).display!=='none' && !document.getElementById('plugins-toggle').disabled`), true, 'plugin management remains available to re-enable features');
    }
    const disabledReload = once(window.webContents, 'did-finish-load'); window.reload(); await disabledReload;
    await run(`await import('/js/extensions/feature-ui.js').then(m=>m.initializeFeatureUI());await import('/js/plugins-panel.js');await import('/js/extensions/feature-state.js').then(m=>m.featuresReady());`);
    assert.equal(await js(`['prompt-toggle','skills-toggle','mobile-access-toggle'].every(id=>getComputedStyle(document.getElementById(id)).display==='none')`), true, 'persisted disabled features stay absent after reload');
    for (const feature of builtins) { feature.enabled = true; feature.state = 'active'; }
    await run(`await import('/js/extensions/feature-state.js').then(m=>m.refreshFeatures())`);
    assert.equal(await js(`['prompt-toggle','skills-toggle','mobile-access-toggle'].every(id=>{const button=document.getElementById(id);return !button.hidden&&!button.disabled&&getComputedStyle(button).display!=='none'&&button.getClientRects().length>0})`), true, 're-enabled toolbar entries are visible and usable');
    await run(`document.getElementById('prompt-toggle').click()`);
    await wait(`!document.getElementById('prompt-overlay').hidden && document.getElementById('prompt-list').textContent.includes('Review')`, 're-enabled prompt opens with retained data');
    legacy = true;
    const reloaded = once(window.webContents, 'did-finish-load'); window.reload(); await reloaded;
    await run(`await import('/js/extensions/feature-ui.js').then(m=>m.initializeFeatureUI());await import('/js/plugins-panel.js');await import('/js/extensions/feature-state.js').then(m=>m.featuresReady());`);
    await wait(`document.querySelectorAll('#features-list button').length === 4`, 'old host defaults');
    assert.equal(await js(`[...document.querySelectorAll('#features-list button')].every(button=>button.disabled) && !document.getElementById('prompt-toggle').hidden`), true);
    assert.equal(writes.filter(write => write.type === 'config').length, 3);
    console.log('PASS feature UI: lazy built-ins, disable/data retention, catalog panels, injection rejection, bound config save/reload/conflict, draft-only action, remount, mobile layout and legacy fallback');
    console.log(`Screenshots: ${path.join(os.tmpdir(), 'ashub-feature-ui-desktop.png')} and ${path.join(os.tmpdir(), 'ashub-feature-ui-mobile.png')}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { clearTimeout(watchdog); window?.destroy(); await new Promise(resolve => server ? server.close(resolve) : resolve()); app.exit(process.exitCode || 0); }
});
