import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import { DesktopService } from '../dist/service.js';import { registerDesktopBridge } from '../dist/bridge.js';
const reply=v=>({content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v});
function fixture(t,approve=()=>({decision:{outcome:'approved'}})){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-bridge-')),file=path.join(home,'settings.json');fs.writeFileSync(file,JSON.stringify({'desktop-control':{enabled:true,allowedApps:['com.test.App']}}));const calls=[];
 const service=new DesktopService(file,{platform:'darwin',factory:()=>({call:async(name,a)=>{calls.push(name);if(name==='apps')return reply({apps:[{pid:1,bundle_id:'com.test.App'}]});if(name==='windows')return reply({windows:[{window_id:2,title:'First bridge window',bounds:{x:0,y:0,width:200,height:100}},{window_id:3,title:'Second bridge window'}]});if(name==='status')return reply({permissions:{accessibility:true},background_input:true});if(name==='observe')return reply({snapshot:'s1',window_id:2});if(name==='screenshot')return {...reply({screenshot:{window_id:2,width:200,height:100,scale:1}}),content:[{type:'image',mimeType:'image/png',data:'AA=='}]};if(name==='click_at')return reply({status:'done',fresh:{snapshot:'s2',window_id:2}});return reply({});},close:async()=>{}})});
 const handlers=new Map(),disposers=[],events=new Map();const ctx={advise:(n,f)=>handlers.set(n,f),onDispose:f=>disposers.push(f),bus:{on:(n,f)=>events.set(n,f),emitPipeAsync:async(_e,p)=>approve(p)}};
 registerDesktopBridge(ctx,service);const bridge=handlers.get('desktop-control:bridge:v1')(()=>{});const life=new AbortController(),client=bridge.connect({bundleId:'com.test.App',lifetime:life.signal});
 t.after(async()=>{for(const f of disposers)f();await client.close();await service.close();fs.rmSync(home,{recursive:true,force:true});});
 return {service,bridge,client,life,calls,events};
}
const options=()=>({windowId:2,goal:'Test',signal:new AbortController().signal});
test('bridge shares the existing desktop task queue and releases ownership',async t=>{const f=fixture(t);const owner=Symbol();await f.service.acquire(owner,'com.test.App',2);let entered=false;const work=f.client.withWindow(options(),async p=>{entered=true;return p.windowId;});await new Promise(r=>setImmediate(r));assert(!entered);await f.service.finish(owner);assert.equal(await work,2);assert.equal((await f.service.status()).busy,false);});
test('bridge requires permission and denies unknown windows',async t=>{const f=fixture(t,()=>({decision:{outcome:'denied'}}));await assert.rejects(f.client.withWindow(options(),async()=>{}),/approved/);assert(!f.calls.includes('observe'));await assert.rejects(f.client.withWindow({...options(),windowId:99},async()=>{}),/existing/);});
test('bridge approval identifies the selected window before invoking the consumer',async t=>{
 let approval;
 const f=fixture(t,payload=>{
  approval=payload;
  return {decision:{outcome:'denied'}};
 });
 await assert.rejects(
  f.client.withWindow({...options(),windowId:3},async()=>assert.fail('Consumer ran before approval')),
  /not approved/,
 );
 assert.equal(approval.metadata.windowId,3);
 assert.equal(approval.description.split('\n')[0],'Window 3 · Second bridge window');
 assert(!f.calls.includes('observe'));
 assert(!f.calls.includes('screenshot'));
});
test('capture references are single use and port expires after operation',async t=>{const f=fixture(t);let port;await f.client.withWindow(options(),async p=>{port=p;const image=await p.capture();await p.input({frameRef:image.frameRef,operation:'click',x:10,y:10});await assert.rejects(p.input({frameRef:image.frameRef,operation:'click',x:10,y:10}),/fresh/);});await assert.rejects(port.capture());});
test('closing consumer cancels pending permission without affecting another owner',async t=>{let entered,reply;const ready=new Promise(r=>entered=r);const f=fixture(t,()=>{entered();return new Promise(r=>reply=r);});const other=Symbol();await f.service.acquire(other,'com.test.App',2);const pending=f.client.withWindow(options(),async()=>{});const rejected=assert.rejects(pending,/cancelled/);await ready;await f.client.close();await rejected;reply({decision:{outcome:'approved'}});assert.equal((await f.service.status()).busy,true);await f.service.finish(other);});
test('config revoke cancels an active public operation and its later input',async t=>{const f=fixture(t);await f.client.withWindow(options(),async p=>{const frame=await p.capture();await f.service.stop();await assert.rejects(p.input({frameRef:frame.frameRef,operation:'click',x:1,y:1}));}).then(()=>assert.fail('should cancel'),()=>{});assert(!f.calls.includes('click_at'));});


test('bridge reuses initial and settled observations but captures a new image each time',async t=>{
 const f=fixture(t);
 await f.client.withWindow(options(),async p=>{
  const a=await p.capture();assert.equal(f.calls.filter(c=>c==='observe').length,1);
  await p.input({frameRef:a.frameRef,operation:'click',x:10,y:10});
  const b=await p.capture();assert.notEqual(a.frameRef,b.frameRef);assert.equal(f.calls.filter(c=>c==='observe').length,1);
  await p.capture();assert.equal(f.calls.filter(c=>c==='observe').length,2);
  assert.equal(f.calls.filter(c=>c==='screenshot').length,3);assert.equal(p.timings.reusedObservations,2);
 });
});
test('an expired observation is refreshed and cannot skip a target validation',async t=>{
 const f=fixture(t);await f.client.withWindow(options(),async p=>{
  await new Promise(r=>setTimeout(r,280));await p.capture();
  assert.equal(f.calls.filter(c=>c==='observe').length,2);assert.equal(p.timings.reusedObservations,0);
 });
});
test('cancelled task cannot use the cached acquisition observation',async t=>{
 const f=fixture(t);await assert.rejects(f.client.withWindow(options(),async p=>{f.client.interrupt();await p.capture();}));
 assert(!f.calls.includes('screenshot'));
});

test('compound-operation cancellation survives released leases and resets only for a new operation',async t=>{
 const f=fixture(t),signal=f.bridge.cancellationSignal;
 await f.client.withWindow({...options(),signal},async p=>{await p.capture();});
 assert.equal(signal.aborted,false);
 await f.service.stop();assert.equal(signal.aborted,true);
 await assert.rejects(f.client.withWindow({...options(),signal},async()=>assert.fail('must not resume')));
 const fresh=f.bridge.cancellationSignal;assert.equal(fresh.aborted,false);
 assert.equal(await f.client.withWindow({...options(),signal:fresh},async()=>42),42);
});
