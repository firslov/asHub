import test from 'node:test';import assert from 'node:assert/strict';
import activate,{validateConfig,transcribe} from '../app.mjs';
const config={endpoint:'https://example.test/v1/audio/transcriptions',model:'gpt-transcribe',apiKey:'fixture-secret'};
test('provider sends file with MIME/extension, no chat history, no retry; accepts mixed text',async()=>{
 for(const mime of ['audio/mp4','audio/mp4; codecs=mp4a.40.2','audio/webm;codecs=opus']){
  const result=await transcribe(config,{data:new Uint8Array([1,2,3]),mimeType:mime,signal:new AbortController().signal},async(url,opts)=>{
   assert.equal(url,config.endpoint);assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer fixture-secret');
   assert.deepEqual([...opts.body.keys()],['model','file']);const file=opts.body.get('file');assert.match(file.name,mime.includes('mp4')?/\.mp4$/:/\.webm$/);assert.equal(file.type,mime);
   return new Response(JSON.stringify({text:'中文 API test'}));
  });assert.equal(result,'中文 API test');
 }
 let calls=0;await assert.rejects(transcribe(config,{data:new Uint8Array([1]),mimeType:'audio/mp4',signal:new AbortController().signal},async()=>{calls++;return new Response('secret not exposed',{status:401});}),/认证失败/);assert.equal(calls,1);
});
test('credentials cannot silently follow endpoint changes and plaintext storage is never used',async()=>{
 assert.throws(()=>validateConfig({...config,endpoint:'http://example.test'}),/HTTPS/);
 assert.throws(()=>validateConfig({endpoint:'https://other.test',model:'test'},config),/重新填写/);
 assert.equal(validateConfig({endpoint:config.endpoint,model:'test'},config).apiKey,'fixture-secret');
 let saved=null,resource,registrations=[],disposals=0;const ctx={signal:new AbortController().signal,services:{
  secrets:{available:true,read:()=>saved,write:(_,v)=>saved=v},interactions:{register:(_,r)=>resource=r},composerInputs:{register:(_,input)=>{registrations.push(input);return()=>disposals++;}}
 }};const instance=activate(ctx);assert.equal(registrations.length,0);
 const plan=await resource.prepare('save',config);assert(plan.preview);assert.equal(saved,null);await plan.execute();assert.equal(registrations.length,1);
 assert(!JSON.stringify(resource.view()).includes('fixture-secret'));assert(!JSON.stringify(plan.preview).includes('fixture-secret'));
 const clear=await resource.prepare('clear',{});await clear.execute();assert.equal(saved,null);assert.equal(disposals,1);
 instance.stop();
 ctx.services.secrets.available=false;await assert.rejects(resource.prepare('save',config),/加密存储/);
});
test('restart restores configuration; late transcriptions observe aborted signal',async()=>{
 let registered;activate({signal:new AbortController().signal,services:{secrets:{read:()=>JSON.stringify(config)},interactions:{register(){}},composerInputs:{register:(_,r)=>{registered=r;return()=>{};}}}});assert(registered);
 const controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(transcribe(config,{data:new Uint8Array(),mimeType:'audio/mp4',signal:controller.signal},async()=>{calls++;}));assert.equal(calls,0);
});

const hunyuan={endpoint:'https://tokenhub.tencentmaas.com/v1/wand/asrproxy/sync_transcribe',model:'hy-asr-3.0-preview',apiKey:'fixture-tokenhub-key'};
const audio=signal=>({data:new Uint8Array([0,1,255,2]),mimeType:'audio/mp4; codecs=mp4a.40.2',signal:signal||new AbortController().signal});
test('TokenHub sends original audio as JSON/Base64 and reads completed output.text',async()=>{
 for(const mimeType of ['audio/wav','audio/mp4; codecs=mp4a.40.2','audio/mp4;codecs=opus','audio/webm;codecs=opus','audio/ogg;codecs=opus']) {
  // A view into a larger buffer must not leak adjacent bytes.
  const input={...audio(),mimeType,data:new Uint8Array([99,0,1,255,2,99]).subarray(1,5)};
  const text=await transcribe(hunyuan,input,async(url,opts)=>{
   assert.equal(url,hunyuan.endpoint);assert.equal(opts.method,'POST');assert.equal(opts.redirect,'error');assert.equal(opts.signal,input.signal);
   assert.deepEqual(opts.headers,{'Content-Type':'application/json',Authorization:'Bearer fixture-tokenhub-key'});
   assert.deepEqual(JSON.parse(opts.body),{model:'hy-asr-3.0-preview',data:'AAH/Ag=='});
   return Response.json({status:'completed',output:{text:'  中文与 English 混合  ',sentences:[],subtitle_url:'https://unused.invalid/subtitle'}});
  });assert.equal(text,'中文与 English 混合');
 }
});
test('TokenHub config is inferred from the exact endpoint, with safe legacy restore and credentials',async()=>{
 assert.deepEqual(validateConfig(hunyuan),hunyuan);
 assert.equal(validateConfig({endpoint:hunyuan.endpoint,apiKey:hunyuan.apiKey}).model,hunyuan.model);
 assert.equal(validateConfig({...hunyuan,endpoint:hunyuan.endpoint+'/'}).model,hunyuan.model);
 assert.throws(()=>validateConfig({...hunyuan,endpoint:'https://tokenhub.tencentmaas.com/v1'}),/完整同步转写地址/);
 assert.throws(()=>validateConfig({...hunyuan,model:'wrong-model'}),/hy-asr-3.0-preview/);
 assert.throws(()=>validateConfig({endpoint:hunyuan.endpoint,model:hunyuan.model},config),/重新填写/);
 assert.throws(()=>validateConfig({endpoint:config.endpoint,model:config.model},hunyuan),/重新填写/);
 // The model name alone never changes the wire protocol for another provider.
 await transcribe({...config,model:hunyuan.model},audio(),async(_,opts)=>{assert(opts.body instanceof FormData);return Response.json({text:'compatible provider'});});
 let registered,resource;const saved=JSON.stringify(hunyuan);
 activate({signal:new AbortController().signal,services:{secrets:{read:()=>saved},interactions:{register:(_,r)=>resource=r},composerInputs:{register:(_,r)=>{registered=r;return()=>{};}}}});
 assert(registered);assert(!JSON.stringify(resource.view()).includes(hunyuan.apiKey));assert.match(resource.view().note,/TokenHub API Key/);
});
test('TokenHub failures do not leak response bodies, retry, or accept partial/wrong output',async()=>{
 for(const status of [401,403,429,500]) {
  let calls=0;await assert.rejects(transcribe(hunyuan,audio(),async()=>{calls++;return new Response('private server detail '+hunyuan.apiKey,{status});}),e=>!e.message.includes(hunyuan.apiKey)&&(status===401||status===403?/TokenHub API Key/.test(e.message):e.message.includes(String(status))));assert.equal(calls,1);
 }
 for(const body of [null,{status:'failed',output:{text:'partial'}},{status:'processing',output:{text:'partial'}},{text:'wrong protocol'},{status:'completed'},{status:'completed',output:{text:123}},{status:'completed',output:{text:'a'.repeat(20001)}}]) {
  await assert.rejects(transcribe(hunyuan,audio(),async()=>Response.json(body)),/未返回已完成|文本无效/);
 }
 await assert.rejects(transcribe(hunyuan,audio(),async()=>new Response('{')),/格式无效/);
 await assert.rejects(transcribe(hunyuan,audio(),async()=>new Response('a'.repeat(128001))),/过大/);
 assert.equal(await transcribe(hunyuan,audio(),async()=>Response.json({status:'completed',output:{text:'   '}})),'');
});
test('TokenHub cancellation suppresses late success and aborts response streaming',async()=>{
 const controller=new AbortController();let resolve,started;
 const ready=new Promise(r=>started=r);
 const pending=transcribe(hunyuan,audio(controller.signal),async()=>{started();return new Promise(r=>resolve=r);});
 await ready;controller.abort();resolve(Response.json({status:'completed',output:{text:'late'}}));await assert.rejects(pending,{name:'AbortError'});
 const reading=new AbortController();let cancelled=false;
 const stream=new ReadableStream({pull(c){reading.abort();c.enqueue(new TextEncoder().encode('{}'));},cancel(){cancelled=true;}},{highWaterMark:0});
 await assert.rejects(transcribe(hunyuan,audio(reading.signal),async()=>new Response(stream)),{name:'AbortError'});assert(cancelled);
});

function configuredSettings() {
 let saved=JSON.stringify(hunyuan),resource,disposals=0,registrations=0,failWrites=false;
 const lifecycle=new AbortController();
 activate({signal:lifecycle.signal,services:{
  secrets:{available:true,read:()=>saved,write:(_,v)=>{if(failWrites)throw Error('fixture storage failure');saved=v;}},
  interactions:{register:(_,r)=>resource=r},
  composerInputs:{register:()=>{registrations++;return()=>disposals++;}},
 }});
 return {resource,lifecycle,set failWrites(value){failWrites=value;},get saved(){return saved;},get registrations(){return registrations;},get disposals(){return disposals;}};
}
test('a stale save confirmation cannot restore a cleared TokenHub credential',async()=>{
 const f=configuredSettings();
 const oldSave=await f.resource.prepare('save',{endpoint:hunyuan.endpoint,model:hunyuan.model});
 await (await f.resource.prepare('clear',{})).execute();
 assert.equal(f.saved,null);assert.equal(f.disposals,1);
 assert.throws(()=>oldSave.execute(),/配置已变更/);
 assert.equal(f.saved,null);assert.equal(f.registrations,1);
});
test('stale clear/save confirmations cannot cancel a newer recording configuration',async()=>{
 const f=configuredSettings(),oldClear=await f.resource.prepare('clear',{}),oldSave=await f.resource.prepare('save',hunyuan);
 const changed={...hunyuan,apiKey:'new-tokenhub-key'};
 await (await f.resource.prepare('save',changed)).execute();
 assert.throws(()=>oldClear.execute(),/配置已变更/);assert.throws(()=>oldSave.execute(),/配置已变更/);
 assert.deepEqual(JSON.parse(f.saved),changed);assert.equal(f.registrations,2);assert.equal(f.disposals,1);
 // A fresh confirmation still works; lifecycle shutdown cannot clear stored keys.
 const clear=await f.resource.prepare('clear',{});f.lifecycle.abort();assert.throws(()=>clear.execute(),{name:'AbortError'});assert.deepEqual(JSON.parse(f.saved),changed);
});

test('clear then save identical settings still invalidates previous-window confirmations',async()=>{
 const f=configuredSettings(),oldSave=await f.resource.prepare('save',hunyuan),oldClear=await f.resource.prepare('clear',{});
 await (await f.resource.prepare('clear',{})).execute();
 await assert.rejects(f.resource.prepare('save',{endpoint:hunyuan.endpoint,model:hunyuan.model}),/API Key/);
 await (await f.resource.prepare('save',hunyuan)).execute();
 assert.deepEqual(JSON.parse(f.saved),hunyuan);
 assert.throws(()=>oldSave.execute(),/配置已变更/);assert.throws(()=>oldClear.execute(),/配置已变更/);
 assert.equal(f.registrations,2);assert.equal(f.disposals,1);
 const retained=await f.resource.prepare('save',{endpoint:hunyuan.endpoint,model:hunyuan.model});await retained.execute();assert.deepEqual(JSON.parse(f.saved),hunyuan);
});
test('failed credential writes preserve live configuration and allow a fresh successful save',async()=>{
 const f=configuredSettings(),changed={...hunyuan,apiKey:'rotated-key'};
 f.failWrites=true;
 assert.throws((await f.resource.prepare('save',changed)).execute,/storage failure/);
 assert.throws((await f.resource.prepare('clear',{})).execute,/storage failure/);
 assert.deepEqual(JSON.parse(f.saved),hunyuan);assert.equal(f.registrations,1);assert.equal(f.disposals,0);
 f.failWrites=false;await (await f.resource.prepare('save',changed)).execute();
 assert.deepEqual(JSON.parse(f.saved),changed);assert.equal(f.registrations,2);assert.equal(f.disposals,1);
 let restored;activate({signal:new AbortController().signal,services:{secrets:{read:()=>f.saved},interactions:{register(){}},composerInputs:{register:(_,r)=>{restored=r;return()=>{};}}}});assert(restored);
 assert(!JSON.stringify(f.resource.view()).includes('rotated-key'));
});
