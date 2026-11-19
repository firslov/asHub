// Synthetic catalogs only: exercise real DOM, CSS and navigation in WebKit/Chromium.
const {webkit,chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'public');
const groups=[{id:'alpha',name:'寻找阿尔法',sessionIds:['leader','research','executor'],pinnedSessionIds:['leader'],activities:[{id:'workflow',sessionId:'leader',label:'证据核查 · 等待成员交付',state:'waiting'}]},{id:'paper',name:'Paper review',sessionIds:['reviewer']}];
let catalog=[{instanceId:'research',title:'策略研究员',projectId:'alpha',isProcessing:true},{instanceId:'leader',title:'调度中枢',projectId:'alpha'},{instanceId:'executor',title:'执行队员',projectId:'alpha'},{instanceId:'reviewer',title:'文献整理',projectId:'paper'},{instanceId:'free',title:'随手记录',projectId:null}];
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://local');
 if(u.pathname.includes('/api/')){
  res.setHeader('Content-Type','application/json');
  if(u.pathname.endsWith('/me'))return res.end(JSON.stringify({username:'fixture'}));
  if(u.pathname.endsWith('/devices'))return res.end(JSON.stringify([{id:'desktop',name:'我的 Mac',online:true}]));
  if(u.pathname.endsWith('/rpc')){let body='';req.on('data',d=>body+=d);return req.on('end',()=>{const {op}=JSON.parse(body);res.end(JSON.stringify(op==='sessions'?catalog:op==='capabilities'?{projects:true,tasks:true}:op==='project-groups'?groups:{}));})}
  res.writeHead(404);return res.end('{}');
 }
 const file=path.join(root,u.pathname.slice('/mobile/'.length)||'index.html');
 if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end()}
 res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await (process.env.NAV_ENGINE==='chromium'?chromium:webkit).launch({headless:true,...(process.env.WEBKIT_EXECUTABLE && process.env.NAV_ENGINE!=='chromium'?{executablePath:process.env.WEBKIT_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   Object.defineProperty(navigator,'standalone',{value:true});
   globalThis.testStreams=[];
   globalThis.EventSource=class{
    constructor(url){this.url=String(url);this.closed=false;testStreams.push(this);setTimeout(()=>{if(!this.closed){this.onmessage?.({data:JSON.stringify({meta:{name:'agent:response-segment'},payload:{text:'这里是已同步的工作内容\n\n'+Array.from({length:50},(_,i)=>'第 '+i+' 段进展').join('\n\n')}})});this.onmessage?.({data:JSON.stringify({meta:{name:'hub:replay-done'},payload:{}})})}},10)}
    addEventListener(){}close(){this.closed=true}
   };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/mobile/`);
  await page.waitForSelector('[data-group-id="alpha"]');
  assert.equal(await page.locator('[data-group-id="alpha"] .nav-work-status').first().textContent(),'证据核查 · 等待成员交付');
  assert(await page.locator('#devices').isDisabled(),'single device needs no picker');
  assert.equal(await page.locator('#sessions .session-button').count(),0,'projects visible without auto expanding everything');
  await page.locator('[data-group-id="alpha"] .nav-group-toggle').tap();
  assert.deepEqual(await page.locator('[data-group-id="alpha"] .session-button').evaluateAll(es=>es.map(e=>e.dataset.sessionId)),['leader','research','executor']);
  await page.screenshot({path:'/tmp/ashub-navigation-home.png'});
  // A scheduled catalog refresh between pointer-down and pointer-up must not eat a tap.
  const row=page.locator('[data-group-id="alpha"] [data-session-id="leader"]');
  const bounds=await row.boundingBox();await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  await page.mouse.down();await page.evaluate(()=>renderSessions());await page.mouse.up();
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>session),'leader','unchanged polling must preserve an in-progress tap');
  await page.waitForFunction(()=>session==='leader'&&streamReady);
  assert.equal(await page.locator('#chat-project').textContent(),'寻找阿尔法');
  await page.waitForFunction(()=>{const e=document.getElementById('messages');return e.scrollHeight-e.scrollTop-e.clientHeight<5});
  await page.locator('#query').fill('保留这条草稿');
  await page.locator('#menu').tap();
  assert.equal(await page.locator('#sessions .active').count(),2,'recent and project membership stay highlighted');
  await page.locator('#session-search-toggle').tap();await page.locator('#session-search').fill('Paper');
  assert.deepEqual(await page.locator('#sessions .session-button').evaluateAll(es=>es.map(e=>e.dataset.sessionId)),['reviewer']);
  await page.locator('#sessions .session-button').tap();await page.waitForFunction(()=>session==='reviewer'&&streamReady);
  await page.locator('#menu').tap();await page.locator('#session-search-close').tap();
  await page.locator('[data-nav-key="recent:leader"]').tap();await page.waitForFunction(()=>session==='leader');
  assert.equal(await page.locator('#query').inputValue(),'保留这条草稿');
  await page.reload();await page.waitForFunction(()=>session==='leader'&&streamReady);
  assert.equal(await page.locator('#query').inputValue(),'保留这条草稿');
  await page.waitForFunction(()=>{const e=document.getElementById('messages');return e.scrollHeight-e.scrollTop-e.clientHeight<5});
  // Slow sidebar metadata must not delay latest content on reload or PWA resume.
  for(const foreground of [false,true]) {
    let releaseMetadata,metadataRequested=false;
    const metadataGate=new Promise(resolve=>releaseMetadata=resolve);
    await page.route('**/api/devices/*/rpc',async route=>{
      if(route.request().postDataJSON()?.op==='project-groups'){metadataRequested=true;await metadataGate;}
      await route.continue();
    });
    try {
      if(foreground)await page.evaluate(()=>{
        Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));
      });
      else await page.reload();
      await page.waitForFunction(()=>session==='leader'&&streamReady);
      assert(metadataRequested,'the optional catalog remains blocked while the conversation is ready');
      await page.waitForFunction(()=>document.querySelector('.reply')?.textContent.includes('第 49 段进展'));
      assert.equal(await page.locator('#query').inputValue(),'保留这条草稿');
      await page.waitForFunction(()=>{const e=document.getElementById('messages');return e.scrollHeight-e.scrollTop-e.clientHeight<5});
    } finally { releaseMetadata();await page.unrouteAll({behavior:'wait'});if(foreground)await page.evaluate(()=>{delete document.hidden;}); }
    await page.waitForFunction(()=>document.getElementById('chat-project').textContent==='寻找阿尔法');
  }
  // Searching before device discovery completes must cancel restoration too.
  let releaseDevices,devicesRequested=false;
  const deviceGate=new Promise(resolve=>releaseDevices=resolve);
  await page.route('**/api/devices',async route=>{devicesRequested=true;await deviceGate;await route.continue()});
  await page.reload();for(let i=0;i<100&&!devicesRequested;i++)await page.waitForTimeout(10);
  assert(devicesRequested);await page.locator('#session-search-toggle').tap();await page.locator('#session-search').fill('Paper');
  releaseDevices();await page.waitForSelector('#sessions [data-session-id="reviewer"]');
  assert.equal(await page.evaluate(()=>session),'','late device discovery must respect active search');
  assert.equal(await page.locator('#session-search').inputValue(),'Paper');
  await page.unroute('**/api/devices');
  // Removed sharing is checked before restoring a saved conversation.
  catalog=catalog.filter(s=>s.instanceId!=='leader');await page.reload();await page.waitForSelector('[data-group-id="alpha"]');
  assert.equal(await page.evaluate(()=>session),'');assert.equal(await page.evaluate(()=>testStreams.length),0);
  assert.equal(await page.evaluate(()=>navigation.recent.includes('leader')),false);
  // Long grouped lists use one touch scroller, including keyboard/landscape sizes.
  await page.evaluate(()=>{
   sessions=Array.from({length:80},(_,i)=>({instanceId:'member'+i,title:'项目成员 '+i+' · 较长的中文对话名称',projectId:'alpha'}));
   groups=[{id:'alpha',name:'一个较长的研究项目名称 · 共享协作',sessionIds:sessions.map(s=>s.instanceId),pinnedSessionIds:['member2','member1'],activities:[{id:'w',sessionId:'member2',label:'较长的项目工作流状态提示 · 等待成员交付并进行验收'.repeat(3),state:'waiting'}]}];
   navigation={last:'',recent:[],expanded:['alpha'],collapsed:[]};viewFilter='browse';renderSessions();
  });
  for(const [width,height] of [[390,844],[320,568],[568,320],[1024,768]]){
   await page.setViewportSize({width,height});
   for(const home of [true,false]){
    await page.evaluate(home=>{session=home?'':'member2';renderSessions();menu(!home)},home);
    await page.waitForTimeout(250);
    const geometry=await page.evaluate(()=>{
     const side=$('sidebar'),list=$('sessions');side.scrollTop=600;const before=side.scrollTop;renderSessions();const after=side.scrollTop;side.scrollTop=side.scrollHeight;
     const b=side.getBoundingClientRect(),a=$('account').getBoundingClientRect();
     return {before,after,footer:a.bottom<=b.bottom+1,nested:list.scrollHeight>list.clientHeight+1,overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert(geometry.before>=599&&Math.abs(geometry.after-geometry.before)<2&&!geometry.nested&&!geometry.overflow&&geometry.footer,JSON.stringify({width,height,home,geometry}));
   }
  }
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{session='';renderSessions();$('sidebar').scrollTop=0});
  await page.locator('[data-group-id="alpha"] .nav-group-toggle').focus();await page.evaluate(()=>renderSessions());
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.navKey),'group:alpha','refresh preserves keyboard focus');
  await page.evaluate(()=>{document.documentElement.style.setProperty('--viewport-height','360px');sessionSearchExpanded=true;renderSessions();$('sidebar').scrollTop=$('sidebar').scrollHeight});
  assert(await page.evaluate(()=>$('account').getBoundingClientRect().bottom<=361),'keyboard does not trap footer');
  await page.evaluate(()=>{document.documentElement.style.removeProperty('--viewport-height');sessionSearchExpanded=false;renderSessions();$('sidebar').scrollTop=0;document.documentElement.dataset.theme='dark'});
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.session-name').first().evaluate(e=>getComputedStyle(e).color),'rgb(235, 231, 220)','dark text must remain legible');
  await page.screenshot({path:'/tmp/ashub-navigation-dark.png'});
  assert.deepEqual(errors,[]);console.log('PASS navigation: WebKit/Chromium PWA, project pins, two-tap open, global search, recent shortcuts, draft/reload restoration, revoked access, long lists, focus, 320/390/landscape/iPad and keyboard layout');
 }finally{await browser.close();server.closeAllConnections();server.close()}
})().catch(e=>{console.error(e);server.closeAllConnections();server.close();process.exitCode=1});
