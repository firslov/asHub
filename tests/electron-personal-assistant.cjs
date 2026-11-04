const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { zip } = require('./plugin-zip-fixture.cjs');
const { env, Bridge, fs, path, root } = require('./harness.cjs');
const modules = {}, e = env({ modules, globals: { setTimeout, clearTimeout, setInterval, clearInterval, Date } });
process.env.AGENT_SH_HOME = e.dir;
app.setPath('userData', path.join(e.dir, 'browser'));
app.on('window-all-closed', () => {});
let hub, win, bridge;
const timeout = setTimeout(() => { console.error('Assistant UI timeout'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  try {
    modules['./extensions/installed.js'] = await import(pathToFileURL(path.join(root, 'dist/extensions/installed.js')).href);
    hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: options => (bridge = new Bridge(options)) });
    if (!hub.server.listening) await once(hub.server, 'listening');
    const base = 'http://127.0.0.1:' + hub.server.address().port;
    const call = async (route, body, headers) => {
      const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: headers ?? { 'Content-Type': 'application/json' }, body: body ? headers ? body : JSON.stringify(body) : undefined });
      const raw = await response.text(); assert.equal(response.status, 200, raw); return JSON.parse(raw);
    };
    const pkgRoot = path.join(root, 'examples/extensions/personal-assistant'), pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json')));
    const files = Object.fromEntries(['package.json', ...pkg.files].map(name => [name, fs.readFileSync(path.join(pkgRoot, name), 'utf8')]));
    const preview = await call('/api/plugins/install?action=preview', zip(files), { 'Content-Type': 'application/zip' }); assert(preview.canInstall, JSON.stringify(preview));
    const job = await call('/api/plugins/install?action=confirm', { token: preview.token }); let result;
    for (let i = 0; i < 150; i++) { result = await call('/api/plugins/install?id=' + job.id); if (result.state !== 'running') break; await new Promise(r => setTimeout(r, 20)); }
    assert.equal(result.state, 'succeeded', JSON.stringify(result));
    const id = (await call('/sessions', { cwd: e.dir, kind: 'agent', title: '个人助理', model:'tiny', provider:'mock' })).instanceId;
    bridge.emit('event', { name:'agent:info', payload:{model:'tiny',provider:'mock'} });
    let feature;
    for (let i = 0; i < 150; i++) { feature = (await call('/api/extensions')).features.find(f => f.name === '个人助手'); if (feature?.state === 'active') break; await new Promise(r => setTimeout(r, 20)); }
    assert.equal(feature?.state, 'active', JSON.stringify(feature));
    const resource = '/api/plugin-resources/' + encodeURIComponent(feature.pluginId) + '/assistant';
    win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if(event.level==='error') console.error('renderer:',event.message); });
    await win.loadURL(base);
    const js = async code => {try{return await win.webContents.executeJavaScript(code);}catch(e){console.error('Renderer expression:',code);throw e;}};
    const wait = async code => { for (let i = 0; i < 160; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 25)); } throw Error('Timed out: ' + code); };
    const click = label => js('(()=>{const b=Array.from(document.querySelectorAll(".extension-resource button")).find(b=>b.textContent===' + JSON.stringify(label) + ');if(!b)throw Error("Button missing");if(b.closest("details"))b.closest("details").open=true;b.click()})()');
    await js('(async()=>{localStorage.setItem("ash.lang","zh");(await import("/js/i18n.js")).setLang("zh")})()');
    await wait('!!document.querySelector(".extension-menu")'); await js('document.querySelector(".extension-menu").click()');
    await wait('document.querySelector(".extension-resource-actions")?.textContent.includes("开启助手")');
    assert.equal(await js('document.querySelectorAll(".extension-resource-actions > button").length'),2);
    assert.deepEqual(await js('(()=>{const s=document.querySelector(".extension-menu svg");return [s?.getAttribute("viewBox"),s?.getAttribute("stroke-width"),s?.getAttribute("width")]})()'),['0 0 14 14','1.3','18']);
    const seed=await call(resource,{action:'save',values:{title:'报告格式',content:'用简洁中文表达 先给结论 再列证据',kind:'preference',scope:'personal'}});
    await call(resource,{confirm:seed.confirmation.id});
    await click('开启助手'); await wait('!!document.querySelector(".extension-resource-form select")');
    assert.equal(await js('document.querySelectorAll(".extension-resource-form > label").length'),1,'only model selection is exposed');
    assert.equal(await js('document.querySelector(".extension-resource-advanced").open'),false);
    await js('document.querySelector(".extension-resource-form").requestSubmit()');
    await wait('!!document.querySelector(".extension-resource-review")');
    assert.match(await js('document.querySelector(".extension-resource-review").textContent'),/成本上限/);
    assert(!(await call(resource)).view.note.includes('后台学习已开启'));
    await click('取消'); await wait('!!document.querySelector(".extension-resource-form select")');
    await js('document.querySelector(".extension-resource-form").requestSubmit()'); await wait('!!document.querySelector(".extension-resource-review")');
    await click('确认'); await wait('document.querySelector(".extension-resource-actions")?.textContent.includes("暂停助手")');
    const shots=process.env.ASHUB_UI_SCREENSHOTS;if(shots)fs.mkdirSync(shots,{recursive:true});
    for(const theme of ['light','dark']){
      await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
      for(const width of [1280,390,320]){
        await js('document.querySelector(".app").classList.toggle("sidebar-collapsed",'+(width<600)+')');win.setContentSize(width,900);await new Promise(r=>setTimeout(r,100));
        assert.equal(await js('(()=>{const p=document.querySelector(".extension-panel");return p.scrollWidth<=p.clientWidth+1&&p.getBoundingClientRect().left>=-1})()'),true);
        assert.equal(await js('document.querySelectorAll(".extension-resource-actions > button").length'),2);
        if(shots)fs.writeFileSync(path.join(shots,'assistant-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
      }
    }
    await click('查看记忆');await wait('document.querySelector(".extension-resource-row h3")?.textContent==="报告格式"');
    assert.equal(await js('document.querySelectorAll(".extension-resource-actions > button").length'),2);
    await click('查看');await wait('document.querySelector(".extension-resource-actions")?.textContent.includes("忘记")');
    assert.equal(await js('document.querySelectorAll(".extension-resource-actions > button").length'),2);
    await click('忘记');await wait('!!document.querySelector(".extension-resource-review")');await click('取消');
    await click('返回');await wait('document.querySelector(".extension-resource-actions")?.textContent.includes("搜索")');
    await click('返回');await wait('document.querySelector(".extension-resource-actions")?.textContent.includes("暂停助手")');
    await click('暂停助手');await wait('!!document.querySelector(".extension-resource-review")');await click('确认');
    await wait('document.querySelector(".extension-resource-actions")?.textContent.includes("继续运行")');
    assert.match((await call(resource)).view.note,/已暂停/);
    await click('继续运行');await wait('!!document.querySelector(".extension-resource-review")');await click('确认');
    await wait('document.querySelector(".extension-resource-actions")?.textContent.includes("暂停助手")');
    const pending=await call(resource,{action:'save',values:{title:'未保存',content:'不要保存',kind:'fact',scope:'personal'}});
    await call('/api/extensions/'+feature.id+'/enabled',{enabled:false});
    const rejected=await fetch(base+resource,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:pending.confirmation.id})});assert.equal(rejected.status,409);
    await call('/api/extensions/'+feature.id+'/enabled',{enabled:true});
    assert.equal((await call(resource,{action:'memories',values:{}})).view.rows.length,1,'restart preserves memory and does not commit cancelled actions');
    console.log('PASS assistant minimal UI: install, SVG stroke, two controls, first-use authorization, pause/resume, memory inspection, cancel forget, restart and six theme/width combinations');
    win.destroy(); await hub.shutdown(); clearTimeout(timeout); app.exit(0);
  } catch (error) { console.error(error); win?.destroy(); try { await hub?.shutdown(); } catch {} clearTimeout(timeout); app.exit(1); }
});
