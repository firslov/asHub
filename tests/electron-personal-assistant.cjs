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
    await wait('!document.querySelector(".extension-menu") || document.querySelector(".extension-menu").hidden===true');
    // Dedicated entries use the sidebar type scale, even when labels are long.
    const entryStyle=await js(`(()=>{const b=document.querySelector('.conversation-entry-open'),row=b.parentElement,more=row.querySelector('.conversation-entry-control');const label=b.textContent;b.textContent='个人助手 · 很长的专属对话名称'.repeat(6);const style=getComputedStyle(b),r=row.getBoundingClientRect(),m=more.getBoundingClientRect();const result={size:style.fontSize,reference:getComputedStyle(document.querySelector('.sidebar-new-btn')).fontSize,weight:Number(style.fontWeight),fits:row.scrollWidth<=row.clientWidth+1,manageVisible:m.right<=r.right+1&&m.width>=32};b.textContent=label;return result;})()`);
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
    // Hold the fade open long enough to test interaction while the overlay still paints.
    await js('document.documentElement.style.setProperty("--dur-fast","10s");document.querySelector(".app").classList.remove("sidebar-collapsed")');
    await wait('getComputedStyle(document.getElementById("sidebar")).visibility==="visible"');
    await js('document.querySelector(".conversation-entry-open").click()');
    await wait('!!document.querySelector(".conversation-welcome .extension-resource-form select")');
    assert(await js('document.querySelector(".app").classList.contains("sidebar-collapsed")'),'opening the assistant on a narrow screen must close the sidebar');
    // A transparent/collapsing navigation layer must stop intercepting input
    // immediately, including scroll containers and hover-enabled action buttons.
    await js('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    await wait('(()=>{const r=document.querySelector(".conversation-welcome select").getBoundingClientRect();return r.width>0&&r.left>=0&&r.bottom<=innerHeight&&document.querySelector(".conversation-welcome").clientWidth>=256})()');
    const collapsedHit=await js(`(()=>{const s=document.getElementById('sidebar'),e=document.querySelector('.conversation-welcome select'),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {rect:r.toJSON(),visibility:getComputedStyle(s).visibility,clickable:hit===e,target:hit?.outerHTML,interactive:[s,...s.querySelectorAll('*')].filter(n=>getComputedStyle(n).pointerEvents!=='none').map(n=>n.id||n.className).slice(0,8)}})()`);
    assert(collapsedHit.clickable&&collapsedHit.interactive.length===0,JSON.stringify(collapsedHit));
    // Reopening must restore hit-testing; closing again must release the form.
    await js('document.getElementById("sidebar-toggle").click()');
    const reopened=await js(`(()=>{const b=document.querySelector('.conversation-entry-open'),r=b.getBoundingClientRect();return !document.querySelector('.app').classList.contains('sidebar-collapsed')&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`);
    assert(reopened,'reopened sidebar entry must remain clickable');
    await js('document.querySelector(".conversation-entry-open").click();document.documentElement.style.removeProperty("--dur-fast")');
    await wait('!!document.querySelector(".conversation-welcome select")');
    const shots=process.env.ASHUB_UI_SCREENSHOTS;if(shots)fs.mkdirSync(shots,{recursive:true});
    for(const width of [320,1280]){
      await js('document.querySelector(".app").classList.toggle("sidebar-collapsed",'+(width<600)+')');win.setContentSize(width,800);
      await wait('innerWidth==='+width);await js('document.querySelector(".app").classList.toggle("sidebar-collapsed",'+(width<600)+')');await js('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
      await wait('document.querySelector(".conversation-welcome").clientWidth >= '+(width<600?width-64:440));
      // Collapse deliberately delays visibility until its fade completes. Two
      // animation frames only confirm layout, not that the overlay stopped hit-testing.
      if(width<600)await wait('getComputedStyle(document.getElementById("sidebar")).visibility==="hidden"');
      if(shots)fs.writeFileSync(path.join(shots,'assistant-welcome-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
      const hit=await js(`(()=>{const e=document.querySelector('.conversation-welcome select'),r=e.getBoundingClientRect(),p=document.querySelector('.conversation-welcome');return {width:innerWidth,scroll:p.scrollWidth,client:p.clientWidth,rect:r.toJSON(),sidebar:{className:document.querySelector(".app").className,visibility:getComputedStyle(document.getElementById("sidebar")).visibility,pointerEvents:getComputedStyle(document.getElementById("sessions")).pointerEvents},target:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML,clickable:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e}})()`);
      assert(hit.scroll<=hit.client+1&&hit.clickable,JSON.stringify(hit));
      const check=await js(`(()=>{const e=document.querySelector('.conversation-welcome input[type="checkbox"]'),r=e.getBoundingClientRect(),l=e.closest('label').getBoundingClientRect(),before=e.checked;e.closest('label').click();const toggled=e.checked!==before;e.closest('label').click();return {width:r.width,height:r.height,aligned:Math.abs((r.top+r.height/2)-(l.top+l.height/2))<2,toggled,restored:e.checked===before}})()`);
      assert(check.width<=20&&check.height<=20&&check.aligned&&check.toggled&&check.restored,JSON.stringify(check));
    }

    await js('document.documentElement.style.removeProperty("--dur-fast")');
    assert.equal(await js('document.querySelectorAll(".conversation-welcome .extension-resource-form > label").length'),2);
    assert.equal(await js('!document.querySelector(".conversation-memory-dialog")'),true,'first use belongs in the chat canvas');
    const welcomeSubmit=()=>js('document.querySelector(".conversation-welcome .extension-resource-form").requestSubmit()');
    // Scope controls to the visible workspace, not the offscreen settings resource.
    const welcomeClick=label=>js('(()=>{const b=[...document.querySelectorAll(".conversation-welcome button")].find(b=>b.textContent==='+JSON.stringify(label)+');if(!b)throw Error("Missing welcome action");b.click()})()');
    await welcomeSubmit();await wait('!!document.querySelector(".conversation-welcome .extension-resource-review")');
    await welcomeClick('取消');await wait('!!document.querySelector(".conversation-welcome .extension-resource-form select")');
    assert.equal((await call('/sessions')).length,1,'cancel creates no chat');
    await welcomeSubmit();await wait('!!document.querySelector(".conversation-welcome .extension-resource-review")');
    const consent=await js('document.querySelector(".conversation-welcome .extension-resource-review").textContent');
    assert.match(consent,/当前及今后/);assert.match(consent,/16000/);assert.match(consent,/4096/);
    await welcomeClick('确认');await wait('!document.querySelector(".conversation-welcome")');
    const assistantId=(await call('/api/plugin-conversations'))[0].sessionId;
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
    await wait('document.querySelector(".resource-inline-toggle")?.getAttribute("aria-checked")==="true"');
    assert.equal(await js('!!document.querySelector(".conversation-memory-dialog")'),false);
    // Off is immediate; opening memory still requires explicit authorization.
    await js('document.querySelector(".resource-inline-toggle").click()');
    await wait('document.querySelector(".resource-inline-toggle")?.getAttribute("aria-checked")==="false"');
    assert.equal(await js('!!document.querySelector("dialog[open]")'),false);
    await js('document.querySelector(".resource-inline-toggle").click()');
    await wait('!!document.querySelector(".resource-toggle-confirm[open]")');
    assert.equal(await js('document.querySelector(".resource-inline-toggle").getAttribute("aria-checked")'), 'false');
    win.setMaximumSize(2000,720);
    for(const theme of ['light','dark'])for(const width of [1280,390,320]){
      await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
      win.setContentSize(width,800);await wait('innerWidth === '+width+' && innerHeight > 0 && innerHeight <= 720');
      await js('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
      const bounds=await js('(()=>{const p=document.querySelector(".resource-toggle-confirm"),r=p.getBoundingClientRect();return {scroll:p.scrollWidth,client:p.clientWidth,left:r.left,right:r.right,viewport:innerWidth}})()');
      assert(bounds.scroll<=bounds.client+1&&bounds.left>=-1&&bounds.right<=bounds.viewport+1,JSON.stringify({theme,width,...bounds}));
      if(shots)fs.writeFileSync(path.join(shots,'assistant-consent-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    // Escape in the permission dialog must never cancel the running chat.
    await js(`(async()=>{
      const {state}=await import('/js/state.js');state.isProcessing=true;
      const original=window.fetch;window.memoryCancelRequests=0;
      window.fetch=(...args)=>{if(String(args[0]).endsWith('/cancel')){window.memoryCancelRequests++;return Promise.resolve(new Response('{}',{status:200}));}return original(...args);};
      window.restoreMemoryFetch=()=>{window.fetch=original;state.isProcessing=false;};
    })()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await wait('!document.querySelector(".resource-toggle-confirm")');
    assert.equal(await js('window.memoryCancelRequests'),0);
    await js('window.restoreMemoryFetch()');
    assert.equal(await js('document.querySelector(".resource-inline-toggle").getAttribute("aria-checked")'),'false');
    await js('document.querySelector(".resource-inline-toggle").click()');await wait('!!document.querySelector(".resource-toggle-confirm[open]")');
    const beforeShortcut=await js('(async()=> (await import("/js/session-manager.js")).activeSessionId.value)()');
    await js(`document.querySelector('.resource-toggle-confirm button').dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',ctrlKey:true,bubbles:true,cancelable:true}))`);
    assert.equal(await js('(async()=> (await import("/js/session-manager.js")).activeSessionId.value)()'),beforeShortcut);
    await click('取消');assert.equal(await js('document.querySelector(".resource-inline-toggle").getAttribute("aria-checked")'),'false');
    await js('document.querySelector(".resource-inline-toggle").click()');await wait('!!document.querySelector(".resource-toggle-confirm[open]")');
    await click('确认');await wait('document.querySelector(".resource-inline-toggle")?.getAttribute("aria-checked")==="true"');
    assert.equal(await js('!!document.querySelector("dialog[open]")'),false);
    // Polling retains the control instead of replacing it or opening settings.
    await js('window.memorySwitchNode=document.querySelector(".resource-inline-toggle")');await new Promise(r=>setTimeout(r,5500));
    assert.equal(await js('window.memorySwitchNode===document.querySelector(".resource-inline-toggle")'),true);
    win.setContentSize(1280,700);await wait('innerWidth===1280');
    await js('document.querySelector(".app").classList.remove("sidebar-collapsed")');
    await new Promise(r=>setTimeout(r,400));
    await js('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
    if(shots)fs.writeFileSync(path.join(shots,'assistant-inline-switch.png'),(await win.webContents.capturePage()).toPNG());
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
    await js(`(async()=>{
      const {mountResource,validateResourceView}=await import('/js/extensions/resource-view.js');
      let invalid=false;try{validateResourceView({actions:[],rows:[],toggle:{label:'Memory',checked:'yes',action:'enable'}})}catch{invalid=true}if(!invalid)throw Error('Malformed toggle accepted');
      const host=document.createElement('div');document.body.append(host);let calls=0,release;
      const view={actions:[{id:'enable',label:'Enable',values:{}}],rows:[],toggle:{label:'Memory',checked:false,action:'enable'}};
      const dispose=mountResource(host,{pluginId:'test'},'start',{inlineToggle:true,request:async body=>{
        if(!body)return {view};calls++;if(body.action)return new Promise(r=>release=()=>r({confirmation:{id:'grant',preview:{title:'Permission',fields:[]}}}));throw Error('test confirmation failed');
      }});
      const wait=()=>new Promise(r=>setTimeout(r,30));await wait();const b=host.querySelector('[role=switch]');b.click();b.click();if(calls!==1)throw Error('Duplicate toggle request');release();await wait();
      const d=document.querySelector('.resource-toggle-confirm');d.querySelector('.p-btn-primary').click();await wait();
      if(!d.textContent.includes('test confirmation failed'))throw Error('Confirmation error hidden behind dialog');
      if(host.querySelector('[role=switch]').getAttribute('aria-checked')!=='false')throw Error('Failed enable changed visual state');
      dispose();if(document.querySelector('.resource-toggle-confirm'))throw Error('Disposed control left a permission dialog');host.remove();
    })()`);
    console.log('PASS dedicated assistant UI: ZIP install, explicit creation/grant, one persistent entry, in-app navigation, pause, themes, disable/re-enable and 1280/390/320 layouts');
    win.destroy();await hub.shutdown();clearTimeout(timeout);app.exit(0);
  }catch(error){console.error(error);win?.destroy();try{await hub?.shutdown();}catch{}clearTimeout(timeout);app.exit(1);}
});
