const test=require('node:test');
const assert=require('node:assert/strict');
const {env}=require('./harness.cjs');
const {El}=require('./ui-harness.cjs');
function fixture(fetch=async()=>new Response('unchanged')) {
 const e=env({globals:{fetch,Request,Headers,Response,TextDecoder,TransformStream}});
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
