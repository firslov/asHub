// Plugin-produced views through the unchanged desktop and remote renderers.
// Requires Playwright; all state is synthetic, with no account/model requests.
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../../..');
(async () => {
  const { AssistantPanel } = await import(pathToFileURL(path.join(__dirname, '../app.mjs')));
  let enabled = true, health = {};
  const learning = { access: () => enabled, health: () => health };
  const panel = new AssistantPanel({ conversationId: () => 'assistant', store: { profile: () => ({ enabled: true }) }, learning });
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
          for (const url of remote ? ['/remote/style.css'] : ['/css/styles.css', '/css/panels/sidebar.css', '/css/panels/plugins.css']) await page.addStyleTag({ url });
          await page.evaluate(async ({ views, remote, theme }) => {
            const assert = (condition, text) => { if (!condition) throw Error(text); };
            document.documentElement.dataset.theme = theme;
            let refresh, current = 0;
            // Trigger the renderer's real polling path deterministically.
            const interval = window.setInterval; window.setInterval = fn => { refresh = fn; return 0; };
            const { mountResource } = await import(remote ? '/remote/plugin-resource-view.js' : '/js/extensions/resource-view.js');
            const row = document.createElement('div'); row.className = remote ? 'plugin-entry' : 'conversation-entry';
            row.style.cssText = 'position:fixed;left:16px;top:24px;width:240px;max-width:calc(100vw - 32px)';
            const open = document.createElement('button'); open.className = remote ? 'plugin-entry-open' : 'conversation-entry-open'; open.textContent = '个人助手';
            const host = document.createElement('div'); host.className = remote ? 'plugin-entry-control' : 'conversation-entry-control';
            row.append(open, host); document.body.append(row);
            const dispose = mountResource(host, { pluginId: 'fixture' }, 'assistant', { inlineToggle: true, request: async body => {
              assert(!body, 'status polling must not mutate authorization'); return { view: views[current] };
            } });
            const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await settle(); host.querySelector('[role=switch]').focus();
            for (current = 0; current < views.length; current++) {
              await refresh(); await settle();
              const expected = views[current].toggle, button = host.querySelector('[role=switch]'), status = host.querySelector('.resource-inline-status');
              assert(button.getAttribute('aria-checked') === String(expected.checked), 'status changed authorization state');
              assert(document.activeElement === button, 'status update lost focus');
              assert((status?.textContent) === expected.status, 'stale or missing status');
              assert(host.querySelectorAll('button').length === 1, 'status adds controls');
              if (status) {
                const rect = status.getBoundingClientRect(), bounds = row.getBoundingClientRect();
                assert(rect.top >= button.getBoundingClientRect().bottom - 1, 'status overlaps switch');
                assert(rect.left >= bounds.left && rect.right <= bounds.right + 1 && row.scrollWidth <= row.clientWidth + 1, 'status overflows narrow entry');
                assert(button.getAttribute('aria-describedby') === status.id && button.title.includes(expected.status), 'full status is inaccessible');
                assert(parseFloat(getComputedStyle(status).fontSize) <= 12, 'status is too prominent');
              }
              assert(!document.querySelector('.resource-toggle-confirm'), 'status opens dialog');
            }
            dispose(); window.setInterval = interval;
          }, { views, remote, theme });
          if (errors.length) throw Error(errors.join('\n'));
          await page.close();
        }
        console.log(`PASS ${remote ? 'remote WebKit' : 'desktop Chromium'}: actual plugin statuses, 320/390px, light/dark, polling, focus, authorization and recovery`);
      } finally { await browser.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
