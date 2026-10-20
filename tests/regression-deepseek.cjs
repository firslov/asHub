const test = require('node:test');
const assert = require('node:assert/strict');
const { env, req, Res } = require('./harness.cjs');
const { ui } = require('./ui-harness.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

test('DeepSeek settings-only catalog includes new and legacy vision models before a session exists', async () => {
  const e = env();
  e.auth.listAllProviders = () => [{ id: 'deepseek' }];
  e.settings.resolveProvider = () => ({ models: ['deepseek-v4-flash'], defaultModel: 'deepseek-v4-flash', modelsExplicit: false });
  const { getModels } = e.load('src/hub.ts', 'export { getModels };');
  const res = new Res(); await getModels(req({}, '/api/models/deepseek'), res, new Map());
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().defaultModel, 'deepseek-v4-flash');
  assert.equal(res.json().models.length, 4);
  for (const m of res.json().models) assert.equal(m.modalities.includes('image'), m.id !== 'deepseek-v4-pro');
});

test('DeepSeek explicit model list and modality overrides stay authoritative', async () => {
  const e = env(); e.auth.listAllProviders = () => [{ id: 'deepseek' }];
  e.settings.resolveProvider = () => ({ modelsExplicit: true, models: ['deepseek-flash', 'private-model'], modelCapabilities: new Map([['deepseek-flash', { modalities: ['text'] }]]) });
  const { getModels } = e.load('src/hub.ts', 'export { getModels };');
  const res = new Res(); await getModels(req({}, '/api/models/deepseek'), res, new Map());
  assert.deepEqual(res.json().models, [{ id: 'deepseek-flash', modalities: ['text'] }, { id: 'private-model' }]);
});

test('DeepSeek reasoning maps legacy settings without sending unsupported effort values', () => {
  const { deepSeekReasoningParams: params } = env().load('src/providers/deepseek.ts');
  assert.deepEqual(plain(params('off')), { thinking: { type: 'disabled' } });
  for (const [level, expected] of [['low','low'], ['medium','high'], ['high','high'], ['xhigh','max'], ['max','max']]) {
    assert.deepEqual(plain(params(level)), { thinking: { type: 'enabled' }, reasoning_effort: expected });
  }
});

test('UI shows native DeepSeek levels and preserves other provider choices', () => {
  const { reasoningLevels, reasoningLabel, normalizeReasoning } = env().load('web/js/reasoning.js');
  assert.deepEqual(plain(reasoningLevels('deepseek').map(l => reasoningLabel(l, 'deepseek'))), ['off','low','high','max']);
  assert.equal(normalizeReasoning('medium', 'deepseek'), 'high');
  assert.deepEqual(plain(reasoningLevels('openai')), ['off','low','medium','high','xhigh']);
  assert.equal(reasoningLabel('xhigh', 'openai'), 'xhigh');
});

test('composer cycles native DeepSeek choices using compatible persisted values', async () => {
  const u = ui(); u.composer();
  const session = u.active.peek(); session.agentInfo = { provider: 'deepseek', thinkingSupported: true, thinkingLevel: 'high' };
  const key = { key: 'Tab', shiftKey: true, preventDefault() {} };
  const press = async () => { for (const handler of u.ids.get('query').events.keydown) await handler(key); };
  await press();
  assert.equal(JSON.parse(u.calls.at(-1).opts.body).level, 'xhigh');
  session.agentInfo.thinkingLevel = 'xhigh'; await press();
  assert.equal(JSON.parse(u.calls.at(-1).opts.body).level, 'off');
  session.agentInfo.provider = 'openai'; session.agentInfo.thinkingLevel = 'low'; await press();
  assert.equal(JSON.parse(u.calls.at(-1).opts.body).level, 'medium');
});

test('subagent selector shows max, normalizes legacy medium, and follows provider changes', () => {
  const u = ui(); u.doc.getElementById('subagent-panel').hidden = true;
  u.modules['./sse.js'] = { setModelCache() {} };
  const { makeReasoningSelect } = u.e.load('web/js/subagent-panel.js', 'export { makeReasoningSelect };');
  u.active.peek().agentInfo.provider = 'deepseek';
  const deep = makeReasoningSelect('review', 'medium');
  assert.equal(deep.value, 'high');
  assert(deep.innerHTML.includes('value="xhigh">max</option>'));
  assert(!deep.innerHTML.includes('value="medium"'));
  u.active.peek().agentInfo.provider = 'openai';
  const other = makeReasoningSelect('review', 'medium');
  assert.equal(other.value, 'medium');
  assert(other.innerHTML.includes('value="xhigh">xhigh</option>'));
});
