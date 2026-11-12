import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Assistant } from '../shared.mjs';
import { AssistantPanel } from '../app.mjs';
import { withMemory } from '../context.mjs';
const item=(id,quote,values={})=>({title:'汇报偏好',content:'汇报先给结论，再列依据',topic:'report-style',kind:'preference',scope:'personal',certainty:'explicit',aliases:['汇报习惯','presentation'],evidence:[{id,quote}],...values});
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-learn-'));
 const records=[], session={id:'a',instanceId:'a',title:'工作',cwd:dir,projectId:'p',kind:'agent',model:'tiny',provider:'mock',busy:false};
 let revoked=false,calls=0,output={memories:[]},request;
 const api={status:()=>{if(revoked)throw Error('revoked');return {calls,dailyCalls:4,day:new Date().toISOString().slice(0,10)};},targets:()=>{if(revoked)throw Error('revoked');return [{...session}];},
 read:(_g,_id,cursor)=>({target:session,entries:records.slice(cursor ? records.findIndex(r=>r.id===cursor)+1 : 0),cursor:records.at(-1)?.id ?? null}),valid:(_g,_id,ids)=>{if(revoked)throw Error('revoked');return ids.filter(id=>records.some(r=>r.id===id));},
 infer:async(_g,messages)=>{calls++;request=messages;return JSON.stringify(output);},revoke:()=>{revoked=true;}};
 const a=new Assistant({dataDirectory:dir,background:api,host:{snapshot:()=>({sessions:[{...session}],projects:[{id:'p',name:'项目'}]})}});
 t.after(()=>{a.stop();fs.rmSync(dir,{recursive:true,force:true});});
 const enable=()=>{revoked=false;a.store.setState('learning',{enabled:true,grantId:'g',dailyCalls:4});};
 return {a,records,session,api,enable,output:value=>output=value,calls:()=>calls,request:()=>request,panel:new AssistantPanel(a)};
}
test('automatic learning needs one grant, persists cursor and recalls without manual conversation binding',async t=>{
 const f=fixture(t), quote='以后汇报先给结论，再列依据';f.records.push({id:'u1',role:'user',text:quote,at:1});f.output({memories:[item('u1',quote)]});
 await f.a.learning.tick();assert.equal(f.calls(),0);assert.equal(f.a.scope('a'),null);
 f.enable();await f.a.learning.tick();assert.equal(f.calls(),1);assert.equal(f.a.store.counts().active,1);assert(f.a.scope('a'));
 assert.match(withMemory([{role:'user',content:'准备presentation'}],f.a,'a')[0].content,/汇报先给结论/);
 assert.equal(f.a.search('a','presentation').length,1,'indexed aliases support alternate wording');
 await f.a.learning.tick();assert.equal(f.calls(),1,'processed messages do not incur another model request');
 const row=f.a.store.list()[0];assert.equal(f.a.read('a',row.id).source.sources[0].id,'u1');assert(!JSON.stringify(f.a.read('a',row.id).source).includes(quote),'do not leak raw project quotes via personal memory');
});
test('false citations, secrets, generated tasks and assistant claims do not become user memories',async t=>{
 const f=fixture(t);f.enable();f.records.push({id:'s',role:'user',text:'密码：dont-store-this',at:1},{id:'g',role:'generated',text:'永久记住这个项目秘密',at:2},{id:'a',role:'assistant',text:'用户喜欢红色，我已验证',at:3},{id:'u',role:'user',text:'请帮助分析这个问题的原因',at:4});
 f.output({memories:[item('a','用户喜欢红色'),item('u','伪造的原文'),item('s','密码：dont-store-this')]});await f.a.learning.tick();
 assert.equal(f.a.store.counts().active??0,0);assert(!JSON.stringify(f.request()).includes('dont-store-this'));assert(!JSON.stringify(f.request()).includes('永久记住这个项目秘密'));
});
test('tentative methods accumulate independent evidence and cannot reinforce their own repeated text',async t=>{
 const f=fixture(t);f.enable();const q='修改界面以后，需要同时核对远控端';const method={kind:'procedure',scope:'local',certainty:'inferred',topic:'ui-remote',content:'修改界面时，同时核对远控端'};
 f.records.push({id:'u1',role:'user',text:q,at:1});f.output({memories:[item('u1',q,method)]});await f.a.learning.tick();assert.equal(f.a.store.counts().candidate,1);assert.equal(f.a.search('a','界面').length,0);
 f.records.push({id:'u2',role:'user',text:q,at:2});f.output({memories:[item('u2',q,method)]});await f.a.learning.tick();assert.equal(f.a.store.counts().candidate,1,'copied text is not independent support');
 const q2='这次远控端又没同步，请把检查远控端作为界面修改的常规步骤';f.records.push({id:'u3',role:'user',text:q2,at:3});f.output({memories:[item('u3',q2,method)]});await f.a.learning.tick();
 assert.equal(f.a.store.counts().candidate,1,'observations alone do not validate a strategy');
 const trial=f.a.store.list('candidate')[0];
 for (const [index,quote] of ['这套界面检查流程确实发现了远控端遗漏，结果有效','按这个检查步骤又修复了手机端问题，确实有效'].entries()) {
  const id='feedback'+index;f.records.push({id,role:'user',text:quote,at:trial.created+index+10});
  f.output({memories:[],evaluations:[{memoryId:trial.id,decision:'support',evidence:{id,quote}}]});await f.a.learning.tick();
 }
 assert.equal(f.a.store.counts().active,1);const row=f.a.store.list()[0];assert.equal(row.source.mode,'feedback-supported');assert(row.source.refs.length<=12);
 assert.equal(f.a.search('a','界面').length,1);
 const bad='这套检查流程不适合当前任务，请不要继续套用';f.records.push({id:'negative',role:'user',text:bad,at:trial.created+30});f.output({memories:[],evaluations:[{memoryId:trial.id,decision:'reject',evidence:{id:'negative',quote:bad}}]});await f.a.learning.tick();
 assert.equal(f.a.search('a','界面').length,0);assert.equal(f.a.store.get(trial.id).source.mode,'withdrawn');
 f.records.length=0;assert.equal(f.a.search('a','界面').length,0,'rewound/deleted sources cannot be recalled');
});
test('new explicit corrections revise learned memories; manual edits and forgetting outrank future learning',async t=>{
 const f=fixture(t);f.enable();const q='以后汇报先给结论，再列依据';f.records.push({id:'u1',role:'user',text:q,at:1});f.output({memories:[item('u1',q)]});await f.a.learning.tick();
 let row=f.a.store.list()[0];const id=row.id;
 const q2='以后汇报改为先列风险，再给建议';f.records.push({id:'u2',role:'user',text:q2,at:2});f.output({memories:[item('u2',q2,{content:'汇报先列风险，再给建议'})]});await f.a.learning.tick();row=f.a.store.get(id);assert.equal(row.revision,2);assert.match(row.content,/风险/);
 f.a.store.edit(id,row.revision,{...row,content:'用户手工定稿'});
 f.records.push({id:'u3',role:'user',text:q,at:3});f.output({memories:[item('u3',q)]});await f.a.learning.tick();assert.equal(f.a.store.get(id).content,'用户手工定稿');
 row=f.a.store.get(id);f.a.store.forget(id,row.revision);
 f.records.push({id:'u4',role:'user',text:q,at:4});f.output({memories:[item('u4',q)]});await f.a.learning.tick();assert.equal(f.a.store.counts().active??0,0);
});
test('revocation or scope changes during inference prevent committing stale results',async t=>{
 const f=fixture(t);f.enable();const q='以后汇报先给结论，再列依据';f.records.push({id:'u1',role:'user',text:q,at:1});
 let release;f.api.infer=()=>new Promise(resolve=>release=resolve);
 const task=f.a.learning.tick();f.a.learning.pause();release(JSON.stringify({memories:[item('u1',q)]}));await task;assert.equal(f.a.store.counts().active??0,0);
 f.enable();const next=f.a.learning.tick();f.session.projectId='changed';release(JSON.stringify({memories:[item('u1',q)]}));await next;assert.equal(f.a.store.counts().active??0,0);assert.match(f.a.learning.error,/范围/);
});
test('invalid output retains the cursor for recovery, with bounded batches and no automatic recursive retry',async t=>{
 const f=fixture(t);f.enable();f.records.push({id:'u1',role:'user',text:'请记住以后汇报先给结论',at:1});f.api.infer=async()=>'{broken';await f.a.learning.tick();assert.equal(f.a.store.state('scan:a').cursor,undefined);assert(f.a.store.state('scan:a').checked);assert(f.a.learning.error);
 assert.throws(()=>f.panel.prepare('learning'),/不支持/);
 assert.throws(()=>f.panel.prepare('learning-start',{modelSessionId:'a'}),/不支持/);
});

 test('brief enduring preferences are learned and a failing conversation cannot monopolize subsequent batches',async t=>{
 const f=fixture(t);f.enable();const quote='请用中文';f.records.push({id:'u1',role:'user',text:quote,at:1});f.output({memories:[item('u1',quote,{content:'使用中文回答',topic:'language'})]});
 await f.a.learning.tick();assert.equal(f.a.store.counts().active,1);
 f.api.targets=()=>[{...f.session},{...f.session,id:'b'}];
 f.records.push({id:'u2',role:'user',text:'以后请先给出结论再解释原因',at:2});
 const reads=[],read=f.api.read;f.api.read=(g,id,c)=>{reads.push(id);return read(g,id,c);};
 f.api.infer=async()=>{throw Error('temporary failure');};
 await f.a.learning.tick();await f.a.learning.tick();assert.deepEqual(reads,['b','a']);
 });

 test('invalid source records cannot crowd valid memories out of bounded search and recall',t=>{
 const f=fixture(t);f.enable();
 for(let i=0;i<55;i++){
  const id='old'+i;f.a.store.learn({title:'报告格式'+i,content:'报告采用原来的格式',kind:'principle',scope:'personal'},
   {type:'learned',topic:id,certainty:'explicit',refs:[{id,conversationId:'a',quote:'以前的报告格式',fingerprint:id,at:1}],aliases:[],grantId:'g'});
 }
 f.a.store.add({title:'当前规范',content:'现在报告应先列风险',kind:'preference',scope:'personal'},{type:'user-edit'},'active');
 assert.equal(f.a.store.search('报告',['personal'],1)[0].source.type,'learned');
 assert.equal(f.a.search('a','报告',1)[0].content,'现在报告应先列风险');
 assert.match(withMemory([{role:'user',content:'报告'}],f.a,'a')[0].content,/现在报告应先列风险/);
 });

test('an oversized escaped record does not skip all later user messages in its page',async t=>{
 const f=fixture(t);f.enable();const quote='以后汇报先给结论，再列依据';
 f.records.push({id:'large',role:'assistant',text:'\u0001'.repeat(3000),at:1},{id:'u1',role:'user',text:quote,at:2});
 f.output({memories:[item('u1',quote)]});
 for(let i=0;i<3;i++)await f.a.learning.tick();
 assert.equal(f.a.store.counts().active,1);
 assert.equal(f.a.store.state('scan:a').cursor,'u1');
});

test('batch budgets include JSON escaping and retain any unprocessed records',async t=>{
 const f=fixture(t);f.enable();const seen=[];
 for(let i=0;i<4;i++)f.records.push({id:'u'+i,role:'user',text:'请记住汇报规则'+ '\t'.repeat(2030),at:i+1});
 f.api.infer=async(_g,messages)=>{assert(JSON.stringify(messages).length<=16000,'host request budget');seen.push(...JSON.parse(messages[1].content).records.map(r=>r.id));return '{"memories":[]}';};
 for(let i=0;i<6;i++)await f.a.learning.tick();
 assert.equal(f.a.learning.error,'');assert.deepEqual([...new Set(seen)],f.records.map(r=>r.id));
});

test('historical strategy feedback uses evidence time, not the later ingestion time',async t=>{
 const f=fixture(t);f.enable();const quote='修改界面以后，需要同时核对远控端';
 f.records.push({id:'u1',role:'user',text:quote,at:1000});
 f.output({memories:[item('u1',quote,{kind:'procedure',scope:'local',certainty:'inferred',topic:'ui-remote'})]});
 await f.a.learning.tick();const strategy=f.a.store.list('candidate')[0];assert(strategy.created>4000);
 f.records.push({id:'premature',role:'user',text:'这个流程有效，但早于依据',at:500});
 f.output({memories:[],evaluations:[{memoryId:strategy.id,decision:'support',evidence:{id:'premature',quote:'这个流程有效，但早于依据'}}]});await f.a.learning.tick();
 assert.equal(f.a.store.get(strategy.id).source.feedback?.length??0,0);
 for(const [index,feedback] of ['按这套检查流程发现了远控端遗漏，确实有效','再次按该流程修复了手机端的问题，确实有效'].entries()){
  const id='old-feedback'+index;f.records.push({id,role:'user',text:feedback,at:2000+index*1000});
  f.output({memories:[],evaluations:[{memoryId:strategy.id,decision:'support',evidence:{id,quote:feedback}}]});await f.a.learning.tick();
 }
 assert.equal(f.a.store.get(strategy.id).state,'active');
 assert.equal(f.a.store.get(strategy.id).source.mode,'feedback-supported');
});

test('forgetting while inference is running rejects a renamed paraphrase from the now-ignored evidence',async t=>{
 const f=fixture(t);f.enable();const quote='以后汇报先给结论，再列依据';
 f.records.push({id:'u1',role:'user',text:quote,at:1000});f.output({memories:[item('u1',quote)]});await f.a.learning.tick();
 const old=f.a.store.list()[0];f.a.store.setState('scan:a',{grantId:'g'});
 let release;f.api.infer=()=>new Promise(resolve=>release=resolve);
 const running=f.a.learning.tick();assert(release);
 f.a.store.forget(old.id,old.revision);
 release(JSON.stringify({memories:[item('u1',quote,{topic:'new-report-topic',title:'表达顺序',content:'汇报时先呈现结论，然后提供支撑依据'})]}));
 await running;
 assert.equal(f.a.store.counts().active??0,0);
 assert.equal(f.a.store.get(old.id).state,'forgotten');
});

test('in-flight forgetting rejects legacy reconciliation and feedback but keeps unrelated results',async t=>{
 const f=fixture(t);f.enable();const quote='以后汇报先给结论，再列依据',other='请使用中文回答我的问题';
 f.records.push({id:'u1',role:'user',text:quote,at:1000});f.output({memories:[item('u1',quote)]});await f.a.learning.tick();
 const old=f.a.store.list()[0];
 const candidate=f.a.store.add({title:'报告习惯',content:'汇报时先呈现结论',kind:'preference',scope:'personal'},{type:'model-proposal',conversationId:'a'});
 const strategy=f.a.store.learn({title:'报告方法',content:'核对结论依据',kind:'procedure',scope:'project:p'},
  {type:'learned',topic:'strategy',certainty:'explicit',grantId:'g',refs:[{id:'observation',conversationId:'a',quote:'核对结论依据',at:100,fingerprint:'observation'}],aliases:[]});
 f.records.unshift({id:'observation',role:'user',text:'核对结论依据',at:100});f.records.push({id:'u2',role:'user',text:other,at:2000});
 f.a.store.setState('scan:a',{grantId:'g'});
 let release;f.api.infer=()=>new Promise(resolve=>release=resolve);const running=f.a.learning.tick();assert(release);
 f.a.store.forget(old.id,old.revision);
 release(JSON.stringify({memories:[item('u1',quote,{legacyId:candidate.id,content:'汇报时先呈现结论'}),item('u2',other,{topic:'language',title:'回答语言',content:'使用中文回答'})],evaluations:[{memoryId:strategy.id,decision:'support',evidence:{id:'u1',quote}}]}));
 await running;
 assert.equal(f.a.store.get(candidate.id).state,'candidate');
 assert.equal(f.a.store.get(strategy.id).source.feedback?.length??0,0);
 assert.equal(f.a.store.list().length,1);assert.equal(f.a.store.list()[0].content,'使用中文回答');
});

test('existing memory and legacy previews never send half an emoji to the background model',async t=>{
 const f=fixture(t);f.enable();const quote='以后汇报先给结论，再列依据';
 f.records.push({id:'u1',role:'user',text:quote,at:1000});
 const memory=f.a.store.learn({title:'既有记忆',content:'文'.repeat(99)+'🟡结尾',kind:'preference',scope:'personal'},
  {type:'learned',topic:'unicode-memory',certainty:'explicit',grantId:'g',aliases:[],refs:[{id:'u1',conversationId:'a',quote,at:1000,fingerprint:'ref'}]});
 const legacy=f.a.store.add({title:'旧候选',content:'文'.repeat(799)+'🟡结尾',kind:'fact',scope:'personal'},{type:'model-proposal',conversationId:'a'});
 let sent;
 f.api.infer=async(_g,messages)=>{
  const payload=JSON.parse(messages[1].content);
  assert(payload.existing.find(r=>r.id===memory.id).content.isWellFormed(),'existing preview must be valid Unicode');
  assert(payload.legacy.find(r=>r.id===legacy.id).content.isWellFormed(),'legacy preview must be valid Unicode');
  sent=payload;return '{"memories":[]}';
 };
 await f.a.learning.tick();assert.equal(f.a.learning.error,'');assert(sent);assert.equal(f.a.store.state('scan:a').cursor,'u1');
 assert.equal(f.a.store.get(memory.id).content,'文'.repeat(99)+'🟡结尾');assert.equal(f.a.store.get(legacy.id).content,'文'.repeat(799)+'🟡结尾');
});

test('unavailable persisted history cannot starve another authorized conversation',async t=>{
 const f=fixture(t);f.enable();f.api.targets=()=>[{...f.session},{...f.session,id:'b',instanceId:'b'}];
 const reads=[];let broken=true;
 f.api.read=(_g,id,cursor)=>{
  reads.push(id);
  if(id==='a' && broken)throw Error('Persisted history unavailable');
  return {entries:cursor?[]:[{id:'u1',role:'user',text:'以后汇报先列结论，再给依据',at:1}],cursor:'u1'};
 };
 await f.a.learning.tick();assert.match(f.a.learning.error,/history unavailable/);
 await f.a.learning.tick();assert.equal(f.calls(),1,'a healthy conversation still gets a learning turn');
 assert.equal(f.a.store.state('scan:b').cursor,'u1');assert.equal(f.a.store.state('scan:a').cursor,undefined,'failure must not skip history');
 broken=false;await f.a.learning.tick();assert.equal(f.a.store.state('scan:a').cursor,undefined,'a failed source waits for its retry time');
 f.a.store.setState('retry:a',{retryAt:0});await f.a.learning.tick();assert.equal(f.a.store.state('scan:a').cursor,'u1');
 assert.deepEqual(reads,['a','b','b','a']);
});

test('nested JSON escaping cannot exceed the host input budget or block later history',async t=>{
 const f=fixture(t);f.enable();const seen=[];
 f.records.push({id:'slashes',role:'user',text:'以后处理路径请保留反斜线 '+ '\\'.repeat(2990),at:1},{id:'plain',role:'user',text:'以后汇报先列结论 '+ '甲'.repeat(2000),at:2});
 f.api.infer=async(_g,messages)=>{
  assert(JSON.stringify(messages).length<=16000,'same limit as BackgroundService.infer');
  const batch=JSON.parse(messages[1].content).records;
  for(const row of batch) assert.equal(row.text,f.records.find(r=>r.id===row.id).text,'split batches instead of truncating records that fit alone');
  seen.push(...batch.map(r=>r.id));return '{"memories":[]}';
 };
 for(let i=0;i<4;i++)await f.a.learning.tick();
 assert.equal(f.a.learning.error,'');assert.deepEqual([...new Set(seen)],['slashes','plain']);
 assert.equal(f.a.store.state('scan:a').cursor,'plain');
});
