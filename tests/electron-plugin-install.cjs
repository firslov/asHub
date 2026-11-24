const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict'),{once}=require('node:events');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'plugin-install-ui-'));app.setPath('userData',profile);const root=path.resolve(__dirname,'../web');
const watchdog=setTimeout(()=>app.exit(1),30000);
app.whenReady().then(async()=>{
 let win,otherWin,server,confirms=0,lists=0,previews=0,polls=0,blocked=false,done=false,rejectConfirmation=false,previewData=null,previewListEmpty=0,holdDelete=false,rejectDelete=false,releaseDelete,deletes=0;
 try{
  server=http.createServer(async(req,res)=>{
   const u=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json');
   if(u.pathname==='/api/plugins'){lists++;res.end(JSON.stringify({plugins:[]}));return;}
   if(u.pathname==='/api/plugins/install'){
    if(req.method==='DELETE'){deletes++;if(rejectDelete){res.writeHead(500);res.end('Cancellation failed');return;}if(holdDelete)await new Promise(resolve=>{releaseDelete=resolve;});res.end('{}');return;}
    if(u.searchParams.get('action')==='previews'){if(previewListEmpty>0){previewListEmpty--;res.end('[]');}else res.end(JSON.stringify(previewData&&previewData.requestId===u.searchParams.get('requestId')?[{token:previewData.token,requestId:previewData.requestId,name:previewData.name,version:previewData.version}]:[]));return;}
    if(u.searchParams.get('action')==='preview'){
     if(req.method==='GET'){if(!previewData){res.writeHead(404);res.end('Preview expired');}else{previewData.canInstall=!blocked;previewData.checks[0].ok=!blocked;res.end(JSON.stringify(previewData));}return;}
     previews++;
     for await(const _ of req){};
     previewData={token:'fixture',requestId:req.headers['x-ashub-preview-request'],environmentRevision:`revision-${previews}`,name:previews===1?'桌面控制 <img src=x onerror=alert(1)>':'桌面控制',version:'0.3.3',previousVersion:'0.3.2',target:'/Users/me/.agent-sh/extensions/ashub-desktop-control',checks:[{label:'platform',ok:!blocked,detail:'macOS'},{label:'node',ok:true,detail:'Node 22.23.3'}],canInstall:!blocked,npm:false,setup:{script:'scripts/ashub-setup.mjs',description:'准备独立的 Python 环境与桌面控制组件'},defaults:{'desktop-control':{enabled:false,allowedApps:[]}},permissions:['系统权限由你手动授予'],legacy:false};
     res.end(JSON.stringify(previewData));return;
    }
    if(req.method==='POST'){
     let body='';for await(const chunk of req)body+=chunk;
     if(JSON.parse(body).environmentRevision!==previewData?.environmentRevision){res.writeHead(409);res.end('Installation preview changed');return;}
     confirms++;if(rejectConfirmation){res.writeHead(400);res.end('Prerequisites changed');return;}res.end(JSON.stringify({id:'fixture',state:'running',step:'setup'}));return;
    }
    polls++;res.end(JSON.stringify({id:'fixture',name:'桌面控制',version:'0.3.3',state:done?'succeeded':'running',step:'setup',restartRequired:true}));return;
   }
   const file=path.join(root,u.pathname==='/'?'index.html':u.pathname);
   if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
   let data=fs.readFileSync(file);if(file.endsWith('.html'))data=data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(data);
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  win=new BrowserWindow({show:false,width:1180,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  const js=async c=>{try{return await win.webContents.executeJavaScript(c);}catch(error){console.error('Renderer script failed:',c);throw error;}};
  const wait=async c=>{for(let n=0;n<150;n++){if(await js(c))return;await new Promise(r=>setTimeout(r,30));}throw Error(c);};
  await js(`document.getElementById('page-loader').remove();document.querySelector('.app').classList.add('sidebar-collapsed');localStorage.setItem('ash.lang','zh');import('/js/plugins-panel.js').then(()=>document.getElementById('plugins-toggle').click())`);
  await wait(`!document.getElementById('plugins-overlay').hidden`);await wait(`!document.getElementById('plugins-install').disabled`);
  const upload=()=>js(`(()=>{const d=new DataTransfer();d.items.add(new File(['fixture'],'plugin.zip',{type:'application/zip'}));const i=document.getElementById('plugin-archive');i.files=d.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  // In insecure HTTP contexts randomUUID can be unavailable while secure random bytes remain available.
  await js(`Object.defineProperty(window.crypto,'randomUUID',{value:undefined,configurable:true})`);
  await upload();await wait(`!!document.querySelector('#plugin-install-preview .p-btn-primary')`);assert.equal(confirms,0);
  assert.match(previewData.requestId,/^[a-f0-9]{32}$/,'preview ID uses cryptographic random bytes');
  assert.equal(await js(`document.querySelectorAll('#plugin-install-preview img').length`),0);
  otherWin=new BrowserWindow({show:false,width:900,height:700,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await otherWin.loadURL(`http://127.0.0.1:${server.address().port}`);
  await otherWin.webContents.executeJavaScript(`document.getElementById('page-loader').remove();document.querySelector('.app').classList.add('sidebar-collapsed');import('/js/plugins-panel.js').then(()=>document.getElementById('plugins-toggle').click())`);
  for(let n=0;n<150;n++){if(await otherWin.webContents.executeJavaScript(`!document.getElementById('plugins-overlay').hidden&&!document.getElementById('plugins-install').disabled`))break;await new Promise(r=>setTimeout(r,30));}
  assert.equal(await otherWin.webContents.executeJavaScript(`document.getElementById('plugin-install-preview').hidden`),true,'a new window must not claim another window preview');
  await otherWin.webContents.executeJavaScript(`window.fetch=async()=>{throw new TypeError('Failed to fetch')};(()=>{const d=new DataTransfer();d.items.add(new File(['other'],'other.zip',{type:'application/zip'}));const i=document.getElementById('plugin-archive');i.files=d.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  for(let n=0;n<150;n++){const text=await otherWin.webContents.executeJavaScript(`document.querySelector('.plugin-install-error')?.textContent||''`);if(text.includes('Failed to fetch'))break;await new Promise(r=>setTimeout(r,30));}
  assert.match(await otherWin.webContents.executeJavaScript(`document.querySelector('.plugin-install-error')?.textContent||''`),/Failed to fetch/);
  assert.equal(await otherWin.webContents.executeJavaScript(`!!document.querySelector('#plugin-install-preview .p-btn-primary')`),false,'failed upload must not recover an older ZIP');
  otherWin.destroy();otherWin=undefined;assert.equal(confirms,0);
  for(let n=0;n<3;n++){
   const loaded=once(win.webContents,'did-finish-load');win.reload();await loaded;
   await js(`document.getElementById('page-loader').remove();document.querySelector('.app').classList.add('sidebar-collapsed');import('/js/plugins-panel.js').then(()=>document.getElementById('plugins-toggle').click())`);
   await wait(`!!document.querySelector('#plugin-install-preview .p-btn-primary')`);
   assert.equal(previews,1,'reload must reuse the preview without consuming another slot');assert.equal(confirms,0,'restoring a preview never authorizes installation');
  }
  rejectDelete=true;
  await js(`document.querySelector('#plugin-install-preview .p-btn').click()`);
  await wait(`document.querySelector('.plugin-install-error')?.textContent==='Cancellation failed'`);
  assert.equal(await js(`document.querySelector('#plugin-install-preview .p-btn-primary').disabled`),false,'failed cancellation must restore usable controls');
  assert.equal(await js(`sessionStorage.getItem('ashub.pluginInstallPreview')`),'fixture','failed cancellation must retain the preview');
  rejectDelete=false;holdDelete=true;const previousDeletes=deletes;
  await js(`(()=>{const cancel=document.querySelector('#plugin-install-preview .p-btn'),confirm=document.querySelector('#plugin-install-preview .p-btn-primary');cancel.click();cancel.click();confirm.click();})()`);
  for(let n=0;n<100&&!releaseDelete;n++)await new Promise(r=>setTimeout(r,20));
  assert(releaseDelete,'cancellation must reach the server');await new Promise(r=>setTimeout(r,80));
  assert.equal(deletes,previousDeletes+1,'rapid cancellation must submit only one DELETE');
  assert.equal(confirms,0,'confirmation must not run while cancellation is pending');
  releaseDelete();releaseDelete=undefined;holdDelete=false;
  await wait(`document.getElementById('plugin-install-preview').hidden`);
  await upload();await wait(`!!document.querySelector('#plugin-install-preview .p-btn-primary')`);
  const screenshotDir=process.env.ASHUB_INSTALL_VISUAL_DIR || path.join(os.tmpdir(),'ashub-install-ui');
  await fs.promises.mkdir(screenshotDir,{recursive:true});
  const debug=win.webContents.debugger;
  debug.attach('1.3');
  const pressKey=async (key,windowsVirtualKeyCode)=>{
   const input={key,code:key,windowsVirtualKeyCode};
   await debug.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',...input,text:key==='Enter'?'\r':''});
   await debug.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...input});
  };
  const labels={
   en:['Cancel','Recheck','Confirm upgrade'],
   zh:['取消安装','重新检查环境','确认升级'],
  };
  for(const language of ['en','zh']){
   await js(`import('/js/i18n.js').then(m=>m.setLang(${JSON.stringify(language)}))`);
   for(const width of [1180,390,320]){
    win.setContentSize(width,844);await wait(`innerWidth===${width} && innerHeight===844`);
    for(const theme of width===1180?['light']:['dark','light']){
     const viewport=`${width}px ${language} ${theme}`;
     await js(`document.documentElement.dataset.theme='${theme}';
      document.querySelector('.plugin-install-actions').scrollIntoView({block:'nearest'});`);
     await js(`Promise.all(document.querySelector('#plugins-overlay').getAnimations({subtree:true})
      .filter(animation=>animation.effect.getTiming().iterations===1).map(animation=>animation.finished.catch(()=>{})))`);
     const layout=await js(`(()=>{
      const panel=document.getElementById('plugins-overlay'),body=panel.querySelector('.p-body');
      const actions=panel.querySelector('.plugin-install-actions'),row=actions.getBoundingClientRect();
      const buttons=[...actions.querySelectorAll('button')].map(button=>{
        const rect=button.getBoundingClientRect(),text=document.createRange();
        text.selectNodeContents(button.firstChild);
        const hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
        const lines=new Set([...text.getClientRects()].map(fragment=>Math.round(fragment.top))).size;
        return {text:button.textContent,lines,top:rect.top,x:rect.x,
          fits:rect.left>=row.left-1 && rect.right<=row.right+1 && button.scrollWidth<=button.clientWidth+1,
          clickable:button.contains(hit) && !button.disabled, primary:button.classList.contains('p-btn-primary')};
      });
      const rect=panel.getBoundingClientRect();
      return {buttons,headerReachable:panel.contains(document.elementFromPoint(rect.left+30,rect.top+30)),
        overflow:panel.scrollWidth>panel.clientWidth+1 || body.scrollWidth>body.clientWidth+1};
     })()`);
     assert.deepEqual(layout.buttons.map(button=>button.text),labels[language],viewport);
     assert.deepEqual(layout.buttons.map(button=>button.primary),[false,false,true],viewport);
     await fs.promises.writeFile(path.join(screenshotDir,`installer-${width}-${language}-${theme}.png`),(await win.webContents.capturePage()).toPNG());
     assert(layout.headerReachable && !layout.overflow && layout.buttons.every(button=>button.fits && button.clickable && button.lines===1),
      viewport+' shows three complete, unobstructed action labels '+JSON.stringify(layout));
     const rows=new Set(layout.buttons.map(button=>button.top));
     if(width===1180) assert.equal(rows.size,1,viewport+' keeps one row');
     if(width===320) assert(rows.size>1,viewport+' wraps full buttons onto another row');
     for(let i=1;i<layout.buttons.length;i++){
      const previous=layout.buttons[i-1],current=layout.buttons[i];
      assert(current.top>previous.top || (current.top===previous.top && current.x>previous.x),viewport+' preserves reading order');
     }
     await js("document.querySelector('#plugin-install-preview summary').focus()");
     for(const label of labels[language]){
      await pressKey('Tab',9);
      assert.equal(await js("document.activeElement.closest('.plugin-install-actions') && document.activeElement.textContent"),label,viewport+' Tab reaches '+label);
     }
     await js('document.activeElement.blur()');
    }
   }
  }
  console.log('PASS upgrade layout: full labels, hit targets, primary action and Tab order at 320/390/1180px (Chinese and English)');
  console.log('Upgrade screenshots:',screenshotDir);
  await js("document.querySelector('#plugin-install-preview .p-btn-primary').focus()");
  await pressKey('Enter',13);debug.detach();
  await wait(`document.querySelector('.plugin-install-status.is-working')`);
  for(let n=0;n<100&&confirms===0;n++)await new Promise(r=>setTimeout(r,20));assert.equal(confirms,1);
  await js(`document.getElementById('plugins-close').click();document.getElementById('plugins-toggle').click()`);assert.equal(confirms,1);
  await win.reload();await new Promise(r=>win.webContents.once('did-finish-load',r));
  await js(`document.getElementById('page-loader').remove();document.querySelector('.app').classList.add('sidebar-collapsed');import('/js/plugins-panel.js').then(()=>document.getElementById('plugins-toggle').click())`);
  await wait(`document.querySelector('.plugin-install-status.is-working')`);assert.equal(confirms,1,'reload must resume status without confirming again');
  const before=lists;done=true;await wait(`document.querySelector('.plugin-install-status')?.textContent==='安装完成'`);await wait(`!document.getElementById('plugins-message').textContent`);assert(lists>before,'refresh plugin list after success');
  assert.equal(await js(`sessionStorage.getItem('ashub.pluginInstallJob')`),null,'successful installation must not leave an expiring job ID');assert.equal(await js(`sessionStorage.getItem('ashub.pluginInstallPreview')`),null);
  const previousPreviews=previews;
  await js(`(()=>{const d=new DataTransfer();d.items.add(new File(['fixture'],'next.zip',{type:'application/zip'}));document.getElementById('plugins-overlay').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:d}));})()`);
  await new Promise(r=>setTimeout(r,100));assert.equal(previews,previousPreviews,'close a completed job before accepting another ZIP');
  await js(`document.querySelector('#plugin-install-preview .p-btn').click()`);await wait(`document.getElementById('plugin-install-preview').hidden`);
  blocked=true;await upload();await wait(`document.querySelector('#plugin-install-preview .p-btn-primary')?.disabled`);assert.equal(confirms,1);
  blocked=false;await js(`document.querySelectorAll('#plugin-install-preview .p-btn')[1].click()`);await wait(`!!document.querySelector('#plugin-install-preview .p-btn-primary') && !document.querySelector('#plugin-install-preview .p-btn-primary').disabled`);assert.equal(confirms,1,'environment recheck must not confirm installation');
  await js(`document.querySelector('#plugin-install-preview .p-btn').click()`);await wait(`document.getElementById('plugin-install-preview').hidden`);
  done=false;await upload();await wait(`!!document.querySelector('#plugin-install-preview .p-btn-primary')`);
  // Deliver the request but drop the response at the fetch boundary. Destroying
  // the socket instead makes Chromium itself replay POSTs before fetch rejects.
  await js(`(()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(String(args[0]).includes('action=confirm')){window.fetch=original;throw new TypeError('Failed to fetch');}return response;};})()`);
  const previousPolls=polls;await js(`document.querySelector('#plugin-install-preview .p-btn-primary').click()`);
  for(let n=0;n<150&&polls===previousPolls;n++)await new Promise(r=>setTimeout(r,30));
  assert(polls>previousPolls,'a lost confirmation must query the original job');
  await wait(`sessionStorage.getItem('ashub.pluginInstallJob')==='fixture' && !!document.querySelector('.plugin-install-status.is-working')`);
  assert.equal(confirms,2,'lost confirmation response must recover by status without resubmission');
  done=true;await wait(`document.querySelector('.plugin-install-status')?.textContent==='安装完成'`);assert.equal(confirms,2);
  await js(`document.querySelector('#plugin-install-preview .p-btn').click()`);await wait(`document.getElementById('plugin-install-preview').hidden`);
  rejectConfirmation=true;await upload();await wait(`!!document.querySelector('#plugin-install-preview .p-btn-primary')`);
  await js(`document.querySelector('#plugin-install-preview .p-btn-primary').click()`);
  await wait(`document.querySelector('.plugin-install-error')?.textContent==='Prerequisites changed'`);
  assert.equal(await js(`sessionStorage.getItem('ashub.pluginInstallJob')`),null,'rejected confirmation must not persist a nonexistent job');
  assert(await js(`!!document.querySelector('#plugin-install-preview .p-btn-primary')`));
  await js(`document.querySelector('#plugin-install-preview .p-btn').click()`);await wait(`document.getElementById('plugin-install-preview').hidden`);rejectConfirmation=false;
  await js(`(()=>{const original=window.fetch;window.fetch=async(...args)=>{const response=await original(...args);if(args[1]?.method==='POST'&&String(args[0]).includes('action=preview')){window.fetch=original;throw new TypeError('Failed to fetch');}return response;};})()`);
  previewListEmpty=2;await upload();await wait(`!!document.querySelector('#plugin-install-preview .p-btn-primary')`);
  assert.equal(await js(`sessionStorage.getItem('ashub.pluginInstallPreview')`),'fixture','lost preview response must recover the server token after a delayed plan listing');assert.equal(await js(`document.querySelector('.plugin-install-error')?.textContent||''`),'');
  previewData=null;const expiredLoad=once(win.webContents,'did-finish-load');win.reload();await expiredLoad;
  await js(`document.getElementById('page-loader').remove();document.querySelector('.app').classList.add('sidebar-collapsed');import('/js/plugins-panel.js').then(()=>document.getElementById('plugins-toggle').click())`);
  await wait(`document.querySelector('.plugin-install-error')?.textContent==='Preview expired'`);
  assert.equal(await js(`sessionStorage.getItem('ashub.pluginInstallPreview')`),null);
  assert.equal(await js(`document.getElementById('plugins-install').disabled`),false,'expired previews must not lock the installer');
  console.log('PASS installer UI: preview reload/expiry, cancellation race/retry, confirmation, prerequisites, escaping, job recovery, completed-job drop guard, lost-response recovery, rejection cleanup and 320/390/1180px layouts');
 }catch(e){console.error(e);process.exitCode=1;}finally{releaseDelete?.();otherWin?.destroy();win?.destroy();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}clearTimeout(watchdog);fs.rmSync(profile,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
