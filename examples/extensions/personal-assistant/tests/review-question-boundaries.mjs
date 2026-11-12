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


const limitedQuestion=(question)=>'下面是角色扮演，请按小说中虚构人物的身份回答；不是核实用户真实信息。'.padEnd(3000,'背')+question;

for(const type of ['denial','identity'])test(`an incomplete question cannot ground a short ${type}`,async t=>{
 for(const checkpoint of ['partial','saved tail','legacy saved tail'])await t.test(checkpoint,async t=>{
  const f=fixture(t),old=type==='denial'?await occupation(f):null;
  f.add('assistant',limitedQuestion(type==='denial'?'你现在仍然是一名大学教师吗？':'你的职业是什么？'));
  let answer;
  if(checkpoint==='partial')answer=f.add('user',type==='denial'?'不是':'医生');
  await f.a.learning.tick();assert.equal(f.a.store.state('scan:a').partial.offset,3000);
  if(checkpoint!=='partial'){
   await f.a.learning.tick();
   if(checkpoint==='legacy saved tail'){
    const state=f.a.store.state('scan:a');for(const row of state.context){delete row.offset;delete row.truncated;}
    f.a.store.setState('scan:a',state);
   }
  }
  f.restart();answer??=f.add('user',type==='denial'?'不是':'医生');
  f.answer(()=>({memories:[item(answer.id,answer.text,type==='denial'?{memoryId:old.id,revision:old.revision,relation:'contradict'}:{content:'用户是一名医生'})]}));
  await f.a.learning.tick();
  assert.equal(f.calls(),old?1:0,'an excerpt is not a complete question about the user');
  assert.equal(f.a.store.state('scan:a').cursor,answer.id);
  if(old){assert.equal(f.a.store.get(old.id).state,'active');assert.equal(f.a.store.get(old.id).revision,old.revision);}
  else assert.equal(f.a.store.activeMemories().length,0);
 });
});

test('a partial question is rejected even when an independent user fact triggers inference',async t=>{
 const f=fixture(t),old=await occupation(f);
 f.add('assistant',limitedQuestion('你现在仍然是一名大学教师吗？'));
 await f.a.learning.tick();f.restart();
 const answer=f.add('user','不是'),city=f.add('user','我的常住城市是上海');
 f.answer(()=>({memories:[item(answer.id,answer.text,{memoryId:old.id,revision:old.revision,relation:'contradict'}),item(city.id,city.text,{title:'居住地',topic:'city',content:'用户常住上海'})]}));
 await f.a.learning.tick();
 assert.equal(f.a.store.get(old.id).state,'active');assert.equal(f.a.store.get(old.id).revision,old.revision);
 assert(f.a.store.activeMemories().some(row=>row.content==='用户常住上海'));
});

test('whole questions still ground short replies after checkpoint and restart',async t=>{
 for(const type of ['denial','identity'])await t.test(type,async t=>{
  const f=fixture(t),old=type==='denial'?await occupation(f):null;
  f.add('assistant',type==='denial'?'你现在仍然是一名大学教师吗？':'你的职业是什么？');
  await f.a.learning.tick();f.restart();
  const answer=f.add('user',type==='denial'?'不是':'医生');
  f.answer(()=>({memories:[item(answer.id,answer.text,type==='denial'?{memoryId:old.id,revision:old.revision,relation:'contradict'}:{content:'用户是一名医生'})]}));
  await f.a.learning.tick();
  if(old)assert.equal(f.a.store.get(old.id).source.mode,'contradicted');
  else assert.equal(f.a.store.activeMemories()[0]?.content,'用户是一名医生');
 });
});

test('protecting question boundaries preserves long user continuation evidence',async t=>{
 const f=fixture(t),quote='我常用的笔名叫不是',row=f.add('user','背'.repeat(3000-(quote.length-2))+quote);
 f.answer(request=>({memories:request.records.some(part=>((part.continuation?.text??'')+part.text).includes(quote))
  ?[item(row.id,quote,{title:'笔名',topic:'pen-name',content:'用户的笔名叫不是'})]:[]}));
 await f.a.learning.tick();f.restart();await f.a.learning.tick();
 assert.equal(f.a.store.activeMemories()[0]?.content,'用户的笔名叫不是');assert.equal(f.calls(),2);
 assert.equal(f.a.store.state('scan:a').cursor,row.id);
});

test('a transient source read failure preserves an old checkpoint and recovers its short answer after restart',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=fixture(t),question=f.add('assistant','你目前居住在哪里？');
 await f.a.learning.tick();
 const state=f.a.store.state('scan:a');for(const row of state.context){delete row.offset;delete row.truncated;}
 f.a.store.setState('scan:a',state);
 const answer=f.add('user','上海'),entry=f.api.entry;let unavailable=true;
 f.api.entry=(...args)=>{if(unavailable&&args[2]===question.id)throw Error('Transient history read failure');return entry(...args);};
 f.answer(()=>({memories:[item(answer.id,answer.text,{title:'居住地',topic:'city',content:'用户居住在上海'})]}));
 await f.a.learning.tick();
 assert.equal(f.calls(),0);
 assert.equal(f.a.store.state('scan:a').cursor,question.id,'unverified context cannot consume the answer');
 assert.equal(f.a.learning.health().errorClass,'temporary');
 f.restart();unavailable=false;t.mock.timers.tick(60001);
 await f.a.learning.tick();
 assert.equal(f.calls(),1);assert.equal(f.a.store.activeMemories()[0]?.content,'用户居住在上海');
 assert.equal(f.a.store.state('scan:a').cursor,answer.id);assert.equal(f.a.learning.health().errorClass,null);
});
