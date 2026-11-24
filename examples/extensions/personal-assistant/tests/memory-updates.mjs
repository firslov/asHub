import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../store.mjs';
import { Learning } from '../learning.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-memory-updates-'));
  let store = new MemoryStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive:true, force:true }); });
  return {
    get store() { return store; },
    restart() { store.close(); store = new MemoryStore(directory); },
    value(content, options = {}) { return { kind:'preference', scope:'personal', title:'交流偏好', content, ...options }; },
    source(topic, at, quote, options = {}) {
      return {
        type:'learned', namespace:'assistant-v4', context:{subject:'user', conversationId:'a'},
        topic, certainty:'explicit', grantId:'g',
        refs:[{id:'u'+at, conversationId:'a', at, quote, fingerprint:quote}],
        ...options,
      };
    },
  };
}

test('an unaligned topic collision preserves the old claim and keeps independent evidence pending', t => {
  const f = fixture(t);
  const first = f.store.learn(f.value('用户喜欢咖啡'), f.source('drinks', 1, '我喜欢咖啡'));
  const input = f.value('用户也喜欢乌龙茶', {title:'乌龙茶'});
  const second = f.store.learn(input, f.source('drinks', 2, '我也喜欢乌龙茶'));
  assert.notEqual(second.id, first.id);
  assert.equal(second.state, 'candidate');
  f.restart();
  const next = f.store.learn(input, f.source('tea', 3, '平时我也会喝乌龙茶'));
  assert.equal(next.id, second.id);
  assert.equal(next.state, 'candidate', 'repetition alone does not resolve a topic collision');
  assert.deepEqual(next.source.refs.map(ref => ref.id), ['u2', 'u3']);
  assert.deepEqual(f.store.activeMemories().map(({id, revision, content}) => [id, revision, content]), [[first.id, 1, first.content]]);
});

test('exact claims are corroborated across topic names without crossing applicability or erasing provenance', t => {
  const f = fixture(t);
  const first = f.store.learn(f.value('用户喜欢咖啡。'), f.source('coffee', 1, '我一直喜欢喝咖啡'));
  const second = f.store.learn(f.value('用户喜欢咖啡', {title:'饮品选择'}),
    f.source('morning-drink', 2, '咖啡是我平时喜欢的饮品', {aliases:['日常饮品']}));
  assert.equal(second.id, first.id);
  assert.equal(second.title, first.title);
  assert.equal(second.content, first.content);
  assert.deepEqual(second.source.refs.map(ref => ref.id), ['u1','u2']);
  assert.deepEqual(second.source.aliases, ['日常饮品']);
  const local = f.store.learn(f.value('用户喜欢咖啡', {scope:'conversation:a'}),
    f.source('coffee', 3, '这次请选咖啡'));
  assert.notEqual(local.id, first.id);
  assert.equal(f.store.get(first.id).scope, 'personal');
  assert.deepEqual(f.store.get(first.id).source.refs.map(ref => ref.id), ['u1','u2']);
  f.store.forget(first.id, second.revision);
  f.restart();
  assert.equal(f.store.learn(f.value('用户喜欢咖啡'), f.source('alternate-drink', 4, '用户过去喜欢咖啡')).state, 'forgotten');
  assert.deepEqual(f.store.state('ignored:a'), ['u1','u2']);
});

test('a temporary instruction cannot revise, deny, or corroborate an established preference', t => {
  const f = fixture(t);
  const first = f.store.learn(f.value('默认简洁回答'), f.source('answer-style', 1, '以后请简洁回答'));
  const local = f.value('本次需要详细回答', {scope:'conversation:a'});
  for (const relation of ['support', 'revise', 'contradict']) {
    assert.throws(() => f.store.learn(local, f.source('answer-style', 2, '这次请详细回答'), {
      alignment:{memoryId:first.id, revision:first.revision, relation},
    }), {code:'MEMORY_CONFLICT'});
  }
  const corrected = f.store.learn(f.value('默认详细回答'), f.source('answer-style', 3, '今后默认详细回答'), {
    alignment:{memoryId:first.id, revision:first.revision, relation:'revise'},
  });
  assert.equal(corrected.id, first.id);
  assert.equal(corrected.content, '默认详细回答');
  assert.deepEqual(corrected.source.originRefs.map(ref => ref.id).sort(), ['u1','u3']);
  assert.equal(f.store.learn(f.value(first.content), f.source('answer-style', 1, '以后请简洁回答')).id, first.id);
});

test('forgetting same-text local evidence leaves the independent personal record available after restart', t => {
  const f = fixture(t);
  const personal = f.store.learn(f.value('用户喜欢咖啡'), f.source('coffee', 1, '我喜欢咖啡'));
  const local = f.store.learn(f.value(personal.content, {scope:'conversation:a'}), f.source('coffee', 2, '本次请选咖啡'));
  f.store.forget(local.id, local.revision);
  f.restart();
  assert.equal(f.store.forgottenCopy(f.store.get(personal.id)), undefined);
  assert.equal(f.store.learn(f.value(personal.content, {scope:'conversation:a'}),
    f.source('renamed-coffee', 3, '这次还是选咖啡')).state, 'forgotten');
  assert.deepEqual(f.store.state('ignored:a'), ['u2']);
});

test('an exact alias is saved on an idempotent write, and revising a contender does not promote a competing claim', t => {
  const f = fixture(t);
  const first = f.store.learn(f.value('用户喜欢咖啡'), f.source('coffee', 1, '我喜欢咖啡'));
  const repeat = f.store.learn(f.value(first.content), f.source('morning-drink', 1, '我喜欢咖啡'));
  assert.equal(repeat.revision, first.revision);
  const prior = f.store.learn(f.value('用户喜欢豆浆'), f.source('morning-drink', 2, '我也喜欢豆浆'));
  assert.equal(prior.state, 'candidate');
  const next = f.store.learn(f.value('用户喜欢豆奶'), f.source('morning-drink', 3, '更准确地说，我喜欢豆奶'), {
    alignment:{memoryId:prior.id, revision:prior.revision, relation:'revise'},
  });
  assert.equal(next.id, prior.id);
  assert.equal(next.state, 'candidate');
  assert.equal(next.content, '用户喜欢豆奶');
  const denied = f.store.learn(f.value('用户没有说喜欢豆奶'), f.source('coffee', 4, '我的意思不是我喜欢豆奶'), {
    alignment:{memoryId:next.id, revision:next.revision, relation:'contradict'},
  });
  const afterDenial = f.store.learn(f.value('用户喜欢酸奶'), f.source('coffee', 5, '我实际说的是我喜欢酸奶'), {
    alignment:{memoryId:denied.id, revision:denied.revision, relation:'revise'},
  });
  assert.equal(afterDenial.state, 'candidate');
  assert.deepEqual(f.store.activeMemories().map(row => row.id), [first.id]);
});

test('a forgotten topic cannot be used to reinforce a different record with identical incoming text', t => {
  const f = fixture(t);
  const old = f.store.learn(f.value('用户住在南京', {kind:'fact'}), f.source('city', 1, '我住在南京'));
  const otherValue = f.value('南京是用户的居住地', {kind:'fact'});
  const other = f.store.learn(otherValue, f.source('residence', 2, '我的居住地是南京'));
  f.store.forget(old.id, old.revision);
  assert.equal(f.store.learn(otherValue, f.source('city', 3, '南京依然是我的居住地')).state, 'forgotten');
  assert.deepEqual(f.store.get(other.id).source.refs.map(ref=>ref.id), ['u2']);
});

test('rewound evidence can be replaced by explicit proof from the remaining branch', t => {
  const f = fixture(t);
  const first = f.store.learn(f.value('用户喜欢咖啡'), f.source('favorite-drink', 20, '我喜欢咖啡'));
  const next = f.store.learn(f.value('用户喜欢绿茶'), f.source('favorite-drink', 10, '我喜欢绿茶'), {priorValid:()=>false});
  assert.equal(next.id, first.id);
  assert.equal(next.state, 'active');
  assert.equal(next.content, '用户喜欢绿茶');
  assert.deepEqual(next.source.refs.map(ref => ref.id), ['u10']);
});

test('a permanent denial still retracts an inferred personal claim originally stored as local', t => {
  const f = fixture(t);
  const value = f.value('用户住在北京', {kind:'fact', scope:'conversation:a'});
  const first = f.store.learn(value, f.source('city', 1, '下班后我回北京', {certainty:'inferred'}));
  const active = f.store.learn(value, f.source('city', 2, '北京是我常住的地方', {certainty:'inferred'}));
  assert.equal(active.id, first.id);
  assert.equal(active.state, 'active');
  const next = f.store.learn({...value, scope:'personal', content:'用户不住在北京'}, f.source('city', 3, '我没有住在北京'), {
    alignment:{memoryId:active.id, revision:active.revision, relation:'contradict'},
  });
  assert.equal(next.scope, active.scope);
  assert.equal(next.source.mode, 'contradicted');
  assert.equal(f.store.activeMemories().length, 0);
});

test('trailing punctuation that changes the claim cannot be deduplicated or forgotten together', t => {
  const f = fixture(t);
  const bang = f.store.learn(f.value('提示符以 ! 结尾时保留 !'), f.source('prompt-bang', 1, '我会输入 !'));
  const question = f.store.learn(f.value('提示符以 ! 结尾时保留 ?'), f.source('prompt-question', 2, '这里应输出 ?'));
  assert.notEqual(question.id, bang.id);
  f.store.forget(bang.id, bang.revision);
  f.restart();
  assert.equal(f.store.forgottenCopy(f.store.get(question.id)), undefined);
  assert.equal(f.store.learn(f.value(bang.content), f.source('another-topic', 3, '我会输入 !')).state, 'forgotten');
});

test('a correction to an already established exact claim withdraws the obsolete memory without duplicating the replacement', t => {
  const f = fixture(t);
  const old = f.store.learn(f.value('用户是教师', {kind:'fact'}), f.source('former-job', 1, '我原来是教师'));
  const known = f.store.learn(f.value('用户是工程师', {kind:'fact'}), f.source('profession', 2, '我从事工程工作'));
  const replacement = f.value(known.content, {kind:'fact'});
  const proof = f.source('profession', 3, '我已经转职，现任工程师');
  const alignment = {memoryId:old.id, revision:old.revision, relation:'revise'};
  const next = f.store.learn(replacement, proof, {alignment});
  assert.equal(next.id, old.id);
  assert.equal(next.source.mode, 'contradicted');
  assert.deepEqual(f.store.activeMemories().map(row=>row.id), [known.id]);
  assert(f.store.history(old.id).some(version=>version.value.content===old.content));
  f.restart();
  assert.equal(f.store.learn(replacement, proof, {alignment}).revision, next.revision);
  f.store.forget(known.id, known.revision);
  assert.deepEqual(f.store.activeMemories(), []);
});

test('confirming the same-topic candidate removes the obsolete conclusion without creating a second copy', t => {
  const f = fixture(t);
  const old = f.store.learn(f.value('用户是教师', {kind:'fact'}), f.source('profession', 1, '我原来是教师'));
  const value = f.value('用户是工程师', {kind:'fact'});
  const contender = f.store.learn(value, f.source('profession', 2, '我考虑转职工程师'));
  assert.equal(contender.state, 'candidate');
  // The candidate pool has no free slot, but the two records can swap states.
  for (let i = 0; i < 99; i++) f.store.add(f.value('待核实 ' + i), {type:'model-proposal'});
  const proof = f.source('profession', 3, '更正，我现在确实是工程师');
  const alignment = {memoryId:old.id, revision:old.revision, relation:'revise'};
  f.store.learn(value, proof, {alignment});
  assert.equal(f.store.get(old.id).source.mode, 'contradicted');
  assert.deepEqual(f.store.memoryTargets().filter(row=>row.content===value.content).map(row=>[row.id,row.state]), [[contender.id,'active']]);
  assert.deepEqual(f.store.get(contender.id).source.refs.map(ref=>ref.id), ['u3']);
  const savedRevision = f.store.get(contender.id).revision;
  f.restart();
  f.store.learn(value, proof, {alignment});
  assert.equal(f.store.get(contender.id).revision, savedRevision);
  f.store.forget(contender.id, savedRevision);
  f.restart();
  assert.equal(f.store.learn(value, f.source('renamed-profession', 4, '我现在是工程师')).state, 'forgotten');
  assert.equal(f.store.activeMemories().length, 0);
});

test('a batch applies the latest explicit correction before older corrections or support', t => {
  const f = fixture(t);
  const first = f.store.learn(f.value('用户喜欢咖啡'), f.source('favorite-drink', 1, '我喜欢咖啡'));
  const target = {id:'a', cwd:'/mock-assistant'};
  const records = [
    {id:'u2', role:'user', at:2, text:'我以前确实喜欢咖啡'},
    {id:'u3', role:'user', at:3, text:'我现在改为喜欢乌龙茶'},
    {id:'u4', role:'user', at:3, text:'刚才说错了，从今天起我的默认饮品是绿茶'},
  ];
  const background = {
    status:()=>({includeHistory:true}), targets:()=>[target],
    valid:(_grant, _id, ids)=>ids.filter(id=>id==='u1'||records.some(record=>record.id===id)),
  };
  const config = {enabled:true, grantId:'g'};
  f.store.setState('learning', config);
  const learning = new Learning({store:f.store, services:{background}, dedicated:true,
    snapshot:()=>({projects:[]}), visible:()=>true});
  const item = (index, relation, content) => ({
    ...f.value(content), topic:'favorite-drink', subject:'user', certainty:'explicit', aliases:[],
    memoryId:first.id, revision:first.revision, relation,
    evidence:[{id:records[index].id, quote:records[index].text}],
  });
  const value = {memories:[
    item(0, 'support', '用户喜欢咖啡'),
    item(1, 'revise', '用户喜欢乌龙茶'),
    item(2, 'revise', '用户喜欢绿茶'),
  ]};
  learning.applyResult(config, target, records, value, [first], [], false, []);
  const corrected = f.store.get(first.id);
  assert.equal(corrected.content, '用户喜欢绿茶');
  assert.equal(corrected.revision, first.revision+1);
  assert.deepEqual(corrected.source.refs.map(ref=>ref.id), ['u4']);
  learning.applyResult(config, target, records, value, [first], [], false, []);
  assert.equal(f.store.get(first.id).revision, corrected.revision);
});
