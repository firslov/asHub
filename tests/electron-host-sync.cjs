// Native browser EventSource -> actual isolated startHub -> real sidebar and
// project modules. All mutations use fixture sessions in the harness temp home.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const actualRoot = process.env.ASHUB_TEST_ROOT || path.resolve(__dirname, '..');
const { env, Bridge } = require(path.join(actualRoot, 'tests/harness.cjs'));
const webRoot = path.resolve(__dirname, '../web');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-host-sync-ui-'));
app.setPath('userData', tmp);
// Explicit exit below must report assertion failures even after cleanup closes
// the hidden last window; Electron's default would otherwise exit early.
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('Host sync UI watchdog'); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  const e = env(); e.context.process.env.ASHUB_TOKEN = 'host-sync-fixture-only';
  const headers = { Authorization: 'Bearer host-sync-fixture-only', 'Content-Type': 'application/json' };
  let hub, proxy, win, coreBase = '', hostStreams = 0, snapshots = 0, held = null, delayNextSessions = false;
  const streams = new Set();
  const bridges = [];
  const boot = async () => {
    hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot, makeBridge: options => { const bridge = new Bridge(options); bridges.push(bridge); return bridge; } });
    await once(hub.server, 'listening'); coreBase = `http://127.0.0.1:${hub.server.address().port}`;
  };
  const api = async (route, body) => {
    const response = await fetch(coreBase + route, { headers, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
    const text = await response.text(); assert(response.ok, `${route}: ${response.status} ${text}`); return text ? JSON.parse(text) : null;
  };
  try {
    await boot();
    const a = await api('/sessions', { cwd: e.dir }), b = await api('/sessions', { cwd: e.dir });
    await api(`/${a.instanceId}/title`, { title: 'First task' }); await api(`/${b.instanceId}/title`, { title: 'Second task' });
    const project = (await api('/api/projects', { action: 'create', name: 'Sync project', cwd: e.dir }))[0];
    proxy = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      // Strip the page's client bundle to isolate only the real modules under
      // test; API responses and host SSE still come from the actual core.
      const filename = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (filename.startsWith(webRoot + path.sep) && fs.existsSync(filename) && fs.statSync(filename).isFile()) {
        let content = fs.readFileSync(filename);
        if (filename.endsWith('.html')) content = content.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
        res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(content); return;
      }
      if (pathname === '/api/host/snapshot') snapshots++;
      const hold = pathname === '/sessions' && delayNextSessions; if (hold) delayNextSessions = false;
      const upstream = http.request(coreBase + req.url, { method: req.method, headers: { ...req.headers, host: new URL(coreBase).host, authorization: headers.Authorization } }, upstreamResponse => {
        if (hold) {
          let text = ''; upstreamResponse.setEncoding('utf8'); upstreamResponse.on('data', chunk => { text += chunk; });
          upstreamResponse.on('end', () => { held = () => { res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers); res.end(text); }; });
          return;
        }
        if (pathname === '/api/host/events') { hostStreams++; streams.add(res); res.once('close', () => streams.delete(res)); }
        res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers); upstreamResponse.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.once('close', () => upstream.destroy()); req.pipe(upstream);
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    win = new BrowserWindow({ show: false, width: 1180, height: 850, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('renderer:', event.message); });
    await win.loadURL(`http://127.0.0.1:${proxy.address().port}`);
    const js = script => win.webContents.executeJavaScript(script);
    const wait = async (script, attempts = 500) => {
      for (let i = 0; i < attempts; i++) { if (await js(script)) return; await new Promise(resolve => setTimeout(resolve, 20)); }
      const state = await js(`({sync:window.hostSync?.state,projectHidden:document.getElementById('projects').hidden,projects:document.getElementById('projects').textContent,sessionIds:[...document.querySelectorAll('#sessions li[data-session-id]')].map(n=>n.dataset.sessionId)})`);
      throw Error('UI timeout: ' + script + '\n' + JSON.stringify({ state, hostStreams, snapshots }));
    };
    await js(`Object.defineProperty(document,'hidden',{get:()=>false});document.getElementById('page-loader')?.remove();localStorage.setItem('ash.lang','en');(async()=>{await import('/js/sidebar.js');const p=await import('/js/projects.js');p.showProjects(true);const h=await import('/js/host-sync.js');window.hostSync=h.initializeHostSync();window.sameHostSync=h.initializeHostSync()===window.hostSync;})()`);
    await wait(`window.hostSync?.state.applied && document.querySelectorAll('#sessions li[data-session-id]').length===2 && document.querySelector('.project-group')`);
    assert.equal(await js('window.sameHostSync'), true); assert.equal(hostStreams, 1);
    // Preserve both a project management draft and the active conversation's
    // composer/tab state while another client changes membership.
    await js(`(async()=>{const m=await import('/js/session-manager.js');window.removes=0;window.conversation={id:${JSON.stringify(a.instanceId)},remove(){window.removes++}};m.sessions.set(window.conversation.id,window.conversation);m.openTabs.value=[window.conversation.id];m.activeSessionId.value=window.conversation.id;document.getElementById('query').value='unsent conversation draft';document.querySelector('.project-group .project-manage').click();window.draftDialog=document.querySelector('dialog');window.draftInput=window.draftDialog.querySelector('input');window.draftInput.value='unsaved project draft';})()`);
    delayNextSessions = true; await js(`document.dispatchEvent(new CustomEvent('ash:sessions-changed'))`);
    for (let i = 0; i < 200 && !held; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(held, 'failed to hold an actual stale /sessions response');
    await api('/api/projects', { action: 'members', id: project.id, add: [a.instanceId] });
    await wait(`!!document.querySelector('.project-chat[href="/${a.instanceId}/"]') && !document.querySelector('#sessions [data-session-id="${a.instanceId}"]')`);
    held(); held = null; await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await js(`!!document.querySelector('#sessions [data-session-id="${a.instanceId}"]')`), false, 'stale response restored a project member to the standalone sidebar');
    assert.equal(await js(`document.querySelector('dialog')===window.draftDialog && document.activeElement===window.draftInput && window.draftInput.value==='unsaved project draft'`), true);
    assert.equal(await js(`document.getElementById('query').value`), 'unsent conversation draft');
    assert.equal(await js(`import('/js/session-manager.js').then(m=>m.sessions.get(window.conversation.id)===window.conversation && m.openTabs.value.length===1 && window.removes===0)`), true);
    // Metadata changes need to invalidate the store even if title, processing,
    // membership and timestamps are unchanged. Hide projects so their fallback
    // polling cannot conceal a sidebar hash that omits model/reasoning/error.
    await js(`import('/js/sidebar.js').then(m=>{m.sidebarView.value='sessions'})`);
    bridges[0].emit('event', { name: 'agent:info', payload: { model: 'fixture-model', provider: 'fixture-provider', thinkingLevel: 'high' } });
    bridges[0].emit('event', { name: 'agent:error', payload: { message: 'fixture terminal error' } });
    await wait(`import('/js/store.js').then(m=>m.allSessions.value.some(s=>s.instanceId===${JSON.stringify(a.instanceId)} && s.model==='fixture-model' && s.provider==='fixture-provider' && s.thinkingLevel==='high' && s.lastTurnError===true))`);
    await js(`import('/js/sidebar.js').then(m=>{m.sidebarView.value='projects'})`);
    // Disconnect the real SSE transport, mutate while it is down, then let
    // native EventSource reconnect. No local sessions-changed signal is sent.
    const beforeStreams = hostStreams, beforeSnapshots = snapshots;
    for (const response of [...streams]) response.end();
    await api('/api/projects', { action: 'members', id: project.id, remove: [a.instanceId], add: [b.instanceId] });
    await wait(`!!document.querySelector('.project-chat[href="/${b.instanceId}/"]') && !document.querySelector('.project-chat[href="/${a.instanceId}/"]')`);
    assert(hostStreams > beforeStreams, 'native EventSource did not reconnect'); assert(snapshots > beforeSnapshots, 'reconnect did not refetch the snapshot');
    const oldEpoch = await js('window.hostSync.state.applied.epoch');
    await hub.shutdown(); await boot();
    await wait(`window.hostSync.state.applied?.epoch!==${JSON.stringify(oldEpoch)}`);
    assert.equal(await js(`document.querySelector('dialog')===window.draftDialog && window.draftInput.value==='unsaved project draft'`), true);
    // Browser back/forward page lifecycle must close, then create one stream.
    await js(`dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}))`);
    await wait(`window.hostSync.state.running===false`);
    const beforeResume = hostStreams;
    await js(`dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))`);
    await wait(`window.hostSync.state.applied!==null`);
    assert.equal(hostStreams, beforeResume + 1);
    for (const width of [1180, 390]) {
      win.setContentSize(width, 850); await new Promise(resolve => setTimeout(resolve, 40));
      const bounds = await js(`(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,overflow:d.scrollWidth-d.clientWidth}})()`);
      assert(bounds.left >= 0 && bounds.right <= bounds.width && bounds.overflow <= 1, JSON.stringify(bounds));
    }
    console.log('PASS actual core HTTP host SSE -> native EventSource -> desktop membership/sidebar/metadata refresh; stale read rejection, drafts/focus/active view, reconnect snapshot, new epoch, bfcache and mobile layout');
  } finally {
    held?.(); win?.destroy();
    for (const response of streams) response.end();
    proxy?.closeAllConnections(); await new Promise(resolve => proxy ? proxy.close(resolve) : resolve());
    await hub?.shutdown(); clearTimeout(watchdog); fs.rmSync(tmp, { recursive: true, force: true });
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
