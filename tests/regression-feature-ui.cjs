const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const moduleAt = file => import(pathToFileURL(path.join(root, 'web/js/extensions', file)));
const definitions = [{ id: 'quick-prompts', name: 'Prompts' }, { id: 'skills-marketplace', name: 'Skills' }];
const feature = (id = 'quick-prompts', enabled = true) => ({ id, name: id, scope: 'frontend', state: enabled ? 'active' : 'inactive', enabled });
const snapshot = features => ({ version: 1, features });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const ui = () => ({ version: 1, panels: [{ id: 'overview', title: 'Overview', components: [
  { type: 'text', text: '<img src=x onerror=alert(1)>' },
  { type: 'action', action: 'composer.insert', label: 'Insert', value: 'A draft' },
  { type: 'form', id: 'settings', fields: [{ id: 'limit', label: 'Limit', type: 'number', value: 5, min: 1, max: 10 }] },
] }] });

test('old host keeps defaults only on explicit missing endpoint; no toggle writes', async () => {
  const { FeatureRegistry } = await moduleAt('feature-registry.js');
  for (const status of [404, 405, 501]) {
    const registry = new FeatureRegistry(definitions, { request: async () => response({}, status) });
    await registry.refresh(); assert.equal(registry.snapshot().supported, false); assert.equal(registry.enabled('quick-prompts'), true);
    await assert.rejects(registry.setEnabled('quick-prompts', false), /unavailable/);
  }
  const registry = new FeatureRegistry(definitions, { request: async () => response({}, 403) });
  await registry.refresh(); assert.equal(registry.snapshot().supported, null); assert.match(registry.snapshot().error, /403/);
});
test('host catalog is authoritative; missing features disabled and metadata cannot execute code', async () => {
  const { FeatureRegistry } = await moduleAt('feature-registry.js');
  let imports = 0;
  const registry = new FeatureRegistry([{ ...definitions[0], load: () => { imports++; return {}; } }, definitions[1]], { request: async () => response(snapshot([{ ...feature(), module: 'https://evil.invalid/code.js' }])) });
  await registry.refresh(); assert.equal(registry.enabled('skills-marketplace'), false); assert.equal(imports, 0);
  assert.equal(registry.snapshot().features[0].module, undefined); await registry.load('quick-prompts'); assert.equal(imports, 1);
});
test('network failure or disappearing endpoint never re-enables a disabled feature', async () => {
  const { FeatureRegistry } = await moduleAt('feature-registry.js');
  let status = 200;
  const registry = new FeatureRegistry(definitions, { request: async () => response(snapshot([feature('quick-prompts', false)]), status) });
  await registry.refresh(); status = 404; await registry.refresh(); assert.equal(registry.enabled('quick-prompts'), false); assert.equal(registry.snapshot().supported, true);
});
test('late GET cannot overwrite POST and duplicate writes are rejected', async () => {
  const { FeatureRegistry } = await moduleAt('feature-registry.js');
  const pending = deferred(), write = deferred(); let calls = 0;
  const registry = new FeatureRegistry(definitions, { request: async (url, options) => {
    if (options?.method) return write.promise;
    calls++; return calls === 1 ? response(snapshot([feature()])) : calls === 2 ? pending.promise : response(snapshot([feature('quick-prompts', false)]));
  } });
  await registry.refresh(); const old = registry.refresh(); const update = registry.setEnabled('quick-prompts', false);
  await assert.rejects(registry.setEnabled('quick-prompts', true), /in progress/);
  write.resolve(response({ ok: true })); await update; pending.resolve(response(snapshot([feature()]))); await old;
  assert.equal(registry.enabled('quick-prompts'), false);
});
test('single-flight bundled import cannot reopen a feature disabled while loading', async () => {
  const { FeatureRegistry } = await moduleAt('feature-registry.js');
  const pending = deferred(); let calls = 0;
  const registry = new FeatureRegistry([{ ...definitions[0], load: () => { calls++; return pending.promise; } }]);
  const a = registry.load('quick-prompts'), b = registry.load('quick-prompts'); await Promise.resolve();
  registry.apply(snapshot([feature('quick-prompts', false)])); pending.resolve({ mounted: true });
  assert.equal(await a, null); assert.equal(await b, null); assert.equal(calls, 1);
});
test('invalid catalog update preserves prior state atomically', async () => {
  const { FeatureRegistry } = await moduleAt('feature-registry.js');
  const registry = new FeatureRegistry(definitions);
  registry.apply(snapshot([feature('quick-prompts', false)]));
  assert.throws(() => registry.apply(snapshot([feature(), feature()])), /Invalid/); assert.equal(registry.enabled('quick-prompts'), false);
});
test('declarative schema accepts bounded text/forms/actions and copies caller data', async () => {
  const { validateDeclarativeUI } = await moduleAt('declarative-schema.js');
  const source = ui(), accepted = validateDeclarativeUI(source); source.panels[0].title = 'changed'; assert.equal(accepted.panels[0].title, 'Overview');
});
test('declarative schema rejects executable content, unknown controls, routes and oversized trees', async () => {
  const { validateDeclarativeUI } = await moduleAt('declarative-schema.js');
  for (const component of [
    { type: 'html', html: '<script>bad()</script>' }, { type: 'text', text: 'text', onClick: 'bad()' },
    { type: 'action', action: 'http.post', label: 'Delete', value: '/api/projects' },
    { type: 'action', action: 'composer.insert', label: 'x', value: 'a'.repeat(8001) },
    { type: 'form', id: 'x', fields: [{ id: 'constructor', label: 'x', type: 'text', value: '' }] },
  ]) { const value = ui(); value.panels[0].components = [component]; assert.throws(() => validateDeclarativeUI(value), /Unsupported/); }
  const value = ui(); value.panels = Array(9).fill(value.panels[0]); assert.throws(() => validateDeclarativeUI(value), /Unsupported/);
});
test('config form requires catalog-bound plugin ID and namespace', async () => {
  const { FeatureRegistry } = await moduleAt('feature-registry.js');
  const declaration = ui(); Object.assign(declaration.panels[0].components[2], { mode: 'config', namespace: 'my-plugin' });
  const registry = new FeatureRegistry(definitions);
  registry.apply(snapshot([{ ...feature('example'), ui: declaration, pluginId: 'bound-id', configNamespaces: ['other'] }]));
  assert.equal(registry.snapshot().features.find(item => item.id === 'example').ui, undefined);
  registry.apply(snapshot([{ ...feature('example'), ui: declaration, pluginId: 'bound-id', configNamespaces: ['my-plugin'] }]));
  assert.equal(registry.snapshot().features.find(item => item.id === 'example').pluginId, 'bound-id');
});
test('config forms reuse revision API, preserve undeclared keys, retain conflict draft', async () => {
  const { PluginConfigForm } = await moduleAt('plugin-config-form.js');
  const writes = []; let revision = 'r1', stored = { limit: 4, keep: { secret: 'preserved' } };
  const form = new PluginConfigForm({ pluginId: 'bound-id', namespace: 'my-plugin', allowedNamespaces: ['my-plugin'], fields: ui().panels[0].components[2].fields,
    request: async (url, options) => {
      if (options?.method) {
        const body = JSON.parse(options.body); writes.push(body); assert.equal(url, '/api/plugins/config');
        if (body.revision !== revision) return response({ error: 'changed' }, 409);
        stored = body.config; revision = 'r2';
      } else assert.equal(url, '/api/plugins/config?id=bound-id&namespace=my-plugin');
      return response({ namespace: 'my-plugin', config: stored, revision });
    },
  });
  await form.load(); form.update('limit', 7); await form.save(); assert.deepEqual(stored, { limit: 7, keep: { secret: 'preserved' } }); assert.equal(writes[0].id, 'bound-id');
  form.update('limit', 9); revision = 'r3'; await assert.rejects(form.save()); assert.equal(form.values.limit, 9); assert.equal(form.conflict, true);
  await form.load(); assert.equal(form.values.limit, 7); assert.equal(form.revision, 'r3');
});
test('invalid field values never cause config writes and foreign namespace responses fail closed', async () => {
  const { PluginConfigForm } = await moduleAt('plugin-config-form.js'); let writes = 0;
  const options = { pluginId: 'x', namespace: 'safe', allowedNamespaces: ['safe'], fields: ui().panels[0].components[2].fields };
  assert.throws(() => new PluginConfigForm({ ...options, namespace: 'providers' }), /Unbound/);
  const form = new PluginConfigForm({ ...options, request: async (url, request) => { if (request?.method) writes++; return response({ namespace: 'safe', revision: '1', config: {} }); } });
  await form.load(); form.update('limit', 100); await assert.rejects(form.save(), /Invalid number/); assert.equal(writes, 0);
  form.request = async () => response({ namespace: 'providers', revision: '2', config: {} }); await assert.rejects(form.load(), /Invalid plugin/);
});

test('absent optional defaults match controls and numeric unset remains omitted', async () => {
  const { PluginConfigForm } = await moduleAt('plugin-config-form.js');
  const { validateDeclarativeUI } = await moduleAt('declarative-schema.js');
  const fields = [
    { id: 'label', label: 'Name', type: 'text' },
    { id: 'enabled', label: 'Enabled', type: 'boolean' },
    { id: 'limit', label: 'Limit', type: 'number', min: 2 },
    { id: 'choice', label: 'Choice', type: 'select', options: [{ value: 'first', label: 'First' }] },
  ];
  validateDeclarativeUI({ version: 1, panels: [{ id: 'optional', title: 'Optional', components: [{ type: 'form', id: 'settings', fields }] }] });
  let submitted;
  const form = new PluginConfigForm({ pluginId: 'fixture', namespace: 'safe', allowedNamespaces: ['safe'], fields,
    request: async (_url, options) => {
      if (options?.method) submitted = JSON.parse(options.body).config;
      return response({ namespace: 'safe', revision: '1', config: submitted || {} });
    },
  });
  await form.load();
  assert.deepEqual(form.values, { label: '', enabled: false, limit: undefined, choice: 'first' });
  form.update('label', 'Changed'); await form.save();
  assert.deepEqual(submitted, { label: 'Changed', enabled: false, choice: 'first' });
  assert.equal(Object.hasOwn(submitted, 'limit'), false);
  form.update('limit', NaN); await assert.rejects(form.save(), /Invalid number/);
  assert.equal(Object.hasOwn(submitted, 'limit'), false);
});

test('disabled balance feature drops late results and keeps the model chip usable', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const listeners = [], requests = [], events = new Map(); let enabled = true, rendered = 0;
  const session = { agentInfo: { provider: 'deepseek' }, balanceEl: {} };
  const source = fs.readFileSync(path.join(root, 'web/js/extensions/provider-balance.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ Map, Set, Date, features: { subscribe: fn => listeners.push(fn) }, featureEnabled: () => enabled,
    featuresReady: () => new Promise(() => {}), document: { addEventListener: (name, fn) => events.set(name, fn) },
    fetch: url => new Promise(resolve => requests.push({ url, resolve })),
  });
  vm.runInContext(source + ';globalThis.create=createProviderBalanceUI;', context);
  const view = context.create({ sessions: new Map([['fixture', session]]), refreshModelChip: () => rendered++ });
  const payload = amount => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: amount }] }) });
  const first = view.refreshProviderBalance('deepseek'); requests[0].resolve(payload('10')); await first;
  assert.match(session.balanceEl._balanceLabel, /10/);
  const pending = view.refreshProviderBalance('deepseek'); enabled = false; listeners[0]();
  assert.equal(session.balanceEl._balanceLabel, ''); requests[1].resolve(payload('999')); await pending;
  assert.equal(session.balanceEl._balanceLabel, ''); const count = requests.length; await view.refreshProviderBalance('deepseek'); assert.equal(requests.length, count);
  assert.ok(rendered >= 2); enabled = true; listeners[0]();
  const fresh = requests.find((item, index) => index >= count && item.url.includes('deepseek')); assert.ok(fresh); fresh.resolve(payload('2'));
  await new Promise(resolve => setImmediate(resolve)); assert.match(session.balanceEl._balanceLabel, /2/);
});


test('host invalidations during a toggle read are retained until a fresh catalog is applied', async () => {
  const { FeatureRegistry } = await moduleAt('feature-registry.js');
  const delayed = deferred(); let reads = 0;
  const registry = new FeatureRegistry(definitions, { request: async (_url, options) => {
    if (options?.method) return response({ ok: true });
    return ++reads === 1 ? delayed.promise : response(snapshot([feature('quick-prompts', false), feature('skills-marketplace', false)]));
  } });
  registry.apply(snapshot([feature(), feature('skills-marketplace')]));
  const writing = registry.setEnabled('quick-prompts', false); await new Promise(setImmediate);
  // The independent host event arrives after the first GET captured old state.
  await registry.refresh();
  delayed.resolve(response(snapshot([feature('quick-prompts', false), feature('skills-marketplace', true)])));
  await writing;
  assert.equal(reads, 2); assert.equal(registry.enabled('skills-marketplace'), false);
  assert.equal(registry.snapshot().busy, false);
});

test('failed lifecycle POST still reconciles committed disable state and retains its error', async () => {
  const { FeatureRegistry } = await moduleAt('feature-registry.js');
  let reads = 0;
  const registry = new FeatureRegistry(definitions, { request: async (_url, options) => {
    if (options?.method) return response({ error: 'cleanup failed after disabling' }, 500);
    reads++; return response(snapshot([{ ...feature('quick-prompts', false), state: 'error' }]));
  } });
  registry.apply(snapshot([feature()]));
  await assert.rejects(registry.setEnabled('quick-prompts', false), /cleanup failed/);
  assert.equal(reads, 1); assert.equal(registry.enabled('quick-prompts'), false);
  assert.equal(registry.snapshot().features[0].state, 'error');
  assert.match(registry.snapshot().error, /cleanup failed/); assert.equal(registry.snapshot().busy, false);
});

test('frontend and host enforce the same total UI boundary before a package can install', async () => {
  const { env } = require('./harness.cjs');
  const parse = env().load('src/extensions/manifest.ts').parsePluginManifest;
  const { validateDeclarativeUI } = await moduleAt('declarative-schema.js');
  const declaration = { version: 1, panels: ['one', 'two'].map(id => ({ id, title: id,
    components: Array.from({ length: 17 }, () => ({ type: 'text', text: 'x'.repeat(8000) })),
  })) };
  let excess = JSON.stringify(declaration).length - 262144;
  for (const component of declaration.panels.flatMap(panel => panel.components).reverse()) {
    const trim = Math.min(excess, component.text.length); component.text = component.text.slice(0, component.text.length - trim); excess -= trim;
    if (!excess) break;
  }
  assert.equal(JSON.stringify(declaration).length, 262144);
  const manifest = parse({ schemaVersion: 2, id: 'capacity-test', ui: declaration }, 'capacity-test');
  assert.deepEqual(validateDeclarativeUI(manifest.ui), declaration);
  declaration.panels[1].components[16].text += 'x';
  assert.equal(JSON.stringify(declaration).length, 262145);
  assert.throws(() => parse({ schemaVersion: 2, id: 'capacity-test', ui: declaration }, 'capacity-test'));
  assert.throws(() => validateDeclarativeUI(declaration), /Unsupported/);
});


for (const reason of ['configuration', 'epoch']) test(`host ${reason} invalidation clears balances and rejects late old-account results`, async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const events = new Map(), requests = [];
  const session = { agentInfo: { provider: 'deepseek' }, balanceEl: {} };
  const source = fs.readFileSync(path.join(root, 'web/js/extensions/provider-balance.js'), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({ Map, Set, Date, features: { subscribe() {} }, featureEnabled: () => true,
    featuresReady: () => new Promise(() => {}), document: { addEventListener: (name, fn) => events.set(name, fn) },
    fetch: url => new Promise(resolve => requests.push({ url, resolve })),
  });
  vm.runInContext(source + ';globalThis.create=createProviderBalanceUI;', context);
  const view = context.create({ sessions: new Map([['fixture', session]]), refreshModelChip() {} });
  const payload = amount => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: amount }] }) });
  const first = view.refreshProviderBalance('deepseek'); requests[0].resolve(payload('10')); await first;
  const pending = view.refreshProviderBalance('deepseek');
  const hostChanged = events.get('ash:host-state-changed'); assert.equal(typeof hostChanged, 'function');
  hostChanged({ detail: { reason: 'invalidation', domains: ['projects'] } }); assert.equal(requests.length, 2);
  hostChanged({ detail: { reason, epoch: reason === 'epoch' ? 'new-host' : 'same-host', domains: reason === 'epoch' ? ['sessions','projects','network','extensions','configuration'] : ['configuration'] } });
  assert.equal(session.balanceEl._balanceLabel, '');
  const fresh = requests.find((request, index) => index >= 2 && request.url.includes('deepseek')); assert.ok(fresh);
  fresh.resolve(payload('2')); await new Promise(setImmediate);
  requests[1].resolve(payload('999')); await pending;
  assert.match(session.balanceEl._balanceLabel, /2/); assert.doesNotMatch(session.balanceEl._balanceLabel, /999/);
});
