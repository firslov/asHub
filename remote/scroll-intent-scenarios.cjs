// Shared Chromium/WebKit scenarios. Synthetic SSE only, no account/model traffic.
const assert = require('node:assert/strict');
module.exports = async function checkScrollIntent(run, resize) {
 const wait = ms => new Promise(r=>setTimeout(r,ms));
 const position = () => run(`(()=>{const m=$('messages');return {top:m.scrollTop,gap:m.scrollHeight-m.clientHeight-m.scrollTop,following:followingBottom};})()`);
 await run(`window.EventSource=class{constructor(){this.handlers={}}addEventListener(n,f){this.handlers[n]=f}close(){}};
 window.fetch=async()=>({ok:true,json:async()=>[]});$('auth').hidden=true;$('workspace').hidden=false;
 user='scroll-test';device='desktop';devices=[{id:device,online:true}];sessions=[{instanceId:'same',title:'Same session'}];
 window.emitTest=(name,payload={})=>source.onmessage({data:JSON.stringify({meta:{name},payload})});
 window.readUp=()=>{const m=$('messages');m.dispatchEvent(new WheelEvent('wheel',{deltaY:-500,bubbles:true}));m.scrollTop=100;};void 0;`);
 for (const [width,height] of [[390,844],[320,568],[844,390]]) {
  await resize(width,height);
  for(let pass=0;pass<5;pass++) {
   await run(`openSession('same')`);
   await run(`source.handlers.reset()`);
   for(let batch=0;batch<4;batch++) {
    await run(`for(let i=0;i<8;i++){emitTest('agent:query',{query:'Question '+i});emitTest('agent:response-segment',{text:'Long reply content '.repeat(100)});emitTest('agent:processing-done');}`);
    await wait(20+pass*7);
    // Emulate deferred browser scroll restoration/anchoring with unchanged
    // dimensions, without any wheel, touch, keyboard or navigation intent.
    await run(`$('messages').scrollTop=100`);await wait(30);
   }
   await run(`emitTest('hub:replay-done')`);await wait(150);
   const done=await position();assert(done.gap<=2,`same-session replay ${width} pass ${pass}: ${JSON.stringify(done)}`);
   // A deferred position update can also land after replay-done.
   await run(`$('messages').scrollTop=120`);await wait(100);
   assert((await position()).gap<=2,'non-user scroll must not cancel following after replay');
   await run(`readUp()`);await wait(50);const reading=await position();
   await run(`emitTest('agent:query',{query:'live'});emitTest('agent:response-segment',{text:'Live result '.repeat(100)});emitTest('agent:processing-done')`);await wait(150);
   assert(Math.abs((await position()).top-reading.top)<=2,'real reading intent survives new output');
   // Once the user scrolls back to the bottom, following resumes.
   await run(`$('messages').dispatchEvent(new WheelEvent('wheel',{deltaY:500,bubbles:true}));$('messages').scrollTop=$('messages').scrollHeight`);await wait(60);
   await run(`emitTest('agent:query',{query:'follow again'});emitTest('agent:response-segment',{text:'Latest result '.repeat(100)});emitTest('agent:processing-done')`);await wait(150);
   assert((await position()).gap<=2,'scrolling down resumes following');
  }
  await run(`document.querySelectorAll('.conversation-nav-tick')[2].click()`);await wait(80);
  const nav=await position();assert(nav.gap>140,'message tick navigates into history');
  await run(`emitTest('agent:usage',{total_tokens:500})`);await wait(80);
  assert(Math.abs((await position()).top-nav.top)<=2,'navigation intent survives render');
  // A one-finger drag during a slow replay takes precedence over replay-done.
  await run(`openSession('same')`);await run(`source.handlers.reset();for(let i=0;i<8;i++){emitTest('agent:query',{query:'Slow '+i});emitTest('agent:response-segment',{text:'History '.repeat(200)});emitTest('agent:processing-done');}`);await wait(100);
  await run(`(()=>{const m=$('messages'),e=new Event('touchmove',{bubbles:true});Object.defineProperty(e,'touches',{value:[{clientY:150}]});m.dispatchEvent(e);m.scrollTop=100;})()`);await wait(60);
  const touch=await position();
  await run(`emitTest('agent:query',{query:'Last replay message'});emitTest('agent:response-segment',{text:'Tail '.repeat(200)});emitTest('agent:processing-done');emitTest('hub:replay-done')`);await wait(150);
  assert(Math.abs((await position()).top-touch.top)<=2,'replay completion must not override a touch drag');
  // Reconnection is a fresh replay and must clear the previous reading intent.
  await run(`connectStream();source.handlers.reset();emitTest('agent:query',{query:'Reconnected'});emitTest('agent:response-segment',{text:'Restored '.repeat(800)});emitTest('agent:processing-done');emitTest('hub:replay-done')`);await wait(150);
  assert((await position()).gap<=2,'reconnection must anchor its fresh replay');
  // Emulate iOS deferring the first few programmatic writes during momentum.
  await run(`readUp()`);await wait(60);
  await run(`(()=>{const m=$('messages');let proto=m,descriptor;while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'scrollTop');proto=Object.getPrototypeOf(proto);}window.scrollWrites=0;Object.defineProperty(m,'scrollTop',{configurable:true,get(){return descriptor.get.call(this)},set(value){if(++window.scrollWrites>3)descriptor.set.call(this,value)}});scroll(true);})()`);await wait(200);
  assert((await position()).gap<=2,'deferred scrollTop writes must be retried until positioned');
  assert(await run(`window.scrollWrites>=4`),'retry scenario must exercise deferred writes');
  await run(`delete $('messages').scrollTop`);
  console.log(`PASS ${width}x${height}: 5 repeated replays, deferred scroll, wheel/touch/navigation, reconnect and deferred writes`);
 }
};
