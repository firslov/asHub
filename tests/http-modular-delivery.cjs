// Cross-layer acceptance: optional features must not become prerequisites for core work.
const { env, Bridge, path, root, fs } = require('./harness.cjs');
const assert = require('node:assert/strict');
const { once } = require('node:events');
(async () => {
  const e = env(); e.context.process.env.ASHUB_TOKEN = 'modular-delivery-fixture';
  const ids = ['quick-prompts', 'skills-marketplace', 'provider-balance', 'mobile-access'];
  const settingsFile = path.join(e.dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ 'ashub.features.disabled': ids, unrelated: { preserved: true } }));
  let hub;
  const boot = async () => {
    hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: opts => new Bridge(opts) });
    await once(hub.server, 'listening');
    return `http://127.0.0.1:${hub.server.address().port}`;
  };
  let base = await boot();
  const headers = { Authorization: 'Bearer modular-delivery-fixture', 'Content-Type': 'application/json', 'x-ashub-local': '1' };
  const request = (route, body, extra = {}) => fetch(base + route, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), ...extra });
  const api = async (route, body) => { const r = await request(route, body); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  try {
    assert.equal((await fetch(base + '/api/extensions')).status, 401);
    assert.equal((await request('/api/extensions/quick-prompts/enabled', { enabled: true }, { headers: { ...headers, Origin: 'https://foreign.invalid' } })).status, 403);
    const features = await api('/api/extensions');
    assert.equal(features.version, 1);
    for (const id of ids) assert.equal(features.features.find(f => f.id === id)?.enabled, false, id);
    for (const route of ['/api/balance?provider=deepseek', '/api/skills', '/api/skills/installed']) {
      assert.equal((await request(route)).status, 409, route);
    }
    const source = await api('/sessions', { cwd: e.dir });
    assert.ok(source.instanceId);
    await api(`/${source.instanceId}/title`, { title: 'Core work without optional plugins' });
    await api('/api/projects', { action: 'create', name: 'Core project', cwd: e.dir, add: [source.instanceId] });
    const projects = await api('/api/projects');
    assert.equal(projects.length, 1); assert.ok(projects[0].sessionIds.includes(source.instanceId));
    await api(`/${source.instanceId}/submit`, { query: 'local fixture only' });
    const conversations = await api('/sessions');
    assert.equal(conversations[0].title, 'Core work without optional plugins');
    assert.equal(conversations[0].projectId, projects[0].id);
    const context = await api(`/${source.instanceId}/context`);
    assert.ok(JSON.stringify(context).includes('local fixture only'));
    const caps = await api('/api/host/capabilities'); assert.ok(caps && typeof caps === 'object');
    const snapshot = await api('/api/host/snapshot');
    assert.ok(snapshot && typeof snapshot === 'object');
    assert.equal(JSON.stringify(snapshot).includes('modular-delivery-fixture'), false);
    const configBefore = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    await api('/api/extensions/quick-prompts/enabled', { enabled: true });
    const config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.deepEqual(config.unrelated, configBefore.unrelated);
    assert.equal(config['ashub.features.disabled'].includes('quick-prompts'), false);
    await api('/api/extensions/quick-prompts/enabled', { enabled: false });
    assert.equal((await api('/sessions')).length, 1);
    await hub.shutdown(); base = await boot();
    const restored = await api('/api/extensions');
    for (const id of ids) assert.equal(restored.features.find(f => f.id === id)?.enabled, false, id);
    assert.equal((await api('/sessions'))[0].title, 'Core work without optional plugins');
    assert.equal((await api('/api/projects'))[0].name, 'Core project');
    console.log('PASS optional features disabled: core conversations/projects/history, auth, settings preservation and restart');
  } finally { await hub.shutdown(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
