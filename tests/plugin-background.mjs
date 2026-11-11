import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginBackground } from '../dist/extensions/background.js';
import { SessionStore } from '../dist/history/session-store.js';
import { generateSummary } from '../dist/history/summary-client.js';
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'background-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new SessionStore(path.join(dir,'a.jsonl'),{create:{sessionId:'a',cwd:dir}});
  const targets=[{id:'a',cwd:dir,title:'A',provider:'mock',model:'tiny',busy:false,projectId:'p'},{id:'b',cwd:dir,title:'B',provider:'mock',model:'tiny',busy:false}];
  let calls=0;
  const runtime={targets:()=>structuredClone(targets),store:()=>store,complete:async()=>{calls++;return '{}';}};
  const shutdown=new AbortController(), session=new AbortController();
  const host=new PluginBackground(path.join(dir,'grants.json'),runtime,shutdown.signal), api=host.bind('plugin',session.signal);
  const approve=(extra={})=>host.approve('plugin',host.prepare('plugin',{modelSessionId:'a',dailyCalls:2,includeHistory:true,excludedIds:['b'],...extra}));
  return {dir,store,targets,runtime,host,api,approve,shutdown,session,calls:()=>calls};
}
test('background requires host approval, isolates plugins, persists quota and blocks revoked/model-changed grants',async t=>{
 const f=fixture(t); assert.throws(()=>f.api.targets('invented'));
 const plan=f.host.prepare('plugin',{modelSessionId:'a',dailyCalls:2,includeHistory:true,excludedIds:[]}); assert(plan.fields.some(x=>x.label==='成本上限'));
 assert.throws(()=>f.api.targets(plan.grant.id)); const id=f.host.approve('plugin',plan);
 assert.throws(()=>f.host.bind('other',f.session.signal).targets(id));
 await f.api.infer(id,[{role:'user',content:'test'}]);
 const restored=new PluginBackground(path.join(f.dir,'grants.json'),f.runtime,f.shutdown.signal).bind('plugin',f.session.signal);
 assert.equal(restored.status(id).calls,1);
 await restored.infer(id,[{role:'user',content:'test'}]); await assert.rejects(()=>restored.infer(id,[{role:'user',content:'test'}]),/额度/);
 f.targets[0].model='changed'; await assert.rejects(()=>restored.infer(id,[{role:'user',content:'test'}]),/配置/);
 restored.revoke(id); assert.throws(()=>restored.targets(id));
});
test('history cursor, generated provenance, exclusions and branch rewinds use durable source IDs',async t=>{
 const f=fixture(t), ids=await f.store.appendMessages([{role:'user',content:'真实用户要求'},{role:'user',content:'[Cross-conversation message / 来自其他对话的消息]\nnot human'},{role:'assistant',content:'答复'}]);
 const id=f.approve(), page=f.api.read(id,'a'); assert.deepEqual(page.entries.map(e=>e.role),['user','generated','assistant']);
 assert.equal(page.cursor,ids.at(-1)); assert.equal(f.api.read(id,'a',page.cursor).entries.length,0);
 assert.throws(()=>f.api.read(id,'b')); assert.deepEqual(f.api.valid(id,'a',[ids[1]]),[ids[1]]);
 f.store.setActiveLeaf(ids[0]); assert.deepEqual(f.api.valid(id,'a',[ids[1]]),[]); assert.equal(f.api.read(id,'a',page.cursor).reset,true);
 const fresh=f.approve({includeHistory:false}); assert.equal(f.api.read(fresh,'a').entries.length,0);
});
test('revocation and disposal abort running inference; cancelled calls count and oversized data never reaches provider',async t=>{
 const f=fixture(t), id=f.approve();
 await assert.rejects(()=>f.api.infer(id,[{role:'user',content:'x'.repeat(16001)}]),/limits/); assert.equal(f.calls(),0);
 f.runtime.complete=(_id,_messages,signal)=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));
 const pending=f.api.infer(id,[{role:'user',content:'test'}]); f.api.revoke(id); await assert.rejects(()=>pending,/cancelled/);
 const next=f.approve(), active=f.api.infer(next,[{role:'user',content:'test'}]); f.session.abort(); await assert.rejects(()=>active,/cancelled/);
});
test('corrupt grant storage fails closed without preventing the host service from being constructed',t=>{
 const f=fixture(t); fs.writeFileSync(path.join(f.dir,'bad.json'),'broken');
 const broken=new PluginBackground(path.join(f.dir,'bad.json'),f.runtime,f.shutdown.signal);
 assert.throws(()=>broken.bind('plugin',f.session.signal).targets('anything'));
 assert.equal(fs.readFileSync(path.join(f.dir,'bad.json'),'utf8'),'broken');
});
test('late stream arrival after abort is closed instead of leaking a background request',async()=>{
 const controller=new AbortController(); let resolve, closed=0;
 const client={stream:()=>new Promise(r=>resolve=r)};
 const pending=generateSummary(client,[{role:'user',content:'test'}],controller.signal,{maxTokens:4096});
 controller.abort(); await assert.rejects(()=>pending);
 resolve({controller:{abort(){closed++;}},async *[Symbol.asyncIterator](){throw Error('must not read after abort');}});
 await new Promise(r=>setImmediate(r)); assert.equal(closed,1);
});

test('bridge rechecks the approved model after async initialization and isolates request budgets',async()=>{
 const { AshBridge } = await import('../dist/bridges/ash.js');
 let model='tiny', request, streams=0;
 const client={async stream(options){request=options;streams++;return {controller:new AbortController(),async *[Symbol.asyncIterator](){yield {choices:[{delta:{content:'{}'},finish_reason:'stop'}]};}};}};
 const bridge={initPromise:Promise.resolve(),closed:false,backgroundControllers:new Set(),opts:{sessionId:'fixture'},
  syncCodex:async()=>{},assertCodexAvailable(){},core:{handlers:{call(name){if(name==='agent:get-model')return {model,provider:'mock'};if(name==='llm:get-client')return client;}}}};
 const call=()=>AshBridge.prototype.backgroundComplete.call(bridge,[{role:'user',content:'test'}],new AbortController().signal,{model:'tiny',provider:'mock'});
 assert.equal(await call(),'{}');assert.equal(request.max_tokens,4096);assert.equal(request.tools,undefined);assert.equal(bridge.backgroundControllers.size,0);
 bridge.syncCodex=async()=>{model='changed';};await assert.rejects(call,/provider changed/);assert.equal(streams,1);assert.equal(bridge.backgroundControllers.size,0);
 model='tiny';bridge.syncCodex=async()=>{for(const c of bridge.backgroundControllers)c.abort();};await assert.rejects(call);assert.equal(streams,1);
 await generateSummary(client,[{role:'user',content:'normal compaction'}],new AbortController().signal);assert.equal(request.max_tokens,8192);
});

import { AshBridge } from '../dist/bridges/ash.js';
import { createPolicyFetch, withNetworkSession } from '../dist/network-policy.js';
test('background inference uses its selected conversation proxy policy across async work', async () => {
  const send = createPolicyFetch(async () => new Response('proxy'), async () => new Response('direct'),
    () => ({ proxyEnabled: true, sessions: { aaaa: false, bbbb: true } }));
  class FixtureBridge extends AshBridge {
    async init() {}
    async syncCodex() { await new Promise(r => setImmediate(r)); }
    assertCodexAvailable() {}
  }
  const bridge = new FixtureBridge({sessionId:'aaaa',cwd:'/tmp'});
  bridge.core = {handlers:{call(name) {
    if(name === 'agent:get-model') return {model:'tiny',provider:'mock'};
    if(name === 'llm:get-client') return {async stream() {
      const route = await (await send('https://provider.invalid/v1')).text();
      return {controller:new AbortController(),async *[Symbol.asyncIterator]() {
        yield {choices:[{delta:{content:route},finish_reason:'stop'}]};
      }};
    }};
  }}};
  const invoke = () => bridge.backgroundComplete([{role:'user',content:'test'}],new AbortController().signal,{model:'tiny',provider:'mock'});
  assert.equal(await invoke(),'direct');
  assert.equal(await withNetworkSession('bbbb',invoke),'direct');
  assert.equal(await (await send('https://provider.invalid/v1')).text(),'proxy');
});


test('compact consent preserves exact grant scope, history policy and quotas',async t=>{
 const f=fixture(t);await f.store.appendMessages([{role:'user',content:'以前的消息'}]);
 const input={modelSessionId:'a',includedIds:['a'],excludedIds:[],includeHistory:true,dailyCalls:4};
 const plan=f.host.prepare('plugin',input);
 assert.deepEqual(plan.fields.map(x=>x.label),['读取范围','后台模型','使用额度']);
 assert.match(plan.fields[0].value,/仅整理「A」对话，包括已有聊天记录及后续消息；不读取其他对话/);
 assert.deepEqual(plan.details.map(x=>x.label),['单次整理上限']);
 assert(![...plan.fields,...plan.details].some(x=>['观察范围','历史范围','排除对话'].includes(x.label)));
 assert.match(plan.fields[2].value,/4.*模型费用/);assert.match(plan.fields[2].value,/失败也计入次数/);assert.match(plan.details.at(-1).value,/16000.*4096/);
 for(const [key,value] of Object.entries(input))assert.deepEqual(plan.grant[key],value);
 const grant=f.host.approve('plugin',plan);assert.deepEqual(f.api.targets(grant).map(x=>x.id),['a']);assert.equal(f.api.read(grant,'a').entries.length,1);assert.throws(()=>f.api.read(grant,'b'),/outside/);
 const future=f.host.prepare('plugin',{...input,includeHistory:false});assert.match(future.fields[0].value,/仅包含本次授权后的新消息/);assert(!future.fields[0].value.includes('包括已有'));
 const next=f.host.approve('plugin',future);assert.equal(f.api.read(next,'a').entries.length,0);
});

test('broad, multi-conversation and excluded scopes retain full visible disclosures',t=>{
 const f=fixture(t),base={modelSessionId:'a',excludedIds:[],includeHistory:true,dailyCalls:4};
 for(const input of [base,{...base,includedIds:['a','b']},{...base,includedIds:['a'],excludedIds:['a']},{...base,includedIds:['b']}]){
  const plan=f.host.prepare('plugin',input);assert.equal(plan.details,undefined);assert(plan.fields.some(x=>x.label==='观察范围'));assert(plan.fields.some(x=>x.label==='排除对话'));assert(plan.fields.some(x=>x.label==='成本上限'));
 }
});
