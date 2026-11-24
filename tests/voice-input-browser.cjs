const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {webkit,chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..','remote/public'),device='A'.repeat(43),input={id:'a'.repeat(32),revision:'fixture-v1',label:'语音输入',labelEn:'Voice input',description:'转写服务 · 最长 60 秒 · 仅写入草稿',descriptionEn:'Transcription · Up to 60 seconds · Draft only',kind:'audio',maxDuration:60,maxBytes:4194304};
let result='转写完成 English',hold=false,starts=0,sends=0;const requests=[],jobs=new Map();
const server=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost');res.setHeader('Content-Type','application/json');
 if(u.pathname.includes('/api/')){
  if(u.pathname.endsWith('/me'))return res.end(JSON.stringify({username:'fixture'}));
  if(u.pathname.endsWith('/devices'))return res.end(JSON.stringify([{id:device,name:'测试电脑',online:true}]));
  if(u.pathname.endsWith('/rpc')){let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);requests.push(b);
   let data={};if(b.op==='sessions')data=[{instanceId:'aaaaaa',title:'一'},{instanceId:'bbbbbb',title:'二'}];
   if(b.op==='capabilities')data={composerInputs:true};
   if(b.op==='submit'){sends++;data={state:'done',result:{ok:true}};}
   if(b.op==='request-status')data={state:'done',result:{ok:true}};
   if(b.op==='composer-input'){
    const a=b.args;if(a.action==='list')data=[input];
    if(a.action==='start'){starts++;jobs.set(a.requestId,hold?{state:'pending'}:{state:'done',text:result});data=jobs.get(a.requestId);}
    if(a.action==='status')data=jobs.get(a.requestId);
    if(a.action==='cancel'){jobs.set(a.requestId,{state:'cancelled'});data={state:'cancelled'};}
   }
   return res.end(JSON.stringify(data));
  }
  res.writeHead(404);return res.end('{}');
 }
 const file=path.join(root,u.pathname.replace(/^\/mobile\//,'')||'index.html');if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const engine=process.env.SYNC_ENGINE==='chromium'?'chromium':'webkit';
 const browser=await (engine==='chromium'?chromium:webkit).launch({headless:true,...(engine==='chromium'&&process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript({path:path.join(__dirname,'fixtures/media-recorder.js')});
  await page.addInitScript(()=>{Object.defineProperty(navigator,'standalone',{value:true});globalThis.EventSource=class{constructor(){this.handlers={};globalThis.stream=this;}addEventListener(n,f){this.handlers[n]=f;}close(){}};});
  await page.goto(`http://127.0.0.1:${server.address().port}/mobile/`);
  await page.waitForFunction(()=>sessions.length===2);
  const open=async sid=>{await page.evaluate(s=>openSession(s),sid);await page.waitForTimeout(350);await page.evaluate(()=>stream.onmessage({data:JSON.stringify({meta:{name:'hub:replay-done'},payload:{}})}));await page.waitForSelector('.composer-media:not([hidden])',{timeout:1500});};
  await open('aaaaaa');const query=page.locator('#query');
  const mic=page.locator('.composer-media-button'),button={click:()=>mic.tap()};
  assert.equal(await page.locator('.composer-media-hold').count(),0,'no hold or extra activation step');
  await query.fill('已有草稿');await page.evaluate(()=>{query.setSelectionRange(4,4);}); // global id is browser named element
  await button.click();await page.waitForFunction(()=>mediaFixture.recorders.length===1);assert.equal(sends,0);assert(await query.isVisible());assert.equal(await query.inputValue(),'已有草稿');
  await page.evaluate(()=>menu(false));await page.waitForTimeout(250);await page.screenshot({path:'/tmp/ashub-voice-click-'+engine+'.png'});
  await button.click();await page.waitForFunction(()=>document.querySelector('#query').value.includes('转写完成'));
  assert.equal(await query.inputValue(),'已有草稿转写完成 English');assert.equal(sends,0);assert.equal(starts,1);assert(await page.locator('.composer-media-cancel').isHidden());
  assert(await page.evaluate(()=>mediaFixture.tracks.every(t=>t.stopped)));assert.equal(requests.find(r=>r.op==='composer-input'&&r.args.action==='start').args.mimeType,'audio/mp4');
  // Short iPhone recordings: do not depend on sub-second MP4 fragments, and
  // keep the audio source alive until the recorder has delivered its final data.
  await page.evaluate(()=>{mediaFixture.requireLiveTrackAtFlush=true;mediaFixture.emptySlices=true;});
  await query.fill('短录音草稿');await button.click();await page.waitForTimeout(3000);await button.click();
  await page.waitForFunction(()=>document.querySelector('#query').value.includes('转写完成'),{},{timeout:2000});
  assert.equal(await query.inputValue(),'短录音草稿转写完成 English');assert.equal(sends,0);assert(await page.evaluate(()=>mediaFixture.tracks.every(t=>t.stopped)));
  await page.evaluate(()=>mediaFixture.emptyRecording=true);const emptyStarts=starts;await button.click();await button.click();
  await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='idle');
  assert.equal(starts,emptyStarts);assert.match(await page.locator('.composer-media-status').textContent(),/未取得录音数据/);assert.equal(await query.inputValue(),'短录音草稿转写完成 English');
  await page.evaluate(()=>{mediaFixture.emptyRecording=false;mediaFixture.holdFlush=true;});await button.click();await button.click();
  assert.equal(await page.evaluate(()=>mediaFixture.tracks.filter(t=>!t.stopped).length),1,'final flush still owns the live track');
  await page.locator('.composer-media-cancel').click();assert(await page.evaluate(()=>mediaFixture.tracks.every(t=>t.stopped)));
  await page.evaluate(()=>{mediaFixture.holdFlush=false;globalThis.oldFlush=mediaFixture.recorders.at(-1).flush;});
  await button.click();await page.evaluate(()=>oldFlush());assert.equal(await page.locator('.composer-media').getAttribute('data-state'),'recording');
  assert.equal(starts,emptyStarts);await button.click();await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='idle');assert.equal(starts,emptyStarts+1);assert.equal(sends,0);
  await page.evaluate(()=>{mediaFixture.requireLiveTrackAtFlush=false;mediaFixture.emptySlices=false;});
  // A stream/system stop without an explicit finish must never upload partial speech.
  await query.fill('中断时保留草稿');const beforeInterruption=starts;
  await button.click();await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='recording');
  await page.evaluate(()=>mediaFixture.recorders.at(-1).stop());await page.waitForTimeout(250);
  assert.equal(starts,beforeInterruption,'unexpected recorder stop must not upload');
  assert.equal(await query.inputValue(),'中断时保留草稿');assert.equal(sends,0);
  assert(await page.evaluate(()=>mediaFixture.tracks.every(t=>t.stopped)));
  // An already in-flight successful response must not leak into a newer recording.
  let lateRoute;const intercept=async route=>{const body=route.request().postDataJSON();if(body.op==='composer-input'&&body.args.action==='start'&&!lateRoute){lateRoute=route;return;}await route.continue();};
  await page.route('**/rpc',intercept);await button.click();await button.click();
  for(let i=0;i<100&&!lateRoute;i++)await page.waitForTimeout(10);assert(lateRoute);
  await page.locator('.composer-media-cancel').click();await query.fill('新的草稿');
  await button.click();await button.click();await page.waitForFunction(()=>document.querySelector('#query').value.includes('转写完成'));
  const newDraft=await query.inputValue();await lateRoute.fulfill({contentType:'application/json',body:JSON.stringify({state:'done',text:'被取消的迟到结果'})});
  await page.waitForTimeout(100);assert.equal(await query.inputValue(),newDraft);assert.equal(sends,0);await page.unroute('**/rpc',intercept);
  // PWA pagehide/bfcache departure releases capture without modifying the draft.
  const beforePagehide=starts;await button.click();await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));await page.waitForTimeout(50);
  assert.equal(starts,beforePagehide);assert.equal(await query.inputValue(),newDraft);assert(await page.evaluate(()=>mediaFixture.tracks.every(t=>t.stopped)));
  await page.evaluate(()=>{globalThis.hiddenStream=stream;window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  await page.waitForFunction(()=>source&&stream!==hiddenStream);await page.evaluate(()=>stream.onmessage({data:JSON.stringify({meta:{name:'hub:replay-done'},payload:{}})}));
  await page.waitForFunction(()=>!document.querySelector('.composer-media-button').disabled);assert.equal(await query.inputValue(),newDraft);
  // Responses already in flight stay stale across A -> B -> A and PWA resume,
  // even when a new recording is active. Check both success and error responses.
  for (const mode of ['switch', 'foreground-success', 'foreground-error']) {
    let stale;const intercept=async route=>{const body=route.request().postDataJSON();if(body.op==='composer-input'&&body.args.action==='start'&&!stale){stale=route;return;}await route.continue();};
    await query.fill('旧草稿 '+mode);await page.route('**/rpc',intercept);await button.click();await button.click();
    for(let i=0;i<100&&!stale;i++)await page.waitForTimeout(10);assert(stale);
    if(mode==='switch') {
      await open('bbbbbb');await query.fill('另一对话的草稿');await open('aaaaaa');assert.equal(await query.inputValue(),'旧草稿 '+mode);
    } else {
      await page.evaluate(()=>{globalThis.suspendedStream=stream;window.dispatchEvent(new Event('pagehide'));});
      await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
      await page.waitForFunction(()=>source&&stream!==suspendedStream);await page.evaluate(()=>stream.onmessage({data:JSON.stringify({meta:{name:'hub:replay-done'},payload:{}})}));
      await page.waitForFunction(()=>!document.querySelector('.composer-media-button').disabled);
    }
    const currentDraft='当前草稿 '+mode;await query.fill(currentDraft);await button.click();await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='recording');
    await stale.fulfill({contentType:'application/json',body:JSON.stringify(mode==='foreground-error'?{state:'error',error:'旧转写失败'}:{state:'done',text:'旧转写不能出现'})});
    await page.waitForTimeout(100);assert.equal(await query.inputValue(),currentDraft);assert.equal(sends,0);
    assert.equal(await page.locator('.composer-media').getAttribute('data-state'),'recording','stale response must not stop the new recording');
    assert.equal(await page.evaluate(()=>mediaFixture.tracks.filter(t=>!t.stopped).length),1);
    await page.locator('.composer-media-cancel').click();await page.unroute('**/rpc',intercept);
    if(mode==='switch'){await open('bbbbbb');assert.equal(await query.inputValue(),'另一对话的草稿');await open('aaaaaa');assert.equal(await query.inputValue(),currentDraft);}
  }
  // The UI can become ready before the 250ms owner poll after a switch.
  // A recording explicitly started for the new owner must survive that refresh.
  await open('aaaaaa');
  const rapidStarts=starts;
  for(const mode of ['refresh','poll']){
    await page.evaluate(async mode=>{
      composerMedia.cancel();session=mode==='refresh'?'bbbbbb':'aaaaaa';generation++;
      document.querySelector('#query').value='快速切换后的草稿';
      document.querySelector('.composer-media-button').click();
      if(mode==='refresh')await composerMedia.refresh();
    },mode);
    await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='recording');
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.composer-media').getAttribute('data-state'),'recording',mode+': new-owner capture must survive owner discovery');
    assert.equal(await query.inputValue(),'快速切换后的草稿');assert.equal(starts,rapidStarts);
    // Ownership handoff must not weaken catalog revision invalidation.
    input.revision='fixture-v2-'+mode;await page.evaluate(()=>composerMedia.refresh());
    assert.equal(await page.locator('.composer-media').getAttribute('data-state'),'idle');
    assert.match(await page.locator('.composer-media-status').textContent(),/配置已变更/);
    assert.equal(await query.inputValue(),'快速切换后的草稿');assert.equal(starts,rapidStarts);
    assert(await page.evaluate(()=>mediaFixture.tracks.every(t=>t.stopped)));
  }
  await open('aaaaaa');
  // Continued editing never loses text; IME completion is respected.
  hold=true;await query.fill('原草稿');await button.click();await button.click();await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='transcribing');
  await query.fill('继续编辑');await page.evaluate(()=>document.querySelector('#query').dispatchEvent(new CompositionEvent('compositionstart')));
  for(let i=0;i<200 && ![...jobs.values()].some(j=>j.state==='pending');i++)await new Promise(r=>setTimeout(r,10));
  assert([...jobs.values()].some(j=>j.state==='pending'));
  for(const [id,j]of jobs)if(j.state==='pending')jobs.set(id,{state:'done',text:'后续转写'});
  await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='inserting');assert.equal(await query.inputValue(),'继续编辑');
  await page.evaluate(()=>document.querySelector('#query').dispatchEvent(new CompositionEvent('compositionend')));
  assert.equal(await query.inputValue(),'继续编辑\n后续转写');
  // Late responses and even returning to the original session cannot touch either draft.
  await query.fill('A 草稿');await button.click();await button.click();await page.waitForTimeout(100);
  await open('bbbbbb');await query.fill('B 草稿');for(const [id,j]of jobs)if(j.state==='pending')jobs.set(id,{state:'done',text:'不应出现'});
  await page.waitForTimeout(850);assert.equal(await query.inputValue(),'B 草稿');await open('aaaaaa');assert.equal(await query.inputValue(),'A 草稿');
  // Permission granted after cancellation must release the microphone without recording/uploading.
  const before=starts;await page.evaluate(()=>mediaFixture.permission='hold');await button.click();await page.waitForFunction(()=>!!mediaFixture.grant);
  await page.locator('.composer-media-cancel').click();await page.evaluate(()=>{mediaFixture.permission='allow';mediaFixture.grant();});await page.waitForTimeout(100);assert.equal(starts,before);assert(await page.evaluate(()=>mediaFixture.tracks.every(t=>t.stopped)));
  // A delayed permission grant from the previous session cannot seize or stop
  // the microphone belonging to the new recording, and cannot upload old audio.
  await page.evaluate(()=>{mediaFixture.permission='hold';mediaFixture.grant=null;});await button.click();await page.waitForFunction(()=>!!mediaFixture.grant);
  await open('bbbbbb');const otherDraft=await query.inputValue();await page.evaluate(()=>mediaFixture.permission='allow');await button.click();
  await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='recording');await page.evaluate(()=>mediaFixture.grant());await page.waitForTimeout(100);
  assert.equal(await query.inputValue(),otherDraft);assert.equal(starts,before);assert.equal(sends,0);
  assert.equal(await page.evaluate(()=>mediaFixture.tracks.filter(t=>!t.stopped).length),1);assert.equal(await page.locator('.composer-media').getAttribute('data-state'),'recording');
  await page.locator('.composer-media-cancel').click();await open('aaaaaa');assert.equal(await query.inputValue(),'A 草稿');
  await page.evaluate(()=>mediaFixture.permission='deny');await button.click();await page.waitForFunction(()=>document.querySelector('.composer-media-status').textContent.includes('未获授权'));assert.equal(await query.inputValue(),'A 草稿');
  await page.evaluate(()=>mediaFixture.permission='allow');await button.click();await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});assert(await page.evaluate(()=>mediaFixture.tracks.every(t=>t.stopped)));assert.equal(starts,before);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await open('aaaaaa');
  // User submit cancels pending conversion, retains the normal send path, never sends a transcript.
  await button.click();await button.click();await page.waitForTimeout(100);await page.locator('#send').click();await page.waitForTimeout(100);
  assert.equal(sends,1);assert.equal(requests.find(r=>r.op==='submit').args.query,'A 草稿');
  for(const [id,j]of jobs)if(j.state==='pending')jobs.set(id,{state:'done',text:'不能自动发送'});await page.waitForTimeout(800);assert.equal(sends,1);assert.equal(await query.inputValue(),'');
  for(const width of [320,390,844]){await page.setViewportSize({width,height:844});await page.evaluate(()=>composerMedia.refresh());await button.click();await page.waitForTimeout(30);
   const box=await page.evaluate(()=>{const b=document.querySelector('.composer-media-button').getBoundingClientRect(),c=document.querySelector('.composer-media-cancel').getBoundingClientRect(),f=document.querySelector('#composer');return {width:b.width,height:b.height,right:c.right,viewport:innerWidth,scroll:document.documentElement.scrollWidth,formOverflow:f.scrollWidth-f.clientWidth};});
   assert(box.width>=44&&box.height>=44&&box.right<=width&&box.scroll<=width+1&&box.formOverflow<=1,JSON.stringify(box));await page.locator('.composer-media-cancel').click();
  }
  // A replay only replaces the event stream. An active recording can still be finished.
  hold=false;
  await page.setViewportSize({width:390,height:844});await query.fill('重同步草稿：');
  const beforeReplay=starts;
  await button.click();await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='recording');
  await page.evaluate(async()=>{stream.handlers.reset();await composerMedia.refresh();});
  assert(await query.isDisabled());assert(!(await mic.isDisabled()),'active recording can finish while replay is pending');
  await button.click();await page.waitForFunction(()=>document.querySelector('#query').value.includes('转写完成'));
  assert.equal(starts,beforeReplay+1);assert.equal(sends,1);assert(await mic.isDisabled(),'another recording cannot start during replay');
  await page.evaluate(()=>stream.onmessage({data:JSON.stringify({meta:{name:'hub:replay-done'},payload:{}})}));
  await page.waitForFunction(()=>streamReady);assert.equal(await query.inputValue(),'重同步草稿：转写完成 English');
  assert(await page.evaluate(()=>mediaFixture.tracks.every(t=>t.stopped)));
  // Once admitted, a conversion survives lost HTTP responses without a second upload.
  for(const {action,status,checks} of [
    {action:'status',status:503,checks:2}, {action:'start',status:503,checks:1},
    {action:'status',status:403,checks:1},
  ]) {
    let statusChecks=0, interrupted=false;
    const interrupt=async route=>{
      const {op,args}=route.request().postDataJSON();
      if(op!=='composer-input') return route.continue();
      if(args.action==='status') statusChecks++;
      if(interrupted || args.action!==action) return route.continue();
      interrupted=true;
      if(action==='start') assert.equal((await (await route.fetch()).json()).state,'pending');
      jobs.set(args.requestId,{state:'done',text:'恢复后的转写'});
      if (action === 'status' && status === 503) {
        return route.fulfill({status, contentType:'text/html', body:'<h1>Service Unavailable</h1>'});
      }
      return route.fulfill({status,json:{error:status===403?'共享权限已失效':'正在重新连接'}});
    };
    const beforeStatusRetry=starts, baseDraft='转写重连草稿：';
    hold=true;await page.route('**/rpc',interrupt);await query.fill(baseDraft);
    await button.click();await button.click();
    await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='idle');
    assert.equal(await query.inputValue(),baseDraft+(status===503?'恢复后的转写':''),action+' '+status);
    assert.equal(statusChecks,checks);assert.equal(starts,beforeStatusRetry+1);assert.equal(sends,1);
    if(status===403) assert.match(await page.locator('.composer-media-status').textContent(),/共享权限已失效/);
    await page.unroute('**/rpc',interrupt);
  }
  // The remote page is Chinese today. Exercise the shared component with both
  // document languages, including switching it without touching an active ticket.
  const changeLanguage=lang=>page.evaluate(lang=>{
    document.documentElement.lang=lang;
    document.dispatchEvent(new CustomEvent('langchange',{detail:{lang:lang.split('-')[0]}}));
  },lang);
  const voiceStatus=page.locator('.composer-media-status'),voiceCancel=page.locator('.composer-media-cancel');
  const expectStatus=async (pattern,english)=>{
    await page.waitForFunction(({source,flags})=>new RegExp(source,flags).test(document.querySelector('.composer-media-status').textContent),
      {source:pattern.source,flags:pattern.flags},{timeout:2000});
    if(english)assert.doesNotMatch(await voiceStatus.textContent(),/\p{Script=Han}/u);
  };
  const stages={
    'zh-CN': {recording:/录音/, interrupted:/录音中断/, empty:/未取得录音数据/, denied:/麦克风.*授权/, waiting:/等待麦克风授权/, processing:/正在转写/, cancelled:/已取消.*草稿保留/, cancel:/取消/, providerAuth:/转写服务.*(?:认证|密钥|鉴权)/},
    en: {recording:/recording/i, interrupted:/interrupt|unexpectedly stopped/i, empty:/no (?:audio|recording)|(?:audio|recording).*empty/i, denied:/microphone.*(?:access|permission|denied)/i, waiting:/(?:wait|request).*microphone|microphone.*(?:access|permission)/i, processing:/transcrib/i, cancelled:/cancel(?:led|ed).*draft/i, cancel:/cancel/i, providerAuth:/authentication|API key/i},
  };
  for(const [locale,words] of Object.entries(stages)){
    const english=locale==='en',draft='Preserve this draft 草稿';
    const beforeErrors=starts,beforeSends=sends;
    await changeLanguage(locale);await query.fill(draft);
    assert.equal(await mic.getAttribute('aria-label'),english?input.labelEn:input.label);
    assert.equal(await mic.getAttribute('title'),english?input.descriptionEn:input.description);
    await page.evaluate(()=>{mediaFixture.permission='allow';mediaFixture.emptyRecording=false;});
    await button.click();
    await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='recording');
    await expectStatus(words.recording,english);
    assert.match(await voiceCancel.textContent(),words.cancel);
    await page.evaluate(()=>mediaFixture.recorders.at(-1).stop());
    await expectStatus(words.interrupted,english);
    assert.equal(await query.inputValue(),draft);
    await page.evaluate(()=>mediaFixture.emptyRecording=true);
    await button.click();await button.click();
    await expectStatus(words.empty,english);
    assert.equal(await query.inputValue(),draft);
    await page.evaluate(()=>{mediaFixture.permission='deny';mediaFixture.emptyRecording=false;});
    await button.click();await expectStatus(words.denied,english);
    assert.equal(await query.inputValue(),draft);
    assert.equal(starts,beforeErrors,'interruption, empty recording and denied permission never upload');
    assert.equal(sends,beforeSends);

    await page.evaluate(()=>{mediaFixture.permission='hold';mediaFixture.grant=null;});
    await button.click();await page.waitForFunction(()=>!!mediaFixture.grant);
    await expectStatus(words.waiting,english);
    const alternate=english?'zh-CN':'en';await changeLanguage(alternate);
    await expectStatus(stages[alternate].waiting,!english);
    assert.equal(await page.locator('.composer-media').getAttribute('data-state'),'permission');
    await changeLanguage(locale);await voiceCancel.tap();
    await expectStatus(words.cancelled,english);
    await page.evaluate(()=>{mediaFixture.permission='allow';mediaFixture.grant();});
    await page.waitForFunction(()=>mediaFixture.tracks.every(track=>track.stopped));
    assert.equal(await query.inputValue(),draft);

    hold=true;await button.click();await button.click();
    await expectStatus(words.processing,english);
    await voiceCancel.tap();await expectStatus(words.cancelled,english);
    assert.equal(await query.inputValue(),draft);
    assert.equal(sends,beforeSends);

    const providerDenied=async route=>{
      const {op,args}=route.request().postDataJSON();
      if(op==='composer-input'&&args.action==='start')
        return route.fulfill({json:{state:'error',error:'旧版转写认证提示',errorCode:'providerAuth'}});
      return route.continue();
    };
    await page.route('**/rpc',providerDenied);
    try{
      await button.click();await button.click();
      await expectStatus(words.providerAuth,english);
      assert.equal(await query.inputValue(),draft);
      assert.equal(sends,beforeSends);
    }finally{await page.unroute('**/rpc',providerDenied);}
  }
  await changeLanguage('zh-CN');
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>menu(false));await page.waitForTimeout(200);await page.screenshot({path:'/tmp/ashub-voice-'+engine+'.png'});
  const native=await page.evaluate(async()=>{
    const Recorder=mediaFixture.NativeRecorder, type=['audio/mp4','audio/webm;codecs=opus','audio/webm'].find(t=>Recorder?.isTypeSupported(t));
    if(!type)throw Error('No native recording format');
    const context=new AudioContext(),destination=context.createMediaStreamDestination(),oscillator=context.createOscillator();oscillator.connect(destination);oscillator.start();await context.resume();
    const chunks=[],recording=new Recorder(destination.stream,{mimeType:type});
    const result=new Promise((resolve,reject)=>{recording.ondataavailable=e=>chunks.push(e.data);recording.onerror=reject;recording.onstop=()=>resolve({type:recording.mimeType,bytes:chunks.reduce((n,c)=>n+c.size,0)});});
    recording.start();await new Promise(r=>setTimeout(r,350));recording.stop();oscillator.stop();destination.stream.getTracks().forEach(t=>t.stop());const value=await result;await context.close();return value;
  });
  assert(native.bytes>0,JSON.stringify(native));console.log('Native synthetic recording:',native);
  assert.deepEqual(errors,[]);console.log('PASS '+engine+' iPhone PWA: tap-to-record/finish, visible draft, MP4, sync readiness, interrupted capture, late responses, edit/IME, session isolation, permission/cancel/background/pagehide, manual send, 320/390/844px, zh/en voice feedback and draft retention');
 }finally{await browser.close();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
