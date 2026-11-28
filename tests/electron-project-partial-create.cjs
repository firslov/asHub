// Real project renderer + HTTP adapter; inject only the conversation factory and title failure.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { env, fs, path, root } = require('./harness.cjs');

const fixture = env();
app.setPath('userData', fixture.dir);
app.setPath('sessionData', fixture.dir);
const webRoot = path.join(root, 'web');
const backend = { id: 'google-antigravity', label: 'Fixture Antigravity', kind: 'antigravity' };
const failure = 'Fixture title save failed';
const scenarios = [
  { id: 'fa1101', worker: true, partial: true },
  { id: 'fa1102', legacy: true, partial: true },
  { id: 'fa1103', worker: true },
  { id: 'fa1104' },
];
const watchdog = setTimeout(() => { console.error('Project recovery fixture timed out'); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  const { handleProjectRequest } = fixture.load('src/transport/project-http.ts');
  const { ProjectService } = fixture.load('src/services/project-service.ts');
  const { HostEvents } = fixture.load('src/services/host-events.ts');
  const sessions = new Map();
  const projects = new ProjectService(path.join(fixture.dir, 'projects.json'), {
    sessions, events: new HostEvents(), expandHome: value => value,
  });
  const [project] = await projects.change({ action: 'create', name: 'Project recovery fixture', cwd: fixture.dir });
  const requests = [], launches = [];
  let scenario, win, serverError;
  const server = http.createServer((req, res) => {
    const serve = async () => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
      // Hold all session publication back to exercise the first view selected by SPA navigation.
      if (pathname === '/sessions') return json([]);
      if (pathname === '/api/models') return json({ providers: [] });
      if (pathname === '/api/settings/network') return json({ proxyEnabled: true, sessions: {} });
      if (await handleProjectRequest(req, res, {
        sessions, projects, sessionBackends: [backend],
        readBody: async request => {
          let raw = ''; for await (const chunk of request) raw += chunk;
          requests.push(JSON.parse(raw)); return raw;
        },
        create: async (cwd, kind) => {
          assert.equal(kind, scenario.worker ? backend.kind : undefined);
          const created = { id: scenario.id, cwd, kind: kind ?? 'agent', projectWorker: !!kind };
          launches.push(created.id); sessions.set(created.id, created); return created;
        },
        saveSessionMetaDebounced() {},
        setSessionTitle: async (session, title) => {
          if (scenario.partial) throw Error(failure);
          session.title = title;
        },
      })) return;
      const file = path.resolve(webRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(webRoot + path.sep) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return res.writeHead(404).end();
      const ext = path.extname(file);
      let content = fs.readFileSync(file, 'utf8');
      if (ext === '.html') content = content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
      res.setHeader('Content-Type', ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'text/html');
      res.end(content);
    };
    void serve().catch(error => { serverError = error; res.destroy(); });
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    win = new BrowserWindow({ show: false, width: 1180, height: 850,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (request, callback) => callback({ cancel: new URL(request.url).origin !== origin }));
    win.webContents.on('console-message', event => { if (event.level === 'error') console.error('Renderer:', event.message); });
    const js = async code => {
      try { return await win.webContents.executeJavaScript(code); }
      catch (error) { console.error('Renderer expression:', code); throw error; }
    };
    const wait = async code => {
      for (let i = 0; i < 180; i++) {
        if (serverError) throw serverError;
        if (await js(code)) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw Error(`UI timeout: ${code}`);
    };
    const dialog = `document.querySelector('dialog[open]')`;
    const primary = `${dialog}?.querySelector('.primary')`;
    const selector = name => `${dialog}?.querySelector(${JSON.stringify(name)})`;
    const option = `[...document.querySelectorAll('dialog .project-model-option')].find(el => el.textContent.trim() === ${JSON.stringify(backend.label)})`;
    for (scenario of scenarios) {
      await win.loadURL(origin);
      await js(`(async () => {
        document.getElementById('page-loader')?.remove();
        localStorage.setItem('ash.lang', 'en');
        window.EventSource = class { addEventListener() {} close() {} };
        const real = fetch.bind(window);
        window.createResponses = [];
        window.fetch = async (url, options) => {
          const res = await real(url, options);
          if (url !== '/api/projects/session') return res;
          const data = await res.clone().json();
          window.createResponses.push({ status: res.status, data });
          if (!${!!scenario.legacy}) return res;
          // Model an older Hub's wire response without replacing any other behavior.
          const { kind, ...legacy } = data;
          return new Response(JSON.stringify(legacy), { status: res.status, headers: res.headers });
        };
        await import('/js/session-view.js');
        (await import('/js/projects.js')).showProjects(true);
      })()`);
      await wait(`!!document.querySelector('.project-toggle')`);
      await js(`document.querySelector('.project-toggle').click();document.querySelector('.project-heading .project-more').click();document.querySelector('.project-group-actions:popover-open .project-new-chat').click()`);
      await wait(`!!${selector('input[name=title]')}`);
      await js(`const title = ${selector('input[name=title]')}; title.value='A saved-title fixture'`);
      if (scenario.worker) {
        await js(`${selector('.project-model-toggle')}.click()`);
        await wait(`!!${option}`);
        await js(`${option}.click()`);
      }
      await js(`${primary}.click();${primary}.click()`);
      if (scenario.partial) {
        await wait(`${primary}?.textContent === 'Open created conversation' && !${primary}.disabled`);
        assert.match(await js(`${selector('.project-error')}.textContent`), /Fixture title save failed/);
        assert.equal(await js(`${selector('input[name=title]')}.disabled`), true);
        assert.equal(await js('location.pathname'), '/', 'the user chooses whether to open the retained conversation');
        await js(`${primary}.click()`);
      }
      const view = `document.querySelector('session-view[session-id="${scenario.id}"]:not([hidden])')`;
      await wait(`!${dialog} && !!${view}`);
      const evidence = await js(`(async () => ({ url: location.pathname, kind: ${view}.kind, responses: createResponses,
        publishedCount: (await import('/js/store.js')).allSessions.peek().length }))()`);
      console.log('Project recovery fixture:', JSON.stringify({ scenario, evidence }));
      assert.equal(evidence.url, `/${scenario.id}/`);
      assert.equal(evidence.publishedCount, 0);
      assert.equal(evidence.kind, scenario.worker ? 'antigravity' : 'agent');
      assert.deepEqual(evidence.responses, [{ status: scenario.partial ? 400 : 200, data: {
        instanceId: scenario.id, cwd: fixture.dir, kind: scenario.worker ? 'antigravity' : 'agent',
        ...(scenario.partial ? { error: 'Error: ' + failure } : {}),
      } }]);
      assert.deepEqual(Array.from(projects.list()[0].sessionIds), launches, 'the member is retained, not recreated');
      assert.equal(requests.length, launches.length);
    }
    assert.deepEqual(launches, scenarios.map(s => s.id));
    assert.deepEqual(requests.map(r => r.backend), [backend.id, undefined, backend.id, undefined]);
    console.log('PASS partial worker recovery, legacy missing-kind recovery, and normal worker/agent creation without duplicate POSTs');
  } finally {
    win?.destroy(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}).then(() => { clearTimeout(watchdog); app.exit(0); }, error => { clearTimeout(watchdog); console.error(error); app.exit(1); });
