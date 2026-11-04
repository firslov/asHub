import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Assistant } from '../shared.mjs';
import { states } from '../store.mjs';
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-legacy-'));
 const records=[], target={id:'a',instanceId:'a',cwd:dir,title:'工作',kind:'agent',projectId:'p',busy:false};
 let calls=0,output={memories:[]},since=0,enabled=true,last;
 const api={status:()=>({}),targets:()=>enabled?[{...target}]:[],
  read:(_g,_id,cursor)=>{const index=records.findIndex(r=>r.id===cursor);const page=records.slice(index+1,index+41);return {entries:page.filter(r=>r.at>=since),cursor:page.at(-1)?.id??cursor??null};},
  valid:(_g,_id,ids)=>enabled?ids.filter(id=>records.some(r=>r.id===id)):[],
  infer:async(_g,messages)=>{calls++;last=JSON.parse(messages[1].content);return JSON.stringify(typeof output==='function'?output(last):output);}};
 const a=new Assistant({dataDirectory:dir,background:api,host:{snapshot:()=>({sessions:[{...target}],projects:[{id:'p',name:'项目'}]})}});
 a.store.setState('learning',{enabled:true,grantId:'g',dailyCalls:4,includeHistory:true});
 const add=(values={})=>a.store.add({title:'汇报偏好',content:'汇报先给结论',kind:'preference',scope:'personal',...values},{type:'model-proposal',conversationId:'a',reason:'助手自己的推测',at:1});
 const memory=(old,id,quote,extra={})=>({legacyId:old.id,title:old.title,content:old.content,kind:old.kind,scope:old.scope==='personal'?'personal':'local',certainty:'explicit',topic:'report-style',aliases:[],evidence:[{id,quote}],...extra});
 t.after(()=>{a.stop();fs.rmSync(dir,{recursive:true,force:true});});
 return {a,records,target,api,add,memory,calls:()=>calls,last:()=>last,output:v=>output=v,since:n=>since=n,exclude:()=>enabled=false};
}
test('legacy proposal becomes a sourced memory in place, preserving identity and prior version',async t=>{
 const f=fixture(t),old=f.add(),quote='以后汇报请先给结论';f.records.push({id:'u',role:'user',text:quote,at:2});f.output({memories:[f.memory(old,'u',quote)]});
 await f.a.learning.tick();const row=f.a.store.get(old.id);
 assert.equal(row.state,'active');assert.equal(row.source.type,'learned');assert.equal(row.source.migratedFrom,'model-proposal');assert.equal(row.source.refs[0].id,'u');assert.equal(row.created,old.created);assert.equal(row.revision,2);
 assert.equal(f.a.store.list('all').length,1);assert.equal(f.a.store.history(old.id).at(-1).value.source.type,'model-proposal');assert.equal(f.a.search('a','汇报').length,1);
 assert(!JSON.stringify(f.last()).includes('助手自己的推测'),'proposal rationale never masquerades as original evidence');
});
test('reconciliation revisits authorized history already passed by the normal cursor without reprocessing it forever',async t=>{
 const f=fixture(t),old=f.add(),quote='以后汇报请先给结论';f.records.push({id:'u',role:'user',text:quote,at:2});
 f.a.store.setState('scan:a',{grantId:'g',cursor:'u'});f.output({memories:[f.memory(old,'u',quote)]});
 await f.a.learning.tick();assert.equal(f.a.store.get(old.id).state,'active');assert.equal(f.calls(),1);assert.equal(f.a.store.state('scan:a').cursor,'u');
 await f.a.learning.tick();assert.equal(f.calls(),1);
});
test('unsupported, assistant-authored or invented citations stay under observation and can be corroborated later',async t=>{
 const f=fixture(t),old=f.add();f.records.push({id:'a1',role:'assistant',text:'用户喜欢先给结论',at:1},{id:'u',role:'user',text:'帮我看看这份材料',at:2});
 f.a.store.setState('scan:a',{grantId:'g',cursor:'u'});f.output({memories:[f.memory(old,'a1','用户喜欢先给结论'),f.memory(old,'u','根本不存在的内容')]});
 await f.a.learning.tick();assert.equal(f.a.store.get(old.id).state,'candidate');assert.equal(f.calls(),1);
 await f.a.learning.tick();assert.equal(f.calls(),1,'completed unsupported scan does not spend a call every minute');
 const quote='今后汇报先给结论，再列依据';f.records.push({id:'u2',role:'user',text:quote,at:3});f.output({memories:[f.memory(old,'u2',quote)]});await f.a.learning.tick();assert.equal(f.a.store.get(old.id).state,'active');
});
test('old evidence outside the authorized start time or in excluded conversations is never read around the host',async t=>{
 const f=fixture(t),old=f.add(),quote='以后汇报请先给结论';f.records.push({id:'u',role:'user',text:quote,at:2});f.a.store.setState('scan:a',{grantId:'g',cursor:'u'});f.output({memories:[f.memory(old,'u',quote)]});
 f.since(10);await f.a.learning.tick();assert.equal(f.calls(),0);assert.equal(f.a.store.get(old.id).state,'candidate');
 f.exclude();await f.a.learning.tick();assert.equal(f.calls(),0);
});
test('late inference cannot resurrect forgotten candidates or broaden project scope',async t=>{
 const f=fixture(t),old=f.add({scope:'project:p'}),quote='以后汇报请先给结论';f.records.push({id:'u',role:'user',text:quote,at:2});
 f.output({memories:[f.memory(old,'u',quote,{scope:'personal'})]});await f.a.learning.tick();assert.equal(f.a.store.get(old.id).state,'candidate');
 let resolve;f.api.infer=()=>new Promise(r=>resolve=r);const work=f.a.learning.tick();assert(resolve);f.a.store.forget(old.id,old.revision);resolve(JSON.stringify({memories:[f.memory(old,'u',quote)]}));await work;assert.equal(f.a.store.get(old.id).state,'forgotten');
});
test('migration preserves strategy thresholds and never replaces manually confirmed records',async t=>{
 const f=fixture(t),old=f.add({kind:'procedure',scope:'project:p'}),quote='修改界面以后同时检查远控端';f.records.push({id:'u',role:'user',text:quote,at:2});f.output({memories:[f.memory(old,'u',quote)]});await f.a.learning.tick();
 assert.equal(f.a.store.get(old.id).state,'candidate');assert.equal(f.a.store.get(old.id).source.type,'learned');assert.equal(f.a.search('a','远控').length,0);
 const active=f.a.store.add({title:'个人决定',content:'用户确认的原内容',kind:'fact',scope:'personal'},{type:'user'},'active');
 const replacement=f.a.store.add({...active,content:'新内容',replaces:active.id,replacesRevision:active.revision},{type:'model-proposal',conversationId:'a'});
 assert(!f.a.store.legacyCandidates('a','p').some(r=>r.id===replacement.id));assert.equal(f.a.store.get(active.id).content,'用户确认的原内容');
});
test('more than six pending proposals each receive their own durable recovery scan',async t=>{
 const f=fixture(t);for(let i=0;i<8;i++)f.add({title:'观察'+i,content:'未经证实的说法'+i});
 f.records.push({id:'u',role:'user',text:'帮我查看这个项目',at:1});f.a.store.setState('scan:a',{grantId:'g',cursor:'u'});
 const seen=new Set();f.output(data=>{data.legacy.forEach(r=>seen.add(r.id));return {memories:[]};});
 for(let i=0;i<10;i++)await f.a.learning.tick();assert.equal(seen.size,8);assert.equal(f.calls(),8);
 assert.equal(states.candidate,'观察中');assert.equal(states.active,'正式记忆');
});

test('secret-bearing legacy drafts are not sent to the organizer',async t=>{
 const f=fixture(t);f.add({content:'密码：must-not-leak'});f.records.push({id:'u',role:'user',text:'请帮我分析这个问题',at:1});
 await f.a.learning.tick();assert(!JSON.stringify(f.last()).includes('must-not-leak'));await f.a.learning.tick();assert.equal(f.calls(),1);
});

test('a heavily escaped history record cannot leave the recovery cursor stuck',async t=>{
 const f=fixture(t);f.add();f.records.push({id:'u',role:'user',text:'帮我查看这些符号'+String.fromCharCode(1).repeat(2990),at:1});f.a.store.setState('scan:a',{grantId:'g',cursor:'u'});
 await f.a.learning.tick();assert.equal(f.calls(),1);assert(f.last().records[0].truncated);assert(f.last().records[0].text.length<=800);
 await f.a.learning.tick();assert.equal(f.calls(),1);
});

test('a failed legacy history read rotates candidates without discarding their recovery cursors',async t=>{
 const f=fixture(t);const one=f.add({title:'候选甲'}),two=f.add({title:'候选乙'});
 const targets=[f.target],c=f.a.learning.config(),signal=new AbortController().signal;
 const read=f.api.read;let first=true,failed;
 f.api.read=(...args)=>{if(first){first=false;throw Error('Persisted history unavailable');}return read(...args);};
 await assert.rejects(f.a.learning.reconcileLegacy(c,targets,signal),/history unavailable/);
 failed=[one,two].find(r=>f.a.store.state('legacy-scan:'+r.id)?.checked);
 assert(failed);assert.equal(f.a.store.state('legacy-scan:'+failed.id).cursor,undefined);
 f.records.push({id:'u',role:'user',text:'以后汇报请先给结论',at:1});
 await f.a.learning.reconcileLegacy(c,targets,signal);
 assert.equal(f.calls(),1);assert.notEqual(f.last().legacy[0].id,failed.id,'the other candidate gets its turn');
 await f.a.learning.reconcileLegacy(c,targets,signal);
 assert.equal(f.a.store.state('legacy-scan:'+failed.id).cursor,'u');
});

test('legacy recovery reserves room for the candidate after nested JSON escaping',async t=>{
 const f=fixture(t);const old=f.add({title:'\\'.repeat(90),content:'\\'.repeat(790)}),seen=[];
 f.records.push({id:'escaped',role:'user',text:'以后汇报请先给结论 '+ '\\'.repeat(2800),at:1},{id:'later',role:'user',text:'以后还需要说明关键依据',at:2});
 f.a.store.setState('scan:a',{grantId:'g',cursor:'later'});
 f.api.infer=async(_g,messages)=>{
  assert(JSON.stringify(messages).length<=16000);
  const data=JSON.parse(messages[1].content);assert.equal(data.legacy[0].id,old.id);
  for(const r of data.records){assert(r.text.isWellFormed());seen.push(r.id);}
  return '{"memories":[]}';
 };
 for(let i=0;i<3;i++)await f.a.learning.tick();
 assert.equal(f.a.learning.error,'');assert.deepEqual([...new Set(seen)],['escaped','later']);
 assert.equal(f.a.store.state('legacy-scan:'+old.id).cursor,'later');
});
