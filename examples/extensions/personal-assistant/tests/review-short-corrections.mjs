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


async function occupation(f) {
 const q=f.add('user','我的职业是一名大学教师');
 f.answer(()=>({memories:[item(q.id,q.text)]}));await f.a.learning.tick();
 return f.a.store.activeMemories()[0];
}

test('a direct short denial can retract a confirmed user fact, including across restart',async t=>{
 for(const restart of [false,true])await t.test(restart?'remembered neighboring question':'same batch',async t=>{
  const f=fixture(t),old=await occupation(f);
  f.add('assistant','你现在仍然是一名大学教师吗？');
  if(restart){await f.a.learning.tick();f.restart();}
  const correction=f.add('user','不是');
  f.answer(request=>{assert(request.existing.some(row=>row.id===old.id),'the confirmed proposition is supplied for constrained correction');return {memories:[item(correction.id,correction.text,{memoryId:old.id,revision:old.revision,relation:'contradict'})]};});
  await f.a.learning.tick();
  assert.equal(f.calls(),2,'a grounded denial is a meaningful correction, not an acknowledgment');
  assert.equal(f.a.store.get(old.id).source.mode,'contradicted');
  assert.equal(f.a.store.get(old.id).state,'candidate');assert.equal(f.a.store.activeMemories().length,0);
 });
});

test('short denials of actions, third-party or hypothetical statements cannot retract a user fact',async t=>{
 for(const question of [null,'你想继续吗？','是否发送这条消息？','我帮你打开网站吗？','你的同事现在仍然是一名大学教师吗？','假如你现在是一名大学教师，你会继续吗？','你现在是一名医生吗？','你现在仍然是一名大学教师并准备辞职吗？','你现在仍然是一名大学教师所以想继续发送邮件吗？'])await t.test(question??'no question',async t=>{
  const f=fixture(t),old=await occupation(f);if(question)f.add('assistant',question);
  const correction=f.add('user','不是');
  f.answer(()=>({memories:[item(correction.id,correction.text,{memoryId:old.id,revision:old.revision,relation:'contradict'})]}));
  await f.a.learning.tick();assert.equal(f.calls(),1,'unrelated short denial does not spend an inference');
  assert.equal(f.a.store.get(old.id).revision,old.revision);assert.equal(f.a.store.get(old.id).state,'active');
 });
});

test('a short denial cannot invent a replacement or create a new memory',async t=>{
 for(const relation of ['revise','new'])await t.test(relation,async t=>{
  const f=fixture(t),old=await occupation(f);
  f.add('assistant','你现在仍然是一名大学教师吗？');const correction=f.add('user','不是');
  f.answer(()=>({memories:[item(correction.id,correction.text,{title:'职业变更',content:'用户改为医生',topic:'doctor',...(relation==='revise'?{memoryId:old.id,revision:old.revision,relation}: {})})]}));
  await f.a.learning.tick();assert.equal(f.a.store.get(old.id).revision,old.revision);
  assert.equal(f.a.store.activeMemories().length,1);assert.equal(f.a.store.activeMemories()[0].content,'用户是一名大学教师');
 });
});

test('a grounded short denial cannot contradict a different existing memory',async t=>{
 const f=fixture(t),old=await occupation(f),q=f.add('user','我偏好简短直接的回答');
 f.answer(()=>({memories:[item(q.id,q.text,{title:'表达偏好',content:'用户偏好简短直接的回答',topic:'response-style',kind:'preference'})]}));await f.a.learning.tick();
 const other=f.a.store.activeMemories().find(row=>row.id!==old.id);
 f.add('assistant','你现在仍然是一名大学教师吗？');const correction=f.add('user','不是');
 f.answer(()=>({memories:[item(correction.id,correction.text,{title:other.title,content:other.content,topic:other.source.topic,kind:other.kind,memoryId:other.id,revision:other.revision,relation:'contradict'})]}));
 await f.a.learning.tick();assert.equal(f.a.store.get(other.id).revision,other.revision);assert.equal(f.a.store.get(other.id).state,'active');
});

test('filtered history records break short-answer grounding within a page and across restart',async t=>{
 for(const gap of ['sensitive','generated','ignored','page boundary','filtered empty page'])await t.test(gap,async t=>{
  const f=fixture(t);
  if(gap==='page boundary')for(let i=0;i<38;i++)f.add('generated','自动生成的系统任务');
  f.add('assistant','你的职业是什么？');
  if(gap==='filtered empty page')await f.a.learning.tick();
  const skipped=f.add(gap==='generated'||gap==='filtered empty page'?'generated':'assistant',gap==='sensitive'||gap==='page boundary'?'改为说说你朋友吧，他的职业是什么？临时密码：placeholder':'改为说说你朋友的职业');
  if(gap==='ignored')f.a.store.setState('ignored:a',[skipped.id]);
  if(gap==='filtered empty page')for(let i=1;i<40;i++)f.add('generated','自动生成的系统任务');
  if(['page boundary','filtered empty page'].includes(gap)){await f.a.learning.tick();f.restart();}
  const answer=f.add('user','医生');
  f.answer(()=>({memories:[item(answer.id,answer.text,{content:'用户是一名医生'})]}));
  await f.a.learning.tick();assert.equal(f.calls(),0,'a missing predecessor cannot be replaced by an older question');
  assert.equal(f.a.store.activeMemories().length,0);assert.equal(f.a.store.state('scan:a').cursor,answer.id);
 });
});

test('a skipped question cannot ground a short answer even when another record triggers inference',async t=>{
 const f=fixture(t);f.add('assistant','你的职业是什么？');
 f.add('assistant','你的朋友是什么职业？密码：placeholder');
 const answer=f.add('user','医生'),other=f.add('user','我居住在上海市');
 f.answer(request=>{assert(!JSON.stringify(request).includes('placeholder'));return {memories:[
  item(answer.id,answer.text,{content:'用户是一名医生'}),
  item(other.id,other.text,{title:'居住地',topic:'city',content:'用户居住在上海市'}),
 ]};});
 await f.a.learning.tick();assert.equal(f.calls(),1);
 assert.deepEqual(f.a.store.activeMemories().map(row=>row.content),['用户居住在上海市']);
});

test('a fresh question after a filtered gap still grounds its own answer',async t=>{
 const f=fixture(t);f.add('assistant','你的职业是什么？');f.add('user','密码：placeholder');
 f.add('assistant','你目前居住在哪里？');const answer=f.add('user','上海');
 f.answer(()=>({memories:[item(answer.id,answer.text,{title:'居住地',topic:'city',content:'用户居住在上海'})]}));
 await f.a.learning.tick();assert.equal(f.calls(),1);assert.equal(f.a.store.activeMemories()[0].content,'用户居住在上海');
});

test('a long message ending in a denial-shaped fragment still uses its complete cross-segment evidence',async t=>{
 const f=fixture(t),quote='我常用的笔名叫不是',row=f.add('user','背'.repeat(3000-(quote.length-2))+quote);
 f.answer(request=>({memories:request.records.some(part=>(part.continuation?.text??'')+part.text===quote||((part.continuation?.text??'')+part.text).includes(quote))
  ?[item(row.id,quote,{title:'笔名',topic:'pen-name',content:'用户的笔名叫不是'})]:[]}));
 await f.a.learning.tick();assert.equal(f.a.store.state('scan:a').partial.offset,3000);f.restart();
 await f.a.learning.tick();assert.equal(f.calls(),2);assert.equal(f.a.store.activeMemories()[0].content,'用户的笔名叫不是');
 assert.equal(f.a.store.state('scan:a').cursor,row.id);
});
