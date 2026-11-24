import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../store.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-forget-scope-'));
  let store = new MemoryStore(directory);
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const local = { title: '饮品偏好', content: '用户喜欢薄荷茶', kind: 'preference', scope: 'conversation:a' };
  const source = (topic, id, quote) => ({
    type: 'learned', namespace: 'assistant-v4', topic, certainty: 'explicit',
    context: { subject: 'user', conversationId: 'a' },
    refs: [{ id, conversationId: 'a', at: Number(id.slice(1)), quote, fingerprint: id }],
  });
  const initial = store.learn(local, source('drink', 'u1', '我在这里喜欢喝薄荷茶'));
  const promoted = store.learn({ ...local, scope: 'personal' }, source('drink', 'u2', '我一直喜欢薄荷茶'), {
    alignment: { memoryId: initial.id, revision: initial.revision, relation: 'revise' },
  });
  assert.equal(promoted.id, initial.id);
  return {
    get store() { return store; }, local, promoted, source,
    restart() { store.close(); store = new MemoryStore(directory); },
  };
}

test('forgetting a scope-promoted record blocks renamed copies in its former scope after history rolls over', t => {
  const f = fixture(t);
  let row = f.promoted;
  for (let i = 1; i <= 11; i++) row = f.store.edit(row.id, row.revision, { ...row, title: `用户确认的偏好 ${i}` });
  assert.equal(f.store.history(row.id).length, 10);
  assert(f.store.history(row.id).every(version => version.value.scope === 'personal'));
  const pending = { value: f.local, source: f.source('queued', 'u4', '我的饮品偏好是薄荷茶') };
  const unrelated = { ...pending, value: { ...f.local, content: '用户喜欢乌龙茶' } };
  f.store.setState('deferred:a', [pending, unrelated]);
  f.restart();
  f.store.forget(row.id, row.revision);
  f.restart();
  const replay = f.store.learn(f.local, f.source('tea-under-new-topic', 'u3', '薄荷茶仍是我喜欢的饮品'));
  assert.equal(replay.state, 'forgotten');
  assert.equal(replay.id, row.id);
  assert.deepEqual(f.store.state('ignored:a').sort(), ['u1', 'u2']);
  assert.deepEqual(f.store.state('deferred:a'), [unrelated]);
  assert.deepEqual(f.store.history(row.id), []);
});

test('forgetting a scope-promoted record leaves an independent memory in the former scope eligible for recall', t => {
  const f = fixture(t);
  const independent = f.store.learn(f.local, f.source('project-drink', 'u3', '在这个对话里的聚会我选薄荷茶'));
  assert.notEqual(independent.id, f.promoted.id);
  assert.equal(independent.state, 'active');
  f.store.forget(f.promoted.id, f.promoted.revision);
  f.restart();
  const kept = f.store.get(independent.id);
  assert.equal(kept.state, 'active');
  assert.equal(f.store.forgottenCopy(kept), undefined);
  const supported = f.store.learn(f.local, f.source('team-drink', 'u4', '这次聚会我依旧选薄荷茶'));
  assert.equal(supported.id, independent.id);
  assert.deepEqual(supported.source.refs.map(ref => ref.id), ['u3', 'u4']);
});

test('updating an exempt independent record does not let a forgotten claim reappear after restart', t => {
  const f = fixture(t);
  const independent = f.store.learn(f.local, f.source('team-drink', 'u3', '聚会时我会选薄荷茶'));
  f.store.forget(f.promoted.id, f.promoted.revision);
  f.restart();
  assert.equal(f.store.forgottenCopy(f.store.get(independent.id)), undefined);
  const revised = f.store.learn({...f.local,content:'用户改为在聚会时喝绿茶'},
    f.source('team-drink', 'u4', '聚会时我现在改喝绿茶'), {
      alignment:{memoryId:independent.id,revision:independent.revision,relation:'revise'},
    });
  assert.equal(revised.id, independent.id);
  f.restart();
  const replay = f.store.learn(f.local, f.source('renamed-tea', 'u5', '此前聚会我会选薄荷茶'));
  assert.equal(replay.state, 'forgotten');
  assert.deepEqual(f.store.activeMemories().map(row=>row.content), [revised.content]);
});

test('a former-scope copy backed only by forgotten evidence is removed across restart', t => {
  const f = fixture(t);
  const original = f.promoted.source.originRefs.find(ref => ref.id === 'u1');
  assert.equal(original.conversationId, 'a');
  const copy = f.store.learn(f.local, f.source('copied-drink', original.id, '我喜欢薄荷茶'));
  assert.notEqual(copy.id, f.promoted.id);
  assert.equal(copy.state, 'active');
  f.store.setState('learning-result:a', {sourceIds:[], existing:[{id:copy.id}], value:{memories:[]}});

  f.store.forget(f.promoted.id, f.promoted.revision);
  f.restart();

  assert.equal(f.store.get(copy.id).state, 'forgotten');
  assert.deepEqual(f.store.history(copy.id), []);
  assert.equal(f.store.state('learning-result:a'), null);
  assert.equal(f.store.learn(f.local, f.source('renamed-drink', 'u3', '薄荷茶是我喜欢的饮品')).state, 'forgotten');

  const freshId = 'u' + (f.store.get(f.promoted.id).updated + 1);
  const renewed = f.store.learn(f.local, f.source('renamed-drink', freshId, '请重新记住：我喜欢薄荷茶'), {explicitRequest:true});
  assert.equal(renewed.state, 'active');
  assert.notEqual(renewed.id, copy.id);
  assert.deepEqual(renewed.source.refs.map(ref=>ref.id), [freshId]);
});

test('earlier proof of a different claim cannot exempt a dependent copy from forgetting', t => {
  const f = fixture(t);
  const past = f.store.learn({...f.local,content:'用户喜欢乌龙茶'}, f.source('team-drink','w1','我曾喜欢乌龙茶'));
  const copy = f.store.learn(f.local, f.source('team-drink','u1','我在这里喜欢喝薄荷茶'), {
    alignment:{memoryId:past.id,revision:past.revision,relation:'revise'},
  });
  assert.deepEqual(copy.source.refs.map(ref=>ref.id), ['u1']);
  assert(copy.source.originRefs.some(ref=>ref.id==='w1'));
  f.store.forget(f.promoted.id,f.promoted.revision);
  f.restart();
  assert.equal(f.store.get(copy.id).state, 'forgotten');
  assert.deepEqual(f.store.history(copy.id), []);
  assert.deepEqual((f.store.state('ignored:a') ?? []).sort(), ['u1','u2'], 'older unrelated evidence remains accessible');
});
