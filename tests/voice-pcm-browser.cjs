const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {webkit,chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../remote/public');
const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="composer-media.css"><form id="form"><div id="tools"></div><textarea id="query">已有草稿</textarea><button id="send" type="submit">发送</button></form><script src="composer-media.js"></script>';
let silentWorklet=false;
const server=http.createServer((req,res)=>{res.setHeader('Cache-Control','no-store');if(silentWorklet&&req.url==='/composer-pcm-worklet.js'){res.setHeader('Content-Type','text/javascript');return res.end("class SilentCapture extends AudioWorkletProcessor { process(){return true;} } registerProcessor('ashub-composer-pcm',SilentCapture);");}res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self'; connect-src 'self'");if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}const file=path.join(root,req.url);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');res.end(fs.readFileSync(file));});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const engine=process.env.SYNC_ENGINE==='chromium'?'chromium':'webkit';const browser=await(engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 Version/26.1 Mobile/15E148 Safari/604.1'});page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);
 await page.evaluate(()=>{
  const Native=AudioContext;globalThis.captures=[];globalThis.tracks=[];globalThis.uploads=[];globalThis.pending=[];globalThis.hold=false;globalThis.permissionHold=false;globalThis.sends=0;globalThis.session='A';globalThis.duration=60;globalThis.audioActivation=false;globalThis.blockedResumes=0;globalThis.permissionRequests=0;globalThis.inputRevision='pcm-test';globalThis.available=true;globalThis.coldStart=4200;
  // Desktop engines allow audio more freely than an iOS PWA. Require each
  // context's first resume in the trusted record-button click, not touch down.
  document.addEventListener('click',e=>{audioActivation=e.isTrusted&&!!e.target.closest('.composer-media-button');},true);
  window.addEventListener('click',()=>{audioActivation=false;});
  globalThis.AudioContext=class extends Native{
   constructor(...args){super(...args);this.unlocked=false;this.delay=coldStart;this.warmed=!this.delay;captures.push(this);}
   get state(){return !this.warmed&&!this.closedSuccessfully?'suspended':super.state;}
   resume(){if(!this.unlocked&&!audioActivation){blockedResumes++;return new Promise(()=>{});}this.unlocked=true;
    if(!this.warmed){if(!this.warming)this.warming=new Promise((resolve,reject)=>setTimeout(()=>{this.warmed=true;if(this.closedSuccessfully){reject(new DOMException('Closed','AbortError'));return;}super.resume().then(()=>{this.dispatchEvent(new Event('statechange'));resolve();},reject);},this.delay));return this.warming;}
    return super.resume();
   }
   close(){return super.close().then(()=>{this.closedSuccessfully=true;});}
  };
  globalThis.managed = false;
  globalThis.MediaRecorder=class{constructor(){throw Error('iPhone must bypass MP4 encoder');}};
  Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{
   permissionRequests++;
   if(permissionHold)await new Promise(r=>globalThis.grant=r);
   const generator=new Native(),destination=generator.createMediaStreamDestination(),oscillator=generator.createOscillator();oscillator.frequency.value=440;oscillator.connect(destination);oscillator.start();await generator.resume();
   for(const t of destination.stream.getTracks()){tracks.push(t);const stop=t.stop.bind(t);let stopped=false;t.stop=()=>{if(stopped)return;stopped=true;stop();oscillator.stop();void generator.close().catch(()=>{});};}return destination.stream;
  }}});
  form.onsubmit=e=>{e.preventDefault();sends++;};
  globalThis.controller=AsHubComposerMedia.mount({container:tools,input:query,form,owner:()=>session,enabled:()=>available,request:async(_,action,args)=>{
   if(action==='list')return[{id:'a'.repeat(32),revision:inputRevision,kind:'audio',maxBytes:4194304,maxDuration:duration,...(managed?{audioFormat:'pcm-wav'}:{})}];
   if(action==='start'){uploads.push(args);if(hold)return new Promise(r=>pending.push(r));return{state:'done',text:'语音结果'};}
   return{state:'cancelled'};
  }});
 });
 const query=page.locator('#query');
 const mic=page.locator('.composer-media-button'),button={click:()=>mic.tap()};
await page.waitForSelector('.composer-media:not([hidden])');
 const record=async()=>{await button.click();try{await page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='recording',null,{timeout:6000});}catch(e){throw Error(await page.evaluate(()=>JSON.stringify({state:document.querySelector('.composer-media').dataset.state,status:document.querySelector('.composer-media-status').textContent,blockedResumes})));}};
 const idle=()=>page.waitForFunction(()=>document.querySelector('.composer-media').dataset.state==='idle');
 await query.fill('已有草稿');const coldStarted=Date.now();await record();assert(Date.now()-coldStarted>=4000,'wait for real cold-start readiness instead of failing at 3 seconds');await page.evaluate(()=>coldStart=0);await page.waitForTimeout(3000);await button.click();await idle();assert.equal(await query.inputValue(),'已有草稿语音结果');
 const wav=await page.evaluate(()=>{const u=uploads[0],b=Uint8Array.from(atob(u.data),c=>c.charCodeAt(0)),v=new DataView(b.buffer);let peak=0;for(let i=44;i<b.length;i+=2)peak=Math.max(peak,Math.abs(v.getInt16(i,true)));return{mime:u.mimeType,size:b.length,rate:v.getUint32(24,true),channels:v.getUint16(22,true),data:v.getUint32(40,true),peak};});
 assert.equal(wav.mime,'audio/wav');assert.equal(wav.rate,16000);assert.equal(wav.channels,1);assert.equal(wav.data,wav.size-44);assert(wav.size>50000&&wav.size<150000&&wav.peak>1000,JSON.stringify(wav));
 await page.waitForFunction(()=>captures.every(c=>c.closedSuccessfully)&&tracks.every(t=>t.readyState==='ended'));
 // Cancel during slow hardware startup, then record again. The old engine's
 // eventual completion must not interrupt the current recorder or edit a draft.
 for(const mode of ['cancel','switch','foreground']){
  const beforeWarmCancel=await page.evaluate(()=>uploads.length);
  await page.evaluate(()=>coldStart=4200);await button.click();await page.waitForFunction(()=>document.querySelector('.composer-media-status').textContent==='正在启动麦克风…');
  if(mode==='cancel')await page.locator('.composer-media-cancel').click();
  else if(mode==='switch')await page.evaluate(async()=>{controller.cancel();session=session==='A'?'B':'A';query.value=session+' 草稿';await controller.refresh();});
  else await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pagehide'));Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  const warmDraft=await query.inputValue();await page.evaluate(()=>coldStart=0);await record();await page.waitForTimeout(4400);
  assert.equal(await page.locator('.composer-media').getAttribute('data-state'),'recording',mode);assert.equal(await query.inputValue(),warmDraft,mode);assert.equal(await page.evaluate(()=>uploads.length),beforeWarmCancel,mode);
  await page.locator('.composer-media-cancel').click();await page.waitForFunction(()=>captures.every(c=>c.closedSuccessfully)&&tracks.every(t=>t.readyState==='ended'));
 }
 // A cancelled provider response must not touch a newer PCM recording/draft.
 await page.evaluate(()=>hold=true);await record();await page.waitForTimeout(400);await button.click();await page.waitForFunction(()=>pending.length===1);await page.locator('.composer-media-cancel').click();await query.fill('新草稿');
 await record();await page.evaluate(()=>pending.shift()({state:'done',text:'过期结果'}));await page.waitForTimeout(100);assert.equal(await query.inputValue(),'新草稿');assert.equal(await page.locator('.composer-media').getAttribute('data-state'),'recording');
 await page.waitForTimeout(300);await button.click();await page.waitForFunction(()=>pending.length===1);await page.evaluate(()=>pending.shift()({state:'done',text:'新录音'}));await idle();assert.equal(await query.inputValue(),'新草稿新录音');
 // Cancellation/session switches/pagehide must immediately release all contexts/tracks.
 for(const action of ['cancel','switch','pagehide']){const count=await page.evaluate(()=>uploads.length);await record();await page.waitForTimeout(200);
  await page.evaluate(action=>{if(action==='cancel')controller.cancel();if(action==='switch'){controller.cancel();session='B';query.value='B 草稿';void controller.refresh();}if(action==='pagehide')window.dispatchEvent(new Event('pagehide'));},action);
  await idle();await page.waitForFunction(()=>captures.every(c=>c.closedSuccessfully)&&tracks.every(t=>t.readyState==='ended'));assert.equal(await page.evaluate(()=>uploads.length),count);
 }
 await page.evaluate(()=>{hold=false;permissionHold=true;});await button.click();await page.waitForFunction(()=>!!globalThis.grant);await page.locator('.composer-media-cancel').click();await page.evaluate(()=>{permissionHold=false;grant();});await page.waitForTimeout(100);await page.waitForFunction(()=>captures.every(c=>c.closedSuccessfully)&&tracks.every(t=>t.readyState==='ended'));
 // Worklet and UI both enforce duration; the resulting file remains bounded.
 await page.evaluate(async()=>{duration=1;await controller.refresh();});const count=await page.evaluate(()=>uploads.length);await record();await idle();assert.equal(await page.evaluate(()=>uploads.length),count+1);
 // A silent AudioWorklet preserves the draft and reports missing PCM audio in
 // the active language, just as an empty MediaRecorder result does.
 silentWorklet=true;
 await page.evaluate(async()=>{duration=60;await controller.refresh();});const noAudioCount=await page.evaluate(()=>uploads.length);
 for(const [locale,message] of [['zh-CN',/未收到麦克风音频/],['en',/no (?:microphone )?audio/i]]){
  await page.evaluate(lang=>{document.documentElement.lang=lang;document.dispatchEvent(new Event('langchange'));},locale);
  await query.fill('Preserve this draft 草稿');
  await record();await idle();
  const status=await page.locator('.composer-media-status').textContent();
  assert.match(status,message);
  if(locale==='en')assert.doesNotMatch(status,/\p{Script=Han}/u);
  assert.equal(await query.inputValue(),'Preserve this draft 草稿');
  assert.equal(await page.evaluate(()=>uploads.length),noAudioCount);
  await page.waitForFunction(()=>captures.every(c=>c.closedSuccessfully)&&tracks.every(t=>t.readyState==='ended'));
 }
 silentWorklet=false;
 // The free descriptor must select PCM on desktop browsers with MediaRecorder.
 await page.evaluate(async()=>{
  Object.defineProperties(navigator, {userAgent:{value:'Desktop test'}, maxTouchPoints:{value:0}});
  managed=true;inputRevision='managed-pcm';await controller.refresh();
 });
 await record();await page.waitForTimeout(350);await button.click();await idle();
 assert.equal(await page.evaluate(()=>uploads.at(-1).mimeType),'audio/wav');
 assert.equal(await page.evaluate(()=>blockedResumes),0,'every fresh context must be unlocked in the record-button tap');assert.equal(await page.evaluate(()=>sends),0);assert.deepEqual(errors,[]);console.log('PASS '+engine+' iPhone PCM: 4.2s cold start, tap activation, no hold/extra enable step, actual AudioWorklet, 3-second 16k mono WAV, non-silent samples, duration, cancel/re-record/late results, session/pagehide/permission cleanup',wav);
}finally{await browser.close();server.closeAllConnections();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
