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
    hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: options => {bridge=new Bridge(options);const b=bridge;setTimeout(()=>b.emit('event',{name:'agent:info',payload:{model:'tiny',provider:'mock'}}),0);return b;} });
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
    win = new BrowserWindow({ show: true, width: 1280, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', event => { if(event.level==='error') console.error('renderer:',event.message); });
    await win.loadURL(base);
    const js = async code => {try{return await win.webContents.executeJavaScript(code);}catch(e){console.error('Renderer expression:',code);throw e;}};
    const wait = async code => { for (let i = 0; i < 160; i++) { if (await js(code)) return; await new Promise(r => setTimeout(r, 25)); } throw Error('Timed out: ' + code); };
    const click = label => js('(()=>{const b=Array.from(document.querySelectorAll(".extension-resource button")).find(b=>b.textContent===' + JSON.stringify(label) + ');if(!b)throw Error("Button missing");if(b.closest("details"))b.closest("details").open=true;b.click()})()');
    await js('(async()=>{localStorage.setItem("ash.lang","zh");(await import("/js/i18n.js")).setLang("zh")})()');
    await wait('!!document.querySelector(".conversation-entry-open")');
    await wait('document.querySelector(".extension-menu")?.hidden===true');
    // Dedicated entries use the sidebar type scale, even when labels are long.
    const entryStyle=await js(`(()=>{const b=document.querySelector('.conversation-entry-open'),row=b.parentElement,more=row.querySelector('.conversation-entry-manage');const label=b.textContent;b.textContent='个人助手 · 很长的专属对话名称'.repeat(6);const style=getComputedStyle(b),r=row.getBoundingClientRect(),m=more.getBoundingClientRect();const result={size:style.fontSize,reference:getComputedStyle(document.querySelector('.sidebar-new-btn')).fontSize,weight:Number(style.fontWeight),fits:row.scrollWidth<=row.clientWidth+1,manageVisible:m.right<=r.right+1&&m.width>=32};b.textContent=label;return result;})()`);
    assert.equal(entryStyle.size,entryStyle.reference,'entry matches sidebar typography');
    assert(entryStyle.weight<=500&&entryStyle.fits&&entryStyle.manageVisible,JSON.stringify(entryStyle));
    if(process.env.ASHUB_UI_SCREENSHOTS){
      fs.mkdirSync(process.env.ASHUB_UI_SCREENSHOTS,{recursive:true});
      for(const theme of ['light','dark']){
        await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
        await new Promise(r=>setTimeout(r,300)); // Let theme color transitions settle before capture.
        await wait('getComputedStyle(document.getElementById("page-loader")).visibility==="hidden"');
        await js('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
        fs.writeFileSync(path.join(process.env.ASHUB_UI_SCREENSHOTS,'assistant-entry-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
      }
      await js('document.documentElement.dataset.theme="light"');
    }
    // A late first-use read must not pull the user back from another chat.
    await js(`(()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).endsWith('/welcome')&&!args[1]?.body)await new Promise(resolve=>window.releaseWelcome=resolve);return response;};window.restoreWelcomeFetch=()=>window.fetch=original;document.querySelector('.conversation-entry-open').click();})()`);
    await wait('typeof window.releaseWelcome === "function"');
    await js('(async()=>{(await import("/js/session-manager.js")).openTab('+JSON.stringify(id)+');window.restoreWelcomeFetch();window.releaseWelcome();})()');
    await wait('!document.querySelector(".conversation-welcome")');
    assert.equal(await js('document.querySelector(".terminal-wrap").inert'),false);
    assert.equal((await call('/sessions')).length,1);
    // Use the actual narrow-screen entry path rather than manually hiding the
    // sidebar after navigation; the workspace must be reachable immediately.
    win.setContentSize(320,800);await wait('innerWidth===320');
    // Make the real collapse fade outlast two frames even on fast CI runners.
    await js('document.documentElement.style.setProperty("--dur-fast","400ms");document.querySelector(".app").classList.remove("sidebar-collapsed")');
    await wait('getComputedStyle(document.getElementById("sidebar")).visibility==="visible"');
    await js('document.querySelector(".conversation-entry-open").click()');
    await wait('!!document.querySelector(".conversation-welcome .extension-resource-form select")');
    assert(await js('document.querySelector(".app").classList.contains("sidebar-collapsed")'),'opening the assistant on a narrow screen must close the sidebar');
    const shots=process.env.ASHUB_UI_SCREENSHOTS;if(shots)fs.mkdirSync(shots,{recursive:true});
    for(const width of [320,1280]){
      await js('document.querySelector(".app").classList.toggle("sidebar-collapsed",'+(width<600)+')');win.setContentSize(width,800);
      await wait('innerWidth==='+width);await js('document.querySelector(".app").classList.toggle("sidebar-collapsed",'+(width<600)+')');await js('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
      await wait('document.querySelector(".conversation-welcome").clientWidth >= '+(width<600?width-64:440));
      // Collapse deliberately delays visibility until its fade completes. Two
      // animation frames only confirm layout, not that the overlay stopped hit-testing.
      if(width<600)await wait('getComputedStyle(document.getElementById("sidebar")).visibility==="hidden"');
      if(shots)fs.writeFileSync(path.join(shots,'assistant-welcome-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
      const hit=await js(`(()=>{const e=document.querySelector('.conversation-welcome select'),r=e.getBoundingClientRect(),p=document.querySelector('.conversation-welcome');return {width:innerWidth,scroll:p.scrollWidth,client:p.clientWidth,rect:r.toJSON(),target:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML,clickable:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e}})()`);
      assert(hit.scroll<=hit.client+1&&hit.clickable,JSON.stringify(hit));
    }

    await js('document.documentElement.style.removeProperty("--dur-fast")');
    assert.equal(await js('document.querySelectorAll(".conversation-welcome .extension-resource-form > label").length'),1);
    assert.equal(await js('document.querySelector(".extension-panel").hidden'),true,'first use belongs in the chat canvas');
    const welcomeSubmit=()=>js('document.querySelector(".conversation-welcome .extension-resource-form").requestSubmit()');
    // Scope controls to the visible workspace, not the offscreen settings resource.
    const welcomeClick=label=>js('(()=>{const b=[...document.querySelectorAll(".conversation-welcome button")].find(b=>b.textContent==='+JSON.stringify(label)+');if(!b)throw Error("Missing welcome action");b.click()})()');
    await welcomeSubmit();await wait('!!document.querySelector(".conversation-welcome .extension-resource-review")');
    await welcomeClick('取消');await wait('!!document.querySelector(".conversation-welcome .extension-resource-form select")');
    assert.equal((await call('/sessions')).length,1,'cancel creates no chat');
    await welcomeSubmit();await wait('!!document.querySelector(".conversation-welcome .extension-resource-review")');await welcomeClick('确认');
    await wait('document.querySelector(".conversation-welcome .extension-resource-actions")?.textContent.includes("开启记忆并开始聊天")');
    const assistantId=(await call('/api/plugin-conversations'))[0].sessionId;assert(assistantId);assert.notEqual(assistantId,id);
    await welcomeClick('开启记忆并开始聊天');await wait('!!document.querySelector(".conversation-welcome .extension-resource-review")');assert.match(await js('document.querySelector(".conversation-welcome .extension-resource-review").textContent'),/仅整理.*不读取其他对话/);
    assert.equal(await js('document.querySelectorAll(".conversation-welcome .extension-resource > .extension-resource-review > dt").length'),3);
    assert.equal(await js('document.querySelector(".extension-authorization-details").open'),false);
    assert(!(await js('document.querySelector(".conversation-welcome .extension-resource > .extension-resource-review").textContent')).includes(assistantId));
    const beforeConsent=(await call('/sessions')).length;
    for(const width of [320,1280]){
      win.setContentSize(width,800);await wait('innerWidth==='+width);await js('document.querySelector(".app").classList.toggle("sidebar-collapsed",'+(width<600)+')');
      await wait('document.querySelector(".conversation-welcome").clientWidth >= '+(width<600?width-64:440));
      for(const expanded of [false,true]){
        await js('document.querySelector(".extension-authorization-details").open='+expanded);
        assert(await js('(()=>{const p=document.querySelector(".conversation-welcome");return p.scrollWidth<=p.clientWidth+1})()'),'authorization never overflows');
        if(expanded){const detail=await js('document.querySelector(".extension-authorization-details").textContent');assert.match(detail,/16000.*4096/);assert(!detail.includes(assistantId));assert(!/观察范围|历史范围|排除对话/.test(detail));}
        if(shots){await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');fs.writeFileSync(path.join(shots,'consent-'+width+'-'+expanded+'.png'),(await win.webContents.capturePage()).toPNG());}
      }
    }
    assert.equal((await call('/sessions')).length,beforeConsent,'expanding details has no side effects');
    await js('document.querySelector(".extension-authorization-details").open=false');
    await welcomeClick('确认');
    await wait('(async()=> (await import("/js/session-manager.js")).activeSessionId.value === '+JSON.stringify(assistantId)+')()');
    assert.equal(await js('!!document.querySelector(".conversation-welcome")'),false);
    assert.equal(await js('document.querySelector(".terminal-wrap").inert'),false);
    await wait('document.querySelector("session-view[session-id="+CSS.escape('+JSON.stringify(assistantId)+')+"] .welcome-title")?.textContent === "个人助手"');
    for(let i=0;i<3;i++)await js('document.querySelector(".conversation-entry-open").click()');
    assert.equal((await call('/sessions')).length,2,'repeated entry uses same assistant');
    await win.loadURL(base);await wait('!!document.querySelector(".conversation-entry-open")');
    win.setContentSize(320,800);await wait('innerWidth===320');
    await js('document.querySelector(".app").classList.remove("sidebar-collapsed");document.querySelector(".conversation-entry-open").click()');
    assert(await js('document.querySelector(".app").classList.contains("sidebar-collapsed")'),'an existing assistant entry also closes mobile navigation');
    await wait('(async()=> (await import("/js/session-manager.js")).activeSessionId.value === '+JSON.stringify(assistantId)+')()');
    assert.equal((await call('/sessions')).length,2,'reload reuses persisted assistant');
    await wait('getComputedStyle(document.getElementById("page-loader")).visibility==="hidden" && Number(getComputedStyle(document.querySelector(".terminal-wrap")).opacity) > .99');
    await js('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    if(shots)fs.writeFileSync(path.join(shots,'assistant-chat.png'),(await win.webContents.capturePage()).toPNG());
    await js('document.querySelector(".conversation-entry-manage").click()');
    await wait('document.querySelector(".extension-resource-actions")?.textContent.includes("暂停记忆")');
    for(const theme of ['light','dark']){
      await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
      for(const width of [1280,390,320]){
        await js('document.querySelector(".app").classList.toggle("sidebar-collapsed",'+(width<600)+')');
        win.setContentSize(width,800);
        await wait('innerWidth === '+width+' && innerHeight === 800');
        await js('document.querySelector(".app").classList.toggle("sidebar-collapsed",'+(width<600)+')');
        await new Promise(r=>setTimeout(r,500));
        // Native resize and viewport-unit style invalidation need not finish in
        // the same task on CI. Measure after Chromium has painted the new size,
        // rather than after a fixed sleep that can still see the previous vw.
        await js('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
        const bounds = await js('(()=>{const p=document.querySelector(".extension-panel"),r=p.getBoundingClientRect();return {scrollWidth:p.scrollWidth,clientWidth:p.clientWidth,left:r.left,right:r.right,viewport:innerWidth,height:innerHeight,hidden:p.hidden,children:[...p.children].map(n=>({className:n.className,scrollWidth:n.scrollWidth,clientWidth:n.clientWidth,width:n.getBoundingClientRect().width}))}})()');
        assert(bounds.scrollWidth<=bounds.clientWidth+1&&bounds.left>=-1, JSON.stringify({theme,width,...bounds}));
        assert.equal(await js('document.querySelectorAll(".extension-resource-actions > button").length'),2);
        if(shots)fs.writeFileSync(path.join(shots,'assistant-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
      }
    }
    await click('查看记忆');await wait('document.querySelector(".extension-resource-note")?.textContent.includes("与你有关")');
    assert.equal(await js('document.querySelectorAll(".extension-resource-row").length'),4);
    await click('返回');await wait('document.querySelector(".extension-resource-actions")?.textContent.includes("暂停记忆")');
    await click('暂停记忆');await wait('!!document.querySelector(".extension-resource-review")');await click('确认');await wait('document.querySelector(".extension-resource-actions")?.textContent.includes("开启记忆")');
    await call('/api/extensions/'+feature.id+'/enabled',{enabled:false});
    await wait('document.querySelector(".conversation-entries")?.hidden===true');
    await call('/api/extensions/'+feature.id+'/enabled',{enabled:true});await wait('document.querySelector(".conversation-entries")?.hidden===false');
    assert.equal((await call('/api/plugin-conversations'))[0].sessionId,assistantId);
    await js(`(async()=>{
      const {mountResource}=await import('/js/extensions/resource-view.js');
      const host=document.createElement('div');document.body.append(host);const navigated=[];
      const view={actions:[{id:'go',label:'Go',values:{}}],rows:[],openConversation:'abcdef'};
      let release;const dispose=mountResource(host,{pluginId:'test'},'start',{request:async body=>body?new Promise(r=>release=()=>r({view})):{view},onComplete:id=>navigated.push(id)});
      await new Promise(r=>setTimeout(r,20));if(navigated.length)throw Error('Passive GET navigated');
      host.querySelector('button').click();await new Promise(r=>setTimeout(r,20));dispose();release();await new Promise(r=>setTimeout(r,20));
      if(navigated.length)throw Error('Disposed resource navigated');host.remove();
    })()`);
    console.log('PASS dedicated assistant UI: ZIP install, explicit creation/grant, one persistent entry, in-app navigation, pause, themes, disable/re-enable and 1280/390/320 layouts');
    win.destroy();await hub.shutdown();clearTimeout(timeout);app.exit(0);
  }catch(error){console.error(error);win?.destroy();try{await hub?.shutdown();}catch{}clearTimeout(timeout);app.exit(1);}
});
