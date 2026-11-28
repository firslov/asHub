// Exercise the real project conversation picker against a loopback-only fixture API.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const root = path.resolve(__dirname, '../web');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-project-task-backend-'));
const userData = path.join(tmp, 'userData');
fs.mkdirSync(userData);
app.setPath('userData', userData);
app.setPath('sessionData', userData);

const project = { id: 'project', name: 'Fixture project', cwd: '/workspace/fixture', sessionIds: [] };
const backend = { id: 'google-antigravity', label: 'Google Antigravity (Experimental)', taskProfile: 'inline-review' };
const model = { id: 'fixture-model', thinkingLevels: ['high'] };
const rejection = 'Fixture: creation rejected';
const submissions = [];
let advertiseBackend = true, backendRequests = 0;

async function serve(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const json = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  if (req.method === 'GET') {
    if (pathname === '/api/projects/session-backends') {
      backendRequests++;
      return advertiseBackend ? json({ backends: [backend] }) : json({ error: 'Not found' }, 404);
    }
    if (pathname === '/api/models') return json({ providers: [{ name: 'codex', models: [model] }] });
    if (pathname === '/api/projects') return json([project]);
    if (pathname === '/api/projects/workspaces') return json({});
    if (pathname === '/api/settings/network') return json({ proxyEnabled: true, sessions: {} });
    if (pathname === '/sessions') return json([]);
  }
  if (req.method === 'POST' && pathname === '/api/projects/session') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    submissions.push(JSON.parse(raw));
    // Stay in the dialog so switching back can be tested without opening a session.
    return json({ error: rejection }, 400);
  }
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root + path.sep) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    res.writeHead(404).end();
    return;
  }
  const type = path.extname(file);
  let content = fs.readFileSync(file);
  if (type === '.html') content = content.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  res.setHeader('Content-Type', type === '.js' ? 'text/javascript' : type === '.css' ? 'text/css' : 'text/html');
  res.end(content);
}

const watchdog = setTimeout(() => {
  console.error('Project task backend fixture timed out');
  app.exit(1);
}, 30000);

app.whenReady().then(async () => {
  let server, win, serverError;
  try {
    server = http.createServer((req, res) => {
      serve(req, res).catch(error => {
        serverError = error;
        res.writeHead(500).end();
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    win = new BrowserWindow({ show: false, width: 1180, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadURL(`http://127.0.0.1:${server.address().port}`);
    const js = source => win.webContents.executeJavaScript(source);
    const wait = async condition => {
      for (let i = 0; i < 150; i++) {
        if (serverError) throw serverError;
        if (await js(condition)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error(`UI timeout: ${condition}`);
    };
    const query = selector => `document.querySelector(${JSON.stringify(selector)})`;
    const click = selector => js(`${query(selector)}.click()`);
    const toggle = 'dialog .project-model-toggle';
    const hint = '#project-task-backend-hint';
    const checkout = 'dialog input[type=checkbox]';
    const primary = 'dialog .primary';
    const option = label => `[...document.querySelectorAll('dialog .project-model-option')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
    const visible = selector => `!!${query(selector)}?.getClientRects().length`;
    const choiceVisibility = `[...document.querySelectorAll('dialog .project-choices')].map(el => !!el.getClientRects().length)`;
    const openCreate = async () => {
      await click('.project-heading .project-more');
      await click('.project-group .project-manage');
      await click('dialog .project-add-conversation');
      await wait(`!!${query(toggle)}`);
    };
    const submit = async () => {
      await click(primary);
      await wait(`${query('dialog .project-error')}?.textContent === ${JSON.stringify(rejection)} && !${query(primary)}.disabled`);
    };

    await js(`(async () => {
      document.getElementById('page-loader')?.remove();
      localStorage.setItem('ash.lang', 'en');
      window.reviewEnabled = false;
      window.reviewWrites = [];
      window.electronAPI = { antigravityReviewPolicy: async (id, enabled) => {
        if (enabled !== undefined) { window.reviewEnabled = enabled; window.reviewWrites.push([id, enabled]); }
        return { available: true, enabled: window.reviewEnabled };
      } };
      (await import('/js/projects.js')).showProjects(true);
    })()`);
    await wait(`!!${query('.project-toggle')}`);
    await click('.project-toggle');
    await wait(`!!${query('.project-heading .project-more')}`);
    await openCreate();
    await click(toggle);
    await wait(`!!${option(backend.label)} && !!${option(model.id + 'codex')}`);
    assert.equal(backendRequests, 1);

    // Set normal choices first to catch leakage of stale configuration into a task POST.
    await js(`${option(model.id + 'codex')}.click()`);
    await click(checkout);
    await js(`document.querySelectorAll('dialog .project-choices').forEach(group => group.lastElementChild.click())`);
    await click(toggle);
    await js(`${option(backend.label)}.click()`);
    assert.equal(await js(`${query(toggle)}.textContent`), backend.label);
    assert.equal(await js(`${query(toggle)}.getAttribute('aria-describedby')`), hint.slice(1));
    assert.equal(await js(visible(hint)), true);
    assert.match(await js(`${query(hint)}.textContent`), /reviews only the text provided.*cannot open or edit project files/i);
    const reviewControl = '.project-review-toggle';
    await wait(visible(reviewControl));
    assert.equal(await js(`${query(reviewControl)}.getAttribute('aria-pressed')`), 'false');
    assert.deepEqual(await js('window.reviewWrites'), [], 'opening the dialogs and choosing the model must not grant access');
    const description = await js(`document.getElementById(${query(reviewControl)}.getAttribute('aria-describedby')).textContent`);
    assert.match(description, /send review task text to Google without asking each time/i);
    assert.match(description, /does not attach chat history or files or grant local tool access/i);
    await click(reviewControl);
    await wait(`${query(reviewControl)}.getAttribute('aria-pressed')==='true'`);
    assert.deepEqual(await js('window.reviewWrites'), [[project.id, true]]);
    assert.equal(await js(visible(checkout)), false);
    assert.equal(await js(`${query(checkout)}.disabled`), true);
    assert.deepEqual(await js(choiceVisibility), [false, false], 'thinking and proxy controls must be hidden');
    await submit();
    assert.deepEqual(submissions, [{ projectId: project.id, cwd: project.cwd, backend: backend.id }]);

    // Selecting the regular model again restores normal controls and request shape.
    await click(toggle);
    await js(`${option(model.id + 'codex')}.click()`);
    assert.equal(await js(visible(hint)), false);
    assert.equal(await js(visible(reviewControl)), false);
    assert.equal(await js(`${query(toggle)}.hasAttribute('aria-describedby')`), false);
    assert.equal(await js(visible(checkout)), true);
    assert.equal(await js(`${query(checkout)}.disabled`), false);
    assert.deepEqual(await js(choiceVisibility), [true, true]);
    await submit();
    assert.deepEqual(submissions[1], { projectId: project.id, cwd: project.cwd, isolated: true,
      model: model.id, provider: 'codex', thinking: 'default', proxyEnabled: false });

    // Older hosts may not expose the advertisement route at all.
    await js(`${query('dialog')}.close()`);
    await wait(`!${query('dialog')}`);
    await click('.project-heading .project-more');
    await click('.project-group .project-manage');
    await wait(visible(reviewControl));
    assert.equal(await js(`${query(reviewControl)}.getAttribute('aria-pressed')`), 'true');
    const actionStyles = () => js(`(() => {
      const buttons = [...document.querySelectorAll('dialog button')];
      const peers = [buttons.find(b => b.textContent.trim() === 'Choose folder'),
        ${query('dialog .project-add-conversation')}, ${query(reviewControl)}];
      return peers.map(button => {
        const style = getComputedStyle(button), rect = button.getBoundingClientRect();
        return [rect.x, rect.width, style.minHeight, style.padding, style.border, style.borderRadius, style.backgroundColor, style.fontSize];
      });
    })()`);
    for (const width of [1180, 390]) {
      win.setContentSize(width, 850);
      await wait(`window.innerWidth === ${width}`);
      const [browse, add, review] = await actionStyles();
      assert.deepEqual(review, browse, `review and folder button styles at ${width}px`);
      assert.deepEqual(review, add, `review and add button styles at ${width}px`);
    }
    await click(reviewControl);
    await wait(`${query(reviewControl)}.getAttribute('aria-pressed')==='false'`);
    assert.deepEqual(await js('window.reviewWrites'), [[project.id, true], [project.id, false]]);
    await js(`${query('dialog')}.close()`);
    await wait(`!${query('dialog')}`);
    advertiseBackend = false;
    await openCreate();
    await click(toggle);
    await wait(`!!${option(model.id + 'codex')}`);
    assert.equal(backendRequests, 2);
    assert.equal(await js(`!!${option(backend.label)}`), false);
    assert.equal(await js(visible(hint)), false);
    await submit();
    assert.deepEqual(submissions[2], { projectId: project.id, cwd: project.cwd, isolated: false });
    assert.equal(submissions.length, 3);
    console.log('PASS project task backend advertisement, inline authorization, shared button styling, minimal POST, and normal fallback');
  } finally {
    win?.destroy();
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    clearTimeout(watchdog);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
