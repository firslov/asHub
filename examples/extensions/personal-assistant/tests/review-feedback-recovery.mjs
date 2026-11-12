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



async function strategy(f) {
 const formation=f.add('user','我打算在汇报时先给结论再给证据');
 f.answer(()=>({memories:[item(formation.id,formation.text,{title:'汇报经验',content:'汇报时先给结论再给证据有助于沟通',kind:'procedure',topic:'reporting'})]}));
 await f.a.learning.tick();const row=f.a.store.list('candidate')[0];
 const feedback=f.add('user','第一次采用先给结论的汇报方式，交流顺畅');
 f.answer(()=>({memories:[],evaluations:[{memoryId:row.id,decision:'support',evidence:{id:feedback.id,quote:feedback.text}}]}));
 await f.a.learning.tick();return f.a.store.get(row.id);
}
function fillActivePool(f) {
 let last;
 for(let i=f.a.store.counts().active??0;i<1000;i++)last=f.a.store.add({title:'容量占位'+i,content:'其他记忆占位'+i,kind:'fact',scope:'personal'},{type:'user-add',userOperation:'filler'+i},'active');
 assert.equal(f.a.store.counts().active,1000);return last;
}
const evaluation=(row,feedback)=>({memoryId:row.id,decision:'support',evidence:{id:feedback.id,quote:feedback.text}});

for(const reviseOther of [false,true])test(`full-capacity feedback resumes without another inference${reviseOther?' or repeating an already-saved correction':''}`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=fixture(t),row=await strategy(f);let other;
 if(reviseOther){
  const source=f.add('user','我的常住城市是北京');
  f.answer(()=>({memories:[item(source.id,source.text,{title:'居住地',topic:'city',content:'用户常住北京'})]}));
  await f.a.learning.tick();other=f.a.store.activeMemories().find(r=>r.source.topic==='city');
 }
 const filler=fillActivePool(f),memories=[];
 if(other){
  const change=f.add('user','我已经搬家，现在常住上海');
  memories.push(item(change.id,change.text,{title:'居住地',topic:'city',content:'用户常住上海',memoryId:other.id,revision:other.revision,relation:'revise'}));
 }
 const feedback=f.add('user','再次先讲结论再给证据，汇报效果依然很好');
 f.answer(()=>({memories,evaluations:[evaluation(row,feedback)]}));
 await f.a.learning.tick();const calls=f.calls();
 assert.equal(f.a.store.get(row.id).source.feedback.length,1);
 assert.notEqual(f.a.store.state('scan:a').cursor,feedback.id,'capacity failure cannot consume the feedback');
 assert(f.a.store.state('learning-result:a'),'the validated feedback stays in the existing extraction receipt');
 assert.equal(f.a.learning.health().errorClass,'capacity');
 let revision;
 if(other){const saved=f.a.store.get(other.id);assert.equal(saved.content,'用户常住上海');assert.equal(saved.revision,other.revision+1);revision=saved.revision;}
 f.a.store.forget(filler.id,filler.revision);f.restart();await f.a.learning.tick();
 assert.equal(f.calls(),calls,'retry delay is preserved through restart');
 t.mock.timers.tick(3600001);await f.a.learning.tick();
 assert.equal(f.calls(),calls,'recovery reuses the paid result');
 assert.equal(f.a.store.get(row.id).state,'active');assert.equal(f.a.store.get(row.id).source.mode,'feedback-supported');
 assert.equal(f.a.store.get(row.id).source.feedback.length,2);
 assert.equal(f.a.store.state('scan:a').cursor,feedback.id);assert.equal(f.a.store.state('learning-result:a'),null);
 assert.equal(f.a.learning.health().errorClass,null);assert.equal(f.a.store.counts().active,1000);
 if(other){assert.equal(f.a.store.get(other.id).revision,revision);assert.equal(f.a.store.get(other.id).content,'用户常住上海');}
 await f.a.learning.tick();assert.equal(f.calls(),calls);assert.equal(f.a.store.get(row.id).source.feedback.length,2);
});

for(const change of ['forget','revoke'])test(`pending feedback cannot restore a strategy after ${change}`,async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=fixture(t),row=await strategy(f),filler=fillActivePool(f),feedback=f.add('user','再次先给结论后给证据，沟通很顺畅');
 f.answer(()=>({memories:[],evaluations:[evaluation(row,feedback)]}));
 await f.a.learning.tick();assert(f.a.store.state('learning-result:a'));const calls=f.calls();
 if(change==='forget'){f.a.store.forget(row.id,row.revision);assert.equal(f.a.store.state('learning-result:a'),null);f.answer(()=>({memories:[]}));}
 else f.api.revoke('g1');
 f.a.store.forget(filler.id,filler.revision);f.restart();t.mock.timers.tick(3600001);await f.a.learning.tick();
 assert.equal(f.a.store.get(row.id).state,change==='forget'?'forgotten':'candidate');
 if(change==='forget'){assert.equal(f.a.store.get(row.id).content,'');assert.equal(f.a.store.state('learning-result:a'),null);}
 else {assert.equal(f.calls(),calls);assert.equal(f.a.learning.health().errorClass,'authorization');assert.equal(f.a.store.get(row.id).source.feedback.length,1);}
});
