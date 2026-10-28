const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict'),{once}=require('node:events');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'plugin-install-ui-'));app.setPath('userData',profile);const root=path.resolve(__dirname,'../web');
const watchdog=setTimeout(()=>app.exit(1),30000);
app.whenReady().then(async()=>{
 let win,server,confirms=0,lists=0,previews=0,polls=0,blocked=false,done=false,rejectConfirmation=false,previewData=null,holdDelete=false,rejectDelete=false,releaseDelete,deletes=0;
 try{
  server=http.createServer(async(req,res)=>{
   const u=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json');
   if(u.pathname==='/api/plugins'){lists++;res.end(JSON.stringify({plugins:[]}));return;}
   if(u.pathname==='/api/plugins/install'){
    if(req.method==='DELETE'){deletes++;if(rejectDelete){res.writeHead(500);res.end('Cancellation failed');return;}if(holdDelete)await new Promise(resolve=>{releaseDelete=resolve;});res.end('{}');return;}
    if(u.searchParams.get('action')==='preview'){
     if(req.method==='GET'){if(!previewData){res.writeHead(404);res.end('Preview expired');}else res.end(JSON.stringify(previewData));return;}
     previews++;
     for await(const _ of req){};
     previewData={token:'fixture',name:'桌面控制 <img src=x onerror=alert(1)>',version:'0.3.3',previousVersion:'0.3.2',target:'/Users/me/.agent-sh/extensions/ashub-desktop-control',checks:[{label:'platform',ok:!blocked,detail:'macOS'},{label:'node',ok:true,detail:'Node 22.23.3'}],canInstall:!blocked,npm:false,setup:{script:'scripts/ashub-setup.mjs',description:'准备独立的 Python 环境与桌面控制组件'},defaults:{'desktop-control':{enabled:false,allowedApps:[]}},permissions:['系统权限由你手动授予'],legacy:false};
     res.end(JSON.stringify(previewData));return;
    }
    if(req.method==='POST'){confirms++;if(rejectConfirmation){res.writeHead(400);res.end('Prerequisites changed');return;}res.end(JSON.stringify({id:'fixture',state:'running',step:'setup'}));return;}
    polls++;res.end(JSON.stringify({id:'fixture',name:'桌面控制',version:'0.3.3',state:done?'succeeded':'running',step:'setup',restartRequired:true}));return;
   }
   const file=path.join(root,u.pathname==='/'?'index.html':u.pathname);
   if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
   let data=fs.readFileSync(file);if(file.endsWith('.html'))data=data.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(data);
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  win=new BrowserWindow({show:false,width:1180,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  const js=c=>win.webContents.executeJavaScript(c);
  const wait=async c=>{for(let n=0;n<150;n++){if(await js(c))return;await new Promise(r=>setTimeout(r,30));}throw Error(c);};
  await js(`document.getElementById('page-loader').remove();document.querySelector('.app').classList.add('sidebar-collapsed');localStorage.setItem('ash.lang','zh');import('/js/plugins-panel.js').then(()=>document.getElementById('plugins-toggle').click())`);
  await wait(`!document.getElementById('plugins-overlay').hidden`);
  const upload=()=>js(`(()=>{const d=new DataTransfer();d.items.add(new File(['fixture'],'plugin.zip',{type:'application/zip'}));const i=document.getElementById('plugin-archive');i.files=d.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await upload();await wait(`!!document.querySelector('#plugin-install-preview .p-btn-primary')`);assert.equal(confirms,0);
  assert.equal(await js(`document.querySelectorAll('#plugin-install-preview img').length`),0);
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
  for(const width of [1180,390,320]){
   win.setContentSize(width,900);await new Promise(r=>setTimeout(r,80));
   assert.equal(await js(`(()=>{const p=document.getElementById('plugins-overlay');return p.scrollWidth>p.clientWidth+1;})()`),false);
   assert(await js(`(()=>{const p=document.getElementById('plugins-overlay'),r=p.getBoundingClientRect();return p.contains(document.elementFromPoint(r.left+30,r.top+30));})()`),'panel must be unobstructed');
   await fs.promises.writeFile(`/tmp/ashub-install-${width}.png`,(await win.webContents.capturePage()).toPNG());
  }
  await js(`document.querySelector('#plugin-install-preview .p-btn-primary').click()`);await wait(`document.querySelector('.plugin-install-status.is-working')`);assert.equal(confirms,1);
  await js(`document.getElementById('plugins-close').click();document.getElementById('plugins-toggle').click()`);assert.equal(confirms,1);
  await win.reload();await new Promise(r=>win.webContents.once('did-finish-load',r));
  await js(`document.getElementById('page-loader').remove();document.querySelector('.app').classList.add('sidebar-collapsed');import('/js/plugins-panel.js').then(()=>document.getElementById('plugins-toggle').click())`);
  await wait(`document.querySelector('.plugin-install-status.is-working')`);assert.equal(confirms,1,'reload must resume status without confirming again');
  const before=lists;done=true;await wait(`document.querySelector('.plugin-install-status')?.textContent==='安装完成'`);await wait(`!document.getElementById('plugins-message').textContent`);assert(lists>before,'refresh plugin list after success');
  const previousPreviews=previews;
  await js(`(()=>{const d=new DataTransfer();d.items.add(new File(['fixture'],'next.zip',{type:'application/zip'}));document.getElementById('plugins-overlay').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:d}));})()`);
  await new Promise(r=>setTimeout(r,100));assert.equal(previews,previousPreviews,'close a completed job before accepting another ZIP');
  await js(`document.querySelector('#plugin-install-preview .p-btn').click()`);await wait(`document.getElementById('plugin-install-preview').hidden`);
  blocked=true;await upload();await wait(`document.querySelector('#plugin-install-preview .p-btn-primary')?.disabled`);assert.equal(confirms,1);
  await js(`document.querySelector('#plugin-install-preview .p-btn').click()`);await wait(`document.getElementById('plugin-install-preview').hidden`);
  blocked=false;done=false;await upload();await wait(`!!document.querySelector('#plugin-install-preview .p-btn-primary')`);
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
  previewData=null;const expiredLoad=once(win.webContents,'did-finish-load');win.reload();await expiredLoad;
  await js(`document.getElementById('page-loader').remove();document.querySelector('.app').classList.add('sidebar-collapsed');import('/js/plugins-panel.js').then(()=>document.getElementById('plugins-toggle').click())`);
  await wait(`document.querySelector('.plugin-install-error')?.textContent==='Preview expired'`);
  assert.equal(await js(`sessionStorage.getItem('ashub.pluginInstallPreview')`),null);
  assert.equal(await js(`document.getElementById('plugins-install').disabled`),false,'expired previews must not lock the installer');
  console.log('PASS installer UI: preview reload/expiry, cancellation race/retry, confirmation, prerequisites, escaping, job recovery, completed-job drop guard, lost-response recovery, rejection cleanup and 320/390/1180px layouts');
 }catch(e){console.error(e);process.exitCode=1;}finally{releaseDelete?.();win?.destroy();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}clearTimeout(watchdog);fs.rmSync(profile,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
