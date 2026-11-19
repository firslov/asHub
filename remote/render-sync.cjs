// Isolated iPhone/PWA fixture: real DOM, clocks and layout; no production devices.
const {webkit,chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'public'),requests=[];
let finishLogout, activeUser='fixture';
const deletions=new Set();
let devices=[{id:'desktop',name:'测试电脑',online:true}],catalog=[{instanceId:'aaaaaa',title:'个人工作',projectId:null},{instanceId:'bbbbbb',title:'其他对话',projectId:null}];
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');
 if(url.pathname.includes('/api/')){
  res.setHeader('Content-Type','application/json');
  if(url.pathname.endsWith('/logout')){await new Promise(resolve=>finishLogout=resolve);activeUser='';return res.end('{"ok":true}');}
  if(url.pathname.endsWith('/login')){let raw='';for await(const c of req)raw+=c;activeUser=JSON.parse(raw).username;return res.end(JSON.stringify({username:activeUser}));}
  if(url.pathname.endsWith('/me'))return res.end(JSON.stringify({username:activeUser}));
  if(url.pathname.endsWith('/devices'))return res.end(JSON.stringify(devices));
  if(url.pathname.endsWith('/rpc')){let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests.push(body);const {op,args}=body;
   if(op==='session-delete'){deletions.add(args.requestId);catalog=catalog.filter(s=>s.instanceId!==args.session);}
   return res.end(JSON.stringify(op==='sessions'?catalog:op==='capabilities'?{sessionDelete:true}:op==='request-status'?(deletions.has(args.requestId)?{state:'done',result:{ok:true}}:{state:'pending'}):{}));}
  res.writeHead(404);return res.end('{}');
 }
 const file=path.join(root,url.pathname.slice('/mobile/'.length)||'index.html');
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const engine=process.env.SYNC_ENGINE==='chromium'?'chromium':'webkit';
 const browser=await (engine==='chromium'?chromium:webkit).launch({headless:true,...(engine==='chromium'&&process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),...(process.env.WEBKIT_EXECUTABLE && engine==='webkit'?{executablePath:process.env.WEBKIT_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   Object.defineProperty(navigator,'standalone',{value:true});globalThis.testStreams=[];
   globalThis.EventSource=class{constructor(url){this.url=String(url);this.handlers={};testStreams.push(this);}addEventListener(name,fn){this.handlers[name]=fn;}close(){this.closed=true;}};
   globalThis.emitTest=(name,payload={},index=testStreams.length-1)=>testStreams[index].onmessage({data:JSON.stringify({meta:{name},payload})});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/mobile/`);
  await page.waitForFunction(()=>sessions.length===2);await page.evaluate(()=>openSession('aaaaaa'));
  await page.waitForFunction(()=>testStreams.length===1);assert.match(await page.locator('#connection').textContent(),/正在同步/);
  await page.evaluate(()=>{testStreams[0].onopen();testStreams[0].handlers.reset();emitTest('agent:response-segment',{text:'已完成的工作记录'});emitTest('agent:processing-done');});
  assert(await page.locator('#send').isDisabled());assert(await page.locator('#sync-retry').isHidden());
  await page.evaluate(()=>emitTest('hub:replay-done'));await page.waitForFunction(()=>streamReady);
  assert.equal(await page.evaluate(async()=>{
   let mutations=0;const observer=new MutationObserver(records=>mutations+=records.length);
   for(const id of ['connection','sync-help'])observer.observe(document.getElementById(id),{childList:true});
   for(let i=0;i<5;i++)controls();await new Promise(r=>requestAnimationFrame(r));observer.disconnect();return mutations;
  }),0,'unchanged state does not repeatedly rewrite the live status announcement');
  await page.locator('#query').fill('保留文本草稿');
  await page.evaluate(()=>{
   fullHistory=true;images=[{name:'draft.png',mimeType:'image/png',data:'AAAA'},{id:'uploaded-image',name:'saved.png'}];renderAttachments();saveDraft();
   sending=true;pendingSend={id:'pending-id',key:key('pending')};storage.set(key('pending'),'pending-id');storage.set(key('pending')+':draft','先前发送的内容');notice('发送结果待确认');testStreams[0].handlers.reset();
  });
  // Real 12-second threshold: neither transport open nor partial frames unlock retry early.
  await page.waitForTimeout(1000);assert(await page.locator('#sync-retry').isHidden());
  await page.waitForSelector('#sync-retry:visible',{timeout:15000});assert.match(await page.locator('#sync-help').textContent(),/草稿和待确认/);
  for(const width of [320,390,844]){
   await page.setViewportSize({width,height:width===844?390:844});await page.waitForTimeout(300);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
   const button=await page.locator('#sync-retry').boundingBox();assert(button&&button.width>0&&button.x>=0&&button.x+button.width<=width+1);
  }
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  assert(await page.locator('#sync-retry').evaluate(b=>{const r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'retry remains tappable after orientation changes');
  for(const theme of ['light','dark']){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);await page.waitForTimeout(300);await page.screenshot({path:`/tmp/ashub-sync-${engine}-${theme}.png`});}
  const generationBefore=await page.evaluate(()=>generation);await page.locator('#sync-retry').tap();
  await page.waitForFunction(()=>testStreams.length===2);assert(await page.locator('#sync-retry').isHidden());
  const state=await page.evaluate(()=>({g:generation,url:testStreams[1].url,text:document.getElementById('query').value,images:images.length,data:images[0].data,sending,pending:storage.get(key('pending')),sent:storage.get(key('pending')+':draft'),notice:document.getElementById('notice').textContent}));
  assert.equal(state.g,generationBefore);assert.equal(new URL(state.url).searchParams.get('history'),'all');assert.equal(state.text,'保留文本草稿');assert.equal(state.images,2);assert.equal(state.data,'AAAA');assert.equal(state.pending,'pending-id');assert.equal(state.sent,'先前发送的内容');assert.equal(state.sending,true);assert.equal(state.notice,'发送结果待确认');
  await page.evaluate(()=>{emitTest('hub:replay-done',{},0);testStreams[0].handlers.reset();testStreams[0].onerror();});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>streamReady),false);
  await page.evaluate(()=>{testStreams[1].handlers.reset();emitTest('agent:response-segment',{text:'最新内容'});emitTest('hub:replay-done');});await page.waitForFunction(()=>streamReady);assert(await page.locator('#sync-status').isHidden());assert(await page.locator('#send').isDisabled());
  await page.evaluate(()=>testStreams[1].onerror());assert.match(await page.locator('#connection').textContent(),/连接中断，正在自动重连/);await page.waitForFunction(()=>testStreams.length===3,{},{timeout:5000});
  devices[0].online=false;await page.evaluate(()=>refreshDevices());assert.equal(await page.locator('#connection').textContent(),'电脑离线');assert(await page.locator('#sync-retry').isHidden());assert.match(await page.locator('#sync-help').textContent(),/设备互联/);
  await page.evaluate(()=>emitTest('hub:replay-done',{},2));assert.equal(await page.evaluate(()=>streamReady),false);
  devices[0].online=true;await page.evaluate(()=>refreshDevices());await page.waitForFunction(()=>testStreams.length===4);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  assert.equal(await page.evaluate(()=>source),null);assert.equal(await page.evaluate(()=>syncTimer),null);assert(await page.locator('#sync-status').isHidden());
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForFunction(()=>testStreams.length===5);
  assert(await page.locator('#sync-retry').isHidden());assert.equal(await page.locator('#query').inputValue(),'保留文本草稿');assert.equal(await page.evaluate(()=>images.length),2);
  await page.evaluate(()=>emitTest('hub:replay-done'));await page.waitForFunction(()=>streamReady);
  // Real HTTP ordering: an old missing snapshot must not unlock a newer pending receipt.
  let delayedReceipt,receiptChecks=0;
  await page.route('**/api/devices/*/rpc',async route=>{
   const body=route.request().postDataJSON();
   if(body.op!=='request-status'||body.args?.requestId!=='ordered-receipt')return route.continue();
   if(++receiptChecks===1){delayedReceipt=route;return;}
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'pending'})});
  });
  await page.evaluate(()=>{storage.set(key('pending'),'ordered-receipt');sending=true;window.lateReceipt=checkPending('ordered-receipt',generation,key('pending'));});
  for(let i=0;i<100&&!delayedReceipt;i++)await page.waitForTimeout(20);assert(delayedReceipt);
  await page.evaluate(()=>checkPending('ordered-receipt',generation,key('pending')));
  await delayedReceipt.fulfill({status:200,contentType:'application/json',body:JSON.stringify({state:'missing'})});
  await page.evaluate(()=>window.lateReceipt);
  assert.equal(await page.evaluate(()=>storage.get(key('pending'))),'ordered-receipt');assert.equal(await page.evaluate(()=>sending),true);
  assert.equal(await page.locator('#query').inputValue(),'保留文本草稿');assert.equal(await page.evaluate(()=>images.length),2);
  await page.unroute('**/api/devices/*/rpc');
  catalog=[];await page.evaluate(()=>refreshSessions());assert.match(await page.locator('#selection-state').textContent(),/设置共享目录/);
  devices=[];await page.evaluate(()=>refreshDevices());assert.match(await page.locator('#selection-state').textContent(),/设备互联 → 允许其他设备访问本机/);
  assert.equal(requests.filter(r=>r.op==='submit').length,0,'resync never resubmits a pending message');
  // Delay a real file read while using the sidebar and account controls. Both
  // devices and accounts deliberately expose the same conversation IDs.
  devices=[{id:'desktop',name:'测试电脑',online:true},{id:'laptop',name:'另一台电脑',online:true}];
  catalog=[{instanceId:'aaaaaa',title:'个人工作',projectId:null},{instanceId:'bbbbbb',title:'其他对话',projectId:null}];
  await page.evaluate(()=>refreshDevices());
  const open=async sid=>{
   if(await page.locator('#menu').isVisible() && await page.locator('#shade').isHidden())await page.locator('#menu').tap();
   await page.locator(`button[data-session-id=${sid}]`).first().tap();
   await page.evaluate(()=>emitTest('hub:replay-done'));
   await page.waitForFunction(()=>streamReady);
  };
  const query=page.locator('#query'), attachments=page.locator('#attachments button');
  await page.evaluate(()=>{
   const read=FileReader.prototype.readAsDataURL;
   FileReader.prototype.readAsDataURL=function(file){
    window.releaseImage=()=>new Promise(resolve=>{this.addEventListener('loadend',resolve,{once:true});read.call(this,file);});
   };
  });
  const selectImage=async name=>{
   await page.evaluate(()=>{window.releaseImage=null;});
   await page.locator('#image-input').setInputFiles({name,mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1f8AAAAASUVORK5CYII=','base64')});
   await page.waitForFunction(()=>!!window.releaseImage);
  };
  await open('bbbbbb');await query.fill('设备一的原草稿');
  await selectImage('session-draft.png');await open('aaaaaa');
  await page.evaluate(()=>window.releaseImage());assert.equal(await attachments.count(),2,'current conversation still has only its own two attachments');
  await open('bbbbbb');assert.equal(await query.inputValue(),'设备一的原草稿');assert.match(await attachments.first().textContent(),/session-draft.png/);
  await selectImage('device-draft.png');await page.locator('#menu').tap();await page.locator('#devices').selectOption('laptop');
  await open('bbbbbb');await query.fill('设备二的草稿');
  await page.evaluate(()=>window.releaseImage());assert.equal(await attachments.count(),0,'same session ID on another device must not receive the file');
  await page.locator('#menu').tap();await page.locator('#devices').selectOption('desktop');
  await page.waitForFunction(()=>device==='desktop'&&session==='bbbbbb');
  await page.evaluate(()=>emitTest('hub:replay-done'));await page.waitForFunction(()=>streamReady);
  assert.equal(await query.inputValue(),'设备一的原草稿');
  assert.deepEqual(await attachments.allTextContents(),['session-draft.png ×','device-draft.png ×']);
  let submitRoute, submitted, receiptState='pending', submitCount=0;
  await page.route('**/api/devices/*/rpc',route=>{
   const {op,args}=route.request().postDataJSON();
   if(op==='submit'){submitCount++;submitted=args;submitRoute=route;return;}
   if(op==='request-status'&&args.requestId===submitted?.requestId)return route.fulfill({json:{state:receiptState}});
   return route.continue();
  });
  await page.locator('#send').tap();
  for(let i=0;!submitRoute&&i<100;i++)await page.waitForTimeout(10);assert(submitRoute);
  assert.equal(submitted.session,'bbbbbb');assert.equal(submitted.query,'设备一的原草稿');assert.equal(submitted.images.length,2);
  await query.fill('发送后继续编辑');await selectImage('after-submit.png');await page.evaluate(()=>window.releaseImage());
  await open('aaaaaa');await submitRoute.fulfill({json:{state:'pending'}});
  await open('bbbbbb');assert(await page.locator('#send').isDisabled());
  assert.equal(await page.evaluate(()=>storage.get(key('pending'))),submitted.requestId);
  receiptState='done';await page.evaluate(()=>checkPending(storage.get(key('pending')),generation,key('pending')));
  assert.equal(await query.inputValue(),'发送后继续编辑');assert.deepEqual(await attachments.allTextContents(),['after-submit.png ×']);
  assert.equal(submitCount,1,'opening another conversation and returning cannot repeat a prior submission');
  await page.unroute('**/api/devices/*/rpc');
  const deletedDraft=await page.evaluate(()=>key('draft'));
  await selectImage('deleted-draft.png');
  await page.locator('#session-actions').tap();await page.getByRole('button',{name:'删除对话',exact:true}).tap();
  await page.getByRole('button',{name:'确认删除',exact:true}).tap();await page.waitForFunction(()=>!session);
  await page.evaluate(()=>window.releaseImage());assert.equal(await page.evaluate(k=>imageDrafts.has(k),deletedDraft),false,'late read cannot recreate a deleted draft');
  catalog.push({instanceId:'cccccc',title:'第三个对话',projectId:null});await page.evaluate(()=>refreshSessions());
  await open('cccccc');await query.fill('退出前草稿');await selectImage('signed-out-draft.png');
  await page.locator('#menu').tap();await page.locator('#account').tap();
  await page.getByRole('button',{name:'退出登录',exact:true}).tap();
  for(let i=0;!finishLogout&&i<100;i++)await page.waitForTimeout(10);assert(finishLogout);
  await page.locator('#modal-close').tap();await open('aaaaaa');
  finishLogout();await page.waitForSelector('#auth:visible');
  // A late read from the old account cannot appear in the logged-out view, or
  // after logging back into that account with a new authorization context.
  await page.evaluate(()=>window.releaseImage());
  await page.locator('#login-form [name=username]').fill('another-account');await page.locator('#login-form [name=password]').fill('fixture-password');
  await page.locator('#auth-submit').tap();await page.waitForFunction(()=>user==='another-account'&&sessions.length===2);
  await open('cccccc');assert.equal(await query.inputValue(),'');assert.equal(await attachments.count(),0);
  assert.deepEqual(await page.evaluate(()=>draftImages('ashub-mobile:fixture:desktop:cccccc:draft')),[]);
  assert.deepEqual(errors,[]);
  console.log(`PASS ${engine} iPhone PWA: live replay state, real timeout, retry, drafts/images/receipt/history, late images across sessions/devices/deletion, logout while navigating, account isolation, out-of-order HTTP receipts, old callbacks, auto reconnect, offline/background recovery, sharing guidance and 320/390/844px layout`);
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);server.closeAllConnections();server.close();process.exitCode=1;});
