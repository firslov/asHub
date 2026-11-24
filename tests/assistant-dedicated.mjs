import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PluginBackground} from '../dist/extensions/background.js';
import {ConversationEntries} from '../dist/extensions/conversation-entries.js';
import {SessionStore} from '../dist/history/session-store.js';
import {Assistant} from '../examples/extensions/personal-assistant/shared.mjs';
import {AssistantPanel} from '../examples/extensions/personal-assistant/app.mjs';
import {MemoryStore} from '../examples/extensions/personal-assistant/store.mjs';
import {withMemory} from '../examples/extensions/personal-assistant/context.mjs';
function fixture(t, seed) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-v4-'));const signal=new AbortController();
  let now=Date.now()-120000,calls=0,reply, sid='aa0011223344';
  const targets=[{id:sid,cwd:dir,title:'助手',model:'mock',provider:'test',busy:true},{id:'bb0011223344',cwd:dir,title:'普通对话',model:'mock',provider:'test',busy:true}];
  const history=new SessionStore(path.join(dir,'history.jsonl'),{create:{sessionId:sid,cwd:dir}});
  const host=new PluginBackground(path.join(dir,'grants.json'),{targets:()=>targets,store:()=>history,complete:async(_id,m)=>{calls++;return reply?.(JSON.parse(m[1].content))??'{}';}},signal.signal);
  const services={dataDirectory:dir,conversations:{canConfigureModel:true,get:()=>sid,models:()=>[{provider:'test',model:'mock'}]},host:{snapshot:()=>({sessions:targets.map(s=>({...s,instanceId:s.id,kind:'agent'})),projects:[]})},background:host.bind('assistant',signal.signal)};
  if(seed){const db=new MemoryStore(dir);seed(db);db.close();}
  const a=new Assistant(services),p=new AssistantPanel(a);
  const authorize=()=>{const plan=p.prepare('authorize');const grant=host.approve('assistant',host.prepare('assistant',plan.backgroundAuthorization));plan.execute(grant);return grant;};
  const add=async(text,role='user')=>{const ids=await history.appendMessages([{role,content:text}]);return ids[0];};
  t.after(()=>{a.stop();signal.abort();history.close?.();fs.rmSync(dir,{recursive:true,force:true});});
  return {a,p,host,services,targets,history,authorize,add,dir,calls:()=>calls,reply:fn=>reply=fn,setId:id=>sid=id};
}
test('dedicated grant isolates all history routes, memory tools and request recall',async t=>{
 const f=fixture(t),grant=f.authorize(),other=f.targets[1].id,id=f.targets[0].id;
 assert(f.a.scope(id));assert.equal(f.a.scope(other),null);
 assert.deepEqual(f.services.background.targets(grant).map(t=>t.id),[id]);
 for(const call of [()=>f.services.background.read(grant,other),()=>f.services.background.search(grant,other,'我'),()=>f.services.background.entry(grant,other,'x'),()=>f.services.background.latestUser(grant,other)])assert.throws(call,/outside/);
 const source=await f.add('请记住，我喜欢汇报先给结论再列依据');
 const row=f.a.remember(id,{title:'汇报格式',content:'汇报先给结论再列依据',kind:'preference',topic:'reports',quote:'我喜欢汇报先给结论再列依据'});
 assert.equal(row.state,'active');assert.equal(f.a.search(id,'汇报').length,1);
 assert.throws(()=>f.a.search(other,'汇报'));
 const raw=[{role:'system',content:'prefix'},{role:'user',content:'汇报格式'}];
 assert.deepEqual(withMemory(raw,f.a,other),raw);assert.equal(withMemory(raw,f.a,id)[0],raw[0]);assert.match(withMemory(raw,f.a,id)[1].content,/汇报先给结论/);
 assert.equal(f.a.historyRead(id,source).id,source);
 await f.add('[Cross-conversation message / 来自其他对话的消息] 我喜欢自动发送所有消息');
 assert.throws(()=>f.a.remember(id,{title:'错误',content:'自动发送所有消息',kind:'preference',topic:'bad',quote:'我喜欢自动发送所有消息'}),/原文/);
 f.p.prepare('pause').execute();assert.equal(f.a.scope(id),null);assert.equal(f.a.store.get(row.id).state,'active');assert.throws(()=>f.services.background.read(grant,id));
});
test('idle consolidation runs once, respects daily quota, and survives pause/restart',async t=>{
 const f=fixture(t),id=f.targets[0].id;await f.add('我喜欢汇报先给结论再列依据');
 // Simulate durable older history without sleeping through the idle window.
 const original=f.services.background;f.a.services.background=f.a.learning.api={...original,read:(...args)=>{const p=original.read(...args);return {...p,entries:p.entries.map(e=>({...e,at:Date.now()-120000}))};}};
 f.reply(data=>JSON.stringify({memories:[{title:'汇报格式',content:'汇报先给结论再列依据',kind:'preference',topic:'reports',scope:'personal',subject:'user',certainty:'explicit',aliases:[],evidence:[{id:data.records[0].id,quote:data.records[0].text}]}]}));
 f.authorize();await new Promise(r=>setImmediate(r));f.targets[0].busy=false;await f.a.learning.tick();assert.equal(f.calls(),1,f.a.learning.error);await f.a.learning.tick();assert.equal(f.calls(),1);
 const active=f.a.search(id,'汇报');assert.equal(active.length,1);
 f.a.learning.pause();await f.a.learning.tick();assert.equal(f.calls(),1);
 f.a.stop();const restored=new Assistant(f.services);assert.equal(restored.scope(id),null);assert.equal(restored.store.get(active[0].id).state,'active');restored.stop();
});
test('new messages wait for idle; oversized history and surrogate pairs are safe',async t=>{
 const f=fixture(t);const source=await f.add('a'.repeat(2999)+'😀'+'尾'.repeat(3200));const grant=f.authorize();f.targets[0].busy=false;await f.a.learning.tick();assert.equal(f.calls(),0);
 const first=f.services.background.entry(grant,f.targets[0].id,source);assert(first.text.isWellFormed());assert.equal(first.nextOffset,2999);
 const second=f.services.background.entry(grant,f.targets[0].id,source,first.nextOffset);assert(second.text.startsWith('😀'));assert(second.text.isWellFormed());assert.throws(()=>f.services.background.entry(grant,f.targets[0].id,source,3000),/offset/);
});
test('legacy data remains preserved and isolated without a manual migration interface',async t=>{
 let old;
 const f=fixture(t,db=>{old=db.add({title:'旧偏好',content:'喜欢蓝色的幻灯片',kind:'preference',scope:'personal'},{type:'user',at:1},'active');db.add({title:'旧猜测',content:'不能自行升级',kind:'fact',scope:'personal'},{type:'model-proposal',conversationId:'old',at:2});db.bind('old','/old',true);});
 f.authorize();assert.equal(f.a.store.bindings().length,0);assert.equal(f.a.search(f.targets[0].id,'蓝色').length,0);assert.equal(f.a.visible(f.a.store.list('candidate')[0]),false);
 assert.throws(()=>f.p.prepare('bind',{conversationId:f.targets[1].id,personal:true}));
 assert.throws(()=>f.p.prepare('migration'),/不支持/);assert.equal(f.a.search(f.targets[0].id,'蓝色').length,0);assert.equal(f.a.store.get(old.id).content,old.content);
 assert.throws(()=>f.p.prepare('save',{id:old.id,revision:old.revision,title:'x',content:'abcd',kind:'fact',scope:'conversation:'+f.targets[1].id}));
});
test('forget requires latest user intent and prevents relearning from the same evidence',async t=>{
 const f=fixture(t),id=f.targets[0].id;f.authorize();await f.add('我喜欢蓝色的幻灯片');
 const row=f.a.remember(id,{title:'颜色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'});
 await f.add('忘记我喜欢蓝色的幻灯片');await f.add('请继续刚才的任务');
 assert.throws(()=>f.a.forgetFromChat(id,{...row,quote:'忘记我喜欢蓝色的幻灯片'}),/明确/);
 await f.add('请忘记我喜欢蓝色的幻灯片');f.a.forgetFromChat(id,{...row,quote:'请忘记我喜欢蓝色的幻灯片'});
 assert.equal(f.a.store.get(row.id).state,'forgotten');assert.equal(f.a.search(id,'颜色').length,0);
 assert.equal(f.a.remember(id,{title:'颜色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'}).state,'forgotten');
});
test('named conversations are idempotent, persisted, and require a new review after deletion',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'named-entry-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const live=new Set();let creates=0;
 const runtime={exists:id=>live.has(id),models:()=>[{provider:'test',model:'mock'}],changed(){},async create(id){creates++;await new Promise(r=>setTimeout(r,5));live.add(id);}};
 const file=path.join(dir,'entries.json'),host=new ConversationEntries(file,runtime),life=new AbortController();
 const api=host.bind('plugin',life.signal);api.register('assistant',{label:'助手',resource:'assistant',cwd:path.join(dir,'work')});
 const input={key:'assistant',provider:'test',model:'mock'},plan=await host.prepare('plugin',input);
 const [a,b]=await Promise.all([host.approve('plugin',plan),host.approve('plugin',plan)]);assert.equal(a,b);assert.equal(creates,1);
 const again=new ConversationEntries(file,runtime);assert.equal(again.bind('plugin',life.signal).get('assistant'),a);
 live.delete(a);assert.throws(()=>host.approve('plugin',{...plan,entry:{}}));await assert.rejects(host.approve('plugin',plan),/binding changed/);
 const replacement=await host.approve('plugin',await host.prepare('plugin',input));assert.notEqual(replacement,a);assert.equal(creates,2);
 life.abort();assert.equal(host.list().length,0);assert.throws(()=>api.get('assistant'));
 fs.writeFileSync(file,'broken');const corrupt=new ConversationEntries(file,runtime);assert.equal(corrupt.list().length,0);assert.throws(()=>corrupt.bind('plugin',new AbortController().signal).register('assistant',{label:'助手',resource:'assistant',cwd:dir}));assert.equal(fs.readFileSync(file,'utf8'),'broken');
});

test('a disabled entry cannot create a conversation after its model catalog resolves',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'entry-model-race-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const life=new AbortController();let release,slow=false,creates=0;
 const host=new ConversationEntries(path.join(dir,'bindings.json'),{exists:()=>false,models:()=>slow?new Promise(r=>release=r):[{provider:'p',model:'m'}],create:async()=>{creates++;},changed(){}});
 host.bind('plugin',life.signal).register('assistant',{label:'Assistant',resource:'assistant',cwd:dir});
 const plan=await host.prepare('plugin',{key:'assistant',provider:'p',model:'m'});slow=true;const pending=host.approve('plugin',plan);life.abort();release([{provider:'p',model:'m'}]);await assert.rejects(pending);assert.equal(creates,0);
});
test('legacy global grants are revoked during dedicated migration',t=>{
 const f=fixture(t);const grant=f.host.approve('assistant',f.host.prepare('assistant',{modelSessionId:f.targets[0].id,excludedIds:[],includeHistory:true,dailyCalls:4}));
 f.a.store.setState('learning',{enabled:true,grantId:grant});f.a.store.db.prepare("DELETE FROM learning_state WHERE key='assistant:v4'").run();f.a.stop();
 const upgraded=new Assistant(f.services);assert.equal(upgraded.learning.config().enabled,false);assert.throws(()=>f.services.background.targets(grant));assert.equal(upgraded.scope(f.targets[1].id),null);upgraded.stop();
});
test('explicit source quotes between 200 and 300 characters remain searchable',async t=>{
 const f=fixture(t),id=f.targets[0].id;f.authorize();const quote='我喜欢的汇报格式是'+('先结论再证据'.repeat(38));await f.add(quote);
 const row=f.a.remember(id,{title:'汇报格式',content:'先给结论再列证据',kind:'preference',topic:'long-quote',quote});assert.equal(row.state,'active');
});

test('forgetting a corrected memory blocks pending consolidation from its original evidence', async t=>{
  const f=fixture(t), id=f.targets[0].id, grant=f.authorize();
  const source=await f.add('我喜欢蓝色的幻灯片');
  const row=f.a.remember(id,{title:'颜色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'});
  const corrected=f.a.store.edit(row.id,row.revision,{title:'颜色',content:'喜欢绿色的幻灯片',kind:'preference',scope:'personal'});
  let finish;f.reply(()=>new Promise(resolve=>finish=resolve));f.targets[0].busy=false;
  const batch=f.a.learning.processBatch(f.a.learning.config(),f.targets[0],f.services.background.read(grant,id).entries,new AbortController().signal);
  f.a.store.forget(corrected.id,corrected.revision);
  finish(JSON.stringify({memories:[{title:'幻灯片色彩',content:'制作幻灯片时偏好蓝色',kind:'preference',topic:'slides-color',scope:'personal',subject:'user',certainty:'explicit',aliases:[],evidence:[{id:source,quote:'我喜欢蓝色的幻灯片'}]}]}));
  await batch;
  assert.equal(f.a.store.activeMemories().length,0,'A delayed paraphrase must not resurrect forgotten evidence after a user correction');
  assert.throws(()=>f.a.historyRead(id,source),/来源/);
});

test('source exclusions survive repeated corrections, restart, and legacy edited records', async t=>{
  const f=fixture(t), id=f.targets[0].id;f.authorize();
  const source=await f.add('我喜欢蓝色的幻灯片');
  const initial=f.a.remember(id,{title:'颜色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'});
  let row=f.a.store.get(initial.id);
  // Reproduce a pre-fix user edit which dropped source IDs from the latest row.
  f.a.store.edit(row.id,row.revision,{...row,content:'喜欢绿色的幻灯片'});
  row=f.a.store.get(row.id);const legacy={type:'user-edit',at:Date.now(),context:row.source.context,topic:row.source.topic};
  f.a.store.db.prepare('UPDATE memories SET source=? WHERE id=?').run(JSON.stringify(legacy),row.id);
  for(let n=0;n<12;n++) {row=f.a.store.get(row.id);f.a.store.edit(row.id,row.revision,{...row,content:'喜欢绿色的幻灯片 '+n});}
  assert(!f.a.store.history(row.id).some(v=>v.value.source.type==='learned'),'Original learned version has aged out');
  f.a.stop();const a=new Assistant(f.services);
  try {row=a.store.get(row.id);a.store.forget(row.id,row.revision);assert((a.store.state('ignored:'+id)??[]).includes(source));assert.equal(a.store.history(row.id).length,0);}finally{a.stop();}
});

test('a fresh explicit request can remember a forgotten fact without replaying old evidence',async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();const input={title:'颜色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'};
 const oldSource=await f.add(input.quote);const old=f.a.remember(sid,input);f.a.store.forget(old.id,old.revision);
 await new Promise(r=>setTimeout(r,2));
 const freshSource=await f.add('请重新记住，我喜欢蓝色的幻灯片');
 const fresh=f.a.remember(sid,input);
 assert.equal(fresh.state,'active','An explicit new user request must not be silently discarded by an old tombstone');
 assert.notEqual(fresh.id,old.id);
 assert.equal(f.a.read(sid,fresh.id).source.sources[0].id,freshSource);
 assert.throws(()=>f.a.historyRead(sid,oldSource),/来源/);
 assert.equal(f.a.store.get(old.id).state,'forgotten');
 assert.equal(f.a.remember(sid,input).id,fresh.id,'A retry must not create another copy');
 // Subsequent ordinary consolidation may corroborate the renewed fact.
 const corroboration=await f.add('我喜欢蓝色的幻灯片');
 const source={...f.a.store.get(fresh.id).source,refs:[{id:corroboration,conversationId:sid,quote:input.quote,at:Date.now(),fingerprint:'fresh-proof'}]};
 delete source.renewedFrom;
 f.a.store.learn({...input,scope:'personal'},source);
 f.a.stop();const restored=new Assistant(f.services);
 try { assert.equal(restored.search(sid,'蓝色').length,1);assert.equal(restored.read(sid,fresh.id).content,input.content); }
 finally {restored.stop();}
});
test('forgetting a corrected fact preserves another established fact from the same source',async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();await f.add('我喜欢蓝色的幻灯片，也喜欢简短的报告');
 const first=f.a.remember(sid,{title:'颜色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'});
 const other=f.a.remember(sid,{title:'汇报',content:'喜欢简短的报告',kind:'preference',topic:'report',quote:'也喜欢简短的报告'});
 const edited=f.a.store.edit(first.id,first.revision,{title:'颜色',content:'喜欢绿色的幻灯片',kind:'preference',scope:'personal'});
 f.a.store.forget(edited.id,edited.revision);
 assert.equal(f.a.read(sid,other.id).content,'喜欢简短的报告');
 assert.equal(f.a.search(sid,'简短的报告').length,1);
});

test('only a new explicit current user request renews forgetting, never late or incidental evidence',async t=>{
 const f=fixture(t),sid=f.targets[0].id,grant=f.authorize();
 const input={title:'颜色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'};
 const original=await f.add(input.quote);const row=f.a.remember(sid,input);
 let finish;f.reply(()=>new Promise(r=>finish=r));f.targets[0].busy=false;
 const pending=f.a.learning.processBatch(f.a.learning.config(),f.targets[0],f.services.background.read(grant,sid).entries,new AbortController().signal);
 f.a.store.forget(row.id,row.revision);
 await new Promise(r=>setTimeout(r,2));await f.add('刚才讨论过我喜欢蓝色的幻灯片');
 assert.equal(f.a.remember(sid,input).state,'forgotten','Incidental historical mentions are not an explicit renewal');
 await f.add('请重新记住，我喜欢蓝色的幻灯片');await f.add('先继续其他事情');
 assert.equal(f.a.remember(sid,input).state,'forgotten','Do not renew from a superseded user message');
 await f.add('请重新记住，我喜欢蓝色的幻灯片');const fresh=f.a.remember(sid,input);assert.equal(fresh.state,'active');
 finish(JSON.stringify({memories:[{...input,title:'过期结果',content:'仍只使用旧的蓝色设置',topic:'renamed-old-color',scope:'personal',subject:'user',certainty:'explicit',aliases:[],evidence:[{id:original,quote:input.quote}]}]}));
 await pending;assert.deepEqual(f.a.store.activeMemories().map(r=>r.id),[fresh.id]);
 const actual=f.a.store.get(fresh.id);f.a.store.forget(actual.id,actual.revision);
 await new Promise(r=>setTimeout(r,2));await f.add('请重新记住，我喜欢蓝色的幻灯片');
 const twice=f.a.remember(sid,input);assert.equal(twice.state,'active');assert.notEqual(twice.id,fresh.id);
 assert.equal(f.a.search(sid,'蓝色').length,1);
});

for(const [label,message] of [
 ['quoted old instruction','你刚才说“请重新记住，我喜欢蓝色的幻灯片”，这句话是什么意思？'],
 ['negated instruction','请不要再记住，我喜欢蓝色的幻灯片'],
 ['negated renewal','不要重新记住，我喜欢蓝色的幻灯片'],
 ['narrated prior request','我之前让你重新记住，我喜欢蓝色的幻灯片'],
 ['a quotation as the whole message','“请重新记住，我喜欢蓝色的幻灯片”'],
 ['question about recall','你还记住我喜欢蓝色的幻灯片吗？'],
 ['a matching fragment in a long quotation','下面是旧聊天的引用，不是新的要求：'+ '旧内容。'.repeat(100)+'请重新记住，我喜欢蓝色的幻灯片']
])test('renewal rejects '+label,async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();const input={title:'颜色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'};
 await f.add(input.quote);const row=f.a.remember(sid,input);f.a.store.forget(row.id,row.revision);await new Promise(r=>setTimeout(r,2));
 await f.add(message);assert.equal(f.a.remember(sid,input).state,'forgotten');assert.equal(f.a.store.activeMemories().length,0);
});

test('direct positive renewal supports Chinese and English and full-message citations',async t=>{
 for(const [message,quote,content] of [
 ['请重新记住，我喜欢蓝色的幻灯片','我喜欢蓝色的幻灯片','喜欢蓝色的幻灯片'],
 ['请帮我记下：“我喜欢蓝色的幻灯片”。','我喜欢蓝色的幻灯片','喜欢蓝色的幻灯片'],
 ['重新记住：我喜欢蓝色的幻灯片','重新记住：我喜欢蓝色的幻灯片','喜欢蓝色的幻灯片'],
 ['我希望你重新记住：我喜欢蓝色的幻灯片','我喜欢蓝色的幻灯片','喜欢蓝色的幻灯片'],
 ['Please remember that I prefer blue slides.','I prefer blue slides','I prefer blue slides']
 ])await t.test(message,async t=>{
   const f=fixture(t),sid=f.targets[0].id;f.authorize();const input={title:'Color',content,kind:'preference',topic:'color',quote};
   await f.add(quote);const row=f.a.remember(sid,input);f.a.store.forget(row.id,row.revision);await new Promise(r=>setTimeout(r,2));await f.add(message);
   assert.equal(f.a.remember(sid,input).state,'active');
 });
});
test('English negation and a bounded excerpt never authorize renewal',async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();const input={title:'Color',content:'Prefers blue slides',kind:'preference',topic:'color',quote:'I prefer blue slides'};
 await f.add(input.quote);const row=f.a.remember(sid,input);f.a.store.forget(row.id,row.revision);await new Promise(r=>setTimeout(r,2));
 for(const message of ["Please don't remember that I prefer blue slides",'Please remember that I prefer blue slides. '+ 'This is only a quoted example. '.repeat(130)]){
   await f.add(message);assert.equal(f.a.remember(sid,input).state,'forgotten');
 }
});

for(const [label,quote] of [
 ['do not forget','请不要忘记，我喜欢蓝色的幻灯片'],
 ['quoted deletion','你之前说“忘记我喜欢蓝色的幻灯片”，这是什么意思？'],
 ['question about deletion','你是否已经忘记我喜欢蓝色的幻灯片？'],
 ['English negation',"Please don't forget that I prefer blue slides"]
])test('forget rejects '+label,async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();const input={title:'颜色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'};
 await f.add(input.quote);const row=f.a.remember(sid,input);await f.add(quote);
 assert.throws(()=>f.a.forgetFromChat(sid,{...row,quote}),/明确/);assert.equal(f.a.store.get(row.id).state,'active');
});

test('direct forget and do-not-remember instructions remain supported',async t=>{
 for(const quote of ['请忘记我喜欢蓝色的幻灯片','不要记我喜欢蓝色的幻灯片','请不要再记住我喜欢蓝色的幻灯片','别记住我喜欢蓝色的幻灯片','Please forget that I prefer blue slides','Do not remember that I prefer blue slides'])await t.test(quote,async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();const evidence=/^[A-Z]/.test(quote)?'I prefer blue slides':'我喜欢蓝色的幻灯片';const input={title:'颜色',content:evidence,kind:'preference',topic:'color',quote:evidence};
 await f.add(input.quote);const row=f.a.remember(sid,input);await f.add(quote);
 assert.deepEqual(f.a.forgetFromChat(sid,{...row,quote}),{forgotten:true});assert.equal(f.a.store.get(row.id).state,'forgotten');
 });
});

test('asking what a memory command means never authorizes it with a full-message citation',async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();const input={title:'颜色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'};
 await f.add(input.quote);const row=f.a.remember(sid,input);
 const deletion='忘记我喜欢蓝色的幻灯片是什么意思？';await f.add(deletion);
 assert.throws(()=>f.a.forgetFromChat(sid,{...row,quote:deletion}),/明确/);
 f.a.store.forget(row.id,row.revision);await new Promise(r=>setTimeout(r,2));
 const renewal='重新记住我喜欢蓝色的幻灯片是什么意思？';await f.add(renewal);
 assert.equal(f.a.remember(sid,{...input,quote:renewal}).state,'forgotten');
});

test('a valid forget command cannot delete an unrelated memory ID',async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();
 await f.add('我喜欢蓝色的幻灯片');const color=f.a.remember(sid,{title:'配色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'});
 await f.add('我是大学教师');const job=f.a.remember(sid,{title:'职业',content:'是一名大学教师',kind:'fact',topic:'job',quote:'我是大学教师'});
 const quote='请忘记我喜欢蓝色的幻灯片';await f.add(quote);
 assert.throws(()=>f.a.forgetFromChat(sid,{...job,quote}),/目标|匹配/);
 assert.equal(f.a.store.get(job.id).state,'active');assert.equal(f.a.store.get(color.id).state,'active');
});
test('a valid renewal command cannot restore an unrelated forgotten fact',async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();
 const job={title:'职业',content:'是一名大学教师',kind:'fact',topic:'job',quote:'我是大学教师'};
 await f.add(job.quote);const old=f.a.remember(sid,job);f.a.store.forget(old.id,old.revision);await new Promise(r=>setTimeout(r,2));
 await f.add('请重新记住，我喜欢蓝色的幻灯片');
 const result=f.a.remember(sid,{...job,quote:'我喜欢蓝色的幻灯片'});
 assert.equal(result.state,'forgotten');assert.equal(f.a.store.activeMemories().length,0);
});

test('forget targets stay distinct within one source and ambiguous names require a precise ID',async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();await f.add('我喜欢蓝色的幻灯片，也喜欢简短的报告');
 const color=f.a.remember(sid,{title:'偏好',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'});
 const report=f.a.remember(sid,{title:'偏好',content:'喜欢简短的报告',kind:'preference',topic:'reports',quote:'也喜欢简短的报告'});
 await f.add('请忘记偏好');assert.throws(()=>f.a.forgetFromChat(sid,{...color,quote:'请忘记偏好'}),/多条/);
 const quote='请忘记我喜欢蓝色的幻灯片';await f.add(quote);assert.throws(()=>f.a.forgetFromChat(sid,{...report,quote}),/匹配/);
 f.a.forgetFromChat(sid,{...color,quote});assert.equal(f.a.read(sid,report.id).content,'喜欢简短的报告');
 await f.add('请忘记：'+report.id);f.a.forgetFromChat(sid,{...report,quote:report.id});assert.equal(f.a.store.activeMemories().length,0);
});
test('forget also rejects ambiguous names shared by active and candidate memories',async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();await f.add('我喜欢蓝色的幻灯片');
 const row=f.a.remember(sid,{title:'偏好',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'});
 const candidate=f.a.store.add({title:'偏好',content:'没有用户确认的推测',kind:'fact',scope:'personal'},{type:'model-proposal',conversationId:sid,reason:'待观察',at:Date.now()});
 await f.add('请忘记偏好');assert.throws(()=>f.a.forgetFromChat(sid,{...row,quote:'请忘记偏好'}),/多条/);
 assert.throws(()=>f.a.forgetFromChat(sid,{...candidate,quote:'请忘记偏好'}),/多条/);
 assert.equal(f.a.store.get(candidate.id).state,'candidate');assert.equal(f.a.store.get(row.id).state,'active');
});

test('fresh evidence after a rewind restores a previously learned fact without obsolete branch IDs',async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();const root=await f.add('开始今天的聊天');
 const input={title:'汇报格式',content:'喜欢先给结论再列依据',kind:'preference',topic:'reports',quote:'我喜欢先给结论再列依据'};
 const oldSource=await f.add(input.quote);const original=f.a.remember(sid,input);assert.equal(f.a.search(sid,'汇报').length,1);
 f.history.setActiveLeaf(root);assert.equal(f.a.search(sid,'汇报').length,0);
 const freshSource=await f.add(input.quote);const fresh=f.a.remember(sid,input);
 assert.equal(fresh.id,original.id);assert.equal(fresh.state,'active');
 assert.equal(f.a.search(sid,'汇报').length,1,'New valid evidence must not be poisoned by a removed branch');
 assert.deepEqual(f.a.read(sid,fresh.id).source.sources.map(r=>r.id),[freshSource]);
 assert(!f.a.store.get(fresh.id).source.refs.some(r=>r.id===oldSource));
});

test('background consolidation replaces obsolete branch evidence and keeps the memory identity',async t=>{
 const f=fixture(t),sid=f.targets[0].id,grant=f.authorize();const root=await f.add('开始今天的聊天');
 const input={title:'汇报格式',content:'喜欢先给结论再列依据',kind:'preference',topic:'reports',quote:'我喜欢先给结论再列依据'};
 await f.add(input.quote);const old=f.a.remember(sid,input);f.history.setActiveLeaf(root);
 const freshSource=await f.add(input.quote);
 f.reply(()=>JSON.stringify({memories:[{...input,scope:'personal',subject:'user',certainty:'explicit',aliases:[],evidence:[{id:freshSource,quote:input.quote}]}]}));
 f.targets[0].busy=false;await f.a.learning.processBatch(f.a.learning.config(),f.targets[0],f.services.background.read(grant,sid).entries,new AbortController().signal);
 assert.equal(f.calls(),1);assert.equal(f.a.search(sid,'汇报')[0].id,old.id);
 assert.deepEqual(f.a.read(sid,old.id).source.sources.map(r=>r.id),[freshSource]);
});
test('a rewound strategy must earn fresh feedback rather than inherit removed validation',async t=>{
 const f=fixture(t),sid=f.targets[0].id,grant=f.authorize();const root=await f.add('开始今天的聊天');
 const input={title:'复核步骤',content:'修改前先保存快照',kind:'procedure',topic:'snapshots',quote:'每次修改前先保存快照'};
 await f.add(input.quote);const first=f.a.remember(sid,input);
 const support=async label=>{await new Promise(r=>setTimeout(r,2));const id=await f.add(label),entry=f.services.background.entry(grant,sid,id);f.a.store.evaluate(first.id,'support',{id,conversationId:sid,quote:label,at:entry.at,fingerprint:label});};
 await support('保存快照使这次修改成功恢复');await support('第二次验证同样因为保存快照恢复成功');assert.equal(f.a.store.get(first.id).state,'active');
 f.history.setActiveLeaf(root);assert.equal(f.a.search(sid,'复核').length,0);
 await new Promise(r=>setTimeout(r,2));const fresh=await f.add(input.quote);const row=f.a.remember(sid,input);
 assert.equal(row.id,first.id);assert.equal(row.state,'candidate');assert.equal(f.a.store.get(row.id).source.feedback,undefined);assert.deepEqual(f.a.store.get(row.id).source.refs.map(r=>r.id),[fresh]);
 await support('新分支第一次快照恢复成功');assert.equal(f.a.store.get(row.id).state,'candidate');
 await support('新分支第二次快照恢复成功');assert.equal(f.a.store.get(row.id).state,'active');assert.equal(f.a.search(sid,'复核').length,1);
});


test('chat-first welcome uses one model field, explicit scoped consent and a navigation result only after completion',async t=>{
 const f=fixture(t);f.setId(null);
 const initial=await f.p.welcome();assert.equal(initial.form.action,'create-assistant');assert.deepEqual(initial.actions,[]);assert.equal(initial.form.fields.length,2);assert(!initial.openConversation);
 const creation=await f.p.prepareWelcome('create-assistant',{model:JSON.stringify({provider:'test',model:'mock'})});
 assert(creation.entryAuthorization);assert(!creation.backgroundAuthorization);assert.equal(f.a.learning.config().enabled,false);
 f.setId(f.targets[0].id);const after=await creation.execute(f.targets[0].id);assert.equal(after.actions[0].id,'authorize');assert(!after.openConversation);
 const consent=await f.p.prepareWelcome('authorize');assert.deepEqual(consent.backgroundAuthorization.includedIds,[f.targets[0].id]);
 const grant=f.host.approve('assistant',f.host.prepare('assistant',consent.backgroundAuthorization));
 assert.equal((await consent.execute(grant)).openConversation,f.targets[0].id);assert(f.a.scope(f.targets[0].id));assert(!f.a.scope(f.targets[1].id));
 assert(!(await f.p.welcome()).openConversation,'passive views never navigate');
 await assert.rejects(f.p.prepareWelcome('forget'),/不支持/);
});

test('welcome can skip memory without enabling it, and stale consent cannot authorize a replacement chat',async t=>{
 const f=fixture(t);const skip=await f.p.prepareWelcome('chat');assert.equal((await skip.execute()).openConversation,f.targets[0].id);assert.equal(f.a.learning.config().enabled,false);
 const consent=await f.p.prepareWelcome('authorize');f.setId(f.targets[1].id);
 assert.throws(()=>skip.execute(),/变化/);await assert.rejects(consent.execute('obsolete'),/变化/);assert.equal(f.a.learning.config().enabled,false);
 f.setId(null);await assert.rejects(f.p.prepareWelcome('chat'),/创建/);
 f.services.conversations.models=()=>[];const view=await f.p.welcome();assert(!view.form);assert.equal(view.actions[0].id,'retry');
});

test('named entry metadata is bounded and preserves optional setup resources across catalogs',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'entry-ui-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const host=new ConversationEntries(path.join(dir,'entries.json'),{exists:()=>false,models:()=>[],create:async()=>{},changed(){}});
 const api=host.bind('plugin',new AbortController().signal),spec={label:'助手',resource:'assistant',cwd:dir,setupResource:'welcome',description:'长期交流'};
 assert.throws(()=>api.register('bad',{...spec,setupResource:'../secret'}));assert.throws(()=>api.register('bad',{...spec,description:'x'.repeat(301)}));
 api.register('assistant',spec);assert.equal(host.list()[0].setupResource,'welcome');assert.equal(host.list()[0].description,'长期交流');
});

test('assistant is a conversation with a minimal memory popover, not a settings form',async t=>{
 const f=fixture(t),view=await f.p.overview();assert.equal(view.form,undefined);assert.equal(view.rows.length,0);
 assert.deepEqual(view.actions.map(a=>a.id),['authorize']);assert.throws(()=>f.p.prepare('configure-model',{}));
 f.authorize();const enabled=await f.p.overview();
 assert.deepEqual(enabled.actions.map(a=>a.id),['enable-theme-overviews','pause']);
 assert.equal(enabled.toggle.action,'pause');assert.equal(f.a.store.themeOverviewEnabled(),false);
});

test('fresh combined onboarding can explicitly skip memory and enter the created chat',async t=>{
 const f=fixture(t);f.services.conversations.supportsEntryBackground=true;f.setId(null);
 const view=await f.p.welcome();assert(view.form.fields.some(x=>x.id==='memory'&&x.type==='checkbox'),'first-use skip control exists');
 const plan=await f.p.prepareWelcome('create-assistant',{model:JSON.stringify({provider:'test',model:'mock'}),memory:false});assert.equal(plan.entryBackground,undefined);
 f.setId(f.targets[0].id);const result=await plan.execute(f.targets[0].id);assert.equal(result.openConversation,f.targets[0].id);assert.equal(f.a.learning.config().enabled,false);
});


test('removed memory UI routes reject without changing stored data or authorization',async t=>{
 const f=fixture(t),id=f.targets[0].id,grant=f.authorize();
 await f.add('我喜欢蓝色的幻灯片');
 const row=f.a.remember(id,{title:'颜色',content:'喜欢蓝色的幻灯片',kind:'preference',topic:'color',quote:'我喜欢蓝色的幻灯片'});
 const config=structuredClone(f.a.learning.config()),stored=f.a.store.get(row.id);
 for(const route of ['memories','search','find','topic','detail','edit','save','forget','migration','history','restore','settings','bindings','configure'])
   assert.throws(()=>f.p.prepare(route,{id:row.id,revision:row.revision,query:'蓝色'}),/不支持/);
 assert.deepEqual(f.a.learning.config(),config);assert.deepEqual(f.a.store.get(row.id),stored);
 assert.deepEqual(f.services.background.targets(grant).map(t=>t.id),[id]);
 f.p.prepare('pause').execute();assert.equal(f.a.scope(id),null);assert.equal(f.a.store.get(row.id).state,'active');
 f.authorize();assert.equal(f.a.search(id,'蓝色').length,1);assert.equal(f.a.scope(f.targets[1].id),null);
});
test('the pilot can opt in under a fixed-model grant without upgrading that grant',t=>{
 const f=fixture(t),id=f.targets[0].id;
 const input={modelSessionId:id,includedIds:[id],excludedIds:[],includeHistory:true,dailyCalls:4};
 const grant=f.host.approve('assistant',f.host.prepare('assistant',input));f.a.learning.configure(grant,input);
 const view=f.p.overview();assert.deepEqual(view.actions.map(a=>a.id),['enable-theme-overviews','pause']);
 assert.equal(view.toggle.action,'pause');assert.equal(f.a.store.themeOverviewEnabled(),false);
 const action=view.actions.find(a=>a.id==='enable-theme-overviews');const enable=f.p.prepare(action.id,action.values);
 assert(enable.preview);assert.equal(enable.backgroundAuthorization,undefined);enable.execute();
 assert.equal(f.a.learning.config().grantId,grant);assert.equal(f.a.store.themeOverviewEnabled(),true);
 assert.notEqual(f.services.background.status(grant).followModel,true);
});


test('session scope follows durable entry ownership during create, restore and replacement',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'entry-session-scope-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'bindings.json'),live=new Set(),life=new AbortController();let host;
 const runtime={exists:id=>live.has(id),models:()=>[{provider:'test',model:'mock'}],changed(){},async create(id){
  assert.equal(live.has(id),false);
  assert(host.matchesSession('plugin',['assistant'],id),'binding must precede kernel startup');
  const cold=new ConversationEntries(file,runtime);assert(cold.matchesSession('plugin',['assistant'],id),'restart before entry registration');
  live.add(id);
 }};
 host=new ConversationEntries(file,runtime);host.bind('plugin',life.signal).register('assistant',{label:'Assistant',resource:'assistant',cwd:dir});
 const input={key:'assistant',provider:'test',model:'mock'};
 const a=await host.approve('plugin',await host.prepare('plugin',input));
 assert(!host.matchesSession('other-plugin',['assistant'],a));assert(!host.matchesSession('plugin',['other'],a));assert(!host.matchesSession('plugin',['assistant'],'ordinary'));
 live.delete(a);const b=await host.approve('plugin',await host.prepare('plugin',input));
 assert(!host.matchesSession('plugin',['assistant'],a));assert(host.matchesSession('plugin',['assistant'],b));
 fs.writeFileSync(file,'broken');assert(!new ConversationEntries(file,runtime).matchesSession('plugin',['assistant'],b));life.abort();
});

test('chat corrections explicitly align a memory by ID and revision while preserving authorization',async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();
 await f.add('我的常住城市是北京');
 const old=f.a.remember(sid,{title:'常住城市',content:'用户常住北京',kind:'fact',topic:'residence',quote:'我的常住城市是北京'});
 await f.add('我已经搬到上海，今后常住上海');
 const input={title:'常住城市',content:'用户现常住上海',kind:'fact',topic:'current-city',quote:'我已经搬到上海，今后常住上海',memoryId:old.id,revision:old.revision,relation:'revise'};
 assert.throws(()=>f.a.remember(sid,{...input,revision:undefined}),/完整/);
 const updated=f.a.remember(sid,input);assert.equal(updated.id,old.id);assert(updated.revision>old.revision);
 assert.equal(f.a.store.activeMemories().length,1);assert.equal(f.a.read(sid,old.id).content,'用户现常住上海');
 assert.equal(f.a.read(sid,old.id).topic,'residence','the existing canonical topic remains stable');
 assert.throws(()=>f.a.remember(sid,input),/变化/,'a stale tool result cannot overwrite the current revision');
 f.p.prepare('pause').execute();assert.throws(()=>f.a.remember(sid,{...input,revision:updated.revision}),/开关/);
});


test('chat revision retains the subject of an assistant memory instead of turning it into a user fact',async t=>{
 const f=fixture(t),sid=f.targets[0].id;f.authorize();await f.add('以后你的名字叫小助');
 const row=f.a.remember(sid,{title:'助手称呼',content:'个人助手名称为小助',kind:'fact',topic:'assistant-name',subject:'assistant',quote:'以后你的名字叫小助'});
 await f.add('以后你的名字改叫阿助');
 const input={title:'助手称呼',content:'个人助手名称为阿助',kind:'fact',topic:'nickname',quote:'以后你的名字改叫阿助',memoryId:row.id,revision:row.revision,relation:'revise'};
 assert.throws(()=>f.a.remember(sid,{...input,subject:'user'}),/主体/);
 const updated=f.a.remember(sid,input);assert.equal(updated.id,row.id);assert.equal(f.a.read(sid,row.id).context.subject,'assistant');
 assert.equal(f.a.read(sid,row.id).content,'个人助手名称为阿助');
});

test('long-lived assistant learns, recalls, corrects and resumes across compact, pause and restart',async t=>{
 const f=fixture(t),sid=f.targets[0].id,original=f.services.background;
 const aged={...original,read:(...args)=>{const page=original.read(...args);return {...page,entries:page.entries.map(e=>({...e,at:e.at-120000}))};}};
 f.services.background=f.a.learning.api=aged;
 let phase='age';
 f.reply(data=>{
   const source=data.records.find(r=>r.role==='user');assert(source);
   const common={scope:'personal',subject:'user',certainty:'explicit',aliases:[],evidence:[{id:source.id,quote:source.text}]};
   const value=phase==='age'?{title:'年龄',content:'用户自述年龄为36岁',kind:'fact',topic:'age'}
     :phase==='diet'?{title:'饮食限制',content:'用户对花生过敏',kind:'fact',topic:'dietary-restriction',scenarios:['晚餐','用餐']}
     :{title:'年龄',content:'用户纠正自述年龄为35岁',kind:'fact',topic:'current-age',memoryId:data.existing.find(x=>x.topic==='age').id,revision:data.existing.find(x=>x.topic==='age').revision,relation:'revise'};
   return JSON.stringify({memories:[{...common,...value}]});
 });
 await f.add('你今年多大？','assistant');await f.add('36岁');const firstGrant=f.authorize();await new Promise(r=>setImmediate(r));f.targets[0].busy=false;
 await f.a.learning.tick();assert.equal(f.calls(),1);assert.match(f.a.search(sid,'我几岁')[0].content,/36/);
 phase='diet';await f.add('我对花生过敏');await f.a.learning.tick();assert.equal(f.calls(),2);
 const request=[{role:'system',content:'Keep this prefix'},{role:'user',content:'帮我安排晚餐'}];const recalled=withMemory(request,f.a,sid);
 assert.match(recalled.at(-1).content,/花生过敏/);assert.equal(request.at(-1).content,'帮我安排晚餐');assert.equal(recalled[0],request[0]);
 phase='correction';const correction=await f.add('年龄说错了，我今年是35岁');await f.a.learning.tick();assert.equal(f.calls(),3);
 const ages=f.a.search(sid,'我的年龄');assert.equal(ages.filter(x=>x.topic==='age').length,1);assert.match(ages.find(x=>x.topic==='age').content,/35/);
 assert(!ages.some(x=>/36岁/.test(x.content)),'outdated current conclusion leaves recall');
 await f.history.appendCompaction(correction,12000);await f.a.learning.tick();assert.equal(f.calls(),3,'compaction does not create new learning evidence');
 f.a.learning.pause();assert.throws(()=>aged.status(firstGrant));f.targets[0].busy=true;const secondGrant=f.authorize();await new Promise(r=>setImmediate(r));f.targets[0].busy=false;
 await f.a.learning.tick();assert.equal(f.calls(),3,'same-scope reauthorization must not pay to relearn old history');assert.equal(aged.status(secondGrant).calls,3);
 f.a.stop();const restored=new Assistant(f.services);
 try{await restored.learning.tick();assert.equal(f.calls(),3);assert.match(restored.search(sid,'我的年龄').find(x=>x.topic==='age').content,/35/);assert.equal(restored.learning.health().errorClass,null);assert(restored.learning.health().lastSuccessAt);}
 finally{restored.stop();}
});

function recalled(f,text,includeTool=false) {
  const image={type:'image_url',image_url:{url:'data:image/png;base64,test'}};
  const user={role:'user',content:[{type:'text',text},image]};
  const request=includeTool?[user,{role:'tool',tool_call_id:'tool-1',content:[{type:'text',text:'工具结果'}]}]:[user];
  const response=withMemory(request,f.a,f.targets[0].id);
  if(response===request)return [];
  assert.equal(response.at(-1).content[1],request.at(-1).content[0]);
  if(includeTool){assert.equal(response[0],user);assert.equal(response.at(-1).tool_call_id,'tool-1');}
  else assert.equal(response[0].content[2],image);
  return JSON.parse(response.at(-1).content[0].text.split('\n')[1]).items;
}

test('hybrid request uses authorized bigrams and exact identifiers, not stale branches or the active prompt',async t=>{
  const f=fixture(t),id=f.targets[0].id;
  const before=await f.add('授权之前的换机编号是 PC-1201');
  await new Promise(r=>setTimeout(r,3));
  const grant=f.host.approve('assistant',f.host.prepare('assistant',{modelSessionId:id,includedIds:[id],excludedIds:[],includeHistory:false,dailyCalls:4}));
  f.a.learning.configure(grant,{modelSessionId:id,includeHistory:false,includedIds:[id]});
  const first=await f.add('扭矩设定为 23 牛米，写到验收单。');
  await f.add('扭矩不应该超过 24 牛米。');
  const branch=await f.add('已经报修，确认编号 AZ-1401 对应冷却泵。');
  const similar=await f.add('已经报修，确认编号 AZ-1402 对应机床。');
  const latest=await f.add('扭矩');
  const base=recalled(f,'扭矩',true);
  assert(base.some(x=>x.id===first && x.kind==='original' && x.confidence==='unverified-history'));
  assert(!base.some(x=>x.id===latest));
  const report=recalled(f,'帮我查编号 AZ-1401');
  assert.deepEqual(report.map(x=>x.id),[branch]);
  assert(!report.some(x=>x.id===similar));
  assert(!recalled(f,'PC-1201').some(x=>x.id===before));
  assert.deepEqual(recalled(f,'讲解彩虹的形成'),[]);
  f.history.setActiveLeaf(first);
  assert.deepEqual(recalled(f,'AZ-1401'),[]);
  const reloadedHistory=new SessionStore(path.join(f.dir,'history.jsonl'));
  const life=new AbortController();
  const recoveredHost=new PluginBackground(path.join(f.dir,'grants.json'),{targets:()=>f.targets,store:()=>reloadedHistory,
    complete:async()=>{throw Error('unexpected inference');}},life.signal);
  const reloaded=new Assistant({...f.services,background:recoveredHost.bind('assistant',life.signal)});
  try {
    assert.deepEqual(recalled({...f,a:reloaded},'AZ-1401'),[]);
    assert.deepEqual(recalled({...f,a:reloaded},'扭矩').map(x=>x.id),[first]);
  } finally {reloaded.stop();life.abort();reloadedHistory.close?.();}
  f.history.setActiveLeaf(latest);
  assert.deepEqual(recalled(f,'AZ-1401').map(x=>x.id),[branch]);
  f.services.background.revoke(grant);
  assert.deepEqual(recalled(f,'扭矩'),[]);
});

test('forget excludes short evidence embedded in a new message, without matching unrelated identifiers',async t=>{
  const f=fixture(t),id=f.targets[0].id; f.authorize();
  const phrase='我的代号是青竹';
  const first=await f.add(phrase+'。');
  assert(recalled(f,'青竹').some(x=>x.id===first));
  const stable=f.a.remember(id,{title:'代号',content:phrase,kind:'fact',subject:'user',topic:'codename',quote:phrase});
  const independent=f.a.store.add({title:'竹林报告',content:'竹林报告按月提交',kind:'fact',scope:'personal'},{type:'user'},'active');
  await f.add('你的代号是青竹，下面接着讨论归档。','assistant');
  const copiedText='补充说明：我的代号是青竹，仅用于内部草稿。';
  const copiedId=await f.add(copiedText);
  const cached={id:copiedId,text:copiedText};
  const unrelated={id:'unrelated',text:'竹林报告按月提交'};
  f.a.store.setState('scan:'+id,{context:[cached,unrelated]});
  f.a.store.setState('learning-result:'+id,{sourceIds:[copiedId],resume:{records:[cached]}});
  const note=await f.add('归档标记 ZT1401 关联另一项独立的审计任务。');
  const obsolete=await f.add('弃用归档标记 ZT-1401');
  const archived=f.a.remember(id,{title:'归档标记',content:'归档标记 ZT-1401',kind:'fact',topic:'archive-id',quote:'弃用归档标记 ZT-1401'});
  assert(recalled(f,'ZT-1401').length);
  await f.add('请忘记'+phrase);
  f.a.forgetFromChat(id,{...stable,quote:'请忘记'+phrase});
  assert.deepEqual(f.a.store.state('scan:'+id)?.context,[unrelated]);
  assert.equal(f.a.store.state('learning-result:'+id),null);
  f.a.store.forget(archived.id,archived.revision);
  const repeated=await f.add('后来补充：'+phrase+'，但这不是报告标题。');
  const assistantCopy=await f.add('你确认过：你的代号是青竹。','assistant');
  const attributed=await f.add('转述：用户的代号是青竹，仅用于内部草稿。');
  const newlyLearnable=await f.add('测试实验台验收后要断电。');
  const batch=f.a.learning.historyBatch(f.a.learning.config(),f.targets[0],'scan:guard-test');
  assert(!batch.records.some(r=>[repeated,assistantCopy,attributed].includes(r.id)));
  assert(batch.records.some(r=>r.id===newlyLearnable));
  await f.add('好，那之前提到的内容呢？');
  assert.deepEqual(recalled(f,'青竹'),[]);
  assert.deepEqual(f.a.historySearch(id,'青竹'),[]);
  assert.throws(()=>f.a.historyRead(id,repeated),/不再用于记忆/);
  assert.throws(()=>f.a.historyRead(id,obsolete),/不再用于记忆/);
  assert.deepEqual(recalled(f,'ZT1401').map(x=>x.id),[note]);
  assert(f.a.read(id,independent.id));
  f.a.stop();
  const restored=new Assistant(f.services);
  try {
    assert.deepEqual(recalled({...f,a:restored},'青竹'),[]);
    assert.deepEqual(recalled({...f,a:restored},'ZT1401').map(x=>x.id),[note]);
    assert(restored.read(id,independent.id));
  } finally {restored.stop();}
});

test('request dedup skips already-visible user messages and fills the freed slot',async t=>{
  const f=fixture(t);f.authorize();
  const shown='杉木档案的表格改用横向布局。';
  const older=await f.add('杉木档案原件储存在南向隔间。');
  await f.add(shown);
  const request=[{role:'user',content:shown},{role:'user',content:'杉木档案'}];
  const output=withMemory(request,f.a,f.targets[0].id);
  assert.equal(output[0],request[0]);
  assert.deepEqual(JSON.parse(output[1].content.split('\n')[1]).items.map(row=>row.id),[older]);
});

test('near-identical messages with different precise values keep both matching sources',async t=>{
  const f=fixture(t), id=f.targets[0].id;f.authorize();
  const a=await f.add('旧设备的恢复代码 RC-091B 已在管理员面板重新生成。');
  const b=await f.add('旧设备的恢复代码 RC-091C 已在管理员面板重新生成。');
  await f.add('旧设备的恢复代码 RC-091C 已在管理员面板重新生成。');
  const codes=recalled(f,'RC-091B 和 RC-091C 两个恢复代码都是什么？');
  assert.equal(codes.length,2);
  assert(codes.some(x=>x.id===a));
  assert(codes.some(x=>x.content.includes('RC-091C')));
  const release=await f.add('版本 0.21.7 的下载附件已经校验。');
  await f.add('版本 0.21.8 的下载附件已经校验。');
  await f.add('版本 0.21.9 的下载附件已经校验。');
  assert.deepEqual(recalled(f,'0.21.7').map(x=>x.id),[release]);
  const gateway=await f.add('网关 v0.21.6 的发布负责人是甲。');
  await f.add('网关 v0.21.7 的发布负责人是乙。');
  assert.deepEqual(recalled(f,'网关 0.21.6 的发布负责人？').map(x=>x.id),[gateway]);
  assert.deepEqual(recalled(f,'v0.21.6').map(x=>x.id),[gateway]);
  const endpoint=await f.add('本机测试服务是 http://192.168.1.13:7878/healthz。');
  await f.add('另一个服务是 http://192.168.1.13:8000/healthz。');
  await f.add('另一台测试机是 192.168.1.14:7878。');
  assert.deepEqual(recalled(f,'192.168.1.13:7878').map(x=>x.id),[endpoint]);
  const hosts=recalled(f,'192.168.1.13');
  assert.equal(hosts.length,2);
  assert(hosts.every(x=>x.content.includes('192.168.1.13')));
  const style=f.a.store.add({title:'回复偏好',content:'回答先给结论并保持简洁',kind:'preference',scope:'personal'},
    {type:'user',context:{subject:'user'}},'active');
  assert.equal(recalled(f,'帮我总结 BX-2022 的新发现').at(0)?.id,style.id);
  assert(!recalled(f,'RC-091B').some(x=>x.id===b));
  await f.add('冷却泵压差应设为 22 千帕，验收前复核。');
  await f.add('冷却泵压差应设为 23 千帕，验收前复核。');
  assert.equal(recalled(f,'冷却泵压差').filter(row=>row.kind==='original').length,2);
});

test('a forgotten sentence does not suppress a new fact with only a shared prefix',async t=>{
  const f=fixture(t),id=f.targets[0].id;f.authorize();
  const old='我决定本周的设计评审改到周三进行';
  await f.add(old);
  const entry=f.a.remember(id,{title:'评审日程',content:old,topic:'design-review-date',quote:old,kind:'fact'});
  f.a.store.forget(entry.id,entry.revision);
  const next='我决定本周的设计评审由李梅主持';
  const source=await f.add(next);
  assert.equal(f.a.historyRead(id,source).text,next);
  assert.equal(recalled(f,'设计评审李梅')[0]?.id,source);
  assert.equal(f.a.remember(id,{title:'评审主持人',content:next,topic:'design-review-host',quote:next,kind:'fact'}).state,'active');
});

test('corrected source does not appear beside its replacement; explicit historic text stays pageable',async t=>{
  const f=fixture(t),id=f.targets[0].id;f.authorize();
  const old=await f.add('我的常住城市是北京');
  const row=f.a.remember(id,{title:'常住城市',content:'用户常住北京',subject:'user',topic:'residence',quote:'我的常住城市是北京',kind:'fact'});
  await f.add('更正：我现在的常住城市是上海');
  f.a.remember(id,{title:'常住城市',content:'用户现常住上海',subject:'user',topic:'residence',quote:'我现在的常住城市是上海',kind:'fact',
    memoryId:row.id,revision:row.revision,relation:'revise'});
  const items=recalled(f,'我现在的常住城市是哪里？');
  assert.equal(items.length,1);
  assert.match(items[0].content,/上海/);
  assert.match(f.a.historyRead(id,old).text,/北京/);
  const long=await f.add('长文校验。'.repeat(4500));
  assert.equal(f.a.historyRead(id,long).more,true);
  const sz=f.a.historyRead(id,long).nextOffset;
  assert.equal(f.a.historyRead(id,long,sz).offset,sz);
});

test('legacy unavailable suppression keeps independent stable recall and cannot reopen on restart',async t=>{
  const f=fixture(t),id=f.targets[0].id;
  const forgotten=await f.add('尖峰限额是二十台');
  await new Promise(r=>setTimeout(r,3));
  const grant=f.host.approve('assistant',f.host.prepare('assistant',{modelSessionId:id,includedIds:[id],excludedIds:[],includeHistory:false,dailyCalls:4}));
  f.a.learning.configure(grant,{modelSessionId:id,includeHistory:false,includedIds:[id]});
  // Reproduce a pre-upgrade tombstone with only a source ID.
  f.a.store.setState('ignored:'+id,[forgotten]);
  await f.add('复述：尖峰限额是二十台，仅供草稿。');
  const stable=f.a.store.add({title:'会议室约定',content:'会议室使用后需归位桌椅',kind:'fact',scope:'personal'},{type:'user'},'active');
  assert.deepEqual(recalled(f,'尖峰限额'),[]);
  assert.deepEqual(recalled(f,'会议室').map(x=>x.id),[stable.id]);
  f.a.stop();
  const restored=new Assistant(f.services);
  try {
    assert.deepEqual(recalled({...f,a:restored},'尖峰限额'),[]);
    assert.equal(recalled({...f,a:restored},'会议室')[0]?.id,stable.id);
  } finally {restored.stop();}
});

test('two-character evidence embedded in later user text stays forgotten after a full restart',async t=>{
  const f=fixture(t),id=f.targets[0].id;f.authorize();
  await f.add('你想用哪个称呼？','assistant');
  const first=await f.add('汀兰');
  assert.deepEqual(recalled(f,'汀兰呢').map(x=>x.id),[first]);
  const row=f.a.remember(id,{title:'称呼',content:'用户希望称呼为汀兰',subject:'user',topic:'preferred-address',quote:'汀兰',kind:'preference'});
  assert.equal(row.state,'active');
  f.a.store.forget(row.id,row.revision);
  const copy=await f.add('补充一下，汀兰是旧草案里的署名。');
  const rule=await f.add('签字使用蓝色钢笔。');
  const reloadHistory=new SessionStore(path.join(f.dir,'history.jsonl'));
  const signal=new AbortController();
  const host=new PluginBackground(path.join(f.dir,'grants.json'),{targets:()=>f.targets,store:()=>reloadHistory,
    complete:async()=>{throw Error('no model call expected');}},signal.signal);
  f.a.stop();
  const restored=new Assistant({...f.services,background:host.bind('assistant',signal.signal)});
  try {
    assert.deepEqual(recalled({...f,a:restored},'汀兰'),[]);
    assert.throws(()=>restored.historyRead(id,copy),/不再用于记忆/);
    assert.deepEqual(recalled({...f,a:restored},'蓝色钢笔').map(x=>x.id),[rule]);
  } finally {restored.stop();signal.abort();reloadHistory.close?.();}
});

const eventFact=(id,quote,fields={})=>({title:'报告模板',content:'长期使用蓝色报告模板',scope:'personal',
  kind:'preference',subject:'user',certainty:'explicit',aliases:[],evidence:[{id,quote}],...fields});
const processEvents=(f,grant,ids,context=[])=>{
  f.targets[0].busy=false;
  return f.a.learning.processBatch(f.a.learning.config(),f.targets[0],
    f.services.background.read(grant,f.targets[0].id).entries.filter(row=>ids.includes(row.id)),new AbortController().signal,false,undefined,context);
};

test('full source identity prevents different excerpts of a replay from giving independent support',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=fixture(t),grant=f.authorize(),id=f.targets[0].id;
  const original='我往常写周报都把风险一栏放在前面，完成项放在后面。';
  const one=await f.add(original);
  const memory={title:'周报结构',content:'写周报时倾向先列风险',kind:'preference',certainty:'inferred'};
  const firstQuote='我往常写周报都把风险一栏放在前面';
  f.reply(()=>JSON.stringify({memories:[eventFact(one,firstQuote,memory)]}));
  await processEvents(f,grant,[one]);
  const prior=f.a.store.list('candidate')[0];
  assert(prior);
  t.mock.timers.tick(24*60*60*1000);
  const repeat=await f.add(original);
  const align={memoryId:prior.id,revision:prior.revision,relation:'support'};
  f.reply(()=>JSON.stringify({memories:[eventFact(repeat,'完成项放在后面',{...memory,...align})]}));
  await processEvents(f,grant,[repeat]);
  assert.equal(f.a.store.get(prior.id).revision,prior.revision);
  assert.equal(f.a.store.get(prior.id).state,'candidate');
  const replay=f.services.background.read(grant,id).entries.find(row=>row.id===repeat);
  assert.equal(f.a.learning.selectIncrement(f.a.learning.config(),f.targets[0],[replay])[0].role,'excluded');
  t.mock.timers.tick(24*60*60*1000);
  const independent='上周复盘周报后发现，把风险放到周报开头比较便于交流。';
  const two=await f.add(independent);
  f.reply(data=>{
    assert(data.existing.some(row=>row.id===prior.id && row.priorEvidence?.text===firstQuote));
    return JSON.stringify({memories:[eventFact(two,independent,{...memory,...align})]});
  });
  await processEvents(f,grant,[two]);
  const current=f.a.store.get(prior.id);
  assert.equal(current.state,'active');
  assert.equal(current.revision,prior.revision+1);
  assert.deepEqual(current.source.refs.map(ref=>ref.id),[one,two]);
});

test('a version inside a temporary sentence is not a boundary; explicit and unresolved changes differ',async t=>{
  const f=fixture(t),grant=f.authorize();
  const original='我长期使用蓝色报告模板。',first=await f.add(original);
  f.reply(()=>JSON.stringify({memories:[eventFact(first,original)]}));
  await processEvents(f,grant,[first]);
  const prior=f.a.store.activeMemories()[0],align={memoryId:prior.id,revision:prior.revision,relation:'revise'};
  const limited=await f.add('本次适配 v1.2.3 版固件，报告模板改用红色。');
  f.reply(()=>JSON.stringify({memories:[eventFact(limited,'报告模板改用红色',{content:'长期使用红色报告模板',...align})]}));
  await processEvents(f,grant,[limited]);
  assert.equal(f.a.store.get(prior.id).revision,prior.revision);
  const doubt=await f.add('报告模板以后可能会改成灰色，还没定。');
  f.reply(()=>JSON.stringify({memories:[eventFact(doubt,'报告模板以后可能会改成灰色',{content:'长期使用灰色报告模板',...align})]}));
  await processEvents(f,grant,[doubt]);
  assert.equal(f.a.store.get(prior.id).revision,prior.revision);
  assert.equal(f.a.store.list('candidate')[0]?.source.mode,'unresolved');
  const real=await f.add('本次检查版本。今后报告模板改用红色。');
  f.reply(()=>JSON.stringify({memories:[eventFact(real,'今后报告模板改用红色',{content:'长期使用红色报告模板',...align})]}));
  await processEvents(f,grant,[real]);
  assert.equal(f.a.store.get(prior.id).content,'长期使用红色报告模板');
});

test('a late clear correction gets a prior ID despite four unrelated event budgets',async t=>{
  const f=fixture(t),grant=f.authorize(),id=f.targets[0].id;
  const former='港区冷库温度上限为零下十度';
  await f.add(former);
  const target=f.a.remember(id,{title:'港区冷库温度上限',content:former,kind:'fact',topic:'old-storage-limit',quote:former,subject:'user'});
  const topics=['防汛泵站','轨道机房','监控值班','实验档案'];
  for(const [i,topic] of topics.entries())for(const [j,part] of ['甲区','乙区'].entries()){
    const s=topic+'检测记录，'+part+'按周复核。';
    await f.add(s);
    f.a.remember(id,{title:topic+'检测记录'+part,content:s,kind:'fact',topic:'area-'+i+'-'+j,quote:s,subject:'user'});
  }
  const ids=[];
  for(const topic of topics)ids.push(await f.add('换个话题，更新'+topic+'检测记录。'));
  const edit='回到之前的港区冷库，更正温度上限为零下十二度。';
  const newest=await f.add(edit);
  const newContent='港区冷库温度上限改为零下十二度';
  f.reply(data=>{
    assert(data.events.length>=5);
    assert(data.existing.length<=8);
    const found=data.existing.find(row=>row.id===target.id);
    assert(found,'an explicit late correction retains space for its old evidence');
    return JSON.stringify({memories:[eventFact(newest,edit,{title:'港区冷库温度上限',kind:'fact',content:newContent,
      memoryId:found.id,revision:found.revision,relation:'revise'})]});
  });
  await processEvents(f,grant,[...ids,newest]);
  assert.equal(f.a.store.get(target.id).content,newContent);
});

test('forget during inference scrubs old identifiers from late candidates and their metadata, without losing independent work',async t=>{
  const f=fixture(t),grant=f.authorize(),id=f.targets[0].id;
  const original='我的皮箱编号是 CRATE-78。';
  await f.add(original);
  const old=f.a.remember(id,{title:'皮箱编号',content:original,kind:'fact',topic:'crate',quote:original,subject:'user'});
  const invoice='我的皮箱发票经周静复核，统一使用纸质档案。',invoiceId=await f.add(invoice);
  let release;
  f.reply(data=>{
    assert(data.existing.some(row=>row.id===old.id&&row.priorEvidence?.text===original));
    return new Promise(resolve=>{release=resolve;});
  });
  const pending=processEvents(f,grant,[invoiceId]);
  f.a.store.forget(old.id,old.revision);
  release(JSON.stringify({memories:[
    eventFact(invoiceId,invoice,{title:'箱柜测试记号',content:'标记为 CRATE-78',kind:'fact'}),
    eventFact(invoiceId,invoice,{title:'发票档案',content:'发票使用纸质档案',aliases:['CRATE-78'],kind:'fact'}),
    eventFact(invoiceId,invoice,{title:'发票档案',content:'发票经周静复核并使用纸质档案',kind:'fact'}),
  ]}));
  await pending;
  assert.deepEqual(f.a.store.activeMemories().map(row=>row.content),['发票经周静复核并使用纸质档案']);
  assert.equal(f.a.store.state('learning-result:'+id),null);
  const restored=new Assistant(f.services);
  try {
    assert.deepEqual(restored.search(id,'CRATE-78'),[]);
    assert.equal(restored.search(id,'周静')[0]?.title,'发票档案');
  } finally {restored.stop();}
});

test('an English short denial retains its supporting question and cannot cross a narrowed grant',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=fixture(t),grant=f.authorize(),id=f.targets[0].id;
  const statement='I am vegetarian.', first=await f.add(statement);
  f.reply(()=>JSON.stringify({memories:[eventFact(first,statement,{title:'Diet',content:'The user is vegetarian',kind:'fact'})]}));
  await processEvents(f,grant,[first]);
  const prior=f.a.store.activeMemories()[0];
  const question=await f.add('Are you still vegetarian?','assistant');
  t.mock.timers.tick(1000);
  const narrowPlan=f.host.prepare('assistant',{modelSessionId:id,includeHistory:false,includedIds:[id],excludedIds:[],dailyCalls:4});
  const answer=await f.add('not anymore');
  const context=f.services.background.entry(grant,id,question);
  f.reply(()=>JSON.stringify({memories:[eventFact(answer,'not anymore',{title:'Diet',kind:'fact',content:'The user is no longer vegetarian',
    memoryId:prior.id,revision:prior.revision,relation:'contradict'})]}));
  await processEvents(f,grant,[answer],[context]);
  const denied=f.a.store.get(prior.id);
  assert.equal(denied.source.mode,'contradicted');
  assert.equal(denied.source.refs[0].contextId,question);
  const narrow=f.host.approve('assistant',narrowPlan);
  f.a.learning.configure(narrow,{modelSessionId:id,includeHistory:false,includedIds:[id]});
  assert.deepEqual(f.services.background.valid(narrow,id,[question,answer]),[answer]);
  f.a.stop();
  const restored=new Assistant(f.services);
  try {
    const follow=await f.add('Is the vegetarian diet still on record?');
    f.reply(data=>{
      assert(!data.existing.some(row=>row.id===prior.id));
      return '{"memories":[]}';
    });
    await processEvents({...f,a:restored},narrow,[follow]);
  } finally {restored.stop();}
});

test('a durable decision in the same sentence is not swallowed by its preceding one-time trial',async t=>{
  const f=fixture(t),grant=f.authorize(),id=f.targets[0].id;
  const text='我的周报长期使用蓝色报告模板发布。';
  await f.add(text);
  const prior=f.a.remember(id,{title:'周报模板',content:text,kind:'preference',topic:'template',subject:'user',quote:text});
  const align={memoryId:prior.id,revision:prior.revision,relation:'revise'};
  const counter=await f.add('本次试用红版报告模板，以后仍用蓝色。');
  f.reply(()=>JSON.stringify({memories:[eventFact(counter,'试用红版报告模板',{...align,content:'长期使用红色报告模板'})]}));
  await processEvents(f,grant,[counter]);
  assert.equal(f.a.store.get(prior.id).revision,prior.revision);
  const update='本次试用已经结束，我决定以后所有周报都按红版发布。',end=await f.add(update);
  const [record]=f.services.background.read(grant,id).entries.filter(row=>row.id===end);
  assert.equal(f.a.learning.selectIncrement(f.a.learning.config(),f.targets[0],[record])[0].role,'user');
  f.reply(()=>JSON.stringify({memories:[eventFact(end,'我决定以后所有周报都按红版发布',{...align,content:'长期使用红色报告模板'})]}));
  await processEvents(f,grant,[end]);
  assert.equal(f.a.store.get(prior.id).content,'长期使用红色报告模板');
});

test('forget cascades to short-answer derivatives of the same value, including after full restart',async t=>{
  const f=fixture(t),grant=f.authorize(),id=f.targets[0].id;
  const code='设备开箱代号是 RX-7057';
  await f.add(code);
  const original=f.a.remember(id,{title:'设备开箱代号',content:code,kind:'fact',topic:'device-code',subject:'user',quote:code});
  const question=await f.add('你的设备恢复凭据是 RX-7057 吗？','assistant');
  const answer=await f.add('还是长期用'),context=f.services.background.entry(grant,id,question);
  f.reply(()=>JSON.stringify({memories:[eventFact(answer,'还是长期用',{title:'恢复凭据',kind:'fact',content:'长期使用的恢复凭据是 RX-7057',topic:'recovery-code'})]}));
  await processEvents(f,grant,[answer],[context]);
  const derivative=f.a.store.activeMemories().find(row=>row.id!==original.id);
  assert.equal(derivative?.source.refs[0].contextId,question);
  const unaffectedText='服务器退役记录由戴宁复核。';
  await f.add(unaffectedText);
  const independent=f.a.remember(id,{title:'服务器退役',content:unaffectedText,kind:'fact',topic:'retirement',subject:'user',quote:unaffectedText});
  f.a.store.forget(original.id,original.revision);
  assert.equal(f.a.store.get(derivative.id).state,'forgotten');
  f.a.stop();
  const restored=new Assistant(f.services);
  try {
    assert.equal(restored.read(id,independent.id).content,unaffectedText);
    assert.deepEqual(recalled({...f,a:restored},'RX-7057'),[]);
    const follow=await f.add('设备的恢复凭据是哪个？');
    f.reply(data=>{
      assert(!data.existing.some(item=>[original.id,derivative.id].includes(item.id)));
      return '{"memories":[]}';
    });
    await processEvents({...f,a:restored},grant,[follow]);
  } finally {restored.stop();}
});

test('late explicit evidence cannot replace a later same-timestamp decision on the active branch',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=fixture(t),grant=f.authorize(),id=f.targets[0].id;
  const defaultText='我默认周报模板使用蓝色。';
  await f.add(defaultText);
  const prior=f.a.remember(id,{title:'周报模板',content:defaultText,kind:'preference',topic:'report-template',subject:'user',quote:defaultText});
  t.mock.timers.tick(1000);
  const older='更正，今后周报模板使用红色。',early=await f.add(older);
  const newer='收回刚才变更，今后周报模板使用灰色。',late=await f.add(newer);
  f.reply(()=>JSON.stringify({memories:[eventFact(late,newer,{content:'周报模板使用灰色',memoryId:prior.id,revision:prior.revision,relation:'revise'})]}));
  await processEvents(f,grant,[late]);
  const revised=f.a.store.get(prior.id);
  assert.equal(revised.content,'周报模板使用灰色');
  f.reply(()=>JSON.stringify({memories:[eventFact(early,older,{content:'周报模板使用红色',memoryId:prior.id,revision:revised.revision,relation:'revise'})]}));
  await processEvents(f,grant,[early]);
  assert.equal(f.a.store.get(prior.id).revision,revised.revision);
  assert.equal(f.a.store.get(prior.id).content,revised.content);
});

test('a temporary qualifier before a long continuation cannot disappear from the cited conclusion',async t=>{
  const f=fixture(t),grant=f.authorize(),id=f.targets[0].id;
  const baseline='我默认报告模板使用蓝色。';
  await f.add(baseline);
  const prior=f.a.remember(id,{title:'报告模板',content:baseline,kind:'preference',topic:'template',subject:'user',quote:baseline});
  const tail='报告模板改用红色';
  const record=await f.add('本次预演，'+ '布局'.repeat(1670)+'，'+tail+'。');
  const c=f.a.learning.config(), key='scan:'+id;
  const first=f.a.learning.historyBatch(c,f.targets[0],key);
  assert.equal(first.state.partial.id,record);
  f.a.learning.commitScan(key,first.state,id);
  const later=f.a.learning.historyBatch(c,f.targets[0],key);
  assert(later.records[0].offset>=3000);
  assert(later.records[0].text.includes(tail));
  const row=f.a.store.get(prior.id);
  f.a.learning.applyResult(c,f.targets[0],later.records,{memories:[eventFact(record,tail,{content:'报告模板长期改用红色',
    memoryId:row.id,revision:row.revision,relation:'revise'})]},[row],[],false,later.context);
  assert.equal(f.a.store.get(prior.id).content,baseline);
  assert.equal(f.a.store.get(prior.id).revision,prior.revision);
});
