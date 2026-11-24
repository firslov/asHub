import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
const option=(name,defaultValue)=>{const i=process.argv.indexOf('--'+name);return i<0?defaultValue:process.argv[i+1];};
const root=path.resolve(option('root',path.join(import.meta.dirname,'../..')));
const hostRoot=path.resolve(option('host-root',root));
const importFrom=(base,p)=>import(pathToFileURL(path.join(base,p)).href);
const [{PluginBackground},{SessionStore},{Assistant},{withMemory}]=await Promise.all([
  importFrom(hostRoot,'dist/extensions/background.js'),importFrom(hostRoot,'dist/history/session-store.js'),
  importFrom(root,'examples/extensions/personal-assistant/shared.mjs'),importFrom(root,'examples/extensions/personal-assistant/context.mjs')]);
const count=Number(option('trajectories','40'));
if(!Number.isSafeInteger(count)||count<1||count>100)throw Error('trajectories must be 1–100');
const tally={project:{expected:0,covered:0},preference:{expected:0,covered:0},exact:{expected:0,covered:0},unrelated:{expected:0,leaked:0},foreign:{expected:0,leaked:0},duplicate:{expected:0,leaked:0}};
let checks=0,elapsed=0, pilotAvailable=false;
const evidenceCoverage={project:{early:0,latest:0,both:0},preference:{early:0,latest:0,both:0}};
for(let i=0;i<count;i++){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-theme-bench-')),life=new AbortController(),id='bench123';
 const name='云'+String.fromCharCode(0x4e00+i), code='ZX-'+(100+i);
 const target={id,instanceId:id,cwd:dir,kind:'agent',title:'助手',provider:'test',model:'test',busy:true,...(i%2?{}:{projectId:'p1'})};
 const projects=[{id:'p1',name,nameObserved:name,nameSince:Date.now()-10000},{id:'p2',name:'南河',nameObserved:'南河',nameSince:Date.now()-10000}];
 const history=new SessionStore(path.join(dir,'history.jsonl'),{create:{sessionId:id,cwd:dir}});
 const host=new PluginBackground(path.join(dir,'grants.json'),{targets:()=>[target],store:()=>history,complete:async()=>{throw Error('model forbidden');}},life.signal);
 const a=new Assistant({dataDirectory:dir,host:{snapshot:()=>({sessions:[target],projects}),projectNames:(entry,sid,grantId)=>{const g=host.bind('assistant',life.signal).status(grantId);if(entry!=='assistant'||sid!==id||g.modelSessionId!==id||g.includedIds?.length!==1||g.includedIds[0]!==id||g.excludedIds.includes(id))throw Error('project authorization');return projects;}},conversations:{get:()=>id},background:host.bind('assistant',life.signal)});
 try{
  const grant=host.approve('assistant',host.prepare('assistant',{modelSessionId:id,includedIds:[id],excludedIds:[],includeHistory:true,dailyCalls:4}));
  a.learning.configure(grant,{modelSessionId:id,includeHistory:true,includedIds:[id]});
  const texts=[`${name}项目最初决定采用离线处理`,`${name}项目后来决定改为本地缓存`,'协作时我偏好先给结论再说明理由','换个话题，我希望先说结论并解释原因',`我的设备代号是 ${code}，由明舟负责`];
  const ids=await history.appendMessages(texts.map(content=>({role:'user',content})));
  const source=(i,context,refs=[i])=>({type:'learned',namespace:'assistant-v4',grantId:grant,context,mode:'explicit',refs:refs.map(j=>({id:ids[j],conversationId:id,quote:texts[j],at:j+1})),topic:'benchmark'+i});
  const rows=[0,1].map(j=>a.store.add({title:name+'项目决策',content:texts[j],kind:'fact',scope:'project:p1'},source(j,{subject:'project',projectId:'p1',conversationId:id}),'active'));
  rows.push(a.store.add({title:'协作偏好',content:texts[2],kind:'preference',scope:'personal'},source(2,{subject:'user',conversationId:id},[2,3]),'active'));
  rows.push(a.store.add({title:'设备代号',content:texts[4],kind:'fact',scope:'personal'},source(4,{subject:'user',conversationId:id}),'active'));
  const ev=(j,k=j)=>({memoryId:rows[j].id,revision:rows[j].revision,conversationId:id,sourceId:ids[k],start:0,end:texts[k].length,role:'support'});
  if(typeof a.store.setThemeOverviewEnabled==='function' && typeof a.store.saveThemeStatements==='function'){
   pilotAvailable=true;a.store.setThemeOverviewEnabled(true);const generation=a.store.themeOverviewGeneration();
   a.store.saveThemeStatements({themeKey:'project:p1',kind:'project',projectId:'p1',title:'项目决策',basisKey:'basis-project',generation,statements:[{text:texts[0],validFrom:history.getEntry(ids[0]).timestamp,evidence:[ev(0)]},{text:texts[1],validFrom:history.getEntry(ids[1]).timestamp,evidence:[ev(1)]}]});
   a.store.saveThemeStatements({themeKey:'preference',kind:'preference',title:'协作偏好',basisKey:'basis-preference',generation,statements:[{text:texts[2],evidence:[ev(2),ev(2,3)]}]});
  }
  const get=q=>{const t=performance.now(),out=withMemory([{role:'user',content:q}],a,id).at(-1).content;elapsed+=performance.now()-t;checks++;
   const end=out.indexOf('\n[End of memory]');return end<0?[]:JSON.parse(out.slice(out.indexOf('\n')+1,end)).items;};
  const positive=(type,q)=>{const items=get(q),body=JSON.stringify(items);tally[type].expected++;if(items.some(x=>x.kind==='theme-overview'))tally[type].covered++;
   const early=body.includes(type==='project'?texts[0]:texts[2]),latest=body.includes(type==='project'?texts[1]:texts[3]);
   evidenceCoverage[type].early+=Number(early);evidenceCoverage[type].latest+=Number(latest);evidenceCoverage[type].both+=Number(early&&latest);};
  const negative=(type,q)=>{const rows=get(q);tally[type].expected++;if(rows.some(x=>x.kind==='theme-overview'))tally[type].leaked++;};
  positive('project',`${name}项目方案决策的演变过程是什么？`);
  positive('preference','我过去的协作沟通偏好有什么变化？');
  tally.exact.expected++;if(get(`设备 ${code} 是谁负责`).some(x=>x.content?.includes('明舟')))tally.exact.covered++;
  negative('unrelated','今天的天气怎么样');
  negative('foreign','南河项目方案决策的演变过程');
  projects.push({id:'p3',name});negative('duplicate',`${name}项目方案决策的演变过程`);
 }finally{a.stop();life.abort();history.close?.();fs.rmSync(dir,{recursive:true,force:true});}
}
console.log(JSON.stringify({root,hostRoot,node:process.version,trajectories:count,defaultAssistantWithoutProjectId:Math.floor(count/2),questions:checks,pilotAvailable,meanMs:+(elapsed/checks).toFixed(2),tally,evidenceCoverage,
 note:'Synthetic seeded examples; no model calls. Explicitly seeded overviews measure retrieval and evidence qualification, not model-generated overview quality or real-world generalization.'},null,2));

// These trajectories exercise the actual low-priority runtime with a fake
// selector, not the preseeded retrieval fixtures above. The selector can choose
// the endpoints only if the runtime actually supplies them in its input.
async function longTrajectories() {
  const modulePath=path.join(root,'examples/extensions/personal-assistant/theme-overviews.mjs');
  const maybeConsolidateOverview=fs.existsSync(modulePath) ? (await importFrom(root,'examples/extensions/personal-assistant/theme-overviews.mjs')).maybeConsolidateOverview : null;
  const results=[];
  for(let k=0;k<4;k++){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-theme-long-')),life=new AbortController(),id='long123',name='长程'+String.fromCharCode(0x7532+k);
    const target={id,instanceId:id,cwd:dir,kind:'agent',title:'助手',provider:'test',model:'test',busy:false};
    const history=new SessionStore(path.join(dir,'history.jsonl'),{create:{sessionId:id,cwd:dir}});
    let seen=[],calls=0;
    const host=new PluginBackground(path.join(dir,'grants.json'),{targets:()=>[target],store:()=>history,complete:async(_id,messages)=>{
      calls++;const data=JSON.parse(messages[1].content);seen=data.excerpts ?? [];
      const first=seen.find(x=>x.text.includes('初始原则')),last=seen.find(x=>x.text.includes('最新转折'));
      const indices=[first?.index,last?.index].filter(x=>Number.isInteger(x));
      return JSON.stringify({indices:indices.length?indices:[0]});
    }},life.signal);
    const projects=[{id:'p1',name,nameObserved:name,nameSince:Date.now()-40*86400000}];
    const a=new Assistant({dataDirectory:dir,host:{snapshot:()=>({sessions:[target],projects}),projectNames:(entry,sid,grantId)=>{const g=host.bind('assistant',life.signal).status(grantId);if(entry!=='assistant'||sid!==id||g.modelSessionId!==id||g.includedIds?.length!==1||g.includedIds[0]!==id||g.excludedIds.includes(id))throw Error('project authorization');return projects;}},conversations:{get:()=>id},background:host.bind('assistant',life.signal)});
    try{
      const grant=host.approve('assistant',host.prepare('assistant',{modelSessionId:id,includedIds:[id],excludedIds:[],includeHistory:true,dailyCalls:4}));
      a.learning.configure(grant,{modelSessionId:id,includeHistory:true,includedIds:[id]});
      const available=!!maybeConsolidateOverview && typeof a.store.setThemeOverviewEnabled==='function';
      if(available)a.store.setThemeOverviewEnabled(true);
      const texts=[`项目${name}决定初始原则：数据离线处理并优先保密。`,
        ...Array.from({length:20},(_,i)=>`项目${name}决定常规方案：检查批次${i}并按既定流程复核。`),
        `项目${name}决定最新转折：改用本地缓存并记录审批，编号 ZX-${900+k}。`];
      const ids=[];const clock=Date.now,base=clock()-texts.length*86400000;
      try{for(let i=0;i<texts.length;i++){Date.now=()=>base+i*86400000;ids.push(...await history.appendMessages([{role:'user',content:texts[i]}]));}}finally{Date.now=clock;}
      for(let i=0;i<texts.length;i++){
        const source={type:'learned',namespace:'assistant-v4',grantId:grant,context:{subject:'project',projectId:'p1',conversationId:id},mode:'explicit',refs:[{id:ids[i],conversationId:id,quote:texts[i],at:base+i*86400000}],topic:'long-'+i};
        const row=a.store.add({title:'项目决策',content:texts[i],kind:'fact',scope:'project:p1'},source,'active');
        a.store.db.prepare('UPDATE memories SET updated=? WHERE id=?').run(base+i*86400000,row.id);
      }
      let generated=false,error=null;
      try{if(available)generated=await maybeConsolidateOverview(a.learning,a.learning.config(),target,life.signal);}catch(e){error=String(e);}
      const saved=available?a.store.listThemeStatements():[];
      const text=JSON.stringify(saved),out=withMemory([{role:'user',content:`${name}项目方案决策的演变过程是什么？`}],a,id).at(-1).content;
      const exact=withMemory([{role:'user',content:`编号 ZX-${900+k} 的决定是什么？`}],a,id).at(-1).content;
      results.push({available,calls,generated,error,exactCovered:exact.includes('最新转折'),suppliedEarly:seen.some(x=>x.text.includes('初始原则')),suppliedLatest:seen.some(x=>x.text.includes('最新转折')),
        savedEarly:text.includes('初始原则'),savedLatest:text.includes('最新转折'),injectedEarly:out.includes('初始原则'),injectedLatest:out.includes('最新转折')});
    }finally{a.stop();life.abort();history.close?.();fs.rmSync(dir,{recursive:true,force:true});}
  }
  return {available:true,trajectories:results.length,eventsPerTrajectory:22,results};
}
console.log(JSON.stringify({longProject:await longTrajectories()}));
