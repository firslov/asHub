import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Learning } from '../learning.mjs';
import { MemoryStore } from '../store.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-deferred-'));
  const target = {id:'a', cwd:directory};
  const config = {enabled:true, grantId:'g', modelSessionId:target.id};
  const live = new Set(['u0']);
  const api = {
    status:()=>({includeHistory:true,includedIds:[target.id]}), targets:()=>[target],
    valid:(_grant,_id,ids)=>ids.filter(id=>live.has(id)),
  };
  let store, learning;
  function restart() {
    store?.close();
    store = new MemoryStore(directory);
    learning = new Learning({
      store, dedicated:true, conversationId:()=>target.id, services:{background:api}, snapshot:()=>({projects:[]}), visible:()=>true,
    });
  }
  restart();
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  store.setState('learning', config);
  const value = {title:'回答格式', content:'默认简洁回答', kind:'preference', scope:'personal'};
  const prior = store.learn(value, {
    namespace:'assistant-v4', type:'learned', grantId:config.grantId, topic:'response-style', certainty:'explicit',
    context:{subject:'user', conversationId:target.id},
    refs:[{id:'u0', conversationId:target.id, at:1, quote:'默认简洁回答', fingerprint:'u0'}],
  });
  let slot;
  for(let i=0;i<100;i++)slot=store.add({title:'提案',content:'待确认事项 '+i,kind:'fact',scope:'personal'},{type:'model-proposal'});
  function batch(id, at, text, fields) {
    const record = {id, role:'user', text, at};
    live.add(id);
    const item = {
      ...value, scope:'personal', subject:'user', certainty:'explicit', topic:prior.source.topic, aliases:[],
      memoryId:prior.id, revision:prior.revision, relation:'contradict', evidence:[{id,quote:text}], ...fields,
    };
    return {records:[record],value:{memories:[item]}};
  }
  return {
    restart,prior,live,
    apply(...args) {
      const {records,value}=batch(...args);
      learning.applyResult(config,target,records,value,[prior],[],false,[]);
    },
    cacheReceipt(...args) {
      const {records,value}=batch(...args),scopeKey=learning.scopeKey(config,target);
      const stateKey='scan:'+target.id, start=learning.scanPosition(store.state(stateKey));
      store.setState('learning-result:'+target.id,{scopeKey,sourceIds:records.map(row=>row.id),value,existing:[prior],legacy:[],resume:{
        records, context:[], legacyOnly:false, stateKey, start, state:{scopeKey,grantId:config.grantId,cursor:records.at(-1).id},
      }});
    },
    tick:()=>learning.tick(),
    row:()=>store.get(prior.id),
    active:()=>store.activeMemories(),
    freeSlot:()=>store.forget(slot.id,slot.revision),
    flush:()=>learning.flushDeferred(config,target,new AbortController().signal),
    deferred:()=>learning.deferred(config,target),
  };
}

test('a deferred denial survives restart and later inferred corroboration while capacity is still full', t => {
  const f = fixture(t);
  f.apply('deny',2,'我已明确取消默认简洁回答的要求。');
  assert.equal(f.deferred().length,1);
  f.restart();
  assert.equal(f.flush(),0,'the protected observation pool is still full');
  f.apply('guess',3,'我觉得简洁的表达方式可能不错。',{certainty:'inferred',relation:'support'});
  assert.equal(f.row().revision,f.prior.revision,'inferred evidence cannot invalidate an explicit, pending denial');
  f.freeSlot();
  assert.equal(f.flush(),1);
  assert.equal(f.row().source.mode,'contradicted');
  assert.deepEqual(f.row().source.refs.map(ref=>ref.id),['deny']);
});

test('a newly reopened slot saves the latest checked denial first', t => {
  const f = fixture(t);
  f.apply('older',2,'我不再要求默认简洁回答。');
  f.apply('newer',3,'再次确认，我已经取消默认简洁回答的要求。');
  assert.equal(f.deferred().length,2);
  f.restart();
  f.freeSlot();
  assert.equal(f.flush(),1);
  assert.equal(f.row().source.mode,'contradicted');
  assert.deepEqual(f.row().source.refs.map(ref=>ref.id),['newer']);
  assert.equal(f.deferred().length,0);
});

test('a rewound newest denial leaves the older queued evidence eligible', t => {
  const f = fixture(t);
  f.apply('older',2,'我不再要求默认简洁回答。');
  f.apply('newer',3,'再次确认，我已经取消默认简洁回答的要求。');
  assert.equal(f.deferred().length,2);
  f.restart();
  f.live.delete('newer');
  f.freeSlot();
  assert.equal(f.flush(),1);
  assert.deepEqual(f.row().source.refs.map(ref=>ref.id),['older']);
  assert.equal(f.deferred().length,0);
});

test('a later explicit reaffirmation supersedes the denial without suppressing independently scoped memories', t => {
  const f = fixture(t);
  f.apply('deny',2,'我不再要求默认简洁回答。');
  f.apply('local',3,'这次请简洁回答。',{scope:'local',topic:'local-style',memoryId:undefined,revision:undefined,relation:undefined});
  assert(f.active().some(row=>row.id!==f.prior.id && row.scope==='conversation:a'));
  f.apply('reaffirm',4,'我撤回前面的取消，默认还是简洁回答。',{relation:'support'});
  assert.equal(f.deferred().length,0);
  f.restart();
  f.freeSlot();
  assert.equal(f.flush(),0);
  assert.equal(f.row().state,'active');
  assert.deepEqual(f.row().source.refs.map(ref=>ref.id),['u0','reaffirm']);
});

test('restart recovers a checked newer reaffirmation before replaying an earlier deferred denial', async t => {
  const f = fixture(t);
  f.apply('deny',2,'我不再要求默认简洁回答。');
  f.cacheReceipt('reaffirm',3,'我撤回前面的取消，默认还是简洁回答。',{relation:'support'});
  f.restart();
  f.freeSlot();
  await f.tick();
  assert.equal(f.row().state,'active');
  assert.deepEqual(f.row().source.refs.map(ref=>ref.id),['u0','reaffirm']);
  assert.equal(f.deferred().length,0);
});
