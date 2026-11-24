import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

// Run each implementation in a fresh process: node recall-scale.mjs --root PATH
// Optional --memories 100 --history 1000 --runs 10 select a smaller matrix.
const opt = name => { const i=process.argv.indexOf('--'+name); return i<0 ? undefined : process.argv[i+1]; };
const root=path.resolve(opt('root') ?? path.join(import.meta.dirname,'../..'));
const hostRoot=path.resolve(opt('host-root') ?? root);
const load=async p=>import(pathToFileURL(path.join(root,p)).href);
const loadHost=async p=>import(pathToFileURL(path.join(hostRoot,p)).href);
const [{PluginBackground},{SessionStore},{Assistant},{withMemory},{retrieve}] = await Promise.all([
  loadHost('dist/extensions/background.js'),loadHost('dist/history/session-store.js'),
  load('examples/extensions/personal-assistant/shared.mjs'),load('examples/extensions/personal-assistant/context.mjs'),
  load('examples/extensions/personal-assistant/retrieval.mjs')]);
const memories=opt('memories') ? [Number(opt('memories'))] : [100,500,1000];
const histories=opt('history') ? [Number(opt('history'))] : [1000,10000,50000];
const runs=Number(opt('runs') ?? 10);
if (![...memories,...histories,runs].every(n=>Number.isSafeInteger(n)&&n>0)) throw Error('counts must be positive integers');
const percentile = (values,p) => +values.slice().sort((a,b)=>a-b)[Math.ceil(values.length*p)-1].toFixed(2);
const stats = a => ({n:a.length,p50:percentile(a,.5),p95:percentile(a,.95)});
const scenarios=[
  {name:'exact',query:'松河联络代号是什么',needle:'松河'},
  {name:'old_identifier',query:'旧代号 OLD-314 是什么',needle:'OLD-314'},
  {name:'project_name',query:'北辰项目的发布计划',needle:'北辰项目'},
  {name:'synonym',query:'我的年龄是多少岁',needle:'出生'},
  {name:'style',query:'天气学和正弦函数有什么区别',needle:'简洁'},
  {name:'original_history',query:'紫鹭船队的停靠地点在哪',needle:'紫鹭船队停靠在东港'},
  {name:'dense',query:'设备巡检温度扭矩',needle:'设备巡检'}
];
async function runCase(n,h) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-scale-')), life=new AbortController();
  const id='abc123',target={id,instanceId:id,cwd:directory,kind:'agent',title:'助手',provider:'test',model:'test',busy:true,projectId:'projA'};
  const history=new SessionStore(path.join(directory,'history.jsonl'),{create:{sessionId:id,cwd:directory}});
  const host=new PluginBackground(path.join(directory,'grants.json'),{targets:()=>[target],store:()=>history,complete:async()=>{throw Error('inference forbidden');}},life.signal);
  const a=new Assistant({dataDirectory:directory,host:{snapshot:()=>({sessions:[target],projects:[{id:'projA',name:'北辰'},{id:'projB',name:'北辰'}]})},conversations:{get:()=>id},background:host.bind('assistant',life.signal)});
  try {
    const grant=host.approve('assistant',host.prepare('assistant',{modelSessionId:id,includedIds:[id],excludedIds:[],includeHistory:true,dailyCalls:4}));
    a.learning.configure(grant,{modelSessionId:id,includeHistory:true,includedIds:[id]});
    const claims=['我的紧急联络代号是松河，设备巡检','我的旧代号是 OLD-314','北辰项目的发布计划是周五发布','我出生于1990年','我偏好简洁回答','北辰另一项目的发布计划是周日发布'];
    const ids=[];
    for(let start=0;start<h;start+=300) {
      const batch=Array.from({length:Math.min(300,h-start)},(_,j)=>{const i=start+j;return {role:'user',content:claims[i] ?? (`合成记录 ${i}：设备巡检记录温度、扭矩、仓储位置和包装检查。`+(i===h-1?' 紫鹭船队停靠在东港':''))};});
      ids.push(...await history.appendMessages(batch));
    }
    const first=a.remember(id,{title:'紧急联络代号',content:claims[0],topic:'emergency',kind:'fact',quote:claims[0]});
    const template=a.store.get(first.id).source;
    for(let i=1;i<n;i++) {
      const content=claims[i] ?? `合成记录 ${i}：设备巡检记录温度、扭矩、仓储位置和包装检查。`;
      const title=['紧急联络代号','旧代号','北辰项目发布计划','出生信息','回答风格','另一项目发布计划'][i] ?? `设备记录 ${i}`;
      const source={...template,...([2,5].includes(i)?{context:{subject:'project',conversationId:id,projectId:i===2?'projA':'projB',projectName:'北辰'}}:{}),topic:'scale-'+i,refs:[{id:ids[i],conversationId:id,quote:content,at:i+1}],originRefs:[]};
      a.store.add({title,content,kind:i===4?'preference':'fact',scope:[2,5].includes(i)?'project:'+(i===2?'projA':'projB'):'personal'},source,'active');
    }
    const access=a.scope(id),cold=[],warm=[],coverage=[],queryTimes=new Map(scenarios.map(s=>[s.name,[]]));
    const call=q=>withMemory([{role:'user',content:q}],a,id);
    const injectedItems=out=>{const text=out.at(-1).content, end=text.indexOf('\n[End of memory]');return end<0?[]:JSON.parse(text.slice(text.indexOf('\n')+1,end)).items;};
    for(const s of scenarios) {
      let t=performance.now(); const out=call(s.query); const firstMs=performance.now()-t; cold.push(firstMs);
      const injected=injectedItems(out).some(row=>JSON.stringify(row).includes(s.needle));
      const candidates={};
      for(const window of [12,24]) {
        const originalCandidates=a.store.recallCandidates, originalValidator=a.learning.validator; let fetched=0,validated=0,pages=0;
        if(originalCandidates) a.store.recallCandidates=function(...args){const result=originalCandidates.apply(this,args);pages++;fetched+=result.length;return result;};
        a.learning.validator=function(...args){const valid=originalValidator.apply(this,args);const wrapped=row=>{validated++;return valid(row);};wrapped.prefetch=valid.prefetch?.bind(valid);return wrapped;};
        try {const t=performance.now(),rows=retrieve(a,access.session,s.query,12,true,true,{window});candidates[window]={covered:rows.some(row=>(row.title+' '+row.content).includes(s.needle)),ms:+(performance.now()-t).toFixed(2),fetched:originalCandidates?fetched:null,pages:originalCandidates?pages:null,validated};} catch(e) {candidates[window]={error:String(e)};}
        finally {if(originalCandidates)a.store.recallCandidates=originalCandidates;a.learning.validator=originalValidator;}
      }
      coverage.push({scenario:s.name,firstMs:+firstMs.toFixed(2),candidates,injected});
    }
    for(let r=0;r<runs;r++) for(const s of scenarios) {const t=performance.now();call(s.query);const elapsed=performance.now()-t;warm.push(elapsed);queryTimes.get(s.name).push(elapsed);}
    const projectItems=injectedItems(call('发布计划'));
    const sameNameCurrentIncluded=projectItems.some(row=>JSON.stringify(row).includes('周五发布'));
    const sameNameProjectExcluded=!projectItems.some(row=>JSON.stringify(row).includes('周日发布'));
    const numberNegative=!injectedItems(call('新代号 NEW-314 是什么')).some(row=>JSON.stringify(row).includes('OLD-314'));
    history.setActiveLeaf(ids[0]);
    const afterRollback=injectedItems(call('旧代号 OLD-314'));
    const rollbackExcluded=!afterRollback.some(row=>JSON.stringify(row).includes('OLD-314'));
    const fillAfterInvalidation=injectedItems(call('设备巡检')).some(row=>JSON.stringify(row).includes('松河'));
    const survivingEvidence=injectedItems(call('松河联络代号是什么')).some(row=>JSON.stringify(row).includes('松河'));
    host.bind('assistant',life.signal).revoke(grant);
    const revoked=injectedItems(call('松河联络代号是什么')).length===0;
    return {memories:n,history:h,cold:stats(cold),warm:stats(warm),warmByQuery:Object.fromEntries([...queryTimes].map(([key,values])=>[key,stats(values)])),coverage,checks:{numberNegative,sameNameCurrentIncluded,sameNameProjectExcluded,rollbackExcluded,fillAfterInvalidation,survivingEvidence,revoked}};
  } finally {a.stop();life.abort();history.close?.();fs.rmSync(directory,{recursive:true,force:true});}
}
console.log(JSON.stringify({root,hostRoot,node:process.version,runsPerQuery:runs,budget:{items:4,chars:2400,originals:2},note:'Cold = first call per query on an already opened and seeded host; warm = repeated calls in same process. First-query timings are ordered; only the first is the first host query. Candidate trials use fixed output limit 12 and internal window 12/24 where supported; legacy ignores the window. Fetched counts include duplicates across lanes; validated counts validator calls. Instrumented candidate timings are single calls after the first request; final injection always uses implementation default window. No model calls. Breakdown of retrieval/validation/sorting is unavailable without implementation instrumentation.',cases:[]}));
for(const n of memories) for(const h of histories) console.log(JSON.stringify(await runCase(n,h)));

// Regression cases use the real host's branch validity, not a mock validator.
async function runLaneEdges() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-lane-')), life=new AbortController(), id='lane123';
  const target={id,instanceId:id,cwd:directory,kind:'agent',title:'助手',provider:'test',model:'test',busy:true};
  const history=new SessionStore(path.join(directory,'history.jsonl'),{create:{sessionId:id,cwd:directory}});
  const host=new PluginBackground(path.join(directory,'grants.json'),{targets:()=>[target],store:()=>history,complete:async()=>{throw Error('inference forbidden');}},life.signal);
  const a=new Assistant({dataDirectory:directory,host:{snapshot:()=>({sessions:[target],projects:[]})},conversations:{get:()=>id},background:host.bind('assistant',life.signal)});
  try {
    const grant=host.approve('assistant',host.prepare('assistant',{modelSessionId:id,includedIds:[id],excludedIds:[],includeHistory:true,dailyCalls:4}));
    a.learning.configure(grant,{modelSessionId:id,includeHistory:true,includedIds:[id]});
    const keys=['灯塔','补给','钥匙','工时','货仓'];
    const goodExact='塔台钥匙保存在 Q-8-X。'+Array.from({length:50},(_,i)=>` 样本名r${i}`).join('');
    const goodLexical=keys.join(' ')+'，需要二次实地测量。'+Array.from({length:50},(_,i)=>` 附件k${i}`).join('');
    const both='链接 P-6-A 与 B-4-S 的两个资产。'+Array.from({length:50},(_,i)=>` 样本名q${i}`).join('');
    const validTexts=[goodExact,goodLexical,...Array.from({length:16},(_,i)=>`档案采购实际经办是候补工位 ${i}`),...Array.from({length:40},(_,i)=>keys.filter((_,j)=>j!==i%keys.length).join(' ')+` 巡查记录 ${i}。`),both,...Array.from({length:40},(_,i)=>`配件 ${i%2===0?'P-6-A':'B-4-S'} 命令 ${i}`)];
    const validIds=await history.appendMessages(validTexts.map(content=>({role:'user',content})));
    const invalidTexts=Array.from({length:30},(_,i)=>`作废 Q-8-X ${i}`);
    const invalidIds=await history.appendMessages(invalidTexts.map(content=>({role:'user',content})));
    history.setActiveLeaf(validIds.at(-1));
    const add=(content,ref,at)=>a.store.add({title:'合成核验',content,kind:'fact',scope:'personal'},
      {type:'learned',namespace:'assistant-v4',grantId:grant,refs:[{id:ref,conversationId:id,quote:content,at}],context:{subject:'user',conversationId:id},mode:'explicit'},'active');
    const rows=validTexts.map((content,i)=>add(content,validIds[i],i<2?1:50+i));
    invalidTexts.forEach((content,i)=>add(content,invalidIds[i],2+i));
    const session=a.scope(id).session;
    const cases=[{name:'exact_after_invalid',query:'档案采购 Q-8-X 实际经办是谁',row:rows[0]},
      {name:'full_terms_after_short_distractors',query:keys.join(' '),row:rows[1]},
      {name:'extra_unmatched_qualifier',query:[...keys,'探索'].join(' '),row:rows[1]},
      {name:'paired_identifiers',query:'P-6-A B-4-S',row:rows[58]}];
    const results=[];
    for(const item of cases){
      const windows={};
      for(const window of [12,24]){
        const matches=retrieve(a,session,item.query,8,false,true,{window});
        windows[window]=matches.some(row=>row.id===item.row.id);
      }
      const matches=retrieve(a,session,item.query,8,false,true,{legacy:true});
      const output=withMemory([{role:'user',content:item.query}],a,id).at(-1).content;
      const end=output.indexOf('\n[End of memory]');
      const injected=end<0?false:JSON.parse(output.slice(output.indexOf('\n')+1,end)).items.some(row=>row.id===item.row.id);
      results.push({name:item.name,windows,fullScan:matches.some(row=>row.id===item.row.id),injectedDefault:injected});
    }
    return {type:'lane_edges',invalidSourceCount:invalidIds.length,shortDistractorCount:40,results};
  } finally {a.stop();life.abort();history.close?.();fs.rmSync(directory,{recursive:true,force:true});}
}
console.log(JSON.stringify(await runLaneEdges()));
