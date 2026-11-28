// Real remote shell and browser layout, synthetic accounts/devices and loopback only.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.join(__dirname, 'public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const route = new URL(req.url, 'http://local').pathname;
    if (route.startsWith('/mobile/api/')) {
      const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      if (route.endsWith('/me')) return json({ username: 'fixture-one' });
      if (route.endsWith('/devices')) return json([
        { id: 'one', name: '电脑一', online: true }, { id: 'two', name: '电脑二', online: true }, { id: 'old', name: '旧版电脑', online: true },
      ]);
      if (route.endsWith('/rpc')) {
        let body = ''; for await (const part of req) body += part;
        const { op } = JSON.parse(body);
        if (op === 'sessions') return json([{ instanceId: 'live', title: '进行中的对话' }]);
        if (op === 'capabilities') return json(route.includes('/old/') ? { archivedHistory: 'true' } : { archivedHistory: true });
      }
      res.writeHead(404); return json({ error: 'Unknown fixture route' });
    }
    const file = path.join(root, route.slice('/mobile/'.length) || 'index.html');
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch { res.writeHead(500); res.end(); }
});

async function check(engine, base) {
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true });
  try {
    const width = Number(process.env.ARCHIVE_WIDTH || 320);
    const page = await browser.newPage({ viewport: { width, height: 680 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    page.setDefaultTimeout(6500);
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const errors = [], requested = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requested.push(request.url()));
    await page.addInitScript(() => {
      globalThis.EventSource = class {
        constructor() { setTimeout(() => { if (!this.closed) {
          this.onmessage?.({ data: JSON.stringify({ meta: { name: 'agent:response-segment' }, payload: { text: '原对话仍然可见' } }) });
          this.onmessage?.({ data: JSON.stringify({ meta: { name: 'hub:replay-done' }, payload: {} }) });
        } }, 5); }
        addEventListener() {} close() { this.closed = true; }
      };
      const real = fetch.bind(window);
      window.archiveRequests = [];
      window.fetch = (input, opts) => {
        const payload = opts?.body && JSON.parse(opts.body);
        if (!['archived-history', 'archived-sessions'].includes(payload?.op)) return real(input, opts);
        return new Promise(resolve => archiveRequests.push({
          path: new URL(input).pathname, ...payload, signal: opts.signal,
          // Ignore abort on purpose: sequence/owner checks must also discard late results.
          reply: (body, status) => resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
        }));
      };
    });
    const open = () => page.locator('#archive-open').tap();
    const dialog = page.locator('#archive-dialog');
    const waitRequest = n => page.waitForFunction(n => archiveRequests.length === n, n);
    const reply = (i, data, status = 200) => page.evaluate(([i, data, status]) => archiveRequests[i].reply(data, status), [i, data, status]);
    const request = i => page.evaluate(i => { const { path, args, op, signal } = archiveRequests[i]; return { path, args, op, aborted: signal.aborted }; }, i);
    const chat = page.locator('#query');
    const ashItems = [{ id: 'shared-id', title: '归档方案', cwd: '/团队/设计' }, { id: 'notes', title: '随手记录', cwd: '/团队/记录' }];
    const messages = page.locator('.archive-text');
    await page.goto(base);
    await page.locator('#archive-open').waitFor();
    await page.locator('#sessions .session-button').first().tap();
    await page.waitForFunction(() => session === 'live' && streamReady);
    await chat.fill('保留未发送的草稿');
    await page.locator('#menu').tap(); await open(); await waitRequest(1);
    assert.deepEqual(await request(0), { path: '/mobile/api/devices/one/rpc', args: {}, op: 'archived-sessions', aborted: false });
    await reply(0, { error: 'Fixture offline' }, 503);
    await page.locator('#archive-retry-list').tap(); await waitRequest(2); await reply(1, ashItems);
    await page.locator('.archive-item').first().waitFor();
    await page.locator('#archive-search').fill('团队/设计');
    assert.equal(await page.locator('.archive-item').count(), 1);
    await page.locator('#archive-search').fill('归档方案');
    await page.locator('.archive-item').tap(); await waitRequest(3);
    assert.deepEqual((await request(2)).args, { session: 'shared-id', offset: 0 });
    await reply(2, { error: 'Fixture failure' }, 503);
    await page.locator('#archive-retry-history').tap(); await waitRequest(4);
    assert.equal((await request(3)).args.offset, 0);
    await reply(3, { messages: [
      { role: 'user', text: '最新提问' },
      { role: 'assistant', text: '**已归档正文**\n\n[普通文字链接](./not-for-navigation)\n\n![不加载资源](./not-for-navigation.png)\n\n| 第一列 | 第二列 |\n|---|---|\n| 一个很宽的列 | ' + 'long_unbroken_token'.repeat(40) + ' |\n\n' + '当前归档的段落。\n\n'.repeat(45) },
    ], nextOffset: 2 });
    await page.locator('.archive-text strong').waitFor();
    assert.equal(await page.locator('.archive-text strong').textContent(), '已归档正文');
    assert.equal(await page.locator('.archive-text :is(a,img)').count(), 0);
    assert.equal(await page.locator('.archive-text table').count(), 1);
    assert(await page.locator('#archive-back').evaluate(e => {
      const rect = e.getBoundingClientRect(), d = e.closest('dialog').getBoundingClientRect();
      return rect.width > 0 && rect.right <= d.right && d.right <= innerWidth && rect.bottom <= innerHeight;
    }));
    await page.locator('#archive-more').tap(); await waitRequest(5); assert.equal((await request(4)).args.offset, 2);
    await reply(4, { messages: [], nextOffset: 4 });
    await page.waitForFunction(() => !document.querySelector('#archive-more').hasAttribute('aria-disabled'));
    assert.equal(await messages.count(), 2, 'empty page is legal');
    const viewport = page.locator('#archive-messages');
    await viewport.evaluate(el => {
      const table = el.querySelector('table');
      window.archiveAnchor = table.closest('article');
      el.scrollTop = 96;
      table.scrollLeft = 150;
    });
    const position = () => viewport.evaluate(el => {
      const table = archiveAnchor.querySelector('table');
      return { top: archiveAnchor.getBoundingClientRect().top, y: el.scrollTop, x: table.scrollLeft,
        oldCardKept: el.contains(archiveAnchor), outerOverflow: el.scrollWidth > el.clientWidth + 1 };
    });
    const samePosition = (before, after, phase) => {
      assert(Math.abs(after.top - before.top) <= 2, `${phase}: ${JSON.stringify({ before, after })}`);
      assert(after.oldCardKept && !after.outerOverflow);
      assert.equal(after.x, before.x, phase);
    };
    const before = await position();
    assert.equal(before.y, 96);
    assert.equal(before.x, 150);
    await page.locator('#archive-more').tap(); await waitRequest(6); assert.equal((await request(5)).args.offset, 4);
    const loading = await position();
    samePosition(before, loading, 'loading earlier messages');
    await reply(5, { error: 'Fixture pagination failure' }, 503);
    await page.locator('#archive-retry-history').waitFor();
    samePosition(before, await position(), 'pagination error');
    await page.locator('#archive-retry-history').tap(); await waitRequest(7); assert.equal((await request(6)).args.offset, 4);
    samePosition(before, await position(), 'retrying earlier messages');

    // Scroll again while the retry is in flight, then let the last page arrive.
    // Mobile WebKit cannot inject a wheel; focus the same scroll region and
    // use the browser's native keyboard scrolling there instead.
    if (engine === 'webkit') {
      await viewport.press('End');
      await page.waitForFunction(() => {
        const el = document.querySelector('#archive-messages');
        return Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 1;
      });
    } else {
      const bounds = await viewport.boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height * .75);
      await page.mouse.wheel(0, 144);
      await page.waitForFunction(y => document.querySelector('#archive-messages').scrollTop >= y + 100, before.y);
    }
    await viewport.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const readPosition = await position();
    assert(Math.abs(readPosition.top - before.top) > 100, 'reader moved while retry was pending');
    await reply(6, { messages: [{ role: 'user', text: '更早的提问' }, { role: 'assistant', text: '更早的解答\n\n' + '更早的长段落。\n\n'.repeat(60) }], nextOffset: null });
    await page.waitForFunction(() => document.querySelectorAll('.archive-text').length === 4);
    const texts = await messages.allTextContents();
    assert.equal(texts[0].trim(), '更早的提问');
    assert.match(texts[1], /^更早的解答/);
    assert.equal(texts[2].trim(), '最新提问');
    assert.equal(await page.locator('#archive-more').isVisible(), false);
    const after = await position();
    samePosition(readPosition, after, 'last page preserves latest reading position');
    assert(after.y > readPosition.y + 1000, 'long page really was prepended');
    console.log(`PASS ${engine}: archive paging positions ${JSON.stringify({ before, loading, readPosition, after })}`);
    await page.locator('#archive-back').tap();
    assert.equal(await page.locator('#archive-search').inputValue(), '归档方案');
    assert.equal(await page.locator('.archive-item').count(), 1);
    await page.locator('#archive-close').tap(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(page.url(), base);
    assert.equal(await page.evaluate(() => session), 'live');
    assert.equal(await chat.inputValue(), '保留未发送的草稿');
    assert.equal(await page.locator('#messages').textContent().then(t => t.includes('原对话仍然可见')), true);

    // A pending reader closed back to the filtered list is not allowed to
    // write data into the dialog, and a stale 401 after switching is inert.
    await page.locator('#menu').tap(); await open(); await waitRequest(8); await reply(7, ashItems);
    await page.locator('.archive-item').first().tap(); await waitRequest(9);
    await page.locator('#archive-back').tap(); assert.equal((await request(8)).aborted, true);
    await reply(8, { messages: [{ role: 'assistant', text: '旧历史不应显示' }], nextOffset: null });
    assert.equal(await messages.count(), 0);
    await page.locator('.archive-item').first().tap(); await waitRequest(10);
    await page.evaluate(() => { const select = document.getElementById('devices'); select.value = 'two'; select.dispatchEvent(new Event('change')); });
    await dialog.waitFor({ state: 'hidden' }); assert.equal((await request(9)).aborted, true);
    await page.waitForFunction(() => device === 'two' && capabilities.archivedHistory === true);
    await open(); await waitRequest(11); assert.equal((await request(10)).path, '/mobile/api/devices/two/rpc');
    await reply(9, { error: 'Expired old request' }, 401);
    await reply(10, [{ id: 'shared-id', title: '电脑二的目录', cwd: '/other' }]);
    await page.locator('.archive-item').waitFor();
    assert.equal(await page.locator('.archive-item').textContent(), '电脑二的目录/other');
    assert.equal(await page.locator('#archive-search').inputValue(), '');
    await page.locator('.archive-item').tap(); await waitRequest(12);
    await page.evaluate(() => start('fixture-two'));
    assert.equal((await request(11)).aborted, true);
    await reply(11, { messages: [{ role: 'assistant', text: '旧账号历史' }], nextOffset: null });
    await dialog.waitFor({ state: 'hidden' }); assert.equal(await messages.count(), 0);
    await page.selectOption('#devices', 'old');
    await page.waitForFunction(() => capabilitiesDevice === 'old');
    assert.equal(await page.locator('#archive-open').isVisible(), false);
    assert.equal(await page.evaluate(() => archiveRequests.length), 12);
    assert(!requested.some(url => /not-for-navigation|unarchive/.test(url)));
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine}: ${width}px archive list/search, safe Markdown, empty and older pages, draft and history isolation, read retries, late close/device/account responses, strict capability gate`);
  } finally { await browser.close(); }
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/mobile/`;
    for (const engine of process.env.ARCHIVE_ENGINE ? [process.env.ARCHIVE_ENGINE] : ['chromium', 'webkit']) await check(engine, base);
  } finally { server.closeAllConnections(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
