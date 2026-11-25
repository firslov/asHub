import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PluginBackground} from '../dist/extensions/background.js';
import {SessionStore} from '../dist/history/session-store.js';
import {Assistant} from '../examples/extensions/personal-assistant/shared.mjs';
import {recall,withMemory,recallBudget,selectRecall} from '../examples/extensions/personal-assistant/context.mjs';

async function fixture(t,projectName='北辰') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-theme-test-')), life=new AbortController(), id='theme123';
  const session={id,instanceId:id,cwd:dir,kind:'agent',title:'助手',provider:'test',model:'test',busy:true,projectId:'p1'};
  const projects=[{id:'p1',name:projectName,nameObserved:projectName,nameSince:Date.now()-10000},{id:'p2',name:'南河',nameObserved:'南河',nameSince:Date.now()-10000}];
  const history=new SessionStore(path.join(dir,'history.jsonl'),{create:{sessionId:id,cwd:dir}});
  const host=new PluginBackground(path.join(dir,'grants.json'),{targets:()=>[session],store:()=>history,complete:async()=>{throw Error('model forbidden');}},life.signal);
  const a=new Assistant({dataDirectory:dir,host:{snapshot:()=>({sessions:[session],projects}),projectNameHistory:(entry,sid,grantId)=>{const g=host.bind('assistant',life.signal).status(grantId);if(entry!=='assistant'||sid!==id||g.modelSessionId!==id||g.includedIds?.length!==1||g.includedIds[0]!==id||g.excludedIds.includes(id))throw Error('project authorization');return {projects,gaps:[]};}},conversations:{get:()=>id},background:host.bind('assistant',life.signal)});
  const grant=host.approve('assistant',host.prepare('assistant',{modelSessionId:id,includedIds:[id],excludedIds:[],includeHistory:true,dailyCalls:4}));
  a.learning.configure(grant,{modelSessionId:id,includeHistory:true,includedIds:[id]});
  const texts=[`${projectName}项目最初决定采用离线处理`,`${projectName}项目后来决定改为本地缓存`,'协作时我偏好先给结论再说明理由','换个话题，我希望先说结论并解释原因'];
  const ids=await history.appendMessages(texts.map(content=>({role:'user',content})));
  const source=(i,context,refs=[i])=>({type:'learned',namespace:'assistant-v4',grantId:grant,context,mode:'explicit',refs:refs.map(j=>({id:ids[j],conversationId:id,quote:texts[j],at:j+1})),topic:'case'+i});
  const rows=[0,1].map(i=>a.store.add({title:'北辰项目决策',content:texts[i],kind:'fact',scope:'project:p1'},source(i,{subject:'project',projectId:'p1',conversationId:id}),'active'));
  rows.push(a.store.add({title:'协作偏好',content:texts[2],kind:'preference',scope:'personal'},source(2,{subject:'user',conversationId:id},[2,3]),'active'));
  const ev=(i,idx=i)=>({memoryId:rows[i].id,revision:rows[i].revision,conversationId:id,sourceId:ids[idx],start:0,end:texts[idx].length,role:'support'});
  const themes=[{id:'theme-project',revision:1,themeKey:'project:p1',kind:'project',projectId:'p1',title:'项目决策',statements:[{text:texts[0],validFrom:history.getEntry(ids[0]).timestamp,evidence:[ev(0)]},{text:texts[1],validFrom:history.getEntry(ids[1]).timestamp,evidence:[ev(1)]}]},
    {id:'theme-preference',revision:1,themeKey:'preference',kind:'preference',title:'协作偏好',statements:[{text:texts[2],evidence:[ev(2),ev(2,3)]}]}];
  const setEnabled=value=>{
    a.store.setThemeOverviewEnabled(value);
    if(value) for(const row of themes) a.store.saveThemeStatements({...row,basisKey:'test-'+row.themeKey,generation:a.store.themeOverviewGeneration()});
  };
  t.after(()=>{a.stop();life.abort();history.close?.();fs.rmSync(dir,{recursive:true,force:true});});
  return {a,host,grant,id,history,ids,rows,themes,projects,session,setEnabled};
}
const projectQuery='本项目方案决策的演变过程是什么？';
const items=(f,q)=>JSON.parse(recall(f.a,f.id,q,q)??'{"items":[]}').items;
const theme=(f,q=projectQuery)=>items(f,q).find(x=>x.kind==='theme-overview');

test('pilot is opt-in, shares budget and exposes traceable IDs through search',async t=>{
  const f=await fixture(t);
  assert.equal(theme(f),undefined);
  const before=withMemory([{role:'user',content:projectQuery}],f.a,f.id);
  f.setEnabled(true);
  const result=theme(f);assert(result);assert.equal(result.statements.length,2);
  assert.equal(result.statements[0].evidence[0].memoryId,f.rows[0].id);
  const rows=items(f,projectQuery);assert(rows.length<=recallBudget.items);assert(rows.reduce((n,row)=>n+JSON.stringify(row).length,0)<=recallBudget.chars);
  const found=f.a.search(f.id,projectQuery).find(x=>x.kind==='theme-overview');assert(found);assert.equal(found.id,undefined);assert.equal(f.a.read(f.id,found.statements[0].evidence[0].memoryId).id,f.rows[0].id);assert.equal(f.a.historyRead(f.id,found.statements[0].evidence[0].sourceId).id,f.ids[0]);
  f.setEnabled(false);assert.deepEqual(withMemory([{role:'user',content:projectQuery}],f.a,f.id),before);
});
test('recall shares project-name history only within the current authorized pass',async t=>{
  const f=await fixture(t);f.setEnabled(true);
  const host=f.a.services.host, read=host.projectNameHistory;
  let allowed=true;
  const projectNameHistory=t.mock.method(host,'projectNameHistory',(...args)=>{
    if(!allowed)throw Error('project authorization');
    return read(...args);
  });
  assert.equal(theme(f)?.statements.length,2);
  assert.equal(projectNameHistory.mock.callCount(),1);
  assert.equal(theme(f,'我过去的协作沟通偏好有什么变化？')?.statements.length,1);
  assert.equal(projectNameHistory.mock.callCount(),1);
  allowed=false;
  assert.equal(theme(f),undefined);
  assert.equal(projectNameHistory.mock.callCount(),2);
});
test('separate statements survive independent revisions and forgotten evidence is excluded',async t=>{
  const f=await fixture(t);f.setEnabled(true);
  f.a.store.edit(f.rows[0].id,f.rows[0].revision,{title:'北辰项目决策',content:'修订后决定暂缓',kind:'fact',scope:'project:p1'});
  const result=theme(f);assert.equal(result.statements.length,1);assert.equal(result.statements[0].text,'北辰项目后来决定改为本地缓存');
  assert.equal(f.a.search(f.id,projectQuery).find(x=>x.kind==='theme-overview').statements.length,1);
  f.a.store.forget(f.rows[1].id,f.rows[1].revision);assert.equal(theme(f),undefined);
});
test('out-of-bounds evidence cannot support a project statement',async t=>{
  const f=await fixture(t);
  f.themes[0].statements[0].evidence[0].end+=50;
  f.setEnabled(true);
  assert.deepEqual(theme(f)?.statements.map(s=>s.text),['北辰项目后来决定改为本地缓存']);
});
test('exact, unrelated, foreign and duplicate project names do not route to themes',async t=>{
  const f=await fixture(t);f.setEnabled(true);
  for(const q of ['北辰项目 v2.3 的决策过程','北辰项目决策原话是什么','今天天气怎么样','南河项目方案决策的演变过程'])assert.equal(theme(f,q),undefined,q);
  f.projects.push({id:'p3',name:'北辰'});assert.equal(theme(f,'北辰项目方案决策的演变过程'),undefined);
});
test('collaboration preferences require an explicit historical question; revoke and rollback deny evidence',async t=>{
  const f=await fixture(t);f.setEnabled(true);
  const q='我过去的协作沟通偏好有什么变化？';assert.equal(theme(f,q)?.statements.length,1);
  assert.equal(theme(f,'帮我安排这次沟通'),undefined);
  f.history.setActiveLeaf(f.ids[0]);assert.equal(theme(f,q),undefined);
  assert.equal(theme(f,projectQuery)?.statements.length,1);
  f.host.bind('assistant',new AbortController().signal).revoke(f.grant);assert.equal(theme(f,projectQuery),undefined);
});

test('default assistant without a project resolves only a unique named project',async t=>{
  const f=await fixture(t);f.setEnabled(true);delete f.session.projectId;
  assert(theme(f,'北辰项目方案决策的演变过程'));
  assert.equal(theme(f,projectQuery),undefined);
  f.projects.push({id:'p3',name:'北辰'});
  assert.equal(theme(f,'北辰项目方案决策的演变过程'),undefined);
});

test('same source is deduplicated but an independent span is retained',async t=>{
  const f=await fixture(t);f.setEnabled(true);
  const selected=items(f,projectQuery), overview=selected.find(x=>x.kind==='theme-overview');
  assert(overview);assert(!selected.some(x=>f.rows.slice(0,2).some(row=>x.id===row.id)));
  const doc=[{sourceId:f.ids[0],text:'北辰项目最初决定采用离线处理',at:1},{sourceId:f.ids[0],text:'另一个不相关的完整片段',at:1}];
  const result=selectRecall([],doc,recallBudget,()=>[],overview,f.id);
  assert(!result.items.some(x=>x.kind==='original'&&x.content===doc[0].text));
  assert(result.items.some(x=>x.kind==='original'&&x.content===doc[1].text));
  const other=selectRecall([],doc.slice(0,1),recallBudget,()=>[],overview,'other-conversation');
  assert(other.items.some(x=>x.kind==='original'&&x.content===doc[0].text));
});
test('ASCII project names require full identifier boundaries',async t=>{
  const f=await fixture(t,'Atlas');f.setEnabled(true);delete f.session.projectId;
  assert(theme(f,'Atlas项目方案决策的演变过程'));
  assert.equal(theme(f,'AtlasNext项目方案决策的演变过程'),undefined);
  f.projects.push({id:'p3',name:'AtlasNext'});
  assert.equal(theme(f,'AtlasNext项目方案决策的演变过程'),undefined);
});

test('numbered project name routes without confusing version and date queries',async t=>{
 const f=await fixture(t,'T3');f.setEnabled(true);delete f.session.projectId;
 assert(theme(f,'T3项目方案决策的演变过程'));
 assert.equal(theme(f,'T3项目v2.3版本的决策演变'),undefined);
 assert.equal(theme(f,'T3项目2024年决策的演变'),undefined);
 assert.equal(theme(f,'T3X项目方案决策的演变过程'),undefined);
});

test('one-character project name needs a project marker and resolves uniquely',async t=>{
 const f=await fixture(t,'A');f.setEnabled(true);delete f.session.projectId;
 assert(theme(f,'A 项目的决策脉络'));
 assert.equal(theme(f,'关于 Atlas 的决策脉络'),undefined);
 f.projects.push({id:'p3',name:'A'});assert.equal(theme(f,'A 项目的决策脉络'),undefined);
});

test('zero timestamp survives and long timeline retains both ends within budget',async t=>{
 const f=await fixture(t);f.themes[1].statements[0].validFrom=0;f.setEnabled(true);
 assert.equal(theme(f,'我过去的协作沟通偏好有什么变化？').statements[0].validFrom,0);
 const texts=Array.from({length:8},(_,i)=>`北辰项目：决定采用阶段${i}方案`+'稳'.repeat(95));
 const ids=await f.history.appendMessages(texts.map(content=>({role:'user',content})));
 const statements=texts.map((text,i)=>{const row=f.a.store.add({title:'北辰项目决策',content:text,kind:'fact',scope:'project:p1'},
  {type:'learned',namespace:'assistant-v4',grantId:f.grant,context:{subject:'project',projectId:'p1',conversationId:f.id},mode:'explicit',refs:[{id:ids[i],conversationId:f.id,quote:text,at:i+1}],topic:'timeline'+i},'active');
  return {text,validFrom:f.history.getEntry(ids[i]).timestamp,evidence:[{memoryId:row.id,revision:row.revision,conversationId:f.id,sourceId:ids[i],start:0,end:text.length,role:'support'}]};});
 f.a.store.saveThemeStatements({themeKey:'project:p1',kind:'project',projectId:'p1',title:'项目决策',basisKey:'long',statements,generation:f.a.store.themeOverviewGeneration()});
 const result=theme(f);assert(result);assert.equal(result.statements[0].text,texts[0]);assert.equal(result.statements.at(-1).text,texts.at(-1));
 assert(JSON.stringify(result).length<=1500);assert(result.statements.length<8);
});

test('overlapping names choose the longest mention; separate projects stay ambiguous',async t=>{
 const f=await fixture(t,'山雀研发');f.setEnabled(true);delete f.session.projectId;
 f.projects.push({id:'p3',name:'山雀'});
 assert(theme(f,'山雀研发项目的决策脉络'));
 assert.equal(theme(f,'比较山雀项目和山雀研发项目的决策脉络'),undefined);
});


test('attached project requires an explicit current-project reference when no name matches',async t=>{
 const f=await fixture(t);f.setEnabled(true);
 for(const q of ['本项目决策演变','当前项目的决策脉络','这个项目的决策变化','北辰项目决策演变'])assert(theme(f,q),q);
 for(const q of ['鲸鱼项目决策演变','项目决策演变']) {assert.equal(theme(f,q),undefined,q);assert(!f.a.search(f.id,q).some(x=>x.kind==='theme-overview'),q);}
});
test('specific historical dates use source recall instead of the full timeline',async t=>{
 const f=await fixture(t);f.setEnabled(true);
 for(const q of ['截至去年五月北辰项目决策如何演变','北辰项目去年决策演变','北辰项目五月的决策变化','北辰项目上个月决策脉络'])assert.equal(theme(f,q),undefined,q);
 assert(theme(f,'北辰项目决策如何演变'));
});


test('a quotation does not suppress a stable fact with additional context',async t=>{
 const f=await fixture(t);
 const old=f.rows[0];
 f.a.store.db.prepare('UPDATE memories SET content=? WHERE id=?').run(old.content+'，并保存到季末供审计复核',old.id);
 f.setEnabled(true);
 const selected=items(f,projectQuery);assert(selected.some(x=>x.kind==='theme-overview'));
 assert(selected.some(x=>x.id===old.id && x.content.includes('保存到季末')));
 assert(!selected.some(x=>x.id===f.rows[1].id));
});


test('explicit theme overview requests honor project scope and precision',async t=>{
 const f=await fixture(t);f.setEnabled(true);delete f.session.projectId;
 assert(theme(f,'请给我北辰项目的主题概览'));
 assert(theme(f,'请给我协作沟通的主题概览'));
 assert.equal(theme(f,'请给我南河项目的主题概览'),undefined);
 assert.equal(theme(f,'北辰项目去年主题概览'),undefined);
});


test('a longer unregistered Chinese name does not route to a prefix project',async t=>{
 const f=await fixture(t,'海鸥');f.setEnabled(true);
 assert(theme(f,'请梳理海鸥项目决策如何演变'));
 assert.equal(theme(f,'请梳理海鸥实验室项目决策如何演变'),undefined);
});


test('punctuated project identifiers route by full project name but version queries stay exact',async t=>{
 const f=await fixture(t,'Lab-42');f.setEnabled(true);delete f.session.projectId;
 assert(theme(f,'Lab-42项目决策如何演变'));
 assert.equal(theme(f,'Lab-42项目v2.1.2决策如何演变'),undefined);
 assert.equal(theme(f,'Lab-420项目决策如何演变'),undefined);
});


test('project names containing collaboration terms request the project overview',async t=>{
 const f=await fixture(t,'反馈系统');f.setEnabled(true);delete f.session.projectId;
 assert(theme(f,'请给我反馈系统项目的主题概览'));
 assert(theme(f,'请概览反馈系统项目的决策演变'));
 assert(theme(f,'请总结反馈系统项目决策的演变与阶段进展'));
 assert.equal(theme(f,'反馈系统计划项目的决策演变'),undefined);
});
