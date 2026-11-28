const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { env, Bridge, fs, path, root } = require('./harness.cjs');

const fixture = env();
app.setPath('userData', path.join(fixture.dir, 'browser'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => app.exit(1), 30000);

app.whenReady().then(async () => {
  let hub, win;
  try {
    let starts = 0;
    hub = fixture.hub().startHub({
      host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'),
      makeBridge: opts => Object.assign(new Bridge(opts), { backendId: 'ash' }),
      makeAntigravityBridge: opts => {
        if (++starts === 1) throw Error('Fixture: Google sign-in required');
        return Object.assign(new Bridge(opts), { backendId: 'acp', readOnlyContext: true });
      },
    });
    await once(hub.server, 'listening');
    const base = 'http://127.0.0.1:' + hub.server.address().port;
    const api = async (route, body) => {
      const res = await fetch(base + route, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert(res.ok, route + ': ' + res.status);
      return res.json();
    };
    const empty = await api('/sessions', { cwd: fixture.dir });
    const existing = await api('/sessions', { cwd: fixture.dir });
    await api('/api/projects', { action: 'create', name: 'Fixture', cwd: fixture.dir, add: [existing.instanceId] });
    const preload = path.join(fixture.dir, 'preload.cjs');
    fs.writeFileSync(preload, `
      const ignore = () => {};
      require('electron').contextBridge.exposeInMainWorld('electronAPI', {
        pickDirectory: async () => ({ cancelled: true }),
        onUpdateAvailable: ignore, onUpdateDownloadProgress: ignore, onUpdateDownloaded: ignore, onUpdateError: ignore,
      });
    `);
    win = new BrowserWindow({
      show: false, width: 1180, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload },
    });
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('renderer:', event.message); });
    const js = expression => win.webContents.executeJavaScript(expression);
    const wait = async expression => {
      for (let i = 0; i < 160; i++) {
        if (await js(expression)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const state = await js(`[...window.__ash.sessions.values()].map(s=>({id:s.id,kind:s.kind,hasHistory:s.hasHistory,replaying:s.state.replaying}))`);
      throw Error('UI timeout: ' + expression + ' ' + JSON.stringify(state));
    };
    await win.loadURL(base + '/' + empty.instanceId + '/');
    await js(`(async () => {
      (await import('/js/i18n.js')).setLang('zh');
      (await import('/js/sse.js')).setModelCache({providers:[{name:'gemini',models:[{id:'gemini-fixture'}]}]});
    })()`);
    const shown = selector => `!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`;
    const changeView = view => js(`
      document.getElementById('sidebar-view-select').click();
      document.querySelector('.sidebar-view-option[data-view="${view}"]').click();
    `);
    const createButton = '#sidebar-create';
    await js("window.originalCreate = document.querySelector('#sidebar-create')");
    for (const [view, label] of [['projects', '新建项目'], ['terminals', '新建终端'], ['sessions', '新建会话']]) {
      await changeView(view);
      assert(await js(shown(createButton)));
      assert(await js("document.querySelector('#sidebar-create') === window.originalCreate"));
      assert.equal(await js("document.querySelector('#sidebar-create').getAttribute('aria-label')"), label);
      assert.equal(await js("document.querySelector('#sidebar-create').title"), label);
      assert.equal(await js(shown('#sidebar-search-toggle')), view !== 'terminals');
      if (view === 'projects') {
        await js("document.querySelector('#sidebar-create').click()");
        assert.equal(await js("document.querySelector('dialog[open] h2').textContent"), label);
        await js("document.querySelector('dialog[open]').close()");
        await wait("!document.querySelector('dialog')");
        assert(await js(`(() => {
          const picker = document.getElementById('sidebar-view-select');
          picker.focus();
          picker.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key: 'n' }));
          return !!document.querySelector('dialog[open]');
        })()`), 'Ctrl+N opens the project dialog while the view selector has focus');
        await js("document.querySelector('dialog[open]').close()");
        await wait("!document.querySelector('dialog')");
      }
    }
    assert.equal(await js("document.querySelector('#new-session, #new-terminal, .project-add, #new-session-options')"), null);
    assert(await js(`(() => {
      const picker = document.querySelector('#sidebar-view-select').getBoundingClientRect();
      const plus = document.querySelector('#sidebar-create').getBoundingClientRect();
      const search = document.querySelector('#sidebar-search-toggle').getBoundingClientRect();
      return picker.right <= plus.left && plus.right <= search.left && plus.width === search.width && plus.height === search.height;
    })()`));

    win.setContentSize(390, 850);
    await wait('innerWidth === 390');
    await js(`(() => {
      if (document.querySelector('.app').classList.contains('sidebar-collapsed')) document.getElementById('sidebar-toggle').click();
      const originalFetch = window.fetch;
      window.restoreCreationFetch = () => { window.fetch = originalFetch; };
      window.fetch = (url, options) => {
        if (url !== '/sessions' || options?.method !== 'POST') return originalFetch(url, options);
        window.creationFailed = true;
        return Promise.resolve(new Response('Fixture: creation failed', { status: 503 }));
      };
      document.getElementById('sidebar-create').click();
    })()`);
    await wait("window.creationFailed && !document.getElementById('sidebar-create').disabled");
    assert(await js("!document.querySelector('.app').classList.contains('sidebar-collapsed')"),
      'failed creation leaves the narrow sidebar open for retry');
    await js('window.restoreCreationFetch()');
    win.setContentSize(1180, 850);
    await wait('innerWidth === 1180');

    const chip = "document.querySelector('session-view:not([hidden]) .usage-model-balance')";
    const picker = '.model-dropdown:not([hidden])';
    const special = picker + ' .model-antigravity';
    const openPicker = async id => {
      await wait(`window.__ash.sessions.get('${id}')?.hasHistory === false && !window.__ash.sessions.get('${id}')?.state.replaying`);
      await wait(`${chip} && !${chip}.hidden && !${chip}.disabled`);
      // HTMLElement.click() skips focus; model the focused button activation so
      // a pending composer refocus from the tab switch cannot cancel this open.
      await js(`(() => { const button = ${chip}; button.focus(); button.click(); })()`);
      await wait(shown(picker));
    };
    await openPicker(empty.instanceId);
    assert(await js(shown(special)));
    assert.match(await js(`document.querySelector('${special}').textContent`), /不支持 asHub 插件/);
    assert(await js(shown(picker + ' [data-provider=gemini][data-model]')));
    await js(`
      const search = document.querySelector('.model-search-input');
      search.value = 'gemini-fixture';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    assert(!await js(shown(special)));
    await js(`window.__ash.openTab('${existing.instanceId}')`);
    await openPicker(existing.instanceId);
    assert(!await js(shown(special)), 'the shared picker must hide Antigravity in a project conversation');
    await js(`window.currentPicker = document.querySelector('${picker}');`);
    const searchModels = query => js(`(() => {
      const search = document.querySelector('.model-search-input');
      search.focus();
      search.value = ${JSON.stringify(query)};
      search.setSelectionRange(0, 1);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const checkSearch = query => js(`(() => {
      const menu = document.querySelector('${picker}');
      const search = menu?.querySelector('.model-search-input');
      return menu === window.currentPicker && document.activeElement === search &&
        search.value === ${JSON.stringify(query)} && search.selectionStart === 0 && search.selectionEnd === 1;
    })()`);
    const [project] = await api('/api/projects');
    const setProjectMember = async (attached) => {
      await api('/api/projects', {
        action: 'edit', id: project.id, name: project.name, [attached ? 'add' : 'remove']: [existing.instanceId],
      });
      await wait(`(async () => (await import('/js/store.js')).getSession('${existing.instanceId}')?.projectId === ${JSON.stringify(attached ? project.id : null)})()`);
    };
    await searchModels('acp');
    await setProjectMember(false);
    assert(await js(shown(special)), 'detaching a project member updates the open picker');
    assert(await checkSearch('acp'), 'detaching preserves the focused search and selection');
    await setProjectMember(true);
    assert(!await js(shown(special)), 'attaching a project member hides the open picker option');
    assert(await checkSearch('acp'), 'attaching preserves the focused search and selection');
    await searchModels('gemini-fixture');
    await setProjectMember(false);
    assert(!await js(shown(special)), 'a non-matching search still hides the eligible option');
    assert(await checkSearch('gemini-fixture'), 'refresh keeps a non-matching search and its focus');
    await searchModels('acp');
    assert(await js(shown(special)));
    await js(`document.querySelector('${special}').focus()`);
    await setProjectMember(true);
    assert(!await js(shown(special)));
    assert(await checkSearch('acp'), 'focus returns to the search when the focused option becomes ineligible');

    await js(`window.__ash.switchTo('${empty.instanceId}'); document.getElementById('query').value = '保留这段草稿';`);
    await openPicker(empty.instanceId);
    await js(`document.querySelector('${special}').click()`);
    await wait("document.body.textContent.includes('Google sign-in required')");
    assert.equal(await js('window.__ash.activeSessionId.peek()'), empty.instanceId);
    assert.equal(await js("document.getElementById('query').value"), '保留这段草稿');

    await openPicker(empty.instanceId);
    await js(`document.querySelector('${special}').click()`);
    await wait("document.querySelector('session-view:not([hidden])')?.kind === 'antigravity'");
    assert.equal(await js("document.getElementById('query').value"), '保留这段草稿');
    assert.match(await js(`document.querySelector('session-view:not([hidden]) .welcome-description').textContent`), /不支持 asHub 插件/);
    assert.match(await js("document.getElementById('composer-help').textContent"), /不支持 asHub 插件/);
    assert.equal(await js(chip + '.disabled'), true);
    const active = await js('window.__ash.activeSessionId.peek()');
    assert.deepEqual(await js('window.__ash.openTabs.peek()'), [active, existing.instanceId]);
    assert.equal(await js('location.pathname'), '/' + active + '/');
    const sessions = await api('/sessions');
    assert(!sessions.some(session => session.instanceId === empty.instanceId));
    assert.equal(sessions.find(session => session.instanceId === active).kind, 'antigravity');
    // A session-scoped asHub proxy policy cannot change the independent ACP route.
    const ordinaryProxyFixture = await api('/sessions', {cwd: fixture.dir});
    await wait(`!!document.querySelector('#sessions li[data-session-id="${active}"]') && !!document.querySelector('#sessions li[data-session-id="${ordinaryProxyFixture.instanceId}"]')`);
    assert(await js(`!!document.querySelector('#sessions li[data-session-id="${ordinaryProxyFixture.instanceId}"] .session-proxy')`), 'ordinary conversations retain the proxy action');
    await wait(`!document.querySelector('#sessions li[data-session-id="${ordinaryProxyFixture.instanceId}"] .session-proxy').disabled`);
    const originalPolicy=await api('/api/settings/network');
    const expectedProxy=!(originalPolicy.sessions[ordinaryProxyFixture.instanceId] ?? originalPolicy.proxyEnabled);
    await js(`document.querySelector('#sessions li[data-session-id="${ordinaryProxyFixture.instanceId}"] .session-proxy').click()`);
    for(let n=0;n<100;n++) {const policy=await api('/api/settings/network');if(policy.sessions[ordinaryProxyFixture.instanceId]===expectedProxy)break;await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal((await api('/api/settings/network')).sessions[ordinaryProxyFixture.instanceId],expectedProxy,'ordinary conversation proxy action still saves');

    assert(!await js(`!!document.querySelector('#sessions li[data-session-id="${active}"] .session-proxy')`), 'ACP conversations must not expose an ineffective proxy action');
    assert.match(await js("document.querySelector('session-view:not([hidden]) .welcome-description').textContent"), /代理.*(?:CLI|系统|环境)/);
    // Reconciliation updates an existing row if its authoritative kind changes.
    await js(`(()=>{const native=window.fetch;window.proxyAuditKind='antigravity';window.restoreProxyAudit=()=>window.fetch=native;window.fetch=async(url,opts)=>{const response=await native(url,opts);if(String(url)!=='/sessions'||opts?.method)return response;const list=await response.json();return new Response(JSON.stringify(list.map(s=>s.instanceId===${JSON.stringify(ordinaryProxyFixture.instanceId)}?{...s,kind:window.proxyAuditKind}:s)),{status:200,headers:{'Content-Type':'application/json'}})};document.dispatchEvent(new CustomEvent('ash:host-state-changed',{detail:{domains:['sessions']}}));})()`);
    await wait(`!document.querySelector('#sessions li[data-session-id="${ordinaryProxyFixture.instanceId}"] .session-proxy')`);
    await js(`window.proxyAuditKind='agent';document.dispatchEvent(new CustomEvent('ash:host-state-changed',{detail:{domains:['sessions']}}))`);
    await wait(`!!document.querySelector('#sessions li[data-session-id="${ordinaryProxyFixture.instanceId}"] .session-proxy')`);
    await js('window.restoreProxyAudit();void 0');



    await js('history.back()');
    await wait(`location.pathname === '/${existing.instanceId}/'`);
    await js('history.back()');
    await wait(`location.pathname === '/${active}/'`);
    assert.equal(await js('window.__ash.activeSessionId.peek()'), active);
    await js('history.forward()');
    await wait(`location.pathname === '/${existing.instanceId}/'`);
    await js('history.forward()');
    await wait(`location.pathname === '/${active}/'`);
    assert.equal(await js("document.getElementById('query').value"), '保留这段草稿');

    // Complete a second replacement while another tab is active.
    const deferred = await api('/sessions', { cwd: fixture.dir });
    await js(`window.__ash.openTab('${deferred.instanceId}')`);
    await wait(`window.__ash.activeSessionId.peek() === '${deferred.instanceId}'`);
    await js("document.getElementById('query').value='延迟会话草稿'");
    await openPicker(deferred.instanceId);
    await js(`(()=>{const native=window.fetch;window.restoreDeferred=()=>window.fetch=native;window.fetch=(url,opts)=>{const response=native(url,opts);if(String(url).endsWith('/backend'))return new Promise((resolve,reject)=>window.releaseDeferred=()=>response.then(resolve,reject));return response;};document.querySelector('${special}').click();})()`);
    await wait('typeof window.releaseDeferred === "function"');
    await js(`window.__ash.switchTo('${existing.instanceId}'); document.getElementById('query').value='另一个标签草稿';window.releaseDeferred();window.restoreDeferred();void 0`);
    await wait(`!window.__ash.sessions.has('${deferred.instanceId}')`);
    assert.equal(await js('window.__ash.activeSessionId.peek()'), existing.instanceId);
    assert.equal(await js("document.getElementById('query').value"), '另一个标签草稿');
    const replacement = (await api('/sessions')).find(s => s.kind === 'antigravity' && s.instanceId !== active).instanceId;
    await js('history.back()');
    await wait(`location.pathname === '/${replacement}/'`);
    assert.equal(await js('window.__ash.activeSessionId.peek()'), replacement);
    assert.equal(await js("document.getElementById('query').value"), '延迟会话草稿');
    await js('history.forward()');
    await wait(`location.pathname === '/${existing.instanceId}/'`);
    assert.equal(await js("document.getElementById('query').value"), '另一个标签草稿');
    win.webContents.reload();
    await once(win.webContents, 'did-finish-load');
    await wait('!!window.__ash?.activeSessionId');
    await js('history.back()');
    await wait(`location.pathname === '/${replacement}/'`);
    assert.equal(await js('window.__ash.activeSessionId.peek()'), replacement);

    const createIn = async view => {
      await changeView(view);
      const previous = win.webContents.getURL();
      await js("document.querySelector('#sidebar-create').click()");
      for (let i = 0; i < 160 && (win.webContents.getURL() === previous || win.webContents.isLoading()); i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.notEqual(win.webContents.getURL(), previous, await js("document.querySelector('.toast-stack')?.textContent ?? document.querySelector('#sidebar-create').title"));
      const id = new URL(win.webContents.getURL()).pathname.split('/')[1];
      return (await api('/sessions')).find(session => session.instanceId === id);
    };
    await js(`localStorage.setItem('ash.default-cwd', ${JSON.stringify(fixture.dir)})`);
    const ordinary = await createIn('sessions');
    assert.equal(ordinary.kind, 'agent');
    assert.equal(ordinary.cwd, fixture.dir);
    const terminal = await createIn('terminals');
    assert.equal(terminal.kind, 'terminal');
    assert.equal(terminal.cwd, ordinary.cwd);
    console.log('PASS shared creation button in all three views and draft-preserving Google switch');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    await hub?.shutdown();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
}).then(() => { clearTimeout(deadline); app.exit(0); }, error => {
  clearTimeout(deadline); console.error(error); app.exit(1);
});
