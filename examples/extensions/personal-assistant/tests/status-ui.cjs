// Plugin-produced views through the unchanged desktop and remote renderers.
// Requires Playwright; all state is synthetic, with no account/model requests.
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../../..');
(async () => {
  const { AssistantPanel } = await import(pathToFileURL(path.join(__dirname, '../app.mjs')));
  let enabled = true, health = {};
  const learning = {
    access: () => enabled, health: () => health, config: () => ({ enabled, grantId: 'grant' }),
    cancelThemeOverview() {}, modelPolicyChanged() {},
  };
  const store = {
    profile: () => ({ enabled: true }), themeOverviewEnabled: () => false,
    setThemeOverviewEnabled() {}, themeOverviewGeneration: () => 0,
  };
  const background = { status: () => ({ followModel: true }), models: () => [] };
  const panel = new AssistantPanel({ dedicated: true, conversationId: () => 'assistant', store, services: { background }, learning });
  const views = [panel.overview()];
  health = { backlog: true }; views.push(panel.overview());
  learning.inferenceSignal = new AbortController().signal; views.push(panel.overview());
  learning.inferenceSignal = null;
  for (const state of [
    { lastSuccessAt: Date.now() - 1000 },
    { lastSuccessAt: new Date(2025, 0, 1, 14, 20).getTime() },
    { errorClass: 'quota', retryAt: Date.now() + 60000 },
    { errorClass: 'temporary', failures: 2 },
    { errorClass: 'capacity' },
    { lastSuccessAt: Date.now() - 1000 },
  ]) { health = state; views.push(panel.overview()); }
  enabled = false; views.push(panel.overview());
  enabled = true; health = { backlog: true }; views.push(panel.overview());
  health = { lastSuccessAt: Date.now() - 1000 }; views.push(panel.overview());
  enabled = false; views.push(panel.overview());
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    const base = pathname.startsWith('/remote/') ? path.join(root, 'remote/public') : path.join(root, 'web');
    const relative = pathname.startsWith('/remote/') ? pathname.slice(8) : pathname.slice(1);
    if (pathname === '/fixture') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><html lang="zh"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>'); }
    const file = path.resolve(base, relative);
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const remote of [false, true]) {
      const browser = await (remote ? webkit : chromium).launch({ headless: true, executablePath: remote ? process.env.WEBKIT_EXECUTABLE : process.env.CHROMIUM_EXECUTABLE });
      try {
        for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
          const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: remote, hasTouch: remote });
          const errors = []; page.on('pageerror', e => errors.push(e.message));
          await page.goto(`http://127.0.0.1:${server.address().port}/fixture`);
          for (const url of remote ? ['/remote/style.css'] : ['/css/styles.css', '/css/panels.css', '/css/panels/sidebar.css', '/css/panels/plugins.css']) await page.addStyleTag({ url });
          await page.evaluate(async ({ views, remote, theme }) => {
            const assert = (condition, text) => { if (!condition) throw Error(text); };
            document.documentElement.dataset.theme = theme;
            let current = 0;
            const callbacks = new Set();
            window.setInterval = fn => { callbacks.add(fn); return callbacks.size; };
            const { mountResource } = await import(remote ? '/remote/plugin-resource-view.js' : '/js/extensions/resource-view.js');
            const row = document.createElement('div');
            row.className = remote ? 'plugin-entry' : 'conversation-entry';
            row.style.cssText = 'position:fixed;left:16px;top:24px;width:240px;max-width:calc(100vw - 32px)';
            const open = document.createElement('button');
            open.className = remote ? 'plugin-entry-open' : 'conversation-entry-open';
            open.textContent = '个人助手';
            const host = document.createElement('div');
            host.className = remote ? 'plugin-entry-control' : 'conversation-entry-control';
            row.append(open, host);
            document.body.append(row);
            const view = () => {
              const desktop = views[current];
              if (!remote) return desktop;
              const actions = desktop.actions.filter(a => a.id === 'pause' || a.id === 'overview');
              const note = desktop.note + (actions.length < desktop.actions.length ? '\n授权与首次设置请在桌面端完成' : '');
              return {...desktop, actions, note};
            };
            const request = async body => {
              assert(!body, 'reading settings must not mutate authorization');
              return { view: view() };
            };
            const dialog = document.createElement('dialog');
            dialog.className = remote ? '' : 'conversation-resource-dialog';
            const content = document.createElement('div');
            content.className = remote ? 'plugin-resource-container' : 'p-body extension-resource-host';
            dialog.append(content);
            document.body.append(dialog);
            let closeSettings;
            const dispose = mountResource(host, { pluginId: 'fixture' }, 'assistant', {
              inlineToggle: true, request, onManage() {
                dialog.showModal();
                closeSettings = mountResource(content, { pluginId: 'fixture' }, 'assistant', { request });
              },
            });
            const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await settle();
            const settings = host.querySelector('button');
            assert(host.querySelectorAll('button').length === 1 && settings.textContent === '···', 'entry needs only one settings control');
            const y = el => {const r = el.getBoundingClientRect();return r.top + r.height / 2;};
            assert(Math.abs(y(open) - y(settings)) <= 1 && row.getBoundingClientRect().height <= 46, 'entry is taller than one row');
            settings.focus();
            settings.click();
            await settle();
            assert(dialog.open, 'settings control does not open the dialog');
            for (current = 0; current < views.length; current++) {
              for (const refresh of callbacks) await refresh();
              await settle();
              const expected = view(), note = content.querySelector('.extension-resource-note');
              assert(!host.querySelector('.resource-inline-status,[role=switch]'), 'entry gained an extra row or switch');
              assert(note?.textContent === expected.note, 'settings status is missing or stale');
              assert(content.querySelectorAll('.extension-resource-action').length === expected.actions.length, 'wrong actions in settings');
              for (const control of content.querySelectorAll('.extension-resource-action')) {
                const range = document.createRange();
                range.selectNodeContents(control);
                assert(range.getClientRects().length === 1, 'button label wraps: ' + control.textContent);
              }
              const range = document.createRange();
              range.selectNodeContents(note);
              const lines = new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => r.top)).size;
              assert(lines === expected.note.split('\n').length, 'status line wraps: ' + note.textContent);
              assert(dialog.scrollWidth <= dialog.clientWidth + 1, 'settings overflow');
            }
            assert(!document.querySelector('.extension-resource-confirm'), 'reading settings opened a confirmation');
            dialog.close();
            closeSettings();
            dispose();
          }, { views, remote, theme });
          if (errors.length) throw Error(errors.join('\n'));
          await page.close();
        }
        console.log(`PASS ${remote ? 'remote WebKit' : 'desktop Chromium'}: compact entry and settings, 320/390px, light/dark, polling and single-line labels`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
