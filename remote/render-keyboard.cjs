// VisualViewport keyboard/pan simulation on the real remote page; no account traffic.
const assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {webkit,chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const engine=process.env.SYNC_ENGINE==='chromium'?'chromium':'webkit';
 const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});page.setDefaultTimeout(6000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.fetch=async()=>({ok:false,status:401,json:async()=>({error:'fixture'})});Object.defineProperty(navigator,'standalone',{value:true});const viewport=new EventTarget();Object.assign(viewport,{height:844,width:390,offsetTop:0,offsetLeft:0,scale:1});Object.defineProperty(window,'visualViewport',{value:viewport});window.testViewport=(height,top,event='resize')=>{Object.assign(viewport,{height,offsetTop:top});viewport.dispatchEvent(new Event(event));};});
  await page.goto(pathToFileURL(path.join(__dirname,'public/index.html')).href);
  await page.evaluate(()=>{window.EventSource=class{constructor(){this.handlers={}}addEventListener(n,f){this.handlers[n]=f}close(){}};window.fetch=async()=>({ok:true,json:async()=>[]});$('auth').hidden=true;$('workspace').hidden=false;user='fixture';device='desktop';devices=[{id:device,online:true}];sessions=[{instanceId:'same',title:'Keyboard'}];openSession('same');source.handlers.reset();for(let i=0;i<20;i++){frame({meta:{name:'agent:query'},payload:{query:'问题 '+i}});frame({meta:{name:'agent:response-segment'},payload:{text:'正文 '.repeat(100)}});}frame({meta:{name:'hub:replay-done'},payload:{}});$('query').disabled=false;$('query').value='尚未发送的草稿';});
  const geometry=()=>page.evaluate(()=>{const v=visualViewport,w=$('workspace').getBoundingClientRect(),q=$('query').getBoundingClientRect(),m=$('messages');return{top:w.top,bottom:w.bottom,height:w.height,viewTop:v.offsetTop,viewBottom:v.offsetTop+v.height,inputTop:q.top,inputBottom:q.bottom,gap:m.scrollHeight-m.clientHeight-m.scrollTop,draft:$('query').value,focused:document.activeElement.id,following:followingBottom,rootHeight:document.documentElement.scrollHeight};});
  await page.waitForFunction(()=>$('messages').scrollHeight-$('messages').clientHeight-$('messages').scrollTop<=2);
  await page.locator('#query').focus();
  for(const [height,top,event] of [[460,0,'resize'],[400,120,'scroll'],[380,140,'resize'],[844,0,'resize']]){
   await page.evaluate(([h,t,e])=>testViewport(h,t,e),[height,top,event]);await page.waitForTimeout(100);const g=await geometry();
   assert(Math.abs(g.top-top)<2&&Math.abs(g.bottom-(top+height))<2,JSON.stringify(g));assert(g.inputTop>=top&&g.inputBottom<=top+height,JSON.stringify(g));assert(g.gap<=2,JSON.stringify(g));assert.equal(g.draft,'尚未发送的草稿');assert.equal(g.focused,'query');
  }
  // Switching while the keyboard is up keeps each draft owned by its session
  // and brings the new conversation's latest message into the visible area.
  await page.evaluate(()=>{
   testViewport(400,120);sessions.push({instanceId:'other',title:'Other'});
   openSession('other');source.handlers.reset();
   frame({meta:{name:'agent:response-segment'},payload:{text:'新对话 '.repeat(800)}});
   frame({meta:{name:'hub:replay-done'},payload:{}});$('query').value='另一对话草稿';
  });await page.waitForTimeout(100);
  assert((await geometry()).gap<=2);
  await page.evaluate(()=>{
   openSession('same');source.handlers.reset();
   frame({meta:{name:'agent:response-segment'},payload:{text:'原对话 '.repeat(800)}});
   frame({meta:{name:'hub:replay-done'},payload:{}});
  });await page.waitForTimeout(100);
  assert.equal((await geometry()).draft,'尚未发送的草稿');assert((await geometry()).gap<=2);
  await page.evaluate(()=>{readHistory();$('messages').scrollTop=100;testViewport(400,120);});await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>$('messages').scrollTop),100,'keyboard must not pull a reader out of history');
  await page.evaluate(()=>testViewport(844,0));await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>followingBottom),false);
  // A suspended PWA can return with a different keyboard/viewport geometry
  // without receiving the resize/scroll events that happened while hidden.
  for(const mode of ['pageshow','visibility'])for(const following of [false,true]){
   await page.evaluate(following=>{if(following)scroll(true);else{readHistory();$('messages').scrollTop=100;}},following);
   await page.evaluate(mode=>{
    testViewport(400,120);
    if(mode==='pageshow')window.dispatchEvent(new Event('pagehide'));
    else{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));}
    Object.assign(visualViewport,{height:844,offsetTop:0});
    // Isolate layout restoration from the network replay tested separately.
    user='';
    if(mode==='pageshow')window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
    else{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));}
   },mode);
   await page.waitForTimeout(100);const g=await geometry();
   assert(Math.abs(g.top)<2&&Math.abs(g.bottom-844)<2,mode+': '+JSON.stringify(g));
   assert.equal(g.draft,'尚未发送的草稿');assert.equal(g.following,following);if(following)assert(g.gap<=2,JSON.stringify(g));else assert.equal(await page.evaluate(()=>$('messages').scrollTop),100);
  }
  // Sidebar input follows the same visual viewport; login keeps normal scrolling.
  await page.evaluate(()=>{menu(true);testViewport(400,120);});await page.waitForTimeout(100);const sidebar=await page.locator('#sidebar').boundingBox();assert(Math.abs(sidebar.y-120)<2&&sidebar.height<=401,JSON.stringify(sidebar));
  await page.evaluate(()=>{menu(false);$('workspace').hidden=true;$('auth').hidden=false;testViewport(844,0);});assert.notEqual(await page.locator('body').evaluate(e=>getComputedStyle(e).overflowY),'hidden');
  assert.deepEqual(errors,[]);console.log('PASS '+engine+' keyboard viewport: resize/pan, composer and latest message visibility, draft/focus, session switch, foreground/bfcache geometry, reading position, close, sidebar and login');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
