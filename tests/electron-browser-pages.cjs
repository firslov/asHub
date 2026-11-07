// Real plugin ZIP installation, AshBridge registration/approval, Chromium page and desktop pane.
// HTTPS fixtures replace the test partition's network; no credentials or public site are used.
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  http = require('node:http');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const { createBrowserPages, publicURL, publicAddress } = require('../electron/browser-pages.cjs');
const { isTrustedDesktopEvent } = require('../electron/background.cjs');
const { zip } = require('./plugin-zip-fixture.cjs');
const root = path.resolve(__dirname, '..'),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-browser-ci-'));
process.env.AGENT_SH_HOME = path.join(temp, 'agent');
fs.mkdirSync(process.env.AGENT_SH_HOME);
for (const key of Object.keys(process.env))
  if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN/.test(key)) delete process.env[key];
app.setPath('userData', path.join(temp, 'profile'));
const timeout = setTimeout(() => {
  console.error('Browser acceptance timed out');
  app.exit(1);
}, 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 150; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(20);
  }
  throw Error('Test condition did not settle');
}
const host = 'https://portal.example';
function fixture(url, day) {
  let html;
  if (url.pathname === '/docs')
    html = '<h1>安装说明</h1><p>测试环境的安装命令是 npm ci</p><a href="/guide">用户指南</a>';
  else if (url.pathname === '/checkin')
    html = `<main></main><script>
  function show(){
    const main=document.querySelector('main');
    if(!document.cookie.includes('fixture=ok')){
      main.innerHTML='<form><label>测试账号<input id="account"></label><label>密码<input type="password"></label><button>登录</button></form>';
      main.firstChild.onsubmit=e=>{e.preventDefault(); document.cookie='fixture=ok; SameSite=Strict; Secure';show()};return;
    }
    main.innerHTML='<button id="checkin" type="button">签到</button><p role="status"></p>';
    const b=main.querySelector('button');
    if(localStorage.day===${JSON.stringify(day)})main.querySelector('p').textContent='今日已签到';
    b.onclick=()=>{localStorage.day=${JSON.stringify(day)};localStorage.count=String(Number(localStorage.count||0)+1); setTimeout(()=>main.querySelector('p').textContent='今日已签到',100)};
  }show()</script>`;
  else if (url.pathname === '/responsive')
    html = `<script>window.initialWidth=innerWidth</script>
      <label>备注<input></label><button onclick="document.querySelector('p').textContent='已执行'">执行</button><p role="status"></p>`;
  else
    html = `<form><label>说明<input id="description" name="description"></label><button>提交申请</button></form><p role="status"></p><script>
  document.querySelector('form').onsubmit=e=>{e.preventDefault();localStorage.submissions=String(Number(localStorage.submissions||0)+1);document.querySelector('p').textContent='申请已提交'}</script>`;
  return new Response('<!doctype html><meta charset="utf-8">' + html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
app
  .whenReady()
  .then(async () => {
    let win, server, registry, installer;
    const bridges = [],
      events = [],
      visits = [];
    let finishNavigation;
    let date = new Date(2026, 10, 5, 9),
      decision = () => true;
    const service = createBrowserPages({
      electron,
      resolvePublic: async (_session, hostname) => hostname === 'portal.example',
      now: () => date,
      notify: (id) => {
        if (win && !win.isDestroyed()) win.webContents.send('desktop:browser-changed', id);
      },
    });
    const source = path.join(root, 'examples/extensions/browser-automation');
    const settings = path.join(process.env.AGENT_SH_HOME, 'settings.json');
    fs.writeFileSync(
      settings,
      JSON.stringify({ disabledBuiltins: ['codex-provider'], 'ashub.permissions.autoApprove': true }),
    );
    const load = (file) => import(pathToFileURL(path.join(root, 'dist', file)).href);
    try {
      const { PluginInstaller } = await load('plugin-installer.js');
      const { installedApplicationDefinitions } = await load('extensions/installed.js');
      const { HOST_PLUGIN_CAPABILITIES } = await load('extensions/manifest.js');
      const { ApplicationExtensionRegistry } = await load('extensions/application.js');
      const { AshBridge } = await load('bridges/ash.js');
      const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
      installer = new PluginInstaller(settings);
      const preview = await installer.preview(
        process.env.ASHUB_BROWSER_TEST_ZIP
          ? fs.readFileSync(process.env.ASHUB_BROWSER_TEST_ZIP)
          : zip(
              Object.fromEntries(
                ['package.json', ...pkg.files].map((file) => [
                  file,
                  fs.readFileSync(path.join(source, file), 'utf8'),
                ]),
              ),
            ),
      );
      assert(preview.canInstall, JSON.stringify(preview));
      const job = installer.confirm(preview.token);
      await until(() => installer.status(job.id).state !== 'running');
      assert.equal(installer.status(job.id).state, 'succeeded', installer.status(job.id).error);
      const projectDir = path.join(root,'examples/extensions/project-management');
      const projectZip = process.env.ASHUB_PROJECT_TEST_ZIP ? fs.readFileSync(process.env.ASHUB_PROJECT_TEST_ZIP) :
        zip(Object.fromEntries(['package.json','index.mjs','work.mjs','ashub-plugin.json','README.md'].map(f=>[f,fs.readFileSync(path.join(projectDir,f),'utf8')])));
      const projectPreview = await installer.preview(projectZip);
      assert(projectPreview.canInstall);
      const projectJob = installer.confirm(projectPreview.token);
      await until(()=>installer.status(projectJob.id).state !== 'running');
      assert.equal(installer.status(projectJob.id).state,'succeeded');
      const {createHostAccess} = await load('services/host-service.js');
      const {HostOperations} = await load('host-operations.js');
      const {ProjectStore} = await load('projects.js');
      const projects = new ProjectStore(path.join(temp,'test-projects.json'));
      registry = new ApplicationExtensionRegistry({
        settingsFile: settings,
        definitions: [],
        capabilities: HOST_PLUGIN_CAPABILITIES,
        discover: () => installedApplicationDefinitions(settings, { enableBrowserPages: service.enable }),
      });
      await registry.start();
      const {pluginCatalog} = await load('plugins.js');
      for(const plugin of pluginCatalog(settings).filter(p=>p.includedApp && !p.bundled)){
        assert(!plugin.enabled); await registry.setPluginEnabled(plugin.id,true);
      }
      const feature = registry.snapshot().features[0];
      assert.equal(feature.state, 'active');
      async function bridge(id) {
        const partition =
          'persist:ashub-browser-' +
          require('node:crypto')
            .createHash('sha256')
            .update(id + '\0' + host)
            .digest('hex');
        const ses = electron.session.fromPartition(partition);
        ses.protocol.handle('https', (req) => {
          visits.push(req.url);
          if (new URL(req.url).pathname === '/unreachable') return Response.error();
          if (new URL(req.url).pathname === '/slow')
            return new Promise((resolve) => {
              finishNavigation = () => resolve(fixture(new URL(req.url), date.toDateString()));
            });
          return fixture(new URL(req.url), date.toDateString());
        });
        const b = new AshBridge({
          sessionId: id,
          kind: 'agent',
          cwd: temp,
          hostAccess: createHostAccess(id, {
            sessions:new Map([[id,{id,kind:'agent',bridge:{},cwd:temp,title:'Coordinator'}]]),
            projects,operations:new HostOperations(path.join(temp,'receipts')),deleting:()=>false,
            expandHome:value=>value,version:()=>({epoch:'test',revision:1}),describe:s=>({id:s.id,title:s.title})
          }),
          bindBrowserPages: (plugin, approve) => service.bind(id, plugin, approve),
        });
        bridges.push(b);
        await b.ready();
        b.on('event', (e) => {
          if (e.name === 'permission:request') {
            events.push(e.payload);
            const ok = decision(e.payload);
            if (ok !== null) b.decidePermission(e.payload.requestId, ok ? 'approved' : 'denied', true);
          }
        });
        return b;
      }
      const a = await bridge('aaaaaa'),
        b = await bridge('bbbbbb');
      function call(bridge, name, args) {
        const t = bridge.extCtx.agent.getTools().find((t) => t.name === name);
        assert(t, name);
        return t.execute(args, null, {});
      }
      async function ok(name, args, bridge = a) {
        const r = await call(bridge, name, args);
        assert(!r.isError, r.content);
        return JSON.parse(r.content);
      }
      const proposal = {name:'Review team',cwd:temp,includeCurrent:false,requestKey:'project-accept-01'};
      decision = () => false;
      assert((await call(a,'project_management_create_project',proposal)).isError);
      assert.equal(projects.list().length,0);
      assert.equal(events.at(-1).sourceName,'项目管理'); assert.equal(events.at(-1).scope,'once');
      decision = () => true;
      await ok('project_management_create_project',{...proposal,requestKey:'project-accept-02'});
      assert.equal(projects.list()[0].name,'Review team');
      console.log('PASS project ZIP invokes real host operation with source-bound once-only consent');
      const item = (page, name) => {
        const e = page.items.find((row) => row.name === name && row.ref);
        assert(e, JSON.stringify(page));
        return e.ref;
      };
      const guest = () => win.contentView.children[0]?.webContents;
      for (const url of [
        'http://127.0.0.1:7878',
        'file:///etc/passwd',
        'https://127.0.0.1',
        'https://[::1]',
        'https://user:pwd@example.com',
      ])
        assert.throws(() => publicURL(url));
      for (const [address, allowed] of [
        ['127.0.0.1', false],
        ['10.0.0.1', false],
        ['::ffff:127.0.0.1', false],
        ['fd00::1', false],
        ['1.1.1.1', true],
        ['2606:4700:4700::1111', true],
      ])
        assert.equal(publicAddress(address), allowed);
      decision = () => false;
      assert((await call(a, 'browser_open', { url: host + '/docs' })).isError);
      assert.equal(visits.length, 0);
      decision = () => true;
      let page = await ok('browser_open', { url: host + '/docs' });
      assert(page.items.some((row) => row.name.includes('npm ci')));
      assert.equal((await ok('browser_observe', { contains: 'npm ci' })).items.length, 1);
      assert((await call(b, 'browser_observe', {})).isError);
      console.log(
        'PASS docs: real ZIP, bridge tools, navigation approval, compact retrieval and conversation isolation',
      );

      // Mount the native guest in the real pane code, using only the ordinary preload API.
      const styles = fs
        .readFileSync(path.join(root, 'web/index.html'), 'utf8')
        .match(/<link[^>]*href="\/css\/[^"]+"[^>]*>/g)
        .join('');
      const shell =
        '<!doctype html><meta charset=utf-8>' +
        styles +
        '<div class="app"><header class="title-bar">asHub</header><main class="main">Chat</main></div><script type=module>import "/js/browser-pane.js";import {activeSessionId} from "/js/store.js";window.switchTo=id=>activeSessionId.value=id;switchTo("aaaaaa");</script>';
      server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(shell);
          return;
        }
        const file = path.join(root, 'web', url.pathname);
        if (!file.startsWith(path.join(root, 'web') + path.sep) || !fs.existsSync(file)) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'application/octet-stream',
        });
        fs.createReadStream(file).pipe(res);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const local = 'http://127.0.0.1:' + server.address().port;
      const trusted = (event) => isTrustedDesktopEvent(event, BrowserWindow, local);
      ipcMain.handle('get-update-mode', () => ({ manual: true }));
      ipcMain.handle('desktop:browser-status', (event, id) => (trusted(event) ? service.status(id) : null));
      ipcMain.on('desktop:browser-layout', (event, id, rect) => {
        if (trusted(event)) service.mount(win, id, rect);
      });
      ipcMain.on('desktop:browser-control', (event, id, action, pageId) => {
        if (trusted(event)) service.control(id, action, pageId);
      });
      win = new BrowserWindow({
        width: 1440,
        height: 750,
        show: false,
        webPreferences: {
          preload: path.join(root, 'electron/preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      await win.loadURL(local);
      const ui = (js) => win.webContents.executeJavaScript(js);
      await until(() => win.contentView.children.length > 0);
      assert(await ui("document.querySelector('.browser-origin').textContent==='https://portal.example'"));
      const shape = await ui(
        "(()=>{const a=document.querySelector('main').getBoundingClientRect(),b=document.querySelector('.browser-viewport').getBoundingClientRect();return [a.right,b.left,b.width]})()",
      );
      assert(shape[0] <= shape[1] + 1 && shape[2] > 200, JSON.stringify(shape));
      assert.equal(
        await guest().executeJavaScript('typeof window.electronAPI+":"+typeof require'),
        'undefined:undefined',
      );
      await ui('switchTo("bbbbbb")');
      await until(() => win.contentView.children.length === 0);
      await ui('switchTo("aaaaaa")');
      await until(() => win.contentView.children.length > 0);

      // Native child views are above HTML regardless of the overlay's CSS z-index.
      await ui("import('/js/updater.js').then(()=>true)");
      win.webContents.send('update-downloaded', '0.21.2');
      await ui(
        "import('/js/toast.js').then(({toast})=>{toast('Connection failed. '.repeat(20),{type:'error',detail:'Retry from settings',duration:60000});return true})",
      );
      await until(() => ui("!!document.querySelector('.update-card .update-btn')"));
      await ui(
        'Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)',
      );
      const underGuest = await ui(`(()=>{
        const g=document.querySelector('.browser-viewport').getBoundingClientRect();
        return ['.update-card','.toast'].filter(selector=>{
          const r=document.querySelector(selector).getBoundingClientRect();
          return r.right>g.left && r.left<g.right && r.top<g.bottom && r.bottom>g.top;
        });
      })()`);
      await ui(
        "document.querySelector('.update-card').remove();document.querySelector('.toast-container').remove()",
      );
      await ok('browser_open', { url: host + '/form' });
      const slow = call(a, 'browser_open', { url: host + '/slow' });
      await until(() => !!finishNavigation);
      service.control('aaaaaa', 'back');
      assert((await slow).isError, 'the interrupted navigation must not report success');
      finishNavigation();
      const retained = !!service.status('aaaaaa');
      assert.deepEqual({ underGuest, retained }, { underGuest: [], retained: true });
      await until(() => guest()?.getURL() === host + '/docs');
      assert((await ok('browser_observe', {})).items.some((row) => row.name.includes('npm ci')));
      console.log(
        'PASS native pane: back cancels loading without closing the page, desktop notifications stay accessible',
      );
      await ok('browser_open', { url: host + '/form' });
      const failed = await call(a, 'browser_open', { url: host + '/unreachable' });
      assert(failed.isError, 'a failed navigation must report an error');
      assert(service.status('aaaaaa')?.back, 'after a failed navigation the user can still return');
      if (guest().getURL() === host + '/unreachable')
        assert(
          (await call(a, 'browser_observe', {})).isError,
          'Chromium error documents cannot be observed as website content',
        );
      service.control('aaaaaa', 'back');
      await until(() => guest()?.getURL() !== host + '/unreachable' && !guest()?.isLoadingMainFrame());
      const recovered = await ok('browser_observe', {});
      assert(
        recovered.items.some((row) => row.name === '提交申请' || row.name.includes('npm ci')),
        'history restores a usable document',
      );
      // Unlike a navigation error on an established page, the first failed open
      // has no document or useful history to keep around.
      assert((await call(b, 'browser_open', { url: host + '/unreachable' })).isError);
      assert.equal(service.status('bbbbbb'), null);
      console.log(
        'PASS failed navigation: a previously loaded page retains working history; a first failure releases its guest',
      );
      const docPage = guest();
      assert.equal(await docPage.executeJavaScript("window.open('https://other.example')===null"), true);
      assert.equal(
        await docPage.executeJavaScript('fetch(' + JSON.stringify(local) + ').then(()=>false,()=>true)'),
        true,
      );
      page = await ok('browser_open', { url: host + '/checkin' });
      assert(
        (await call(a, 'browser_act', { action: 'fill', ref: item(page, '密码'), value: 'fixture' })).isError,
      );
      await ui("document.querySelector('.browser-mode').click()");
      await until(() => service.status('aaaaaa').manual);
      await until(()=>ui("!document.querySelector('.browser-controller').hidden && document.querySelector('.browser-mode').getAttribute('aria-pressed')==='true'"));
      assert((await call(a, 'browser_observe', {})).isError);
      // Simulate the human entering fixture credentials directly in the visible guest.
      await guest().executeJavaScript(
        "document.querySelector('#account').value='fixture';document.querySelector('input[type=password]').value='fixture-only';document.querySelector('form').requestSubmit()",
      );
      await ui("document.querySelector('.browser-mode').click()");
      await until(() => !service.status('aaaaaa').manual);
      page = await ok('browser_observe', {});
      let count = events.length;
      const checkin = async (page) =>
        ok('browser_act', { action: 'click', ref: item(page, '签到'), expect: '今日已签到', daily: true });
      assert.equal((await checkin(page)).status, 'verified');
      assert.equal(events.length, count + 1);
      assert.equal(events.at(-1).scope,'daily7');
      assert.equal(events.at(-1).sourceName,'会话浏览器');
      assert.deepEqual(events.find(e=>e.scope==='site')?.browser,{action:'open',origin:host});
      assert.equal(events.at(-1).browser.origin,host);
      page = await ok('browser_open', { url: host + '/checkin' });
      assert.equal((await checkin(page)).status, 'already-observed');
      assert.equal(
        (await ok('browser_act', { action: 'click', ref: item(page, '签到'), daily: true })).status,
        'already-attempted',
      );
      // The real scheduler selects the due time; a deterministic recipient invokes the
      // installed browser tools so this regression requires no external model or account.
      const { Scheduler } = await import(
        pathToFileURL(path.join(root, 'examples/extensions/scheduled-tasks/app.mjs')).href
      );
      const deliveries = [],
        receipts = new Map();
      const scheduler = new Scheduler(
        {
          host: {
            snapshot: () => ({ sessions: [{ instanceId: 'aaaaaa', kind: 'agent', title: 'Check in' }] }),
          },
          messages: {
            submit(request) {
              assert.equal(request.grantId, 'fixture-schedule');
              const receipt = { id: request.key, state: 'queued' };
              receipts.set(request.key, receipt);
              deliveries.push(
                ok('browser_open', { url: host + '/checkin' })
                  .then(checkin)
                  .then((result) => {
                    receipt.state = 'completed';
                    return result;
                  }),
              );
              return receipt;
            },
            lookup: (key) => receipts.get(key),
            status: (id) => receipts.get(id),
          },
        },
        { file: path.join(temp, 'schedule.json'), now: () => date.getTime() },
      );
      const plan = scheduler.prepare('save', {
        title: 'Check in',
        targetId: 'aaaaaa',
        message: '检查并签到一次',
        cadence: 'daily',
        time: '09:00',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        missed: 'skip',
        graceMinutes: 30,
      });
      assert.equal(plan.authorization.targetId, 'aaaaaa');
      plan.execute('fixture-schedule');
      date = new Date(2026, 10, 6, 8, 59);
      scheduler.tick();
      assert.equal(deliveries.length, 0);
      date = new Date(2026, 10, 6, 9);
      scheduler.tick();
      scheduler.tick();
      assert.equal(deliveries.length, 1);
      assert.equal((await deliveries[0]).status, 'verified');
      assert.equal(events.length, count + 1);
      assert.equal(await guest().executeJavaScript('localStorage.count'), '2');
      // Recheck scope when approval arrives, even if the button itself kept its name and ID.
      const regressions = [];
      date = new Date(2026, 10, 14, 9);
      page = await ok('browser_open', { url: host + '/checkin' });
      decision = () => null;
      count = events.length;
      const regrant = call(a, 'browser_act', { action: 'click', ref: item(page, '签到'), daily: true });
      await until(() => events.length > count);
      await guest().executeJavaScript("document.body.append(document.createElement('form'))");
      a.decidePermission(events.at(-1).requestId, 'approved', false);
      if (!(await regrant).isError || (await guest().executeJavaScript('localStorage.count')) !== '2')
        regressions.push('changed daily scope clicked');
      decision = () => true;
      const otherPage = await ok('browser_open', { url: host + '/checkin' }, b);
      assert(
        otherPage.items.some((row) => row.name === '登录'),
        'another conversation must log in separately',
      );
      service.control('bbbbbb', 'close');
      console.log(
        'PASS daily check-in: manual login, isolated credentials, one scoped approval, two days and no repeat on the same day',
      );

      page = await ok('browser_open', { url: host + '/form' });
      const stale = item(page, '说明');
      page = await ok('browser_observe', {});
      assert((await call(a, 'browser_act', { action: 'fill', ref: stale, value: 'stale' })).isError);
      await ok('browser_act', { action: 'fill', ref: item(page, '说明'), value: '资料审阅' });
      page = await ok('browser_observe', {});
      assert(
        (await call(a, 'browser_act', { action: 'click', ref: item(page, '提交申请'), daily: true })).isError,
      );
      decision = () => false;
      assert((await call(a, 'browser_act', { action: 'click', ref: item(page, '提交申请') })).isError);
      assert.equal(await guest().executeJavaScript("localStorage.getItem('submissions')"), null);
      assert(events.at(-1).items[0].fields.some((f) => f.value === '资料审阅'));
      decision = () => null;
      count = events.length;
      const changed = call(a, 'browser_act', { action: 'click', ref: item(page, '提交申请') });
      await until(() => events.length > count);
      await guest().executeJavaScript(
        "document.querySelector('#description').value='changed during approval'",
      );
      a.decidePermission(events.at(-1).requestId, 'approved', true);
      assert((await changed).isError);
      assert.equal(await guest().executeJavaScript("localStorage.getItem('submissions')"), null);
      decision = () => true;
      page = await ok('browser_observe', {});
      assert.equal(
        (await ok('browser_act', { action: 'click', ref: item(page, '提交申请'), expect: '申请已提交' }))
          .status,
        'verified',
      );
      assert.equal(await guest().executeJavaScript('localStorage.submissions'), '1');
      console.log(
        'PASS form: stale references rejected, fill, separate preview, deny without submission, confirm once and verify result',
      );

      await guest().executeJavaScript(`(()=>{
        const form=document.createElement('form');
        form.innerHTML='<input name="method" value="fixture"><input name="matches" type="hidden"><input type="hidden" name="recipient" value="private-A"><label>范围<select multiple name="scope"><option selected>A</option><option selected>B</option><option>C</option></select></label><button>保存范围</button>';
        form.onsubmit=e=>{e.preventDefault();document.body.dataset.sent='yes'};
        document.body.prepend(form);
      })()`);
      for (const mutation of [
        "document.querySelector('[name=recipient]').value='private-B'",
        "document.querySelector('[name=scope]').options[2].selected=true",
        "document.querySelector('[name=scope]').form.setAttribute('method','post')",
      ]) {
        page = await ok('browser_observe', {});
        count = events.length;
        decision = () => null;
        const save = call(a, 'browser_act', { action: 'click', ref: item(page, '保存范围') });
        await until(() => events.length > count);
        const preview = events.at(-1);
        assert(!JSON.stringify(preview).includes('private-'), 'hidden form data stays out of approval cards');
        await guest().executeJavaScript(mutation);
        a.decidePermission(preview.requestId, 'approved', false);
        if (!(await save).isError || (await guest().executeJavaScript('document.body.dataset.sent')))
          regressions.push('changed form submitted: ' + mutation);
        await guest().executeJavaScript('delete document.body.dataset.sent');
      }
      await guest().executeJavaScript(`(()=>{
        const host=document.createElement('div'); document.body.prepend(host);
        const inner=document.createElement('section');host.attachShadow({mode:'open'}).append(inner);
        const button=document.createElement('button');button.textContent='组件按钮';
        inner.attachShadow({mode:'open'}).append(button);
        button.onclick=()=>document.body.dataset.shadowClicked='yes';
      })()`);
      await guest().executeJavaScript(
        "const cover=document.createElement('div');cover.id='cover';cover.style.cssText='position:fixed;inset:0;z-index:10000;background:white';document.body.append(cover)",
      );
      page = await ok('browser_observe', {});
      decision = () => true;
      const blocked = await call(a, 'browser_act', { action: 'click', ref: item(page, '组件按钮') });
      assert(
        blocked.isError &&
          (await guest().executeJavaScript('document.body.dataset.shadowClicked')) === undefined,
      );
      await guest().executeJavaScript("document.querySelector('#cover').remove()");
      page = await ok('browser_observe', {});
      decision = () => true;
      const shadow = await call(a, 'browser_act', { action: 'click', ref: item(page, '组件按钮') });
      if (
        shadow.isError ||
        (await guest().executeJavaScript('document.body.dataset.shadowClicked')) !== 'yes'
      )
        regressions.push('uncovered shadow button rejected');
      assert.deepEqual(regressions, []);
      console.log(
        'PASS changing approval scope and form payload, nested shadow hit testing and overlay rejection',
      );
      await ok('browser_open', { url: host + '/docs' });
      await guest().executeJavaScript(
        `document.body.innerHTML='<label><input id="flag" type="checkbox">订阅通知</label><label>备注<input id="note"></label>'`,
      );
      page = await ok('browser_observe', {});
      const failures = [];
      if (page.items.find((row) => row.name === '订阅通知')?.checked !== false)
        failures.push('checkbox state missing from observation');
      for (const [name, action, mutation, read, keep] of [
        [
          '订阅通知',
          'click',
          'document.querySelector("#flag").checked=true',
          'document.querySelector("#flag").checked',
          true,
        ],
        [
          '备注',
          'fill',
          'document.querySelector("#note").value="human draft"',
          'document.querySelector("#note").value',
          'human draft',
        ],
      ]) {
        page = await ok('browser_observe', {});
        decision = () => null;
        count = events.length;
        const task = call(a, 'browser_act', {
          ref: item(page, name),
          action,
          ...(action === 'fill' ? { value: 'replacement' } : {}),
        });
        await until(() => events.length > count);
        await guest().executeJavaScript(mutation);
        a.decidePermission(events.at(-1).requestId, 'approved', false);
        if (!(await task).isError || (await guest().executeJavaScript(read)) !== keep)
          failures.push('stale approval modified ' + name);
      }
      await guest().executeJavaScript(
        `document.body.innerHTML='<button id="daily" type="button" onclick="this.dataset.clicked=1">每日按钮</button><div id="cover" style="position:fixed;inset:0;background:white"></div>'`,
      );
      const dailyClick = async () => {
        const result = await ok('browser_observe', {});
        return call(a, 'browser_act', { action: 'click', daily: true, ref: item(result, '每日按钮') });
      };
      decision = () => true;
      assert((await dailyClick()).isError);
      await guest().executeJavaScript("document.querySelector('#cover').remove()");
      count = events.length;
      if (
        (await dailyClick()).isError ||
        events.length !== count + 1 ||
        (await guest().executeJavaScript("document.querySelector('#daily').dataset.clicked")) !== '1'
      )
        failures.push('covered daily button consumed an unexecuted attempt');
      await guest().executeJavaScript(
        "document.querySelector('#daily').id='editor-test';document.body.insertAdjacentHTML('beforeend','<div contenteditable></div>')",
      );
      if (!(await dailyClick()).isError) failures.push('daily grant accepted on an editable page');
      await guest().executeJavaScript(
        `document.body.innerHTML='<section></section>';document.querySelector('section').attachShadow({mode:'open'}).innerHTML='<button id="shadow-daily" type="button">每日按钮</button><form><input></form>'`,
      );
      if (!(await dailyClick()).isError)
        failures.push('daily grant accepted alongside a form inside a component');
      assert.deepEqual(failures, []);
      await guest().executeJavaScript(
        `document.body.innerHTML='<button id="lost" type="button" onclick="window.dispatchCount++">每日按钮</button>';window.dispatchCount=0`,
      );
      const debuggerApi = guest().debugger,
        send = debuggerApi.sendCommand;
      debuggerApi.sendCommand = async function (method, args) {
        const reply = await send.call(this, method, args);
        if (method === 'Runtime.callFunctionOn' && args.arguments?.[2]?.value?.identity)
          throw Error('Fixture: dispatch acknowledgement lost');
        return reply;
      };
      try {
        assert((await dailyClick()).isError);
      } finally {
        debuggerApi.sendCommand = send;
      }
      const replay = await dailyClick();
      assert.equal(JSON.parse(replay.content).status, 'already-attempted');
      assert.equal(await guest().executeJavaScript('window.dispatchCount'), 1);
      console.log(
        'PASS changed checkbox/draft, editable surfaces, daily quota after a blocked click and after a lost acknowledgement',
      );
      await guest().executeJavaScript(`(()=>{
        const host = document.createElement('section'); host.id='widget'; document.body.replaceChildren(host);
        host.attachShadow({mode:'open'}).innerHTML='<label>组件备注<input></label><button>组件保存</button>';
        host.shadowRoot.querySelector('button').onclick=()=>document.body.dataset.clicked='yes';
        document.addEventListener('input',e=>{if(e.target===host)document.body.dataset.draft=host.shadowRoot.querySelector('input').value;});
      })()`);
      page = await ok('browser_observe', {});
      await ok('browser_act', { action: 'fill', ref: item(page, '组件备注'), value: 'review draft' });
      assert.equal(
        await guest().executeJavaScript('document.body.dataset.draft'),
        'review draft',
        'outer application receives edits inside components',
      );
      page = await ok('browser_observe', {});
      count = events.length;
      decision = () => null;
      const pendingClick = call(a, 'browser_act', { action: 'click', ref: item(page, '组件保存') });
      await until(() => events.length > count);
      await guest().executeJavaScript(
        "document.querySelector('#widget').setAttribute('aria-disabled','true')",
      );
      a.decidePermission(events.at(-1).requestId, 'approved', false);
      assert((await pendingClick).isError, 'disabled component rejects stale approval');
      assert.equal(await guest().executeJavaScript('document.body.dataset.clicked'), undefined);

      await guest().executeJavaScript(`(()=>{
        class Recipient extends HTMLElement {
          static formAssociated=true;
          constructor(){super();this.field=this.attachInternals();}
          setRecipient(value){this.field.setFormValue(value);}
        }
        customElements.define('fixture-recipient',Recipient);
        document.body.innerHTML='<form><fixture-recipient name="recipient"></fixture-recipient><button>提交收件人</button></form>';
        document.querySelector('fixture-recipient').setRecipient('recipient-A');
        document.querySelector('form').onsubmit=e=>{e.preventDefault();document.body.dataset.submitted=new FormData(e.target).get('recipient');};
      })()`);
      page = await ok('browser_observe', {});
      count = events.length;
      decision = (preview) => {
        guest()
          .executeJavaScript("document.querySelector('fixture-recipient').setRecipient('recipient-B')")
          .then(() => a.decidePermission(preview.requestId, 'approved', false));
        return null;
      };
      const customResult = await call(a, 'browser_act', { action: 'click', ref: item(page, '提交收件人') });
      assert(customResult.isError && /manual control/.test(customResult.content), customResult.content);
      assert.equal(events.length, count, 'unpreviewable values never reach the approval card');
      assert.equal(await guest().executeJavaScript('document.body.dataset.submitted'), undefined);
      console.log(
        'PASS component inputs notify the application, disabled hosts reject old approvals, custom form values require manual control',
      );
      decision = () => true;
      await ok('browser_open', { url: host + '/docs' });
      await guest()
        .executeJavaScript(`document.body.innerHTML='<section id="alpha"></section><section id="beta"></section>';
        for(const host of document.querySelectorAll('section')){
          host.attachShadow({mode:'open'}).innerHTML='<button id="run" type="button">执行任务</button>';
          host.shadowRoot.querySelector('button').onclick=()=>host.dataset.runs=String(1+Number(host.dataset.runs||0));
        } void 0;`);
      const componentAction = async (index) => {
        const observed = await ok('browser_observe', {});
        const buttons = observed.items.filter((i) => i.name === '执行任务' && i.ref);
        assert.equal(buttons.length, 2);
        return call(a, 'browser_act', { ref: buttons[index].ref, action: 'click', daily: true });
      };
      assert(!(await componentAction(0)).isError);
      date = new Date(+date + 86400000);
      decision = () => false;
      count = events.length;
      const wrongTarget = await componentAction(1);
      const reusedAcrossHosts =
        !wrongTarget.isError ||
        events.length !== count + 1 ||
        (await guest().executeJavaScript('document.querySelector("#beta").dataset.runs')) !== undefined;

      count = events.length;
      assert(!(await componentAction(0)).isError, 'original target retains its permission');
      assert.equal(events.length, count, 'same host and button can reuse the grant');
      assert.equal(await guest().executeJavaScript('document.querySelector("#alpha").dataset.runs'), '2');
      await guest().executeJavaScript("document.querySelector('#beta').removeAttribute('id')");
      count = events.length;
      assert((await componentAction(1)).isError, 'anonymous component cannot identify a recurring target');
      assert.equal(events.length, count, 'ambiguous target never reaches approval');
      decision = () => true;
      await guest()
        .executeJavaScript(`document.body.innerHTML='<button id="expiry" type="button">每日按钮</button>';
        window.expiryRuns=0;document.querySelector('#expiry').onclick=()=>window.expiryRuns++;void 0`);
      assert(!(await dailyClick()).isError);
      date = new Date(+date + 7 * 86400000 - 1);
      decision = () => false;
      let checks = 0;
      const api = guest().debugger,
        original = api.sendCommand;
      api.sendCommand = async function (method, args) {
        const reply = await original.call(this, method, args);
        if (method === 'Accessibility.getPartialAXTree' && ++checks === 2) date = new Date(+date + 2);
        return reply;
      };
      let late;
      try {
        late = await dailyClick();
      } finally {
        api.sendCommand = original;
      }
      assert.equal(checks, 2, 'fixture crosses the deadline during the final target check');
      assert.deepEqual(
        {
          reusedAcrossHosts,
          expiredClick: !late.isError || (await guest().executeJavaScript('window.expiryRuns')) !== 1,
        },
        { reusedAcrossHosts: false, expiredClick: false },
      );
      count = events.length;
      assert((await dailyClick()).isError, 'an expired grant must request fresh approval');
      assert.equal(events.length, count + 1);
      assert.equal(await guest().executeJavaScript('window.expiryRuns'), 1);
      console.log(
        'PASS recurring grants distinguish component instances, refuse ambiguous hosts and enforce expiry at dispatch',
      );

      // The submitter's present-but-empty formaction targets the current document.
      decision = () => true;
      await ok('browser_open', { url: host + '/docs' });
      await guest().executeJavaScript(
        `document.body.innerHTML='<form action="/fallback"><input name="q" value="test"><button formaction="">保存</button></form>'`,
      );
      const savePage = await ok('browser_observe', {});
      await ok('browser_act', { action: 'click', ref: item(savePage, '保存') });
      await until(() => visits.includes(host + '/docs?q=test'));
      const destinationField = (event) =>
        event.items[0].fields.find((f) => f.label.includes('Destination')).value;
      const emptyOverride = destinationField(events.at(-1));
      await until(() => guest()?.getURL() === host + '/docs?q=test');
      await guest()
        .executeJavaScript(`document.body.innerHTML='<form action="/fallback"><button>保存</button></form>';
        window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++};void 0`);
      page = await ok('browser_observe', {});
      count = events.length;
      decision = () => null;
      const saveToFallback = call(a, 'browser_act', { action: 'click', ref: item(page, '保存') });
      await until(() => events.length > count);
      const pendingPreview = events.at(-1);
      assert.equal(destinationField(pendingPreview), host + '/fallback');
      await guest().executeJavaScript("document.querySelector('form button').setAttribute('formaction','')");
      a.decidePermission(pendingPreview.requestId, 'approved', false);
      const changedTarget = await saveToFallback;
      assert.deepEqual(
        {
          emptyOverride,
          rejected: !!changedTarget.isError,
          submits: await guest().executeJavaScript('window.submits'),
        },
        { emptyOverride: host + '/docs', rejected: true, submits: 0 },
      );
      console.log(
        'PASS form destinations: empty submitter override matches native navigation and invalidates a pending approval',
      );

      // Programmatic value assignment bypasses the maxlength enforced by Chromium's editor.
      await guest()
        .executeJavaScript(`document.body.innerHTML='<input aria-label="代号" maxlength="2"><textarea aria-label="备注" maxlength="3"></textarea>';
        window.edits=0;document.body.oninput=()=>window.edits++;void 0`);
      const nativeValue = await guest().executeJavaScript(`(()=>{
        const input=document.querySelector('input'); input.focus();
        document.execCommand('insertText',false,'甲乙丙');const value=input.value;
        input.value='';window.edits=0;return value;
      })()`);
      assert.equal(nativeValue, '甲乙');
      decision = () => true;
      page = await ok('browser_observe', {});
      count = events.length;
      const tooLong = await call(a, 'browser_act', {
        action: 'fill',
        ref: item(page, '代号'),
        value: '甲乙丙',
      });
      const first = {
        rejected: !!tooLong.isError,
        prompts: events.length - count,
        value: await guest().executeJavaScript("document.querySelector('input').value"),
      };
      page = await ok('browser_observe', {});
      decision = () => null;
      count = events.length;
      const pendingFill = call(a, 'browser_act', { action: 'fill', ref: item(page, '备注'), value: '🌟A' });
      await until(() => events.length > count);
      await guest().executeJavaScript("document.querySelector('textarea').maxLength=2");
      a.decidePermission(events.at(-1).requestId, 'approved', false);
      const shorter = await pendingFill;
      assert.deepEqual(
        {
          first,
          rejectedAfterChange: !!shorter.isError,
          edits: await guest().executeJavaScript('window.edits'),
        },
        { first: { rejected: true, prompts: 0, value: '' }, rejectedAfterChange: true, edits: 0 },
      );
      decision = () => true;
      page = await ok('browser_observe', {});
      await ok('browser_act', { action: 'fill', ref: item(page, '备注'), value: '🌟' });
      assert.equal(await guest().executeJavaScript("document.querySelector('textarea').value"), '🌟');
      await guest().executeJavaScript("document.querySelector('textarea').maxLength=3");
      page = await ok('browser_observe', {});
      await ok('browser_act', { action: 'fill', ref: item(page, '备注'), value: 'A\r\nB' });
      assert.equal(await guest().executeJavaScript("document.querySelector('textarea').value"), 'A\nB');
      console.log('PASS field length: native limit, pending limit change and exact-length Unicode input');

      // Never switch to B before this click: its first page has no native parent.
      const background = await ok('browser_open', { url: host + '/responsive' }, b);
      assert.equal(service.status('bbbbbb').back, false, 'bootstrap document is absent from history');
      const result = await ok(
        'browser_act',
        { action: 'click', ref: item(background, '执行'), expect: '已执行' },
        b,
      );
      assert.equal(result.status, 'verified');
      await ui('switchTo("bbbbbb")');
      await until(() => guest()?.getURL() === host + '/responsive');
      const responsive = guest();
      assert(
        (await responsive.executeJavaScript('window.initialWidth')) > 0,
        'first site script had a viewport',
      );
      await until(async () => {
        const native = win.contentView.children[0].getBounds();
        const [w, h] = await responsive.executeJavaScript('[innerWidth,innerHeight]');
        return w === native.width && h === native.height;
      });
      await ui('switchTo("aaaaaa")');
      await until(() => guest() && guest() !== responsive);
      const backgroundAgain = await ok('browser_observe', {}, b);
      await ok('browser_act', { action: 'fill', ref: item(backgroundAgain, '备注'), value: '再次切换后' }, b);
      assert.equal(await responsive.executeJavaScript("document.querySelector('input').value"), '再次切换后');
      service.control('bbbbbb', 'close');
      console.log(
        'PASS unmounted page: initial responsive layout, background click, native viewport on mount and fill after detach',
      );

      const { setPluginAutoApproval } = await load('plugin-approvals.js');
      setPluginAutoApproval(settings, feature.pluginId, true);
      decision = () => false;
      count = events.length;
      const automaticPage = await ok('browser_open', {url:host+'/responsive'});
      const automaticClick = await ok('browser_act', {action:'click',ref:item(automaticPage,'执行'),expect:'已执行'});
      assert.equal(automaticClick.status,'verified');
      assert.equal(events.length,count,'enabled plugin policy skips repeated approval');
      setPluginAutoApproval(settings,feature.pluginId,false);
      page=await ok('browser_observe',{});
      assert((await call(a,'browser_act',{action:'fill',ref:item(page,'备注'),value:'denied'})).isError);
      assert.equal(events.length,count+1,'disabling policy immediately restores confirmation');
      assert.equal(await guest().executeJavaScript("document.querySelector('input').value"),'');
      console.log('PASS plugin auto-approval: live per-plugin opt-in, automatic action verification and immediate revocation');
      setPluginAutoApproval(settings, feature.pluginId, true);
      let recurringPage = await ok('browser_open', { url: host + '/checkin' });
      const recurringClick = (snapshot) =>
        call(a, 'browser_act', { action: 'click', daily: true, ref: item(snapshot, '签到') });
      count = events.length;
      assert(!(await recurringClick(recurringPage)).isError);
      recurringPage = await ok('browser_observe', {});
      assert.equal(JSON.parse((await recurringClick(recurringPage)).content).status, 'already-attempted');
      assert.equal(events.length, count);
      const runsBeforeRevocation = await guest().executeJavaScript('localStorage.count');
      setPluginAutoApproval(settings, feature.pluginId, false);
      date = new Date(+date + 86400000);
      recurringPage = await ok('browser_observe', {});
      const revoked = await recurringClick(recurringPage);
      assert.deepEqual({
        denied: !!revoked.isError,
        prompted: events.length === count + 1,
        runs: await guest().executeJavaScript('localStorage.count'),
      }, {denied: true, prompted: true, runs: runsBeforeRevocation});
      console.log('PASS daily opt-in: automatic approval enforces the daily quota without granting seven days after revocation');

      decision = () => true;
      await ok('browser_open', { url: host + '/docs' });
      await guest().executeJavaScript(`document.body.innerHTML='<button type="button" id="first">任务一</button><button type="button" id="second">任务二</button>';
        for(const button of document.querySelectorAll('button')) button.onclick=()=>button.dataset.count=String(1+Number(button.dataset.count||0));
        void 0`);
      const runDailyButton = async (name) => {
        const snapshot = await ok('browser_observe', {});
        return call(a, 'browser_act', { action: 'click', daily: true, ref: item(snapshot, name) });
      };
      // The first button has a manually approved schedule, the second only per-plugin consent.
      assert(!(await runDailyButton('任务一')).isError);
      setPluginAutoApproval(settings, feature.pluginId, true);
      assert(!(await runDailyButton('任务二')).isError);
      const repeat = await runDailyButton('任务一');
      const clickCounts = () => guest().executeJavaScript("Array.from(document.querySelectorAll('button'), b => b.dataset.count)");
      assert.deepEqual(
        { status: JSON.parse(repeat.content).status, runs: await clickCounts() },
        { status: 'already-attempted', runs: ['1', '1'] },
      );
      setPluginAutoApproval(settings, feature.pluginId, false);
      date = new Date(+date + 86400000);
      decision = () => false;
      count = events.length;
      assert(!(await runDailyButton('任务一')).isError);
      assert.equal(events.length, count, 'original manual schedule is still effective');
      assert((await runDailyButton('任务二')).isError);
      assert.equal(events.length, count + 1);
      assert.deepEqual(await clickCounts(), ['2', '1']);
      console.log('PASS daily targets: independent daily quotas and manual vs automatic consent');

      decision = () => true;
      await ok('browser_open', { url: host + '/form' });
      page = await ok('browser_observe', {});
      decision = () => null;
      count = events.length;
      const waiting = call(a, 'browser_act', { action: 'click', ref: item(page, '提交申请') });
      await until(() => events.length > count);
      await registry.setPluginEnabled(feature.pluginId, false);
      assert((await waiting).isError);
      assert.equal(service.status('aaaaaa'), null);
      await until(() => win.contentView.children.length === 0);
      const visible = a.core.bus.emitPipe('agent:tools:visible', { tools: a.extCtx.agent.getTools() }).tools;
      assert(!visible.some((t) => t.name === 'browser_open'));
      assert.equal(a.core.handlers.call('instruction:browser-automation'), '');
      assert((await call(a, 'browser_open', { url: host + '/docs' })).isError);
      console.log(
        'PASS disable: pending grant revoked, guest removed, tools hidden and outstanding session denied',
      );
      await registry.setPluginEnabled(feature.pluginId, true);
      decision = () => true;
      await ok('browser_open', { url: host + '/docs' });
      await registry.uninstallPlugin(feature.pluginId, () => {}, () => {
        installer.uninstall(feature.pluginId);
        for (const bridge of bridges) bridge.uninstallPlugin(feature.pluginId);
      });
      assert.equal(service.status('aaaaaa'), null);
      assert(!a.extCtx.agent.getTools().some(tool => tool.name === 'browser_open'));
      assert(!registry.snapshot().features.some(entry => entry.pluginId === feature.pluginId));
      console.log('PASS browser uninstall closes an open page and unloads tools in existing sessions');
    } finally {
      for (const b of bridges) b.close();
      await registry?.close();
      await installer?.close();
      service.close();
      win?.destroy();
      server?.closeAllConnections();
      server?.close();
      clearTimeout(timeout);
    }
  })
  .then(
    () => app.exit(0),
    (err) => {
      console.error(err);
      app.exit(1);
    },
  );
