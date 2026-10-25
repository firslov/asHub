const { env, Bridge, fs, path, root } = require('./harness.cjs');
const assert = require('node:assert/strict');
const { once } = require('node:events');
(async () => {
  const e = env(); e.context.process.env.ASHUB_TOKEN = 'plugin-test';
  const configDir = e.dir;
  fs.mkdirSync(path.join(configDir, 'extensions'));
  fs.writeFileSync(path.join(configDir, 'extensions', 'sample.mjs'), 'throw new Error("listing must not import")');
  const plugin = e.load('src/plugins.ts').pluginCatalog(path.join(configDir, 'settings.json'))[0];
  const hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: o => {
    const b = new Bridge(o); b.getPluginStatus = () => [{ id: plugin.id, name: 'sample', state: 'loaded' }]; return b;
  } });
  await once(hub.server, 'listening');
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const headers = { Authorization: 'Bearer plugin-test', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/api/plugins')).status, 401);
    assert.equal((await fetch(base + '/api/plugins', { method: 'PUT', headers: { ...headers, Origin: 'https://foreign.invalid' }, body: '{}' })).status, 403);
    let r = await fetch(base + '/api/plugins', { headers }); let data = await r.json();
    assert.equal(data.plugins.filter(p => !p.builtin).length, 1); assert(data.plugins.some(p => p.builtin && p.name === 'OpenAI')); assert.equal(data.plugins[0].sessions.length, 0);
    await fetch(base + '/sessions', { method: 'POST', headers, body: JSON.stringify({ cwd: e.dir }) });
    r = await fetch(base + '/api/plugins', { headers }); data = await r.json();
    assert.equal(data.plugins[0].sessions[0].state, 'loaded');
    r = await fetch(base + '/api/plugins', { method: 'PUT', headers, body: JSON.stringify({ id: plugin.id, enabled: false }) });
    assert.equal(r.status, 200); data = await r.json();
    assert.equal(data.plugins[0].enabled, false); assert.equal(data.plugins[0].sessions[0].state, 'loaded');
    r = await fetch(base + '/api/config', { method: 'PUT', headers, body: JSON.stringify({ test: true }) }); assert.equal(r.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json')))['ashub.plugins.disabled'][0], plugin.id);
    for (const body of [{ id: plugin.id, enabled: 'false' }, { id: 'missing', enabled: true }, null]) {
      assert.equal((await fetch(base + '/api/plugins', { method: 'PUT', headers, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal((await fetch(base + '/api/plugins', { method: 'PUT', headers, body: JSON.stringify({ id: 'builtin:agent', enabled: false }) })).status, 400);
    const nativeURL = base + '/api/plugins/config?id=builtin:provider:openai&namespace=providers.openai';
    const native = await (await fetch(nativeURL, { headers })).json();
    const nativeSave = await fetch(base + '/api/plugins/config', { method: 'PUT', headers, body: JSON.stringify({ id: 'builtin:provider:openai', namespace: 'providers.openai', config: { defaultModel: 'fixture' }, revision: native.revision }) });
    assert.equal(nativeSave.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json'))).providers.openai.defaultModel, 'fixture');
    assert.equal((await fetch(base + '/api/plugins/config?id=builtin:provider:openai&namespace=providers.deepseek', { headers })).status, 400);
    const codex = await (await fetch(base + '/api/plugins/config?id=builtin:codex-provider&namespace=codex-provider', { headers })).json();
    const beforeCodex = fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8');
    const invalidCodex = await fetch(base + '/api/plugins/config', { method: 'PUT', headers, body: JSON.stringify({ id: 'builtin:codex-provider', namespace: 'codex-provider', config: { models: 'example-model' }, revision: codex.revision }) });
    assert.equal(invalidCodex.status, 400);
    assert.match(await invalidCodex.text(), /codex-provider.models/);
    assert.equal(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8'), beforeCodex);
    const configURL = base + '/api/plugins/config?id=' + plugin.id + '&namespace=sample';
    assert.equal((await fetch(configURL)).status, 401);
    assert.equal((await fetch(configURL, { method: 'PUT', headers: { ...headers, Origin: 'https://foreign.invalid' }, body: '{}' })).status, 403);
    let config = await (await fetch(configURL, { headers })).json();
    assert.deepEqual(config.config, {});
    let saved = await fetch(base + '/api/plugins/config', { method: 'PUT', headers, body: JSON.stringify({ id: plugin.id, namespace: 'sample', config: { endpoint: 'https://fixture.invalid', limit: 3 }, revision: config.revision }) });
    assert.equal(saved.status, 200); assert.equal(saved.headers.get('cache-control'), 'no-store');
    const stale = await fetch(base + '/api/plugins/config', { method: 'PUT', headers, body: JSON.stringify({ id: plugin.id, namespace: 'sample', config: {}, revision: config.revision }) });
    assert.equal(stale.status, 409);
    assert.equal((await fetch(base + '/api/plugins/config?id=' + plugin.id + '&namespace=providers', { headers })).status, 400);
    assert.equal((await fetch(base + '/api/plugins/config', { method: 'PUT', headers, body: JSON.stringify({ id: plugin.id, namespace: 'sample', config: [], revision: config.revision }) })).status, 400);
    config = await (await fetch(configURL, { headers })).json(); assert.equal(config.config.limit, 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, 'settings.json')))['ashub.plugins.disabled'][0], plugin.id);
    console.log('PASS plugin config HTTP: auth, namespace isolation, JSON validation, conflict protection');
    console.log('PASS plugin HTTP: authentication, origin, status, toggle, stale config, validation');
  } finally { await hub.shutdown(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
