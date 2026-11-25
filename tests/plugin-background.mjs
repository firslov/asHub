import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PluginBackground } from '../dist/extensions/background.js';
import { acquireLedgerLock } from '../dist/extensions/ledger-lock.js';
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
test('evidence lookup uses whole identifiers and distinct terms in authorized branch order',async t=>{
 const f=fixture(t);
 const [anchor,exact,prefix,lexical,technical]=await f.store.appendMessages([
  {role:'user',content:'确认 HX-12 合同续签'},
  {role:'user',content:'ＨＸ－１２'},
  {role:'user',content:'HX-120 合同'},
  {role:'user',content:'续签合同前核对条款'},
  {role:'user',content:'repo/path blue-green'},
  {role:'assistant',content:'HX-12 合同续签'},
  {role:'user',content:'[插件任务] HX-12 合同续签'},
 ]);
 const id=f.approve(), query={exact:['HX-12'],terms:['合同','续签','续签']};
 const lookup=()=>f.api.lookupEvidence(id,'a',anchor,query);
 assert.deepEqual(lookup(),{hits:[{id:lexical,exact:false,shared:2},{id:exact,exact:true,shared:0}],more:false});
 const windowed=f.api.lookupEvidence(id,'a',anchor,{...query,excludeWithin:{entries:2,elapsedMs:60000}});
 assert.deepEqual(windowed,{hits:[{id:lexical,exact:false,shared:2}],more:false});
 assert.deepEqual(f.api.read(id,'a',anchor,1).entries.map(row=>row.id),[exact]);
 assert.deepEqual(f.api.lookupEvidence(id,'a',anchor,{exact:[],terms:['合同','合同']}),{hits:[],more:false});
 assert.deepEqual(f.api.lookupEvidence(id,'a',anchor,{exact:[],terms:['repo/path','blue-green']}),{hits:[{id:technical,exact:false,shared:2}],more:false});
 assert.throws(()=>f.api.lookupEvidence(id,'b',anchor,query),/outside/);
 assert.throws(()=>f.api.lookupEvidence(id,'a',anchor,{exact:['HX 12'],terms:[]}),/Invalid evidence/);
 assert.throws(()=>f.api.lookupEvidence(id,'a',anchor,{exact:new Array(2),terms:[]}),/Invalid evidence/);
 const [latest]=await f.store.appendMessages([{role:'user',content:'撤回 HX-12 合同续签'}]);
 assert.deepEqual(lookup().hits.map(hit=>hit.id),[latest,lexical,exact]);
 f.store.setActiveLeaf(prefix);
 const [alternate]=await f.store.appendMessages([{role:'user',content:'与 HX-12 无关'}]);
 assert.deepEqual(lookup().hits.map(hit=>hit.id),[alternate,exact]);
 assert.throws(()=>f.api.lookupEvidence(id,'a',lexical,query),/unavailable/);
 f.api.revoke(id);
 assert.throws(lookup,/撤销/);
 const restricted=f.approve({includeHistory:false});
 const session=f.host.bind('other',f.session.signal);
 assert.throws(()=>session.lookupEvidence(restricted,'a',anchor,query),/撤销/);
});
test('evidence lookup reports overflow only for eligible matches and returns the newest matches',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2030-03-04T12:00:00Z')});
 const f=fixture(t);
 const [older]=await f.store.appendMessages([{role:'user',content:'HX-12 old'}]);
 const prior=f.approve();
 assert.doesNotThrow(()=>f.api.lookupEvidence(prior,'a',older,{exact:['HX-12'],terms:[]}));
 t.mock.timers.tick(1000);
 const restricted=f.approve({includeHistory:false});
 const [anchor]=await f.store.appendMessages([{role:'user',content:'HX-12 renew'}]);
 assert.throws(()=>f.api.lookupEvidence(restricted,'a',older,{exact:['HX-12'],terms:[]}),/unavailable/);
 const exact=()=>f.api.lookupEvidence(restricted,'a',anchor,{exact:['HX-12'],terms:[]});
 const ids=await f.store.appendMessages(Array.from({length:24},()=>({role:'user',content:'HX-12 later'})));
 await f.store.appendMessages([{role:'assistant',content:'HX-12'},{role:'user',content:'HX-120'},{role:'user',content:'[插件任务] HX-12'}]);
 assert.deepEqual(exact(),{hits:[...ids].reverse().map(id=>({id,exact:true,shared:0})),more:false});
 const [latest]=await f.store.appendMessages([{role:'user',content:'HX-12 follows up'}]);
 assert.deepEqual(exact(),{hits:[latest,...ids.slice(1).reverse()].map(id=>({id,exact:true,shared:0})),more:true});
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
 assert.match(plan.fields[0].value,/仅处理「A」对话，包括已有聊天记录及后续消息；不读取其他对话/);
 assert.deepEqual(plan.details.map(x=>x.label),['单次请求上限']);
 assert(![...plan.fields,...plan.details].some(x=>['观察范围','历史范围','排除对话'].includes(x.label)));
 assert.match(plan.fields[2].value,/4.*模型费用/);assert.match(plan.fields[2].value,/失败也计入次数/);assert.match(plan.details.at(-1).value,/16000.*4096/);
 for(const [key,value] of Object.entries(input))assert.deepEqual(plan.grant[key],value);
 const grant=f.host.approve('plugin',plan);assert.deepEqual(f.api.targets(grant).map(x=>x.id),['a']);assert.equal(f.api.read(grant,'a').entries.length,1);assert.throws(()=>f.api.read(grant,'b'),/outside/);
 const future=f.host.prepare('plugin',{...input,includeHistory:false});assert.match(future.fields[0].value,/仅包含本次确认预览生成时起的新消息，确认后才获得读取权/);assert(!future.fields[0].value.includes('包括已有'));
 const next=f.host.approve('plugin',future);assert.equal(f.api.read(next,'a').entries.length,0);
});

test('broad, multi-conversation and excluded scopes retain full visible disclosures',t=>{
 const f=fixture(t),base={modelSessionId:'a',excludedIds:[],includeHistory:true,dailyCalls:4};
 for(const input of [base,{...base,includedIds:['a','b']},{...base,includedIds:['a'],excludedIds:['a']},{...base,includedIds:['b']}]){
  const plan=f.host.prepare('plugin',input);assert.equal(plan.details,undefined);assert(plan.fields.some(x=>x.label==='观察范围'));assert(plan.fields.some(x=>x.label==='排除对话'));assert(plan.fields.some(x=>x.label==='成本上限'));
 }
});

for(const compact of [true,false])test(`new-message consent describes the preview cutoff and requires confirmation across restart (compact=${compact})`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2030-03-04T12:00:00Z')});
 const f=fixture(t),[before]=await f.store.appendMessages([{role:'user',content:'范围标记-预览前'}]);
 t.mock.timers.tick(1000);const previewAt=Date.now();
 const plan=f.host.prepare('plugin',{modelSessionId:'a',excludedIds:[],...(compact?{includedIds:['a']}:{}),includeHistory:false,dailyCalls:2});
 const scope=plan.fields.find(field=>field.label===(compact?'读取范围':'历史范围')).value;
 assert.match(scope,/本次确认预览生成时起.*确认后才获得读取权/);
 assert.equal(plan.grant.since,previewAt);
 assert.throws(()=>f.api.read(plan.grant.id,'a'),/撤销或不存在/,'a preview grants no history access');
 t.mock.timers.tick(1000);const [during]=await f.store.appendMessages([{role:'user',content:'范围标记-等待确认'}]);
 assert.throws(()=>f.api.search(plan.grant.id,'a','范围标记'),/撤销或不存在/);
 t.mock.timers.tick(1000);const id=f.host.approve('plugin',plan);
 assert.equal(f.api.status(id).since,previewAt,'confirmation must preserve the documented preview cutoff');
 t.mock.timers.tick(1000);const [after]=await f.store.appendMessages([{role:'user',content:'范围标记-确认后'}]);
 const verify=(api,expected)=>{
  assert.deepEqual(api.read(id,'a').entries.map(entry=>entry.id),expected);
  assert.deepEqual(api.search(id,'a','范围标记').map(entry=>entry.id),expected);
  assert.deepEqual(api.valid(id,'a',[before,...expected]),expected);
  assert.throws(()=>api.entry(id,'a',before),/unavailable/);
  assert.equal(api.entry(id,'a',during).previousId,null,'the cutoff also hides predecessor IDs');
  for(const source of expected)assert.equal(api.entry(id,'a',source).id,source);
  assert.equal(api.latestUser(id,'a'),expected.at(-1));
 };
 verify(f.api,[during,after]);
 const history=new SessionStore(path.join(f.dir,'a.jsonl'));f.runtime.store=()=>history;
 const restored=new PluginBackground(path.join(f.dir,'grants.json'),f.runtime,f.shutdown.signal).bind('plugin',f.session.signal);
 assert.equal(restored.status(id).since,previewAt);verify(restored,[during,after]);
 t.mock.timers.tick(1000);const [later]=await history.appendMessages([{role:'user',content:'范围标记-重启后'}]);
 verify(restored,[during,after,later]);assert.equal(f.calls(),0);
});

test('explicit follow-model grants survive model switches and restart without broadening history',async t=>{
 const f=fixture(t),id=f.approve({followModel:true,includedIds:['a'],excludedIds:[]});
 assert.equal(f.api.status(id).followModel,true);
 f.targets[0].model='next';f.targets[0].provider='other';await f.api.infer(id,[{role:'user',content:'test'}]);
 const restored=new PluginBackground(path.join(f.dir,'grants.json'),f.runtime,f.shutdown.signal).bind('plugin',f.session.signal);
 await restored.infer(id,[{role:'user',content:'test'}]);assert.throws(()=>restored.read(id,'b'),/outside/);
 f.targets[0].cwd='/different';await assert.rejects(restored.infer(id,[{role:'user',content:'test'}]),/配置/);
 assert.throws(()=>f.approve({followModel:true}),/dedicated/);
});
test('follow-model rejects stale inference and preserves existing read access after quota exhaustion',async t=>{
 const f=fixture(t),id=f.approve({followModel:true,includedIds:['a'],excludedIds:[],dailyCalls:1});let release;
 f.runtime.complete=()=>new Promise(r=>release=r);
 const work=f.api.infer(id,[{role:'user',content:'test'}]);f.targets[0].model='next';release('stale');await assert.rejects(work,/未保存/);
 assert.doesNotThrow(()=>f.api.read(id,'a'));await assert.rejects(f.api.infer(id,[{role:'user',content:'test'}]),/额度/);
});

test('switching the conversation model aborts a pending background stream immediately',async()=>{
 class B extends AshBridge {async init(){} }
 const b=new B({sessionId:'switch-test',cwd:'/tmp'});let active={model:'old',provider:'mock'};
 const c=new AbortController();b.backgroundControllers.add(c);
 b.core={handlers:{call:n=>n==='agent:get-models'?[{id:'old',provider:'mock'},{id:'new',provider:'mock'}]:active},bus:{emit:(_n,p)=>{active={model:p.id,provider:p.provider};}}};
 await b.execCommand('/model','old@mock');assert(!c.signal.aborted,'same model leaves the current background stream intact');
 await assert.rejects(async()=>b.execCommand('/model','missing@mock'),/Unknown model/);assert(!c.signal.aborted,'invalid selection leaves the stream intact');
 await b.execCommand('/model','new@mock');assert(c.signal.aborted,'old inference must be cancelled on switch');
});

test('daily usage survives revoke, renewed approval and process restart without granting extra calls',async t=>{
 const f=fixture(t),first=f.approve();
 await f.api.infer(first,[{role:'user',content:'one'}]);
 f.api.revoke(first);assert.throws(()=>f.api.status(first),/撤销/);
 const file=path.join(f.dir,'grants.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));
 assert.equal(state.version,2);assert.equal(state.grants.length,0);assert.equal(state.usage[0].calls,1);
 const host=new PluginBackground(file,f.runtime,f.shutdown.signal),api=host.bind('plugin',f.session.signal);
 const plan=host.prepare('plugin',{modelSessionId:'a',dailyCalls:2,includeHistory:true,excludedIds:[]});
 assert.equal(plan.grant.calls,1);assert.equal(f.calls(),1,'preview does not call the model');
 const second=host.approve('plugin',plan);assert.equal(api.status(second).calls,1);
 await api.infer(second,[{role:'user',content:'two'}]);
 api.revoke(second);
 const third=host.approve('plugin',host.prepare('plugin',{modelSessionId:'a',dailyCalls:2,includeHistory:true,excludedIds:[]}));
 assert.equal(api.status(third).calls,2);
 await assert.rejects(()=>api.infer(third,[{role:'user',content:'blocked'}]),/额度/);assert.equal(f.calls(),2);
});

test('renewal applies the new total daily limit to live usage rather than a stale preview',async t=>{
 const f=fixture(t),first=f.approve({dailyCalls:4});
 await f.api.infer(first,[{role:'user',content:'one'}]);
 const reduced=f.host.prepare('plugin',{modelSessionId:'a',dailyCalls:1,includeHistory:true,excludedIds:[]});
 await f.api.infer(first,[{role:'user',content:'two'}]);
 const second=f.host.approve('plugin',reduced);assert.equal(f.api.status(second).calls,2);
 await assert.rejects(()=>f.api.infer(second,[{role:'user',content:'blocked'}]),/额度/);
 const third=f.approve({dailyCalls:3});assert.equal(f.api.status(third).calls,2);
 await f.api.infer(third,[{role:'user',content:'three'}]);
 await assert.rejects(()=>f.api.infer(third,[{role:'user',content:'blocked'}]),/额度/);assert.equal(f.calls(),3);
});

test('legacy grant usage migrates before revocation and corrupt usage never replenishes quota',async t=>{
 const f=fixture(t),id=f.approve();await f.api.infer(id,[{role:'user',content:'one'}]);
 const file=path.join(f.dir,'grants.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
 fs.writeFileSync(file,JSON.stringify({version:1,grants:saved.grants}));
 const host=new PluginBackground(file,f.runtime,f.shutdown.signal),api=host.bind('plugin',f.session.signal);
 assert.equal(api.status(id).calls,1);api.revoke(id);
 const renewed=host.approve('plugin',host.prepare('plugin',{modelSessionId:'a',dailyCalls:2,includeHistory:true,excludedIds:[]}));
 assert.equal(api.status(renewed).calls,1);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).version,2);
 for(const usage of [undefined,[],[{pluginId:'plugin',day:saved.grants[0].day,calls:0}],[{pluginId:'plugin',day:'2026-02-30',calls:1}],[{pluginId:'plugin',day:saved.grants[0].day,calls:-1}]]){
  const bad=path.join(f.dir,'bad-usage.json'),contents=JSON.stringify({...saved,usage});fs.writeFileSync(bad,contents);
  const broken=new PluginBackground(bad,f.runtime,f.shutdown.signal);
  assert.throws(()=>broken.bind('plugin',f.session.signal).status(id),/usage/);
  assert.throws(()=>broken.prepare('plugin',{modelSessionId:'a',dailyCalls:4,includeHistory:true,excludedIds:[]}),/usage/);
  assert.equal(fs.readFileSync(bad,'utf8'),contents);
 }
});

test('UTC day rollover replenishes each plugin once and status reports the current day',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2030-03-04T23:59:00Z')});
 const f=fixture(t),id=f.approve({dailyCalls:1});await f.api.infer(id,[{role:'user',content:'today'}]);
 const other=f.host.bind('other',f.session.signal),otherId=f.host.approve('other',f.host.prepare('other',{modelSessionId:'a',dailyCalls:1,includeHistory:true,excludedIds:[]}));
 assert.equal(other.status(otherId).calls,0,'another plugin has its own allowance');
 await other.infer(otherId,[{role:'user',content:'other today'}]);
 await assert.rejects(()=>f.api.infer(id,[{role:'user',content:'blocked'}]),/额度/);
 t.mock.timers.setTime(new Date('2030-03-05T00:00:00Z').getTime());
 assert.equal(f.api.status(id).calls,0);assert.equal(f.api.status(id).day,'2030-03-05');
 await f.api.infer(id,[{role:'user',content:'tomorrow'}]);
 const host=new PluginBackground(path.join(f.dir,'grants.json'),f.runtime,f.shutdown.signal),api=host.bind('plugin',f.session.signal);
 assert.equal(api.status(id).calls,1);await assert.rejects(()=>api.infer(id,[{role:'user',content:'blocked'}]),/额度/);
 assert.equal(host.bind('other',f.session.signal).status(otherId).calls,0);
});

test('failed and cancelled provider requests remain charged across renewed grants, preflight rejection does not',async t=>{
 const f=fixture(t),id=f.approve({dailyCalls:2});
 const cancelled=new AbortController();cancelled.abort();
 await assert.rejects(()=>f.api.infer(id,[{role:'user',content:'not started'}],cancelled.signal));assert.equal(f.api.status(id).calls,0);
 f.runtime.complete=async()=>{throw Error('temporary provider failure');};
 await assert.rejects(()=>f.api.infer(id,[{role:'user',content:'failure'}]),/provider failure/);assert.equal(f.api.status(id).calls,1);
 const renewed=f.approve({dailyCalls:2});assert.equal(f.api.status(renewed).calls,1);
 let release;f.runtime.complete=(_id,_messages,signal)=>new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});
 const pending=f.api.infer(renewed,[{role:'user',content:'cancel'}]);f.api.revoke(renewed);await assert.rejects(()=>pending,/cancelled/);
 const last=f.approve({dailyCalls:2});assert.equal(f.api.status(last).calls,2);
 await assert.rejects(()=>f.api.infer(last,[{role:'user',content:'blocked'}]),/额度/);
 release?.('late');
});

test('usage must be durably saved before provider work and persistence failure fails closed',async t=>{
 const f=fixture(t),id=f.approve(),file=path.join(f.dir,'grants.json');
 // Replace the ledger with a directory. No provider work may begin without
 // durable accounting against the previously committed authorization.
 fs.unlinkSync(file);fs.mkdirSync(file);
 await assert.rejects(()=>f.api.infer(id,[{role:'user',content:'not persisted'}]));
 assert.equal(f.calls(),0);
 assert.throws(()=>f.api.status(id));assert.throws(()=>f.approve());
 assert.equal(fs.readdirSync(f.dir).some(name=>name.endsWith('.tmp')),false);
});

test('quota reservation rejects changed ledger bytes even when inode, size and mtime still match', async t => {
  const f = fixture(t), id = f.approve(), file = path.join(f.dir, 'grants.json');
  const time = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(file, time, time);
  const restored = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
  const before = fs.lstatSync(file, { bigint: true });
  const previous = fs.readFileSync(file, 'utf8');
  const changed = previous.replaceAll('"pluginId":"plugin"', '"pluginId":"pluGin"');
  assert.notEqual(previous, changed);
  fs.writeFileSync(file, changed);
  fs.utimesSync(file, time, time);
  const after = fs.lstatSync(file, { bigint: true });
  assert.deepEqual([after.ino, after.size, after.mtimeNs], [before.ino, before.size, before.mtimeNs]);
  await assert.rejects(() => restored.infer(id, [{ role: 'user', content: 'Synthetic request' }]), /ledger no longer matches/);
  assert.equal(f.calls(), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
  assert.throws(() => restored.read(id, 'a'), /ledger no longer matches/);
});

test('quota reservation keeps support for a previously persisted ledger behind a symlink', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), id = f.approve(), file = path.join(f.dir, 'grants.json');
  const original = path.join(f.dir, 'original.json');
  fs.renameSync(file, original);
  fs.symlinkSync('original.json', file);
  const restored = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
  assert.equal(restored.status(id).calls, 0);
  await restored.infer(id, [{ role: 'user', content: 'Synthetic request' }]);
  assert.equal(f.calls(), 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).usage[0].calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(original, 'utf8')).usage[0].calls, 0);
});

for (const failure of ['write', 'rename']) test(`a temporary quota ${failure} EIO rejects the request before dispatch and preserves authorized history`, async t => {
  const f = fixture(t), id = f.approve({ dailyCalls: 2 }), file = path.join(f.dir, 'grants.json');
  const [source] = await f.store.appendMessages([{ role: 'user', content: 'Existing authorized history' }]);
  const request = [{ role: 'user', content: 'Synthetic request' }];
  await f.api.infer(id, request);
  const committed = fs.readFileSync(file, 'utf8');
  let fail = true;
  const failureError = Object.assign(Error(`Temporary quota ${failure} failed`), { code: 'EIO' });
  if (failure === 'write') {
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (target, ...args) => {
      if (fail && typeof target === 'string' && target.startsWith(file + '.') && target.endsWith('.tmp')) {
        fail = false;
        write(target, 'partial');
        throw failureError;
      }
      return write(target, ...args);
    });
  } else {
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source, destination) => {
      if (fail && destination === file) {
        fail = false;
        throw failureError;
      }
      return rename(source, destination);
    });
  }
  await assert.rejects(() => f.api.infer(id, request), { code: 'EIO' });
  assert.equal(f.calls(), 1, 'the failed reservation must not reach the provider');
  assert.equal(fs.readFileSync(file, 'utf8'), committed);
  assert(!fs.readdirSync(f.dir).some(name => name.endsWith('.tmp')));
  assert.deepEqual(f.api.read(id, 'a').entries.map(entry => entry.id), [source]);
  assert.throws(() => f.api.read(id, 'b'), /outside/);
  assert.equal(f.api.status(id).calls, 1);
  await f.api.infer(id, request);
  assert.equal(f.calls(), 2);
  const restored = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
  assert.equal(restored.status(id).calls, 2);
  await assert.rejects(() => restored.infer(id, request), /额度/);
});

test('quota rename EIO stays closed if the committed ledger cannot be verified', async t => {
  for (const damage of ['missing', 'corrupt', 'replaced', 'unreadable']) await t.test(damage, async t => {
    const f = fixture(t), id = f.approve(), file = path.join(f.dir, 'grants.json');
    const rename = fs.renameSync, read = fs.readFileSync;
    const request = [{ role: 'user', content: 'Synthetic request' }];
    const fail = t.mock.method(fs, 'renameSync', (source, destination) => {
      if (destination !== file) return rename(source, destination);
      if (damage === 'missing') fs.unlinkSync(file);
      else if (damage === 'corrupt') fs.writeFileSync(file, 'corrupt');
      else if (damage === 'replaced') {
        fs.copyFileSync(file, file + '.replacement');
        rename(file + '.replacement', file);
      } else {
        t.mock.method(fs, 'readFileSync', (target, ...args) => {
          if (target === file) throw Object.assign(Error('Ledger read failed'), { code: 'EIO' });
          return read(target, ...args);
        });
      }
      throw Object.assign(Error('Temporary quota rename failed'), { code: 'EIO' });
    });
    await assert.rejects(() => f.api.infer(id, request), { code: 'EIO' });
    fail.mock.restore();
    assert.throws(() => f.api.read(id, 'a'), { code: 'EIO' });
    await assert.rejects(() => f.api.infer(id, request), { code: 'EIO' });
    assert.equal(f.calls(), 0);
  });
});

test('an ambiguous quota commit or failed revocation EIO remains fail-closed', async t => {
  await t.test('rename committed before its error', async t => {
    const f = fixture(t), id = f.approve(), file = path.join(f.dir, 'grants.json');
    const rename = fs.renameSync, request = [{ role: 'user', content: 'Synthetic request' }];
    t.mock.method(fs, 'renameSync', (source, destination) => {
      rename(source, destination);
      if (destination === file) throw Object.assign(Error('Uncertain quota commit'), { code: 'EIO' });
    });
    await assert.rejects(() => f.api.infer(id, request), { code: 'EIO' });
    assert.throws(() => f.api.read(id, 'a'), { code: 'EIO' });
    assert.equal(f.calls(), 0);
    const restored = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
    assert.equal(restored.status(id).calls, 1, 'a possibly committed reservation must not be refunded');
  });
  for (const damage of ['missing', 'corrupt', 'replaced']) await t.test(`the temporary file is ${damage} at rename failure`, async t => {
    const f = fixture(t), id = f.approve(), file = path.join(f.dir, 'grants.json');
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (source, destination) => {
      if (destination !== file) return rename(source, destination);
      if (damage === 'missing') fs.unlinkSync(source);
      else if (damage === 'corrupt') fs.writeFileSync(source, 'partial');
      else {
        fs.copyFileSync(source, source + '.replacement');
        rename(source + '.replacement', source);
      }
      throw Object.assign(Error('Uncertain quota commit'), { code: 'EIO' });
    });
    await assert.rejects(() => f.api.infer(id, [{ role: 'user', content: 'Synthetic request' }]), { code: 'EIO' });
    assert.throws(() => f.api.read(id, 'a'), { code: 'EIO' });
    assert.equal(f.calls(), 0);
  });
  await t.test('revocation failed before commit', t => {
    const f = fixture(t), id = f.approve(), file = path.join(f.dir, 'grants.json');
    const write = fs.writeFileSync;
    t.mock.method(fs, 'writeFileSync', (target, ...args) => {
      if (typeof target === 'string' && target.startsWith(file + '.') && target.endsWith('.tmp')) {
        throw Object.assign(Error('Revocation write failed'), { code: 'EIO' });
      }
      return write(target, ...args);
    });
    assert.throws(() => f.api.revoke(id), { code: 'EIO' });
    assert.throws(() => f.api.read(id, 'a'), { code: 'EIO' });
    assert.equal(f.calls(), 0);
  });
});

test('a committed quota survives rename metadata changes and optional identity sampling failures', async t => {
  const f = fixture(t), id = f.approve({ dailyCalls: 3 }), file = path.join(f.dir, 'grants.json');
  const rename = fs.renameSync, lstat = fs.lstatSync;
  const request = [{ role: 'user', content: 'Synthetic request' }];
  let changes = 0, failSample = false, failRename = false;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination !== file) return rename(source, destination);
    if (failRename) throw Object.assign(Error('Temporary quota rename failed'), { code: 'EIO' });
    rename(source, destination);
    // The target can have different metadata after a successful rename.
    const time = new Date(1_000_000 + 1_000 * ++changes);
    fs.utimesSync(file, time, time);
    failSample = changes === 2;
  });
  t.mock.method(fs, 'lstatSync', (target, ...args) => {
    if (target === file && failSample) {
      failSample = false;
      throw Object.assign(Error('Optional identity sample failed'), { code: 'EIO' });
    }
    return lstat(target, ...args);
  });
  await f.api.infer(id, request);
  await f.api.infer(id, request);
  assert.equal(f.calls(), 2);
  assert.equal(f.api.status(id).calls, 2);
  failRename = true;
  await assert.rejects(() => f.api.infer(id, request), { code: 'EIO' });
  assert.throws(() => f.api.read(id, 'a'), { code: 'EIO' }, 'no automatic recovery without a trusted committed identity');
  assert.equal(f.calls(), 2);
  const restored = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
  assert.equal(restored.status(id).calls, 2);
});

test('history entry identifies its direct predecessor without skipping tools or generated messages',async t=>{
 const f=fixture(t),ids=await f.store.appendMessages([
  {role:'assistant',content:'您目前住在哪里？'},
  {role:'user',content:'[Project skills available: example]'},
  {role:'user',content:'上海'},
  {role:'tool',content:'另一个操作的结果'},
  {role:'user',content:'不是'},
  {role:'user',content:'[Cross-conversation message / 来自其他对话的消息]\n另一个任务'},
  {role:'user',content:'北京'},
  {role:'user',content:'详细说明'.repeat(1000)},
 ]),grant=f.approve();
 assert.equal(f.api.entry(grant,'a',ids[0]).previousId,null,'the first visible history item has no predecessor');
 assert.equal(f.api.entry(grant,'a',ids[2]).previousId,ids[0],'invisible skill notes retain existing history semantics');
 assert.equal(f.api.entry(grant,'a',ids[4]).previousId,ids[3],'a tool result cannot be skipped when checking adjacency');
 assert.equal(f.api.entry(grant,'a',ids[6]).previousId,ids[5],'a generated task cannot be skipped when checking adjacency');
 const start=f.api.entry(grant,'a',ids[7]),tail=f.api.entry(grant,'a',ids[7],start.nextOffset);
 assert.equal(start.previousId,ids[6]);assert.equal(tail.previousId,ids[6],'continuation offsets do not change the source predecessor');
 assert.equal(start.text+tail.text,'详细说明'.repeat(1000));assert.equal(start.more,true);assert.equal(tail.more,false);
});

test('history predecessor never exposes an ID from before the authorized start time',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2030-03-04T12:00:00Z')});
 const f=fixture(t),[old]=await f.store.appendMessages([{role:'assistant',content:'您是大学教师吗？'}]);
 t.mock.timers.tick(1000);const grant=f.approve({includeHistory:false});
 const [answer,question,next]=await f.store.appendMessages([{role:'user',content:'不是'},{role:'assistant',content:'您现在住在哪里？'},{role:'user',content:'上海'}]);
 assert.equal(f.api.entry(grant,'a',answer).previousId,null);
 assert.throws(()=>f.api.entry(grant,'a',old),/unavailable/);
 assert.equal(f.api.entry(grant,'a',next).previousId,question);
 assert.throws(()=>f.api.entry(grant,'b',next),/outside/);
});

test('history predecessor follows the current branch after rewind and store restoration',async t=>{
 const f=fixture(t),[question,answer,staleQuestion,staleAnswer]=await f.store.appendMessages([
  {role:'assistant',content:'您现在住在哪里？'},{role:'user',content:'上海'},
  {role:'assistant',content:'您仍然是大学教师吗？'},{role:'user',content:'不是'},
 ]),grant=f.approve();
 assert.equal(f.api.entry(grant,'a',staleAnswer).previousId,staleQuestion);
 f.store.setActiveLeaf(question);const [fresh]=await f.store.appendMessages([{role:'user',content:'北京'}]);
 assert.equal(f.api.entry(grant,'a',fresh).previousId,question);
 assert.throws(()=>f.api.entry(grant,'a',answer),/unavailable/);
 assert.throws(()=>f.api.entry(grant,'a',staleAnswer),/unavailable/);
 const restored=new SessionStore(path.join(f.dir,'a.jsonl'));f.runtime.store=()=>restored;
 assert.equal(f.api.entry(grant,'a',fresh).previousId,question);
 assert.equal(f.api.entry(grant,'a',question).previousId,null);
});

test('3C model changes preserve authorization and quota, persist safely, and execute the selected model',async t=>{
 const f=fixture(t),chosen={provider:'private',model:'compact'},options=[{...chosen,apiKey:'never-expose'}];let used;
 f.runtime.models=async()=>options;f.runtime.describeSpecified=async()=>({identity:'a'.repeat(64),origin:'https://example.invalid'});f.runtime.completeSpecified=async(_id,_messages,_signal,selection)=>{used=selection;return 'selected';};
 const id=f.approve({includedIds:['a'],excludedIds:[],followModel:true,dailyCalls:4}),before=f.api.status(id);
 assert.deepEqual(await f.api.models(id),[chosen]);assert(!JSON.stringify(await f.api.models(id)).includes('never-expose'));
 await f.api.infer(id,[{role:'user',content:'first'}]);
 const plan=await f.host.prepareModelChange('plugin',{grantId:id,model:chosen});assert(plan.fields.some(x=>x.value.includes('1 / 4')));
 assert.equal(await f.host.approveModelChange('plugin',plan),id);const changed=f.api.status(id);
 assert.equal(changed.modelRevision,1);assert.deepEqual(changed.backgroundModel,chosen);assert.equal(changed.since,before.since);assert.deepEqual(changed.includedIds,before.includedIds);assert.equal(changed.calls,1);
 const disk=JSON.parse(fs.readFileSync(path.join(f.dir,'grants.json'),'utf8'));assert.deepEqual(JSON.parse(disk.grants[0].modelBinding),['a',f.dir]);assert.notEqual(disk.grants[0].modelBinding,JSON.stringify(['a',f.dir,'mock','tiny']));
 f.targets[0].model='new-foreground';assert.equal(await f.api.infer(id,[{role:'user',content:'second'}]),'selected');assert.deepEqual(used,chosen);
 const restored=new PluginBackground(path.join(f.dir,'grants.json'),f.runtime,f.shutdown.signal).bind('plugin',f.session.signal);
 assert.equal(restored.status(id).calls,2);assert.deepEqual(restored.status(id).backgroundModel,chosen);assert.equal(restored.status(id).modelTarget.model,'compact');
 assert.throws(()=>f.host.bind('other',f.session.signal).status(id));await assert.rejects(()=>f.host.bind('other',f.session.signal).models(id));
});

test('3C stale plans, async races, and old late completions cannot commit',async t=>{
 const f=fixture(t),sel={provider:'mock',model:'alternate'};f.runtime.models=async()=>[sel];f.runtime.describeSpecified=async()=>({identity:'a'.repeat(64),origin:'https://example.invalid'});let release;
 f.runtime.complete=()=>new Promise(r=>{release=r});f.runtime.completeSpecified=async()=> 'new';
 const id=f.approve({includedIds:['a'],excludedIds:[],followModel:true,dailyCalls:4});
 const pending=f.api.infer(id,[{role:'user',content:'old'}]);const p=await f.host.prepareModelChange('plugin',{grantId:id,model:sel});const stale=await f.host.prepareModelChange('plugin',{grantId:id,model:null});
 await f.host.approveModelChange('plugin',p);release('late');await assert.rejects(pending);await assert.rejects(()=>f.host.approveModelChange('plugin',stale),/变化/);
 assert.equal(f.api.status(id).calls,1);assert.equal(await f.api.infer(id,[{role:'user',content:'new'}]),'new');
 let resume;f.runtime.models=()=>new Promise(r=>{resume=r});const delayed=f.host.prepareModelChange('plugin',{grantId:id,model:sel});
 await f.host.approveModelChange('plugin',await f.host.prepareModelChange('plugin',{grantId:id,model:null}));resume([sel]);await assert.rejects(delayed,/变化/);
});

test('3C missing models do not lock the run slot or fall back, and capability loss preserves history',async t=>{
 const f=fixture(t),sel={provider:'mock',model:'alternate'};let options=[sel],runs=0;f.runtime.models=async()=>options;f.runtime.describeSpecified=async()=>({identity:'a'.repeat(64),origin:'https://example.invalid'});f.runtime.completeSpecified=async()=>{runs++;return 'ok'};
 const id=f.approve({includedIds:['a'],excludedIds:[],followModel:true,dailyCalls:4});await f.host.approveModelChange('plugin',await f.host.prepareModelChange('plugin',{grantId:id,model:sel}));
 options=[];await assert.rejects(()=>f.api.infer(id,[{role:'user',content:'x'}]),/不可用/);assert.equal(f.calls(),0);assert.equal(f.api.status(id).calls,0);assert.doesNotThrow(()=>f.api.read(id,'a'));
 options=[sel];assert.equal(await f.api.infer(id,[{role:'user',content:'x'}]),'ok');assert.equal(runs,1);
 options=[];await f.host.approveModelChange('plugin',await f.host.prepareModelChange('plugin',{grantId:id,model:null}));assert.equal(await f.api.infer(id,[{role:'user',content:'x'}]),'{}');
});

test('3C whitelist prevents policy injection and malformed persisted policy fails closed',async t=>{
 const f=fixture(t),id=f.approve({includedIds:['a'],excludedIds:[],backgroundModel:{provider:'p',model:'m'},modelRevision:9});
 const status=f.api.status(id);assert.equal(status.backgroundModel,null);assert.equal(status.modelRevision,0);
 const file=path.join(f.dir,'grants.json'),data=JSON.parse(fs.readFileSync(file,'utf8'));data.grants[0].backgroundModel={provider:'p',model:'m'};data.grants[0].modelRevision=1;data.grants[0].followModel=true;fs.writeFileSync(file,JSON.stringify(data));
 assert.throws(()=>new PluginBackground(file,f.runtime,f.shutdown.signal).bind('plugin',f.session.signal).status(id),/Invalid persisted model policy/);
});

test('3C final synchronous validation prevents a late-confirmed policy write',async t=>{
 const f=fixture(t),sel={provider:'mock',model:'alternate'};let release,waiting=false;
 f.runtime.models=async()=>{if(waiting)await new Promise(r=>{release=r});return [sel]};f.runtime.describeSpecified=async()=>({identity:'a'.repeat(64),origin:'https://example.invalid'});f.runtime.completeSpecified=async()=>'';
 const id=f.approve({includedIds:['a'],excludedIds:[],followModel:true});const plan=await f.host.prepareModelChange('plugin',{grantId:id,model:sel});
 let allowed=true;waiting=true;const pending=f.host.approveModelChange('plugin',plan,()=>{if(!allowed)throw Error('disabled')});allowed=false;release();await assert.rejects(pending,/disabled/);assert.equal(f.api.status(id).modelRevision,0);
});

test('3C endpoint identity changes require renewed confirmation and cannot spend quota',async t=>{
 const f=fixture(t),sel={provider:'mock',model:'alternate'};let identity='a'.repeat(64),expected;
 f.runtime.models=async()=>[sel];f.runtime.describeSpecified=async()=>({identity,origin:'https://example.invalid'});f.runtime.completeSpecified=async(_id,_messages,_signal,_selection,pin)=>{expected=pin;return 'ok'};
 const id=f.approve({includedIds:['a'],excludedIds:[],followModel:true});
 const stale=await f.host.prepareModelChange('plugin',{grantId:id,model:sel});identity='b'.repeat(64);await assert.rejects(()=>f.host.approveModelChange('plugin',stale),/端点/);assert.equal(f.api.status(id).modelRevision,0);
 await f.host.approveModelChange('plugin',await f.host.prepareModelChange('plugin',{grantId:id,model:sel}));identity='c'.repeat(64);await assert.rejects(()=>f.api.infer(id,[{role:'user',content:'x'}]),/端点/);assert.equal(f.api.status(id).calls,0);assert.doesNotThrow(()=>f.api.read(id,'a'));
 identity='b'.repeat(64);assert.equal(await f.api.infer(id,[{role:'user',content:'x'}]),'ok');assert.equal(expected,identity);
});

test('3C counts provider-reported tokens across model policies without estimating unavailable usage', async t => {
  t.mock.timers.enable({ apis:['Date'], now:new Date('2030-03-04T23:59:00Z') });
  const f = fixture(t), selection = { provider:'mock', model:'alternate' };
  f.runtime.models = () => [selection];
  f.runtime.describeSpecified = async () => ({ identity:'a'.repeat(64), origin:'https://example.invalid' });
  f.runtime.complete = async (_id, _messages, _signal, report) => {
    report({ inputTokens:100, outputTokens:12 });
    return '{}';
  };
  f.runtime.completeSpecified = async (_id, _messages, _signal, _selection, _identity, report) => {
    report({ inputTokens:50, outputTokens:8 });
    return '{}';
  };
  const id = f.approve({ includedIds:['a'], excludedIds:[], followModel:true, dailyCalls:4 });
  const infer = (api = f.api) => api.infer(id,[{ role:'user', content:'synthetic source' }]);
  assert.equal(f.api.status(id).tokenUsage, undefined);
  await infer();
  await f.host.approveModelChange('plugin', await f.host.prepareModelChange('plugin', { grantId:id, model:selection }));
  await infer();
  f.runtime.completeSpecified = async () => { throw Error('provider unavailable'); };
  await assert.rejects(infer(), /provider unavailable/);
  const restored = new PluginBackground(path.join(f.dir,'grants.json'),f.runtime,f.shutdown.signal).bind('plugin',f.session.signal);
  assert.equal(restored.status(id).calls, 3);
  assert.deepEqual(restored.status(id).tokenUsage, { inputTokens:150, outputTokens:20, reportedCalls:2 });
  t.mock.timers.tick(60_000);
  assert.equal(restored.status(id).calls, 0);
  assert.equal(restored.status(id).tokenUsage, undefined);
});

test('summary uses the provider usage frame even when it follows the final text frame', async () => {
  const observed = [];
  let finishReason = 'stop';
  const client = { async stream() {
    return (async function* () {
      yield { choices:[{ delta:{ content:'{}' }, finish_reason:finishReason }] };
      yield { choices:[], usage:{ prompt_tokens:8, completion_tokens:2 } };
    })();
  } };
  const run = () => generateSummary(client,[{ role:'user', content:'test' }],new AbortController().signal, {
    onUsage:usage=>observed.push(usage),
  });
  assert.equal(await run(), '{}');
  assert.deepEqual(observed,[{ inputTokens:8, outputTokens:2 }]);
  finishReason = 'length';
  await assert.rejects(run(), /Incomplete summary/);
  assert.deepEqual(observed,[{ inputTokens:8, outputTokens:2 }, { inputTokens:8, outputTokens:2 }]);
});

test('a failed statistics write preserves the paid reply, the durable allowance and the grant', async t => {
  const f = fixture(t), id = f.approve();
  const rename = fs.renameSync;
  let failStatsWrite = false;
  t.mock.method(fs, 'renameSync', (source, destination) => {
    if (failStatsWrite && destination === path.join(f.dir,'grants.json')) {
      failStatsWrite = false;
      throw Error('temporary statistics write failure');
    }
    return rename(source,destination);
  });
  f.runtime.complete = async (_id, _messages, _signal, report) => {
    report({ inputTokens:21, outputTokens:5 });
    failStatsWrite = true;
    return 'paid result';
  };
  assert.equal(await f.api.infer(id,[{ role:'user', content:'synthetic source' }]), 'paid result');
  assert.equal(f.api.status(id).calls, 1);
  assert.doesNotThrow(() => f.api.read(id,'a'));
  const restored = new PluginBackground(path.join(f.dir,'grants.json'),f.runtime,f.shutdown.signal).bind('plugin',f.session.signal);
  assert.equal(restored.status(id).calls, 1);
  assert.equal(restored.status(id).tokenUsage, undefined);
});

for (const change of ['revoked', 'unreadable']) test(`late statistics leave the ${change} ledger untouched and preserve the paid reply`, async t => {
  const f = fixture(t), id = f.approve(), file = path.join(f.dir, 'grants.json');
  const request = [{ role: 'user', content: 'Synthetic request' }];
  let release, start;
  const started = new Promise(resolve => { start = resolve; });
  f.runtime.complete = async (_id, _messages, _signal, report) => {
    await new Promise(resolve => { release = resolve; start(); });
    report({ inputTokens: 21, outputTokens: 5 });
    return 'paid result';
  };
  const pending = f.api.infer(id, request);
  await started;
  if (change === 'revoked') {
    const second = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
    second.revoke(id);
    assert.throws(() => second.status(id), /撤销/);
  }
  const read = fs.readFileSync, committed = read(file, 'utf8');
  const blocker = change === 'unreadable' ? t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === file) throw Object.assign(Error('Statistics cannot read the ledger'), { code: 'EIO' });
    return read(target, ...args);
  }) : undefined;
  release();
  assert.equal(await pending, 'paid result');
  blocker?.mock.restore();
  assert.equal(read(file, 'utf8'), committed);
  assert(!fs.readdirSync(f.dir).some(name => name.endsWith('.tmp')));

  const restarted = new PluginBackground(file, f.runtime, f.shutdown.signal);
  const api = restarted.bind('plugin', f.session.signal);
  let checkedId = id;
  if (change === 'revoked') {
    assert.throws(() => api.read(id, 'a'), /撤销/);
    checkedId = restarted.approve('plugin', restarted.prepare('plugin', {
      modelSessionId: 'a', dailyCalls: 2, includeHistory: true, excludedIds: ['b'],
    }));
  }
  assert.equal(api.status(checkedId).calls, 1);
  assert.equal(api.status(checkedId).tokenUsage, undefined);
});

test('a foreground model change cannot restore authorization revoked by another host', t => {
  const f = fixture(t);
  const id = f.approve({ includedIds: ['a'], excludedIds: [], followModel: true });
  const file = path.join(f.dir, 'grants.json');
  const other = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
  other.revoke(id);
  const revoked = fs.readFileSync(file, 'utf8');

  f.targets[0].model = 'switched';
  assert.throws(() => f.host.noteForegroundModelChange('a', f.dir, 'mock', 'switched'), /ledger no longer matches/);
  assert.throws(() => f.api.read(id, 'a'), /ledger no longer matches/);
  assert.equal(fs.readFileSync(file, 'utf8'), revoked);
  const restarted = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
  assert.throws(() => restarted.status(id), /撤销/);
});

test('another host cannot commit between checking and replacing the ledger', t => {
  const f = fixture(t);
  const id = f.approve({ includedIds: ['a'], excludedIds: [], followModel: true });
  const file = path.join(f.dir, 'grants.json');
  const other = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
  const rename = fs.renameSync;
  let interleaved = false;
  const mock = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === file && !interleaved) {
      interleaved = true;
      assert.throws(() => other.revoke(id), { code: 'ELOCKED' });
    }
    return rename(source, destination);
  });

  f.targets[0].model = 'switched';
  f.host.noteForegroundModelChange('a', f.dir, 'mock', 'switched');
  assert(interleaved);
  mock.mock.restore();
  const current = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
  current.revoke(id);
  const restarted = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
  assert.throws(() => restarted.status(id), /撤销/);
  assert(!fs.existsSync(file + '.writer-lock'));
});

test('a busy ledger preserves existing access and allows the same instance to retry', async t => {
  const f = fixture(t);
  const id = f.approve();
  const file = path.join(f.dir, 'grants.json');
  const request = [{ role: 'user', content: 'Local fixture' }];
  const release = acquireLedgerLock(file);
  try {
    const earlier = new Date(Date.now() - 60_000);
    fs.utimesSync(file + '.writer-lock', earlier, earlier);
    await assert.rejects(() => f.api.infer(id, request), { code: 'ELOCKED' });
    assert.throws(() => f.api.revoke(id), { code: 'ELOCKED' });
    assert.equal(f.api.status(id).calls, 0);
    assert.equal(f.calls(), 0);
  } finally {
    release();
  }
  await f.api.infer(id, request);
  assert.equal(f.api.status(id).calls, 1);
  f.api.revoke(id);
  assert.throws(() => f.api.status(id), /撤销/);
});

test('the next writer can recover the lock of an exited process', async t => {
  const f = fixture(t);
  const id = f.approve();
  const file = path.join(f.dir, 'grants.json');
  const lockModule = new URL('../dist/extensions/ledger-lock.js', import.meta.url).href;
  execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { acquireLedgerLock } from ${JSON.stringify(lockModule)}; acquireLedgerLock(process.argv[1]);`, file]);
  assert(fs.existsSync(file + '.writer-lock'));
  await f.api.infer(id, [{ role: 'user', content: 'Local fixture' }]);
  assert.equal(f.api.status(id).calls, 1);
  assert(!fs.existsSync(file + '.writer-lock'));
});

test('model observations during a busy save invalidate earlier confirmations and persist on the next observation', async t => {
  const f = fixture(t);
  const id = f.approve({ includedIds: ['a'], excludedIds: [], followModel: true });
  const file = path.join(f.dir, 'grants.json');
  const prepared = await f.host.prepareModelChange('plugin', { grantId: id, model: null });
  const release = acquireLedgerLock(file);
  try {
    f.targets[0].model = 'other';
    f.host.noteForegroundModelChange('a', f.dir, 'mock', 'other');
    f.targets[0].model = 'tiny';
    f.host.noteForegroundModelChange('a', f.dir, 'mock', 'tiny');
    assert.equal(f.api.status(id).modelRevision, 2);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).grants[0].modelRevision, undefined);
  } finally {
    release();
  }
  await assert.rejects(() => f.host.approveModelChange('plugin', prepared), /已变化/);
  f.host.noteForegroundModelChange('a', f.dir, 'mock', 'tiny');
  const restarted = new PluginBackground(file, f.runtime, f.shutdown.signal).bind('plugin', f.session.signal);
  assert.equal(restarted.status(id).modelRevision, 2);
});

test('3C persists real foreground changes across A–B–A only for grants that use the foreground', async t => {
  const f = fixture(t);
  const id = f.approve({ includedIds:['a'], excludedIds:[], followModel:true, dailyCalls:4 });
  const before = f.api.status(id);
  const switchTo = model => {
    f.targets[0].model = model;
    f.host.noteForegroundModelChange('a', f.dir, 'mock', model);
  };
  switchTo('tiny');
  assert.equal(f.api.status(id).modelRevision, 0);
  switchTo('y'.repeat(201));
  switchTo('tiny');
  const restored = new PluginBackground(path.join(f.dir,'grants.json'),f.runtime,f.shutdown.signal).bind('plugin',f.session.signal);
  const after = restored.status(id);
  assert.equal(after.modelRevision, 2);
  assert.equal(after.since, before.since);
  assert.equal(after.calls, 0);
  assert.deepEqual(after.modelTarget, before.modelTarget);

  const model = { provider:'specified', model:'independent' };
  f.runtime.models = () => [model];
  f.runtime.describeSpecified = async () => ({ identity:'a'.repeat(64), origin:'https://example.invalid' });
  f.runtime.completeSpecified = async () => 'ok';
  await f.host.approveModelChange('plugin', await f.host.prepareModelChange('plugin', { grantId:id, model }));
  switchTo('changed again');
  assert.equal(f.api.status(id).modelRevision, 3);
  assert.equal(await f.api.infer(id,[{ role:'user', content:'test' }]), 'ok');
});
