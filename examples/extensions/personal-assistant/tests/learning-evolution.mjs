import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Assistant } from '../shared.mjs';
const item=(id,quote,extra={})=>({title:'职业',content:'用户是一名大学教师',kind:'fact',scope:'personal',subject:'user',certainty:'explicit',topic:'occupation',aliases:[],evidence:[{id,quote}],...extra});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-evolution-learning-')),records=[],requests=[];
 const target={id:'a',instanceId:'a',cwd:dir,title:'助手',kind:'agent',projectId:null,busy:false};
 let grant='g1',since=0,revoked=false,answer=()=>({memories:[]}),calls=0;
 const clip=(s,n)=>{let end=Math.min(n,s.length);if(end<s.length&&/[\uD800-\uDBFF]/u.test(s[end-1]??''))end--;return s.slice(0,end);};
 const api={
  status:g=>{if(revoked||g!==grant)throw Error('后台授权已撤销');return {includedIds:['a'],excludedIds:[],includeHistory:since===0,since,calls,dailyCalls:4,day:new Date().toISOString().slice(0,10)};},
  targets:g=>{api.status(g);return [{...target}];},
  read:(g,id,cursor)=>{api.status(g);const index=records.findIndex(r=>r.id===cursor),page=records.slice(index+1,index+41);return {entries:page.filter(r=>r.at>=since).map(r=>({...r,text:clip(r.text,3000),truncated:r.text.length>3000})),cursor:page.at(-1)?.id??cursor??null,more:index+1+page.length<records.length,reset:!!cursor&&index<0};},
  entry:(g,id,source,offset=0)=>{api.status(g);const r=records.find(r=>r.id===source&&r.at>=since);if(!r)throw Error('History source unavailable');assert(!(/[\uDC00-\uDFFF]/u.test(r.text[offset]??'')&&/[\uD800-\uDBFF]/u.test(r.text[offset-1]??'')),'offset never splits emoji');const text=clip(r.text.slice(offset),3000);return {...r,text,offset,nextOffset:offset+text.length,more:offset+text.length<r.text.length};},
  valid:(g,id,ids)=>{api.status(g);return ids.filter(id=>records.some(r=>r.id===id&&r.at>=since));},
  infer:async(g,messages)=>{api.status(g);calls++;assert(JSON.stringify(messages).length<=16000);const request=JSON.parse(messages[1].content);requests.push(request);const value=await answer(request);return typeof value==='string'?value:JSON.stringify(value);},
  revoke:g=>{api.status(g);revoked=true;},
 };
 const services={dataDirectory:dir,conversations:{get:()=>target.id},background:api,host:{snapshot:()=>({sessions:[target],projects:[]})}};
 let a=new Assistant(services);
 const enable=()=>{revoked=false;a.store.setState('learning',{enabled:true,grantId:grant,modelSessionId:'a',includedIds:['a'],excludedIds:[],includeHistory:since===0,dailyCalls:4});};enable();
 t.after(()=>{a.stop();fs.rmSync(dir,{recursive:true,force:true});});
 return {get a(){return a;},api,records,target,requests,calls:()=>calls,answer:fn=>answer=fn,
  add:(role,text)=>{const row={id:'r'+records.length,role,text,at:Date.now()-120000+records.length};records.push(row);return row;},
  restart:()=>{a.stop();a=new Assistant(services);},
  reauthorize:(start=0)=>{a.learning.pause();grant+='x';since=start;enable();},
 };
}

test('brief direct answers use neighboring questions but acknowledgments and third-party answers do not become user facts',async t=>{
 const f=fixture(t);f.add('assistant','您今年多大？');const age=f.add('user','36岁');
 f.answer(r=>({memories:[item(age.id,age.text,{title:'年龄',content:'用户自述36岁',topic:'age'})]}));
 await f.a.learning.tick();assert.equal(f.a.store.activeMemories()[0].content,'用户自述36岁');
 const source=f.a.store.activeMemories()[0].source;assert.deepEqual(source.refs.map(r=>r.id),[age.id]);
 f.add('assistant','您希望我继续吗？');const ack=f.add('user','好的');f.answer(()=>({memories:[item(ack.id,'好的')]}));await f.a.learning.tick();assert.equal(f.calls(),1,'an acknowledgment alone does not spend a consolidation request');
 f.add('assistant','您的朋友住在哪里？');const city=f.add('user','上海');f.answer(()=>({memories:[item(city.id,'上海',{title:'住址',topic:'city',content:'用户住在上海'})]}));await f.a.learning.tick();assert.equal(f.a.store.activeMemories().length,1,'another person is not the user');
 const orphan=f.add('user','北京');f.answer(()=>({memories:[item(orphan.id,'北京',{topic:'orphan-city'})]}));await f.a.learning.tick();assert.equal(f.a.store.activeMemories().length,1);
});

test('a question processed before shutdown still grounds the next short answer',async t=>{
 const f=fixture(t);f.add('assistant','您目前住在哪里？');await f.a.learning.tick();assert.equal(f.calls(),0);f.restart();
 const city=f.add('user','上海');f.answer(()=>({memories:[item(city.id,city.text,{title:'居住地',content:'用户居住在上海',topic:'city'})]}));await f.a.learning.tick();
 assert.equal(f.a.store.activeMemories()[0].content,'用户居住在上海');assert.equal(f.requests[0].context.at(-1).role,'assistant');
});

test('long records resume after restart and learn the tail without changing earlier source identity',async t=>{
 const f=fixture(t),quote='我希望长期安排中优先留出家人相处时间';const row=f.add('user','背景资料'.repeat(1700)+'。'+quote);
 f.answer(request=>({memories:request.records.some(r=>r.text.includes(quote))?[item(row.id,quote,{title:'家庭时间',content:'长期安排优先留出家人相处时间',topic:'family-time'})]:[]}));
 await f.a.learning.tick();const first=f.a.store.state('scan:a');assert.equal(first.cursor,null);assert(first.partial.offset>0);f.restart();
 for(let i=0;i<8&&f.a.store.state('scan:a').cursor!==row.id;i++)await f.a.learning.tick();
 assert.equal(f.a.store.state('scan:a').partial,null);assert.equal(f.a.store.state('scan:a').cursor,row.id);assert.equal(f.a.store.activeMemories()[0].source.refs[0].id,row.id);
 const parts=f.requests.flatMap(r=>r.records.filter(r=>r.id===row.id));assert.equal(parts.map(p=>p.text).join(''),row.text);assert(parts.every((p,i)=>p.offset===(i?parts.slice(0,i).reduce((n,p)=>n+p.text.length,0):0)));
});

test('escaped unicode records are continued instead of silently dropping the clipped suffix',async t=>{
 const f=fixture(t),row=f.add('user','我使用的样例文字'+('\\😀'.repeat(1800))+'以后请保留原始路径');
 for(let i=0;i<12&&f.a.store.state('scan:a')?.cursor!==row.id;i++)await f.a.learning.tick();
 const parts=f.requests.flatMap(r=>r.records.filter(r=>r.id===row.id));assert.equal(parts.map(p=>p.text).join(''),row.text);assert(parts.every(p=>p.text.isWellFormed()));assert.equal(f.a.learning.error,'');
});

test('same-scope reauthorization preserves completed progress and changed history scope is rechecked',async t=>{
 const f=fixture(t),first=f.add('user','以后回复请直接给出结论');await f.a.learning.tick();assert.equal(f.calls(),1);
 f.reauthorize();await f.a.learning.tick();assert.equal(f.calls(),1,'turning the switch on again does not repeat paid extraction');
 const next=f.add('user','我的职业是一名大学教师');await f.a.learning.tick();assert.equal(f.requests.at(-1).records[0].id,next.id);
 f.reauthorize(next.at);await f.a.learning.tick();assert(!f.requests.at(-1).records.some(r=>r.id===first.id),'new grant excludes earlier source');
});

test('rewound partial sources are abandoned rather than resuming stale text',async t=>{
 const f=fixture(t),old=f.add('user','旧的经历'.repeat(1500));await f.a.learning.tick();assert(f.a.store.state('scan:a').partial);f.records.length=0;
 const fresh=f.add('user','新的分支只保留这个明确偏好');fresh.id='new-branch';await f.a.learning.tick();assert.equal(f.a.store.state('scan:a').cursor,fresh.id);assert.equal(f.a.store.state('scan:a').partial,null);assert(!f.requests.at(-1).context?.some(r=>r.id===old.id));
});

test('transient failures back off across restart and successful recovery clears health',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=fixture(t);f.add('user','我的职业是一名大学教师');f.answer(()=>{throw Error('HTTP 502');});
 await f.a.learning.tick();assert.equal(f.calls(),1);assert.equal(f.a.learning.health().errorClass,'temporary');f.restart();await f.a.learning.tick();assert.equal(f.calls(),1);
 t.mock.timers.tick(60001);f.answer(r=>({memories:[item(r.records[0].id,r.records[0].text)]}));await f.a.learning.tick();assert.equal(f.calls(),2);assert.equal(f.a.learning.health().errorClass,null);assert(f.a.learning.health().lastSuccessAt);assert.equal(f.a.learning.health().backlog,false);
});

test('quota waiting also gates legacy recovery and preserves the pending history',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=fixture(t);f.add('user','我的职业是一名大学教师');
 f.a.store.add({title:'旧观察',content:'用户喜欢报告',kind:'preference',scope:'personal'},{type:'model-proposal',conversationId:'a'});
 f.answer(()=>{throw Error('今日后台整理额度已用完');});await f.a.learning.tick();const h=f.a.learning.health();assert.equal(h.errorClass,'quota');assert(h.retryAt>Date.now());
 await f.a.learning.tick();assert.equal(f.calls(),1,'legacy reconciliation must not bypass the target retry gate');assert.equal(f.a.store.state('scan:a').cursor,undefined);
});

test('a full candidate pool recycles weak observations without blocking a new explicit fact',async t=>{
 const f=fixture(t);
 for(let i=0;i<100;i++)f.a.store.learn({title:'观察'+i,content:'待继续观察的偏好'+i,kind:'preference',scope:'personal'},{type:'learned',namespace:'assistant-v4',topic:'observation-'+i,certainty:'inferred',context:{subject:'user'},refs:[{id:'unused'+i,conversationId:'a',quote:'独立证据'+i,at:i,fingerprint:'proof'+i}],grantId:'g1'});
 const q=f.add('user','我最近尝试先列出风险，感觉可以继续观察');const job=f.add('user','我的职业是一名大学教师');
 f.answer(()=>({memories:[item(q.id,q.text,{title:'列风险',content:'先列风险可能适合用户',topic:'new-observation',kind:'preference',certainty:'inferred'}),item(job.id,job.text)]}));
 await f.a.learning.tick();assert(f.a.store.activeMemories().some(r=>r.source.topic==='occupation'));assert.equal(f.a.store.counts().candidate,100);assert.equal(f.a.store.state('scan:a').cursor,job.id);assert.equal(f.a.learning.health().errorClass,null);
});

test('capacity defers a checked result without repeated inference and clears its warning after space is restored',async t=>{
 const f=fixture(t);const q=f.add('user','我的职业是一名大学教师');f.answer(()=>({memories:[item(q.id,q.text)]}));
 const learn=f.a.store.learn.bind(f.a.store);let full=true;f.a.store.learn=(...args)=>{if(full)throw Object.assign(Error('记忆容量已满'),{code:'MEMORY_CAPACITY'});return learn(...args);};
 await f.a.learning.tick();assert.equal(f.a.store.state('scan:a').cursor,q.id);assert.equal(f.a.learning.health().errorClass,'capacity');assert.equal(f.a.store.state('deferred:a').length,1);
 await f.a.learning.tick();assert.equal(f.calls(),1,'retrying a checked write never calls the model again');full=false;await f.a.learning.tick();assert.equal(f.calls(),1);assert.equal(f.a.store.activeMemories().length,1);assert.equal(f.a.learning.health().errorClass,null);assert.equal(f.a.learning.health().backlog,false);
});

test('deferred sources invalidated by rewind or forgetting never become memories',async t=>{
 const f=fixture(t),q=f.add('user','我的职业是一名大学教师');f.answer(()=>({memories:[item(q.id,q.text)]}));
 const learn=f.a.store.learn.bind(f.a.store);f.a.store.learn=()=>{throw Object.assign(Error('记忆容量已满'),{code:'MEMORY_CAPACITY'});};await f.a.learning.tick();f.a.store.learn=learn;f.records.length=0;await f.a.learning.tick();assert.equal(f.a.store.activeMemories().length,0);assert.equal(f.a.store.state('deferred:a').length,0);
});

test('aligned paraphrases accumulate evidence while corrections retain identity and reject unsupported IDs',async t=>{
 const f=fixture(t),q1=f.add('user','你的回答太绕了，我还是喜欢直接一点');
 f.answer(()=>({memories:[item(q1.id,q1.text,{title:'表达偏好',content:'用户倾向直接回答',kind:'preference',certainty:'inferred',topic:'direct'})]}));await f.a.learning.tick();
 const prior=f.a.store.list('candidate')[0];const q2=f.add('user','先把答案告诉我，然后再解释就行');
 f.answer(r=>{assert(r.existing.some(row=>row.id===prior.id&&row.revision===prior.revision));return {memories:[item(q2.id,q2.text,{title:'回答格式',content:'先给直接答案，再解释',kind:'preference',certainty:'inferred',topic:'new-spelling',memoryId:prior.id,revision:prior.revision,relation:'support'})]};});await f.a.learning.tick();
 const active=f.a.store.get(prior.id);assert.equal(active.state,'active');assert.equal(active.source.refs.length,2);assert.equal(active.content,prior.content);
 const q3=f.add('user','我改主意了，回答前先列出主要风险');f.answer(()=>({memories:[item(q3.id,q3.text,{title:'回答格式',content:'回答前先列主要风险',kind:'preference',topic:'another-spelling',memoryId:active.id,revision:active.revision,relation:'revise'})]}));await f.a.learning.tick();
 assert.equal(f.a.store.get(prior.id).content,'回答前先列主要风险');assert.equal(f.a.store.activeMemories().length,1);
 const q4=f.add('user','我需要保留明确的原文依据');f.answer(()=>({memories:[item(q4.id,q4.text,{memoryId:'invented-id',revision:1,relation:'revise'})]}));await f.a.learning.tick();assert.equal(f.a.store.activeMemories().length,1);
});

test('a transient database write failure reuses its extracted result after restart',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=fixture(t),q=f.add('user','我的职业是一名大学教师');f.answer(()=>({memories:[item(q.id,q.text)]}));
 f.a.store.learn=()=>{throw Error('SQLITE_BUSY');};await f.a.learning.tick();assert.equal(f.calls(),1);assert(f.a.store.state('learning-result:a'));
 f.restart();t.mock.timers.tick(60001);await f.a.learning.tick();assert.equal(f.calls(),1,'durable extraction receipt avoids another model call');assert.equal(f.a.store.activeMemories().length,1);assert.equal(f.a.store.state('learning-result:a'),null);
});

test('a disk write failure cannot turn the unattended tick into an unhandled rejection',async t=>{
 const f=fixture(t);f.add('user','我的职业是一名大学教师');const write=f.a.store.setState.bind(f.a.store);
 f.a.store.setState=()=>{throw Error('SQLITE_FULL');};await assert.doesNotReject(f.a.learning.tick());assert.equal(f.a.learning.health().errorClass,'temporary');assert.equal(f.a.learning.health().backlog,true);f.a.store.setState=write;
});

test('filtered pre-grant records remain valid scan positions and do not trap authorized messages behind them',async t=>{
 const f=fixture(t);for(let i=0;i<80;i++)f.add('user','较早的历史记录'+i);const q=f.add('user','我的职业是一名大学教师');
 f.reauthorize(q.at);f.answer(r=>({memories:[item(q.id,q.text)]}));
 await f.a.learning.tick();assert.equal(f.a.store.state('scan:a').cursor,f.records[39].id);assert.equal(f.calls(),0);
 await f.a.learning.tick();assert.equal(f.a.store.state('scan:a').cursor,f.records[79].id);assert.equal(f.calls(),0);
 await f.a.learning.tick();assert.equal(f.a.store.state('scan:a').cursor,q.id);assert.equal(f.calls(),1);assert.equal(f.a.store.activeMemories().length,1);
 assert.deepEqual(f.requests[0].records.map(r=>r.id),[q.id],'no pre-grant content enters the request');
});

test('scan checkpoint failure keeps the paid extraction receipt for restart recovery',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=fixture(t),q=f.add('user','我的职业是一名大学教师');f.answer(()=>({memories:[item(q.id,q.text)]}));
 const write=f.a.store.setState.bind(f.a.store);f.a.store.setState=(key,value)=>{if(key==='scan:a'&&value?.cursor===q.id)throw Error('SQLITE_BUSY while committing cursor');return write(key,value);};
 await f.a.learning.tick();assert.equal(f.calls(),1);assert.equal(f.a.store.activeMemories().length,1);assert.notEqual(f.a.store.state('scan:a').cursor,q.id);assert(f.a.store.state('learning-result:a'));
 f.restart();t.mock.timers.tick(60001);await f.a.learning.tick();assert.equal(f.calls(),1,'successful extraction is reused when checkpoint commit is retried');assert.equal(f.a.store.state('scan:a').cursor,q.id);assert.equal(f.a.store.state('learning-result:a'),null);assert.equal(f.a.store.activeMemories().length,1);
});

test('forgetting during inference cannot restore removed source text through the scan context checkpoint',async t=>{
 const f=fixture(t),q=f.add('user','我最喜欢的颜色是深海蓝色');f.answer(()=>({memories:[item(q.id,q.text,{title:'颜色偏好',content:'用户喜欢深海蓝色',kind:'preference',topic:'color'})]}));await f.a.learning.tick();const old=f.a.store.activeMemories()[0];
 const fresh=f.add('user','回复我时请先给结论再解释依据');let finish;f.answer(()=>new Promise(resolve=>finish=resolve));
 const task=f.a.learning.tick();assert(finish);f.a.store.forget(old.id,old.revision);
 assert(!JSON.stringify(f.a.store.db.prepare('SELECT value FROM learning_state').all()).includes('深海蓝色'),'forget immediately removes the cached source');
 finish({memories:[item(fresh.id,fresh.text,{title:'表达偏好',content:'回复时先结论后依据',kind:'preference',topic:'style'})]});await task;
 assert(!JSON.stringify(f.a.store.db.prepare('SELECT value FROM learning_state').all()).includes('深海蓝色'),'the late checkpoint must not restore forgotten derived text');
 assert(f.a.store.activeMemories().some(r=>r.source.topic==='style'),'unrelated valid information still commits');
 assert.equal(f.a.store.state('learning-result:a'),null);
});

test('invalidated evidence or a changed target scope is rejected before persisting the extraction receipt',async t=>{
 for(const change of ['rewind','scope'])await t.test(change,async t=>{
  const f=fixture(t),q=f.add('user','我的职业是一名大学教师');let finish;f.answer(()=>new Promise(resolve=>finish=resolve));
  const written=[],write=f.a.store.setState.bind(f.a.store);f.a.store.setState=(key,value)=>{if(key==='learning-result:a'&&value)written.push(value);return write(key,value);};
  const task=f.a.learning.tick();assert(finish);
  if(change==='rewind')f.records.length=0;else f.target.cwd=path.join(f.target.cwd,'different');
  finish({memories:[item(q.id,q.text)]});await task;
  assert.equal(written.length,0,'late data outside the live evidence/scope is never cached');assert.equal(f.a.store.activeMemories().length,0);
 });
});
