import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Assistant} from '../shared.mjs';

function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-model-policy-'));
 const records=[],calls=[];let revision=0,enabled=true,modelTarget,reply=async()=>({memories:[]});
 const target={id:'a',instanceId:'a',cwd:dir,kind:'agent',title:'助手',busy:false};
 const api={
  status:g=>{if(g!=='grant'||!enabled)throw Error('授权不可用');return {includedIds:['a'],excludedIds:[],since:0,includeHistory:true,dailyCalls:4,calls:calls.length,day:new Date().toISOString().slice(0,10),modelRevision:revision,...(modelTarget!==undefined?{modelTarget}:{})};},
  targets:g=>{api.status(g);return [target];},
  read:(g,_id,cursor)=>{api.status(g);const i=records.findIndex(r=>r.id===cursor),rows=records.slice(i+1);return {entries:rows.map(r=>({...r,text:r.text.slice(0,3000),truncated:r.text.length>3000})),cursor:rows.at(-1)?.id??cursor??null,more:false,reset:!!cursor&&i<0};},
  entry:(g,_id,id,offset=0)=>{api.status(g);const row=records.find(r=>r.id===id);if(!row)throw Error('missing');const text=row.text.slice(offset,offset+3000);return {...row,text,offset,nextOffset:offset+text.length,more:offset+text.length<row.text.length};},
  valid:(g,_id,ids)=>{api.status(g);return ids.filter(id=>records.some(r=>r.id===id));},
  infer:async(g,messages,signal)=>{api.status(g);if(calls.length>=4)throw Error('今日额度已用完');const request=JSON.parse(messages[1].content);calls.push({revision,request,signal});return JSON.stringify(await reply(request,signal));},
  revoke:()=>{enabled=false;},
 };
 const services={dataDirectory:dir,conversations:{get:()=>target.id},background:api,host:{snapshot:()=>({sessions:[target],projects:[]})}};
 let a=new Assistant(services);
 const config={enabled:true,grantId:'grant',modelSessionId:'a',includedIds:['a'],excludedIds:[],includeHistory:true,dailyCalls:4};
 a.store.setState('learning',config);
 t.after(()=>{a.stop();fs.rmSync(dir,{recursive:true,force:true});});
 return {get a(){return a;},api,records,calls,target,add(text){const row={id:'r'+records.length,role:'user',text,at:Date.now()-120000+records.length};records.push(row);return row;},
  reply(fn){reply=fn;},switchTo(value){revision=value;},setTarget(value){modelTarget=value;},restart(){a.stop();a=new Assistant(services);},revision:()=>revision};
}
const fact=r=>({title:'职业',content:'用户是一名大学教师',kind:'fact',scope:'personal',subject:'user',certainty:'explicit',topic:'occupation',aliases:[],evidence:[{id:r.id,quote:r.text}]});
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};

test('model policy switch cancels late normal inference without resetting scope, cursor or quota',async t=>{
 const f=fixture(t),row=f.add('我是一名大学教师'),held=gate();f.reply(()=>held.promise);
 const pending=f.a.learning.tick();assert.equal(f.calls.length,1);
 const before=f.a.store.state('scan:a'),scope=f.a.learning.scopeKey(f.a.learning.config(),f.target),signal=f.calls[0].signal;
 f.switchTo(1);assert.equal(f.a.learning.modelPolicyChanged('grant'),true);assert(signal.aborted);
 held.resolve({memories:[fact(row)]});await pending;
 assert.equal(f.a.store.activeMemories().length,0);assert(f.a.store.state('learning-result:a')==null);
 assert.equal(f.a.store.state('scan:a').cursor,before.cursor);assert.equal(f.a.learning.scopeKey(f.a.learning.config(),f.target),scope);
 assert.equal(f.calls.length,1);assert.equal(f.a.learning.health().errorClass,null);
 f.reply(()=>({memories:[fact(row)]}));await f.a.learning.tick();
 assert.equal(f.calls.length,2);assert.equal(f.calls[1].revision,1);assert.equal(f.a.store.activeMemories()[0].content,'用户是一名大学教师');
 assert.equal(f.a.store.state('scan:a').cursor,row.id);
});

test('model revision is checked even if a change notification is delayed',async t=>{
 const f=fixture(t),row=f.add('我是一名大学教师'),held=gate();f.reply(()=>held.promise);
 const pending=f.a.learning.tick();f.switchTo(1);held.resolve({memories:[fact(row)]});await pending;
 assert.equal(f.a.store.activeMemories().length,0);assert(f.a.store.state('learning-result:a')==null);
 assert.notEqual(f.a.store.state('scan:a')?.cursor,row.id);
});

test('restart reuses only same-policy extraction receipts, including legacy revision zero',async t=>{
 for(const scenario of ['same','legacy-zero','changed','back-to-first'])await t.test(scenario,async t=>{
  const f=fixture(t),row=f.add('我是一名大学教师');f.reply(()=>({memories:[fact(row)]}));
  const learn=f.a.store.learn.bind(f.a.store);let fail=true;
  f.a.store.learn=(...args)=>{if(fail){fail=false;throw Error('synthetic disk failure');}return learn(...args);};
  await f.a.learning.tick();let receipt=f.a.store.state('learning-result:a');assert(receipt);assert.equal(receipt.modelRevision,0);
  if(scenario==='legacy-zero'){delete receipt.modelRevision;f.a.store.setState('learning-result:a',receipt);}
  const savedScan=f.a.store.state('scan:a');f.restart();f.a.store.setState('retry:a',null);
  if(scenario==='changed')f.switchTo(1);
  if(scenario==='back-to-first'){f.switchTo(1);f.a.learning.modelPolicyChanged('grant');f.switchTo(2);f.a.learning.modelPolicyChanged('grant');}
  await f.a.learning.tick();
  assert.equal(f.calls.length,['same','legacy-zero'].includes(scenario)?1:2);
  assert.equal(f.a.store.activeMemories()[0].content,'用户是一名大学教师');
  assert.equal(f.a.store.state('scan:a').cursor,row.id);assert.equal(savedScan.cursor??null,null);
 });
});

test('policy notification clears only stale extraction receipts and retains retry, history and committed memory',async t=>{
 const f=fixture(t);const row=f.add('我是一名大学教师');f.reply(()=>({memories:[fact(row)]}));await f.a.learning.tick();
 const before=f.a.store.activeMemories()[0],scan=f.a.store.state('scan:a'),retry={errorClass:'quota',failures:1,retryAt:Date.now()+100000};
 f.a.store.setState('retry:a',retry);f.a.store.setState('learning-result:a',{modelRevision:0,value:{memories:[]}});
 assert.equal(f.a.learning.modelPolicyChanged('unrelated'),false);assert(f.a.store.state('learning-result:a'));
 f.switchTo(1);assert(f.a.learning.modelPolicyChanged('grant'));assert(f.a.store.state('learning-result:a')==null);
 assert.deepEqual(f.a.store.state('scan:a'),scan);assert.deepEqual(f.a.store.state('retry:a'),retry);
 assert.equal(f.a.store.get(before.id).content,before.content);assert.equal(f.calls.length,1);
});

test('a new policy clears temporary backoff without removing recall or usage',async t=>{
 const f=fixture(t),first=f.add('我是一名大学教师');f.reply(()=>({memories:[fact(first)]}));await f.a.learning.tick();
 const memory=f.a.store.activeMemories()[0];f.add('我的下一条个人资料需要整理');f.reply(()=>{throw Error('synthetic provider unavailable');});
 await f.a.learning.tick();const retry=f.a.store.state('retry:a');assert.equal(retry.errorClass,'temporary');
 assert.equal(f.a.read('a',memory.id).content,memory.content);assert.equal(f.calls.length,2);
 f.switchTo(1);f.a.learning.modelPolicyChanged('grant');
 assert(f.a.store.state('retry:a')==null);assert.equal(f.a.read('a',memory.id).content,memory.content);
 f.reply(()=>({memories:[]}));await f.a.learning.tick();assert.equal(f.calls.length,3,'new policy can retry immediately');
});

test('same-policy restart rejects a receipt when its source is no longer on the active branch',async t=>{
 const f=fixture(t),old=f.add('我是一名大学教师');f.reply(()=>({memories:[fact(old)]}));
 f.a.store.learn=()=>{throw Error('synthetic disk failure');};await f.a.learning.tick();assert(f.a.store.state('learning-result:a'));
 f.restart();f.a.store.setState('retry:a',null);f.records.length=0;
 const replacement=f.add('我是一名大学教师');replacement.id='new-branch';f.reply(()=>({memories:[fact(replacement)]}));
 await f.a.learning.tick();assert.equal(f.calls.length,2);const row=f.a.store.activeMemories()[0];assert.equal(row.source.refs[0].id,'new-branch');
});

test('changing models mid-batch preserves a previously committed scan position',async t=>{
 const f=fixture(t),first=f.add('我是一名大学教师');f.reply(()=>({memories:[fact(first)]}));await f.a.learning.tick();
 assert.equal(f.a.store.state('scan:a').cursor,first.id);const next=f.add('我现在仍是一名大学教师'),held=gate();f.reply(()=>held.promise);
 const pending=f.a.learning.tick();assert.equal(f.calls.length,2);f.switchTo(1);f.a.learning.modelPolicyChanged('grant');
 held.resolve({memories:[fact(next)]});await pending;assert.equal(f.a.store.state('scan:a').cursor,first.id);
 f.reply(()=>({memories:[fact(next)]}));await f.a.learning.tick();assert.equal(f.a.store.state('scan:a').cursor,next.id);
 assert.equal(f.calls.length,3);
});

test('followed conversation model changes invalidate pending work without altering source scope',async t=>{
 const f=fixture(t),row=f.add('我是一名大学教师'),held=gate(),first={conversationId:'a',cwd:f.target.cwd,provider:'one',model:'alpha'};
 f.setTarget(first);f.reply(()=>held.promise);const pending=f.a.learning.tick();
 const scope=f.a.learning.scopeKey(f.a.learning.config(),f.target);
 f.setTarget({...first,model:'beta'});held.resolve({memories:[fact(row)]});await pending;
 assert.equal(f.a.store.activeMemories().length,0);assert(f.a.store.state('learning-result:a')==null);
 assert.equal(f.a.learning.health().errorClass,null);assert.equal(f.a.learning.scopeKey(f.a.learning.config(),f.target),scope);
 f.reply(()=>({memories:[fact(row)]}));await f.a.learning.tick();assert.equal(f.a.store.activeMemories().length,1);
});

test('restart only reuses a receipt for the same actual model target',async t=>{
 for(const changed of [false,true])await t.test(changed?'changed target':'unchanged target',async t=>{
  const f=fixture(t),row=f.add('我是一名大学教师'),target={conversationId:'a',cwd:f.target.cwd,provider:'one',model:'alpha'};
  f.setTarget(target);f.reply(()=>({memories:[fact(row)]}));f.a.store.learn=()=>{throw Error('synthetic disk failure');};
  await f.a.learning.tick();assert(f.a.store.state('learning-result:a')?.modelTargetKey);f.restart();f.a.store.setState('retry:a',null);
  if(changed)f.setTarget({...target,model:'beta'});
  await f.a.learning.tick();assert.equal(f.calls.length,changed?2:1);assert.equal(f.a.store.activeMemories().length,1);
 });
});

test('capacity-deferred source is reprocessed by the new policy without rewinding the cursor',async t=>{
 const f=fixture(t),row=f.add('我是一名大学教师');f.reply(()=>({memories:[fact(row)]}));
 f.a.store.learn=()=>{throw Object.assign(Error('记忆容量已满'),{code:'MEMORY_CAPACITY'});};
 await f.a.learning.tick();assert.equal(f.a.store.state('deferred:a').length,1);assert.equal(f.a.store.state('scan:a').cursor,row.id);
 f.switchTo(1);f.a.learning.modelPolicyChanged('grant');const pending=f.a.store.state('deferred:a');
 assert.equal(pending.length,1);assert.equal(pending[0].replay,true);assert(!JSON.stringify(pending).includes(row.text));
 f.restart();f.a.store.setState('retry:a',null);f.reply(()=>({memories:[fact(row)]}));await f.a.learning.tick();
 assert.equal(f.a.store.state('deferred:a').length,0);assert.equal(f.a.store.state('scan:a').cursor,row.id);
 assert.equal(f.a.store.activeMemories().length,1);assert.equal(f.calls.length,2);
});

test('forgotten or revoked replay sources are never read or inferred again',async t=>{
 for(const action of ['forget','revoke'])await t.test(action,async t=>{
  const f=fixture(t),row=f.add('我是一名大学教师');f.reply(()=>({memories:[fact(row)]}));
  f.a.store.learn=()=>{throw Object.assign(Error('记忆容量已满'),{code:'MEMORY_CAPACITY'});};await f.a.learning.tick();
  f.switchTo(1);f.a.learning.modelPolicyChanged('grant');f.restart();f.a.store.setState('retry:a',null);
  if(action==='forget')f.a.store.setState('ignored:a',[row.id]);else f.api.revoke('grant');
  let reads=0;const original=f.api.entry;f.api.entry=(...args)=>{reads++;return original(...args);};
  await f.a.learning.tick();assert.equal(f.calls.length,1);assert.equal(reads,0);assert.equal(f.a.store.activeMemories().length,0);
 });
});

test('429 uses bounded Retry-After seconds or date and falls back on malformed values',async t=>{
 for(const example of [
  {label:'seconds header',error:{status:429,headers:new Headers({'Retry-After':'180'})},delay:180000},
  {label:'HTTP date',error:{status:429,headers:new Headers({'Retry-After':'Tue, 24 Nov 2026 09:05:00 GMT'})},delay:300000},
  {label:'structured',error:{status:429,retry_after:90},delay:90000},
  {label:'Codex proxy nested',error:{type:'codex_proxy_error',error:{status:429,retryable:false,retry_after:'125'}},delay:125000},
  {label:'malformed',error:{status:429,headers:new Headers({'Retry-After':'bad'})},delay:60000},
  {label:'bounded',error:{status:429,retry_after:999999},delay:86400000},
 ])await t.test(example.label,async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T09:00:00Z')});
  const f=fixture(t);f.add('我是一名大学教师');f.reply(()=>{throw Object.assign(Error('rate limited'),example.error);});
  await f.a.learning.tick();assert.equal(f.a.store.state('retry:a').retryAt-Date.now(),example.delay);
  assert.equal(f.calls.length,1);await f.a.learning.tick();assert.equal(f.calls.length,1);
 });
});

test('unverifiable legacy receipt is not applied once the host supplies an execution target',async t=>{
 const f=fixture(t),row=f.add('我是一名大学教师');f.reply(()=>({memories:[fact(row)]}));
 f.a.store.learn=()=>{throw Error('synthetic disk failure');};await f.a.learning.tick();
 const old=f.a.store.state('learning-result:a');delete old.modelTargetKey;delete old.modelRevision;f.a.store.setState('learning-result:a',old);
 f.restart();f.a.store.setState('retry:a',null);f.setTarget({conversationId:'a',cwd:f.target.cwd,provider:'one',model:'alpha'});
 await f.a.learning.tick();assert.equal(f.calls.length,2,'unattested legacy model target requires a new extraction');assert.equal(f.a.store.activeMemories().length,1);
});

test('an unavailable execution target leaves already committed memory readable and schedules bounded retry',async t=>{
 const f=fixture(t),row=f.add('我是一名大学教师');f.reply(()=>({memories:[fact(row)]}));await f.a.learning.tick();
 const saved=f.a.store.activeMemories()[0];f.setTarget(null);f.add('新近需要整理的资料');await f.a.learning.tick();
 assert.equal(f.a.read('a',saved.id).content,saved.content);assert.equal(f.calls.length,1);
 assert.equal(f.a.store.state('retry:a').errorClass,'temporary');assert(f.a.store.state('retry:a').retryAt>Date.now());
});

test('host rejection from a followed-model switch does not create old-model backoff',async t=>{
 const f=fixture(t),row=f.add('我是一名大学教师'),target={conversationId:'a',cwd:f.target.cwd,provider:'one',model:'alpha'};
 f.setTarget(target);let reject;f.reply(()=>new Promise((_,r)=>{reject=r;}));
 const pending=f.a.learning.tick();f.setTarget({...target,model:'beta'});reject(Error('后台模型已切换，本次结果未保存'));
 await pending;assert(f.a.store.state('retry:a')==null);assert.equal(f.a.learning.health().errorClass,null);
 f.reply(()=>({memories:[fact(row)]}));await f.a.learning.tick();assert.equal(f.a.store.activeMemories().length,1);
});

test('a long deferred source is replayed at its cited offset without moving the scan cursor',async t=>{
 const f=fixture(t),quote='我是一名大学教师',row=f.add('背'.repeat(14000)+quote);
 const c=f.a.learning.config(),scopeKey=f.a.learning.scopeKey(c,f.target);
 f.a.store.setState('scan:a',{scopeKey,grantId:'grant',cursor:row.id});
 f.a.store.setState('deferred:a',[{scopeKey,key:'old',modelRevision:0,source:{refs:[{id:row.id,conversationId:'a',start:14000,end:14000+quote.length}]},value:{content:'old model result'}}]);
 f.switchTo(1);f.a.learning.modelPolicyChanged('grant');
 f.reply(request=>({memories:[fact({...row,text:quote})]}));await f.a.learning.tick();
 assert.equal(f.calls.length,1);assert(f.calls[0].request.records[0].text.includes(quote));
 assert.equal(f.a.store.activeMemories().length,1);assert.equal(f.a.store.state('scan:a').cursor,row.id);
});

test('the existing forget transaction removes retained replay source pointers',async t=>{
 const f=fixture(t),source=f.add('我是一名大学教师'),c=f.a.learning.config();
 const saved=f.a.store.add({title:'职业',content:source.text,kind:'fact',scope:'personal'},
  {type:'learned',namespace:'assistant-v4',grantId:'grant',context:{subject:'user',conversationId:'a'},refs:[{id:source.id,conversationId:'a',quote:source.text,at:source.at}],topic:'occupation'},'active');
 const scopeKey=f.a.learning.scopeKey(c,f.target);
 f.a.store.setState('deferred:a',[{scopeKey,key:'old',modelRevision:0,source:{refs:[{id:source.id,conversationId:'a',start:0,end:source.text.length}]},value:{content:'previous model text'}}]);
 f.switchTo(1);f.a.learning.modelPolicyChanged('grant');assert.equal(f.a.store.state('deferred:a')[0].replay,true);
 f.a.store.forget(saved.id,saved.revision);assert.equal(f.a.store.state('deferred:a').length,0);
});

test('replayed explicit correction can update the existing memory with new model output',async t=>{
 const f=fixture(t),first=f.add('我喜欢报告写得详细'),correction=f.add('我不再喜欢详细报告，以后报告保持简洁');
 const old=f.a.store.add({title:'报告偏好',content:'用户喜欢详细报告',kind:'preference',scope:'personal'},
  {type:'learned',namespace:'assistant-v4',grantId:'grant',certainty:'explicit',context:{subject:'user',conversationId:'a'},refs:[{id:first.id,conversationId:'a',quote:first.text,at:first.at}],topic:'report'},'active');
 const c=f.a.learning.config(),scopeKey=f.a.learning.scopeKey(c,f.target);
 f.a.store.setState('scan:a',{scopeKey,grantId:'grant',cursor:correction.id});
 f.a.store.setState('deferred:a',[{scopeKey,key:'old',modelRevision:0,source:{refs:[{id:correction.id,conversationId:'a',start:0,end:correction.text.length}]},alignment:{memoryId:old.id,revision:old.revision,relation:'revise'},value:{content:'old model answer'}}]);
 f.switchTo(1);f.a.learning.modelPolicyChanged('grant');
 const pending=f.a.store.state('deferred:a');assert(!JSON.stringify(pending).includes('old model answer'));assert(!JSON.stringify(pending).includes(old.id));
 f.reply(request=>{assert(request.existing.some(row=>row.id===old.id));return {memories:[{title:'报告偏好',content:'用户希望报告简洁',kind:'preference',scope:'personal',subject:'user',certainty:'explicit',topic:'report',aliases:[],memoryId:old.id,revision:old.revision,relation:'revise',evidence:[{id:correction.id,quote:correction.text}]}]};});
 await f.a.learning.tick();assert.equal(f.a.store.get(old.id).content,'用户希望报告简洁');assert.equal(f.a.store.state('scan:a').cursor,correction.id);
});

test('real host foreground A→B→A revision prevents parked receipt reuse after restart',async t=>{
 const {PluginBackground}=await import('../../../../dist/extensions/background.js');
 const {SessionStore}=await import('../../../../dist/history/session-store.js');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-model-aba-')),life=new AbortController(),id='aba123';
 const target={id,instanceId:id,cwd:dir,kind:'agent',title:'助手',provider:'mock',model:'alpha',busy:false};
 const history=new SessionStore(path.join(dir,'history.jsonl'),{create:{sessionId:id,cwd:dir}});
 let calls=0;const text='我是一名大学教师';
 const host=new PluginBackground(path.join(dir,'grants.json'),{targets:()=>[target],store:()=>history,
  complete:async()=>{calls++;return JSON.stringify({memories:[{title:calls===1?'旧回执':'新回执',content:'用户是一名大学教师',kind:'fact',scope:'personal',subject:'user',certainty:'explicit',topic:'occupation',aliases:[],evidence:[{id:history.getActiveLeaf(),quote:text}]}]});}},life.signal);
 const api=host.bind('assistant',life.signal),services={dataDirectory:dir,conversations:{get:()=>id},background:api,host:{snapshot:()=>({sessions:[target],projects:[]})}};
 let a=new Assistant(services);t.after(()=>{a.stop();life.abort();history.close?.();fs.rmSync(dir,{recursive:true,force:true});});
 const grant=host.approve('assistant',host.prepare('assistant',{modelSessionId:id,includedIds:[id],excludedIds:[],includeHistory:true,dailyCalls:4,followModel:true}));
 a.store.setState('learning',{enabled:true,grantId:grant,modelSessionId:id,includedIds:[id],excludedIds:[],includeHistory:true,dailyCalls:4});
 const [source]=await history.appendMessages([{role:'user',content:text}]);history.getEntry(source).timestamp=Date.now()-120000;
 a.store.learn=()=>{throw Error('synthetic disk failure');};await a.learning.tick();assert(a.store.state('learning-result:'+id));
 for(const model of ['beta','alpha']){target.model=model;host.noteForegroundModelChange(id,dir,'mock',model);}
 assert.equal(api.status(grant).modelRevision,2);
 a.stop();a=new Assistant(services);a.store.setState('retry:'+id,null);await a.learning.tick();
 assert.equal(calls,2);assert.equal(a.store.activeMemories()[0].title,'新回执');assert.equal(a.store.state('scan:'+id).cursor,source);
});

test('model switch replays multiple deferred sources together',async t=>{
 const f=fixture(t),first=f.add('我是一名大学教师。'),second=f.add('我每周三授课。');
 const result=()=>({memories:[{...fact(first),evidence:[{id:first.id,quote:first.text},{id:second.id,quote:second.text}]}]});
 f.reply(result);f.a.store.learn=()=>{throw Object.assign(Error('记忆容量已满'),{code:'MEMORY_CAPACITY'});};
 await f.a.learning.tick();assert.equal(f.a.store.state('deferred:a')[0].source.refs.length,2);
 f.switchTo(1);f.restart();f.reply(request=>{
  assert.deepEqual(request.records.filter(r=>r.role==='user').map(r=>r.id),[first.id,second.id]);return result();
 });
 await f.a.learning.tick();assert.equal(f.calls.length,2);assert.equal(f.a.store.activeMemories().length,1);
 assert.equal(f.a.store.state('scan:a').cursor,second.id);
});

test('automatic model switch clears only old model failure backoff',async t=>{
 for(const kind of ['temporary','format'])await t.test(kind,async t=>{
  const f=fixture(t),row=f.add('我是一名大学教师');
  f.reply(()=>{if(kind==='temporary')throw Error('synthetic transport failure');return 'bad';});
  await f.a.learning.tick();assert.equal(f.a.store.state('retry:a').errorClass,kind);
  f.switchTo(1);f.reply(()=>({memories:[fact(row)]}));await f.a.learning.tick();
  assert.equal(f.calls.length,2);assert.equal(f.a.store.activeMemories().length,1);
 });
});

test('deferred citations from one message are replayed in one continuous record',async t=>{
 const f=fixture(t),a='我是一名大学教师。',b='我每周三授课。',row=f.add(a+b);
 const result=()=>({memories:[{...fact(row),evidence:[{id:row.id,quote:a},{id:row.id,quote:b}]}]});
 f.reply(result);f.a.store.learn=()=>{throw Object.assign(Error('记忆容量已满'),{code:'MEMORY_CAPACITY'});};
 await f.a.learning.tick();assert.equal(f.a.store.state('deferred:a')[0].source.refs.length,2);
 f.switchTo(1);f.restart();f.reply(request=>{
  const records=request.records.filter(r=>r.id===row.id);assert.equal(records.length,1);
  assert(records[0].text.includes(a)&&records[0].text.includes(b));return result();
 });
 await f.a.learning.tick();assert.equal(f.calls.length,2);assert.equal(f.a.store.activeMemories().length,1);
});

test('irreducibly oversized replay retains pointers without blocking subsequent history',async t=>{
 const f=fixture(t),old=f.add('大学教师'+ '甲'.repeat(13000)+'每周三授课');f.reply(()=>({memories:[]}));await f.a.learning.tick();
 const scopeKey=f.a.learning.scopeKey(f.a.learning.config(),f.target);
 f.a.store.setState('scan:a',{...f.a.store.state('scan:a'),cursor:old.id,partial:null});
 f.a.store.setState('deferred:a',[{replay:true,scopeKey,key:'source:oversize',source:{refs:[
  {id:old.id,conversationId:'a',start:0,end:4},{id:old.id,conversationId:'a',start:13004,end:13009},
 ]}}]);
 const next=f.add('我是一名大学教师');f.reply(()=>({memories:[fact(next)]}));await f.a.learning.tick();
 assert.equal(f.a.store.state('deferred:a')[0].replayBlocked,true);assert.equal(f.a.store.state('scan:a').cursor,next.id);
 assert.equal(f.calls.length,2);assert.equal(f.a.store.activeMemories().length,1);
});
