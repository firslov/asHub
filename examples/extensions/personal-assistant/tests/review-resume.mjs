import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Assistant } from '../shared.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-review-resume-'));
  const records = [], requests = [];
  const target = { id: 'a', instanceId: 'a', cwd: dir, projectId: null, title: '助手', kind: 'agent', busy: false };
  let answer = () => ({ memories: [] });
  const clip = (text, n) => { let end = Math.min(n, text.length); if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end--; return text.slice(0, end); };
  const api = {
    status: () => ({ includedIds: ['a'], excludedIds: [], includeHistory: true, since: 0, calls: requests.length, dailyCalls: 4 }),
    targets: () => [{ ...target }],
    read: (g, id, cursor) => {
      const index = records.findIndex(row => row.id === cursor), page = records.slice(index + 1, index + 41);
      return { entries: page.map(row => ({ ...row, text: clip(row.text, 3000), truncated: row.text.length > 3000 })), cursor: page.at(-1)?.id ?? cursor ?? null, more: index + 1 + page.length < records.length, reset: !!cursor && index < 0 };
    },
    entry: (g, id, source, offset = 0) => {
      const row = records.find(row => row.id === source);
      if (!row) throw Error('History source unavailable');
      if (offset < 0 || offset > row.text.length || (offset > 0 && /[\uD800-\uDBFF]/u.test(row.text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(row.text[offset] ?? ''))) throw Error('Invalid history offset');
      const text = clip(row.text.slice(offset), 3000);
      return { ...row, text, offset, nextOffset: offset + text.length, more: offset + text.length < row.text.length };
    },
    valid: (g, id, ids) => ids.filter(id => records.some(row => row.id === id)),
    infer: async (g, messages) => {
      assert(JSON.stringify(messages).length <= 16000);
      const request = JSON.parse(messages[1].content); requests.push(request);
      return JSON.stringify(await answer(request));
    },
    revoke: () => {},
  };
  const services = { dataDirectory: dir, conversations: { get: () => 'a' }, background: api, host: { snapshot: () => ({ sessions: [target], projects: [] }) } };
  let a = new Assistant(services);
  a.store.setState('learning', { enabled: true, grantId: 'g1', modelSessionId: 'a', includedIds: ['a'], excludedIds: [], includeHistory: true, dailyCalls: 4 });
  t.after(() => { a.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { get a() { return a; }, records, requests,
    add: (role, text) => { const row = { id: 'r' + records.length, role, text, at: Date.now() - 120000 + records.length }; records.push(row); return row; },
    answer: fn => answer = fn,
    restart: () => { a.stop(); a = new Assistant(services); },
  };
}

const fact = (row, quote) => ({ title: '居住地', content: '用户住在上海', kind: 'fact', scope: 'personal', subject: 'user', certainty: 'explicit', topic: 'city', aliases: [], evidence: [{ id: row.id, quote }] });
const suppliedText = (request, id) => [...(request.context ?? []), ...request.records].filter(row => row.id === id).map(row => row.text).join('');

for (const { quote, first } of [{ quote: '我住在上海', first: 2 }, { quote: '我住在上海并且喜欢当地的生活', first: 2 }, { quote: '我住在上海生活很好', first: 8 }]) {
  test(`a fact crossing a history segment boundary survives restart (${quote.length - first} character suffix)`, async t => {
    const f = fixture(t), row = f.add('user', '背'.repeat(3000 - first) + quote);
    f.answer(request => ({ memories: suppliedText(request, row.id).includes(quote) ? [fact(row, quote)] : [] }));
    await f.a.learning.tick();
    assert.equal(f.a.store.state('scan:a').partial.offset, 3000);
    assert.equal(f.a.store.activeMemories().length, 0, 'incomplete source cannot support the fact');
    f.restart();
    await f.a.learning.tick();
    assert.equal(f.a.store.state('scan:a').cursor, row.id);
    assert.equal(f.a.store.state('scan:a').partial, null);
    assert.equal(f.requests.length, 2, 'the final source fragment still reaches consolidation');
    assert.equal(f.a.store.activeMemories()[0]?.content, '用户住在上海');
    assert.deepEqual(f.a.store.activeMemories()[0]?.source.refs.map(ref => ({ id: ref.id, quote: ref.quote })), [{ id: row.id, quote }]);
  });
}

test('continuation rejects a quote wholly in the already processed prefix', async t => {
  const f = fixture(t), quote = '我住在上海';
  const row = f.add('user', '背'.repeat(2990) + quote + '。'.repeat(5) + '现在讨论另一个临时话题');
  f.answer(() => ({ memories: [] }));
  await f.a.learning.tick(); f.restart();
  f.answer(request => { assert(request.records[0].continuation.text.includes(quote)); return { memories: [fact(row, quote)] }; });
  await f.a.learning.tick();
  assert.equal(f.requests.length, 2);
  assert.equal(f.a.store.activeMemories().length, 0, 'old overlap text is not fresh evidence');
  assert.equal(f.a.store.state('scan:a').cursor, row.id);
});

test('longer sources preserve consecutive segment offsets and exact text through restart', async t => {
  const f = fixture(t), quote = '我住在上海', row = f.add('user', '背'.repeat(5998) + quote);
  f.answer(request => ({ memories: suppliedText(request, row.id).includes(quote) ? [fact(row, quote)] : [] }));
  await f.a.learning.tick(); await f.a.learning.tick();
  assert.equal(f.a.store.state('scan:a').partial.offset, 6000); f.restart();
  await f.a.learning.tick();
  const parts = f.requests.flatMap(request => request.records.filter(part => part.id === row.id));
  assert.equal(parts.map(part => part.text).join(''), row.text);
  assert.deepEqual(parts.map(part => part.offset), [0, 3000, 6000]);
  assert.equal(f.a.store.activeMemories()[0]?.content, '用户住在上海');
});

test('a discontinuous saved neighbor cannot be spliced into fresh source evidence', async t => {
  const f = fixture(t), row = f.add('user', '背'.repeat(2998) + '我住在上海');
  await f.a.learning.tick();
  const state = f.a.store.state('scan:a');
  state.context = [{ id: row.id, role: 'user', at: row.at, text: '我出生', offset: 20 }];
  f.a.store.setState('scan:a', state); f.restart();
  f.answer(request => {
    assert(request.records[0].continuation.text.endsWith('我住'));
    assert(!request.records[0].continuation.text.includes('我出生'));
    return { memories: [fact(row, '我出生在上海')] };
  });
  await f.a.learning.tick();
  assert.equal(f.a.store.activeMemories().length, 0);
  assert.equal(f.a.store.state('scan:a').cursor, row.id);
});

test('a secret split across two source segments is not sent in the continuation', async t => {
  const f = fixture(t), row = f.add('user', '背'.repeat(2997) + '密码:' + 'synthetic-secret');
  await f.a.learning.tick();
  assert.equal(f.a.store.state('scan:a').partial.offset, 3000); f.restart();
  await f.a.learning.tick();
  assert.equal(f.requests.length, 1, 'the joined sensitive text is filtered before another inference');
  assert.equal(f.a.store.state('scan:a').cursor, row.id);
});

test('an older checkpoint restores an exact unicode-safe prefix beyond the initial preview', async t => {
  const f = fixture(t), quote = '我住在上海', row = f.add('user', '背'.repeat(5699) + '😀' + '背'.repeat(297) + quote);
  f.answer(request => ({ memories: suppliedText(request, row.id).includes(quote) ? [fact(row, quote)] : [] }));
  await f.a.learning.tick(); await f.a.learning.tick();
  const state = f.a.store.state('scan:a'); assert.equal(state.partial.offset, 6000);
  for (const record of state.context) delete record.offset;
  f.a.store.setState('scan:a', state); f.restart(); await f.a.learning.tick();
  const continuation = f.requests.at(-1).records[0].continuation;
  assert(continuation.text.isWellFormed());
  assert.equal(continuation.text, row.text.slice(continuation.offset, 6000));
  assert.equal(f.a.store.activeMemories()[0]?.content, '用户住在上海');
});
