const test=require('node:test');
const assert=require('node:assert/strict');
const {env}=require('./harness.cjs');
const {El}=require('./ui-harness.cjs');
function fixture(fetch=async()=>new Response('unchanged')) {
 const e=env({globals:{fetch,Request,Headers,Response,TextDecoder,TransformStream,ReadableStream}});
 return {e,mod:e.load('src/providers/codex-usage.ts')};
}
const frame=usage=>'data: '+JSON.stringify({type:'response.completed',response:{usage}})+'\r\n\r\n';
test('raw Codex diagnostics keep only valid numeric counters and preserve missing versus zero',()=>{
 const {mod}=fixture();
 const clean=mod.usageCounters({input_tokens:10,input_tokens_details:{cached_tokens:0,cache_write_tokens:10,secret:'hidden'},output_tokens:NaN,total_tokens:-1,credential:'hidden'});
 assert.equal(JSON.stringify(clean),'{"input_tokens":10,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":10}}');
 assert.equal(mod.usageCounters({}).input_tokens_details,undefined);
 assert.equal(mod.usageCounters({input_tokens_details:{cached_tokens:null}}).input_tokens_details,undefined);
});
test('usage observer handles fragmented UTF-8 and CRLF, malformed frames and final data without a separator',()=>{
 const {mod}=fixture(),seen=[];const consume=mod.usageObserver(u=>seen.push(u));
 const bytes=new TextEncoder().encode('data: {bad}\r\n\r\n'+frame({input_tokens:10,input_tokens_details:{cached_tokens:0},text:'秘密😀'})+frame({input_tokens:20}).trimEnd());
 for(const byte of bytes)consume(Uint8Array.of(byte));consume();
 assert.equal(seen.length,2);assert.equal(seen[0].input_tokens_details.cached_tokens,0);
 assert.equal(seen[1].input_tokens,20);assert.equal(seen[1].input_tokens_details,undefined);
 assert(!JSON.stringify(seen).includes('秘密'));
});
test('transport observation preserves response bytes, isolates sessions and unregisters cleanly',async()=>{
 const wire=frame({input_tokens:10,input_tokens_details:{cached_tokens:5}});
 const original=async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}});
 const {e,mod}=fixture(original),a=[],b=[];
 const closeA=mod.observeCodexUsage('https://codex.test/responses','a',u=>a.push(u));
 const closeB=mod.observeCodexUsage('https://codex.test/responses','b',u=>b.push(u));
 try {
  for(const [url,id] of [['https://codex.test/responses','a'],['https://other.test/responses','a'],['https://codex.test/responses','unknown']]) {
   const res=await e.context.fetch(url,{headers:{session_id:id}});assert.equal(await res.text(),wire);
  }
  assert.equal(a.length,1);assert.equal(b.length,0);
  // A completion already in flight cannot report to a closed session.
  const late=await e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'}});
  closeA();await late.text();assert.equal(a.length,1);
  const res=await e.context.fetch(new Request('https://codex.test/responses',{headers:{session_id:'b'}}));
  await res.text();assert.equal(b.length,1);
 } finally {closeA();closeB();}
 assert.equal(e.context.fetch,original);
});
test('duplicate terminal events without usage do not overwrite counters; oversized diagnostics are bounded',()=>{
 const {mod}=fixture(),seen=[];const consume=mod.usageObserver(u=>seen.push(u));
 consume(new TextEncoder().encode(frame({input_tokens:10,input_tokens_details:{cached_tokens:5}})
   +'data: {"type":"response.done","response":{}}\n\n'));consume();
 assert.equal(seen.length,1);assert.equal(seen[0].input_tokens_details.cached_tokens,5);
 const large=mod.usageObserver(()=>assert.fail('oversized event should not be retained'));
 large(new Uint8Array(4*1024*1024+1));large();
});

test('large batches and oversized individual events do not hide later completion or usage',async()=>{
 const encoder=new TextEncoder(),limit=4*1024*1024;
 const small='data: '+JSON.stringify({type:'response.output_text.delta',delta:'x'.repeat(1000)})+'\r\n\r\n';
 const large='data: '+JSON.stringify({type:'response.output_text.done',text:'x'.repeat(limit)})+'\r\n\r\n';
 for(const prefix of [small.repeat(4200),large])for(const fragmented of [false,true]){
  const wire=prefix+frame({input_tokens:10}),events=[],usage=[];
  const bytes=encoder.encode(wire);
  const upstream=new ReadableStream({start(c){
   if(fragmented){
    // Split the oversized event's CRLF boundary across reads as well.
    c.enqueue(bytes.subarray(0,prefix.length-3));
    for(let i=prefix.length-3;i<prefix.length;i++)c.enqueue(bytes.subarray(i,i+1));
    c.enqueue(bytes.subarray(prefix.length));
   }else c.enqueue(bytes);
   c.close();
  }});
  const {e,mod}=fixture(async()=>new Response(upstream));
  const close=mod.observeCodexUsage('https://codex.test/responses','a',u=>usage.push(u),ev=>events.push(ev));
  try{
   const response=await e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'}});
   assert.equal(await response.text(),wire,'the observer must preserve every response byte');
   assert.equal(events.at(-1).phase,'complete');assert.equal(usage[0]?.input_tokens,10);
  }finally{close();}
 }
});

test('an oversized terminal reports limited observation instead of inventing a stream failure or cancellation',async()=>{
 const wire='data: '+JSON.stringify({type:'response.completed',response:{output:'x'.repeat(4*1024*1024),usage:{input_tokens:10}}})+'\n\n';
 for(const exit of ['eof','cancel','abort','timeout','error']){
  const events=[],usage=[],abort=new AbortController();let upstream;
  const {e,mod}=fixture(async()=>new Response(new ReadableStream({start(c){upstream=c;c.enqueue(new TextEncoder().encode(wire));}})));
  const close=mod.observeCodexUsage('https://codex.test/responses','a',u=>usage.push(u),ev=>events.push(ev));
  try{
   const reader=(await e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'},signal:abort.signal})).body.getReader();
   assert.equal(Buffer.from((await reader.read()).value).toString(),wire);
   if(exit==='eof'){upstream.close();assert((await reader.read()).done);}
   else if(exit==='error'){upstream.error(Object.assign(new Error('reset'),{code:'ECONNRESET'}));await assert.rejects(reader.read());}
   else{
    if(exit==='abort')abort.abort();
    if(exit==='timeout')abort.abort(new Error('Codex upstream timed out waiting for stream data after 1800s'));
    await reader.cancel();
   }
   const outcome=events.at(-1);
   assert.equal(usage.length,0,'oversized JSON must stay bounded');
   assert.equal(outcome.phase,exit==='abort'?'cancelled':['timeout','error'].includes(exit)?'error':'unobserved',exit);
   if(exit==='timeout')assert.equal(outcome.code,'UPSTREAM_IDLE_TIMEOUT');
   else if(exit==='error')assert.equal(outcome.code,'ECONNRESET');
   else if(exit!=='abort')assert.equal(outcome.code,'OBSERVATION_LIMIT');
  }finally{close();}
 }
});
test('cancelling an observed response cancels upstream consumption',async()=>{
 let cancelled=false;
 const {e,mod}=fixture(async()=>new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}}));
 const close=mod.observeCodexUsage('https://codex.test/responses','a',()=>{});
 try {
  const res=await e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'}});
  await res.body.cancel();assert.equal(cancelled,true);
 } finally {close();}
});
test('usage display distinguishes unreported, zero and positive cache counts',()=>{
 const e=env({modules:{'../utils.js':{fmtNum:String},'./tool-group.js':{},'../i18n.js':{t:k=>k}}});
 const {renderUsage}=e.load('web/js/stream/renderers.js');
 const session={usageEl:new El(),state:{contextWindow:100,lastUsage:{prompt_tokens:10,prompt_cache_hit_tokens:5,prompt_cache_miss_tokens:5}}};
 renderUsage(session);assert(session.usageEl.innerHTML.includes('50.0%'));
 session.state.lastUsage={prompt_tokens:10,cache_reported:false};renderUsage(session);
 assert(session.usageEl.innerHTML.includes('usage.cache.unknown'));assert(!session.usageEl.innerHTML.includes('0.0%'));
 session.state.lastUsage={prompt_tokens:10,cache_reported:true,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:10};renderUsage(session);
 assert(session.usageEl.innerHTML.includes('0.0%'));assert(!session.usageEl.innerHTML.includes('usage.cache.unknown'));
});

test('request diagnostics measure UTF-8 JSON bytes and phases without inspecting content',async()=>{
 const wire=frame({input_tokens:5}),events=[];
 const {e,mod}=fixture(async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}}));
 const close=mod.observeCodexUsage('https://codex.test/responses','a',()=>{},ev=>events.push(ev));
 try {
  const body=JSON.stringify({input:'私密😀'});
  const res=await e.context.fetch('https://codex.test/responses',{headers:{session_id:'a',authorization:'SECRET'},body,method:'POST'});
  assert.equal(await res.text(),wire);
  assert.deepEqual(events.map(e=>e.phase),['request','headers','streaming','complete']);
  assert.equal(events[0].requestBytes,Buffer.byteLength(body));
  assert.equal(events.at(-1).responseBytes,Buffer.byteLength(wire));
  assert(!JSON.stringify(events).includes('私密'));assert(!JSON.stringify(events).includes('SECRET'));
 }finally{close();}
});

test('diagnostic callback failures cannot affect usage, stream output or other sessions',async()=>{
 const seen=[],wire=frame({input_tokens:5});
 const {e,mod}=fixture(async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}}));
 const a=mod.observeCodexUsage('https://codex.test/responses','a',()=>{throw Error('observer');},()=>{throw Error('observer');});
 const b=mod.observeCodexUsage('https://codex.test/responses','b',u=>seen.push(u),()=>assert.fail('wrong session'));
 try {assert.equal(await(await e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'}})).text(),wire);assert.equal(seen.length,0);}
 finally{a();b();}
});

test('fetch rejection and non-200 responses remain errors with sanitized diagnostic codes',async()=>{
 const original=Object.assign(new Error('net::ERR_HTTP2_PROTOCOL_ERROR PRIVATE'),{code:'UNKNOWN'}),events=[];
 let fail=true;
 const {e,mod}=fixture(async()=>{if(fail)throw original;return new Response('PRIVATE',{status:504});});
 const close=mod.observeCodexUsage('https://codex.test/responses','a',()=>{},e=>events.push(e));
 try {
  await assert.rejects(e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'}}),e=>e===original);
  assert.equal(events.at(-1).code,'ERR_HTTP2_PROTOCOL_ERROR');fail=false;
  const res=await e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'}});
  assert.equal(res.status,504);assert.equal(await res.text(),'PRIVATE');assert.equal(events.at(-1).status,504);
  assert(!JSON.stringify(events).includes('PRIVATE'));
 }finally{close();}
});

test('EOF, mid-stream errors and cancellation retain transport behavior and correct outcome',async()=>{
 for(const mode of ['eof','error','cancel','terminal']){
  const events=[];let cancelled=false,controller;
  const upstream=new ReadableStream({start(c){controller=c;},cancel(){cancelled=true;}});
  const {e,mod}=fixture(async()=>new Response(upstream,{headers:{'content-type':'text/event-stream'}}));
  const close=mod.observeCodexUsage('https://codex.test/responses','a',()=>{},e=>events.push(e));
  try{
   const res=await e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'}});
   const reader=res.body.getReader();
   if(mode==='cancel'){await reader.cancel();assert(cancelled);assert.equal(events.at(-1).phase,'cancelled');}
   else if(mode==='error'){const error=new Error('socket PRIVATE');controller.error(error);await assert.rejects(reader.read(),e=>e===error);assert.equal(events.at(-1).phase,'error');}
   else if(mode==='eof'){controller.close();assert((await reader.read()).done);assert.equal(events.at(-1).code,'STREAM_ENDED');}
   else{controller.enqueue(new TextEncoder().encode(frame({})));await reader.read();await reader.cancel();assert(cancelled);assert.equal(events.at(-1).phase,'complete');}
  }finally{close();}
 }
});

test('abort before response headers remains cancellation and unregister stops late diagnostics',async()=>{
 const controller=new AbortController(),events=[];let release;
 const {e,mod}=fixture(()=>new Promise((resolve,reject)=>{release=()=>reject(controller.signal.reason);}));
 const close=mod.observeCodexUsage('https://codex.test/responses','a',()=>{},e=>events.push(e));
 const pending=e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'},signal:controller.signal});
 controller.abort();release();await assert.rejects(pending);assert.equal(events.at(-1).phase,'cancelled');
 close();assert.equal(events.length,2);
});

test('a DONE marker, empty body or HTTP 200 error page cannot masquerade as Codex completion',async()=>{
 for(const [wire,headers,status] of [
  ['data: [DONE]\n\n',{'content-type':'text/event-stream'},200],
  ['<html>gateway error</html>',{'content-type':'text/html'},200],
  [null,{},204],
 ]){
  const events=[];
  const {e,mod}=fixture(async()=>new Response(wire,{headers,status}));
  const close=mod.observeCodexUsage('https://codex.test/responses','a',()=>{},ev=>events.push(ev));
  try{
   const response=await e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'}});
   assert.equal(await response.text(),wire??'');
   assert.equal(events.at(-1).phase,'error');
   assert.equal(events.at(-1).code,'STREAM_ENDED');
   assert(!events.some(ev=>ev.phase==='complete'));
  }finally{close();}
 }
});

test('Codex completion is recognized from the stream even if a gateway changes its content type',async()=>{
 const wire=frame({input_tokens:5})+'data: [DONE]\n\n',events=[];
 const {e,mod}=fixture(async()=>new Response(wire,{headers:{'content-type':'text/plain'}}));
 const usage=[];
 const close=mod.observeCodexUsage('https://codex.test/responses','a',u=>usage.push(u),ev=>events.push(ev));
 try{
  const response=await e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'}});
  assert.equal(events.at(-1).phase,'headers','must wait for a terminal event before reporting success');
  assert.equal(await response.text(),wire);
  assert.equal(events.at(-1).phase,'complete');assert.equal(usage[0].input_tokens,5);
 }finally{close();}
});

test('header and idle deadlines are errors, distinct from user cancellation at every transport exit',async()=>{
 for(const [reason,code] of [
  [new Error('Codex upstream timed out waiting for response headers after 600s'),'UPSTREAM_HEADERS_TIMEOUT'],
  [new Error('Codex upstream timed out waiting for stream data after 1800s'),'UPSTREAM_IDLE_TIMEOUT'],
  [new DOMException('The operation timed out','TimeoutError'),'REQUEST_TIMEOUT'],
 ])for(const exit of ['fetch','read','eof','cancel']){
  const events=[],abort=new AbortController();let controller;
  const upstream=new ReadableStream({start(c){controller=c;}});
  const {e,mod}=fixture(async()=>{
   if(exit==='fetch'){abort.abort(reason);throw new DOMException('aborted','AbortError');}
   return new Response(upstream,{headers:{'content-type':'text/event-stream'}});
  });
  const close=mod.observeCodexUsage('https://codex.test/responses','a',()=>{},ev=>events.push(ev));
  try{
   const response=e.context.fetch('https://codex.test/responses',{headers:{session_id:'a'},signal:abort.signal});
   if(exit==='fetch')await assert.rejects(response);
   else{
    const reader=(await response).body.getReader();abort.abort(reason);
    if(exit==='cancel')await reader.cancel();
    else if(exit==='eof'){controller.close();assert((await reader.read()).done);}
    else {controller.error(new DOMException('aborted','AbortError'));await assert.rejects(reader.read());}
   }
   assert.equal(events.at(-1).phase,'error',exit);
   assert.equal(events.at(-1).code,code,exit);
  }finally{close();}
 }
});
