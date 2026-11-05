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
  let hub, proxy, win, coreBase = '', hostStreams = 0, snapshots = 0, snapshotStream = 0, held = null, delayNextSessions = false;
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
      if (pathname === '/api/host/snapshot') { snapshots++; snapshotStream = hostStreams; }
      const hold = pathname === '/sessions' && delayNextSessions; if (hold) delayNextSessions = false;
      const upstream = http.request(coreBase + req.url, { method: req.method, headers: { ...req.headers, host: new URL(coreBase).host, authorization: headers.Authorization } }, upstreamResponse => {
        if (hold) {
          let text = ''; upstreamResponse.setEncoding('utf8'); upstreamResponse.on('data', chunk => { text += chunk; });
          upstreamResponse.on('end', () => { held = () => { res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers); res.end(text); }; });
          return;
        }
        if (pathname === '/api/host/events') { hostStreams++; streams.add(res); res.once('close', () => streams.delete(res)); }
        res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
        // Keep reconnect slower than an ordinary project refresh, as on CI.
        if (pathname === '/api/host/events') res.write('retry: 5000\n\n');
        upstreamResponse.pipe(res);
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
    // Finish A's pending focus restoration after B's real picker has opened.
    const pickerRetainedFocus = await js(`(async () => {
      const m = await import('/js/session-manager.js');
      const sse = await import('/js/sse.js');
      const chip = document.createElement('button');
      const wrap = document.createElement('div');
      wrap.className = 'terminal-wrap'; wrap.dataset.uiUsageModelShow = 'true';
      document.body.append(wrap); wrap.append(chip);
      const target = {id:${JSON.stringify(b.instanceId)}, state:{}, agentInfo:{}, modelEl:chip, modelPickerEl:wrap};
      m.sessions.set(target.id,target);
      sse.seedSessionInfo(target,{model:'fixture',provider:'deepseek'});
      sse.setModelCache({providers:[{name:'deepseek',models:[{id:'fixture'}]}]});
      m.activeSessionId.value = ${JSON.stringify(a.instanceId)};
      m.activeSessionId.value = target.id;
      chip.click();
      const search = document.querySelector('.model-dropdown:not([hidden]) .model-search-input');
      if (!search || document.activeElement !== search) throw Error('Fixture failed to focus the real picker');
      await new Promise(requestAnimationFrame);
      const retained = document.activeElement === search;
      search.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      // Hold two catalog reads across B -> A -> B, even after their abort signals.
      // Keyboard focus returns to the active composer before either reply arrives.
      const originalFetch = window.fetch;
      const replies = [];
      const input = document.getElementById('query');
      window.fetch = (url, ...args) => url === '/api/models'
        ? new Promise(resolve => replies.push(resolve))
        : originalFetch(url,...args);
      try {
        sse.invalidateModelCache();
        chip.click();
        m.activeSessionId.value = ${JSON.stringify(a.instanceId)};
        m.activeSessionId.value = target.id;
        chip.focus(); chip.click();
        if (replies.length !== 2) throw Error('Expected two distinct picker openings');
        input.focus();
        if (document.activeElement !== input) throw Error('Fixture composer did not receive focus');
        for (const reply of replies.reverse()) {
          reply(Response.json({providers:[{name:'deepseek',models:[{id:'fixture'}]}]}));
          await new Promise(resolve => setTimeout(resolve,0));
        }
        if (!document.querySelector('.model-dropdown').hidden || document.activeElement !== input)
          throw Error('Late catalog reopened the model picker or stole composer focus');
      } finally { window.fetch = originalFetch; }
      m.activeSessionId.value = ''; wrap.remove(); m.sessions.delete(target.id);
      return retained;
    })()`);
    assert.equal(pickerRetainedFocus,true,'late tab switch must not steal keyboard input from model search');
    await js(`(async () => {
      const m = await import('/js/session-manager.js');
      const {onReplayDone} = await import('/js/sse.js');
      await import('/js/session-view.js');
      const proto = customElements.get('session-view').prototype;
      const views = [${JSON.stringify(a.instanceId)}, ${JSON.stringify(b.instanceId)}].map(id => {
        // Mount the production scroll handler without subscribing these fixture tabs to SSE.
        const view = document.createElement('section');
        view.id = id; view.agentInfo = {};
        document.body.append(view);
        view.captureScrollPosition = proto.captureScrollPosition;
        proto.initStreamShell.call(view);
        const content = document.createElement('div');
        content.style.height = '1200px';
        view.streamEl.style.cssText = 'display:block;height:80px;overflow:auto';
        view.streamEl.replaceChildren(content);
        m.sessions.set(id,view);
        return view;
      });
      const [a,b] = views;
      try {
        m.activeSessionId.value = a.id; m.activeSessionId.value = b.id;
        b.streamEl.scrollTop = 200;
        if (a.streamEl.scrollHeight !== 0 || b.streamEl.scrollTop !== 200) throw Error('Invalid hidden replay fixture');
        onReplayDone(a);
        if (b.streamEl.scrollTop !== 200) throw Error('Inactive replay scrolled the active chat');
        m.activeSessionId.value = a.id;
        if (a.streamEl.scrollHeight - a.streamEl.clientHeight - a.streamEl.scrollTop > 1)
          throw Error('Returning to the chat lost the bottom position requested by replay');
        const {maybeScroll} = await import('/js/stream/scroll.js');
        m.activeSessionId.value = b.id;
        a.streamEl.firstChild.style.height = '1800px';
        maybeScroll(a);
        maybeScroll(a);
        if (b.streamEl.scrollTop !== 200) throw Error('Background streaming scrolled the visible chat');
        m.activeSessionId.value = a.id;
        if (a.streamEl.scrollHeight - a.streamEl.clientHeight - a.streamEl.scrollTop > 1)
          throw Error('Background streaming lost the bottom position after replay had finished');
        a.streamEl.scrollTop = 150;
        m.activeSessionId.value = b.id;
        await new Promise(requestAnimationFrame);
        a.streamEl.firstChild.style.height = '2400px';
        maybeScroll(a);
        m.activeSessionId.value = a.id;
        if (a.streamEl.scrollTop !== 150) throw Error('Tab switch overwrote manual reading position');
        a.streamEl.scrollTop = a.streamEl.scrollHeight;
        m.activeSessionId.value = b.id;
        await new Promise(requestAnimationFrame);
        a.streamEl.firstChild.style.height = '3000px';
        maybeScroll(a);
        m.activeSessionId.value = a.id;
        if (a.streamEl.scrollHeight - a.streamEl.clientHeight - a.streamEl.scrollTop > 1)
          throw Error('Scrolling back to bottom just before switching did not resume following');
        // Terminal mode hides the composer, giving the stream a taller viewport.
        document.querySelector('.app').append(a);
        const layout = document.createElement('div');
        layout.style.cssText = 'display:flex;flex-direction:column;height:240px';
        const composer = document.createElement('div');
        composer.className = 'live-input';
        composer.style.cssText = 'height:80px;flex:none';
        a.append(layout); layout.append(a.streamEl,composer);
        a.streamEl.style.cssText = 'flex:1;min-height:0;overflow:auto';
        m.setSessionKind(b.id,'terminal');
        m.activeSessionId.value = b.id;
        if (getComputedStyle(composer).display !== 'none') throw Error('Invalid terminal layout fixture');
        onReplayDone(a);
        m.activeSessionId.value = a.id;
        if (a.streamEl.scrollHeight - a.streamEl.clientHeight - a.streamEl.scrollTop > 1)
          throw Error('Returning from terminal measured the bottom before restoring the composer');
        // The user resizes their window in terminal mode; no chat event is needed.
        m.activeSessionId.value = b.id;
        layout.style.height = '180px';
        m.activeSessionId.value = a.id;
        if (a.streamEl.scrollHeight - a.streamEl.clientHeight - a.streamEl.scrollTop > 1)
          throw Error('Hidden resize detached a previously bottom-aligned conversation');
        a.streamEl.scrollTop = 150;
        m.activeSessionId.value = b.id;
        layout.style.height = '220px';
        m.activeSessionId.value = a.id;
        if (a.streamEl.scrollTop !== 150) throw Error('Hidden resize changed the manual reading position');
        // The streaming follow threshold must not snap a slightly raised reading position on switch.
        a.streamEl.scrollTop = a.streamEl.scrollHeight - a.streamEl.clientHeight - 20;
        const nearBottom = a.streamEl.scrollTop;
        m.activeSessionId.value = b.id; m.activeSessionId.value = a.id;
        if (a.streamEl.scrollTop !== nearBottom) throw Error('Tab switch snapped a near-bottom reader');
        // The explicit jump to latest must survive immediately switching away.
        a.streamEl.scrollTop = 150;
        a.captureScrollPosition();
        maybeScroll(a);
        if (a.pillEl.hidden) throw Error('Expected new output button while reading history');
        a.pillEl.click();
        m.activeSessionId.value = b.id;
        a.streamEl.firstChild.style.height = '4400px';
        maybeScroll(a);
        m.activeSessionId.value = a.id;
        await new Promise(requestAnimationFrame);
        if (a.streamEl.scrollHeight - a.streamEl.clientHeight - a.streamEl.scrollTop > 1)
          throw Error('Switching tabs lost the requested jump to the latest output');
        m.setSessionKind(b.id,'agent');
      } finally {
        m.activeSessionId.value = '';
        for (const view of views) {m.sessions.delete(view.id); view.remove();}
      }
    })()`);
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
    // native EventSource reconnect. A normal project refresh may finish first;
    // it must not be mistaken for recovery of the event transport.
    const beforeStreams = hostStreams, beforeSnapshots = snapshots;
    for (const response of [...streams]) response.end();
    await api('/api/projects', { action: 'members', id: project.id, remove: [a.instanceId], add: [b.instanceId] });
    await js(`import('/js/projects.js').then(m=>{m.showProjects(false);m.showProjects(true)})`);
    await wait(`!!document.querySelector('.project-chat[href="/${b.instanceId}/"]') && !document.querySelector('.project-chat[href="/${a.instanceId}/"]')`);
    // Poll transport evidence independently of DOM changes: fallback refreshes
    // can update the list before EventSource's retry timer opens a new stream.
    // The snapshot must have started after that new connection, not be an older
    // in-flight refresh that happened to complete while disconnected.
    const reconnectDeadline = Date.now() + 10000;
    while ((hostStreams <= beforeStreams || snapshotStream <= beforeStreams) && Date.now() < reconnectDeadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert(hostStreams > beforeStreams, 'native EventSource did not reconnect');
    assert(snapshots > beforeSnapshots && snapshotStream > beforeStreams, 'reconnect did not refetch the snapshot');
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
