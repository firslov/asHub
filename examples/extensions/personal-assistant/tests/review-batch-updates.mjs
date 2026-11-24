import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Learning } from '../learning.mjs';
import { MemoryStore } from '../store.mjs';

function fixture(t, memory = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-review-batch-'));
  const store = new MemoryStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, {recursive:true, force:true}); });
  const target = {id:'a', cwd:directory};
  const config = {enabled:true, grantId:'g'};
  const api = {status:()=>({includeHistory:true}), targets:()=>[target], valid:(_grant,_id,ids)=>ids};
  store.setState('learning', config);
  const learning = new Learning({
    store, dedicated:true, services:{background:api}, snapshot:()=>({projects:[]}), visible:()=>true,
  });
  const value = {title:'回答格式', content:'默认简洁回答', kind:'preference', scope:'personal', ...memory};
  const prior = store.learn(value, {
    namespace:'assistant-v4', type:'learned', grantId:config.grantId, topic:'response-style', certainty:'explicit',
    context:{subject:'user', conversationId:target.id},
    refs:[{id:'u0', conversationId:target.id, at:1, quote:'默认简洁回答', fingerprint:'u0'}],
  });
  const item = (record, quote, fields) => ({
    ...value, subject:'user', certainty:'explicit', topic:prior.source.topic, aliases:[],
    evidence:[{id:record.id, quote}], memoryId:prior.id, revision:prior.revision, relation:'revise', ...fields,
  });
  const apply = (records, memories) => learning.applyResult(config, target, records, {memories}, [prior], [], false, []);
  return { learning, store, prior, target, item, config, apply };
}

test('a temporary qualifier surrounding an exact evidence excerpt cannot revise a permanent preference', t => {
  const f = fixture(t);
  const record = {id:'u1', role:'user', text:'本次，请用详细格式回答。', at:2};
  f.apply([record], [f.item(record, '请用详细格式回答', {content:'默认详细回答'})]);
  assert.equal(f.store.get(f.prior.id).content, f.prior.content);
  assert.equal(f.store.get(f.prior.id).revision, f.prior.revision);
});

test('a temporary instruction in a separate sentence does not scope a later permanent revision', t => {
  const f = fixture(t);
  const revision = '从今天起，默认回答请先给结论';
  const record = {id:'u1', role:'user', text:'本次，请用详细格式回答。' + revision, at:2};
  f.apply([record], [f.item(record, revision, {content:'默认回答先给结论'})]);
  assert.equal(f.store.get(f.prior.id).content, '默认回答先给结论');
});

test('an explicit reaffirmation can cancel an earlier revision within one batch', t => {
  const f = fixture(t);
  const change = {id:'u1', role:'user', text:'从今以后，默认请详细回答。', at:2};
  const reaffirm = {id:'u2', role:'user', text:'我收回刚才的变更，默认还是简洁回答。', at:2};
  f.apply([change, reaffirm], [
    f.item(change, change.text, {content:'默认详细回答'}),
    f.item(reaffirm, reaffirm.text, {relation:'support'}),
  ]);
  const saved = f.store.get(f.prior.id);
  assert.equal(saved.content, f.prior.content);
  assert.deepEqual(saved.source.refs.map(ref=>ref.id), ['u0','u2']);
});

test('the last reaffirmation in one message can cancel an earlier correction', t => {
  const f = fixture(t);
  const correction = '从今以后，默认请详细回答。';
  const reaffirmation = '刚才说错了，默认还是简洁回答。';
  const record = {id:'u1', role:'user', text:correction + reaffirmation, at:2};
  f.apply([record], [
    f.item(record, correction, {content:'默认详细回答'}),
    f.item(record, reaffirmation, {relation:'support'}),
  ]);
  const saved = f.store.get(f.prior.id);
  assert.equal(saved.content, f.prior.content);
  assert.equal(saved.source.refs.at(-1).quote, reaffirmation);
});

test('multiple corrections in one message follow the order of their evidence', t => {
  const f = fixture(t);
  const early = '从今以后，默认请详细回答。';
  const latest = '我收回这条变更，今后请先给结论。';
  const record = {id:'u1', role:'user', text:early + latest, at:2};
  f.apply([record], [
    f.item(record, early, {content:'默认详细回答'}),
    f.item(record, latest, {content:'默认先给结论'}),
  ]);
  assert.equal(f.store.get(f.prior.id).content, '默认先给结论');
});

test('an already recorded later reaffirmation still wins over an earlier correction', t => {
  const f = fixture(t);
  const change = {id:'u1', role:'user', text:'从今以后，默认请详细回答。', at:2};
  const reaffirm = {id:'u2', role:'user', text:'我收回刚才的变更，默认还是简洁回答。', at:2};
  f.apply([reaffirm], [f.item(reaffirm, reaffirm.text, {relation:'support'})]);
  const prior = f.store.get(f.prior.id);
  const revision = prior.revision;
  f.learning.applyResult(f.config, f.target, [change, reaffirm], {memories:[
    f.item(change, change.text, {revision, content:'默认详细回答'}),
    f.item(reaffirm, reaffirm.text, {revision, relation:'support'}),
  ]}, [prior], [], false, []);
  const saved = f.store.get(prior.id);
  assert.equal(saved.content, prior.content);
  assert.equal(saved.revision, revision);
});

test('an invalid latest change does not discard a valid earlier correction', t => {
  const f = fixture(t);
  const change = {id:'u1', role:'user', text:'从今以后，默认请详细回答。', at:2};
  const temporary = {id:'u2', role:'user', text:'本次我只需要表格。', at:3};
  f.apply([change, temporary], [
    f.item(temporary, temporary.text, {content:'默认用表格回答'}),
    f.item(change, change.text, {content:'默认详细回答'}),
  ]);
  assert.equal(f.store.get(f.prior.id).content, '默认详细回答');
});

test('a new denial of an already contradicted memory prevents an earlier restoration', t => {
  const f = fixture(t);
  const firstDenial = {id:'u1', role:'user', text:'我没有默认简洁回答的要求。', at:2};
  f.apply([firstDenial], [f.item(firstDenial, firstDenial.text, {relation:'contradict'})]);
  const prior = f.store.get(f.prior.id);
  assert.equal(prior.source.mode, 'contradicted');
  const earlierRevival = {id:'u2', role:'user', text:'从今以后，默认还是简洁回答。', at:3};
  const latestDenial = {id:'u3', role:'user', text:'我收回刚才的话，仍然没有默认简洁回答的要求。', at:4};
  const memories = [
    f.item(earlierRevival, earlierRevival.text, {revision:prior.revision}),
    f.item(latestDenial, latestDenial.text, {revision:prior.revision, relation:'contradict'}),
  ];
  const apply = () => f.learning.applyResult(f.config, f.target, [earlierRevival, latestDenial], {memories}, [prior], [], false, []);
  apply();
  const saved = f.store.get(prior.id);
  assert.equal(saved.source.mode, 'contradicted');
  assert.equal(saved.source.refs[0].id, latestDenial.id);
  assert.equal(f.store.activeMemories().length, 0);
  apply();
  assert.equal(f.store.get(prior.id).revision, saved.revision);
});

test('a later confirmed short denial also prevents restoration of an already contradicted fact', t => {
  const f = fixture(t, {title:'职业', content:'用户是一名教师', kind:'fact'});
  const firstDenial = {id:'u1', role:'user', text:'我已经不再是一名教师。', at:2};
  f.apply([firstDenial], [f.item(firstDenial, firstDenial.text, {relation:'contradict'})]);
  const prior = f.store.get(f.prior.id);
  assert.equal(prior.source.mode, 'contradicted');
  const earlierRevival = {id:'u2', role:'user', text:'我刚刚回到教师岗位了。', at:3};
  const question = {id:'q', role:'assistant', text:'您现在是一名教师吗？', at:4};
  const latestDenial = {id:'u3', role:'user', text:'不是', at:5, previousId:question.id};
  f.learning.applyResult(f.config, f.target, [earlierRevival, question, latestDenial], {memories:[
    f.item(earlierRevival, earlierRevival.text, {revision:prior.revision}),
    f.item(latestDenial, latestDenial.text, {revision:prior.revision, relation:'contradict'}),
  ]}, [prior], [], false, []);
  const saved = f.store.get(prior.id);
  assert.equal(saved.state, 'candidate');
  assert.equal(saved.source.mode, 'contradicted');
  assert.equal(saved.source.refs[0].id, latestDenial.id);
  assert.equal(f.store.activeMemories().length, 0);
});

test('an unaligned duplicate cannot consume the revision of a capacity-deferred denial', t => {
  const f = fixture(t);
  let candidate;
  for (let i = 0; i < 100; i++) {
    candidate = f.store.add({title:'提案', content:'待确认事项 ' + i, kind:'fact', scope:'personal'}, {type:'model-proposal'});
  }
  const historical = {id:'u1', role:'user', text:'此前我的默认习惯是简洁作答。', at:2};
  const denial = {id:'u2', role:'user', text:'不要再记默认简洁回答这个偏好。', at:3};
  const independent = {id:'u3', role:'user', text:'平时我喜欢喝绿茶。', at:4};
  const unaligned = {memoryId:undefined, revision:undefined, relation:undefined};
  f.apply([historical, denial, independent], [
    f.item(denial, denial.text, {relation:'contradict', content:'不应记住默认简洁回答'}),
    f.item(historical, historical.text, {...unaligned, topic:'other-response-style'}),
    f.item(independent, independent.text, {...unaligned, topic:'tea', title:'饮品', content:'用户喜欢绿茶'}),
  ]);
  assert.deepEqual(f.learning.deferred(f.config, f.target).map(row=>row.alignment?.relation), ['contradict']);
  assert.equal(f.store.get(f.prior.id).revision, f.prior.revision);
  assert(f.store.activeMemories().some(row=>row.content==='用户喜欢绿茶'));

  f.store.forget(candidate.id, candidate.revision);
  assert.equal(f.learning.flushDeferred(f.config, f.target, new AbortController().signal), 1);
  assert.equal(f.store.get(f.prior.id).source.mode, 'contradicted');
});
