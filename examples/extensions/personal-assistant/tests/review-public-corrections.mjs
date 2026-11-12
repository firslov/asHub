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


function publicHistory(f,{neighbors=true}={}) {
 const entry=f.api.entry;
 f.api.entry=(g,id,source,offset=0)=>{
  const row=entry(g,id,source,offset),index=f.records.findIndex(r=>r.id===source),prior=f.records[index-1];
  return {...row,...(neighbors?{previousId:prior&&f.api.valid(g,id,[prior.id]).includes(prior.id)?prior.id:null}:{})};
 };
 f.api.search=(g,id,query)=>f.records.filter(r=>f.api.valid(g,id,[r.id]).includes(r.id)&&r.text.includes(query)).map(r=>{
  const start=Math.max(0,r.text.indexOf(query)-100);
  return {...r,text:r.text.slice(start,start+800)};
 }).slice(-12);
 f.api.latestUser=(g,id)=>f.records.filter(r=>r.role==='user'&&f.api.valid(g,id,[r.id]).includes(r.id)).at(-1)?.id;
}
async function occupation(f) {
 const q=f.add('user','我的职业是一名大学教师');
 f.answer(()=>({memories:[item(q.id,q.text)]}));await f.a.learning.tick();
 return f.a.store.activeMemories()[0];
}
const correctionArgs=old=>({title:old.title,content:old.content,kind:old.kind,topic:old.source.topic,subject:'user',quote:'不是',memoryId:old.id,revision:old.revision,relation:'contradict'});

test('public remember applies a grounded short correction and preserves it through restart',async t=>{
 const f=fixture(t);publicHistory(f);const old=await occupation(f);
 const status=f.api.status;let blockedCalls=0;f.api.status=g=>({...status(g),calls:4,dailyCalls:4});
 f.api.infer=async()=>{blockedCalls++;throw Error('今日后台整理额度已用完');};
 f.add('assistant','你现在仍然是一名大学教师吗？');f.add('user','不是');
 const result=f.a.remember('a',correctionArgs(old));assert.equal(result.id,old.id);assert.equal(result.state,'candidate');
 f.restart();assert.equal(f.a.store.get(old.id).source.mode,'contradicted');assert.equal(f.a.store.activeMemories().length,0);
 assert.equal(f.calls(),1,'the foreground correction never invokes another model');assert.equal(blockedCalls,0,'exhausted background quota cannot block an explicit correction');
});

test('public remember uses the exact predecessor of a non-latest source, not search-match adjacency',async t=>{
 const f=fixture(t);publicHistory(f);const old=await occupation(f);
 f.add('user','不是');f.add('assistant','你现在仍然是一名大学教师吗？');const correction=f.add('user','不是');
 f.add('user','我们接下来聊一个新话题');
 f.a.remember('a',correctionArgs(old));const row=f.a.store.get(old.id);
 assert.equal(row.source.mode,'contradicted');assert.equal(row.source.refs[0].id,correction.id);
 assert.throws(()=>f.a.remember('a',correctionArgs(old)),/记忆已变化/,'a stale revision never overrides a later update');
});

test('public remember can ground a complete short factual answer without inventing evidence',t=>{
 const f=fixture(t);publicHistory(f);f.add('assistant','你目前居住在哪里？');const answer=f.add('user','上海');
 const result=f.a.remember('a',{title:'居住地',content:'用户居住在上海',kind:'fact',topic:'city',subject:'user',quote:'上海'});
 assert.equal(result.state,'active');assert.deepEqual(f.a.store.get(result.id).source.refs.map(ref=>[ref.id,ref.quote]),[[answer.id,'上海']]);
});

test('public short correction rejects unavailable or non-human neighboring questions',async t=>{
 for(const mode of ['ignored','generated','sensitive question','third party','truncated question','legacy host','missing neighbor'])await t.test(mode,async t=>{
  const f=fixture(t);publicHistory(f,{neighbors:mode!=='legacy host'});const old=await occupation(f);
  const question=f.add('assistant',mode==='generated'?'[插件任务] 你现在仍然是一名大学教师吗？':mode==='sensitive question'?'你现在仍然是一名大学教师吗？密码：placeholder':mode==='third party'?'你的朋友现在仍然是一名大学教师吗？':mode==='truncated question'?'你现在仍然是一名大学教师吗？'+'背景'.repeat(1600):'你现在仍然是一名大学教师吗？');
  f.add('user','不是');
  if(mode==='ignored')f.a.store.setState('ignored:a',[question.id]);
  if(mode==='missing neighbor'){const entry=f.api.entry;f.api.entry=(...args)=>({...entry(...args),previousId:'no-such-record'});}
  assert.throws(()=>f.a.remember('a',correctionArgs(old)));assert.equal(f.a.store.get(old.id).revision,old.revision);assert.equal(f.a.store.get(old.id).state,'active');
 });
});

test('public remember still accepts a complete quotation located beyond a long record preview',t=>{
 const f=fixture(t);publicHistory(f);const quote='以后回答请先给结论再说明依据';const source=f.add('user','背景资料'.repeat(1500)+quote);
 const result=f.a.remember('a',{title:'表达偏好',content:'用户希望先给结论再说明依据',kind:'preference',topic:'response-style',subject:'user',quote});
 assert.equal(result.state,'active');assert.deepEqual(f.a.store.get(result.id).source.refs.map(ref=>[ref.id,ref.quote]),[[source.id,quote]]);
});

test('public correction consumes real authorized host history and persists independently of the background model',async t=>{
 const {PluginBackground}=await import('../../../../dist/extensions/background.js');
 const {SessionStore}=await import('../../../../dist/history/session-store.js');
 const f=fixture(t);f.target.provider='mock';f.target.model='tiny';
 const history=new SessionStore(path.join(f.target.cwd,'history.jsonl'),{create:{sessionId:'a',cwd:f.target.cwd}});
 let inferenceCalls=0;
 const host=new PluginBackground(path.join(f.target.cwd,'grants.json'),{targets:()=>[{...f.target}],store:()=>history,complete:async()=>{inferenceCalls++;throw Error('provider must not be called');}},new AbortController().signal);
 const grant=host.approve('assistant',host.prepare('assistant',{modelSessionId:'a',includedIds:['a'],excludedIds:[],includeHistory:true,dailyCalls:1}));
 Object.assign(f.api,host.bind('assistant',new AbortController().signal));
 f.a.store.setState('learning',{enabled:true,grantId:grant,modelSessionId:'a',includedIds:['a'],excludedIds:[],includeHistory:true,dailyCalls:1});
 await history.appendMessages([{role:'user',content:'我的职业是一名大学教师'}]);
 const old=f.a.remember('a',{title:'职业',content:'用户是一名大学教师',kind:'fact',topic:'occupation',subject:'user',quote:'我的职业是一名大学教师'});
 const ids=await history.appendMessages([{role:'assistant',content:'你现在仍然是一名大学教师吗？'},{role:'user',content:'不是'}]);
 assert.equal(f.api.entry(grant,'a',ids[1]).previousId,ids[0]);
 f.a.remember('a',correctionArgs(f.a.store.get(old.id)));f.restart();
 const corrected=f.a.store.get(old.id);assert.equal(corrected.state,'candidate');assert.equal(corrected.source.mode,'contradicted');
 assert.equal(corrected.source.refs[0].id,ids[1]);assert.equal(inferenceCalls,0);
 assert.equal(f.a.search('a','职业').length,0,'a contradicted fact is not recalled after restart');
});
