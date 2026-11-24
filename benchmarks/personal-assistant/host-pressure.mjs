import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PluginBackground } from '../../dist/extensions/background.js';
import { SessionStore } from '../../dist/history/session-store.js';
import { Assistant } from '../../examples/extensions/personal-assistant/shared.mjs';
import { withMemory } from '../../examples/extensions/personal-assistant/context.mjs';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-recall-pressure-')), life=new AbortController();
const id='abc123', target={id,instanceId:id,cwd:directory,kind:'agent',title:'助手',provider:'test',model:'test',busy:true};
const history=new SessionStore(path.join(directory,'history.jsonl'),{create:{sessionId:id,cwd:directory}});
const host=new PluginBackground(path.join(directory,'grants.json'),{targets:()=>[target],store:()=>history,complete:async()=>{throw Error('inference not expected');}},life.signal);
const a=new Assistant({dataDirectory:directory,host:{snapshot:()=>({sessions:[target],projects:[]})},
  conversations:{get:()=>id},background:host.bind('assistant',life.signal)});
try {
  const grant=host.approve('assistant',host.prepare('assistant',{modelSessionId:id,includedIds:[id],excludedIds:[],includeHistory:true,dailyCalls:4}));
  a.learning.configure(grant,{modelSessionId:id,includeHistory:true,includedIds:[id]});
  const claim='我的紧急联络代号是松河';
  await history.appendMessages([{role:'user',content:claim}]);
  const forgotten=a.remember(id,{title:'联络代号',content:claim,topic:'emergency',kind:'fact',quote:claim});
  const varied=process.argv.includes("--varied");
  let length=0;
  for(let i=0;i<40;i++){
    const detail='设备仓储例行盘点，记录库位、箱号、外包装和签收人，按生产队列顺序核对。';
    const long=varied ? Array.from({length:58},(_,j)=>detail.slice(0,-1)+'，区位'+String.fromCharCode(0x3400+i*58+j)+'。').join('') : detail.repeat(58);
    const c=`第 ${i+1} 批样本。机器巡检时查看温度、扭矩、油路和漏水痕迹。` + long;
    length+=c.length;
    await history.appendMessages([{role:'user',content:c}]);
  }
  const run=()=>withMemory([{role:'user',content:'机器巡检扭矩'}],a,id);
  function measure() {
    for(let i=0;i<8;i++)assert.match(run()[0].content,/unverified-history/);
    const times=[];
    for(let i=0;i<60;i++){const start=performance.now();run();times.push(performance.now()-start);}
    times.sort((a,b)=>a-b);
    return {p50:+times[30].toFixed(2),p95:+times[57].toFixed(2)};
  }
  const baseline=measure();
  a.store.forget(forgotten.id,forgotten.revision);
  const request=[{role:'user',content:'松河'}];
  assert.equal(withMemory(request,a,id),request);
  const withForget=measure();
  console.log(JSON.stringify({messages:41,scenario:varied?"varied":"repeated",averageCharsPerLongMessage:Math.round(length/40),runs:60,baseline,withForget},null,2));
} finally {a.stop();life.abort();history.close?.();fs.rmSync(directory,{force:true,recursive:true});}
