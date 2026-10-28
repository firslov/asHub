// Real Chromium rendering with local fixtures only; no user sessions or model calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-markdown-ui-'));
app.setPath('userData', profile);
const watchdog = setTimeout(() => app.exit(1), 30000);
const source = '**没有证据覆盖的部分默认“未检查”，不是默认通过。**正式库分别登记。';
let server, win;
app.whenReady().then(async () => {
  try {
    const desktop = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
    const scripts = desktop.match(/<script\b[^>]*src="(?:\/vendor\/(?:marked\.min|dompurify\.min|katex\/katex\.min)|\/js\/markdown-compat)\.js"[^>]*><\/script>/g);
    assert.equal(scripts.length, 4);
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        return res.end(`<!doctype html><meta charset="utf-8">${scripts.join('')}<article id="reply"></article>`);
      }
      const file = path.resolve(root, 'web', '.' + pathname);
      if (!file.startsWith(path.join(root, 'web') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404); return res.end();
      }
      res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const run = code => win.webContents.executeJavaScript(code);
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const result = await run(`(async () => {
      const { mdToHtml, renderMathIn } = await import('/js/utils.js');
      const { addReplyCopyBtn } = await import('/js/stream/reply.js');
      const raw = ${JSON.stringify(source)}, target = document.getElementById('reply');
      target.innerHTML = mdToHtml(raw);
      const strong = target.querySelector('strong')?.textContent;
      let copied = '';
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { copied = text; } } });
      addReplyCopyBtn(target, raw); target.querySelector('button').click(); await Promise.resolve();
      target.innerHTML = mdToHtml('$x^2$ ' + raw); renderMathIn(target);
      const math = !!target.querySelector('.katex');
      const mathBold = target.querySelector('strong')?.textContent;
      target.innerHTML = mdToHtml(raw + '<img src=x onerror="alert(1)"><script>alert(1)</' + 'script>');
      return { strong, copied, math, mathBold, unsafe: !!target.querySelector('script,[onerror]') };
    })()`);
    assert.equal(result.strong, '没有证据覆盖的部分默认“未检查”，不是默认通过。');
    assert.equal(result.copied, source);
    assert.equal(result.math, true);
    assert.equal(result.mathBold, result.strong);
    assert.equal(result.unsafe, false);
    console.log('PASS desktop Chromium rendering, math, sanitization and raw copying');
    if (fs.existsSync(path.join(root, 'remote'))) {
      await win.loadFile(path.join(root, 'remote/public/index.html'));
      const mobile = await run(`(() => {
        const raw = ${JSON.stringify(source)};
        for (const c of raw) chunk(c); finishReply();
        const live = $('messages').querySelector('.reply strong')?.textContent;
        const target = document.createElement('article');
        renderMarkdown(target, raw); const history = target.querySelector('strong')?.textContent;
        renderMarkdown(target, raw + '<img src=x onerror="alert(1)"><script>alert(1)</' + 'script>');
        return { live, history, unsafe: !!target.querySelector('script,img,[onerror]') };
      })()`);
      assert.equal(mobile.live, result.strong);
      assert.equal(mobile.history, result.strong);
      assert.equal(mobile.unsafe, false);
      console.log('PASS remote Chromium streaming, history rendering and sanitization');
    } else console.log('SKIP remote website is not included in this checkout');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}).then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  clearTimeout(watchdog);
  fs.rmSync(profile, { recursive: true, force: true });
  app.exit(code);
}
