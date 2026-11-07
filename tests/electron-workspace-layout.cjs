// Render the full desktop shell against an isolated Hub and a real native browser view.
// ASHUB_VISUAL_DIR optionally saves the screenshots used in design review.
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;
const { env, Bridge, fs, path, root } = require('./harness.cjs');
const { zip } = require('./plugin-zip-fixture.cjs');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { createBrowserPages } = require(path.join(root, 'electron/browser-pages.cjs'));
const fixture = env({ globals: { setTimeout, clearTimeout, setInterval, clearInterval } });
fixture.clock(Date.now());
app.setPath('userData', path.join(fixture.dir, 'profile'));
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, description) {
  for (let i = 0; i < 180; i++) {
    if (await fn()) return;
    await sleep(25);
  }
  throw Error('Timed out: ' + description);
}
const baseline = process.env.ASHUB_VISUAL_BASELINE === '1';
const output = process.env.ASHUB_VISUAL_DIR;
let win, hub;
const pages = createBrowserPages({
  electron,
  resolvePublic: async (_, host) => host === 'docs.example',
  notify: (id) => {
    if (win && !win.isDestroyed()) win.webContents.send('desktop:browser-changed', id);
  },
});
const timeout = setTimeout(() => {
  console.error('Layout acceptance timed out');
  app.exit(1);
}, 120000);
app.whenReady().then(async () => {
  try {
    const bridges = new Map();
    hub = fixture.hub().startHub({
      host: '127.0.0.1',
      port: 0,
      webRoot: path.join(root, 'web'),
      enableBrowserPages: pages.enable,
      makeBridge: (opts) => {
        const b = new Bridge(opts);
        bridges.set(opts.sessionId, b);
        return b;
      },
    });
    await once(hub.server, 'listening');
    const base = 'http://127.0.0.1:' + hub.server.address().port;
    async function request(route, method = 'GET', body) {
      const isZip = Buffer.isBuffer(body);
      const response = await fetch(base + route, {
        method,
        headers: { 'Content-Type': isZip ? 'application/zip' : 'application/json', 'X-Ashub-Local': '1' },
        body: isZip ? body : body === undefined ? undefined : JSON.stringify(body),
      });
      assert(response.ok, await response.clone().text());
      return response.json();
    }
    const fresh = (await request('/api/plugins')).plugins.filter(plugin => plugin.includedApp);
    assert.equal(fresh.length,3);
    assert(fresh.every(plugin => plugin.bundled && !plugin.enabled && !plugin.autoApprove));
    const bundledBrowser = fresh.find(plugin => plugin.manifest.id === 'ashub-browser-automation');
    const bundledOwner = pages.bind('bundled-test-session', bundledBrowser.id, async () => false);
    assert(!bundledOwner.available());
    await request('/api/plugins','PUT',{id:bundledBrowser.id,enabled:true});
    assert(bundledOwner.available(),'bundled browser uses the native service without installing a ZIP');
    await assert.rejects(bundledOwner.run({op:'open',url:'https://docs.example/lesson'}),/permission denied/i);
    await request('/api/plugins','PUT',{id:bundledBrowser.id,enabled:false});
    assert(!bundledOwner.available());
    bundledOwner.close();
    const plugin = path.join(root, 'examples/extensions/browser-automation');
    const pkg = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json')));
    const archive = process.env.ASHUB_BROWSER_TEST_ZIP
      ? fs.readFileSync(process.env.ASHUB_BROWSER_TEST_ZIP)
      : zip(
          Object.fromEntries(
            ['package.json', ...pkg.files].map((f) => [f, fs.readFileSync(path.join(plugin, f), 'utf8')]),
          ),
        );
    const preview = await request('/api/plugins/install?action=preview', 'POST', archive);
    assert(preview.canInstall);
    const job = await request('/api/plugins/install?action=confirm', 'POST', { token: preview.token });
    await until(async () => {
      const j = await request('/api/plugins/install?id=' + job.id);
      assert.notEqual(j.state, 'failed', j.error);
      return j.state === 'succeeded';
    }, 'install');
    // The project extension has session tools and no declarative toolbar entry.
    const projectRoot = path.join(root, 'examples/extensions/project-management');
    const projectZip = process.env.ASHUB_PROJECT_TEST_ZIP ? fs.readFileSync(process.env.ASHUB_PROJECT_TEST_ZIP) :
      zip(Object.fromEntries(['package.json','ashub-plugin.json','index.mjs','work.mjs','README.md'].map(f=>[f,fs.readFileSync(path.join(projectRoot,f),'utf8')])));
    const projectPreview = await request('/api/plugins/install?action=preview','POST',projectZip);
    assert(projectPreview.canInstall);
    const projectJob = await request('/api/plugins/install?action=confirm','POST',{token:projectPreview.token});
    await until(async()=>{const j=await request('/api/plugins/install?id='+projectJob.id); assert.notEqual(j.state,'failed',j.error);return j.state==='succeeded';},'project plugin installed');
    // An unrelated plugin contributes a real toolbar panel. Its local panel ID
    // deliberately matches the retired browser panel to exercise plugin scoping.
    const toolsZip = zip({
      'package.json': JSON.stringify({name:'layout-tools',version:'1.0.0',type:'module',main:'index.mjs'}),
      'ashub-plugin.json': JSON.stringify({schemaVersion:2,id:'layout-tools',name:'测试工具',entries:{session:'index.mjs'},
        ui:{version:1,panels:[{id:'browser',title:'资料',components:[{type:'text',text:'资料'}]}]}}),
      'index.mjs':'export default () => {}',
    });
    const toolPreview = await request('/api/plugins/install?action=preview','POST',toolsZip);
    assert(toolPreview.canInstall,JSON.stringify(toolPreview));
    const toolJob = await request('/api/plugins/install?action=confirm','POST',{token:toolPreview.token});
    await until(async()=>{const j=await request('/api/plugins/install?id='+toolJob.id);assert.notEqual(j.state,'failed',j.error);return j.state==='succeeded';},'extra panel installed');
    await request('/api/plugins/install?id='+toolJob.id,'DELETE');
    for(const installed of (await request('/api/plugins')).plugins.filter(p=>p.includedApp && !p.bundled)){
      assert(!installed.enabled,'ZIP upgrade preserves disabled bundled state');
      await request('/api/plugins','PUT',{id:installed.id,enabled:true});
    }
    let delayNextStatus;
    ipcMain.handle('desktop:browser-status', (_e, id) => {
      const result = pages.status(id), delay = delayNextStatus;
      delayNextStatus = undefined;
      return delay ? delay(result) : result;
    });
    ipcMain.on('desktop:browser-layout', (_e, id, box) => pages.mount(win, id, box));
    let rejectHandoff = false;
    ipcMain.on('desktop:browser-control', (_e, id, action, pageId) => { if (!rejectHandoff) pages.control(id, action, pageId); });
    ipcMain.handle('get-update-mode', () => ({ manual: true }));
    ipcMain.handle('desktop:background:get', () => ({ enabled: false }));
    ipcMain.handle('desktop:background:set', () => ({ enabled: false }));
    ipcMain.handle('focus-window', () => {});

    async function openWindow(url) {
      win = new BrowserWindow({
        show: false,
        width: 1440,
        height: 850,
        webPreferences: {
          preload: path.join(root, 'electron/preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      await win.loadURL(url);
      win.showInactive();
    }
    await openWindow(base);
    const js = (code) => win.webContents.executeJavaScript(code);
    await js("localStorage.setItem('ash.lang','zh')");
    await win.loadURL(base);
    await until(() => js("!!document.querySelector('.extension-menu')"), 'extension menu');
    const browserInstallId = (await request('/api/plugins')).plugins.find(p=>p.manifest?.id==='ashub-browser-automation').id;
    const browserFeatureId = 'plugin-'+browserInstallId;
    const retiredKey = 'extension-'+browserFeatureId.length+'-'+browserFeatureId+'-panel-7-browser';
    async function assertRetiredEntryAbsent() {
      assert(await js(`!document.getElementById(${JSON.stringify(retiredKey+'-toggle')}) &&
        !document.getElementById(${JSON.stringify(retiredKey+'-panel')}) &&
        !document.querySelector('#rail-tool-menu [data-tool="'+${JSON.stringify(retiredKey+'-toggle')}+'"]')`),
        'retired browser shortcut is absent from both toolbar and More');
    }
    await assertRetiredEntryAbsent();
    await js("localStorage.setItem('ash.toolbar.unpinned',JSON.stringify(["+JSON.stringify(retiredKey+'-toggle')+"]))");
    async function capture(name) {
      if (!output) return;
      await js('document.fonts.ready.then(()=>true)');
      await sleep(400);
      fs.mkdirSync(output, { recursive: true });
      // WebContents capture omits native child views. Composite their actual pixels at native bounds.
      const shot = await win.webContents.capturePage(),
        size = shot.getSize();
      let bitmap = shot.toBitmap({ scaleFactor: 1 });
      if (name === 'home') {
        await js("Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().endTime < Infinity).map(a=>a.finished.catch(()=>{}))).then(()=>true)");
        const titleGreen = await js("Number(getComputedStyle(document.querySelector('.welcome-title')).color.match(/[0-9.]+/g)[1])");
        // Some compositors return the preceding blank frame even after the loader has faded.
        const title = await js("document.querySelector('.welcome-title').getBoundingClientRect().toJSON()");
        await until(async () => {
          win.webContents.invalidate();
          bitmap = (await win.webContents.capturePage()).toBitmap({scaleFactor: 1});
          let min = 255, max = 0;
          for (let y = Math.ceil(title.top); y < title.bottom; y++) {
            for (let x = Math.ceil(title.left); x < title.right; x++) {
              const green = bitmap[(y * size.width + x) * 4 + 1];
              min = Math.min(min, green);
              max = Math.max(max, green);
            }
          }
          const backgroundGreen = bitmap[(Math.floor(title.top) * size.width + Math.floor(title.left)) * 4 + 1];
          return max - min > 0.88 * Math.abs(titleGreen - backgroundGreen) && max - min > 40;
        }, 'welcome title painted');
      }
      for (const child of win.contentView.children) {
        const rect = child.getBounds();
        let pixels;
        // A remounted native guest can be attached one compositor frame before it has pixels.
        await until(async () => {
          const frame = await child.webContents.capturePage();
          if (frame.isEmpty()) return false;
          pixels = frame.resize({ width: rect.width, height: rect.height }).toBitmap({ scaleFactor: 1 });
          return pixels.length === rect.width * rect.height * 4;
        }, 'native guest screenshot');
        for (let y = 0; y < rect.height; y++)
          pixels.copy(
            bitmap,
            ((rect.y + y) * size.width + rect.x) * 4,
            y * rect.width * 4,
            (y + 1) * rect.width * 4,
          );
      }
      fs.writeFileSync(
        path.join(output, name + '.png'),
        electron.nativeImage.createFromBitmap(bitmap, size).toPNG(),
      );
    }
    await until(() => js(`document.querySelector('#no-session-cta').getClientRects().length > 0 &&
      Number(getComputedStyle(document.querySelector('#page-loader')).opacity) === 0`), 'welcome screen visible');
    await capture('home');
    if (!baseline) {
      for (const language of ['en', 'zh']) {
        win.setContentSize(390, 780);
        await js("import('/js/i18n.js').then(m=>m.setLang("+JSON.stringify(language)+"))");
        await js("document.querySelector('.app').classList.add('sidebar-collapsed'); document.querySelector('#no-session-cta').focus()");
        await until(()=>js("innerWidth===390"),'welcome narrow viewport');
        win.focus();
        win.webContents.focus();
        await js("document.querySelector('#no-session-cta').focus()");
        for (const backwards of [false, true]) {
          win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab',modifiers:backwards?['shift']:[]});
          win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab',modifiers:backwards?['shift']:[]});
        }
        await sleep(40);
        assert(await js(`document.querySelector('#version-label').getBoundingClientRect().right <= innerWidth &&
          document.querySelector('#conn').scrollWidth <= document.querySelector('#conn').clientWidth + 1`),
          'title bar status and version fit at 390px in '+language);
        assert(await js(`(()=>{const button=document.querySelector('#no-session-cta'),rect=button.getBoundingClientRect();
          return document.activeElement===button && button.matches(':focus-visible') && button.clientWidth+1>=button.scrollWidth &&
            [...document.querySelectorAll('#no-session-empty .template')].every(b=>b.offsetWidth>=b.scrollWidth && b.getBoundingClientRect().right<=innerWidth);
        })()`),'welcome actions fit at 390px in '+language);
      }
      win.setContentSize(1440,850);
      await js("document.querySelector('.app').classList.remove('sidebar-collapsed')");
      const folder = path.join(fixture.dir, 'starter');
      fs.mkdirSync(folder);
      await js("localStorage.setItem('ash.default-cwd'," + JSON.stringify(folder) + ')');
      await js("document.querySelector('#no-session-empty .template').click()");
      await until(
        () => js("document.querySelector('#query').value.includes('review')"),
        'editable starter draft',
      );
      const created = await request('/sessions');
      assert.equal(created.length, 1);
      assert.equal(created[0].cwd, folder);
      assert.equal(bridges.get(created[0].instanceId).messages.length, 0, 'no template auto-send');
      await js(
        "import('/js/session-manager.js').then(m=>m.closeTab(" +
          JSON.stringify(created[0].instanceId) +
          ',{backendClosed:true}))',
      );
      await request('/' + created[0].instanceId + '/', 'DELETE');
      await win.loadURL(base);
      await until(() => js("!!document.querySelector('.extension-menu')"), 'empty shell restored');
    }
    const folders = ['课程设计/教材', '课程审校/教材', '资料核查'],
      ids = [];
    for (const [index, folder] of folders.entries()) {
      const cwd = path.join(fixture.dir, folder);
      fs.mkdirSync(cwd, { recursive: true });
      const { instanceId } = await request('/sessions', 'POST', { cwd });
      ids.push(instanceId);
      await request('/' + instanceId + '/title', 'POST', {
        title: ['课程结构梳理', '第三讲内容审校', '网页资料核查'][index],
      });
    }
    const id = ids[0];
    await js("import('/js/session-manager.js').then(m=>m.switchTo(" + JSON.stringify(id) + '))');
    await sleep(500);
    const emit = (name, payload) => bridges.get(id).emit('event', { name, payload });
    emit('agent:query', { query: '请梳理课程结构，指出需要优先调整的地方。' });
    const reply =
      '建议先调整第三讲。它第一次引入参数估计，但前两讲尚未解释样本和总体的区别。\n\n### 建议的调整顺序\n\n1. 在第二讲补一个抽样例子。\n2. 将第三讲的推导移到实例之后。\n3. 保留原有练习，并增加一道解释结果的题。';
    emit('agent:response-chunk', { blocks: [{ type: 'text', text: reply }] });
    emit('agent:response-done', {});
    emit('agent:processing-done', {});
    await until(
      () => js("document.querySelector('session-view .agent-reply')?.textContent.includes('第三讲')"),
      'readable reply',
    );
    const resize = async (width) => {
      win.setContentSize(width, 820);
      await until(() => js('innerWidth===' + width), 'window size');
      await sleep(100);
    };
    const theme = (name) => js('document.documentElement.dataset.theme=' + JSON.stringify(name));
    for (const width of [1100, 1200, 1440]) {
      await resize(width);
      for (const mode of ['light', 'dark']) {
        await theme(mode);
        await capture('chat-' + width + '-' + mode);
      }
    }
    if (!baseline) {
      const other = ids[1];
      const background = bridges.get(other);
      background.emit('event',{name:'permission:request',payload:{requestId:'background-approval',expiresAt:Date.now()+60000}});
      const badge = sid => `li[data-session-id="${sid}"] .needs-attention`;
      await until(()=>js("!!document.querySelector("+JSON.stringify(badge(other))+")"),'background approval');
      assert(!await js("!!document.querySelector("+JSON.stringify(badge(id))+")"));
      background.emit('event',{name:'permission:resolved',payload:{requestId:'background-approval',outcome:'denied'}});
      await until(()=>js("!document.querySelector("+JSON.stringify(badge(other))+")"),'background decision cleared');
      fixture.clock(Date.now());
      background.emit('event',{name:'agent:error',payload:{message:'fixture interrupted'}});
      await until(()=>js("document.querySelector("+JSON.stringify(badge(other))+")?.textContent==='需处理'"),'unseen terminal error');
      await js("import('/js/session-manager.js').then(m=>m.switchTo("+JSON.stringify(other)+"))");
      await until(()=>js("!document.querySelector("+JSON.stringify(badge(other))+")"),'viewed error acknowledged');
      await js("import('/js/session-manager.js').then(m=>m.switchTo("+JSON.stringify(id)+"))");
      await js("import('/js/sse.js').then(m=>m.setModelCache({providers:[{name:'fixture',models:[{id:'long-model-name'.repeat(10)}]}]}))");
      await js("document.querySelector('session-view:not([hidden]) .usage-model-balance').focus()");
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});
      win.webContents.sendInputEvent({type:'char',keyCode:'\r'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
      await until(()=>js("document.querySelector('session-view:not([hidden]) .usage-model-balance').ariaExpanded==='true'"),'keyboard model picker');
      for (const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({type,keyCode:'Escape'});
      await until(()=>js("document.activeElement.matches('.usage-model-balance') && document.activeElement.ariaExpanded==='false'"),'model focus returned');
      const geometry = await js(
        `(()=>{const box=document.querySelector('.agent-box');return [box.offsetWidth,box.parentElement.clientWidth]})()`,
      );
      assert(geometry[0] < geometry[1] - 40, 'short message should hug its text');
      const locations = await js(
        "[...document.querySelectorAll('.session-cwd')].map(el=>[el.title,el.textContent])",
      );
      const matching = locations.filter(([full]) => full.endsWith('/教材'));
      assert.equal(new Set(matching.map((row) => row[1])).size, 2);
    }
    const site = 'https://docs.example';
    const partition =
      'persist:ashub-browser-' +
      createHash('sha256')
        .update(id + '\0' + site)
        .digest('hex');
    const guestSession = electron.session.fromPartition(partition);
    guestSession.protocol.handle(
      'https',
      () =>
        new Response(
          '<!doctype html><meta charset=utf-8><style>body{margin:32px 24px;background:#f8f7f3;color:#373b34;font:16px/1.65 system-ui}h1{font:600 28px Georgia}small{color:#727769}</style><small>课程资料库</small><h1>第三讲 · 参数估计</h1><p>本讲将通过一次抽样实验，说明样本均值与总体均值之间的关系。</p><h3>阅读目标</h3><ol><li>区分样本与总体</li><li>比较两种抽样方案</li><li>解释估计结果</li></ol>',
          { headers: { 'content-type': 'text/html; charset=utf-8' } },
        ),
    );
    const lifetime = new AbortController();
    pages.enable('layout-test', lifetime.signal);
    const owner = pages.bind(id, 'layout-test', async () => true);
    await owner.run({ op: 'open', url: site + '/lesson' });
    const view = () => win.contentView.children[0]?.webContents;
    await until(() => view()?.getURL() === site + '/lesson', 'initial native view');
    const guest = view();
    await guest.executeJavaScript("window.layoutMarker='preserved'");
    await js("document.querySelector('.browser-divider')?.focus()");
    if (!baseline) {
      rejectHandoff = true;
      await js("document.querySelector('.browser-mode').click()");
      await until(()=>js("!!document.querySelector('.toast') && !document.querySelector('.browser-mode').disabled"),'failed handoff feedback');
      assert(await js("document.querySelector('.browser-controller').hidden"));
      rejectHandoff = false;
      await js("document.querySelector('.toast-container')?.remove()");
      const old = await js("document.querySelector('.browser-pane').offsetWidth");
      await js(
        "document.querySelector('.browser-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))",
      );
      await until(
        () => js("document.querySelector('.browser-pane').offsetWidth>" + old),
        'keyboard resizing',
      );
      // Exercise both normal movement and a release delivered without its
      // intermediate pointermove (Chromium may coalesce native input on CI).
      await js(`window.resizeEvents=[];
        for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture']) {
          document.addEventListener(type,event=>{
            window.resizeEvents.push({type,x:event.clientX,buttons:event.buttons,target:event.target.className,
              captured:event.target.hasPointerCapture?.(event.pointerId),focused:document.hasFocus()});
            if(window.resizeEvents.length>24)window.resizeEvents.shift();
          },true);
        }`);
      for (const move of [true, false]) {
        const rect = await js("document.querySelector('.browser-divider').getBoundingClientRect().toJSON()");
        const right = await js("document.querySelector('.browser-pane').getBoundingClientRect().right");
        const x = Math.round(rect.x + 2), y = Math.round(rect.y + 40);
        const releaseX = x + (move ? 60 : -40);
        const expected = Math.round(right - releaseX);
        win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        await until(
          () => js("document.querySelector('.browser-pane').classList.contains('resizing')"),
          'pointer capture',
        );
        if (move) win.webContents.sendInputEvent({ type: 'mouseMove', x: releaseX, y, modifiers: ['leftButtonDown'] });
        win.webContents.sendInputEvent({ type: 'mouseUp', x: releaseX, y, button: 'left', clickCount: 1 });
        await until(
          () => js("!document.querySelector('.browser-pane').classList.contains('resizing')"),
          'pointer release',
        );
        const width = await js("document.querySelector('.browser-pane').offsetWidth");
        const events = await js('JSON.stringify(window.resizeEvents)');
        assert(Math.abs(width - expected) <= 1,
          `release commits final width (move=${move}): expected ${expected}, got ${width}; events=${events}`);
        const savedWidth = await js("Number(localStorage.getItem('ash.browser.width-ratio')) * (document.querySelector('.browser-pane').getBoundingClientRect().right - document.querySelector('.main').getBoundingClientRect().left)");
        assert(Math.abs(savedWidth - expected) <= 1, 'release persists the final width');
        await until(() => view() === guest, 'browser restored after drag');
      }
    }
    for (const width of [1100, 1200, 1440]) {
      await resize(width);
      const compact =
        !baseline && (await js("document.querySelector('.browser-pane').dataset.layout==='compact'"));
      if (!baseline) assert.equal(compact, width === 1100, 'width ' + width);
      for (const mode of ['light', 'dark']) {
        await theme(mode);
        await js("document.querySelectorAll('.permission-card.decided').forEach(card=>card.remove())");
        if (compact) await js("document.querySelector('.browser-web').click()");
        await until(() => !!view(), 'web attached');
        assert.equal(await view().executeJavaScript('window.layoutMarker'), 'preserved');
        const geometry = await js(`(()=>{const p=document.querySelector('.browser-pane'),main=document.querySelector('.main'),h=p.querySelector('header');
          const pane=p.getBoundingClientRect(), canvas=main.getBoundingClientRect(), viewport=p.querySelector('.browser-viewport').getBoundingClientRect();
          return {pane:pane.toJSON(),canvas:canvas.toJSON(),viewport:viewport.toJSON(),headerBottom:h.getBoundingClientRect().bottom,
            outer:parseFloat(getComputedStyle(p).borderTopRightRadius),inner:parseFloat(getComputedStyle(main).borderTopRightRadius),
            left:parseFloat(getComputedStyle(p).borderTopLeftRadius)};})()`);
        assert(geometry.outer>0 && geometry.inner===0 && (compact ? geometry.left===geometry.outer : geometry.left===0));
        if (!compact) assert(Math.abs(geometry.canvas.right-geometry.pane.left)<=1 && geometry.canvas.top===geometry.pane.top,'flush split seam');
        const native=win.contentView.children[0].getBounds();
        assert(native.y>=geometry.headerBottom-1 && native.y>=geometry.pane.top+geometry.outer &&
          Math.abs(native.x-geometry.viewport.x)<=1 && Math.abs(native.width-geometry.viewport.width)<=1 &&
          Math.abs(native.y-geometry.viewport.y)<=1 && Math.abs(native.height-geometry.viewport.height)<=1,'native guest stays below corners within the DOM viewport');
        await capture('web-' + width + '-' + mode);
        if (compact) {
          await js("import('/js/toast.js').then(({toast})=>toast('连接暂时中断',{duration:60000}))");
          await until(() => !view(), 'compact notification remains visible');
          await js("document.querySelector('.toast-container')?.remove()");
          await until(() => !!view(), 'guest restored after notification');
        }
        await js("document.querySelectorAll('.permission-card.decided').forEach(card=>card.remove())");
        const editingSettings = compact && mode === 'dark';
        if (editingSettings) {
          await js("document.getElementById('plugins-toggle').click()");
          await until(()=>js("document.activeElement.id==='plugins-close'"),'settings keyboard focus');
        }
        emit('permission:request', {
          kind: 'operation',
          requestId: 'layout-' + width + mode,
          explicit: true,
          title: '打开网页 · Open website', sourceName:'会话浏览器',
          scope:'site', browser:{ action:'open', origin:site },
          expiresAt: Date.now() + 300000,
          durationMs: 300000,
          items: [
            {
              title: '网页',
              fields: [
                { label: 'URL', value: site + '/lesson' },
                { label: '用途', value: '核对第三讲的知识点顺序' },
              ],
            },
          ],
        });
        await until(
          () => js("!!document.querySelector('session-view:not([hidden]) .permission-card:not(.decided)')"),
          'approval',
        );
        if (compact) {
          await until(() => !view(), 'compact approval exposes chat');
          assert(await js("document.querySelector('.browser-web').disabled"));
          if (editingSettings) {
            assert.equal(await js("document.activeElement.id"),'plugins-close','pending approval must preserve drawer focus');
            await js("document.getElementById('plugins-close').click()");
          } else assert(await js("document.activeElement === document.querySelector('.browser-chat')"));

        }
        if (!compact && !baseline) {
          const card = await js(
            "document.querySelector('.permission-card:not(.decided)').getBoundingClientRect().right",
          );
          assert(card <= win.contentView.children[0].getBounds().x + 2);
        }
        const row = `li[data-session-id="${id}"] .needs-attention`;
        await until(()=>js("!!document.querySelector("+JSON.stringify(row)+")"),'pending sidebar badge');
        if (width===1200 && mode==='dark') {
          await js("const sum=document.querySelector('.permission-card:not(.decided) details summary');sum.click();sum.focus()");
          await js("import('/js/i18n.js').then(m=>m.setLang('en'))");
          assert(await js("document.activeElement===document.querySelector('.permission-card:not(.decided) summary') && document.activeElement.parentElement.open"));
          await js("import('/js/i18n.js').then(m=>m.setLang('zh'));document.activeElement.click()");
        }
        await capture('approval-' + width + '-' + mode);
        emit('permission:resolved', { requestId: 'layout-' + width + mode, outcome: 'denied' });
        await until(() => js("!document.querySelector('.permission-card:not(.decided)')"), 'decision');
        await until(()=>js("!document.querySelector("+JSON.stringify(row)+")"),'resolved sidebar badge cleared');
      }
    }
    if (!baseline) {
      // At effective narrow widths the sidebar and backdrop overlay the guest.
      await resize(390);
      await js("document.querySelector('.app').classList.add('sidebar-collapsed'); document.querySelector('.browser-web').click()");
      await until(()=>!!view(),'narrow web visible');
      await js("document.querySelector('.app').classList.remove('sidebar-collapsed')");
      await until(()=>!view(),'native guest detached beneath the open narrow sidebar');
      await js("document.querySelector('.app').classList.add('sidebar-collapsed')");
      await until(()=>!!view(),'narrow sidebar close restores web');
      await js("document.querySelector('.browser-chat').click()");
      emit('agent:info',{model:'fixture-long-model-'.repeat(18),provider:'fixture'});
      const windowsLeaf = 'long-path-'.repeat(20);
      emit('shell:cwd-change',{cwd:'C:\\courses\\'+windowsLeaf});
      await until(()=>js("document.querySelector('session-view:not([hidden]) .usage-location').textContent==="+JSON.stringify(windowsLeaf)),'Windows leaf is displayed');
      assert(await js(`(()=>{const box=document.querySelector('session-view:not([hidden]) .usage-strip'),m=box.querySelector('.usage-model-balance'),cwd=box.querySelector('.usage-location');
        return m.title.includes('fixture-long-model-') && cwd.title.includes('long-path-') && m.scrollWidth>m.clientWidth &&
          m.getBoundingClientRect().right<=innerWidth && cwd.getBoundingClientRect().right<=innerWidth;})()`),'long identity and directory stay within the narrow strip');
      await resize(1440);
      await js("document.querySelector('.app').classList.remove('sidebar-collapsed')");
      await until(()=>!!view(),'split page reattached');
      await js("document.querySelector('.browser-mode').click()");
      await until(()=>js("!document.querySelector('.browser-controller').hidden && !document.querySelector('.browser-mode').disabled"),'manual state confirmed');
      for (const language of ['en','zh']) {
        await resize(390);
        await js("import('/js/i18n.js').then(m=>m.setLang("+JSON.stringify(language)+"))");
        await js("document.querySelector('.app').classList.add('sidebar-collapsed');document.querySelector('.browser-web').click()");
        await until(()=>view()===guest,'manual narrow view');
        await until(()=>js("document.querySelector('.browser-origin').clientWidth>=80"),'narrow site remains identifiable');
        assert(await js(`document.querySelector('.browser-close').getBoundingClientRect().right<=innerWidth &&
            document.querySelector('.browser-pane header').scrollWidth<=document.querySelector('.browser-pane header').clientWidth+1`),'narrow manual toolbar fits '+language);
        await capture('manual-390-'+language);
      }
      await js("document.querySelector('.browser-mode').click()");
      await until(()=>js("document.querySelector('.browser-controller').hidden"),'returned to assistant');
      await resize(1440);
      await js("document.querySelector('.app').classList.remove('sidebar-collapsed')");
      const savedScroll = await guest.executeJavaScript("document.body.style.minHeight='3200px'; scrollTo(0,640); scrollY");
      assert(savedScroll>0);
      await js("import('/js/session-manager.js').then(m=>m.switchTo("+JSON.stringify(ids[1])+"))");
      await until(()=>!view(),'switch away detaches previous session browser');
      await js("import('/js/session-manager.js').then(m=>m.switchTo("+JSON.stringify(id)+"))");
      await until(()=>view()===guest,'switch back restores original web contents');
      assert.equal(await guest.executeJavaScript('scrollY'),savedScroll,'session switch preserves page scroll');
      await js(`import('/js/toast.js').then(({toast})=>toast('连接暂时中断',{type:'error',duration:60000}))`);
      await until(() => js("!!document.querySelector('.toast')"), 'notification');
      assert(
        await js(
          `document.querySelector('.toast').getBoundingClientRect().right<=document.querySelector('.browser-viewport').getBoundingClientRect().left`,
        ),
      );
      await js("document.querySelector('.toast-container')?.remove()");
      const longText = '材料编号_' + 'research-'.repeat(170);
      emit('agent:query', {
        query: longText,
        images: [
          {
            mimeType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jmK0AAAAASUVORK5CYII=',
          },
        ],
      });
      await until(() => js("!!document.querySelector('.agent-box-img')"), 'attachment');
      assert(
        await js(
          `(()=>{const box=[...document.querySelectorAll('.agent-box')].at(-1);return box.scrollWidth<=box.clientWidth+1 && box.getBoundingClientRect().right<=document.querySelector('.browser-pane').getBoundingClientRect().left})()`,
        ),
        'long message remains in reading column',
      );
      await js("document.querySelector('.agent-box-img').click()");
      await until(() => !view(), 'image lightbox above guest');
      await js("document.querySelector('.img-lightbox').click()");
      await until(() => !!view(), 'guest returns after lightbox');
      await js("document.querySelector('.rail-more').click()");
      await until(
        () => js("document.querySelector('#rail-tool-menu').matches(':popover-open')"),
        'more open',
      );
      await until(() => !view(), 'native guest hidden beneath popover');
      await js(
        "window.pinFocusId=document.querySelector('.extension-menu').id; document.querySelector('#rail-tool-menu [data-tool='+CSS.escape(window.pinFocusId)+'] [aria-pressed]').focus(); document.querySelector('.extension-menu').title+=' '",
      );
      await sleep(50);
      assert(
        await js(
          "document.activeElement.closest('[data-tool]')?.dataset.tool===window.pinFocusId && document.activeElement.hasAttribute('aria-pressed')",
        ),
        'menu refresh retains keyboard focus',
      );
      await js("document.querySelector('#rail-tool-menu > div:last-child [aria-pressed]').click()");
      const pluginId = await js("document.querySelector('.extension-menu').id");
      assert(
        await js(
          'document.getElementById(' + JSON.stringify(pluginId) + ").classList.contains('rail-unpinned')",
        ),
      );
      await js("document.querySelector('#rail-tool-menu > div:last-child button').click()");
      await until(() => js("!document.querySelector('.extension-panel').hidden"), 'unpinned tool opened');
      await js("document.querySelector('.extension-panel .p-icon-btn').click()");
      const saved = await js("localStorage.getItem('ash.browser.width-ratio')");
      const oldWindow = win;
      win = null;
      oldWindow.destroy();
      await openWindow(base + '/' + id + '/');
      await until(
        () => js("!!document.querySelector('.extension-menu.rail-unpinned')"),
        'saved pin on fresh window',
      );
      await assertRetiredEntryAbsent();
      await until(() => !!view(), 'browser restored on fresh window');
      const ratio = await js(
        "document.querySelector('.browser-pane').offsetWidth/(document.querySelector('.browser-pane').getBoundingClientRect().right-document.querySelector('.main').getBoundingClientRect().left)",
      );
      assert(Math.abs(ratio - Number(saved)) < 0.01);
    }
    if (!baseline) {
      const oldPage=pages.status(id);
      let started, release;
      const held=new Promise(resolve=>{started=resolve});
      delayNextStatus=result=>new Promise(resolve=>{started();release=()=>resolve(result)});
      rejectHandoff=true;
      await js("document.querySelector('.browser-mode').click()");
      await held;
      pages.control(id,'close');
      await until(()=>js("document.querySelector('.browser-pane').hidden"),'original page closed');
      await owner.run({op:'open',url:site+'/lesson'});
      await until(()=>!!view(),'replacement page visible');
      assert(await js("!document.querySelector('.browser-mode').disabled"),'old pending handoff must not lock the replacement page');
      pages.control(id,'manual',oldPage.pageId);
      assert.equal(pages.status(id).manual,false,'stale manual action cannot control the replacement page');
      release();await sleep(60);rejectHandoff=false;
      assert(!await js("!!document.querySelector('.toast')"),'no stale handoff error on replacement page');
    }
    pages.control(id, 'close');
    await js("document.getElementById('plugins-toggle').click()");
    await until(
      () => js("!!document.querySelector('.plugin-item:not([data-builtin]) .plugin-configure')"),
      'plugin manager',
    );
    const inventory = (await request('/api/plugins')).plugins;
    const browserPlugin = inventory.find(p=>p.manifest?.id==='ashub-browser-automation');
    const projectPlugin = inventory.find(p=>p.manifest?.id==='ashub-project-management');
    assert(browserPlugin && projectPlugin);
    assert(!await js("!!document.querySelector('#features-list .plugin-toggle')"),'no package management entries in App features');
    for (const plugin of inventory.filter(p=>p.includedApp)) {
      const selector = '#plugin-toggle-'+plugin.id;
      assert(await js("document.querySelector('#plugins-list').contains(document.querySelector("+JSON.stringify(selector)+")) && document.querySelectorAll("+JSON.stringify(selector)+").length===1"));
    }
    const kimi = inventory.find(p=>p.bundled && p.manifest?.id==='ashub-kimi-coding-plan');
    const kimiToggle = '#plugin-toggle-'+kimi.id;
    const kimiRow='.plugin-item:has('+kimiToggle+')';
    assert(await js("(()=>{const e=document.querySelector("+JSON.stringify(kimiRow+' .plugin-name')+");return e.offsetHeight<=2*parseFloat(getComputedStyle(e).lineHeight)+1})()"),
      'the bundled source label must leave enough room for the plugin name');
    await js("document.querySelector("+JSON.stringify(kimiToggle)+").click()");
    await until(()=>js("document.querySelector("+JSON.stringify(kimiToggle)+").getAttribute('aria-checked')==='true'"),'enable Kimi from Local extensions');
    await js("document.querySelector("+JSON.stringify(kimiToggle)+").click()");
    await until(()=>js("document.querySelector("+JSON.stringify(kimiToggle)+").getAttribute('aria-checked')==='false'"),'disable Kimi from Local extensions');
    // Two independent renderers observe a session-only switch and its consent.
    const primary=win;
    await openWindow(base);
    const secondary=win;win=primary;
    const peer=source=>secondary.webContents.executeJavaScript(source);
    try {
      await peer("document.getElementById('plugins-toggle').click()");
      const selector=JSON.stringify('#plugin-toggle-'+projectPlugin.id);
      const consent=JSON.stringify('#plugin-approval-toggle-'+projectPlugin.id);
      await until(()=>peer("!!document.querySelector("+selector+")"),'second plugin manager loaded');
      const configure = '#plugins-list .plugin-item:has(#plugin-toggle-'+projectPlugin.id+') .plugin-configure';
      await js("document.querySelector("+JSON.stringify(configure)+").focus()");
      await peer("document.querySelector("+selector+").click()");
      await until(()=>js("document.querySelector("+selector+")?.getAttribute('aria-checked')==='false'"),'remote window sees project disable');
      assert(await js("document.activeElement===document.querySelector("+JSON.stringify(configure)+")"),'peer update preserves focus on the project configuration button');
      const browserConfigure=JSON.stringify('#plugin-configure-'+browserPlugin.id);
      const browserService=JSON.stringify('[data-plugin-id="'+browserPlugin.id+'"] .feature-toggle');
      await js("document.querySelector("+browserConfigure+").click();document.querySelector("+browserService+").focus()");
      await peer("document.querySelector("+consent+").click()");
      await until(()=>js("document.querySelector("+consent+")?.getAttribute('aria-checked')==='true'"),'remote window sees changed consent');
      assert(await js("document.activeElement===document.querySelector("+browserService+")"),'cross-window consent change keeps focus on a reused feature switch');
      await js("document.querySelector("+browserConfigure+").click()");
      await request('/api/plugins','PUT',{id:projectPlugin.id,autoApprove:false});
      await request('/api/plugins','PUT',{id:projectPlugin.id,enabled:true});
      await until(()=>js("document.querySelector("+selector+")?.getAttribute('aria-checked')==='true' && document.querySelector("+consent+")?.getAttribute('aria-checked')==='false'"),'remote window sees revocation and re-enable');
    } finally {secondary.destroy();}
    const browserRow = '.plugin-item:has(.plugin-bound-features[data-plugin-id="'+browserPlugin.id+'"])';
    await js("document.querySelector("+JSON.stringify(browserRow+' .plugin-configure')+").click()");
    await until(()=>js("!!document.querySelector("+JSON.stringify(browserRow+' .feature-toggle')+")"),'browser service remains configurable');
    assert(!await js("!!document.querySelector("+JSON.stringify(browserRow+' .plugin-entry-toggle')+")"));
    const toolsPlugin=inventory.find(p=>p.manifest?.id==='layout-tools');
    const toolsRow='.plugin-item:has(.plugin-bound-features[data-plugin-id="'+toolsPlugin.id+'"])';
    await js("document.querySelector("+JSON.stringify(toolsRow+' .plugin-configure')+").click()");
    await until(()=>js("!!document.querySelector("+JSON.stringify(toolsRow+' .plugin-entry-toggle')+")"),'other plugin keeps its placement control');
    assert(await js("document.querySelector('#plugins-list').contains(document.querySelector("+JSON.stringify(browserRow)+"))"),'browser appears in Local extensions');
    assert(await js("!!document.querySelector('#features-list [data-feature-id=mobile-access]') && document.querySelectorAll("+JSON.stringify(browserRow)+").length===1"),'no duplicate browser row');
    assert(!await js("!!document.querySelector('.plugin-bound-features[data-plugin-id=\""+projectPlugin.id+"\"] .plugin-entry-toggle')"));
    await js("document.querySelector("+JSON.stringify(toolsRow+' .plugin-entry-toggle')+").click()");
    await until(()=>js("!document.querySelector('.extension-menu').classList.contains('rail-unpinned')"),'plugin entry pin without granting consent');
    assert(!((await request('/api/plugins')).plugins.find(p=>p.id===toolsPlugin.id).autoApprove));
    assert(!((await request('/api/plugins')).plugins.find(p=>p.id===browserPlugin.id).autoApprove));
    await js("document.querySelector("+JSON.stringify(toolsRow+' .plugin-entry-toggle')+").click();document.querySelector("+JSON.stringify(browserRow+' .plugin-approval')+").scrollIntoView({block:'center'})");

    await js("window.initialStorageWrite=Storage.prototype.setItem; Storage.prototype.setItem=function(k,v){if(k==='ash.toolbar.unpinned')throw Error('storage full');return window.initialStorageWrite.call(this,k,v)};true");
    await js("document.querySelector("+JSON.stringify(toolsRow+' .plugin-entry-toggle')+").click()");
    assert(await js("!document.querySelector('.extension-menu').classList.contains('rail-unpinned')"),'placement still works in this window if saving is unavailable');
    await js("Storage.prototype.setItem=window.initialStorageWrite;document.querySelector("+JSON.stringify(toolsRow+' .plugin-entry-toggle')+").click()");
    await theme('light');
    await capture('plugins-light');
    await theme('dark');
    await capture('plugins-dark');
    if (!baseline) {
      const installed = (await request('/api/plugins')).plugins.find(
        (p) => p.manifest?.id === 'ashub-browser-automation',
      );
      assert(installed);
      await request('/api/plugins', 'DELETE', { id: installed.id });
      const restoreSelector='[data-restore="ashub-browser-automation"]';
      await until(()=>js("!!document.querySelector("+JSON.stringify(restoreSelector)+")"),'offline reinstall is available after uninstall');
      assert(!(await request('/api/plugins')).plugins.some(p=>p.manifest?.id==='ashub-browser-automation'));
      await js("document.querySelector("+JSON.stringify(restoreSelector)+").focus()");
      await request('/api/plugins','PUT',{id:projectPlugin.id,autoApprove:true});
      await until(()=>js("document.getElementById("+JSON.stringify('plugin-approval-toggle-'+projectPlugin.id)+")?.getAttribute('aria-checked')==='true'"),'catalog changes while the restore button is focused');
      assert(await js("document.activeElement===document.querySelector("+JSON.stringify(restoreSelector)+")"),'peer changes keep focus on available offline reinstall');
      await request('/api/plugins','PUT',{id:projectPlugin.id,autoApprove:false});
      await js("document.querySelector("+JSON.stringify(restoreSelector)+").click()");
      await until(async()=>(await request('/api/plugins')).plugins.some(p=>p.manifest?.id==='ashub-browser-automation' && p.bundled && !p.enabled && !p.autoApprove),'offline restore stays disabled');
      await assertRetiredEntryAbsent();
      assert(await js("!!document.querySelector('.extension-menu.rail-unpinned')"),'uninstall preserves unrelated plugin');
      await js(
        "document.getElementById('plugins-close').click();document.querySelector('.rail-more').click()",
      );
      await until(
        () => js("document.querySelector('#rail-tool-menu').matches(':popover-open')"),
        'menu after uninstall',
      );
      assert(!(await js("document.querySelector('#rail-tool-menu').textContent.includes('会话浏览器')")));
      await assertRetiredEntryAbsent();
      await js("document.querySelector('#rail-tool-menu').hidePopover()");
      const reinstall = await request('/api/plugins/install?action=preview', 'POST', archive);
      const rejob = await request('/api/plugins/install?action=confirm', 'POST', { token: reinstall.token });
      await until(async () => {
        const j = await request('/api/plugins/install?id=' + rejob.id);
        assert.notEqual(j.state, 'failed', j.error);
        return j.state === 'succeeded';
      }, 'reinstall');
      await until(
        () => js("!!document.querySelector('.extension-menu.rail-unpinned')"),
        'unrelated tool retains saved placement',
      );
    }
    await assertRetiredEntryAbsent();
    console.log(
      'PASS workspace reading layout, native browser, permissions, toolbar placement and window restoration',
    );
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    pages.close();
    win?.destroy();
    await hub?.shutdown();
    app.exit(process.exitCode || 0);
  }
});
