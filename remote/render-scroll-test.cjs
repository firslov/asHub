// Actual browser layout, synthetic sessions only; no account or live model requests.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-remote-scroll-'));
app.setPath('userData', profile);
let win;
const wait = ms => new Promise(r => setTimeout(r, ms));
const watchdog = setTimeout(() => finish(1), 60000);
app.whenReady().then(async () => {
 win = new BrowserWindow({width:390,height:844,show:false,webPreferences:{contextIsolation:true,backgroundThrottling:false}});
 await win.loadFile(path.join(__dirname,'public/index.html'));
 const run = code => win.webContents.executeJavaScript(code);
 const pos = () => run(`(()=>{const m=$('messages');return {top:m.scrollTop,gap:m.scrollHeight-m.clientHeight-m.scrollTop};})()`);
 await run(`window.EventSource=class {constructor(){this.handlers={};} addEventListener(n,f){this.handlers[n]=f;} close(){}};
 window.fetch=async()=>({ok:true,json:async()=>[]});
 $('auth').hidden=true;$('workspace').hidden=false;user='test';device='desktop';devices=[{id:device,online:true}];
 sessions=[{instanceId:'first',title:'First'},{instanceId:'second',title:'Second'}];
 window.replay=async id=>{await openSession(id);source.handlers.reset();for(let i=0;i<14;i++){
 source.onmessage({data:JSON.stringify({meta:{name:'agent:query'},payload:{query:'Question '+i}})});
 source.onmessage({data:JSON.stringify({meta:{name:'agent:response-segment'},payload:{text:'Paragraph '+('long response content '.repeat(50))}})});
 source.onmessage({data:JSON.stringify({meta:{name:'agent:processing-done'},payload:{}})});
 }source.onmessage({data:JSON.stringify({meta:{name:'hub:replay-done'},payload:{}})});};void 0;`);
 for (const [width,height] of [[390,844],[320,568],[568,320],[1200,800]]) {
  win.setContentSize(width,height); await wait(100);
  await run(`replay('first')`); await wait(200);
  assert((await pos()).gap<=2,'initial replay at bottom');
  await run(`$('messages').dispatchEvent(new WheelEvent('wheel',{deltaY:-500,bubbles:true}));$('messages').scrollTop=100`); await wait(80);
  await run(`replay('second')`); await wait(200);
  assert((await pos()).gap<=2,'switch from history must reach bottom');
  // Images and font/layout settling can change content height after the last SSE frame.
  await run(`window.late=el('div');late.style.height='10px';$('messages').lastElementChild.append(late);scroll(true);`);await wait(80);
  await run(`late.style.height='360px'`); await wait(100);
  assert((await pos()).gap<=2,`late content growth must retain bottom at ${width}`);
  // A new SSE frame can arrive before ResizeObserver delivers the layout change.
  await run(`late.style.height='560px';frame({meta:{name:'agent:usage'},payload:{total_tokens:500}})`);await wait(100);
  assert((await pos()).gap<=2,'a frame racing layout must preserve following intent');
  await run(`document.documentElement.style.setProperty('--viewport-height','240px')`);await wait(100);
  assert((await pos()).gap<=2,'keyboard/viewport shrinking must retain bottom');
  await run(`document.documentElement.style.removeProperty('--viewport-height')`);await wait(100);
  await run(`$('messages').dispatchEvent(new WheelEvent('wheel',{deltaY:-500,bubbles:true}));$('messages').scrollTop=100`);await wait(80);const reading=await pos();
  await run(`late.style.height='540px'`);await wait(100);
  assert(Math.abs((await pos()).top-reading.top)<=2,'late growth must not interrupt reading');
  await run(`document.documentElement.style.setProperty('--viewport-height','240px')`);await wait(100);
  assert(Math.abs((await pos()).top-reading.top)<=2,'viewport changes must not interrupt reading');
  await run(`document.documentElement.style.removeProperty('--viewport-height');scroll(true)`);await wait(100);
  // A branch reset may arrive in a batch whose old viewport was scrolled into history.
  await run(`$('messages').dispatchEvent(new WheelEvent('wheel',{deltaY:-500,bubbles:true}));$('messages').scrollTop=100`);await wait(80);
  await run(`enqueueFrame({meta:{name:'hub:branch-switched'}});for(let i=0;i<70;i++){
   enqueueFrame({meta:{name:'agent:query'},payload:{query:'Branch '+i}});
   enqueueFrame({meta:{name:'agent:response-segment'},payload:{text:'Replayed '.repeat(100)}});
   enqueueFrame({meta:{name:'agent:processing-done'}});
  }enqueueFrame({meta:{name:'hub:replay-done'}});`);await wait(300);
  assert((await pos()).gap<=2,'reset inside a batch must reset follow intent');
  await run(`(()=>{window.record=el('details');record.append(el('summary','Inspect details'));const body=el('div');body.style.height='600px';record.append(body);$('messages').append(record);scroll(true);})()`);await wait(80);
  const beforeExpand=await pos();
  await run(`record.querySelector('summary').click()`);await wait(100);
  assert(Math.abs((await pos()).top-beforeExpand.top)<=2,'expanding details must preserve the reader position');
  console.log(`PASS ${width}x${height}: session switch, late layout, viewport, reading, branch replay, disclosure`);
 }
 await require('./scroll-intent-scenarios.cjs')(run,async(width,height)=>{win.setContentSize(width,height);await wait(80);});
}).then(()=>finish(0),e=>{console.error(e);finish(1);});
function finish(code){clearTimeout(watchdog);win?.destroy();try{fs.rmSync(profile,{recursive:true,force:true});}catch{}app.exit(code);}
