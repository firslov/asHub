import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginBackground } from '../../dist/extensions/background.js';
import { SessionStore } from '../../dist/history/session-store.js';
import { Assistant } from '../../examples/extensions/personal-assistant/shared.mjs';
import { recall } from '../../examples/extensions/personal-assistant/context.mjs';

const id='aa1122ff', DAY=86_400_000;
const repeat='我往常在月会使用简明格式，项目风险先讲。';
const title='月会格式', preference='月会倾向使用简明格式';
const base=(id, quote, change={})=>({title,content:preference,kind:'preference',scope:'personal',
  subject:'user',certainty:'inferred',aliases:[],evidence:[{id,quote}],...change});
async function compare(useEvents){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-events-zh-'));
  const target={id,instanceId:id,cwd:directory,title:'助手',kind:'agent',provider:'test',model:'test',busy:true};
  const filename=path.join(directory,'history.jsonl'), grants=path.join(directory,'grants.json');
  const RealDate=Date;
  let now=RealDate.UTC(2026,0,12,9);
  globalThis.Date=class extends RealDate {
    constructor(...args){super(...(args.length?args:[now]));}
    static now(){return now;}
  };
  let history=new SessionStore(filename,{create:{sessionId:id,cwd:directory}});
  let life, host, a, response=()=>({memories:[]}), calls=[], stages=[];
  function start(){
    life=new AbortController();
    host=new PluginBackground(grants,{targets:()=>[target],store:()=>history,complete:async(_id,request)=>{
      const data=JSON.parse(request[1].content),value=response(data);
      calls.push({chars:JSON.stringify(request).length,existing:data.existing.length,events:data.events?.length??0,
        priorSources:data.existing.filter(row=>row.priorEvidence).length,utcDay:new Date().toISOString().slice(0,10),
        context:data.context?.length??0});
      return JSON.stringify(value);
    }},life.signal);
    a=new Assistant({dataDirectory:directory,conversations:{get:()=>id},
      host:{snapshot:()=>({sessions:[target],projects:[]})},background:host.bind('assistant',life.signal)});
    if(!useEvents) {
      a.learning.eventLayout=()=>[];
      a.learning.selectIncrement=(_config,_target,rows)=>rows;
    }
  }
  const add=async(content,role='user')=>(await history.appendMessages([{role,content}]))[0];
  const tick=async step=>{const start=calls.length;now+=120000;await a.learning.tick();
    assert.equal(a.learning.error,'',step);
    stages.push({step,calls:calls.slice(start),active:a.store.activeMemories().length});
  };
  const setReply=fn=>{response=fn;};
  const assign=(row,relation)=>({memoryId:row.id,revision:row.revision,relation});
  const find=title=>a.store.memoryTargets().find(row=>row.title===title);
  start();
  try {
    const grant=host.approve('assistant',host.prepare('assistant',{modelSessionId:id,includedIds:[id],
      excludedIds:[],includeHistory:true,dailyCalls:4}));
    a.learning.configure(grant,{modelSessionId:id,includedIds:[id],includeHistory:true,dailyCalls:4});
    await new Promise(resolve=>setImmediate(resolve));
    const precise='我的 VX-7023 操作准则是先核对再发布。';
    await add(precise);
    const subject=a.remember(id,{title:'操作准则',content:'工作以核对为先',quote:precise,kind:'fact',subject:'user'});
    for(const text of ['鸟类记录用纸质笔记','灌溉使用滴漏装置','出差优先乘火车','库存工具放三号架','合唱预定周五',
      '外壳材料使用木材','庭院色彩选用蓝色','采购付款采用月结','仓位使用上午快照','南门使用第二个入口']){
      now+=10;await add(text);
      a.remember(id,{title:text,content:text,quote:text,kind:'fact',subject:'user'});
    }
    const initial=a.learning.historyBatch(a.learning.config(),target,'scan:'+id);
    a.learning.commitScan('scan:'+id,initial.state,id);
    target.busy=false;

    await add('本次投影临时用红色背景。');await tick('一次性事项');
    const first=await add(repeat);
    setReply(()=>({memories:[base(first,'我往常在月会使用简明格式')]}));await tick('形成待观察');
    const candidate=find(title);assert.equal(candidate.state,'candidate');

    now+=DAY;
    const repeated=await add(repeat);
    setReply(()=>({memories:[base(repeated,'项目风险先讲',assign(candidate,'support'))]}));await tick('隔日重复原文，换一种截引');
    assert.equal(find(title).revision,candidate.revision);

    now+=DAY;
    const corroboration='实际开完本月月会后，我确认简明格式更便于参与者理解。';
    const second=await add(corroboration);
    setReply(data=>{
      const prior=data.existing.find(row=>row.id===candidate.id);
      return {memories:prior?[base(second,corroboration,assign(prior,'support'))]:[]};
    });
    await tick('隔日独立支持');
    assert.equal(find(title).state,'active');assert.equal(find(title).id,candidate.id);

    await add('换个话题，更新库存工具的记录。');
    await add('另一个任务，重新确认南门的入口。');
    const correction='回到之前的项目，更正 VX-7023：以后改为次日上午执行。';
    const corrected=await add(correction);
    const correctionReply=(row, sourceId=corrected, quote=correction)=>base(sourceId,quote,{...assign(row,'revise'),
      title:'操作准则',kind:'fact',content:'操作安排在次日上午执行',certainty:'explicit'});
    setReply(data=>{
      const prior=data.existing.find(row=>row.id===subject.id);
      return {memories:prior?[correctionReply(prior)]:[]};
    });
    await tick('同批两个话题与按编号明确纠正');

    const observation='我还没定是否改成长篇格式，月会暂未确认。';
    const unsure=await add(observation);
    setReply(data=>{
      const prior=data.existing.find(row=>row.id===candidate.id);
      return {memories:prior?[base(unsure,observation,{...assign(prior,'revise'),certainty:'explicit',content:'月会使用长篇格式'})]:[]};
    });
    await tick('未解决冲突');
    assert.equal(find(title).content,preference);
    assert(a.store.memoryTargets().some(row=>row.source.mode==='unresolved'));

    await add('您平时使用什么姓名署名？','assistant');
    setReply(()=>({memories:[]}));await tick('先到的问句无可学习增量');
    a.stop();life.abort();history.close?.();
    history=new SessionStore(filename);start();
    const who=await add('陈岚');
    setReply(data=>{
      assert(data.context?.at(-1)?.role==='assistant');
      return {memories:[base(who,'陈岚',{title:'署名',content:'用户以陈岚署名',certainty:'explicit',kind:'fact'})]};
    });
    await tick('跨批短答与主机重启');
    assert.equal(find('署名').source.refs[0].contextId,history.getHistoryEntries().at(-2).id);

    const before=a.store.get(subject.id);
    const oldRow=a.services.background.entry(grant,id,history.getHistoryEntries()[0].id);
    a.learning.applyResult(a.learning.config(),target,[oldRow],{memories:[{
      ...correctionReply(before,oldRow.id,oldRow.text),content:'退回旧流程',
    }]},[before],[],false,[]);
    assert.equal(a.store.get(subject.id).revision,before.revision);
    stages.push({step:'旧更正迟到',calls:[]});

    const personal=find('署名');
    a.store.forget(personal.id,personal.revision);
    await add('补充：陈岚是旧签名。');
    setReply(()=>{throw Error('forgotten duplicate should not reach inference');});
    await tick('遗忘及重复原话');
    assert(!recall(a,id,'陈岚')?.includes('陈岚'));
    a.learning.pause();
    await add('我的新签名还没决定。');
    await tick('撤权后无模型调用');
    assert.equal(a.scope(id),null);
    const daily={};for(const call of calls)daily[call.utcDay]=(daily[call.utcDay]??0)+1;
    assert(Object.values(daily).every(n=>n<=4));
    const mixed=stages.find(stage=>stage.step==='同批两个话题与按编号明确纠正').calls[0];
    return {mode:useEvents?'事件分段和选择性巩固':'关闭二阶段分段与增量筛选（消融）',daily,mixed,
      calls:calls.length,chars:calls.reduce((n,c)=>n+c.chars,0),maxChars:Math.max(...calls.map(c=>c.chars)),
      priorSlots:calls.reduce((n,c)=>n+c.existing,0),explicitRevision:a.store.get(subject.id).content!=='工作以核对为先',
      independentSupport:a.store.get(candidate.id).state,stages};
  } finally {
    a.stop();life.abort();history.close?.();globalThis.Date=RealDate;fs.rmSync(directory,{force:true,recursive:true});
  }
}
console.log(JSON.stringify([await compare(false),await compare(true)],null,2));
