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


function failCheckpoint(f,id) {
 const write=f.a.store.setState.bind(f.a.store);
 f.a.store.setState=(key,value)=>{
  if(key==='scan:a'&&value?.cursor===id)throw Error('SQLITE_BUSY while committing cursor');
  return write(key,value);
 };
}

test('completed extraction resumes after a checkpoint failure even when newer messages arrive before restart',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=fixture(t),q=f.add('user','我的职业是一名大学教师');
 f.answer(()=>({memories:[item(q.id,q.text)]}));failCheckpoint(f,q.id);
 await f.a.learning.tick();assert.equal(f.calls(),1);assert(f.a.store.state('learning-result:a'));
 assert.equal(f.a.store.activeMemories().length,1);assert.notEqual(f.a.store.state('scan:a').cursor,q.id);
 f.add('assistant','已经理解你的职业背景。');
 f.restart();t.mock.timers.tick(60001);await f.a.learning.tick();
 assert.equal(f.calls(),1,'appending a reply must not repeat already paid extraction');
 assert.equal(f.a.store.activeMemories().length,1);assert.equal(f.a.store.state('learning-result:a'),null);
 await f.a.learning.tick();assert.equal(f.calls(),1);assert.equal(f.a.store.state('scan:a').cursor,f.records.at(-1).id);
});

test('restart recovery cannot apply a cached result outside live authorization or source history',async t=>{
 for(const change of ['revoke','forget','rewind','scope'])await t.test(change,async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=fixture(t),q=f.add('user','我的职业是一名大学教师');
  f.answer(()=>({memories:[item(q.id,q.text)]}));failCheckpoint(f,q.id);
  await f.a.learning.tick();assert.equal(f.calls(),1);assert(f.a.store.state('learning-result:a'));
  const old=f.a.store.activeMemories()[0];
  if(change==='revoke')f.api.revoke('g1');
  if(change==='forget')f.a.store.forget(old.id,old.revision);
  if(change==='rewind')f.records.length=0;
  if(change==='scope')f.target.cwd=path.join(f.target.cwd,'changed');
  f.restart();t.mock.timers.tick(60001);
  if(change==='scope')f.answer(()=>({memories:[]}));
  await f.a.learning.tick();
  if(change==='revoke'){
   assert.equal(f.calls(),1);assert.equal(f.a.learning.health().errorClass,'authorization');
   assert.notEqual(f.a.store.state('scan:a').cursor,q.id);
  }else if(change==='forget'){
   assert.equal(f.calls(),1);assert.equal(f.a.store.get(old.id).state,'forgotten');
   assert.equal(f.a.store.state('learning-result:a'),null);assert.equal(f.a.store.activeMemories().length,0);
  }else if(change==='rewind'){
   assert.equal(f.calls(),1);assert.equal(f.a.store.state('learning-result:a'),null);
   assert.equal(f.a.learning.valid(f.a.store.get(old.id)),false);
  }else{
   assert.equal(f.calls(),2,'a new workspace scope must not replay the old cached inference');
   assert.equal(f.a.store.state('learning-result:a'),null);
   assert.equal(f.a.store.get(old.id).revision,old.revision,'old receipt is not reapplied');
  }
 });
});

test('receipt recovery commits only its original batch before consolidating an appended user message',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=fixture(t),old=f.add('user','我的职业是一名大学教师');
 f.answer(()=>({memories:[item(old.id,old.text)]}));failCheckpoint(f,old.id);
 await f.a.learning.tick();assert.equal(f.calls(),1);
 const fresh=f.add('user','我喜欢先给结论再解释依据');
 f.answer(request=>{assert.deepEqual(request.records.map(row=>row.id),[fresh.id]);return {memories:[item(fresh.id,fresh.text,{topic:'answer-style',title:'表达偏好',content:'用户希望先结论后依据',kind:'preference'})]};});
 f.restart();t.mock.timers.tick(60001);await f.a.learning.tick();
 assert.equal(f.calls(),1);assert.equal(f.a.store.state('scan:a').cursor,old.id);
 assert.equal(f.a.store.activeMemories().length,1);
 await f.a.learning.tick();assert.equal(f.calls(),2);assert.equal(f.a.store.state('scan:a').cursor,fresh.id);
 assert.equal(f.a.store.activeMemories().length,2);
});

test('legacy recovery checkpoints its own scan without consuming appended ordinary messages',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=fixture(t),old=f.add('user','我的职业是一名大学教师');
 await f.a.learning.tick();assert.equal(f.calls(),1);
 const proposal=f.a.store.add({title:'职业',content:'用户是一名大学教师',kind:'fact',scope:'personal'},{type:'model-proposal',conversationId:'a'});
 const key='legacy-scan:'+proposal.id,write=f.a.store.setState.bind(f.a.store);
 f.a.store.setState=(k,value)=>{if(k===key&&value?.cursor===old.id)throw Error('SQLITE_BUSY while committing legacy cursor');return write(k,value);};
 f.answer(()=>({memories:[item(old.id,old.text,{legacyId:proposal.id})]}));
 await f.a.learning.tick();assert.equal(f.calls(),2);
 assert.equal(f.a.store.get(proposal.id).state,'active');
 const receipt=f.a.store.state('learning-result:a');assert.equal(receipt.resume.stateKey,key);assert.equal(receipt.resume.legacyOnly,true);
 const fresh=f.add('user','我喜欢先给结论再解释依据');
 f.answer(request=>{assert.deepEqual(request.records.map(row=>row.id),[fresh.id]);return {memories:[]};});
 f.restart();t.mock.timers.tick(60001);await f.a.learning.tick();
 assert.equal(f.calls(),2);assert.equal(f.a.store.state(key).cursor,old.id);
 assert.equal(f.a.store.state('scan:a').cursor,old.id,'legacy recovery must leave the ordinary scan at its previous cursor');
 await f.a.learning.tick();assert.equal(f.calls(),3);assert.equal(f.a.store.state('scan:a').cursor,fresh.id);
});

test('receipt recovery survives same-scope reauthorization but rejects newly excluded history',async t=>{
 for(const sameScope of [true,false])await t.test(sameScope?'same scope':'changed history',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const f=fixture(t),q=f.add('user','我的职业是一名大学教师');
  f.answer(()=>({memories:[item(q.id,q.text)]}));
  f.a.store.learn=()=>{throw Error('SQLITE_BUSY before saving memory');};
  await f.a.learning.tick();assert.equal(f.calls(),1);assert.equal(f.a.store.activeMemories().length,0);
  assert(f.a.store.state('learning-result:a'));
  f.reauthorize(sameScope?0:q.at+1);f.restart();t.mock.timers.tick(60001);await f.a.learning.tick();
  assert.equal(f.calls(),1);assert.equal(f.a.store.state('learning-result:a'),null);
  assert.equal(f.a.store.activeMemories().length,sameScope?1:0);
  if(sameScope){assert.equal(f.a.store.state('scan:a').grantId,'g1x');assert.equal(f.a.store.activeMemories()[0].source.grantId,'g1x');}
 });
});

test('a receipt cannot overwrite a scan that advanced independently before recovery',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const f=fixture(t),old=f.add('user','我的职业是一名大学教师');
 f.answer(()=>({memories:[item(old.id,old.text)]}));failCheckpoint(f,old.id);
 await f.a.learning.tick();const receipt=f.a.store.state('learning-result:a');assert(receipt);
 f.restart();
 f.a.store.setState('scan:a',{...receipt.resume.state,context:[]});
 const fresh=f.add('user','我喜欢先给结论再解释依据');
 f.answer(request=>{assert.deepEqual(request.records.map(row=>row.id),[fresh.id]);return {memories:[]};});
 t.mock.timers.tick(60001);await f.a.learning.tick();
 assert.equal(f.calls(),2,'a changed start checkpoint invalidates the stale receipt');
 assert.equal(f.a.store.state('scan:a').cursor,fresh.id);assert.equal(f.a.store.state('learning-result:a'),null);
});
