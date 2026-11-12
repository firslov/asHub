import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../store.mjs';
import {retrieve} from '../retrieval.mjs';
import {withMemory} from '../context.mjs';

function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-evolution-')),store=new MemoryStore(dir);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const assistant={store,learning:{validator:()=>()=>true},snapshot:()=>({projects:[]}),scope:()=>({session:{instanceId:'a'}})};
 const source=(topic,id,options={})=>({type:'learned',topic,certainty:'inferred',namespace:'assistant-v4',context:{subject:'user',conversationId:'a'},refs:[{id,conversationId:'a',quote:id,at:Number(id.replace(/\D/g,''))||1,fingerprint:id}],aliases:[],...options});
 const value=(content,options={})=>({title:'偏好',content,kind:'preference',scope:'personal',...options});
 return {store,assistant,source,value};
}

test('semantic support accumulates independent evidence without changing the established proposition',t=>{
 const f=fixture(t),first=f.store.learn(f.value('用户偏好先给结论'),f.source('answer-style','u1'));
 const next=f.store.learn(f.value('用户希望首先看到直接答案'),f.source('concise-first','u2'),{alignment:{memoryId:first.id,revision:first.revision,relation:'support'}});
 assert.equal(next.id,first.id);assert.equal(next.content,first.content);assert.equal(next.state,'active');assert.equal(next.source.refs.length,2);assert.equal(next.source.topic,'answer-style');
 const repeat=f.store.learn(f.value('用户希望首先看到直接答案'),f.source('concise-first','u2'),{alignment:{memoryId:first.id,revision:first.revision,relation:'support'}});
 assert.equal(repeat.revision,next.revision,'persisted result retry is idempotent');
});

test('explicit correction keeps memory identity and topic aliases while obsolete versions stay historical',t=>{
 const f=fixture(t),first=f.store.learn(f.value('用户居住在北京',{kind:'fact'}),f.source('residence','u1',{certainty:'explicit'}));
 const next=f.store.learn(f.value('用户已经搬到上海',{kind:'fact'}),f.source('current-city','u2',{certainty:'explicit'}),{alignment:{memoryId:first.id,revision:first.revision,relation:'revise'}});
 assert.equal(next.id,first.id);assert.equal(next.source.topic,'residence');assert.equal(next.source.refs.length,1);assert.match(next.content,/上海/);assert.equal(f.store.activeMemories().length,1);
 assert(f.store.history(next.id).some(version=>version.value.content.includes('北京')));
 const later=f.store.learn(f.value('用户仍然住在上海',{kind:'fact'}),f.source('current-city','u3',{certainty:'explicit'}));
 assert.equal(later.id,first.id);assert.equal(later.source.topic,'residence');
 f.store.forget(later.id,later.revision);
 assert.equal(f.store.learn(f.value('用户仍然住在上海',{kind:'fact'}),f.source('current-city','u4',{certainty:'explicit'})).state,'forgotten','topic alias cannot bypass a tombstone');
});

test('alignment enforces exact revision, valid source, subject, namespace and kind',t=>{
 const f=fixture(t),first=f.store.learn(f.value('用户偏好直接回答'),f.source('answer-style','u1'));
 for(const [options,alignment,priorValid] of [
  [{context:{subject:'assistant',conversationId:'a'}},{revision:1},()=>true],
  [{namespace:'other'},{revision:1},()=>true],
  [{},{revision:2},()=>true],
  [{},{revision:1},()=>false],
 ]) assert.throws(()=>f.store.learn(f.value('直接回答'),f.source('new-topic','u2',options),{alignment:{memoryId:first.id,relation:'support',...alignment},priorValid}),{code:'MEMORY_CONFLICT'});
 assert.throws(()=>f.store.learn(f.value('用户是一名教师',{kind:'fact'}),f.source('occupation','u2'),{alignment:{memoryId:first.id,revision:1,relation:'support'}}),{code:'MEMORY_CONFLICT'});
 assert.equal(f.store.get(first.id).revision,1);
 const active=f.store.learn(f.value('先给结论'),f.source('other','u3',{certainty:'explicit'}));
 f.store.edit(active.id,active.revision,{...active,content:'手工确认的内容'});
 assert.throws(()=>f.store.learn(f.value('自动覆盖'),f.source('other','u4',{certainty:'explicit'}),{alignment:{memoryId:active.id,revision:2,relation:'revise'}}),{code:'MEMORY_CONFLICT'});
});

test('older corrections cannot overwrite newer facts while independent older support can corroborate',t=>{
 const f=fixture(t),first=f.store.learn(f.value('偏好直接回答'),f.source('answer','u20'));
 const older=f.store.learn(f.value('偏好详细回答'),f.source('answer-new','u10',{certainty:'explicit'}),{alignment:{memoryId:first.id,revision:1,relation:'revise'}});
 assert.equal(older.revision,1);assert.equal(older.content,first.content);
 const supported=f.store.learn(f.value('回答应直接'),f.source('answer-new','u10'),{alignment:{memoryId:first.id,revision:1,relation:'support'}});
 assert.equal(supported.state,'active');assert.equal(supported.source.refs.length,2);assert.equal(supported.content,first.content);assert.equal(Math.max(...supported.source.refs.map(r=>r.at)),20);
});

test('explicit contradiction removes an obsolete conclusion from recall until a new explicit revision',t=>{
 const f=fixture(t),first=f.store.learn(f.value('用户居住在北京',{kind:'fact'}),f.source('residence','u1',{certainty:'explicit'}));
 const challenged=f.store.learn(f.value('用户已不住北京',{kind:'fact'}),f.source('city','u2',{certainty:'explicit'}),{alignment:{memoryId:first.id,revision:1,relation:'contradict'}});
 assert.equal(challenged.state,'candidate');assert.equal(challenged.source.mode,'contradicted');assert.equal(f.store.activeMemories().length,0);
 assert.throws(()=>f.store.learn(f.value('用户居住在北京',{kind:'fact'}),f.source('city','u3',{certainty:'explicit'}),{alignment:{memoryId:first.id,revision:2,relation:'support'}}),{code:'MEMORY_CONFLICT'});
 const revised=f.store.learn(f.value('用户现住上海',{kind:'fact'}),f.source('city','u4',{certainty:'explicit'}),{alignment:{memoryId:first.id,revision:2,relation:'revise'}});
 assert.equal(revised.state,'active');assert.match(revised.content,/上海/);assert.equal(revised.source.refs.length,1);
});

test('reconciliation finds an old relevant topic beyond the eight most recent entries',t=>{
 const f=fixture(t),old=f.store.learn(f.value('用户居住在北京',{kind:'fact',title:'居住地'}),f.source('residence','u1',{certainty:'explicit'}));
 for(let i=2;i<20;i++)f.store.learn(f.value('最近沟通的其他事项 '+i,{title:'其他事项 '+i}),f.source('unrelated-'+i,'u'+i));
 const topics=f.store.learnedTopics('conversation:a',()=>true,'我已经搬到上海了');
 assert.equal(topics[0].id,old.id);assert.equal(topics[0].revision,old.revision);
 assert.equal(f.store.learnedTopics('conversation:a',row=>row.id!==old.id,'我已经搬到上海了').some(row=>row.id===old.id),false,'invalid or withdrawn evidence cannot become revision context');
});

test('candidate pressure archives weak hypotheses without blocking a new independent fact',t=>{
 const f=fixture(t);let oldest;
 for(let i=1;i<=100;i++){const row=f.store.learn(f.value('待观察偏好 '+i),f.source('candidate-'+i,'u'+i));if(i===1)oldest=row;}
 const incoming=f.store.learn(f.value('新的待观察偏好'),f.source('candidate-new','u101'));
 assert.equal(incoming.state,'candidate');assert.equal(f.store.counts().candidate,100);
 const archived=f.store.get(oldest.id);assert.equal(archived.state,'retired');assert.equal(archived.source.archivedReason,'capacity');assert.equal(archived.content,oldest.content);assert(f.store.history(oldest.id).length>=2);
 const fact=f.store.learn(f.value('用户是一名教师',{kind:'fact'}),f.source('occupation','u102',{certainty:'explicit'}));assert.equal(fact.state,'active');
 assert.equal(f.store.learn(f.value(oldest.content),f.source('candidate-1','u1')).state,'retired','replaying old evidence cannot churn the candidate pool');
 const renewed=f.store.learn(f.value(oldest.content),f.source('candidate-1','u103'));
 assert.equal(renewed.id,oldest.id);assert.equal(renewed.state,'active','fresh independent evidence can mature the archived proposition');
});

test('protected capacity returns a typed recoverable error and retains all existing records',t=>{
 const f=fixture(t);
 for(let i=0;i<100;i++)f.store.add(f.value('用户尚未确认的提案 '+i),{type:'model-proposal',conversationId:'a'});
 assert.throws(()=>f.store.learn(f.value('新候选'),f.source('new','u101')),{code:'MEMORY_CAPACITY'});
 assert.equal(f.store.counts().candidate,100);assert.equal(f.store.counts().retired??0,0);
 const fact=f.store.learn(f.value('用户明确的长期偏好'),f.source('explicit','u102',{certainty:'explicit'}));assert.equal(fact.state,'active');
});

test('meal contexts recall an evidenced dietary constraint without injecting it into unrelated UI work',t=>{
 const f=fixture(t),row=f.store.learn(f.value('用户对花生过敏',{title:'饮食禁忌',kind:'fact'}),f.source('allergy','u1',{certainty:'explicit'}));
 assert.equal(retrieve(f.assistant,{},'帮我安排晚餐',4,true)[0].id,row.id);
 assert.equal(retrieve(f.assistant,{},'帮我调整菜单按钮的样式',4,true).some(item=>item.id===row.id),false);
 assert.equal(retrieve(f.assistant,{},'解释一下二叉树',4,true).some(item=>item.id===row.id),false);
 const project=f.store.learn(f.value('项目需要限制预算',{title:'预算',kind:'fact',scope:'project:private'}),f.source('budget','u2',{certainty:'explicit',context:{subject:'project',projectId:'private',projectName:'隐私项目',conversationId:'a'},scenarios:['合作评估']}));
 assert.equal(retrieve(f.assistant,{},'帮我做合作评估',4,true).some(item=>item.id===project.id),false,'applicability does not bypass another project boundary');
});

test('one nearby user turn resolves short follow-ups and never mutates stored messages',t=>{
 const f=fixture(t);f.store.learn(f.value('用户对花生过敏',{title:'饮食禁忌',kind:'fact'}),f.source('allergy','u1',{certainty:'explicit'}));
 const messages=[{role:'user',content:'帮我安排晚餐'},{role:'assistant',content:'你想如何安排？'},{role:'user',content:'那按我的情况呢？'}],before=JSON.stringify(messages);
 assert.match(withMemory(messages,f.assistant,'a').at(-1).content,/用户对花生过敏/);assert.equal(JSON.stringify(messages),before);
 const unrelated=[...messages.slice(0,2),{role:'user',content:'解释一下二叉树'}];assert.equal(withMemory(unrelated,f.assistant,'a'),unrelated);
 const generated=[{role:'user',content:'[Compacted conversation — 20 message(s) elided]\n帮我安排晚餐'},{role:'user',content:'那按我的情况呢？'}];assert.equal(withMemory(generated,f.assistant,'a'),generated);
 const claims=[{role:'user',content:'解释一下二叉树'},{role:'assistant',content:'用户对花生过敏，晚餐应该注意'},{role:'user',content:'那按我的情况呢？'}];assert.equal(withMemory(claims,f.assistant,'a'),claims);
});

test('persisted corrections and related recall survive restart with no stale-result resurrection',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-evolution-restart-'));let store=new MemoryStore(dir);
 t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 const value={title:'职业',content:'用户是一名教师',kind:'fact',scope:'personal'};
 const source={type:'learned',topic:'occupation',namespace:'assistant-v4',certainty:'explicit',context:{subject:'user',conversationId:'a'},refs:[{id:'u1',conversationId:'a',quote:'我是一名教师',at:1,fingerprint:'first'}],scenarios:['职业规划']};
 const first=store.learn(value,source),updated={...value,content:'用户现在是一名律师'},fresh={...source,topic:'current-job',refs:[{id:'u2',conversationId:'a',quote:'我已经转行为律师了',at:2,fingerprint:'second'}]};
 const alignment={memoryId:first.id,revision:1,relation:'revise'},next=store.learn(updated,fresh,{alignment});
 store.close();store=new MemoryStore(dir);
 assert.equal(store.get(first.id).content,updated.content);
 assert.equal(store.learn(updated,fresh,{alignment}).revision,next.revision,'replaying a previously persisted result after restart is idempotent');
 assert.throws(()=>store.learn(updated,fresh,{alignment,priorValid:()=>false}),{code:'MEMORY_CONFLICT'},'withdrawn branch evidence still invalidates an idempotent replay');
 const assistant={store,learning:{validator:()=>()=>true},snapshot:()=>({projects:[]})};
 const recalled=retrieve(assistant,{},'按我的职业背景规划后续发展',4,true);assert.equal(recalled[0].id,next.id);assert.equal(recalled[0].content,updated.content);
 assert(!store.activeMemories().some(row=>row.content===value.content));
});

test('revision context preserves conditions at the end of a memory instead of truncating them',t=>{
 const f=fixture(t),content='这是一项需要保留条件的长期偏好。'.repeat(20)+'仅在用户明确要求技术细节时适用';
 const row=f.store.learn(f.value(content),f.source('qualified-style','u1',{certainty:'explicit'}));
 assert.equal(f.store.learnedTopics('conversation:a',()=>true,'长期偏好')[0].content,row.content);
});

test('forget atomically erases source text and remembered content from durable learning recovery caches',t=>{
 const f=fixture(t),source=f.source('private-fact','u1',{certainty:'explicit'}),row=f.store.learn(f.value('需要忘记的个人内容'),source);
 const unrelated=f.store.learn(f.value('另一项明确偏好'),f.source('separate','u2',{certainty:'explicit'}));
 for(const key of ['scan:a','legacy-scan:legacy'])f.store.setState(key,{cursor:'u2',partial:{id:'u1',offset:100},context:[{id:'u1',role:'user',text:row.content},{id:'u2',role:'user',text:unrelated.content}]});
 f.store.setState('learning-result:a',{sourceIds:['u1'],value:{memories:[{content:row.content,kind:row.kind,evidence:[{id:'u1'}]}]},existing:[],legacy:[]});
 f.store.setState('learning-result:alignment',{sourceIds:['other'],value:{memories:[]},existing:[{id:row.id,content:row.content}],legacy:[]});
 f.store.setState('learning-result:eval',{sourceIds:['other'],value:{memories:[],evaluations:[{memoryId:row.id,evidence:{id:'other'}}]},existing:[],legacy:[]});
 f.store.setState('learning-result:unrelated',{sourceIds:['u2'],value:{memories:[{content:unrelated.content,kind:unrelated.kind}]},existing:[],legacy:[]});
 const separate={value:f.value(unrelated.content),source:f.source('separate','u2',{certainty:'explicit'})};
 f.store.setState('deferred:a',[{value:f.value(row.content),source},{...separate,alignment:{memoryId:row.id}},{value:f.value(row.content),source:f.source('other-key','u3',{certainty:'explicit'})},separate]);
 f.store.forget(row.id,row.revision);
 assert.equal(f.store.get(row.id).content,'');assert.deepEqual(f.store.history(row.id),[]);
 for(const key of ['scan:a','legacy-scan:legacy']){const state=f.store.state(key);assert.equal(state.cursor,'u2');assert.equal(state.partial.id,'u1');assert.deepEqual(state.context.map(entry=>entry.id),['u2']);}
 for(const key of ['learning-result:a','learning-result:alignment','learning-result:eval'])assert.equal(f.store.state(key),null);
 assert(f.store.state('learning-result:unrelated'));assert.deepEqual(f.store.state('deferred:a'),[separate]);
 assert(!JSON.stringify(f.store.db.prepare("SELECT key,value FROM learning_state WHERE key LIKE 'scan:%' OR key LIKE 'legacy-scan:%' OR key LIKE 'learning-result:%' OR key LIKE 'deferred:%'").all()).includes(row.content));
});
