import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../store.mjs';
import { Learning } from '../learning.mjs';

const value = n => ({ title:'当前岗位', content:'用户当前岗位为岗位 ' + n, kind:'fact', scope:'personal' });
const source = n => ({ type:'learned', namespace:'assistant-v4', topic:'occupation', certainty:'explicit',
  context:{subject:'user',conversationId:'assistant'}, refs:[{id:'u'+n,conversationId:'assistant',quote:'我当前的岗位是岗位 '+n,at:n,fingerprint:'u'+n}] });
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-correction-review-'));
  let store=new MemoryStore(dir);
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {get store(){return store;},restart(){store.close();store=new MemoryStore(dir);}};
}

for(const relation of ['revise','contradict']) test(`forgetting after repeated ${relation} and restart also erases the oldest sources and recovery copies`,t=>{
  const f=fixture(t);let row=f.store.learn(value(1),source(1));
  for(let n=2;n<=13;n++) {
    row=f.store.learn(value(n),source(n),{alignment:{memoryId:row.id,revision:row.revision,relation:relation === 'contradict' && n % 2 === 1 ? 'revise' : relation}});
  }
  assert.equal(f.store.history(row.id).length,10,'full memory versions stay bounded');
  assert.deepEqual(row.source.refs.map(ref=>ref.id),['u13'],'old sources cannot corroborate or date the corrected proposition');
  assert(row.source.originRefs.every(ref=>Object.keys(ref).sort().join(',')==='conversationId,id'),'retained provenance contains no old quotes or memory text');
  assert(!f.store.history(row.id).some(version=>JSON.stringify(version.value).includes(JSON.stringify(source(1).refs[0].quote))),'source ID retention must not extend old quote retention');
  const other=f.store.learn({...value('other'),title:'其他事实'},{...source(99),topic:'other-fact'});
  f.store.setState('scan:assistant',{cursor:'u99',context:[{id:'u1',role:'user',text:'我当前的岗位是岗位 1'},{id:'u99',role:'user',text:other.content}]});
  f.store.setState('learning-result:assistant',{sourceIds:['u1'],existing:[],legacy:[],value:{memories:[{...value(1),topic:'original-position',evidence:[{id:'u1',quote:'我当前的岗位是岗位 1'}]}]},resume:{stateKey:'scan:assistant',records:[{id:'u1',role:'user',text:source(1).refs[0].quote}],context:[],state:{context:[{id:'u1',role:'user',text:source(1).refs[0].quote}]}}});
  const unrelated={value:{...value('other'),title:'其他事实'},source:{...source(99),topic:'other-fact'}};
  f.store.setState('deferred:assistant',[{value:value(1),source:source(1)},unrelated]);
  f.restart();
  f.store.forget(row.id,row.revision);
  const ignored=new Set(f.store.state('ignored:assistant'));
  for(let n=1;n<=13;n++)assert(ignored.has('u'+n),'earlier source u'+n+' must stay excluded after version history rolls over');
  assert.equal(f.store.state('learning-result:assistant'),null,'old pending inference must not revive forgotten source content');
  assert.deepEqual(f.store.state('scan:assistant').context.map(entry=>entry.id),['u99']);
  assert.deepEqual(f.store.state('deferred:assistant'),[unrelated]);
  assert.equal(f.store.get(row.id).content,'');assert.deepEqual(f.store.history(row.id),[]);
  assert.equal(f.store.get(other.id).state,'active');
});

test('candidate archival, restoration and a manual correction retain enough provenance for complete forgetting',t=>{
  const f=fixture(t);let row;
  for(let n=1;n<=12;n++)row=f.store.learn(value(n),{...source(n),certainty:'inferred'});
  for(let n=100;n<200;n++)f.store.learn(value(n),{...source(n),topic:'other-'+n,certainty:'inferred'});
  assert.equal(f.store.get(row.id).state,'retired');
  row=f.store.learn(value(13),source(13));
  assert.equal(row.state,'active');
  for(let n=1;n<=12;n++)row=f.store.edit(row.id,row.revision,{...row,title:'用户确认的岗位 '+n});
  assert.equal(f.store.history(row.id).length,10);
  f.restart();f.store.forget(row.id,row.revision);
  const ignored=new Set(f.store.state('ignored:assistant'));
  for(let n=1;n<=13;n++)assert(ignored.has('u'+n),'original source u'+n+' survives archival and manual version rollover');
  assert(!ignored.has('u100'),'forgetting remains limited to this memory’s sources');
  assert.deepEqual(f.store.get(row.id).source,{});assert.deepEqual(f.store.history(row.id),[]);
});

test('recovery cannot use forgotten existing or legacy references, even with otherwise fresh valid evidence',t=>{
  const f=fixture(t),target={id:'assistant',cwd:'/mock-assistant',projectId:null};
  const records=[{id:'u90',role:'user',text:'我已经改行做设计师了',at:90}];
  const api={status:()=>({includedIds:[target.id],excludedIds:[],includeHistory:true}),targets:()=>[target],valid:(g,id,ids)=>ids.filter(id=>records.some(row=>row.id===id))};
  const assistant={store:f.store,services:{background:api},snapshot:()=>({projects:[]}),visible:()=>true,dedicated:true};
  const learning=new Learning(assistant),c={enabled:true,grantId:'g',includedIds:[target.id]};f.store.setState('learning',c);
  const old=f.store.learn(value(1),source(1));
  const legacy=f.store.add({...value(2),title:'旧提案'},{type:'model-proposal',conversationId:target.id});
  const scopeKey=learning.scopeKey(c,target),oldState={scopeKey,cursor:'u1',partial:null};f.store.setState('scan:assistant',oldState);
  const base={...value(90),subject:'user',certainty:'explicit',topic:'occupation',aliases:[],evidence:[{id:'u90',quote:records[0].text}]};
  const result={memories:[{...base,memoryId:old.id,revision:old.revision,relation:'revise'},{...base,legacyId:legacy.id,topic:'legacy-occupation'}]};
  const resume={start:learning.scanPosition(oldState),stateKey:'scan:assistant',state:{scopeKey,cursor:'u90',context:records},records,context:[],legacyOnly:false};
  f.store.setState('learning-result:assistant',{scopeKey,sourceIds:['u90'],existing:[old],legacy:[legacy],value:result,resume});
  f.store.forget(old.id,old.revision);f.store.forget(legacy.id,legacy.revision);
  assert.equal(f.store.state('learning-result:assistant'),null,'forget also removes receipts that only reference the old memory as reconciliation context');
  assert.equal(learning.recoverResult(c,target,new AbortController().signal),false);
  assert.equal(f.store.state('scan:assistant').cursor,'u1','discarding a receipt cannot consume new evidence');
  // The same result may already be held in a running call when forgetting ends.
  learning.applyResult(c,target,records,result,[old],[legacy],false,[]);
  assert.equal(f.store.activeMemories().length,0);
  assert.equal(f.store.get(old.id).state,'forgotten');assert.equal(f.store.get(legacy.id).state,'forgotten');
});
