import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore, terms, previewText } from '../store.mjs';
import { Assistant, start, current } from '../shared.mjs';
import { AssistantPanel } from '../app.mjs';
import { withMemory, recall } from '../context.mjs';
import activateSession from '../session.mjs';

const input = (values = {}) => ({ title: '周报格式', content: '周报先给结论，再列证据与待办', kind: 'preference', scope: 'personal', ...values });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-memory-'));
  const snapshot = { sessions: [
    { instanceId: 'a', kind: 'agent', title: '助手', cwd: '/work/a', projectId: 'p' },
    { instanceId: 'b', kind: 'agent', title: '项目成员', cwd: '/work/b', projectId: 'p' },
    { instanceId: 'c', kind: 'agent', title: '其他项目', cwd: '/work/c', projectId: 'q' },
    { instanceId: 'terminal', kind: 'ash-terminal', title: '终端', cwd: '/work/a' },
  ], projects: [{ id: 'p', name: '研究项目' }, { id: 'q', name: '另一个项目' }] };
  const services = { dataDirectory: dir, host: { snapshot: () => structuredClone(snapshot) } };
  const a = new Assistant(services), panel = new AssistantPanel(a);
  t.after(() => { a.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, a, panel, snapshot, services, db: a.store };
}
const user = { type: 'user', at: 1 };
test('memory survives restart with stable assistant identity and Chinese/English search', t => {
  const f = fixture(t), row = f.db.add(input(), user, 'active'), identity = f.db.profile().assistantId;
  assert.equal(f.db.search('周报', ['personal'])[0].id, row.id);
  const english = f.db.add(input({ title: 'API', content: 'Use OpenAI Responses for this application' }), user, 'active');
  assert.equal(f.db.search('OpenAI', ['personal'])[0].id, english.id);
  f.a.stop();
  const restored = new MemoryStore(f.dir);
  try { assert.equal(restored.profile().assistantId, identity); assert.equal(restored.get(row.id).content, row.content); }
  finally { restored.close(); }
});
test('a proposal is never recalled until reviewed; exact retries share one candidate', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  const proposal = { ...input(), reason: '用户要求周报先给结论' };
  const first = f.a.propose('a', proposal), retry = f.a.propose('a', proposal);
  assert.equal(first.id, retry.id); assert.equal(f.db.counts().candidate, 1);
  assert.equal(f.a.search('a', '周报').length, 0);
  const plan = f.panel.prepare('approve', first); assert(plan.preview);
  assert.equal(f.a.search('a', '周报').length, 0, 'prepare does not authorize');
  plan.execute(); assert.equal(f.a.search('a', '周报').length, 1);
});
test('authorization remains required but provenance and legacy personal flags no longer isolate recall', t => {
  const f = fixture(t);
  const personal = f.db.add(input(), user, 'active');
  const project = f.db.add(input({ scope: 'project:p' }), user, 'active');
  const local = f.db.add(input({ scope: 'conversation:a' }), user, 'active');
  assert.throws(() => f.a.search('a', '周报'), /未关联/);
  f.db.bind('a', '/work/a', true); f.db.bind('b', '/work/b', false); f.db.bind('c', '/work/c', false);
  assert.equal(f.a.search('a', '周报').length, 3);
  assert.equal(f.a.search('b', '周报').length, 3);
  assert.equal(f.a.read('b', personal.id).scope, 'global'); assert.equal(f.a.read('b', local.id).id, local.id);
  assert.equal(f.a.search('c', '周报').length, 3);
  f.snapshot.sessions[1].projectId = 'q'; assert.equal(f.a.search('b', '周报').length, 3);
  f.snapshot.sessions[0].cwd = '/work/replaced'; assert.equal(f.a.scope('a'), null);
  f.snapshot.sessions.splice(1, 1); assert.equal(f.a.scope('b'), null);
});
test('association requires confirmed unchanged target and rejects terminal sessions', t => {
  const f = fixture(t), plan = f.panel.prepare('bind', { conversationId: 'a', personal: true });
  assert.equal(f.a.scope('a'), null); assert(plan.preview.fields.some(f => f.label === '模型服务'));
  f.snapshot.sessions[0].cwd = '/changed'; assert.throws(() => plan.execute(), /变化/);
  assert.equal(f.db.bindings().length, 0);
  assert.throws(() => f.panel.prepare('bind', { conversationId: 'terminal', personal: true }), /可用/);
});
test('candidate replacement is atomic and revision-checked, and forgotten proposals cannot replay', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  const old = f.db.add(input(), user, 'active');
  const next = f.a.propose('a', { ...input({ content: '周报改用表格' }), reason: '用户纠正格式', replaces: old.id, replacesRevision: old.revision });
  assert.equal(f.a.read('a', old.id).content, old.content);
  const approved = f.panel.prepare('approve', next).execute();
  assert(approved.rows[0].detail.includes('表格'));
  assert.equal(f.a.propose('a', { ...input({ content: '周报改用表格' }), reason: '用户纠正格式', replaces: old.id, replacesRevision: old.revision }).state, 'active', 'retry after approval returns existing memory');
  assert.equal(f.db.get(old.id).state, 'retired'); assert.throws(() => f.a.read('a', old.id));
  const active = f.db.get(next.id);
  f.db.forget(active.id, active.revision);
  assert.equal(f.db.history(active.id).length, 0);
  assert.equal(f.db.search('表格', ['personal']).length, 0);
  const fresh = { ...input({ content: '不采纳的内容' }), reason: '暂未确认' };
  const proposal = f.a.propose('a', fresh); f.db.forget(proposal.id, proposal.revision);
  assert.equal(f.a.propose('a', fresh).state, 'forgotten');
  assert.equal(f.db.get(proposal.id).content, '');
});
test('concurrent user edit invalidates a prepared approval without retiring original memory', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  const old = f.db.add(input(), user, 'active');
  const next = f.a.propose('a', { ...input({ content: '模型的修订' }), reason: '提议', replaces: old.id, replacesRevision: old.revision });
  const plan = f.panel.prepare('approve', next);
  f.db.edit(old.id, old.revision, input({ content: '用户的新要求' }));
  assert.throws(() => plan.execute(), /变化/);
  assert.equal(f.db.get(old.id).state, 'active'); assert.equal(f.db.get(next.id).state, 'candidate');
});
test('candidate from revoked source cannot be activated by a stale confirmation', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  const proposal = f.a.propose('a', { ...input(), reason: '用户偏好' }), plan = f.panel.prepare('approve', proposal);
  f.db.unbind('a'); assert.throws(() => plan.execute(), /未关联/);
  assert.equal(f.db.get(proposal.id).state, 'candidate');
});
test('edit, bounded version history, restore and forget do not resurrect old content', t => {
  const f = fixture(t);
  let row = f.db.add(input(), user, 'active');
  for (let i = 0; i < 12; i++) row = f.db.edit(row.id, row.revision, input({ content: '格式' + i }));
  assert.equal(f.db.history(row.id).length, 10);
  const previous = f.db.history(row.id)[1];
  const restore = f.panel.prepare('restore', { id: row.id, revision: row.revision, version: previous.revision });
  assert(restore.preview); restore.execute();
  assert.equal(f.db.get(row.id).content, previous.value.content);
  row = f.db.get(row.id);
  const removal = f.panel.prepare('forget', row); assert(f.db.search('格式', ['personal']).length);
  removal.execute(); assert.equal(f.db.history(row.id).length, 0); assert.equal(f.db.search('格式', ['personal']).length, 0);
});
test('profile pause rejects memory tools and recall while preserving data', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true); f.db.add(input(), user, 'active');
  const p = f.db.profile(), plan = f.panel.prepare('configure', { name: '我的助手', enabled: false, revision: p.revision });
  plan.execute();
  assert.equal(f.a.scope('a'), null); assert.throws(() => f.a.propose('a', { ...input(), reason: 'no' }));
  assert.equal(f.db.counts().active, 1);
  assert.throws(() => plan.execute(), /变化/);
});
test('scope validation, runtime argument validation and Unicode are bounded', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  assert.throws(() => f.a.propose('a', { ...input({ scope: 'project:q' }), reason: '越界' }));
  assert.throws(() => f.a.propose('a', { ...input({ kind: '__proto__' }), reason: '坏类型' }));
  assert.throws(() => f.a.propose('a', { ...input({ content: 'a'.repeat(2001) }), reason: '过长' }));
  assert.throws(() => f.a.search('a', '周报', 10000));
  assert.throws(() => f.db.list('active', -1));
  assert(terms('中文检索 GPT-6.1').includes('检索'));
  const row = f.db.add(input({ content: '保留 emoji 🟡 与孤立字符 \ud83d' }), user, 'active');
  assert(row.content.isWellFormed());
});
test('request recall preserves prefix, tool IDs and images without persisting context', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true); f.db.add(input(), user, 'active');
  const messages = [{ role: 'system', content: 'stable' }, { role: 'user', content: [
    { type: 'text', text: '整理周报' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } },
  ] }];
  const copy = structuredClone(messages), result = withMemory(messages, f.a, 'a');
  assert.equal(result[0], messages[0]); assert.equal(result[1].content[2], messages[1].content[1]);
  assert(result[1].content[0].text.includes('周报先给结论'));
  assert.deepEqual(messages, copy);
  const toolMessages = [...messages, { role: 'tool', tool_call_id: 'call-1', content: 'result' }];
  const toolResult = withMemory(toolMessages, f.a, 'a'); assert.equal(toolResult.at(-1).tool_call_id, 'call-1');
  assert.equal(toolMessages.at(-1).content, 'result');
});
test('steering and restored requests use latest user text rather than an event cache', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  f.db.add(input({ title: '颜色', content: '幻灯片使用蓝色', kind: 'fact' }), user, 'active');
  const original = [{ role: 'system', content: 'stable' }, { role: 'user', content: '准备周报' }, { role: 'assistant', content: '处理中' }];
  const steer = [...original, { role: 'user', content: '幻灯片怎么配色' }];
  const result = withMemory(steer, f.a, 'a');
  assert(result.at(-1).content.includes('幻灯片使用蓝色'));
  assert.equal(withMemory(original, f.a, 'a'), original, 'do not mutate assistant/tool-call messages');
  f.db.unbind('a'); assert.equal(withMemory(steer, f.a, 'a'), steer);
});
test('recall budget is bounded with complete records and no lone surrogates', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  for (let i = 0; i < 15; i++) f.db.add(input({ title: '要求' + i, content: '要求' + i + '🟡'.repeat(900), kind: 'principle' }), { type: 'user', userOperation: String(i) }, 'active');
  const output = recall(f.a, 'a', '要求'), value = JSON.parse(output);
  assert(output.length < 3000); assert(value.more); assert(value.items.length > 0);
  for (const row of value.items) assert(row.content.isWellFormed());
});
test('two connections serialize edits and stale revisions cannot overwrite', t => {
  const f = fixture(t), second = new MemoryStore(f.dir);
  try {
    const row = f.db.add(input(), user, 'active'); second.edit(row.id, row.revision, input({ content: '其他连接写入' }));
    assert.throws(() => f.db.edit(row.id, row.revision, input({ content: '过期写入' })), /变化/);
    assert.equal(f.db.get(row.id).content, '其他连接写入');
  } finally { second.close(); }
});
test('unsupported or corrupt databases fail without silently resetting data', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-corrupt-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'memory.sqlite'), db = new DatabaseSync(file); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => new MemoryStore(dir), /版本不受支持/);
  const probe = new DatabaseSync(file); assert.equal(probe.prepare('PRAGMA user_version').get().user_version, 99); probe.close();
  const brokenDir = path.join(dir, 'broken'); fs.mkdirSync(brokenDir);
  const brokenFile = path.join(brokenDir, 'memory.sqlite'), bytes = Buffer.from('not a SQLite database');
  fs.writeFileSync(brokenFile, bytes);
  assert.throws(() => new MemoryStore(brokenDir));
  assert.deepEqual(fs.readFileSync(brokenFile), bytes);
});
test('application stop revokes existing session tools and a late disposal cannot remove a replacement', t => {
  const f = fixture(t); f.a.stop();
  const active = start(f.services), tools = new Map(), advices = [];
  active.assistant.store.bind('a', '/work/a', true);
  activateSession({ services: { dataDirectory: f.dir }, list: () => ['session:current-id'], call: () => 'a',
    bus: { onPipe() {} },
    agent: { registerTool: t => tools.set(t.name, t), registerInstruction() {}, adviseInstruction() {} }, advise: (...v) => advices.push(v),
  });
  assert.equal(tools.size, 8);
  assert.throws(() => start(f.services), /运行/);
  active.dispose(); assert.equal(current(f.dir), undefined);
  return tools.get('assistant_memory_search').execute({ query: '周报' }).then(result => {
    assert(result.isError);
    const again = start(f.services); active.dispose(); assert.equal(current(f.dir), again.assistant); again.dispose();
  });
});

test('explicit user recreation is allowed after forgetting', t => {
  const f = fixture(t), row = f.db.add(input(), user, 'active');
  f.db.forget(row.id, row.revision);
  const plan = f.panel.prepare('save', input()); assert(plan.preview);
  const view = plan.execute(); assert.equal(view.rows[0].title, '周报格式');
  assert.equal(f.db.counts().active, 1);
});

test('image-only requests retain general language preferences but omit task-specific instructions and facts', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  f.db.add(input(), user, 'active');
  f.db.add(input({title:'回答语言',content:'使用中文回答'}),user,'active');
  f.db.add(input({ title: '无关事实', content: '另一项目的试验结果', kind: 'fact' }), user, 'active');
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } };
  const output = withMemory([{ role: 'user', content: [image] }], f.a, 'a');
  assert.match(output[0].content[0].text, /使用中文回答/);
  assert(!output[0].content[0].text.includes('周报先给结论'));
  assert(!output[0].content[0].text.includes('另一项目的试验结果'));
  assert.equal(output[0].content[1], image);
});

test('kernel context envelopes cannot consume the query term budget or recall unrelated facts', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  f.db.add(input({ title: '颜色', content: '幻灯片使用蓝色', kind: 'fact' }), user, 'active');
  f.db.add(input({ title: '后台环境', content: '无关的路由配置', kind: 'fact' }), user, 'active');
  const context = '后台环境 ' + Array.from({ length: 90 }, (_, i) => 'context' + i).join(' ');
  const wrap = (tag, body) => `<${tag}>\n${context}\n</${tag}>\n\n${body}`;
  for (const content of [wrap('dynamic_context', '幻灯片'), wrap('query_context', '幻灯片'), wrap('dynamic_context', wrap('query_context', '幻灯片'))]) {
    const raw = [{ role: 'user', content }], output = withMemory(raw, f.a, 'a');
    const memory = JSON.parse(output[0].content.split('\n')[1]);
    assert.deepEqual(memory.items.map(r => r.content), ['幻灯片使用蓝色']);
    assert(output[0].content.endsWith(content), 'request envelope remains intact');
    assert.equal(raw[0].content, content, 'stored content remains intact');
    const tools = withMemory([...raw, { role: 'tool', tool_call_id: 'result-1', content: '结果' }], f.a, 'a');
    assert.match(tools.at(-1).content, /幻灯片使用蓝色/);
    assert.equal(tools.at(-1).tool_call_id, 'result-1');
  }
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } };
  const parts = [{ type: 'text', text: wrap('query_context', '') }, image];
  const output = withMemory([{ role: 'user', content: parts }], f.a, 'a');
  assert.equal(output[0].content, parts, 'no empty memory wrapper when nothing matches');
  assert.equal(output[0].content[1], image);
});

test('query extraction preserves unclosed envelopes and tags quoted inside user text', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  f.db.add(input({ title: '颜色', content: '幻灯片使用蓝色', kind: 'fact' }), user, 'active');
  for (const content of ['<query_context>\n幻灯片', '请看这段示例：<dynamic_context>\n幻灯片\n</dynamic_context>\n\n']) {
    const output = withMemory([{ role: 'user', content }], f.a, 'a');
    assert.match(output[0].content, /幻灯片使用蓝色/);
    assert(output[0].content.endsWith(content));
  }
});

test('proposal retries cannot report edited content as the original accepted memory', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  const proposal = { ...input(), reason: '用户明确要求' };
  const candidate = f.a.propose('a', proposal);
  f.panel.prepare('approve', candidate).execute();
  const accepted = f.db.get(candidate.id);
  const changed = f.db.edit(accepted.id, accepted.revision, input({ content: '周报按时间顺序展开' }));
  assert.throws(() => f.a.propose('a', proposal), /已修改/);
  assert.equal(f.db.get(changed.id).content, changed.content);
  assert.equal(f.db.counts().candidate ?? 0, 0, 'retry must not create a competing candidate');
  // An explicit revision against the current memory still works.
  const revision = f.a.propose('a', { ...proposal, replaces: changed.id, replacesRevision: changed.revision });
  assert.equal(revision.state, 'candidate');
  f.panel.prepare('approve', revision).execute();
  assert.equal(f.a.read('a', revision.id).content, proposal.content);
});

test('deduplicated proposals are rechecked after their memory moves to another scope', t => {
  const f = fixture(t); f.db.bind('a', '/work/a', true);
  const proposal = { ...input(), reason: '用户明确要求' }, candidate = f.a.propose('a', proposal);
  f.panel.prepare('approve', candidate).execute();
  const accepted = f.db.get(candidate.id);
  f.db.edit(accepted.id, accepted.revision, input({ scope: 'project:q' }));
  assert.equal(f.a.read('a', accepted.id).context.projectId, 'q', 'scope remains provenance, not a read boundary');
  assert.throws(() => f.a.propose('a', proposal), /范围/);
  assert.equal(f.db.counts().active, 1);
  assert.equal(f.db.counts().candidate ?? 0, 0);
});


test('bounded previews preserve Unicode pairs, enforce the original budget and leave stored content intact',t=>{
  const f=fixture(t);
  for(const limit of [100,240,800]) {
    const content='文'.repeat(limit-1)+'🟡完整后文';
    const preview=previewText(content,limit);
    assert.equal(preview,'文'.repeat(limit-1));assert(preview.isWellFormed());assert(preview.length<=limit);
    assert.equal(previewText('文'.repeat(limit-2)+'🟡后文',limit),'文'.repeat(limit-2)+'🟡');
  }
  assert.equal(previewText('hello',3),'hel');assert.equal(previewText('🟡',1),'');assert.equal(previewText('🟡',2),'🟡');assert.equal(previewText('文本',0),'');
  const row=f.db.add(input({content:'文'.repeat(239)+'🟡后文'}),user,'active');
  assert(f.panel.row(row).detail.isWellFormed());assert.equal(f.panel.row(row).detail.length,239);
  assert.equal(f.db.get(row.id).content,row.content);
});
