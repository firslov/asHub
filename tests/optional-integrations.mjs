import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const omitted = process.env.ASHUB_TEST_EXCLUDED === '1';
const gemini = 'builtin:provider:gemini';
const antigravity = 'builtin:integration:google-antigravity';
const setting = 'ashub.integrations.disabled';

// A new process per fixture exercises cold kernel caches and restart-only integration policy.
async function checkStartup(spec) {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs/promises')).default;
  const { once } = await import('node:events');
  const file = `${process.env.AGENT_SH_HOME}/settings.json`;
  const localFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail('No provider network calls during startup/onboarding');
  const { desktopConversationBackends, allowsProvider } = await import('./dist/integrations.js');
  if (spec.desktopFirst) assert.deepEqual(await desktopConversationBackends(() => assert.fail('Unexpected proxy lookup')), []);
  const { startHub } = await import('./dist/hub.js');
  const hub = startHub({ host: '127.0.0.1', port: 0, webRoot: './web', makeBridge: () => assert.fail('No bridge needed') });
  try {
    await once(hub.server, 'listening');
    const request = (route, method = 'GET', payload) => localFetch(`http://127.0.0.1:${hub.server.address().port}${route}`, {
      method, signal: AbortSignal.timeout(3000),
      headers: { Authorization: 'Bearer optional-integration-fixture', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const config = await request('/api/config');
    const marker = `${process.env.AGENT_SH_HOME}/fixture-app.started`;
    if (spec.restarted) {
      assert.equal(config.status, 200);
      assert.equal(allowsProvider('gemini'), !spec.omitted);
      for (let i = 0; i < 100; i++) {
        const extensions = await request('/api/extensions');
        assert.equal(extensions.status, 200);
        const { features } = await extensions.json();
        assert(features.some(f => f.id === 'quick-prompts' && !f.enabled && f.state === 'inactive'));
        if (features.some(f => f.name === 'Cold-start fixture' && f.state === 'active')) {
          assert.equal(await fs.readFile(marker, 'utf8'), 'started');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.fail('Restored policy did not start the eligible fixture application');
    }
    if (spec.damaged) {
      assert.deepEqual(await (await request('/sessions')).json(), []);
      const checkExtensionsUnavailable = async () => {
        const extensions = await request('/api/extensions');
        assert.equal(extensions.status, 200);
        const { features } = await extensions.json();
        assert(features.some(f => f.id === 'quick-prompts'));
        assert(features.every(f => !f.pluginId && !f.enabled && f.state === 'inactive'));
        await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
        const rejected = await request('/api/extensions/quick-prompts/enabled', 'POST', { enabled: true });
        assert.equal(rejected.status, 503);
      };
      if (spec.registryUnavailable) await checkExtensionsUnavailable();
      assert.deepEqual(await desktopConversationBackends(() => assert.fail('Unexpected proxy lookup')), []);
      assert.equal(config.status, spec.configStatus ?? 500);
      if (config.ok) assert.equal((await config.json()).anyProviderConfigured, false);
      else {
        assert(!config.headers.has('x-ashub-provider-revision'));
        assert(!((await config.text()).includes('FIXTURE_CONTENT_NOT_FOR_LOGS')));
      }
      assert.equal(allowsProvider('gemini'), false);
      if (spec.directory) assert((await fs.stat(file)).isDirectory());
      else {
        assert.equal(await fs.readFile(file, 'utf8'), spec.raw);
        if (!config.ok) {
          const rejected = await request('/api/config', 'PUT', {});
          assert.equal(rejected.status, 500);
          assert.equal(await fs.readFile(file, 'utf8'), spec.raw);
        }
      }
      if (spec.directory) await fs.rmdir(file);
      const repaired = JSON.stringify({ 'ashub.features.disabled': ['quick-prompts'] });
      await fs.writeFile(file, repaired);
      assert.equal((await request('/api/config')).status, 200);
      if (spec.registryUnavailable) await checkExtensionsUnavailable();
      assert.equal(await fs.readFile(file, 'utf8'), repaired);
      assert.equal(allowsProvider('gemini'), false, 'repair must not enable an integration before restart');
      const plugins = await request('/api/plugins');
      assert.equal(plugins.status, 200);
      const { plugins: entries } = await plugins.json();
      const optional = entries.filter(p => p.optional);
      assert.equal(optional.length, spec.omitted ? 0 : 2);
      assert(optional.every(p => p.enabled && p.restartRequired));
    } else {
      assert.equal(config.status, 200);
      assert.equal((await config.json()).anyProviderConfigured, spec.configured);
      assert.equal(allowsProvider('gemini'), spec.geminiAllowed);
    }
  } finally { await hub.shutdown(); }
}

const coldFixtures = [
  { name: 'Gemini settings key only', settings: { providers: { gemini: { apiKey: 'fixture-key' } } } },
  { name: 'Gemini keys.json key only', keys: { gemini: 'fixture-key' } },
  { name: 'enabled Gemini keys.json key only', enabled: true, keys: { gemini: 'fixture-key' } },
  { name: 'enabled DeepSeek environment key', env: { DEEPSEEK_API_KEY: 'fixture-key' }, configured: true },
  { name: 'keyless OpenAI compatible endpoint', missing: true, env: { OPENAI_BASE_URL: 'http://127.0.0.1:1/v1' }, configured: true },
  { name: 'signed-in Codex', codex: true, configured: true },
  { name: 'damaged JSON, Hub first', damaged: true, raw: '{"ashub.integrations.disabled":["google-gemini"],"key":FIXTURE_CONTENT_NOT_FOR_LOGS}' },
  { name: 'damaged JSON, desktop discovery first', damaged: true, desktopFirst: true, raw: '{"key":FIXTURE_CONTENT_NOT_FOR_LOGS}' },
  { name: 'unreadable settings file', damaged: true, directory: true },
  { name: 'invalid settings object', damaged: true, raw: '[]' },
  { name: 'invalid optional integration policy', damaged: true, configStatus: 200, raw: '{"ashub.integrations.disabled":[false]}' },
];

for (const fixture of coldFixtures) test(`cold startup: ${fixture.name}`, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ashub-integration-cold-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/KEY|TOKEN|OPENAI_BASE_URL/i.test(key)) delete env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, AGENT_SH_HOME: home, ASHUB_ACCESS_TOKEN: 'optional-integration-fixture', ...fixture.env });
  const file = path.join(home, 'settings.json');
  const settings = { disabledBuiltins: fixture.codex ? [] : ['codex-provider'],
    ...(!fixture.enabled ? { [setting]: ['google-gemini'] } : {}), ...fixture.settings };
  if (fixture.directory) await fs.mkdir(file);
  else if (!fixture.missing) await fs.writeFile(file, fixture.raw ?? JSON.stringify(settings));
  if (fixture.keys) await fs.writeFile(path.join(home, 'keys.json'), JSON.stringify(fixture.keys));
  if (fixture.codex) {
    await fs.mkdir(path.join(home, 'codex-provider'));
    await fs.writeFile(path.join(home, 'codex-provider', 'auth.json'), JSON.stringify({ access: 'fixture', refresh: 'fixture', accountId: 'fixture', expires: 1 }));
  }
  const registryUnavailable = !!(fixture.damaged && fixture.configStatus !== 200);
  if (registryUnavailable) {
    const plugin = path.join(home, 'extensions', 'cold-fixture');
    await fs.mkdir(plugin, { recursive: true });
    await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'cold-fixture', version: '1.0.0', type: 'module' }));
    await fs.writeFile(path.join(plugin, 'ashub-plugin.json'), JSON.stringify({ schemaVersion: 2, id: 'cold-fixture', name: 'Cold-start fixture',
      entries: { application: 'app.mjs' }, requires: { hostApi: '^1', capabilities: ['application-lifecycle'] } }));
    await fs.writeFile(path.join(plugin, 'app.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(path.join(home, 'fixture-app.started'))}, 'started');
export default () => {};`);
  }
  const geminiAllowed = !omitted && !!(fixture.enabled || fixture.missing);
  const spec = { geminiAllowed, configured: fixture.configured ?? geminiAllowed, ...fixture, omitted, registryUnavailable };
  const invoke = data => spawnSync(process.execPath, ['--input-type=module', '-e', `await (${checkStartup.toString()})(${JSON.stringify(data)});`], {
    cwd: path.resolve(import.meta.dirname, '..'), env, timeout: 10000, encoding: 'utf8',
  });
  const run = invoke(spec);
  assert.equal(run.status, 0, run.error?.message ?? run.stderr);
  if (fixture.damaged) {
    assert.match(run.stderr, /\[integrations\].*settings\.json.*disabled/i);
    assert(!run.stderr.includes('FIXTURE_CONTENT_NOT_FOR_LOGS'));
  }
  if (registryUnavailable) {
    assert.match(run.stderr, /\[extensions\].*settings\.json.*restart/i);
    const restarted = invoke({ restarted: true, omitted });
    assert.equal(restarted.status, 0, restarted.error?.message ?? restarted.stderr);
  }
});

test(omitted ? 'Google-free build preserves history and runs another provider' : 'disabled integrations preserve history and restart settings are reversible', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ashub-integration-runtime-'));
  const settingsFile = path.join(home, 'settings.json');
  process.env.AGENT_SH_HOME = home;
  process.env.ASHUB_ACCESS_TOKEN = 'optional-integration-fixture';
  process.env.ASHUB_EXPERIMENTAL_ANTIGRAVITY_WORKER = '1';
  delete process.env.OPENAI_BASE_URL;
  for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key) && key !== 'ASHUB_ACCESS_TOKEN') delete process.env[key];
  const settings = { disabledBuiltins: ['codex-provider'], defaultProvider: 'gemini',
    providers: {
      gemini: { apiKey: 'disabled-fixture-key', baseURL: 'https://disabled.invalid/v1', models: ['custom-gemini-name'] },
      alternate: { apiKey: 'fixture-key', baseURL: 'https://alternate.invalid/v1', models: ['fixture-model'] },
    },
    ...(!omitted ? { [setting]: ['google-gemini', 'google-antigravity'] } : {}),
  };
  await fs.writeFile(settingsFile, JSON.stringify(settings));
  const data = path.join(home, 'hub-sessions');
  await fs.mkdir(data);
  const saved = [['feed01', 'agent', 'gemini', 'custom-gemini-name'], ['feed02', 'antigravity'], ['feed03', 'agent', undefined, 'gemini-4-neon']];
  for (const [id, kind, provider, model] of saved) {
    await fs.writeFile(path.join(data, id + '.meta.json'), JSON.stringify({ id, kind, provider, model, cwd: home, title: id, startedAt: 1, firstQuery: 'old query',
      ...(kind === 'antigravity' ? { projectWorker: true } : {}) }));
    await fs.writeFile(path.join(data, id + '.replay.jsonl'), `id: 11\ndata: ${JSON.stringify({ meta: { source: id, name: 'agent:response-segment', ts: 1 }, payload: { text: `saved-${id}` } })}\n\n`);
  }
  const { startHub } = await import('../dist/hub.js');
  const { AshBridge } = await import('../dist/bridges/ash.js');
  const { desktopConversationBackends } = await import('../dist/integrations.js');
  const published = await desktopConversationBackends(() => { assert.fail('disabled desktop backend queried proxy'); });
  assert.deepEqual(published, []);
  let launches = 0;
  let live, liveOptions;
  const hub = startHub({ host: '127.0.0.1', port: 0, webRoot: path.resolve(import.meta.dirname, '../web'),
    conversationBackends: published, makeBridge: opts => { launches++; liveOptions = opts; return live = new AshBridge(opts); } });
  t.after(async () => { try { await hub.shutdown(); } finally { await fs.rm(home, { recursive: true, force: true }); } });
  await once(hub.server, 'listening');
  const localFetch = globalThis.fetch;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    assert.equal(new URL(input instanceof Request ? input.url : input).hostname, 'alternate.invalid');
    assert.equal(JSON.parse(init.body).model, 'fixture-model');
    calls++;
    const chunks = [ { choices: [{ delta: { content: 'Alternate answer' }, finish_reason: null }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] } ];
    return new Response(chunks.map(x => `data: ${JSON.stringify(x)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  const call = (route, method = 'GET', body, signal) => localFetch(`http://127.0.0.1:${hub.server.address().port}${route}`, {
    method, headers: { Authorization: 'Bearer optional-integration-fixture', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const json = async (...args) => {
    const r = await call(...args); assert(r.ok, `${args[0]} ${r.status}: ${await r.clone().text()}`); return r.json();
  };
  assert.deepEqual(await json('/integrations'), { conversationBackends: [] });
  assert.equal((await call('/api/models/gemini')).status, 404);
  assert.equal((await call('/sessions', 'POST', { cwd: home, kind: 'antigravity' })).status, 403);
  const sessions = await json('/sessions');
  for (const [id, kind, provider, model] of saved) {
    const row = sessions.find(s => s.instanceId === id);
    assert.equal(row.provider, provider ?? (model ? 'gemini' : undefined));
    assert.equal(row.kind, kind);
    assert(row.backendUnavailable);
    const context = await json(`/${id}/context`);
    assert.equal(context.messages[0].content, `saved-${id}`);
    assert.equal(context.readOnly, true);
    assert.equal((await call(`/${id}/submit`, 'POST', { query: 'do not send' })).status, 503);
  }
  assert.equal(launches, 0);
  const streamSignal = AbortSignal.timeout(3000);
  const stream = await call('/events?subs=feed02:100', 'GET', undefined, streamSignal);
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let replay = '';
  try {
    while (!replay.includes('hub:replay-done')) {
      const { value, done } = await reader.read();
      if (done) break;
      replay += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
  assert.match(replay, /saved-feed02/);
  assert.match(replay, /"backendUnavailable":/);
  const plugins = async () => (await json('/api/plugins')).plugins.filter(p => [gemini, antigravity].includes(p.id));
  assert.equal((await plugins()).length, omitted ? 0 : 2);
  if (!omitted) {
    const current = await plugins(); assert(current.every(p => p.optional && !p.enabled && !p.restartRequired));
    const changed = await json('/api/plugins', 'PUT', { id: gemini, enabled: true });
    assert(changed.plugins.some(p => p.id === gemini && p.enabled && p.restartRequired));
    assert.equal((await call('/api/models/gemini')).status, 404, 'runtime availability must not change until restart');
    const reverted = await json('/api/plugins', 'PUT', { id: gemini, enabled: false });
    assert(reverted.plugins.some(p => p.id === gemini && !p.enabled && !p.restartRequired));
    assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')).providers, settings.providers);
  }
  const { instanceId } = await json('/sessions', 'POST', { cwd: home });
  assert.equal(launches, 1);
  assert.equal((await call(`/${instanceId}/backend`, 'POST', { kind: 'antigravity' })).status, 403);
  assert(!(await live.getModels()).models.some(m => m.provider === 'gemini'));
  await live.submit('Use only another provider');
  assert.equal(calls, 1);
  const [{ id: projectId }] = await json('/api/projects', 'POST', { action: 'create', name: 'Fixture', cwd: home, add: [instanceId, 'feed02'] });
  assert.deepEqual((await liveOptions.hostAccess.catalog()).projectSessionBackends, []);
  await assert.rejects(liveOptions.hostAccess.execute({ idempotencyKey: 'omitted-worker-fixture', operations: [{ type: 'conversation.createProjectWorker',
    input: { projectId, title: 'Unavailable reviewer', backend: 'google-antigravity' } }] }, () => assert.fail('Missing backend must not prompt')), /backend unavailable/);
  await assert.rejects(liveOptions.conversationAccess.send('feed02', 'Do not deliver'), /backend unavailable/);
  assert.equal(launches, 1, 'reading old records and rejecting missing workers must not launch another backend');
});
