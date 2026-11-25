import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-openrouter-catalog-'));
process.env.AGENT_SH_HOME = dir;
for (const name of Object.keys(process.env)) {
  if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(name) || name === 'OPENAI_BASE_URL') delete process.env[name];
}
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const { AshBridge } = await import('../dist/bridges/ash.js');
const { reloadSettings } = await import('agent-sh/settings');

const fallback = { apiKey: 'fixture-fallback', baseURL: 'https://fallback.invalid/v1', models: ['fallback-model'] };
const curatedModel = 'deepseek/deepseek-v4-flash';
function saveKey(key) {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    defaultProvider: 'openrouter', startupBanner: false, disabledBuiltins: ['codex-provider'],
    providers: { fixture: fallback, ...(key ? { openrouter: { apiKey: key } } : {}) },
  }));
  reloadSettings();
}

function fixture(t) {
  saveKey('fixture-A');
  const requests = [], bridges = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, 'https://openrouter.ai/api/v1/models', 'unexpected external request');
    const response = Promise.withResolvers();
    requests.push({ key: request.headers.get('authorization'), reply: response.resolve });
    return response.promise;
  });
  t.after(async () => {
    for (const bridge of bridges) bridge.close();
    for (const request of requests) request.reply(Response.json({ data: [] }));
    await setImmediate();
  });
  return {
    requests,
    async start() {
      const bridge = new AshBridge({ cwd: dir });
      bridges.push(bridge);
      await bridge.ready();
      return bridge;
    },
    async finish(index, model) {
      requests[index].reply(Response.json({ data: [model] }));
      await setImmediate();
    },
  };
}
const catalog = bridge => bridge.core.handlers.call('agent:get-models').filter(model => model.provider === 'openrouter');
const ids = bridge => catalog(bridge).map(model => model.id);

test('a delayed startup catalog cannot replace the refreshed key B catalog', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const bridge = await f.start();
  assert.deepEqual(ids(bridge), [curatedModel], 'startup must still expose its curated fallback while fetch is pending');
  saveKey('fixture-B');
  await bridge.reloadProviders();
  assert.deepEqual(f.requests.map(request => request.key), ['Bearer fixture-A', 'Bearer fixture-B']);
  await f.finish(1, { id: 'new-catalog-model', architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['reasoning'], context_length: 64000 });
  assert.deepEqual(ids(bridge), ['new-catalog-model']);
  assert.deepEqual(catalog(bridge)[0].modalities, ['text', 'image']);
  assert.equal(catalog(bridge)[0].contextWindow, 64000);
  await f.finish(0, { id: 'stale-activation-model' });
  assert.deepEqual(ids(bridge), ['new-catalog-model']);
});

test('revoking OpenRouter invalidates startup with or without an explicit reload', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const refreshed = await f.start(), unrefreshed = await f.start();
  // Observe provider registration directly: a revoked key also hides stale
  // registrations from agent:get-models, so that catalog alone can miss a bug.
  const refreshedRegister = t.mock.method(refreshed.extCtx.agent.providers, 'register');
  const unrefreshedRegister = t.mock.method(unrefreshed.extCtx.agent.providers, 'register');
  saveKey(undefined);
  await refreshed.reloadProviders();
  assert.equal(f.requests.length, 2, 'revoked credentials must not trigger another catalog fetch');
  await f.finish(0, { id: 'revoked-0' });
  await f.finish(1, { id: 'revoked-1' });
  assert.equal(refreshedRegister.mock.callCount(), 0);
  assert.equal(unrefreshedRegister.mock.callCount(), 0, 'credential check also protects a bridge not yet notified');
  assert.deepEqual(ids(refreshed), []);
  const later = await f.start();
  assert.equal(later.core.handlers.call('agent:get-model').provider, 'fixture');
  assert.equal(f.requests.length, 2);
});

test('refreshing one of two sessions with the same key does not invalidate the other', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const first = await f.start(), second = await f.start();
  await first.reloadProviders();
  assert.deepEqual(f.requests.map(request => request.key), Array(3).fill('Bearer fixture-A'));
  await f.finish(2, { id: 'first-refreshed' });
  await f.finish(1, { id: 'deepseek/second-startup' });
  await f.finish(0, { id: 'first-stale-startup' });
  assert.deepEqual(ids(first), ['first-refreshed'], 'same-key refresh must win by generation');
  assert.deepEqual(ids(second), ['deepseek/second-startup'], 'second bridge has an independent generation and catalog');
  assert.equal(catalog(second)[0].echoReasoning, true, 'startup keeps the built-in OpenRouter metadata');
});

test('closing the bridge suppresses its startup catalog registration', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const bridge = await f.start();
  const register = t.mock.method(bridge.extCtx.agent.providers, 'register');
  bridge.close();
  await f.finish(0, { id: 'closed-stale-startup' });
  assert.equal(register.mock.callCount(), 0);
});
