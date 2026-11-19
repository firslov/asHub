const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-backend-sync-'));
app.setPath('userData',profile);app.on('window-all-closed',()=>{});
const deadline=setTimeout(()=>{console.error('Sync acceptance timeout');app.exit(1);},95000);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
app.whenReady().then(async()=>{
 let server,win;const controller=new AbortController(),streams=[];let deviceState='online',submits=0,receiptCalls=0,failList=false,holdList,releaseList,holdInfo=false,infoWaits=[],releaseSubmit;
 const returns=[],errors=[];
 try{
  const {BackendConnections}=await import('../dist/extensions/backends.js');
  const registry=new BackendConnections({signal:controller.signal,reveal:(...args)=>returns.push(args)});
  const entry=registry.bind('device-plugin',controller.signal).register('office',{
   label:'办公室 Mac · A',managementResource:'connections',status:()=>deviceState,online:()=>deviceState==='online',
   request:async(op)=>{
    if(op==='sessions'){if(failList)throw Object.assign(Error('设备查询暂时失败'),{status:503});if(holdList){holdList=false;return new Promise(r=>releaseList=r);}return [{instanceId:'same',title:'同名对话'},{instanceId:'other',title:'另一个对话'}];}
    if(op==='capabilities')return {};
    if(op==='submit'){submits++;return new Promise(r=>releaseSubmit=()=>r({state:'pending'}));}
    if(op==='request-status'){receiptCalls++;return {state:'pending'};}
    throw Error('Unexpected '+op);
   },subscribe:async(sid,emit,signal)=>{let stop;const end=new Promise(r=>stop=r);streams.push({sid,emit,stop,signal});signal.addEventListener('abort',stop,{once:true});await end;signal.removeEventListener('abort',stop);},
  });
  server=http.createServer(async(req,res)=>{
   if(holdInfo && req.url.endsWith('/info')) await new Promise(r=>infoWaits.push(r));
   if(await registry.handle(req,res,async r=>{let text='';for await(const c of r)text+=c;return text;}))return;
   const file=path.join(root,'web',new URL(req.url,'http://localhost').pathname);
   if(!file.startsWith(path.join(root,'web')+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream');res.end(file.endsWith('.html')?fs.readFileSync(file,'utf8').replace('<script type="module"', '<script>window.testStreams=[];window.EventSource=class extends EventSource{constructor(url){super(url);testStreams.push(this);}}</script><script type="module"'):fs.readFileSync(file));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  win=new BrowserWindow({show:true,useContentSize:true,width:1180,height:820,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.on('console-message',(_e,level,msg)=>{if(level>=3)errors.push(msg);});
  await win.loadURL('http://127.0.0.1:'+server.address().port+'/backend.html?connection='+entry.id);
  const js=c=>win.webContents.executeJavaScript(c),wait=async c=>{for(let i=0;i<240;i++){if(await js(c))return;await pause(25);}throw Error('Timed out '+c);};
  const latest=()=>streams.at(-1),emit=(name,payload={})=>latest().emit({meta:{name},payload});
  await wait("document.querySelectorAll('#sessions button').length===2 && document.querySelector('.bw-brand img').naturalWidth>0");
  assert.equal(await js("document.querySelector('#execution-device').textContent"),'执行设备：办公室 Mac · A');
  await js("document.querySelector('#sessions button').click()");await wait("document.querySelector('#connection').textContent.includes('正在同步')");
  await pause(400);assert.equal(await js("document.querySelector('#sync-retry').hidden"),true);
  // Actual 12-second deadline, not an accelerated production timer.
  await pause(12100);await wait("!document.querySelector('#sync-retry').hidden");
  for(const width of [1180,760])for(const theme of ['light','dark']) {
   win.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width,height:820},viewPosition:{x:0,y:0},viewSize:{width,height:820},deviceScaleFactor:1,scale:1});
   await js(`document.documentElement.dataset.theme='${theme}'`);await pause(180);
   assert(await js("document.body.scrollWidth<=innerWidth && document.querySelector('#sync-retry').getBoundingClientRect().right<=innerWidth && document.querySelector('#execution-device').clientWidth>0"));
   if(width===1180)fs.writeFileSync(path.join(os.tmpdir(),'ashub-desktop-sync-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
  }
  const first=latest();await js("document.querySelector('#sync-retry').click()");await pause(150);
  await js(`testStreams[0].onmessage({data:JSON.stringify({meta:{name:'hub:replay-done'},payload:{}})})`);
  first.emit({meta:{name:'hub:replay-done'},payload:{}});await pause(80);assert.equal(await js("document.querySelector('#send').disabled"),true);
  emit('hub:replay-done');await wait("!document.querySelector('#send').disabled");
  await js(`(()=>{document.querySelector('#query').value='保留的草稿';document.querySelector('#query').dispatchEvent(new Event('input'));const d=new DataTransfer();d.items.add(new File(['png'],'draft.png',{type:'image/png'}));document.querySelector('#upload').files=d.files;document.querySelector('#upload').dispatchEvent(new Event('change'));})()`);
  await wait("document.querySelector('#attachments').textContent.includes('draft.png')");
  await js("document.querySelector('#composer').requestSubmit()");await wait("!document.querySelector('#receipt').hidden");await pause(100);assert.equal(submits,1);
  const record=await js(`localStorage.getItem('ash.backend.${entry.id}.same.pending')`);assert(record);
  emit('backend:reset');await wait("document.querySelector('#connection').textContent.includes('正在同步')");
  assert.equal(await js("document.querySelector('#send').disabled"),true);await pause(12100);await wait("!document.querySelector('#sync-retry').hidden");
  const before=latest();await js("document.querySelector('#sync-retry').click()");await pause(180);
  before.emit({meta:{name:'agent:response-segment'},payload:{text:'迟到内容'}});
  assert.equal(await js("document.querySelector('#query').value"),'保留的草稿');assert.match(await js("document.querySelector('#attachments').textContent"),/draft.png/);
  assert.equal(await js(`localStorage.getItem('ash.backend.${entry.id}.same.pending')`),record);assert.equal(submits,1);
  emit('hub:replay-done');await wait("document.querySelector('#connection').textContent.includes('已同步')");assert(!(await js("document.querySelector('#messages').textContent")).includes('迟到内容'));assert(receiptCalls>0);assert.equal(submits,1);releaseSubmit();await pause(100);assert.equal(submits,1,'resync while submit is in flight cannot duplicate execution');
  // Session switches keep independent image/text drafts; stale queued replay-done cannot ready the new session.
  const previous=latest();await js("document.querySelectorAll('#sessions button')[1].click()");await pause(100);previous.emit({meta:{name:'hub:replay-done'}});await pause(80);assert.equal(await js("document.querySelector('#send').disabled"),true);emit('hub:replay-done');await wait("!document.querySelector('#send').disabled");assert.equal(await js("document.querySelector('#query').value"),'');
  await js("document.querySelector('#sessions button').click()");await pause(100);assert.equal(await js("document.querySelector('#query').value"),'保留的草稿');assert.match(await js("document.querySelector('#attachments').textContent"),/draft.png/);emit('hub:replay-done');await wait("document.querySelector('#connection').textContent.includes('已同步')");
  // A real stream ends; automatic reconnect must not duplicate the send.
  const old=latest(),count=streams.length;old.stop();await wait("document.querySelector('#connection').textContent.includes('正在恢复')");await pause(2400);assert(streams.length>count);emit('hub:replay-done');await wait("document.querySelector('#connection').textContent.includes('已同步')");assert.equal(submits,1);
  deviceState='unknown';await js("document.querySelector('#refresh').click()");await wait("document.querySelector('#connection').textContent.includes('待确认')");deviceState='offline';await js("document.querySelector('#refresh').click()");await wait("document.querySelector('#connection').textContent.includes('离线')");assert.equal(submits,1);
  holdInfo=true;await js("document.querySelector('#refresh').click()");while(!infoWaits.length)await pause(10);
  await pause(12200);assert.equal(await js("document.querySelector('#connection').textContent"),'执行设备离线');assert.equal(await js("document.querySelector('#sync-retry').hidden"),true,'a pending offline status query is not an active replay');
  holdInfo=false;infoWaits.splice(0).forEach(r=>r());await pause(120);
  deviceState='online';await js("document.querySelector('#refresh').click()");await pause(150);emit('hub:replay-done');await wait("document.querySelector('#connection').textContent.includes('已同步')");
  failList=true;await js("document.querySelector('#refresh').click()");await wait("document.querySelector('#notice').textContent.includes('设备查询暂时失败')");
  failList=false;await js("document.querySelector('#refresh').click()");await pause(150);emit('hub:replay-done');await wait("document.querySelector('#connection').textContent.includes('已同步') && document.querySelector('#notice').hidden");
  // A delayed catalog response after the page is hidden cannot reconnect it.
  holdList=true;await js("document.querySelector('#refresh').click()");while(!releaseList)await pause(10);
  await js("window.dispatchEvent(new Event('pagehide'))");releaseList([{instanceId:'wrong',title:'迟到的列表'}]);await pause(100);assert(!(await js("document.querySelector('#sessions').textContent")).includes('迟到'));const countHidden=streams.length;
  await pause(200);assert.equal(streams.length,countHidden);await js("window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))");await pause(150);emit('hub:replay-done');await wait("document.querySelector('#connection').textContent.includes('已同步')");
  await js("document.querySelector('#return-devices').click()");await pause(100);assert.deepEqual(returns,[['device-plugin','connections']]);
  entry.dispose();await js("document.querySelector('#refresh').click()");await wait("document.querySelector('#connection').textContent.includes('授权已失效')");
  assert.equal(await js(`localStorage.getItem('ash.backend.${entry.id}.same.pending')`),record);assert.equal(await js(`localStorage.getItem('ash.backend.${entry.id}.same.draft')`),'保留的草稿');
  await js("document.querySelector('#return-devices').click()");await pause(100);assert.equal(returns.length,2);assert.equal(submits,1);
  assert.deepEqual(errors,[]);console.log('PASS desktop sync: real 12s retry, current replay only, reset, immutable device identity/owner navigation, image/text drafts, pending receipt without resend, switching, reconnect/offline/unknown/revocation, hidden and late catalog');
 }finally{controller.abort();win?.destroy();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());fs.rmSync(profile,{recursive:true,force:true});clearTimeout(deadline);}
}).then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
