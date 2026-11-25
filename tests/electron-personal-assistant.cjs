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
    const holdCatalog=()=>js(`(()=>{
      const fetchEntry=window.fetch.bind(window), pending=[];
      window.heldCatalog={pending,restore(){window.fetch=fetchEntry;for(const release of pending.splice(0))release();}};
      window.fetch=(input,init)=>{
        const request=fetchEntry(input,init);
        if(new URL(String(input),location.href).pathname!=='/api/plugin-conversations')return request;
        return new Promise((resolve,reject)=>pending.push(()=>request.then(resolve,reject)));
      };
    })()`);

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
    assert.equal(await js('!document.querySelector(".conversation-resource-dialog")'),true,'first use belongs in the chat canvas');
    const welcomeSubmit=()=>js('document.querySelector(".conversation-welcome .extension-resource-form").requestSubmit()');
    // Scope controls to the visible workspace, not the offscreen settings resource.
    const welcomeClick=label=>js('(()=>{const b=[...document.querySelectorAll(".conversation-welcome button")].find(b=>b.textContent==='+JSON.stringify(label)+');if(!b)throw Error("Missing welcome action");b.click()})()');
    await welcomeSubmit();await wait('!!document.querySelector(".conversation-welcome .extension-resource-review")');
    await welcomeClick('取消');await wait('!!document.querySelector(".conversation-welcome .extension-resource-form select")');
    assert.equal((await call('/sessions')).length,1,'cancel creates no chat');
    await welcomeSubmit();await wait('!!document.querySelector(".conversation-welcome .extension-resource-review")');
    const consent=await js('document.querySelector(".conversation-welcome .extension-resource-review").textContent');
    assert.match(consent,/当前选择的模型与 VPN.*今后切换的模型服务/);
    assert.match(consent,/不读取其他对话/);assert.match(consent,/每天最多 4 次后台处理/);
    const consentLimits=await js('document.querySelector(".conversation-welcome .extension-authorization-details").textContent');
    assert.match(consentLimits,/单次请求上限/);assert.match(consentLimits,/16000/);assert.match(consentLimits,/4096/);
    // Invalidations or a focus event can start a newer catalog read while the
    // confirmation already created the assistant and is waiting to navigate.
    await holdCatalog();
    await welcomeClick('确认');
    await wait('window.heldCatalog.pending.length>0 && !document.querySelector(".conversation-welcome .extension-resource-confirm")');
    await js('window.welcomeCatalogReads=window.heldCatalog.pending.length;window.dispatchEvent(new Event("focus"))');
    await wait('window.heldCatalog.pending.length>window.welcomeCatalogReads');
    await js('Promise.all(window.heldCatalog.pending.splice(0,window.welcomeCatalogReads).map(release=>release()))');
    await js('window.heldCatalog.restore()');
    await wait('!document.querySelector(".conversation-welcome")');
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
    const entrySettings = '.conversation-entry .resource-inline-setup';
    const menu = '.conversation-resource-dialog[open]';
    const confirmation = menu + ' .extension-resource-confirm';
    const openSettings = () => js(`(() => {const b=document.querySelector(${JSON.stringify(entrySettings)});b.focus();b.click()})()`);
    const dialogClick = label => js(`(() => {
      const button=[...document.querySelectorAll(${JSON.stringify(menu+' button')})].find(n=>n.textContent===${JSON.stringify(label)});
      if(!button)throw Error('Missing assistant action: '+${JSON.stringify(label)});
      button.click();
    })()`);
    const waitForAction = label => wait(`[...document.querySelectorAll(${JSON.stringify(menu+' .extension-resource-action')})].some(b=>b.textContent===${JSON.stringify(label)})`);
    const memoryEnabled = async () => (await call(resource)).view.actions.some(a=>a.id==='pause');

    win.setContentSize(1280,720);await wait('innerWidth===1280');
    await js('document.querySelector(".app").classList.remove("sidebar-collapsed")');
    await wait('document.querySelector(".conversation-entry")?.getBoundingClientRect().width>=200');
    await wait('!!document.querySelector('+JSON.stringify(entrySettings)+')');
    const entryLayout = await js(`(() => {
      const row=document.querySelector('.conversation-entry'),[title,settings]=row.querySelectorAll('button');
      const center=b=>{const r=b.getBoundingClientRect();return r.top+r.height/2};
      return {buttons:row.querySelectorAll('button').length,height:row.getBoundingClientRect().height,offset:Math.abs(center(title)-center(settings)),status:!!row.querySelector('.resource-inline-status')};
    })()`);
    assert(entryLayout.buttons===2&&entryLayout.height<=44&&entryLayout.offset<=1&&!entryLayout.status,JSON.stringify(entryLayout));
    if(shots)fs.writeFileSync(path.join(shots,'assistant-compact-entry.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await js('!!document.querySelector("dialog[open]")'),false);
    await openSettings();await waitForAction('关闭记忆');
    for(const theme of ['light','dark'])for(const width of [1280,390,320]){
      await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
      win.setContentSize(width,720);await wait('innerWidth==='+width);
      await js('document.fonts.ready');
      const layout=await js(`(() => {
        const d=document.querySelector(${JSON.stringify(menu)});
        const lineCount=element=>{const range=document.createRange();range.selectNodeContents(element);return new Set([...range.getClientRects()].map(r=>r.top)).size;};
        return {overflow:d.scrollWidth>d.clientWidth+1,buttons:[...d.querySelectorAll('.extension-resource-action')].map(lineCount),note:lineCount(d.querySelector('.extension-resource-note'))};
      })()`);
      assert(!layout.overflow&&layout.buttons.length>1&&layout.buttons.every(lines=>lines===1)&&layout.note===1,JSON.stringify({theme,width,...layout}));
      if(shots)fs.writeFileSync(path.join(shots,'assistant-settings-'+theme+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    await dialogClick('关闭记忆');await waitForAction('开启记忆');
    assert.equal(await memoryEnabled(),false,'pausing takes effect without a confirmation');
    await dialogClick('开启记忆');
    await wait('!!document.querySelector('+JSON.stringify(confirmation)+')');
    const readConsentLayout=()=>js(`(() => {
      const d=document.querySelector(${JSON.stringify(menu)}),r=d.getBoundingClientRect();
      const buttons=[...d.querySelectorAll('.extension-resource-confirm button')].map(button=>{
        button.focus();button.scrollIntoView({block:'nearest'});const b=button.getBoundingClientRect();
        return {label:button.textContent,visible:b.height>=36 && b.top>=r.top && b.bottom<=r.bottom+1 &&
          b.left>=r.left && b.right<=r.right && button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))};
      });
      return {buttons,scroll:d.scrollWidth,client:d.clientWidth,left:r.left,right:r.right,viewport:innerWidth};
    })()`);
    // At narrow widths the review can scroll, including when details are expanded.
    for(const theme of ['light','dark'])for(const width of [1280,390,320]){
      await js('document.documentElement.dataset.theme='+JSON.stringify(theme));
      win.setContentSize(width,720);await wait('innerWidth==='+width);
      await js('document.fonts.ready');
      const bounds=await readConsentLayout();
      assert(bounds.scroll<=bounds.client+1&&bounds.left>=-1&&bounds.right<=bounds.viewport+1,JSON.stringify({theme,width,...bounds}));
      assert.deepEqual(bounds.buttons,[{label:'取消',visible:true},{label:'确认',visible:true}],JSON.stringify({theme,width,...bounds}));
      await js('document.querySelector(".conversation-resource-dialog .extension-authorization-details summary").focus()');
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
      await wait('document.querySelector(".conversation-resource-dialog .extension-authorization-details")?.open');
      assert.deepEqual((await readConsentLayout()).buttons,bounds.buttons,'expanded details keep both buttons reachable');
      await js('document.querySelector(".conversation-resource-dialog .extension-authorization-details").open=false');
    }
    // Escape in the permission review must never cancel the running chat.
    await js(`(async()=>{
      const {state}=await import('/js/state.js');state.isProcessing=true;
      const original=window.fetch;window.memoryCancelRequests=0;
      window.fetch=(...args)=>{if(String(args[0]).endsWith('/cancel')){window.memoryCancelRequests++;return Promise.resolve(new Response('{}',{status:200}));}return original(...args);};
      window.restoreMemoryFetch=()=>{window.fetch=original;state.isProcessing=false;};
    })()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await wait('!document.querySelector('+JSON.stringify(menu)+')');
    assert.equal(await js('window.memoryCancelRequests'),0);
    await js('window.restoreMemoryFetch()');
    assert.equal(await memoryEnabled(),false);
    win.setContentSize(1280,720);await wait('innerWidth===1280');
    await js('document.querySelector(".app").classList.remove("sidebar-collapsed")');
    await openSettings();await waitForAction('开启记忆');await dialogClick('开启记忆');
    await wait('!!document.querySelector('+JSON.stringify(confirmation)+')');
    const beforeShortcut=await js('(async()=> (await import("/js/session-manager.js")).activeSessionId.value)()');
    await js(`document.querySelector(${JSON.stringify(confirmation+' button')}).dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',ctrlKey:true,bubbles:true,cancelable:true}))`);
    assert.equal(await js('(async()=> (await import("/js/session-manager.js")).activeSessionId.value)()'),beforeShortcut);
    await dialogClick('取消');await waitForAction('开启记忆');assert.equal(await memoryEnabled(),false);
    await dialogClick('开启记忆');
    await wait('!!document.querySelector('+JSON.stringify(confirmation)+')');
    await dialogClick('确认');await waitForAction('关闭记忆');
    assert(await memoryEnabled());
    const themeOn='enable-theme-overviews',themeOff='disable-theme-overviews';
    assert((await call(resource)).view.actions.some(row=>row.id===themeOn),'pilot is off after granting ordinary memory');
    await dialogClick('开启概览');
    await wait('!!document.querySelector('+JSON.stringify(confirmation)+')');
    const details=await js('document.querySelector(".conversation-resource-dialog .extension-resource-review").textContent');
    assert.match(details,/项目决策.*协作偏好/);
    assert.match(details,/最多 4 次.*最多占 1 次/);
    await dialogClick('取消');await waitForAction('开启概览');
    assert((await call(resource)).view.actions.some(row=>row.id===themeOn),'cancel leaves pilot off');
    await dialogClick('开启概览');
    await wait('!!document.querySelector('+JSON.stringify(confirmation)+')');
    await dialogClick('确认');await waitForAction('关闭概览');
    const remoteRoute=resource+'?remoteSession='+encodeURIComponent(assistantId);
    assert.deepEqual((await call(remoteRoute)).view.actions.map(row=>row.id),['pause']);
    const denied=await fetch(base+remoteRoute,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},
      body:JSON.stringify({action:themeOff,values:{}})});
    assert.equal(denied.status,409,'remote client cannot change desktop pilot');
    await dialogClick('关闭概览');await waitForAction('开启概览');
    assert(await memoryEnabled(),'turning off the pilot preserves ordinary memory');

    // A remote pause is visible in a desktop settings dialog that's already open.
    const pause=(await call(remoteRoute)).view.actions.find(a=>a.id==='pause');
    await call(remoteRoute,{action:pause.id,values:pause.values});
    for(let i=0;i<320&&!await js(`document.querySelector(${JSON.stringify(menu)})?.textContent.includes("开启记忆")`);i++)
      await new Promise(r=>setTimeout(r,25));
    await waitForAction('开启记忆');
    await js('document.querySelector('+JSON.stringify(menu)+').close()');
    await wait('!document.querySelector(".conversation-resource-dialog")');
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
    await js(`(async()=>{
      const {mountResource}=await import('/js/extensions/resource-view.js');
      const host=document.createElement('div'),other=document.createElement('button');document.body.append(host,other);
      let release;const view=checked=>({actions:[{id:'toggle',label:'Toggle',values:{}}],rows:[],toggle:{label:'Memory',checked,action:'toggle'}});
      const dispose=mountResource(host,{pluginId:'test'},'start',{inlineToggle:true,request:async body=>body?new Promise(r=>release=()=>r({view:view(false)})):{view:view(true)}});
      await new Promise(r=>setTimeout(r,20));const b=host.querySelector('button');b.focus();b.click();other.focus();release();
      await new Promise(r=>setTimeout(r,20));if(document.activeElement!==other)throw Error('Late toggle response stole focus');
      if(host.querySelector('[role=switch]').getAttribute('aria-checked')!=='false')throw Error('Toggle response did not update');
      dispose();host.remove();other.remove();
    })()`);
    await js('('+require('./assistant-health-scenario.cjs').toString()+')({moduleUrl:"/js/extensions/resource-view.js"})');
    // Replace the named conversation before this window receives the catalog
    // changes. Even a stale click that reaches the host must leave the new grant active.
    await openSettings();await waitForAction('开启记忆');await dialogClick('开启记忆');
    await wait('!!document.querySelector('+JSON.stringify(confirmation)+')');
    await dialogClick('确认');await waitForAction('关闭记忆');
    await holdCatalog();
    const removed=await fetch(base+'/'+assistantId+'/',{method:'DELETE'});
    assert.equal(removed.status,200);
    const setup=resource.replace(/assistant$/,'welcome');
    const replacement=await call(setup,{action:'create-assistant',values:{model:JSON.stringify({provider:'mock',model:'tiny'}),memory:true}});
    await call(setup,{confirm:replacement.confirmation.id});
    const replacementId=(await call('/api/plugin-conversations'))[0].sessionId;
    assert(replacementId&&replacementId!==assistantId);
    await dialogClick('关闭记忆');
    await wait('document.querySelector(".conversation-resource-dialog[open] .plugins-message")?.textContent.includes("设置已变化")');
    assert(await memoryEnabled(),'a stale click cannot pause the replacement grant');
    await js('window.heldCatalog.restore();window.dispatchEvent(new Event("focus"))');
    await wait('!document.querySelector(".conversation-resource-dialog[open]")');
    const replacementRoute=resource+'?remoteSession='+encodeURIComponent(replacementId);
    const currentPause=(await call(replacementRoute)).view.actions.find(a=>a.id==='pause');
    const paused=await call(replacementRoute,{action:currentPause.id,values:currentPause.values});
    assert.match(paused.view.note,/长期记忆已关闭/,'the currently bound remote settings can still pause memory');
    console.log('PASS dedicated assistant UI: ZIP install, explicit creation/grant, concurrent directory refresh, stale dialog rejection, desktop theme pilot, pause, themes, disable/re-enable and 1280/390/320 layouts');
    win.destroy();await hub.shutdown();clearTimeout(timeout);app.exit(0);
  }catch(error){console.error(error);win?.destroy();try{await hub?.shutdown();}catch{}clearTimeout(timeout);app.exit(1);}
});
