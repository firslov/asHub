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

async function fixture(t,text='项目乙决定采用方案甲',before=[]) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'theme-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const target={id:'a',cwd:dir,title:'A',model:'m',provider:'p',busy:false,projectId:'b'};
 const projects=[{id:'a-project',name:'甲',nameObserved:'甲',nameSince:0},{id:'b',name:'乙',nameObserved:'乙',nameSince:0}];
 const history=new SessionStore(path.join(dir,'a.jsonl'),{create:{sessionId:'a',cwd:dir}});
 const ids=await history.appendMessages([...before,{role:'user',content:text}]);
 const id=ids.pop();
 let resolve, calls=0;const requests=[];
 const host=new PluginBackground(path.join(dir,'grant.json'),{targets:()=>[target],store:()=>history,complete:async(_id,messages)=>{calls++;requests.push(JSON.parse(messages[1].content));return await new Promise(r=>{resolve=r})}},new AbortController().signal);
 const api=host.bind('plugin',new AbortController().signal);
 const grant=host.approve('plugin',host.prepare('plugin',{modelSessionId:'a',dailyCalls:4,includeHistory:true,excludedIds:[],includedIds:['a'],followModel:true}));
 const states=new Map([['learning',{enabled:true,grantId:grant,modelSessionId:'a'}]]);let enabled=true,generation=1;
 const saved=[];
 const row={id:'memory',revision:1,state:'active',scope:'project:b',kind:'fact',title:'决策',content:text,source:{type:'learned',grantId:grant,context:{projectId:'b',subject:'project',conversationId:'a'},refs:[{conversationId:'a',id,quote:text,at:Date.now()}]}};
 const db={state:k=>states.get(k),setState:(k,v)=>states.set(k,v),profile:()=>({enabled:true,assistantId:'assistant'}),forgottenCopy:()=>false,activeMemories:()=>[row],get:key=>key===row.id?row:null,
 themeOverviewEnabled:()=>enabled,themeOverviewGeneration:()=>generation,listThemeStatements:()=>saved.flatMap(({statements,...group})=>statements.map(statement=>({...group,...statement}))),saveThemeStatements:value=>{
  if(!enabled||generation!==value.generation)throw Error('stale');
  if(value.reviewed)states.set('theme-overview:review:'+value.themeKey,value.reviewProgress??value.basisKey);
  saved.push(value);
 }};

 const a={store:db,services:{background:api,host:{projectNameHistory:(entry,conversation,grantId)=>{assert.equal(entry,'assistant');assert.equal(conversation,target.id);const authorization=api.status(grantId);assert.equal(authorization.followModel,true);assert.deepEqual(authorization.includedIds,[conversation]);return {projects,gaps:[]};}}},visible:()=>true,dedicated:false,snapshot:()=>({projects:projects.map(({id,name})=>({id,name}))}),conversationId:()=>target.id};
 const learning=new Learning(a);a.learning=learning; const config=learning.config();
 const reply=(indices=[0], statuses=[])=>{
  const {kind,excerpts}=requests.at(-1);
  if(kind==='preference')return JSON.stringify({indices});
  return JSON.stringify({indices,decisions:excerpts.map(({index,text})=>{
   const status=statuses[index]??'settled';
   return {index,status,...(status==='settled'?{quote:text}:{})};
  })});
 };
 return {dir,target,projects,history,host,api,grant,db,a,learning,config,row,saved,id,beforeIds:ids,requests,calls:()=>calls,
  reply,resolve:value=>resolve(value),select:(indices,statuses)=>resolve(reply(indices,statuses)),
  toggle:()=>{enabled=!enabled;generation++},run:()=>maybeConsolidateOverview(learning,config,target,learning.controller.signal)};
}

test('real host revalidates branch, authorization, source revision and pilot generation after inference',async t=>{
 for(const action of ['rewind','revoke','reauthorize','project-history','revision','toggle','cancel','forget']) {
  await t.test(action,async t=>{
   const f=await fixture(t);const pending=f.run();assert.equal(f.calls(),1);
   if(action==='rewind')f.history.setActiveLeaf('a');
   if(action==='revoke')f.api.revoke(f.grant);
   if(action==='reauthorize')f.host.approve('plugin',f.host.prepare('plugin',{modelSessionId:'a',dailyCalls:4,includeHistory:true,excludedIds:[]}));
   if(action==='project-history')f.a.services.host.projectNameHistory=()=>{throw Error('project authorization');};
   if(action==='revision')f.row.revision++;
   if(action==='toggle'){f.toggle();f.toggle();}
   if(action==='cancel')f.learning.cancel();
   if(action==='forget')f.db.setState('ignored:a',[f.id]);
   f.select([0]);
   try {assert.equal(await pending,false)} catch(e){assert(['cancel','revoke','reauthorize'].includes(action));}
   assert.equal(f.saved.length,0);
  });
 }
});
test('source excerpts remain exact and a failed daily attempt is not retried',async t=>{
 const f=await fixture(t);const pending=f.run();f.select([0]);assert(await pending);
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
 t.mock.timers.setTime(Date.parse('2026-11-25T00:00:01.000Z'));f.select([0]);assert.equal(await pending,false);assert.equal(f.saved.length,0);
 const next=f.run();assert.equal(f.calls(),2);f.select([0]);assert.equal(await next,true);
});
test('dedicated conversation can bind an unambiguous project suffix to its stable ID',async t=>{
 const f=await fixture(t,'北辰项目决定采用方案甲');
 f.projects.splice(0,f.projects.length,{id:'north',name:'北辰',nameObserved:'北辰',nameSince:0},{id:'short',name:'辰',nameObserved:'辰',nameSince:0});
 f.target.projectId=null;f.row.scope='conversation:a';f.row.source.context={subject:'other',conversationId:'a'};
 const pending=f.run();assert.equal(f.calls(),1);f.select([0]);assert(await pending);
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
 const pending=f.run();assert.equal(f.calls(),1);f.select([0]);assert(await pending);
 const statement=f.saved[0].statements[0];assert.equal(statement.evidence.length,2);assert(themeEvidenceValid(f.a,statement));
 f.history.setActiveLeaf(f.id);assert(!themeEvidenceValid(f.a,statement));
});
test('two project decisions produce a locally ordered, independently cited timeline',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T08:00:00Z')});
 const first='项目乙决定采用事件表记录登录日志';
 const f=await fixture(t,first);t.mock.timers.setTime(Date.parse('2026-11-24T09:00:00Z'));
 const text='项目乙决定采用对象存储归档故障截图';const [id]=await f.history.appendMessages([{role:'user',content:text}]);
 const row={...f.row,id:'memory2',content:text,source:{...f.row.source,refs:[{conversationId:'a',id,quote:text,at:Date.now()}]}};
 f.db.activeMemories=()=>[f.row,row];f.db.get=key=>key===f.row.id?f.row:key===row.id?row:null;
 const projectNameHistory=t.mock.method(f.a.services.host,'projectNameHistory');
 const pending=f.run();assert.equal(projectNameHistory.mock.callCount(),1);
 f.select([1,0]);assert(await pending);
 assert.equal(projectNameHistory.mock.callCount(),2);
 const statements=f.saved[0].statements;assert.deepEqual(statements.map(s=>s.text),[first,text]);
 assert.deepEqual(statements.map(s=>s.evidence.filter(ref=>ref.role==='support').map(ref=>ref.sourceId)),[[f.id],[id]]);
 assert(statements.every(s=>themeEvidenceValid(f.a,s)));
});
test('real theme store round trip and repeated basis skip inference',async t=>{
 const f=await fixture(t);const db=new MemoryStore(path.join(f.dir,'memory'));t.after(()=>db.close());
 db.setState('learning',f.config);db.setThemeOverviewEnabled(true);
 db.add({title:'决策',content:f.row.content,scope:'project:b',kind:'fact'},f.row.source,'active');
 f.a.store=db;f.learning.db=db;
 const pending=f.run();assert.equal(f.calls(),1);f.select([0]);assert(await pending);
 const [stored]=db.listThemeStatements();assert.equal(stored.kind,'project');assert(themeEvidenceValid(f.a,stored));
 db.setState('theme-overview:day',null);assert.equal(await f.run(),false);assert.equal(f.calls(),1);
});
function projectStore(t,f) {
 const db=new MemoryStore(path.join(f.dir,'memory'));
 t.after(()=>db.close());
 db.setState('learning',f.config);
 db.setThemeOverviewEnabled(true);
 f.a.store=db;f.learning.db=db;f.a.dedicated=true;f.target.instanceId=f.target.id;
 return db;
}

function addProjectMemory(db,row) {
 return db.add({title:row.title,content:row.content,scope:row.scope,kind:row.kind},row.source,'active');
}

function seedLegacyProjectRow(f,db,row) {
 const text=f.history.getEntry(f.id).message.content;
 db.saveThemeStatements({themeKey:'project:b',kind:'project',projectId:'b',title:'决策',
  basisKey:'previous-version',generation:db.themeOverviewGeneration(),statements:[{
   text,validFrom:f.history.getEntry(f.id).timestamp,evidence:[{
    memoryId:row.id,revision:row.revision,conversationId:f.target.id,sourceId:f.id,start:0,end:text.length,role:'support',
   }],
  }]});
}

test('legacy project rows still require conservative review at recall',async t=>{
 for(const [text,visible] of [
  ['项目乙决定采用本地缓存的说法不属实。',false],
  ['项目乙决定采用本地缓存，前提是安全评审通过。',false],
  ['项目乙决定采用本地缓存。',true],
  ['项目乙决定采用本地缓存。如果安全评审通过，运维团队再部署缓存服务。',true],
 ])await t.test(text,async t=>{
  const f=await fixture(t,text);
  const db=projectStore(t,f),row=addProjectMemory(db,f.row);
  seedLegacyProjectRow(f,db,row);
  const recalled=themeRecall(f.a,f.target,'本项目的决策脉络')?.statements.map(statement=>statement.text)??[];
  assert.deepEqual(recalled,visible?[text]:[]);
  assert.equal(db.get(row.id)?.state,'active');
  assert.equal(f.api.entry(f.grant,f.target.id,f.id,0).text,text);
  assert.equal(f.calls(),0);
 });
});
test('a legacy project decision is withheld when authorized later evidence can invalidate it',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T18:00:00Z')});
 const initial='项目乙决定采用本地缓存。';
 const f=await fixture(t,initial),db=projectStore(t,f),row=addProjectMemory(db,f.row);
 seedLegacyProjectRow(f,db,row);
 const recall=()=>themeRecall(f.a,f.target,'本项目的决策脉络')?.statements.map(statement=>statement.text)??[];
 assert.deepEqual(recall(),[initial]);

 t.mock.timers.setTime(Date.parse('2026-12-04T19:00:00Z'));
 await f.history.appendMessages([{role:'user',content:'项目甲决定撤回本地缓存方案，停止实施。'}]);
 assert.deepEqual(recall(),[initial]);

 await f.history.appendMessages([{role:'user',content:'项目乙决定撤回本地缓存方案，停止实施。'}]);
 assert.deepEqual(recall(),[]);
 assert.equal(f.calls(),0);
 assert.equal(db.get(row.id)?.state,'active');
});

test('one existing background call classifies all decision candidates and recalls only settled evidence',async t=>{
 const cases=[
  ['项目乙：本地缓存是最终方案。','settled'],
  ['项目乙决定采用冗余缓存，前提是安全评审通过。','conditional'],
  ['项目乙决定采用外部缓存的说法不属实。','denied'],
  ['项目乙：还得比较多个备选。','insufficient'],
 ];
 const f=await fixture(t,cases[0][0]);
 const db=projectStore(t,f);
 addProjectMemory(db,f.row);
 for(const [text] of cases.slice(1)){
  const [id]=await f.history.appendMessages([{role:'user',content:text}]);
  addProjectMemory(db,{...f.row,content:text,source:{...f.row.source,refs:[{conversationId:f.target.id,id,quote:text,at:f.history.getEntry(id).timestamp}]}});
 }
 const pending=f.run();
 assert.equal(f.calls(),1);
 const excerpts=f.requests[0].excerpts;
 assert.deepEqual(new Set(excerpts.map(({text})=>text)),new Set(cases.map(([text])=>text)));
 const statuses=excerpts.map(({text})=>cases.find(([candidate])=>candidate===text)[1]);
 f.select([statuses.indexOf('settled')],statuses);
 assert.equal(await pending,true);
 const [settled]=db.listThemeStatements();
 assert.deepEqual(db.listThemeStatements().map(row=>row.text),[cases[0][0]]);
 assert.equal(settled.decisionReview.version,2);
 assert.equal(settled.evidence[0].sourceId,f.id);
 assert.deepEqual(themeRecall(f.a,f.target,'本项目的决策脉络').statements.map(row=>row.text),[cases[0][0]]);
 assert.equal(f.api.status(f.grant).calls,1);
 assert.equal(f.calls(),1);
 assert.equal(db.activeMemories().length,4);
});

test('settled decisions anchor a unique commitment clause while storing the complete original',async t=>{
 const text='项目乙：已确定采用本地缓存。安全评审通过后再部署。';
 const commitment='已确定采用本地缓存。';
 const f=await fixture(t,text),db=projectStore(t,f);
 addProjectMemory(db,f.row);
 const pending=f.run();
 assert.equal(f.calls(),1);
 f.resolve(JSON.stringify({decisions:[{index:0,status:'settled',quote:commitment}],indices:[0]}));
 assert.equal(await pending,true);
 const [statement]=db.listThemeStatements();
 const {start,end}=statement.decisionReview.commitment;
 assert.equal(text.slice(start,end),commitment);
 assert.equal(statement.text,text);
 assert.equal(themeRecall(f.a,f.target,'本项目的决策脉络').statements[0].text,text);
 assert.equal(f.calls(),1);
});

test('a full-excerpt model review waits for commitment reassessment',async t=>{
 const f=await fixture(t),db=projectStore(t,f),memory=addProjectMemory(db,f.row);
 seedLegacyProjectRow(f,db,memory);
 const [old]=db.listThemeStatements();
 db.saveThemeStatements({...old,generation:db.themeOverviewGeneration(),reviewed:true,
  statements:[{...old,decisionReview:{version:1,context:[]}}]});
 assert.equal(themeRecall(f.a,f.target,'本项目的决策脉络'),null);
 assert.equal(db.get(memory.id)?.state,'active');
 assert.equal(f.calls(),0);
 const pending=f.run();
 f.select();
 assert.equal(await pending,true);
 assert.equal(db.listThemeStatements()[0].decisionReview.version,2);
 assert(themeRecall(f.a,f.target,'本项目的决策脉络'));
});

test('proof copied only from context or an ambiguous repeated span is rejected',async t=>{
 for(const [text,quote] of [
  ['项目乙：我们还在比较缓存方案。','已经批准了旧的离线方案。'],
  ['项目乙：继续测试。继续测试。','继续测试。'],
 ])await t.test(text,async t=>{
  const f=await fixture(t,text,[{role:'user',content:'已经批准了旧的离线方案。'}]);
  const db=projectStore(t,f);
  addProjectMemory(db,f.row);
  const pending=f.run();
  assert.equal(f.calls(),1);
  assert(f.requests[0].excerpts[0].context.some(item=>item.text==='已经批准了旧的离线方案。'));
  f.resolve(JSON.stringify({decisions:[{index:0,status:'settled',quote}],indices:[0]}));
  assert.equal(await pending,false);
  assert.deepEqual(db.listThemeStatements(),[]);
 });
});

test('invalid model decisions cannot replace existing verified overviews',async t=>{
 for(const [label,alter] of [
  ['malformed JSON',()=>'{'],
  ['old model response',({indices})=>({indices})],
  ['missing assessment',response=>({...response,decisions:[]})],
  ['model-authored statement',response=>({...response,text:'编造内容'})],
  ['nonexistent candidate',response=>({...response,indices:[99]})],
  ['unsettled selection',response=>({...response,decisions:[{index:0,status:'conditional'}]})],
  ['duplicate candidate assessment',response=>({...response,decisions:[...response.decisions,...response.decisions]})],
  ['unknown decision status',response=>({...response,decisions:[{index:0,status:'assumed'}]})],
  ['invented quote',response=>({...response,decisions:[{...response.decisions[0],quote:'并不存在的原文'}]})],
 ])await t.test(label,async t=>{
  const f=await fixture(t),db=projectStore(t,f);
  const row=addProjectMemory(db,f.row);
  seedLegacyProjectRow(f,db,row);
  const before=db.listThemeStatements();
  const pending=f.run();assert.equal(f.calls(),1);
  const response=alter(JSON.parse(f.reply()));
  f.resolve(typeof response==='string'?response:JSON.stringify(response));
  assert.equal(await pending,false);
  assert.deepEqual(db.listThemeStatements(),before);
 });
});

test('valid denials supersede old overviews without reprocessing the same empty result',async t=>{
 const f=await fixture(t),db=projectStore(t,f);
 const row=addProjectMemory(db,f.row);
 seedLegacyProjectRow(f,db,row);
 assert(themeRecall(f.a,f.target,'本项目的决策脉络'));
 const text='刚才那项选择已经撤回，目前没有替代方案。';
 await f.history.appendMessages([{role:'user',content:text}]);
 const pending=f.run();
 assert.equal(f.calls(),1);
 assert(f.requests[0].excerpts[0].context.some(item=>item.position==='after'&&item.text===text));
 f.select([],['denied']);
 assert.equal(await pending,true);
 assert.deepEqual(db.listThemeStatements(),[]);
 assert.equal(themeRecall(f.a,f.target,'本项目的决策脉络'),null);
 assert.equal(db.get(row.id)?.state,'active');
 db.setState('theme-overview:day',null);
 assert.equal(await f.run(),false);
 assert.equal(f.calls(),1);
});
test('adjacent user context is filtered, stays private and remains a dependency',async t=>{
 const privateText='password: HIDDEN-FIXTURE-CONTEXT';
 const generatedText='[插件任务] 生成的上下文引用';
 const forgottenText='曾经使用红色专用设备。';
 const contextText='我们讨论的是缓存策略的调整。';
 const followup='这次记录只涉及本地缓存方案的选择。';
 const f=await fixture(t,undefined,[generatedText,privateText,forgottenText,contextText].map(content=>({role:'user',content})));
 const db=projectStore(t,f),primary=addProjectMemory(db,f.row);
 const personalMemory=(text,id)=>db.add({title:'用户陈述',content:text,scope:'personal',kind:'fact'},{
  ...f.row.source,context:{subject:'user',conversationId:f.target.id},
  refs:[{conversationId:f.target.id,id,quote:text,at:f.history.getEntry(id).timestamp}],
 },'active');
 const forgotten=personalMemory(forgottenText,f.beforeIds[2]);
 db.forget(forgotten.id,forgotten.revision);
 const contextId=f.beforeIds[3];
 const contextMemory=personalMemory(contextText,contextId);
 const [laterId]=await f.history.appendMessages([{role:'user',content:followup}]);
 const pending=f.run();
 assert.equal(f.calls(),1);
 const request=f.requests[0].excerpts[0];
 assert.deepEqual(request.context,[{position:'before',text:contextText},{position:'after',text:followup}]);
 assert(!JSON.stringify(f.requests[0]).includes(privateText));
 assert(!JSON.stringify(f.requests[0]).includes(forgottenText));
 assert(!JSON.stringify(f.requests[0]).includes(generatedText));
 f.select();
 assert.equal(await pending,true);
 const [stored]=db.listThemeStatements();
 assert.equal(stored.evidence[0].sourceId,f.id);
 assert.deepEqual(stored.evidence.slice(1).map(e=>[e.role,e.sourceId]),[['context',contextId],['context',laterId]]);
 assert.equal(stored.decisionReview.version,2);
 assert(!JSON.stringify(stored).includes(contextText), 'the database retains context references, never copied context');
 assert(!JSON.stringify(stored).includes(followup));

 const overview=themeRecall(f.a,f.target,'本项目的决策脉络');
 assert(overview);
 assert.deepEqual(overview.statements.map(s=>s.text),[f.row.content]);
 assert(overview.statements[0].evidence.every(e=>e.role==='support'));
 assert.equal(f.calls(),1);

 db.forget(contextMemory.id,contextMemory.revision);
 assert.equal(db.get(primary.id)?.state,'active');
 assert.deepEqual(db.listThemeStatements(),[]);
 assert.equal(themeRecall(f.a,f.target,'本项目的决策脉络'),null);
 assert.equal(f.calls(),1);
});

test('new neighboring context invalidates pending and saved assessments',async t=>{
 for(const timing of ['during inference','after saving'])await t.test(timing,async t=>{
  const f=await fixture(t),db=projectStore(t,f);
  addProjectMemory(db,f.row);
  const pending=f.run();assert.equal(f.calls(),1);
  const appendCorrection=()=>f.history.appendMessages([{role:'user',content:'更正，刚才的方案并没有获得通过。'}]);
  if(timing==='during inference')await appendCorrection();
  f.select();
  assert.equal(await pending,timing==='after saving');
  if(timing==='after saving'){
   assert(themeRecall(f.a,f.target,'本项目的决策脉络'));
   await appendCorrection();
  } else assert.deepEqual(db.listThemeStatements(),[]);
  assert.equal(themeRecall(f.a,f.target,'本项目的决策脉络'),null);
  assert.equal(f.api.entry(f.grant,f.target.id,f.id).text,f.row.content);
  assert.equal(f.calls(),1);
 });
});

test('a late correction invalidates only the linked project decision before its next model review',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T22:05:00Z')});
 const initial='项目「海岬」：工单 HC-26 已签字。故障明细固定保留三十天，即刻生效。';
 const other='项目「北屿」：工单 BY-26 已签字。故障明细固定保留三十天，即刻生效。';
 const f=await fixture(t,initial),db=projectStore(t,f),original=addProjectMemory(db,f.row);
 f.projects.splice(0,f.projects.length,
  {id:'b',name:'海岬',nameSince:0}, {id:'a-project',name:'北屿',nameSince:0});
 f.target.projectId=null;
 const recall=name=>themeRecall(f.a,f.target,`项目「${name}」的决策脉络`)?.statements.map(s=>s.text)??[];
 t.mock.timers.setTime(Date.parse('2026-11-24T23:00:00Z'));
 const [otherId]=await f.history.appendMessages([{role:'user',content:other}]);
 addProjectMemory(db,{...f.row,content:other,scope:'project:a-project',source:{...f.row.source,
  context:{...f.row.source.context,projectId:'a-project'},refs:[{conversationId:f.target.id,id:otherId,quote:other,at:f.history.getEntry(otherId).timestamp}]}});
 for(const date of ['2026-11-24T23:20:00Z','2026-11-25T00:01:00Z']) {
  const before=f.calls();
  t.mock.timers.setTime(Date.parse(date));
  const pending=f.run();assert.equal(f.calls(),before+1);
  f.select();assert.equal(await pending,true);
 }
 assert.deepEqual(recall('海岬'),[initial]);
 assert.deepEqual(recall('北屿'),[other]);

 const generated='[插件任务] HC-26 的草案已删除。';
 const sensitive='HC-26 的操作记录包含 password: FIXTURE-LATE-SECRET';
 const intervening=[
  '项目「北屿」：发布窗口改到下周，运维正在协调。','培训的人还没到齐，下午再安排会议。',
  '项目「海岬」：设计评审结束，样式问题另外跟进。','验收同事准备了三份测试数据。',
  '项目「北屿」：新的静态资源需要替换图标。','支持同事说明天重新登记值班表。',
  generated,'项目「海岬」：接口文档先给使用方核对。',
  '这次会议纪要要把不同议题分开。','项目「北屿」：演示环境正等待服务器配额。',
  sensitive,'排班和预算还在单独确认。',
  // The late evidence is outside the first authorized history page.
  ...Array.from({length:33},(_,index)=>`维护记录 ${index+1} 已登记，仍需协调会议时间。`),
 ];
 const start=Date.parse('2026-11-25T00:15:00Z');
 for(const [index,content] of intervening.entries()) {
  t.mock.timers.setTime(start+index*5*60*1000);
  await f.history.appendMessages([{role:'user',content}]);
 }
 assert.deepEqual(recall('海岬'),[initial]);
 assert.deepEqual(recall('北屿'),[other]);

 t.mock.timers.setTime(Date.parse('2026-11-25T04:00:00Z'));
 const correction='项目「海岬」：HC-26 的留存决议撤回，三十天未获批准。';
 await f.history.appendMessages([{role:'user',content:correction}]);
 assert.deepEqual(recall('海岬'),[],'the stale assessment must be withheld as soon as its linked evidence changes');
 assert.deepEqual(recall('北屿'),[other]);
 assert.equal(f.calls(),2,'recall must not call the model');

 t.mock.timers.setTime(Date.parse('2026-11-26T00:01:00Z'));
 const reassessment=f.run();assert.equal(f.calls(),3);
 const [candidate]=f.requests.at(-1).excerpts;
 assert.equal(candidate.text,initial);
 assert(candidate.context.some(item=>item.position==='after'&&item.text===correction));
 assert(!candidate.context.some(item=>[other,generated,sensitive].includes(item.text)));
 f.select([],['denied']);assert.equal(await reassessment,true);
 assert.deepEqual(recall('海岬'),[]);
 assert.deepEqual(recall('北屿'),[other]);
 assert.equal(db.get(original.id)?.state,'active');
 assert.equal(f.api.entry(f.grant,f.target.id,f.id).text,initial);
});
test('indexed evidence catches withdrawals beyond the original decision window without mixing projects',async t=>{
 const workItem='项目「海岬」：工单 HC-26 已签字。故障明细在 v2.4.6 固定保留三十天，即刻生效。';
 const workItemCorrection='项目「海岬」：HC-26 的三十天留存决议撤回，按原发布口径执行。';
 for(const {label,initial,correction,correctionAt,fillerCount=130,testCrowding} of [
  {
   label:'same project and topic more than three authorized pages later',
   initial:'项目「海岬」：故障明细在 v2.4.6 固定保留三十天，已批准生效。',
   correction:'项目「海岬」：撤回故障明细的三十天留存要求，沿用原发布口径。',
   correctionAt:'2026-11-25T17:00:00Z',
  },
  {
   label:'same work item more than seven days and three authorized pages later',
   initial:workItem,correction:workItemCorrection,
   correctionAt:'2026-12-04T17:00:00Z',
   testCrowding:true,
  },
  {
   label:'same work item more than seven days later within the first page',
   initial:workItem,correction:workItemCorrection,
   correctionAt:'2026-12-04T17:00:00Z',
   fillerCount:12,
  },
 ])await t.test(label,async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T18:00:00Z')});
  const other='项目「北屿」：工单 BY-26 已签字。故障明细固定保留三十天，即刻生效。';
  const f=await fixture(t,initial),db=projectStore(t,f),original=addProjectMemory(db,f.row);
  f.projects.splice(0,f.projects.length,{id:'b',name:'海岬',nameSince:0},{id:'a-project',name:'北屿',nameSince:0});
  f.target.projectId=null;
  const recall=name=>themeRecall(f.a,f.target,`项目「${name}」的决策脉络`)?.statements.map(s=>s.text)??[];
  t.mock.timers.setTime(Date.parse('2026-11-24T19:00:00Z'));
  const [otherId]=await f.history.appendMessages([{role:'user',content:other}]);
  addProjectMemory(db,{...f.row,content:other,scope:'project:a-project',source:{...f.row.source,
   context:{...f.row.source.context,projectId:'a-project'},
   refs:[{conversationId:f.target.id,id:otherId,quote:other,at:f.history.getEntry(otherId).timestamp}]}});
  for(const date of ['2026-11-24T19:30:00Z','2026-11-25T00:01:00Z']) {
   const before=f.calls();
   t.mock.timers.setTime(Date.parse(date));
   const pending=f.run();assert.equal(f.calls(),before+1);
   f.select();assert.equal(await pending,true);
  }
  assert.deepEqual(recall('海岬'),[initial]);
  assert.deepEqual(recall('北屿'),[other]);

  t.mock.timers.setTime(Date.parse('2026-11-25T10:00:00Z'));
  await f.history.appendMessages(Array.from({length:fillerCount},(_,i)=>({
   role:'user',content:`项目「${i%2?'海岬':'北屿'}」：维护班次 ${i+1} 已登记，下次会议核对培训材料和联系人。`,
  })));
  t.mock.timers.setTime(Date.parse(correctionAt)-60000);
  const otherVersion='项目「北屿」：撤下 v2.4.6 的演示主题，只修改页面配色和图标。';
  const forgotten='项目「海岬」：故障明细取消保留三十天，撤回记录。';
  const [,forgottenId]=await f.history.appendMessages([
   {role:'user',content:otherVersion},{role:'user',content:forgotten},
  ]);
  db.setState(`ignored:${f.target.id}`,[forgottenId]);
  assert.deepEqual(recall('海岬'),[initial],'unrelated and forgotten messages must not invalidate this project');
  assert.deepEqual(recall('北屿'),[other]);

  t.mock.timers.setTime(Date.parse(correctionAt));
  const [correctionId]=await f.history.appendMessages([{role:'user',content:correction}]);
  let cursor=f.id,correctionPage=null;
  for(let index=0;index<3;index++) {
   const page=f.api.read(f.grant,f.target.id,cursor);
   if(page.entries.some(entry=>entry.id===correctionId))correctionPage=index+1;
   if(!page.more)break;
   cursor=page.cursor;
  }
  assert.equal(correctionPage,fillerCount>120?null:1);
  assert.deepEqual(recall('海岬'),[],'the now-stale decision must disappear without waiting for the model');
  assert.deepEqual(recall('北屿'),[other]);
  assert.equal(f.calls(),2,'recall must not call the model');

  t.mock.timers.setTime(Date.parse(correctionAt)+24*60*60*1000);
  const pending=f.run();assert.equal(f.calls(),3);
  const [candidate]=f.requests.at(-1).excerpts;
  assert.equal(candidate.text,initial);
  assert(candidate.context.some(item=>item.position==='after' && item.text===correction));
  assert(!candidate.context.some(item=>[otherVersion,other,forgotten].includes(item.text)));
  f.select([],['denied']);assert.equal(await pending,true);
  assert.deepEqual(recall('海岬'),[]);
  assert.deepEqual(recall('北屿'),[other]);
  assert.equal(db.get(original.id)?.state,'active');

  if(testCrowding) {
   const day=24*60*60*1000, correctionTime=Date.parse(correctionAt);
   t.mock.timers.setTime(correctionTime+day+60000);
   await f.history.appendMessages(Array.from({length:30},(_,i)=>({
    role:'user',content:`项目「海岬」：HC-26 的附件链接 ${i+1} 已归档，只做目录登记。`,
   })));
   assert.deepEqual(recall('海岬'),[]);
   assert.deepEqual(recall('北屿'),[other]);
   assert.equal(f.calls(),3,'even after later mentions, recall never calls the model');

   t.mock.timers.setTime(correctionTime+2*day);
   const next=f.run();
   if(f.calls()===4) {
    const context=f.requests.at(-1).excerpts.find(item=>item.text===initial)?.context;
    f.select([],['denied']);await next;
    assert(context?.some(item=>item.text===correction),'a renewed review must not lose the withdrawal behind later mentions');
   } else assert.equal(await next,false);
   assert.deepEqual(recall('海岬'),[]);
   assert.deepEqual(recall('北屿'),[other]);
  }
 });
});
test('a long indexed update cannot make its prior project decision look current',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T18:00:00Z')});
 const initial='项目乙决定采用本地缓存。';
 const f=await fixture(t,initial),db=projectStore(t,f);
 addProjectMemory(db,f.row);
 const first=f.run();assert.equal(f.calls(),1);f.select();assert.equal(await first,true);
 const recall=()=>themeRecall(f.a,f.target,'本项目的决策脉络')?.statements.map(statement=>statement.text)??[];
 assert.deepEqual(recall(),[initial]);

 t.mock.timers.setTime(Date.parse('2026-12-04T19:00:00Z'));
 const minutes='依次记录会议的设备清单和班次安排。'.repeat(200);
 const update=project=>`项目${project}的会议纪要。${minutes}之前采用本地缓存的安排已撤回。`;
 await f.history.appendMessages([{role:'user',content:update('甲')}]);
 assert.deepEqual(recall(),[initial]);
 const [id]=await f.history.appendMessages([{role:'user',content:update('乙')}]);
 assert(f.api.entry(f.grant,f.target.id,id).more);
 assert.deepEqual(recall(),[]);
 assert.equal(f.calls(),1);
});
test('an indexed project reference carries its immediately following authorized answer',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T18:00:00Z')});
 const initial='项目乙决定采用本地缓存，关联工单 HC-26。';
 const f=await fixture(t,initial),db=projectStore(t,f);
 addProjectMemory(db,f.row);
 const first=f.run();assert.equal(f.calls(),1);f.select();assert.equal(await first,true);
 const recall=()=>themeRecall(f.a,f.target,'本项目的决策脉络')?.statements.map(statement=>statement.text)??[];

 t.mock.timers.setTime(Date.parse('2026-12-04T19:00:00Z'));
 const reference='项目乙：请看工单 HC-26，确认一下原定版本的执行安排。';
 const [referenceId]=await f.history.appendMessages([{role:'user',content:reference}]);
 const second=f.run();assert.equal(f.calls(),2);f.select();assert.equal(await second,true);
 assert.deepEqual(recall(),[initial]);

 await f.history.appendMessages([{role:'user',content:'项目甲：先取消，别下单。'}]);
 assert.deepEqual(recall(),[initial]);
 f.history.setActiveLeaf(referenceId);
 const correction='先取消，别下单。';
 await f.history.appendMessages([
  {role:'assistant',content:'按原安排继续办理吗？'},{role:'user',content:correction},
 ]);
 assert.deepEqual(recall(),[]);
 assert.equal(f.calls(),2);

 t.mock.timers.setTime(Date.parse('2026-12-05T00:01:00Z'));
 const next=f.run();assert.equal(f.calls(),3);
 const [candidate]=f.requests.at(-1).excerpts;
 assert.equal(candidate.text,initial);
 assert.deepEqual(candidate.context.map(({text,position})=>[text,position]),[[reference,'after'],[correction,'after']]);
 f.select([],['denied']);assert.equal(await next,true);
 assert.deepEqual(recall(),[]);
});
test('a concurrent ordinary tick aborts the in-flight theme without cancelling ordinary learning',async t=>{
 const f=await fixture(t);f.learning.historyBatch=()=>({records:[],context:[],backlog:false,state:{}});
 f.learning.commitScan=()=>{};f.learning.deferred=()=>[];f.learning.flushDeferred=()=>0;f.learning.recoverResult=()=>false;
 f.learning.reconcileLegacy=async()=>false;f.learning.setHealth=()=>{};
 const normal=f.learning.controller.signal,pending=f.learning.tick();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls(),1);assert.equal(f.learning.themeActive,true);
 await f.learning.tick();assert.equal(normal.aborted,false);f.select([0]);await pending;
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
 const pending=f.run();f.select([0,1]);assert(await pending);
 assert.deepEqual(f.saved[0].statements.map(s=>s.text),['项目乙决定采用方案甲','项目乙决定改为方案乙']);
});
test('long selected project excerpts are bounded without cutting a source',async t=>{
 const f=await fixture(t,'项目乙决定采用方案一'+ '甲'.repeat(250));const rows=[f.row];
 for(let i=2;i<=4;i++){
  const text=`项目乙决定采用方案${i}`+'乙'.repeat(250),[id]=await f.history.appendMessages([{role:'user',content:text}]);
  rows.push({...f.row,id:'memory'+i,content:text,source:{...f.row.source,refs:[{conversationId:'a',id,quote:text,at:Date.now()}]}});
 }
 f.db.activeMemories=()=>rows;f.db.get=key=>rows.find(r=>r.id===key);
 const pending=f.run();f.select([0,1,2,3]);assert(await pending);
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
 const pending=f.run();f.select([0]);assert(await pending);
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
 const pending=f.run();assert.equal(f.calls(),1);f.select([0]);assert(await pending);
 assert.equal(f.saved[0].projectId,'a-project');assert(themeEvidenceValid(f.a,f.saved[0].statements[0]));
});
test('unverified or boundary-time project names cannot attribute old evidence',async t=>{
 for(const project of [{id:'b',name:'乙'}, {id:'b',name:'乙',boundary:true}]) {
  await t.test(JSON.stringify(project),async t=>{
   const f=await fixture(t);if(project.boundary)project.nameSince=f.row.source.refs[0].at;
   f.projects.splice(0,f.projects.length,project);assert.equal(await f.run(),false);assert.equal(f.calls(),0);
  });
 }
});

test('name-free coverage gaps prevent new attribution and hide older summaries built from the same time',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T08:00:00Z')});
 const f=await fixture(t,'项目乙决定采用方案甲'), at=f.row.source.refs[0].at;
 const read=f.a.services.host.projectNameHistory;
 let gaps=[{from:at-10,to:at}];
 f.a.services.host.projectNameHistory=(...args)=>({...read(...args),gaps});
 assert.equal(await f.run(),false);
 assert.equal(f.calls(),0);
 gaps=[{from:at-10,to:at-1}];
 const pending=f.run();assert.equal(f.calls(),1);f.select([0]);assert(await pending);
 const {statements:[statement],...overview}=f.saved[0];
 assert(themeEvidenceValid(f.a,statement,overview));
 gaps=[{from:at,to:at+10}];
 assert(!themeEvidenceValid(f.a,statement,overview));
});
test('rewinding one project step leaves the independent step visible through normal recall',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T08:00:00Z')});
 const f=await fixture(t,'项目乙决定采用事件表记录登录日志');
 t.mock.timers.setTime(Date.parse('2026-11-24T09:00:00Z'));
 const text='项目乙决定采用对象存储归档故障截图';const [id]=await f.history.appendMessages([{role:'user',content:text}]);
 const second={...f.row,id:'second',content:text,source:{...f.row.source,refs:[{conversationId:'a',id,quote:text,at:Date.now()}]}};
 const db=new MemoryStore(path.join(f.dir,'normal-recall'));t.after(()=>db.close());db.setState('learning',f.config);db.setThemeOverviewEnabled(true);
 db.add({title:'第一步',content:f.row.content,scope:'project:b',kind:'fact'},f.row.source,'active');
 db.add({title:'第二步',content:second.content,scope:'project:b',kind:'fact'},second.source,'active');
 f.a.store=db;f.learning.db=db;f.a.dedicated=true;f.learning.access=()=>true;
 const pending=f.run();f.select([0,1]);assert(await pending);
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
 const pending=f.run();assert.equal(f.requests[0].excerpts[0].text,raw);f.select([0]);assert(await pending);
 const [statement]=db.listThemeStatements();assert.equal(statement.text,raw.trim());
 assert.equal(statement.evidence[0].start,0);assert.equal(statement.evidence[0].end,raw.length);assert(themeEvidenceValid(f.a,statement));
});
test('public project snapshot omits history and restricted metadata enables normal recall',async t=>{
 const f=await fixture(t,'北辰项目决定采用方案甲');f.projects.splice(0,f.projects.length,{id:'north',name:'北辰',nameObserved:'北辰',nameSince:0});
 f.target.projectId=null;f.row.scope='conversation:a';f.row.source.context={subject:'other',conversationId:'a'};
 assert.deepEqual(f.a.snapshot().projects,[{id:'north',name:'北辰'}]);
 const db=new MemoryStore(path.join(f.dir,'restricted-names'));t.after(()=>db.close());db.setState('learning',f.config);db.setThemeOverviewEnabled(true);
 db.add({title:'决策',content:f.row.content,scope:'conversation:a',kind:'fact'},f.row.source,'active');f.a.store=db;f.learning.db=db;f.a.dedicated=true;f.learning.access=()=>true;
 const pending=f.run();assert.equal(f.calls(),1);f.select([0]);assert(await pending);
 const [stored]=db.listThemeStatements();assert.equal(stored.projectId,'north');assert(themeEvidenceValid(f.a,stored));
 assert.deepEqual(themeRecall(f.a,{instanceId:'a',projectId:null},'北辰项目的决策脉络').statements.map(s=>s.text),[f.row.content]);
 f.a.services.host.projectNameHistory=()=>{throw Error('revoked')};assert(!themeEvidenceValid(f.a,stored));
});
test('missing or denied project metadata never falls back to snapshot and does not block preferences',async t=>{
 for(const unavailable of [undefined,()=>{throw Error('unavailable')}])await t.test(String(unavailable),async t=>{
  const f=await fixture(t,'我确认以后协作报告一律先给结论。');f.a.services.host.projectNameHistory=unavailable;
  f.a.snapshot=()=>({projects:[{id:'b',name:'乙',nameSince:0,nameObserved:'乙'}]});
  f.row.kind='preference';f.row.scope='personal';f.row.source.context={subject:'user',conversationId:'a'};
  const pending=f.run();assert.equal(f.calls(),1);f.select([0]);assert(await pending);
  assert.equal(f.saved[0].kind,'preference');assert(themeEvidenceValid(f.a,f.saved[0].statements[0]));
 });
 const f=await fixture(t);f.a.services.host.projectNameHistory=undefined;
 f.a.snapshot=()=>({projects:[{id:'b',name:'乙',nameSince:0,nameObserved:'乙'}]});
 assert.equal(await f.run(),false);assert.equal(f.calls(),0);
});
test('long project history supplies earliest, latest and middle decisions within eight candidates',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-01T08:00:00Z')});
 const f=await fixture(t,'项目乙：决定采用初始原则：离线处理');const rows=[f.row],start=Date.now();
 for(let i=1;i<22;i++) {
  t.mock.timers.setTime(start+i*86400000);
  const text=`项目乙：决定采用第${i}阶段方案：执行复核`,[id]=await f.history.appendMessages([{role:'user',content:text}]);
  rows.push({...f.row,id:`memory${i}`,content:text,source:{...f.row.source,refs:[{conversationId:'a',id,quote:text,at:Date.now()}]}});
 }
 f.db.activeMemories=()=>[...rows].reverse();f.db.get=key=>rows.find(r=>r.id===key);
 const pending=f.run();assert.equal(f.calls(),1);
 const excerpts=f.requests[0].excerpts;assert.equal(excerpts.length,8);
 assert.equal(excerpts[0].text,rows[0].content);assert.equal(excerpts.at(-1).text,rows.at(-1).content);
 assert(excerpts.slice(1,-1).every(x=>x.text!==rows[0].content && x.text!==rows.at(-1).content));
 f.select([0,7]);assert(await pending);
 assert.deepEqual(f.saved[0].statements.map(s=>s.text),[rows[0].content,rows.at(-1).content]);
});
test('later daily reviews reach unsampled candidates and preserve valid previously selected decisions',async t=>{
 for(const {firstSettled,nextSettled} of [
  {firstSettled:false,nextSettled:true}, {firstSettled:true,nextSettled:false}, {firstSettled:true,nextSettled:true},
 ])await t.test(JSON.stringify({firstSettled,nextSettled}),async t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-01T08:00:00Z')});
  const firstDecision='项目乙：最终决定沿用方案甲。';
  const intermediateDecision='项目乙已经决定采用本地缓存。';
  const firstText=firstSettled?firstDecision:'项目乙：仍需讨论第一阶段的方案。';
  const unsampledText=nextSettled?intermediateDecision:'项目乙：缓存方案还没有结论。';
  const f=await fixture(t,firstText),db=projectStore(t,f),start=Date.now();
  addProjectMemory(db,f.row);
  for(let i=1;i<9;i++){
   t.mock.timers.setTime(start+i*86400000);
   const text=i===7?unsampledText:'项目乙：仍需讨论备选'+i+'。';
   const [id]=await f.history.appendMessages([{role:'user',content:text}]);
   addProjectMemory(db,{...f.row,content:text,source:{...f.row.source,refs:[{conversationId:f.target.id,id,quote:text,at:Date.now()}]}});
  }
  const first=f.run();
  assert.equal(f.calls(),1);
  const firstBatch=f.requests[0].excerpts;
  assert.equal(firstBatch.length,8);
  assert(!firstBatch.some(({text})=>text===unsampledText));
  const firstStatuses=firstBatch.map(({text})=>text===firstDecision?'settled':'insufficient');
  f.select(firstSettled?[firstStatuses.indexOf('settled')]:[],firstStatuses);
  assert.equal(await first,true);
  assert.deepEqual(db.listThemeStatements().map(s=>s.text),firstSettled?[firstDecision]:[]);
  assert.equal(await f.run(),false);
  assert.equal(f.calls(),1);

  t.mock.timers.setTime(start+9*86400000);
  const second=f.run();
  assert.equal(f.calls(),2);
  assert.deepEqual(f.requests[1].excerpts.map(({text})=>text),[unsampledText]);
  f.select(nextSettled?[0]:[],[nextSettled?'settled':'insufficient']);
  assert.equal(await second,true);
  assert.deepEqual(db.listThemeStatements().map(s=>s.text),[
   ...(firstSettled?[firstDecision]:[]),...(nextSettled?[intermediateDecision]:[]),
  ]);

  t.mock.timers.setTime(start+10*86400000);
  assert.equal(await f.run(),false);
  assert.equal(f.calls(),2);
 });
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
 const pending=f.run();assert.equal(f.calls(),1);f.select([0]);assert(await pending);
 assert.equal(f.saved[0].projectId,'b');
});


test('deleted longer project name does not become a short-name project decision',async t=>{
 const f=await fixture(t,'北辰项目决定采用方案甲');
 f.projects.splice(0,f.projects.length,{id:'short',name:'辰',nameObserved:'辰',nameSince:0});
 f.row.scope='conversation:a';f.row.source.context={subject:'other',conversationId:'a'};
 assert.equal(await f.run(),false);assert.equal(f.calls(),0);
 for(const text of ['辰项目决定采用方案甲','项目辰决定采用方案甲','关于辰项目决定采用方案甲','我们在辰项目决定采用方案甲']) {
  await t.test(text,async t=>{const g=await fixture(t,text);g.projects.splice(0,g.projects.length,{id:'short',name:'辰',nameObserved:'辰',nameSince:0});g.row.scope='conversation:a';g.row.source.context={subject:'other',conversationId:'a'};const pending=g.run();assert.equal(g.calls(),1);g.select([0]);assert.equal(await pending,true);assert.equal(g.saved[0].projectId,'short');});
 }
});


test('project reviews do not override the source memory scope',async t=>{
 const f=await fixture(t,'我在项目乙做过方案文档，后来改学了财会。');
 f.row.scope='personal';f.row.source.context.subject='user';
 assert.equal(await f.run(),false);assert.equal(f.calls(),0);
 const g=await fixture(t),pending=g.run();g.select();
 assert(await pending);assert(themeEvidenceValid(g.a,g.saved[0].statements[0]));
 g.row.scope='personal';g.row.source.context.subject='user';
 assert(!themeEvidenceValid(g.a,g.saved[0].statements[0]));
});


test('project-name prefix cannot claim a longer unregistered project',async t=>{
 const f=await fixture(t,'项目乙实验室已经决定采用方案甲');
 assert.equal(await f.run(),false);assert.equal(f.calls(),0);
 const g=await fixture(t,'项目乙已经决定采用方案甲');const pending=g.run();g.select([0]);assert(await pending);
});


test('quoted replay is not independent preference evidence',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T08:00:00Z')});
 const text='我喜欢汇报先说结论，再列理由。',f=await fixture(t,text);f.row.kind='preference';f.row.scope='personal';f.row.source.context={subject:'user',conversationId:'a'};
 t.mock.timers.setTime(Date.parse('2026-11-25T09:00:00Z'));const quote='「'+text+'」',[id]=await f.history.appendMessages([{role:'user',content:quote}]);
 f.row.source.refs.push({conversationId:'a',id,quote,at:Date.now()});assert.equal(await f.run(),false);assert.equal(f.calls(),0);
});


test('a name extended by a boundary-like word is not a shorter project',async t=>{
 for(const text of ['项目乙计划已经决定采用方案甲','项目乙方案组决定采用方案甲','乙项目组决定采用方案甲',
  '项目乙决定论研究组决定采用方案甲','项目乙和风项目决定采用方案甲','项目乙选择器决定采用方案甲',
  '项目乙决定论研究组使用方案甲','项目乙决定论研究组：使用方案甲','项目乙选择器，决定采用方案甲']) {
  await t.test(text,async t=>{
   const f=await fixture(t,text);assert.equal(await f.run(),false);assert.equal(f.calls(),0);
  });
 }
});

test('a clear project possessive or explicit divider can introduce a decision',async t=>{
 for(const text of ['项目乙的方案决定采用方案甲','项目乙：选择方案甲','项目乙，决定采用方案甲','项目「乙」决定采用方案甲','项目「乙」选用了方案甲','项目乙：选定的是方案甲。'])await t.test(text,async t=>{
  const f=await fixture(t,text);
  const pending=f.run();assert.equal(f.calls(),1);f.select([0]);assert(await pending);
  assert.equal(f.saved[0].projectId,'b');assert(themeEvidenceValid(f.a,f.saved[0].statements[0]));
 });
});

test('an explicit foreign or unresolved project mention cannot reach decision review',async t=>{
 for(const text of [
  '项目乙：等待评审。项目丙决定采用方案甲。',
  '项目乙决定采用方案甲。项目丙决定采用方案乙。',
  '项目乙：决定在项目丙采用方案甲。',
  '项目「乙」和「丙」决定采用方案甲。',
  '项目『乙』和『甲』共同决定采用开放格式',
 ])await t.test(text,async t=>{
  const f=await fixture(t,text),pending=f.run();
  const calls=f.calls();if(calls)f.select();
  assert.equal(await pending,false);
  assert.equal(calls,0);
 });
});

test('existing project rows still reject ambiguous predicates and hypothetical source text',async t=>{
 for(const text of [
  '项目乙决定采用方案甲。决定采用方案乙。',
  '项目乙决定采用方案甲而丙选用了方案乙。',
  '如果项目乙决定采用方案甲，请通知我。',
  '项目乙决定采用方案甲吗？',
  '项目乙决定采用方案甲的话，我会通知你。',
 ])await t.test(text,async t=>{
  const f=await fixture(t,text),db=projectStore(t,f);
  seedLegacyProjectRow(f,db,addProjectMemory(db,f.row));
  assert.equal(themeRecall(f.a,f.target,'本项目的决策脉络'),null);
  assert.equal(f.calls(),0);
 });
});

test('two clauses can both have an explicit decision belonging to the same project',async t=>{
 for(const text of ['项目乙决定采用方案甲。项目乙决定改为方案乙。','项目乙决定采用方案甲，但项目乙决定改为方案乙。'])await t.test(text,async t=>{
  const f=await fixture(t,text);
  const pending=f.run();assert.equal(f.calls(),1);f.select([0]);assert(await pending);
  assert.equal(f.saved[0].projectId,'b');assert(themeEvidenceValid(f.a,f.saved[0].statements[0]));
 });
});

test('decision nouns do not suppress a clearly attributed decision',async t=>{
 for(const text of ['项目乙决定采用选择器。','项目乙决定采用决定树模型','项目乙决定采用选择排序算法','项目乙决定采用方案甲。后来我在阅读决定论研究资料。',
  '项目乙决定采用方案甲。性能是决定因素。','项目乙决定采用项目管理插件。','项目乙决定采用设计师说的话作为验收依据。',
  '项目乙决定采用设计师说过的话作为验收依据。','项目乙决定采用设计师写下来的话作为验收依据。',
  '项目乙决定采用设计师写下来的话作为产品口号。','项目乙决定采用设计师说的话用作产品口号。',
  '项目乙决定采用设计师说过的话作为发布条款。','项目乙决定采用设计师所说的话。',
  '项目乙决定采用方案甲并由技术员实施。','项目乙决定采用没有广告的版本。','项目乙决定采用一个没有广告的版本。',
  '项目乙决定采用预先选定的方案。','项目乙决定采用委员会决定采用过的方案。'])await t.test(text,async t=>{
  const f=await fixture(t,text);
  const pending=f.run();assert.equal(f.calls(),1);f.select([0]);assert(await pending);
  assert.equal(f.saved[0].projectId,'b');assert(themeEvidenceValid(f.a,f.saved[0].statements[0]));
 });
});

test('an ambiguous joined name cannot fall back to a registered suffix',async t=>{
 const f=await fixture(t,'项目乙和风项目决定采用方案甲');
 f.projects.push({id:'wind',name:'风',nameSince:0});
 const pending=f.run();
 // Release the mock inference if an incorrect attribution starts it.
 if(f.calls())f.select([0]);
 assert.equal(await pending,false);
 assert.equal(f.calls(),0);

 const g=await fixture(t,'项目乙和风项目决定采用方案甲');
 g.projects.push({id:'wind',name:'风',nameSince:0},{id:'full',name:'乙和风',nameSince:0});
 const resolved=g.run();assert.equal(g.calls(),1);g.select([0]);assert(await resolved);
 assert.equal(g.saved[0].projectId,'full');
});

test('model policy changes discard late theme results and retain the shared UTC-day attempt',async t=>{
 for(const notification of [true,false])await t.test(notification?'notified':'status revision only',async t=>{
  const f=await fixture(t);let revision=0;
  const status=f.api.status.bind(f.api);
  f.learning.api={...f.api,status:g=>({...status(g),modelRevision:revision})};
  const pending=f.run();assert.equal(f.calls(),1);const spent=f.api.status(f.grant).calls;
  revision=1;if(notification)assert(f.learning.modelPolicyChanged(f.grant));
  f.select([0]);try{assert.equal(await pending,false);}catch(e){assert(notification&&e.name==='AbortError');}
  assert.equal(f.saved.length,0);assert.equal(f.api.status(f.grant).calls,spent);
  assert.equal(await f.run(),false,'switching model must not reset the daily theme limit');assert.equal(f.calls(),1);
 });
});

test('theme selection shares the real host four-call daily allowance with ordinary inference',async t=>{
 const f=await fixture(t),request=[{role:'system',content:'synthetic request'},{role:'user',content:'{}'}];
 for(let i=0;i<3;i++){const pending=f.api.infer(f.grant,request);f.resolve('{}');await pending;}
 assert.equal(f.api.status(f.grant).calls,3);
 const pending=f.run();assert.equal(f.calls(),4);f.select([0]);assert(await pending);
 assert.equal(f.api.status(f.grant).calls,4);await assert.rejects(f.api.infer(f.grant,request),/额度/);
});

test('a followed model target change rejects a late theme result even without a revision increment',async t=>{
 const f=await fixture(t);const status=f.api.status.bind(f.api);let model='first';
 f.learning.api={...f.api,status:g=>({...status(g),modelRevision:0,modelTarget:{conversationId:'a',cwd:f.target.cwd,provider:'test',model}})};
 const pending=f.run();model='second';f.select([0]);assert.equal(await pending,false);
 assert.equal(f.saved.length,0);assert.equal(f.calls(),1);assert.equal(await f.run(),false);
});
