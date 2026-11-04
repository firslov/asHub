import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Assistant } from '../shared.mjs';
import { recall, withMemory } from '../context.mjs';

function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-global-'));
  const snapshot={sessions:[{instanceId:'a',kind:'agent',cwd:'/a',projectId:'p'},{instanceId:'b',kind:'agent',cwd:'/b',projectId:'q'}],projects:[{id:'p',name:'星河项目'},{id:'q',name:'海川项目'}]};
  const validIds=new Set(['a:u1','a:u2','b:u3','b:u4']); let excluded=[],revoked=false,validCalls=0,inferences=0;
  const api={status:()=>{if(revoked)throw Error('revoked');return {excludedIds:excluded};}, targets:()=>{if(revoked)throw Error('revoked');return snapshot.sessions.filter(s=>!excluded.includes(s.instanceId)).map(s=>({...s,id:s.instanceId}));},valid:(_g,id,ids)=>{validCalls++;return ids.filter(ref=>validIds.has(id+':'+ref));},infer:()=>{inferences++;throw Error('Recall must stay local');}};
  const a=new Assistant({dataDirectory:directory,background:api,host:{snapshot:()=>structuredClone(snapshot)}});
  a.store.setState('learning',{enabled:true,grantId:'g',excludedIds:[],dailyCalls:4});
  t.after(()=>{a.stop();fs.rmSync(directory,{recursive:true,force:true});});
  const source=(values={})=>({type:'learned',topic:'biography',certainty:'explicit',refs:[{id:'u1',conversationId:'a',quote:'我是一名35岁的物理教师',at:1000,fingerprint:'proof'}],grantId:'g',aliases:[],at:2000,...values});
  const input=(values={})=>({title:'职业与年龄',content:'用户自述为35岁的物理教师',kind:'fact',scope:'conversation:a',...values});
  return {a,snapshot,source,input,validIds,exclude:ids=>excluded=ids,revoke:()=>revoked=true,validCalls:()=>validCalls,inferences:()=>inferences,directory};
}

test('old local facts are globally recalled without rewriting IDs, history or source proof',t=>{
  const f=fixture(t),row=f.a.store.add(f.input(),f.source(),'active');
  const old=f.a.store.db.prepare('SELECT * FROM memories WHERE id=?').get(row.id),history=f.a.store.history(row.id);
  for(const query of ['你知道我几岁吗','我教授哪个学科','你对我的了解有哪些']) {
    assert.equal(f.a.search('b',query)[0].id,row.id);
    const memory=JSON.parse(recall(f.a,'b',query));assert.equal(memory.items[0].id,row.id);assert.equal(memory.items[0].observedAt,1000);
    assert.equal(memory.items[0].context.conversationId,'a');
  }
  assert.equal(f.a.read('b',row.id).scope,'global');
  assert.deepEqual(f.a.store.db.prepare('SELECT * FROM memories WHERE id=?').get(row.id),old);
  assert.deepEqual(f.a.store.history(row.id),history);assert.equal(f.inferences(),0);
  const request=[{role:'user',content:'帮我算一下二加二'}];assert.equal(withMemory(request,f.a,'b'),request,'unrelated tasks do not receive a profile');
});

test('project context is globally searchable but not automatically mixed into another project',t=>{
  const f=fixture(t),row=f.a.store.add(f.input({title:'发布规范',content:'星河项目发布时必须检查服务甲',scope:'project:p'}),{type:'user'},'active');
  assert.equal(f.a.search('b','发布规范')[0].id,row.id);
  assert.equal(recall(f.a,'b','准备发布'),null);
  assert.match(recall(f.a,'a','准备发布'),/检查服务甲/);
  assert.match(recall(f.a,'b','星河项目发布要检查什么'),/检查服务甲/);
  assert.equal(f.a.read('b',row.id).context.projectId,'p');
});

test('archival retains verified memory; rewind, exclusions, pause and revoked grants still suppress recall',t=>{
  const f=fixture(t),row=f.a.store.add(f.input(),f.source(),'active');
  assert.equal(f.a.search('b','年龄').length,1);
  f.validIds.delete('a:u1');assert.equal(f.a.search('b','年龄').length,0,'live branch rewind');f.validIds.add('a:u1');
  f.snapshot.sessions.shift();assert.equal(f.a.search('b','年龄').length,1,'archived source no longer a target');
  f.exclude(['a']);assert.equal(f.a.search('b','年龄').length,0);assert.throws(()=>f.a.read('b',row.id));
  f.a.store.bind('b','/b',true);f.exclude(['b']);assert.equal(f.a.scope('b'),null,'manual binding cannot bypass explicit exclusion');
  f.exclude([]);const p=f.a.store.profile();f.a.store.configure({...p,enabled:false},p.revision);assert.equal(recall(f.a,'b','年龄'),null);
  const p2=f.a.store.profile();f.a.store.configure({...p2,enabled:true},p2.revision);f.revoke();assert.equal(f.a.scope('b'),null);
});

test('duplicate self descriptions share one recall and forgetting one prevents evidence replay',t=>{
  const f=fixture(t),one=f.a.store.add(f.input(),f.source(),'active');
  f.a.store.add(f.input({title:'背景',content:'用户自述为35岁的物理教师。'}),f.source({topic:'legacy-duplicate'}),'active');
  assert.equal(f.a.store.counts().active,2,'no destructive semantic merge');
  assert.equal(f.a.search('b','年龄').length,1);
  assert.equal(JSON.parse(recall(f.a,'b','年龄')).items.length,1);
  f.a.store.forget(one.id,one.revision);assert.equal(f.a.search('b','年龄').length,0);
});

test('cross-conversation corrections preserve identity, reject older backfill, respect edits and forgetting',t=>{
  const f=fixture(t),old=f.a.store.learn(f.input(),f.source());
  const nextSource=f.source({refs:[{id:'u3',conversationId:'b',quote:'我是一名36岁的物理教师',at:3000,fingerprint:'new'}]});
  const next=f.a.store.learn(f.input({content:'用户自述为36岁的物理教师',scope:'personal'}),nextSource);
  assert.equal(next.id,old.id);assert.equal(next.revision,2);assert.equal(next.scope,'personal');assert.equal(f.a.store.counts().active,1);
  assert.equal(f.a.store.learn(f.input(),f.source()).id,old.id);assert.equal(f.a.store.get(old.id).content,next.content,'old history does not undo a newer correction');
  const edited=f.a.store.edit(next.id,next.revision,{...next,content:'用户手工定稿的职业记录'});
  assert.equal(f.a.store.learn(f.input(),nextSource).content,edited.content);
  f.a.store.forget(edited.id,edited.revision);assert.equal(f.a.store.learn(f.input(),nextSource).state,'forgotten');
});

test('legacy topic updates retain IDs across contexts and do not reinterpret quoted fictional biographies',t=>{
  const f=fixture(t),old=f.a.store.add(f.input(),f.source(),'active');
  f.a.store.setState('topic:conversation:a:biography',old.id);
  const next=f.a.store.learn(f.input({scope:'personal',content:'用户自述为36岁的物理教师'}),f.source({refs:[{id:'u3',conversationId:'b',quote:'我是一名36岁的物理教师',at:3000,fingerprint:'new'}]}));
  assert.equal(next.id,old.id);
  const fictional=f.a.store.add(f.input({scope:'project:p',title:'小说角色',content:'小说角色是一位35岁教师'}),f.source({topic:'fiction',refs:[{id:'u2',conversationId:'a',quote:'假设我是一名35岁的物理教师',at:1,fingerprint:'fiction'}]}),'active');
  assert.equal(fictional.source.context.subject,'project');
  assert(!JSON.parse(recall(f.a,'b','我几岁')).items.some(r=>r.id===fictional.id));
});

test('bounded recall keeps conditions and timestamps, avoids single-character noise and preserves tool requests',t=>{
  const f=fixture(t);
  for(let i=0;i<8;i++) f.a.store.add(f.input({title:'报告要求'+i,content:'报告需要检查指标'+i,kind:'preference',scope:'personal'}),{type:'user',userOperation:String(i)},'active');
  const out=recall(f.a,'b','整理报告'),data=JSON.parse(out);assert.equal(data.items.length,4);assert(data.more);assert(data.items.reduce((n,r)=>n+JSON.stringify(r).length,0)<=2400);
  assert.equal(recall(f.a,'b','报'),null,'one common Chinese character does not recall unrelated information');
  f.a.store.add(f.input({title:'语言',content:'使用中文回答',kind:'preference',scope:'personal'}),{type:'user'},'active');
  const messages=[{role:'user',content:'你好'},{role:'tool',tool_call_id:'t',content:'原结果'}];const before=structuredClone(messages),result=withMemory(messages,f.a,'b');
  assert.equal(result.at(-1).tool_call_id,'t');assert.match(result.at(-1).content,/使用中文回答/);assert.deepEqual(messages,before);
  assert.equal(f.inferences(),0);
});

test('shared source verification is memoized within a retrieval and separate profiles never share a store',t=>{
  const f=fixture(t);for(let i=0;i<8;i++)f.a.store.add(f.input({title:'背景'+i,content:'用户自述为35岁教师'+i}),f.source({topic:'topic'+i}),'active');
  const before=f.validCalls();f.a.search('b','年龄');assert.equal(f.validCalls()-before,1);
  const secondDir=path.join(f.directory,'other'),other=new Assistant({dataDirectory:secondDir,host:{snapshot:()=>f.snapshot}});
  try {other.store.bind('b','/b',true);assert.deepEqual(other.search('b','年龄'),[]);}finally{other.stop();}
});

test('different facts supported by the same user sentence are never collapsed as duplicates',t=>{
  const f=fixture(t);
  f.a.store.add(f.input({content:'用户自述为35岁'}),f.source(),'active');
  f.a.store.add(f.input({title:'学科',content:'用户教授物理学科'}),f.source({topic:'discipline'}),'active');
  assert.equal(JSON.parse(recall(f.a,'b','你对我的了解有哪些')).items.length,2);
  assert.match(f.a.search('b','我教哪个学科')[0].content,/物理/);
});

test('topic domains separate user and assistant; retired memories cannot be resurrected by learning',t=>{
  const f=fixture(t),user=f.a.store.learn(f.input({scope:'personal'}),f.source());
  f.a.store.setState('topic:personal:biography',user.id);
  const assistant=f.a.store.learn(f.input({scope:'personal',content:'助手叫小星'}),f.source({context:{subject:'assistant'},refs:[{id:'u3',conversationId:'b',quote:'助手叫小星',at:3000,fingerprint:'assistant'}]}));
  assert.notEqual(assistant.id,user.id);assert.equal(f.a.store.get(user.id).content,user.content);
  const replacement=f.a.store.add({...user,replaces:user.id,replacesRevision:user.revision,content:'用户重新确认的职业信息'},{type:'user'});
  f.a.store.approve(replacement.id,replacement.revision);
  assert.equal(f.a.store.learn(f.input({scope:'personal'}),f.source()).state,'retired');assert.equal(f.a.store.get(user.id).state,'retired');
});

test('deduplication preserves significant punctuation and distinct project contexts',t=>{
  const f=fixture(t);
  for(const [index,content] of ['额度为1.5万元','额度为15万元'].entries())f.a.store.add(f.input({content,scope:'personal'}),{type:'user',userOperation:String(index)},'active');
  assert.equal(f.a.search('b','额度').length,2);
  for(const id of ['p','q'])f.a.store.add(f.input({content:'发布需要审批',scope:'project:'+id}),{type:'user'},'active');
  assert.equal(f.a.search('b','发布').length,2);
});

test('new explicit personal facts retain project provenance while becoming global and legacy candidates adapt in place',t=>{
  const f=fixture(t),quote='我是一名35岁的物理教师',target={id:'a',projectId:'p'},records=[{id:'u1',role:'user',text:quote,at:1000}];
  const checked=f.a.learning.check({title:'个人背景',content:quote,kind:'fact',topic:'biography',scope:'personal',subject:'user',certainty:'explicit',aliases:[],evidence:[{id:'u1',quote}]},records,target,'g');
  assert.equal(checked.value.scope,'personal');assert.equal(checked.source.context.projectId,'p');assert.equal(checked.source.context.projectName,'星河项目');
  const old=f.a.store.add(f.input(),{type:'model-proposal',conversationId:'a'});
  const migrated=f.a.store.adoptLegacy(old.id,old.revision,checked.value,checked.source);
  assert.equal(migrated.id,old.id);assert.equal(migrated.state,'active');assert.equal(f.a.read('b',old.id).scope,'global');
});

test('forgetting one fact does not hide a different fact from the same original user sentence',t=>{
  const f=fixture(t),age=f.a.store.learn(f.input({content:'用户自述为35岁'}),f.source({topic:'age'}));
  const subject=f.a.store.learn(f.input({title:'学科',content:'用户教授物理学科'}),f.source({topic:'discipline'}));
  f.a.store.forget(age.id,age.revision);
  assert.equal(f.a.read('b',subject.id).id,subject.id);
  assert.equal(f.a.search('b','物理学科')[0].id,subject.id);
});

test('forgetting a legacy local topic before its first global update blocks cross-conversation resurrection',t=>{
  const f=fixture(t),old=f.a.store.add(f.input(),f.source(),'active');
  f.a.store.setState('topic:conversation:a:biography',old.id);
  f.a.store.forget(old.id,old.revision);
  const next=f.a.store.learn(f.input({scope:'personal'}),f.source({refs:[{id:'u3',conversationId:'b',quote:'我是一名35岁的物理教师',at:3000,fingerprint:'new'}]}));
  assert.equal(next.state,'forgotten');assert.equal(f.a.store.counts().active??0,0);
});

test('forget fingerprints preserve word boundaries, decimal values, case, and manual recreation',t=>{
  const f=fixture(t);
  const old=f.a.store.learn(f.input({content:'API field is userID'}),f.source({topic:'api-field'}));
  const other=f.a.store.learn(f.input({content:'API field is userid'}),f.source({topic:'other-field'}));
  f.a.store.forget(old.id,old.revision);
  assert.equal(f.a.read('b',other.id).content,other.content);
  const recreated=f.a.store.add(f.input({content:old.content}),{type:'user',userOperation:'explicit-recreate'},'active');
  assert.equal(f.a.read('b',recreated.id).content,old.content);
  const alternate=f.a.store.learn(f.input({content:old.content}),f.source({topic:'alternate-name'}));
  assert.equal(alternate.state,'forgotten','renaming a topic cannot replay exact forgotten content');
  const legacy=f.a.store.add(f.input({content:old.content}),{type:'model-proposal',conversationId:'a'});
  assert.equal(f.a.store.adoptLegacy(legacy.id,legacy.revision,f.input({content:old.content}),f.source()),null);
  assert.equal(f.a.store.get(legacy.id).state,'candidate','legacy reconciliation must honor forgetting too');
});

test('older independent evidence can corroborate an unchanged candidate without undoing newer corrections',t=>{
  const f=fixture(t),value=f.input({title:'汇报偏好',content:'用户偏好先列风险再给建议',kind:'preference',scope:'personal'});
  const newer=f.source({topic:'report-risk',certainty:'inferred',refs:[{id:'u3',conversationId:'b',quote:'先看看风险再谈建议吧',at:2000,fingerprint:'newer'}]});
  const older=f.source({topic:'report-risk',certainty:'inferred',refs:[{id:'u1',conversationId:'a',quote:'汇报时先说风险会比较好',at:1000,fingerprint:'older'}]});
  const candidate=f.a.store.learn(value,newer);assert.equal(candidate.state,'candidate');
  const supported=f.a.store.learn(value,older);
  assert.equal(supported.id,candidate.id);assert.equal(supported.state,'active');assert.equal(supported.source.refs.length,2);
  assert.equal(supported.source.context.conversationId,'b','earlier evidence must not replace newer provenance');
  assert.equal(f.a.read('b',supported.id).observedAt,2000);
  const correction=f.a.store.learn({...value,content:'汇报应先给建议再列风险'},f.source({topic:'report-risk',refs:[{id:'u4',conversationId:'b',quote:'以后请先给建议再列风险',at:3000,fingerprint:'correction'}]}));
  assert.equal(f.a.store.learn(value,older).content,correction.content,'older conflicting content still cannot overwrite a correction');
});

test('English age expansion does not match fragments inside image, storage, usage or language',t=>{
  const f=fixture(t);
  f.a.store.add(f.input({title:'Image storage',content:'Application usage and language configuration',scope:'project:q'}),{type:'user'},'active');
  assert.equal(recall(f.a,'b','How old am I?'),null);
  assert.deepEqual(f.a.search('b','How old am I?'),[]);
  const real=f.a.store.add(f.input({title:'Background',content:'Age: 35',scope:'personal'}),{type:'user'},'active');
  assert.deepEqual(f.a.search('b','How old am I?').map(r=>r.id),[real.id]);
});

test('out-of-order corroboration stays bounded, keeps the latest evidence and does not count copied text twice',t=>{
  const f=fixture(t),value=f.input({title:'汇报偏好',content:'用户偏好先列风险再给建议',kind:'preference',scope:'personal'});
  const source=(id,at,fingerprint)=>f.source({topic:'backfill-order',certainty:'inferred',refs:[{id,conversationId:'a',quote:'不同用户依据'+id,at,fingerprint}]});
  const first=f.a.store.learn(value,source('latest',5000,'same-text'));
  const copy=f.a.store.learn(value,source('copy',4000,'same-text'));assert.equal(copy.state,'candidate','copied text is not independent evidence');
  for(let i=0;i<20;i++)f.a.store.learn(value,source('older'+i,1000+i,'distinct'+i));
  const row=f.a.store.get(first.id);assert.equal(row.state,'active');assert.equal(row.source.refs.length,12);assert(row.source.refs.some(r=>r.id==='latest'));
  assert.equal(Math.max(...row.source.refs.map(r=>r.at)),5000);
  const attempted=f.a.store.learn({...value,content:'一条较旧且冲突的结论'},source('conflict',4500,'conflict'));
  assert.equal(attempted.content,value.content);
});

test('global inferred preferences accumulate independent evidence across source projects in either arrival order',async t=>{
 for(const reverse of [false,true]) await t.test(reverse?'older evidence arrives last':'newer evidence arrives last',async t=>{
  const f=fixture(t),a=f.a;
  const entries=[{id:'u1',role:'user',text:'我通常会先看结论，再读分析依据',at:1000},{id:'u3',role:'user',text:'我习惯先抓结论，然后再看详细依据',at:2000}];
  const item=e=>({title:'阅读偏好',content:'用户偏好先看结论，再看依据',kind:'preference',scope:'local',subject:'user',certainty:'inferred',topic:'reading-style',aliases:[],evidence:[{id:e.id,quote:e.text}]});
  for(const index of reverse?[1,0]:[0,1]) {
   a.services.background.infer=async()=>JSON.stringify({memories:[item(entries[index])]});
   const s=f.snapshot.sessions[index];
   await a.learning.processBatch(a.learning.config(),{...s,id:s.instanceId},[entries[index]],new AbortController().signal);
  }
  const row=a.store.list('all')[0];
  assert.equal(row.state,'active','two independent global observations should corroborate');
  assert.equal(row.source.refs.length,2);assert.equal(row.scope,'project:q');
  assert.equal(row.source.context.projectId,'q');assert.equal(row.source.context.conversationId,'b');
  assert.equal(a.search('a','阅读偏好')[0].id,row.id);
  assert.equal(a.store.counts().active,1);
 });
});

test('corroboration across origins keeps project rules separate and cannot overwrite a newer global correction',t=>{
 const f=fixture(t),a=f.a;
 const input=scope=>({title:'阅读偏好',content:'偏好先看结论，再看依据',kind:'preference',scope});
 const source=(who,subject,at,quote)=>f.source({topic:'reading-style',certainty:'inferred',context:{subject,projectId:who==='a'?'p':'q',conversationId:who},refs:[{id:who==='a'?'u1':'u3',conversationId:who,at,quote,fingerprint:quote}]});
 const p=a.store.learn(input('project:p'),source('a','project',1000,'星河项目应先汇报结论'));
 const q=a.store.learn(input('project:q'),source('b','project',2000,'海川项目应先汇报结论'));
 assert.notEqual(p.id,q.id);assert.equal(p.state,'candidate');assert.equal(q.state,'candidate');
 const first=a.store.learn(input('project:p'),source('a','user',1000,'我习惯先看结论'));
 const corrected=a.store.learn({...input('personal'),content:'偏好先列风险，再给建议'},{...source('b','user',3000,'以后请先列风险再给建议'),certainty:'explicit'});
 assert.equal(corrected.id,first.id);
 const late=a.store.learn(input('project:p'),source('a','user',2000,'我通常会先读结论'));
 assert.equal(late.content,corrected.content);assert.equal(late.scope,'personal');assert.equal(late.source.refs.length,1);
 assert.equal(a.store.counts().active,1);assert.equal(a.store.counts().candidate,2);
});
