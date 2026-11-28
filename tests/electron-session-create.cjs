const { app, BrowserWindow } = require('electron');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const { env, Bridge, fs, path, root } = require('./harness.cjs');

const fixture = env();
app.setPath('userData', path.join(fixture.dir, 'browser'));
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => app.exit(1), 30000);

app.whenReady().then(async () => {
  const hub = fixture.hub().startHub({
    host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'),
    makeBridge: opts => Object.assign(new Bridge(opts), { backendId: 'ash' }),
  });
  let win;
  try {
    await once(hub.server, 'listening');
    const base = 'http://127.0.0.1:' + hub.server.address().port;
    const session = id => '/' + id + '/';
    const list = async (body) => {
      const response = await fetch(base + '/sessions', body ? {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      } : undefined);
      assert(response.ok, await response.clone().text());
      return response.json();
    };
    const first = (await list({ cwd: fixture.dir })).instanceId;
    const second = (await list({ cwd: fixture.dir })).instanceId;
    win = new BrowserWindow({
      show: false, width: 1180, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    await win.loadURL(base + session(first));
    const js = expression => win.webContents.executeJavaScript(expression);
    const wait = async expression => {
      for (let i = 0; i < 160; i++) {
        if (await js(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error('UI timeout: ' + expression);
    };
    const stateFor = id => `window.__ash?.activeSessionId.peek() === ${JSON.stringify(id)}`;
    const changeView = view => js(`
      document.getElementById('sidebar-view-select').click();
      document.querySelector('.sidebar-view-option[data-view="${view}"]').click();
    `);
    await wait(stateFor(first));
    await js(`localStorage.setItem('ash.default-cwd', ${JSON.stringify(fixture.dir)})`);

    const beginDelayedCreate = async (view) => {
      await changeView(view);
      await js(`(() => {
        const original = window.fetch;
        window.heldCreate = { count: 0 };
        window.fetch = async (url, options) => {
          if (url !== '/sessions' || options?.method !== 'POST') return original(url, options);
          heldCreate.count++;
          const response = await original(url, options);
          heldCreate.id = (await response.clone().json()).instanceId;
          await new Promise(resolve => { heldCreate.release = resolve; });
          return response;
        };
        heldCreate.restore = () => { window.fetch = original; };
        const button = document.getElementById('sidebar-create');
        button.click();
        button.click();
      })()`);
      await wait("typeof window.heldCreate?.release === 'function'");
      return js('heldCreate.id');
    };
    const writeDraft = draft => js(`(() => {
      const input = document.getElementById('query');
      input.value = ${JSON.stringify(draft)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const finishDelayedCreate = async (active, draft, created, kind, previousCount) => {
      await js('heldCreate.release()');
      await wait("!document.getElementById('sidebar-create').disabled");
      // Give any full-document navigation scheduled by the handler a chance
      // to begin before comparing the current URL and composer.
      await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))');
      assert.equal(new URL(win.webContents.getURL()).pathname, session(active), 'late creation steals navigation');
      assert(await js(stateFor(active)));
      assert.equal(await js("document.getElementById('query').value"), draft);
      assert.equal(await js('heldCreate.count'), 1);
      await js('heldCreate.restore()');
      const sessions = await list();
      assert.equal(sessions.length, previousCount + 1);
      assert.equal(sessions.find(item => item.instanceId === created)?.kind, kind);
    };

    const delayedChat = await beginDelayedCreate('sessions');
    await js(`window.__ash.openTab('${second}')`);
    await wait(stateFor(second));
    await writeDraft('Keep the other conversation draft');
    await finishDelayedCreate(second, 'Keep the other conversation draft', delayedChat, 'agent', 2);

    const delayedTerminal = await beginDelayedCreate('terminals');
    await js(`window.__ash.openTab('${first}'); window.__ash.switchTo('${second}');`);
    await writeDraft('Keep the draft when I return');
    await finishDelayedCreate(second, 'Keep the draft when I return', delayedTerminal, 'terminal', 3);

    for (const [view, kind] of [['sessions', 'agent'], ['terminals', 'terminal']]) {
      await changeView(view);
      const loaded = once(win.webContents, 'did-finish-load');
      await js("document.getElementById('sidebar-create').click()");
      await loaded;
      const id = new URL(win.webContents.getURL()).pathname.split('/')[1];
      assert.equal((await list()).find(item => item.instanceId === id)?.kind, kind);
      await wait(stateFor(id));
    }
    assert.equal((await list()).length, 6);
    console.log('PASS session creation opens normal chat and terminal, and late responses preserve navigation and drafts');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    await hub.shutdown();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
}).then(() => { clearTimeout(watchdog); app.exit(0); }, error => {
  clearTimeout(watchdog);
  console.error(error);
  app.exit(1);
});
