// Isolated Chromium UI checks against fixture data; no user configuration or external APIs.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-plugin-ui-'));
app.setPath('userData', dir);
const root = path.resolve(__dirname, '../web');
const watchdog = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  let win, server;
  const plugins = [
    { id: 'one', name: '文献检索', source: '~/.agent-sh/extensions/literature/index.ts', enabled: true, sessions: [{ title: '论文综述', state: 'loaded', configNamespaces: ['literature'] }, { title: '资料整理', state: 'loaded' }] },
    { id: 'two', name: '项目通知', source: '~/.agent-sh/extensions/project-notify/index.ts', enabled: false, sessions: [] },
    { id: 'three', name: '资源查询', source: '~/.agent-sh/extensions/resource-search/index.ts', enabled: true, sessions: [{ title: '研究笔记', state: 'error', error: 'Required endpoint is not configured' }] },
  ];
  plugins.push(
    { id: 'builtin:agent', name: 'agent-sh', builtin: true, required: true, description: 'plugins.descAgent', sessions: [{ title: '论文综述', state: 'loaded' }] },
    { id: 'builtin:provider:openai', name: 'OpenAI', builtin: true, configNamespace: 'providers.openai', description: 'plugins.descProvider', sessions: [{ title: '论文综述', state: 'registered' }] },
    { id: 'builtin:codex-provider', name: 'Codex', builtin: true, configNamespace: 'codex-provider', description: 'plugins.descCodex', sessions: [] },
  );
  let failNext = false, delay = 0, configWrites = 0;
  const configs = new Map([['literature', { config: { endpoint: 'https://example.invalid/search', limit: 8 }, revision: 1 }]]);
  try {
    server = http.createServer(async (req, res) => {
      if (req.url === '/api/models' || req.url === '/api/config') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/api/models' ? { providers: [{ name: 'fixture', models: [] }] } : { providers: {}, 'sample': { endpoint: 'https://example.invalid' } })); return;
      }
      if (req.url === '/api/plugins') {
        if (req.method === 'PUT') { let body = ''; for await (const part of req) body += part;
          if (failNext) { failNext = false; res.writeHead(500); res.end('fixture failure'); return; }
          const input = JSON.parse(body); plugins.find(p => p.id === input.id).enabled = input.enabled;
        }
        const snapshot = JSON.stringify({ plugins });
        const pause = delay; delay = 0;
        setTimeout(() => { res.setHeader('Content-Type', 'application/json'); res.end(snapshot); }, pause); return;
      }
      if (req.url.startsWith('/api/plugins/config')) {
        const url = new URL(req.url, 'http://localhost');
        let input;
        if (req.method === 'PUT') { let raw = ''; for await (const part of req) raw += part; input = JSON.parse(raw); }
        const namespace = input?.namespace || url.searchParams.get('namespace');
        const current = configs.get(namespace) || { config: {}, revision: 0 };
        if (input) {
          if (input.revision !== String(current.revision)) { res.writeHead(409); res.end('changed elsewhere'); return; }
          current.config = input.config; current.revision++; configs.set(namespace, current); configWrites++;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ namespace, config: current.config, revision: String(current.revision) })); return;
      }
      const url = new URL(req.url, 'http://localhost');
      const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      let content = fs.readFileSync(file);
      if (file.endsWith('.html')) content = content.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'); res.end(content);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    win = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
    await win.loadURL(`http://127.0.0.1:${server.address().port}`);
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async code => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 20)); } throw Error('UI wait failed: '+code); };
    await js(`document.getElementById('page-loader').remove(); document.querySelector('.app').classList.add('sidebar-collapsed'); localStorage.setItem('ash.lang','zh'); import('/js/plugins-panel.js').then(() => document.getElementById('plugins-toggle').click())`);
    await wait(`document.querySelectorAll('.plugin-item').length === 6`);
    assert.equal(await js(`document.querySelector('.plugin-toggle').getAttribute('aria-checked')`), 'true');
    await js(`document.querySelector('.plugin-toggle').click()`);
    await wait(`document.querySelector('.plugin-toggle').getAttribute('aria-checked') === 'false' && !document.querySelector('.plugin-toggle').disabled`);
    assert.equal(plugins[0].enabled, false);
    assert.equal(await js(`document.getElementById('plugins-toggle').getAttribute('aria-expanded')`), 'true');
    assert.equal(await js(`document.getElementById('plugins-toggle').classList.contains('active')`), true);
    failNext = true; await js(`document.querySelector('.plugin-toggle').click()`);
    await wait(`document.getElementById('plugins-message').textContent.includes('fixture failure')`);
    assert.equal(await js(`document.querySelector('.plugin-toggle').getAttribute('aria-checked')`), 'false');
    await js(`document.getElementById('plugins-refresh').click()`);
    await wait(`document.querySelectorAll('.plugin-item').length === 6 && !document.getElementById('plugins-refresh').disabled`);
    delay = 200;
    await js(`document.getElementById('plugins-refresh').click(); document.getElementById('plugins-close').click(); document.getElementById('plugins-toggle').click()`);
    await wait(`document.querySelectorAll('.plugin-item').length === 6`);
    await new Promise(r => setTimeout(r, 240));
    assert.equal(await js(`document.getElementById('plugins-overlay').hidden`), false);
    await js(`document.querySelector('.plugin-configure').click()`);
    await wait(`document.querySelector('.plugin-config-editor') && !document.querySelector('.plugin-config-editor').disabled`);
    assert.equal(await js(`document.getElementById('config-overlay').hidden`), true);
    assert.equal(await js(`document.querySelector('.plugin-namespace').value`), 'literature');
    const edit = text => js(`(() => { const e=document.querySelector('.plugin-config-editor'); e.value=${JSON.stringify(text)}; e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await edit('{bad'); await js(`document.querySelector('.plugin-config-save').click()`);
    await wait(`document.querySelector('.plugin-config-message').textContent.includes('JSON')`); assert.equal(configWrites, 0);
    await edit(JSON.stringify({ endpoint: 'https://example.invalid/search', limit: 12 }));
    await js(`document.querySelector('.plugin-config-save').click()`);
    await wait(`!document.querySelector('.plugin-config-save').disabled && document.querySelector('.plugin-config-message').textContent.includes('已保存')`);
    assert.equal(configs.get('literature').config.limit, 12);
    configs.set('literature', { config: { limit: 15 }, revision: 3 });
    await edit(JSON.stringify({ limit: 20 })); await js(`document.querySelector('.plugin-config-save').click()`);
    await wait(`document.querySelector('.plugin-config-message').textContent.includes('其他位置')`);
    assert.match(await js(`document.querySelector('.plugin-config-editor').value`), /20/);
    await js(`document.querySelector('.plugin-config-read').click()`);
    assert.equal(await js(`document.querySelector('.plugin-config-confirm').hidden`), false);
    await js(`document.querySelector('.plugin-config-discard').click()`);
    await wait(`!document.querySelector('.plugin-config-editor').disabled && document.querySelector('.plugin-config-editor').value.includes('15')`);
    await edit(JSON.stringify({ endpoint: 'https://example.invalid/search', limit: 18 }, null, 2));
    await js(`document.getElementById('plugins-close').click(); document.getElementById('plugins-toggle').click()`);
    await wait(`document.querySelector('.plugin-config-editor')?.value.includes('18')`);
    assert.equal(await js(`document.querySelector('.plugin-config').hidden`), false);
    await js(`document.getElementById('plugins-refresh').click()`);
    await wait(`document.querySelector('.plugin-config-editor')?.value.includes('18')`);
    await js(`document.querySelector('.plugin-config-save').click()`);
    await wait(`!document.querySelector('.plugin-config-save').disabled`);
    assert.equal(configs.get('literature').config.limit, 18);
    assert.equal(await js(`document.querySelectorAll('[data-builtin] .plugin-toggle').length`), 0);
    assert.equal(await js(`!!document.querySelector('[data-builtin]').querySelector('.plugin-configure')`), false);
    assert.equal(await js(`document.querySelectorAll('.plugin-group-title').length`), 2);
    await js(`document.getElementById('plugin-config-builtin:provider:openai').closest('.plugin-item').querySelector('.plugin-configure').click()`);
    await wait(`!document.getElementById('plugin-config-builtin:provider:openai').querySelector('textarea').disabled`);
    assert.equal(await js(`document.getElementById('plugin-config-builtin:provider:openai').querySelector('input').readOnly`), true);
    assert.equal(await js(`document.getElementById('plugin-config-builtin:provider:openai').querySelector('input').value`), 'providers.openai');
    await js(`(() => { const box=document.getElementById('plugin-config-builtin:provider:openai'), e=box.querySelector('textarea'); e.value='{"defaultModel":"fixture"}'; e.dispatchEvent(new Event('input',{bubbles:true})); box.querySelector('.plugin-config-save').click(); })()`);
    await wait(`!document.getElementById('plugin-config-builtin:provider:openai').querySelector('.plugin-config-save').disabled`);
    assert.equal(configs.get('providers.openai').config.defaultModel, 'fixture');
    await js(`document.getElementById('plugin-config-builtin:provider:openai').closest('.plugin-item').querySelector('.plugin-configure').click()`);
    for (const width of [1180, 390]) {
      win.setContentSize(width, 900);
      await js(`document.querySelectorAll('.plugin-details').forEach(d => d.open=true)`);
      await new Promise(r => setTimeout(r, 80));
      const bounds = await js(`(() => { const p=document.getElementById('plugins-overlay'), r=p.getBoundingClientRect(); return { left:r.left, right:r.right, width:innerWidth, overflow:p.scrollWidth-p.clientWidth, items:[...p.querySelectorAll('.plugin-item')].map(e=>e.scrollWidth-e.clientWidth) }; })()`);
      assert(bounds.right - bounds.left > 100);
      assert(bounds.left >= -1 && bounds.right <= bounds.width + 1, JSON.stringify(bounds));
      assert(bounds.overflow <= 1 && bounds.items.every(n => n <= 1), JSON.stringify(bounds));
      if (width === 1180) await js(`document.querySelectorAll('.plugin-details').forEach(d => d.open=false)`);
      assert(await js(`(() => { const p=document.getElementById('plugins-overlay'), r=p.getBoundingClientRect(); return p.contains(document.elementFromPoint(r.left+20,r.top+20)); })()`), 'panel must be visible and unobstructed');
      await fs.promises.writeFile(`/tmp/ashub-plugins-${width}.png`, (await win.webContents.capturePage()).toPNG());
    }
    await js(`document.querySelector('.plugin-configure').click(); document.querySelectorAll('.plugin-details').forEach(d=>d.open=false); document.querySelector('[data-builtin]').scrollIntoView({block:'start'});`);
    await fs.promises.writeFile('/tmp/ashub-plugins-builtins.png', (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('.plugin-configure').click()`);
    await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    assert.equal(await js(`document.getElementById('plugins-overlay').hidden`), true);
    assert.equal(await js(`document.activeElement.id`), 'plugins-toggle');
    assert.equal(await js(`document.querySelectorAll('#plugins-toggle').length === 1 && !!document.querySelector('.toolbar #plugins-toggle') && !document.querySelector('#config-overlay #plugins-toggle')`), true);
    assert.equal(await js(`document.getElementById('plugins-toggle').getAttribute('aria-expanded')`), 'false');
    await js(`import('/js/config-panel.js').then(() => document.getElementById('config-toggle').click())`);
    await wait(`!document.getElementById('config-overlay').hidden && !document.getElementById('config-save').disabled`);
    await js(`document.getElementById('plugins-toggle').click()`);
    await wait(`!document.getElementById('plugins-overlay').hidden && document.getElementById('config-overlay').hidden`);
    await wait(`document.querySelector('.plugin-config-editor')?.value.includes('18')`);
    assert.equal(await js(`document.querySelector('.plugin-config').hidden`), false);
    console.log('PASS built-in UI: no toggle for bundled components, fixed config paths, inline provider save');
    console.log('PASS Chromium inline plugin configuration: JSON validation, save, conflict, reload and draft preservation');
    console.log('PASS Chromium plugin UI: rendering, toggle, failure, stale refresh, close/reopen, Escape and desktop/mobile-width layout');
  } finally {
    win?.destroy(); server?.closeAllConnections(); await new Promise(r => server ? server.close(r) : r());
    clearTimeout(watchdog); fs.rmSync(dir, { recursive: true, force: true });
  }
}).then(() => app.exit(0), e => { console.error(e); app.exit(1); });
