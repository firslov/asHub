import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Assistant } from '../shared.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-batch-validator-'));
  const target = { id:'assistant', cwd:dir, projectId:null };
  const grant = { includedIds:[target.id], excludedIds:[], since:0, includeHistory:true };
  const live = new Set();
  const reads = [];
  const api = {
    status: () => grant,
    targets: () => [target],
    valid: (_, id, ids) => {
      assert.equal(id, target.id);
      reads.push(...ids);
      return ids.filter(sourceId => live.has(sourceId));
    },
  };
  const assistant = new Assistant({ dataDirectory:dir, background:api, conversations:{ get:() => target.id },
    host:{ snapshot:() => ({ sessions:[target], projects:[] }) } });
  const { store, learning } = assistant;
  const config = { enabled:true, grantId:'grant', modelSessionId:target.id, includedIds:[target.id], dailyCalls:4 };
  store.setState('learning', config);
  t.after(() => {
    assistant.stop();
    fs.rmSync(dir, { recursive:true, force:true });
  });

  const addMemory = (topic, content, sourceId = 'shared') => store.learn(
    { title:topic, content, kind:'fact', scope:'personal' },
    {
      type:'learned', namespace:'assistant-v4', topic, certainty:'explicit', grantId:config.grantId,
      context:{ subject:'user', conversationId:target.id },
      refs:[{ conversationId:target.id, id:sourceId, quote:content, fingerprint:topic, at:1 }],
    },
  );
  const process = records => learning.processBatch(config, target, records, new AbortController().signal);
  return { api, live, reads, addMemory, process, store };
}

test('candidate ranking and short-denial lookup validate each shared source once per batch', async t => {
  const { api, live, reads, addMemory, process } = fixture(t);
  live.add('shared');
  live.add('independent');
  const job = addMemory('occupation', '用户在图书馆工作');
  addMemory('city', '用户住在厦门');
  addMemory('commute', '用户每周乘公交上班', 'independent');
  addMemory('past-occupation', '用户在书店工作', 'removed');
  addMemory('past-city', '用户住在南京', 'removed');
  let request, discoveryReads;
  api.infer = async (_, messages) => {
    request = JSON.parse(messages[1].content);
    discoveryReads = [...reads];
    return '{"memories":[]}';
  };

  const records = [
    { id:'question', role:'assistant', text:'你现在在图书馆工作吗？', at:2 },
    { id:'answer', role:'user', text:'不是', previousId:'question', at:3 },
    { id:'question-2', role:'assistant', text:'你现在在书店工作吗？', at:4 },
    { id:'answer-2', role:'user', text:'不是', previousId:'question-2', at:5 },
  ];
  for (const record of records) live.add(record.id);
  await process(records);

  assert.deepEqual(discoveryReads.sort(), ['independent', 'removed', 'shared']);
  assert.equal(request.existing[0].id, job.id, 'the valid denial candidate is prioritized');
  assert.deepEqual(request.existing.map(row => row.id), [job.id], 'omit unrelated existing memories');
});

test('evidence discarded during inference cannot justify a late update or appear in the next batch', async t => {
  const { api, live, reads, addMemory, process, store } = fixture(t);
  const prior = addMemory('occupation', '用户在图书馆工作');
  const message = { id:'new-proof', role:'user', text:'我现在仍然在图书馆工作', at:2 };
  live.add('shared');
  live.add(message.id);
  let resolveInference, request;
  api.infer = (_, messages) => {
    request = JSON.parse(messages[1].content);
    return new Promise(resolve => { resolveInference = resolve; });
  };

  const pending = process([message]);
  assert(request.existing.some(row => row.id === prior.id));
  live.delete('shared');
  reads.length = 0;
  resolveInference(JSON.stringify({ memories:[{
    title:prior.title, content:prior.content, kind:prior.kind, scope:prior.scope, subject:'user',
    certainty:'explicit', topic:prior.source.topic, aliases:[], memoryId:prior.id, revision:prior.revision,
    relation:'support', evidence:[{ id:message.id, quote:message.text }],
  }] }));
  await pending;
  assert(reads.includes('shared'), 'apply rechecks the prior source after inference');
  assert.equal(store.get(prior.id).revision, prior.revision, 'a rewound source cannot support this update');

  api.infer = async (_, messages) => {
    request = JSON.parse(messages[1].content);
    return '{"memories":[]}';
  };
  live.add('another-message');
  await process([{ ...message, id:'another-message' }]);
  assert.deepEqual(request.existing, []);
});
