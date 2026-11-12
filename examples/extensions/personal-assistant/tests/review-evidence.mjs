import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Assistant } from '../shared.mjs';

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-feedback-evidence-')),records=[];
  const target={id:'a',instanceId:'a',cwd:dir,projectId:null,title:'助手',kind:'agent',busy:false};
  const api={
    status:()=>({includedIds:['a'],excludedIds:[],includeHistory:true,since:0}),
    targets:()=>[{...target}],
    valid:(g,id,ids)=>ids.filter(id=>records.some(row=>row.id===id)),
    latestUser:()=>records.filter(row=>row.role==='user').at(-1)?.id,
    search:(g,id,query)=>records.filter(row=>row.text.includes(query)),
    entry:(g,id,source,offset=0)=>{const row=records.find(row=>row.id===source);if(!row)throw Error('History source unavailable');return {...row,text:row.text.slice(offset),offset,more:false};},
    revoke:()=>{},
  };
  const services={dataDirectory:dir,background:api,conversations:{get:()=>target.id},host:{snapshot:()=>({sessions:[target],projects:[]})}};
  let a=new Assistant(services);
  a.store.setState('learning',{enabled:true,grantId:'g',modelSessionId:'a',includedIds:['a'],excludedIds:[],includeHistory:true});
  t.after(()=>{a.stop();fs.rmSync(dir,{recursive:true,force:true});});
  return {get a(){return a;},records,
    add(text){const row={id:'u'+(records.length+1),role:'user',text,at:records.length+1};records.push(row);return row;},
    restart(){a.stop();a=new Assistant(services);},
  };
}
const ref=row=>({id:row.id,conversationId:'a',quote:row.text,at:row.at,fingerprint:row.id});
const source=(row,topic='reporting')=>({type:'learned',namespace:'assistant-v4',topic,certainty:'explicit',grantId:'g',context:{subject:'user',conversationId:'a'},refs:[ref(row)]});
const value={title:'汇报经验',content:'向导师汇报时先给结论有助于沟通',kind:'procedure',scope:'personal'};

test('forgetting a feedback-qualified strategy removes every evidence path after restart',t=>{
  const f=fixture(t),formation=f.add('我想尝试向导师汇报时先给结论');
  let row=f.a.store.learn(value,source(formation));
  const first=f.add('按约定向导师先汇报结论，第一次沟通效果很好');
  const second=f.add('再次向导师先汇报结论，沟通仍然很顺畅');
  for(const feedback of [first,second])f.a.store.evaluate(row.id,'support',ref(feedback));
  row=f.a.store.get(row.id);assert.equal(row.state,'active');assert.equal(row.source.mode,'feedback-supported');
  assert.equal(f.a.search('a','汇报')[0]?.id,row.id);
  const separate=f.add('我喜欢深海蓝色的界面');
  const unrelated=f.a.store.learn({title:'颜色偏好',content:'用户喜欢深海蓝色的界面',kind:'preference',scope:'personal'},source(separate,'color'));
  for(const key of ['scan:a','legacy-scan:old'])f.a.store.setState(key,{cursor:separate.id,context:[first,separate]});
  const receipt={sourceIds:[first.id],existing:[],legacy:[],value:{memories:[{title:'沟通习惯',content:'先总结有助于和导师沟通',kind:'preference',evidence:[{id:first.id,quote:first.text}]}]}};
  f.a.store.setState('learning-result:a',receipt);
  const unrelatedReceipt={sourceIds:[separate.id],existing:[],legacy:[],value:{memories:[]}};
  f.a.store.setState('learning-result:unrelated',unrelatedReceipt);
  const keep={value:{title:unrelated.title,content:unrelated.content,kind:unrelated.kind,scope:unrelated.scope},source:source(separate,'color')};
  f.a.store.setState('deferred:a',[{value:{...value,content:'汇报时先总结能促进讨论'},source:source(second,'reporting-paraphrase')},keep]);
  f.restart();const command='请忘记汇报经验';f.add(command);
  assert.deepEqual(f.a.forgetFromChat('a',{id:row.id,revision:row.revision,quote:command}),{forgotten:true});
  assert.deepEqual(new Set(f.a.store.state('ignored:a')),new Set([formation.id,first.id,second.id]));
  assert.deepEqual(f.a.historySearch('a','导师'),[],'forgotten feedback cannot return through original-history fallback');
  assert.throws(()=>f.a.historyRead('a',first.id),/不再用于记忆/);
  assert.deepEqual(f.a.search('a','汇报'),[]);assert.equal(f.a.read('a',unrelated.id).content,unrelated.content);
  for(const key of ['scan:a','legacy-scan:old'])assert.deepEqual(f.a.store.state(key).context.map(record=>record.id),[separate.id]);
  assert.equal(f.a.store.state('learning-result:a'),null);
  assert.deepEqual(f.a.store.state('learning-result:unrelated'),unrelatedReceipt);
  assert.deepEqual(f.a.store.state('deferred:a'),[keep]);
  assert.equal(f.a.store.get(row.id).content,'');assert.deepEqual(f.a.store.history(row.id),[]);
});

test('feedback IDs survive bounded feedback/version histories and manual correction until forgotten',t=>{
  const f=fixture(t),formation=f.add('我准备采用先结论后依据的汇报方式');
  let row=f.a.store.learn(value,source(formation));const evidence=[formation];
  for(let n=1;n<=35;n++){
    const feedback=f.add('第'+n+'次应用汇报经验后沟通顺畅');evidence.push(feedback);
    f.a.store.evaluate(row.id,'support',ref(feedback));
  }
  row=f.a.store.get(row.id);assert.equal(row.source.feedback.length,20);assert.equal(f.a.store.history(row.id).length,10);
  assert(!JSON.stringify(f.a.store.history(row.id)).includes(evidence[1].text),'the oldest feedback body is not retained beyond bounded history');
  for(let n=1;n<=12;n++)row=f.a.store.edit(row.id,row.revision,{...value,title:'汇报经验 '+n});
  assert(row.source.originRefs.every(item=>Object.keys(item).sort().join(',')==='conversationId,id'));
  f.restart();f.a.store.forget(row.id,row.revision);
  assert.deepEqual(new Set(f.a.store.state('ignored:a')),new Set(evidence.map(item=>item.id)));
  assert.deepEqual(f.a.historySearch('a','应用汇报经验'),[]);
});
