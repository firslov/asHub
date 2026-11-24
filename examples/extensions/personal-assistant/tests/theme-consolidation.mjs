import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../../../dist/history/session-store.js';
import { PluginBackground } from '../../../../dist/extensions/background.js';
import { Learning } from '../learning.mjs';
import { MemoryStore } from '../store.mjs';
import { themeRecall } from '../context.mjs';
import { maybeConsolidateOverview, themeEvidenceValid } from '../theme-overviews.mjs';

async function fixture(t,text='项目乙决定采用方案甲') {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'theme-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const target={id:'a',cwd:dir,title:'A',model:'m',provider:'p',busy:false,projectId:'b'};
 const projects=[{id:'a-project',name:'甲',nameObserved:'甲',nameSince:0},{id:'b',name:'乙',nameObserved:'乙',nameSince:0}];
 const history=new SessionStore(path.join(dir,'a.jsonl'),{create:{sessionId:'a',cwd:dir}});
 const [id]=await history.appendMessages([{role:'user',content:text}]);
 let resolve, calls=0;const requests=[];
 const host=new PluginBackground(path.join(dir,'grant.json'),{targets:()=>[target],store:()=>history,complete:async(_id,messages)=>{calls++;requests.push(JSON.parse(messages[1].content));return await new Promise(r=>{resolve=r})}},new AbortController().signal);
 const api=host.bind('plugin',new AbortController().signal);
 const grant=host.approve('plugin',host.prepare('plugin',{modelSessionId:'a',dailyCalls:4,includeHistory:true,excludedIds:[],includedIds:['a'],followModel:true}));
 const states=new Map([['learning',{enabled:true,grantId:grant,modelSessionId:'a'}]]);let enabled=true,generation=1;
 const saved=[];
 const row={id:'memory',revision:1,state:'active',scope:'project:b',kind:'fact',title:'决策',content:text,source:{type:'learned',grantId:grant,context:{projectId:'b',subject:'project',conversationId:'a'},refs:[{conversationId:'a',id,quote:text,at:Date.now()}]}};
 const db={state:k=>states.get(k),setState:(k,v)=>states.set(k,v),profile:()=>({enabled:true,assistantId:'assistant'}),forgottenCopy:()=>false,activeMemories:()=>[row],get:key=>key===row.id?row:null,
 themeOverviewEnabled:()=>enabled,themeOverviewGeneration:()=>generation,listThemeStatements:()=>saved.flatMap(({statements,...group})=>statements.map(statement=>({...group,...statement}))),saveThemeStatements:value=>{if(!enabled||generation!==value.generation)throw Error('stale');saved.push(value)}};
 const a={store:db,services:{background:api,host:{projectNames:(entry,conversation,grantId)=>{assert.equal(entry,'assistant');assert.equal(conversation,target.id);const authorization=api.status(grantId);assert.equal(authorization.followModel,true);assert.deepEqual(authorization.includedIds,[conversation]);return projects;}}},visible:()=>true,dedicated:false,snapshot:()=>({projects:projects.map(({id,name})=>({id,name}))}),conversationId:()=>target.id};
 const learning=new Learning(a);a.learning=learning; const config=learning.config();
 return {dir,target,projects,history,host,api,grant,db,a,learning,config,row,saved,id,requests,calls:()=>calls,resolve:value=>resolve(value),toggle:()=>{enabled=!enabled;generation++},run:()=>maybeConsolidateOverview(learning,config,target,learning.controller.signal)};
}

test('real host revalidates branch, authorization, source revision and pilot generation after inference',async t=>{
 for(const action of ['rewind','revoke','reauthorize','revision','toggle','cancel','forget']) {
  await t.test(action,async t=>{
   const f=await fixture(t);const pending=f.run();assert.equal(f.calls(),1);
   if(action==='rewind')f.history.setActiveLeaf('a');
   if(action==='revoke')f.api.revoke(f.grant);
   if(action==='reauthorize')f.host.approve('plugin',f.host.prepare('plugin',{modelSessionId:'a',dailyCalls:4,includeHistory:true,excludedIds:[]}));
   if(action==='revision')f.row.revision++;
   if(action==='toggle'){f.toggle();f.toggle();}
   if(action==='cancel')f.learning.cancel();
   if(action==='forget')f.db.setState('ignored:a',[f.id]);
   f.resolve('{"indices":[0]}');
   try {assert.equal(await pending,false)} catch(e){assert(['cancel','revoke','reauthorize'].includes(action));}
   assert.equal(f.saved.length,0);
  });
 }
});
test('source excerpts remain exact and a failed daily attempt is not retried',async t=>{
 const f=await fixture(t);const pending=f.run();f.resolve('{"indices":[0]}');assert(await pending);
 const statement=f.saved[0].statements[0];assert.equal(statement.text,f.row.content);assert(themeEvidenceValid(f.a,statement));
 assert.equal(await f.run(),false);assert.equal(f.calls(),1);
 f.row.revision++;assert(!themeEvidenceValid(f.a,statement));
});
test('moved project, ambiguous names and unmarked old records do not establish project attribution',async t=>{
 for(const text of ['决定采用方案甲','项目乙和项目甲决定采用方案甲']) {
  await t.test(text,async t=>{const f=await fixture(t,text);assert.equal(await f.run(),false);assert.equal(f.calls(),0)});
 }
 const f=await fixture(t);f.projects.push({id:'duplicate',name:'乙',nameObserved:'乙',nameSince:0});assert.equal(await f.run(),false);assert.equal(f.calls(),0);
});
test('ordinary backlog prevents a theme call and cancellation is isolated',async t=>{
 const f=await fixture(t);f.learning.historyBatch=()=>({records:[],context:[],backlog:true,state:{}});
 f.learning.commitScan=()=>{};f.learning.deferred=()=>[];f.learning.flushDeferred=()=>0;f.learning.recoverResult=()=>false;
 f.learning.reconcileLegacy=async()=>false;f.learning.setHealth=()=>{};
 await f.learning.tick();assert.equal(f.calls(),0);
 const normal=f.learning.controller.signal;f.learning.cancelThemeOverview();assert.equal(normal.aborted,false);
});
test('crossing UTC day discards the late response and permits a new-day attempt',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T23:59:59.000Z')});
 const f=await fixture(t);const pending=f.run();
 t.mock.timers.setTime(Date.parse('2026-11-25T00:00:01.000Z'));f.resolve('{"indices":[0]}');assert.equal(await pending,false);assert.equal(f.saved.length,0);
 const next=f.run();assert.equal(f.calls(),2);f.resolve('{"indices":[0]}');assert.equal(await next,true);
});
test('model-added prose is ignored and never enters the saved statement',async t=>{
 const f=await fixture(t);const pending=f.run();f.resolve('{"indices":[0],"text":"编造内容"}');assert.equal(await pending,true);
 assert.equal(f.saved[0].statements[0].text,f.row.content);
});
test('dedicated conversation can bind an unambiguous project suffix to its stable ID',async t=>{
 const f=await fixture(t,'北辰项目决定采用方案甲');
 f.projects.splice(0,f.projects.length,{id:'north',name:'北辰',nameObserved:'北辰',nameSince:0},{id:'short',name:'辰',nameObserved:'辰',nameSince:0});
 f.target.projectId=null;f.row.scope='conversation:a';f.row.source.context={subject:'other',conversationId:'a'};
 const pending=f.run();assert.equal(f.calls(),1);f.resolve('{"indices":[0]}');assert(await pending);
 assert.equal(f.saved[0].projectId,'north');assert(themeEvidenceValid(f.a,f.saved[0].statements[0]));
 const altered={...f.saved[0],projectId:'short'};assert(!themeEvidenceValid(f.a,f.saved[0].statements[0],altered));
 assert(!themeEvidenceValid(f.a,{...f.saved[0].statements[0],text:'伪造',matched:true},f.saved[0]));
});
test('distinct verified events support a preference and are rechecked when read',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T08:00:00Z')});
 const first='我工作协作时习惯先给结论，再说明依据。',second='换个话题，日常协作报告请先写结论和依据。';
 const f=await fixture(t,first);f.row.kind='preference';f.row.scope='personal';f.row.source.context={subject:'user',conversationId:'a'};
 t.mock.timers.setTime(Date.parse('2026-11-24T15:00:00Z'));
 const [id]=await f.history.appendMessages([{role:'user',content:second}]);f.row.source.refs.push({conversationId:'a',id,quote:second,at:Date.now()});
 const pending=f.run();assert.equal(f.calls(),1);f.resolve('{"indices":[0]}');assert(await pending);
 const statement=f.saved[0].statements[0];assert.equal(statement.evidence.length,2);assert(themeEvidenceValid(f.a,statement));
 f.history.setActiveLeaf(f.id);assert(!themeEvidenceValid(f.a,statement));
});
test('two project decisions produce a locally ordered, independently cited timeline',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T08:00:00Z')});
 const f=await fixture(t);t.mock.timers.setTime(Date.parse('2026-11-24T09:00:00Z'));
 const text='项目乙决定改为方案乙';const [id]=await f.history.appendMessages([{role:'user',content:text}]);
 const row={...f.row,id:'memory2',content:text,source:{...f.row.source,refs:[{conversationId:'a',id,quote:text,at:Date.now()}]}};
 f.db.activeMemories=()=>[f.row,row];f.db.get=key=>key===f.row.id?f.row:key===row.id?row:null;
 const pending=f.run();f.resolve('{"indices":[1,0]}');assert(await pending);
 const statements=f.saved[0].statements;assert.deepEqual(statements.map(s=>s.text),['项目乙决定采用方案甲','项目乙决定改为方案乙']);
 assert(statements.every(s=>s.evidence.length===1 && themeEvidenceValid(f.a,s)));
});
test('real theme store round trip and repeated basis skip inference',async t=>{
 const f=await fixture(t);const db=new MemoryStore(path.join(f.dir,'memory'));t.after(()=>db.close());
 db.setState('learning',f.config);db.setThemeOverviewEnabled(true);
 db.add({title:'决策',content:f.row.content,scope:'project:b',kind:'fact'},f.row.source,'active');
 f.a.store=db;f.learning.db=db;
 const pending=f.run();assert.equal(f.calls(),1);f.resolve('{"indices":[0]}');assert(await pending);
 const [stored]=db.listThemeStatements();assert.equal(stored.kind,'project');assert(themeEvidenceValid(f.a,stored));
 db.setState('theme-overview:day',null);assert.equal(await f.run(),false);assert.equal(f.calls(),1);
});
test('a concurrent ordinary tick aborts the in-flight theme without cancelling ordinary learning',async t=>{
 const f=await fixture(t);f.learning.historyBatch=()=>({records:[],context:[],backlog:false,state:{}});
 f.learning.commitScan=()=>{};f.learning.deferred=()=>[];f.learning.flushDeferred=()=>0;f.learning.recoverResult=()=>false;
 f.learning.reconcileLegacy=async()=>false;f.learning.setHealth=()=>{};
 const normal=f.learning.controller.signal,pending=f.learning.tick();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls(),1);assert.equal(f.learning.themeActive,true);
 await f.learning.tick();assert.equal(normal.aborted,false);f.resolve('{"indices":[0]}');await pending;
 assert.equal(f.saved.length,0);assert.equal(f.learning.themeActive,false);
});
test('English project names have strict word boundaries',async t=>{
 const f=await fixture(t,'Project AtlasNext decided to use blue');f.projects.splice(0,f.projects.length,{id:'b',name:'Atlas',nameObserved:'Atlas',nameSince:0});
 assert.equal(await f.run(),false);assert.equal(f.calls(),0);
});
test('same-millisecond project decisions follow history predecessor order',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T08:00:00Z')});
 const f=await fixture(t),text='项目乙决定改为方案乙';const [id]=await f.history.appendMessages([{role:'user',content:text}]);
 const row={...f.row,id:'memory2',content:text,source:{...f.row.source,refs:[{conversationId:'a',id,quote:text,at:Date.now()}]}};
 f.db.activeMemories=()=>[row,f.row];f.db.get=key=>key===f.row.id?f.row:key===row.id?row:null;
 const pending=f.run();f.resolve('{"indices":[0,1]}');assert(await pending);
 assert.deepEqual(f.saved[0].statements.map(s=>s.text),['项目乙决定采用方案甲','项目乙决定改为方案乙']);
});
test('long selected project excerpts are bounded without cutting a source',async t=>{
 const f=await fixture(t,'项目乙决定采用方案一'+ '甲'.repeat(250));const rows=[f.row];
 for(let i=2;i<=4;i++){
  const text=`项目乙决定采用方案${i}`+'乙'.repeat(250),[id]=await f.history.appendMessages([{role:'user',content:text}]);
  rows.push({...f.row,id:'memory'+i,content:text,source:{...f.row.source,refs:[{conversationId:'a',id,quote:text,at:Date.now()}]}});
 }
 f.db.activeMemories=()=>rows;f.db.get=key=>rows.find(r=>r.id===key);
 const pending=f.run();f.resolve('{"indices":[0,1,2,3]}');assert(await pending);
 const statements=f.saved[0].statements;assert.equal(statements.length,4);assert(statements.every(s=>s.text.length<=1000 && themeEvidenceValid(f.a,s)));
});
test('idle single-evidence preferences do not read original messages',async t=>{
 const f=await fixture(t),row={...f.row,scope:'personal',kind:'preference',source:{...f.row.source,context:{subject:'user'}}};
 f.db.activeMemories=()=>Array.from({length:200},(_,i)=>({...row,id:String(i)}));let reads=0;
 const entry=f.api.entry;f.learning.api={...f.api,entry:(...args)=>{reads++;return entry(...args)}};f.a.services.background=f.learning.api;
 assert.equal(await f.run(),false);assert.equal(reads,0);assert.equal(f.calls(),0);
});
test('one source cannot become two timeline decisions through duplicate memories',async t=>{
 const f=await fixture(t),row={...f.row,id:'duplicate'};f.db.activeMemories=()=>[f.row,row];f.db.get=key=>key===row.id?row:f.row;
 const pending=f.run();f.resolve('{"indices":[0]}');assert(await pending);
 assert.equal(f.saved[0].statements[0].text,f.row.content);assert.equal(f.saved[0].statements[0].evidence.length,1);
});
test('replayed original with a copy prefix is not an independent preference event',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T08:00:00Z')});
 const first='我工作协作时习惯先给结论，再说明依据。',f=await fixture(t,first);
 f.row.kind='preference';f.row.scope='personal';f.row.source.context={subject:'user',conversationId:'a'};
 t.mock.timers.setTime(Date.parse('2026-11-25T15:00:00Z'));const text='再次复制原话：'+first;
 const [id]=await f.history.appendMessages([{role:'user',content:text}]);f.row.source.refs.push({conversationId:'a',id,quote:text,at:Date.now()});
 assert.equal(await f.run(),false);assert.equal(f.calls(),0);
});
test('historical project names follow verified time intervals across rename and reuse',async t=>{
 const f=await fixture(t,'项目甲决定采用方案甲'), at=f.row.source.refs[0].at;
 f.projects.splice(0,f.projects.length,
  {id:'a-project',name:'新甲',nameObserved:'新甲',nameSince:at+10,nameHistory:[{name:'甲',from:0,to:at+10}]},
  {id:'b',name:'甲',nameObserved:'甲',nameSince:at+20});
 const pending=f.run();assert.equal(f.calls(),1);f.resolve('{"indices":[0]}');assert(await pending);
 assert.equal(f.saved[0].projectId,'a-project');assert(themeEvidenceValid(f.a,f.saved[0].statements[0]));
});
test('unverified or boundary-time project names cannot attribute old evidence',async t=>{
 for(const project of [{id:'b',name:'乙',nameObserved:'乙'}, {id:'b',name:'乙',nameObserved:'乙',boundary:true}, {id:'b',name:'乙',nameObserved:'other',nameSince:0}]) {
  await t.test(JSON.stringify(project),async t=>{
   const f=await fixture(t);if(project.boundary)project.nameSince=f.row.source.refs[0].at;
   f.projects.splice(0,f.projects.length,project);assert.equal(await f.run(),false);assert.equal(f.calls(),0);
  });
 }
});
test('rewinding one project step leaves the independent step visible through normal recall',async t=>{
 const f=await fixture(t);const text='项目乙决定改为方案乙';const [id]=await f.history.appendMessages([{role:'user',content:text}]);
 const second={...f.row,id:'second',content:text,source:{...f.row.source,refs:[{conversationId:'a',id,quote:text,at:Date.now()}]}};
 const db=new MemoryStore(path.join(f.dir,'normal-recall'));t.after(()=>db.close());db.setState('learning',f.config);db.setThemeOverviewEnabled(true);
 db.add({title:'第一步',content:f.row.content,scope:'project:b',kind:'fact'},f.row.source,'active');
 db.add({title:'第二步',content:second.content,scope:'project:b',kind:'fact'},second.source,'active');
 f.a.store=db;f.learning.db=db;f.a.dedicated=true;f.learning.access=()=>true;
 const pending=f.run();f.resolve('{"indices":[0,1]}');assert(await pending);
 const stored=db.listThemeStatements();assert.deepEqual(stored.map(row=>row.text),[f.row.content,second.content]);
 assert.deepEqual(stored.map(row=>row.validFrom),[f.api.entry(f.grant,'a',f.id).at,f.api.entry(f.grant,'a',id).at]);
 assert(stored.every(row=>themeEvidenceValid(f.a,row)));
 let recalled=themeRecall(f.a,{instanceId:'a',projectId:'b'},'项目乙决策脉络');assert.equal(recalled.statements.length,2);
 f.history.setActiveLeaf(f.id);
 recalled=themeRecall(f.a,{instanceId:'a',projectId:'b'},'项目乙决策脉络');
 assert.deepEqual(recalled.statements.map(x=>x.text),[f.row.content]);
});
test('trimmed display preserves original offsets and validates after storage',async t=>{
 const raw='  项目乙决定采用方案甲  ',f=await fixture(t,raw);
 const db=new MemoryStore(path.join(f.dir,'padded'));t.after(()=>db.close());db.setState('learning',f.config);db.setThemeOverviewEnabled(true);
 db.add({title:'决策',content:raw,scope:'project:b',kind:'fact'},f.row.source,'active');f.a.store=db;f.learning.db=db;
 const pending=f.run();f.resolve('{"indices":[0]}');assert(await pending);
 const [statement]=db.listThemeStatements();assert.equal(statement.text,raw.trim());
 assert.equal(statement.evidence[0].start,0);assert.equal(statement.evidence[0].end,raw.length);assert(themeEvidenceValid(f.a,statement));
});
test('public project snapshot omits history and restricted metadata enables normal recall',async t=>{
 const f=await fixture(t,'北辰项目决定采用方案甲');f.projects.splice(0,f.projects.length,{id:'north',name:'北辰',nameObserved:'北辰',nameSince:0});
 f.target.projectId=null;f.row.scope='conversation:a';f.row.source.context={subject:'other',conversationId:'a'};
 assert.deepEqual(f.a.snapshot().projects,[{id:'north',name:'北辰'}]);
 const db=new MemoryStore(path.join(f.dir,'restricted-names'));t.after(()=>db.close());db.setState('learning',f.config);db.setThemeOverviewEnabled(true);
 db.add({title:'决策',content:f.row.content,scope:'conversation:a',kind:'fact'},f.row.source,'active');f.a.store=db;f.learning.db=db;f.a.dedicated=true;f.learning.access=()=>true;
 const pending=f.run();assert.equal(f.calls(),1);f.resolve('{"indices":[0]}');assert(await pending);
 const [stored]=db.listThemeStatements();assert.equal(stored.projectId,'north');assert(themeEvidenceValid(f.a,stored));
 assert.deepEqual(themeRecall(f.a,{instanceId:'a',projectId:null},'北辰项目的决策脉络').statements.map(s=>s.text),[f.row.content]);
 f.a.services.host.projectNames=()=>{throw Error('revoked')};assert(!themeEvidenceValid(f.a,stored));
});
test('missing or denied project metadata never falls back to snapshot and does not block preferences',async t=>{
 for(const unavailable of [undefined,()=>{throw Error('unavailable')}])await t.test(String(unavailable),async t=>{
  const f=await fixture(t,'我确认以后协作报告一律先给结论。');f.a.services.host.projectNames=unavailable;
  f.a.snapshot=()=>({projects:[{id:'b',name:'乙',nameSince:0,nameObserved:'乙'}]});
  f.row.kind='preference';f.row.scope='personal';f.row.source.context={subject:'user',conversationId:'a'};
  const pending=f.run();assert.equal(f.calls(),1);f.resolve('{"indices":[0]}');assert(await pending);
  assert.equal(f.saved[0].kind,'preference');assert(themeEvidenceValid(f.a,f.saved[0].statements[0]));
 });
 const f=await fixture(t);f.a.services.host.projectNames=undefined;
 f.a.snapshot=()=>({projects:[{id:'b',name:'乙',nameSince:0,nameObserved:'乙'}]});
 assert.equal(await f.run(),false);assert.equal(f.calls(),0);
});
test('long project history supplies earliest, latest and middle decisions within eight candidates',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-01T08:00:00Z')});
 const f=await fixture(t,'项目乙决定初始原则：离线处理');const rows=[f.row],start=Date.now();
 for(let i=1;i<22;i++) {
  t.mock.timers.setTime(start+i*86400000);
  const text=`项目乙决定第${i}阶段方案：执行复核`,[id]=await f.history.appendMessages([{role:'user',content:text}]);
  rows.push({...f.row,id:`memory${i}`,content:text,source:{...f.row.source,refs:[{conversationId:'a',id,quote:text,at:Date.now()}]}});
 }
 f.db.activeMemories=()=>[...rows].reverse();f.db.get=key=>rows.find(r=>r.id===key);
 const pending=f.run();assert.equal(f.calls(),1);
 const excerpts=f.requests[0].excerpts;assert.equal(excerpts.length,8);
 assert.equal(excerpts[0].text,rows[0].content);assert.equal(excerpts.at(-1).text,rows.at(-1).content);
 assert(excerpts.slice(1,-1).every(x=>x.text!==rows[0].content && x.text!==rows.at(-1).content));
 f.resolve('{"indices":[0,7]}');assert(await pending);
 assert.deepEqual(f.saved[0].statements.map(s=>s.text),[rows[0].content,rows.at(-1).content]);
});
test('same-name create, rename and historical end boundaries block attribution',async t=>{
 for(const boundary of ['create','rename-from','rename-to']) await t.test(boundary,async t=>{
  const f=await fixture(t),at=f.api.entry(f.grant,'a',f.id).at;
  const b=boundary==='create' ? {id:'other',name:'乙',nameObserved:'乙',nameSince:at}
   : boundary==='rename-from' ? {id:'other',name:'其他',nameObserved:'其他',nameSince:at+10,nameHistory:[{name:'乙',from:at,to:at+10}]}
   : {id:'other',name:'其他',nameObserved:'其他',nameSince:at,nameHistory:[{name:'乙',from:0,to:at}]};
  f.projects.push(b);assert.equal(await f.run(),false);assert.equal(f.calls(),0);
 });
});
test('unrelated name boundaries and expired name intervals do not block attribution',async t=>{
 const f=await fixture(t),at=f.api.entry(f.grant,'a',f.id).at;
 f.projects.push({id:'other',name:'甲',nameObserved:'甲',nameSince:at,nameHistory:[{name:'乙',from:0,to:at-1}]});
 const pending=f.run();assert.equal(f.calls(),1);f.resolve('{"indices":[0]}');assert(await pending);
 assert.equal(f.saved[0].projectId,'b');
});


test('deleted longer project name does not become a short-name project decision',async t=>{
 const f=await fixture(t,'北辰项目决定采用方案甲');
 f.projects.splice(0,f.projects.length,{id:'short',name:'辰',nameObserved:'辰',nameSince:0});
 f.row.scope='conversation:a';f.row.source.context={subject:'other',conversationId:'a'};
 assert.equal(await f.run(),false);assert.equal(f.calls(),0);
 for(const text of ['辰项目决定采用方案甲','项目辰决定采用方案甲','关于辰项目决定采用方案甲','我们在辰项目决定采用方案甲']) {
  await t.test(text,async t=>{const g=await fixture(t,text);g.projects.splice(0,g.projects.length,{id:'short',name:'辰',nameObserved:'辰',nameSince:0});g.row.scope='conversation:a';g.row.source.context={subject:'other',conversationId:'a'};const pending=g.run();assert.equal(g.calls(),1);g.resolve('{"indices":[0]}');assert.equal(await pending,true);assert.equal(g.saved[0].projectId,'short');});
 }
});


test('project overview requires a definite project decision both on write and read',async t=>{
 for(const [scope,subject,text] of [
  ['personal','user','我在项目乙做过方案文档，后来改学了财会。'],
  ['project:b','project','项目乙方案文档的名字是 quickstart.md。'],
  ['project:b','project','项目乙还没有决定采用哪个数据库。'],
  ['project:b','project','项目乙尚待确定采用哪个方案。'],
 ]) await t.test(text,async t=>{const f=await fixture(t,text);f.row.scope=scope;f.row.source.context.subject=subject;assert.equal(await f.run(),false);assert.equal(f.calls(),0);});
 const f=await fixture(t,'项目乙决定采用方案甲');const pending=f.run();f.resolve('{"indices":[0]}');assert(await pending);assert(themeEvidenceValid(f.a,f.saved[0].statements[0]));
 f.row.scope='personal';f.row.source.context.subject='user';assert(!themeEvidenceValid(f.a,f.saved[0].statements[0]));
});


test('project-name prefix cannot claim a longer unregistered project',async t=>{
 const f=await fixture(t,'项目乙实验室已经决定采用方案甲');
 assert.equal(await f.run(),false);assert.equal(f.calls(),0);
 const g=await fixture(t,'项目乙已经决定采用方案甲');const pending=g.run();g.resolve('{"indices":[0]}');assert(await pending);
});


test('quoted replay is not independent preference evidence',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T08:00:00Z')});
 const text='我喜欢汇报先说结论，再列理由。',f=await fixture(t,text);f.row.kind='preference';f.row.scope='personal';f.row.source.context={subject:'user',conversationId:'a'};
 t.mock.timers.setTime(Date.parse('2026-11-25T09:00:00Z'));const quote='「'+text+'」',[id]=await f.history.appendMessages([{role:'user',content:quote}]);
 f.row.source.refs.push({conversationId:'a',id,quote,at:Date.now()});assert.equal(await f.run(),false);assert.equal(f.calls(),0);
});


test('a name extended by a boundary-like word is not a shorter project',async t=>{
 const f=await fixture(t,'项目乙计划已经决定采用方案甲');assert.equal(await f.run(),false);assert.equal(f.calls(),0);
});

test('model policy changes discard late theme results and retain the shared UTC-day attempt',async t=>{
 for(const notification of [true,false])await t.test(notification?'notified':'status revision only',async t=>{
  const f=await fixture(t);let revision=0;
  const status=f.api.status.bind(f.api);
  f.learning.api={...f.api,status:g=>({...status(g),modelRevision:revision})};
  const pending=f.run();assert.equal(f.calls(),1);const spent=f.api.status(f.grant).calls;
  revision=1;if(notification)assert(f.learning.modelPolicyChanged(f.grant));
  f.resolve('{"indices":[0]}');try{assert.equal(await pending,false);}catch(e){assert(notification&&e.name==='AbortError');}
  assert.equal(f.saved.length,0);assert.equal(f.api.status(f.grant).calls,spent);
  assert.equal(await f.run(),false,'switching model must not reset the daily theme limit');assert.equal(f.calls(),1);
 });
});

test('theme selection shares the real host four-call daily allowance with ordinary inference',async t=>{
 const f=await fixture(t),request=[{role:'system',content:'synthetic request'},{role:'user',content:'{}'}];
 for(let i=0;i<3;i++){const pending=f.api.infer(f.grant,request);f.resolve('{}');await pending;}
 assert.equal(f.api.status(f.grant).calls,3);
 const pending=f.run();assert.equal(f.calls(),4);f.resolve('{"indices":[0]}');assert(await pending);
 assert.equal(f.api.status(f.grant).calls,4);await assert.rejects(f.api.infer(f.grant,request),/额度/);
});

test('a followed model target change rejects a late theme result even without a revision increment',async t=>{
 const f=await fixture(t);const status=f.api.status.bind(f.api);let model='first';
 f.learning.api={...f.api,status:g=>({...status(g),modelRevision:0,modelTarget:{conversationId:'a',cwd:f.target.cwd,provider:'test',model}})};
 const pending=f.run();model='second';f.resolve('{"indices":[0]}');assert.equal(await pending,false);
 assert.equal(f.saved.length,0);assert.equal(f.calls(),1);assert.equal(await f.run(),false);
});
