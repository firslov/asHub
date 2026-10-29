const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { env, Bridge, path, fs } = require('./harness.cjs');
const { zip } = require('./plugin-zip-fixture.cjs');
const http = require('node:http');

async function fixture(extra = {}) {
  const e = env(extra);
  extra.beforeBoot?.(e);
  const instances = [];
  const { startHub } = e.load('src/hub.ts');
  const app = startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(__dirname, '..', 'web'),
    makeBridge: options => { const bridge = new Bridge(options); instances.push(bridge); return bridge; } });
  if (!app.server.listening) await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const api = async (route, body, method) => {
    const response = await fetch(base + route, { method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Origin: base, 'Content-Type': 'application/json', 'x-ashub-local': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, value: (() => { try { return JSON.parse(text); } catch { return text; } })() };
  };
  return { e, app, api, base, instances };
}

test('real host snapshots/invalidations agree with legacy routes and optional feature toggles preserve core data', async () => {
  const f = await fixture();
  let eventReader;
  try {
    // Startup is intentionally independent from the core listener. Let the
    // bundled factories settle before exercising their feature-specific routes.
    await new Promise(resolve => setImmediate(resolve));
    const cap = await f.api('/api/host/capabilities'); assert.equal(cap.status, 200);
    assert.equal(cap.value.approval, 'source-bound-explicit');
    const initial = (await f.api('/api/host/snapshot')).value;
    const streaming = await fetch(f.base + '/api/host/events'); eventReader = streaming.body.getReader();
    const ready = new TextDecoder().decode((await eventReader.read()).value);
    assert.match(ready, /event: snapshot/); assert(ready.includes(initial.epoch));
    const created = await f.api('/sessions', { cwd: f.e.dir, kind: 'agent' }); assert.equal(created.status, 200);
    const id = created.value.instanceId;
    assert(id);
    const project = await f.api('/api/projects', { action: 'create', name: 'Review', cwd: f.e.dir, add: [id] });
    assert.equal(project.status, 200);
    const snapshot = (await f.api('/api/host/snapshot')).value;
    assert(snapshot.revision > initial.revision);
    assert.deepEqual(snapshot.sessions, (await f.api('/sessions')).value);
    assert.deepEqual(snapshot.projects, (await f.api('/api/projects')).value);
    assert.equal(snapshot.sessions[0].projectId, project.value[0].id);
    assert(!JSON.stringify(snapshot).includes('fake-test-key'));
    const packet = new TextDecoder().decode((await eventReader.read()).value);
    assert.match(packet, /event: invalidation/);
    await eventReader.cancel(); eventReader = undefined;
    for (const feature of ['quick-prompts', 'skills-marketplace', 'provider-balance', 'mobile-access']) {
      const response = await f.api('/api/extensions/' + feature + '/enabled', { enabled: false });
      assert.equal(response.status, 200, JSON.stringify(response.value));
    }
    assert.equal((await f.api('/api/skills/installed')).status, 409);
    assert.equal((await f.api('/api/balance?provider=fixture')).status, 409);
    const mobile = await f.api('/api/mobile');
    assert.equal(mobile.status, 200); assert.equal(mobile.value.featureEnabled, false);
    assert.equal((await f.api('/api/mobile/enable', {})).status, 409);
    assert.equal((await f.api('/api/projects')).value[0].sessionIds[0], id);
    assert.equal((await f.api('/' + id + '/submit', { query: 'Fixture core-only turn' })).status, 200);
    assert.equal((await f.api('/' + id + '/cancel', {})).status, 200);
    assert.equal((await f.api('/' + id + '/context')).status, 200);
    const reenabled = await f.api('/api/extensions/provider-balance/enabled', { enabled: true });
    assert.equal(reenabled.status, 200);
    assert.equal((await f.api('/api/balance?provider=fixture')).status, 200, 'ordinary disable must not permanently close the service');
    assert(fs.existsSync(path.join(f.e.dir, 'hub-sessions', id + '.meta.json')));
  } finally { await eventReader?.cancel(); await f.app.shutdown(); }
});

test('slow optional extension startup does not block real core HTTP queries', async () => {
  // Replace only the application registry dependency to keep an optional
  // startup unresolved. This exercises the actual startHub/HTTP path.
  class SlowRegistry {
    constructor() {}
    start() { return new Promise(() => {}); }
    snapshot() { return { version: 1, features: [{ id: 'slow-fixture', enabled: true, state: 'starting', scope: 'application' }] }; }
    async handle() { return false; }
    async run() { const error = Error('Feature is starting'); error.status = 409; throw error; }
    async close() {}
  }
  const f = await fixture({ modules: { './extensions/application.js': { ApplicationExtensionRegistry: SlowRegistry } } });
  try {
    const response = await Promise.race([f.api('/sessions'), new Promise((_, reject) => setTimeout(() => reject(Error('core blocked by optional startup')), 1500))]);
    assert.equal(response.status, 200);
    assert.deepEqual(response.value, []);
    assert.equal((await f.api('/api/balance?provider=fixture')).status, 409);
    assert.equal((await f.api('/api/host/snapshot')).value.extensions.features[0].state, 'starting');
  } finally { await f.app.shutdown(); }
});

test('failed optional cleanup still closes HTTP and flushes durable core session metadata', async () => {
  class FailingRegistry {
    start() { return Promise.resolve(); }
    snapshot() { return { version: 1, features: [] }; }
    async handle() { return false; }
    async run(_id, fn) { return fn(); }
    async close() { throw Error('fixture optional cleanup failed'); }
  }
  const f = await fixture({ modules: { './extensions/application.js': { ApplicationExtensionRegistry: FailingRegistry } } });
  try {
    const created = await f.api('/sessions', { cwd: f.e.dir, kind: 'agent' });
    const id = created.value.instanceId;
    assert.equal((await f.api('/' + id + '/title', { title: 'Keep durable metadata' })).status, 200);
    let closed = false; f.instances[0].once('closed', () => { closed = true; });
    await assert.rejects(f.app.shutdown(), /extension cleanup failed/i);
    assert.equal(f.app.server.listening, false, 'optional cleanup failure must not leave the core listener running');
    const saved = JSON.parse(fs.readFileSync(path.join(f.e.dir, 'hub-sessions', id + '.meta.json'), 'utf8'));
    assert.equal(saved.title, 'Keep durable metadata');
    assert.equal(closed, true, 'session bridge must be torn down after optional cleanup failure');
  } finally { await f.app.shutdown().catch(() => {}); }
});

test('shutdown closes an incomplete extension toggle upload without changing settings', { timeout: 6000 }, async () => {
  const f = await fixture({ globals: { setTimeout, clearTimeout, setInterval, clearInterval },
    beforeBoot(e) { fs.writeFileSync(path.join(e.dir, 'settings.json'), JSON.stringify({ unrelated: { keep: true } })); } });
  const file = path.join(f.e.dir, 'settings.json');
  let upload, closing, deadline;
  try {
    assert.equal((await f.api('/api/extensions')).status, 200);
    const before = fs.readFileSync(file, 'utf8');
    const arrived = new Promise(resolve => f.app.server.once('request', request => request.once('data', () => resolve(request))));
    const body = JSON.stringify({ enabled: false });
    upload = http.request(f.base + '/api/extensions/quick-prompts/enabled', { method: 'POST',
      headers: { Origin: f.base, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } });
    upload.on('error', () => {});
    const clientClosed = new Promise(resolve => upload.once('close', resolve));
    upload.write(body.slice(0, 6));
    const request = await arrived;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(request.complete, false);
    closing = f.app.shutdown();
    await Promise.race([closing, new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('shutdown waited for an incomplete extension upload')), 1000); })]);
    clearTimeout(deadline); deadline = undefined;
    await clientClosed;
    assert.equal(upload.destroyed, true);
    assert.equal(request.destroyed, true);
    const connections = await new Promise((resolve, reject) => f.app.server.getConnections((error, count) => error ? reject(error) : resolve(count)));
    assert.equal(connections, 0, 'shutdown must close the upload socket, beyond stopping the listener');
    upload.end(body.slice(6));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'a cancelled or late body must not persist a toggle');
  } finally {
    clearTimeout(deadline); upload?.destroy(); await (closing ?? f.app.shutdown());
  }
});

test('registry shutdown preserves the response of a complete accepted extension toggle', { timeout: 6000 }, async () => {
  const e = env({ globals: { setTimeout, clearTimeout } });
  const file = path.join(e.dir, 'settings.json'); fs.writeFileSync(file, '{}');
  const { ApplicationExtensionRegistry, FEATURES_DISABLED } = e.load('src/extensions/application.ts');
  let releaseStop, enteredStop;
  const stopping = new Promise(resolve => { enteredStop = resolve; });
  const stopGate = new Promise(resolve => { releaseStop = resolve; });
  const registry = new ApplicationExtensionRegistry({ settingsFile: file, definitions: [{ id: 'accepted', name: 'Accepted',
    create: () => ({ stop: async () => { enteredStop(); await stopGate; } }) }] });
  await registry.start();
  let serverRequest;
  const server = http.createServer((request, response) => {
    serverRequest = request;
    void registry.handle(request, response).catch(error => { response.destroy(error); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  let closing;
  try {
    const response = fetch(base + '/api/extensions/accepted/enabled', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    await stopping;
    assert.equal(serverRequest.complete, true);
    closing = registry.close();
    releaseStop();
    const result = await response;
    assert.equal(result.status, 200);
    assert.equal((await result.json()).features[0].enabled, false);
    await closing;
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8'))[FEATURES_DISABLED], ['accepted']);
  } finally {
    releaseStop(); await (closing ?? registry.close());
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

for (const scope of ['application', 'session']) {
  test(`nested ${scope} entry keeps package upgrade blocked while its consumer is busy`, async () => {
    let applicationBusy = false, pluginId, finishTurn;
    // Only application activity is simulated. Catalog/package resolution,
    // upgrade ZIP preview, confirmation and target preservation use the real
    // host/installer; the session case uses a real pending fixture turn.
    class Registry {
      start() { return Promise.resolve(); }
      snapshot() { return { version: 1, features: [] }; }
      async handle() { return false; }
      async run(_id, fn) { return fn(); }
      isPluginBusy(id) { return applicationBusy && id === pluginId; }
      async close() {}
    }
    const f = await fixture({ modules: { './extensions/application.js': { ApplicationExtensionRegistry: Registry } } });
    try {
      const entry = scope === 'application' ? 'app/start.mjs' : 'session/start.mjs';
      const target = path.join(f.e.dir, 'extensions', `nested-${scope}`);
      const manifest = { schemaVersion: 2, id: `nested-${scope}`, name: `Nested ${scope}`, entries: { [scope]: entry } };
      const metadata = version => ({ name: `nested-${scope}`, version, type: 'module', main: entry });
      fs.mkdirSync(path.dirname(path.join(target, entry)), { recursive: true });
      fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(metadata('1.0.0')));
      fs.writeFileSync(path.join(target, 'ashub-plugin.json'), JSON.stringify(manifest));
      fs.writeFileSync(path.join(target, entry), 'export default function activate() {}');
      const { pluginCatalog } = f.e.load('src/plugins.ts');
      const plugin = pluginCatalog(path.join(f.e.dir, 'settings.json')).find(p => p.packageRoot === target);
      assert(plugin); pluginId = plugin.id;
      assert.notEqual(path.dirname(plugin.source), target, 'fixture must reproduce a nested canonical entry');
      if (scope === 'application') applicationBusy = true;
      else {
        const created = await f.api('/sessions', { cwd: f.e.dir, kind: 'agent' });
        assert.equal(created.status, 200);
        const bridge = f.instances[0];
        bridge.getPluginStatus = () => [{ id: pluginId, state: 'loaded' }];
        bridge.submit = () => new Promise(resolve => { finishTurn = resolve; });
        const submitted = await f.api('/' + created.value.instanceId + '/submit', { query: 'hold nested plugin fixture' });
        assert.equal(submitted.status, 200);
        assert.equal((await f.api('/sessions')).value[0].isProcessing, true);
      }
      const archive = zip({
        'release/package.json': JSON.stringify(metadata('2.0.0')),
        'release/ashub-plugin.json': JSON.stringify(manifest),
        ['release/' + entry]: 'export default function activate() {}',
      });
      const response = await fetch(f.base + '/api/plugins/install?action=preview', { method: 'POST',
        headers: { Origin: f.base, 'Content-Type': 'application/zip' }, body: archive });
      assert.equal(response.status, 200);
      const preview = await response.json();
      assert.equal(preview.target, target);
      assert.equal(preview.previousVersion, '1.0.0');
      assert.equal(preview.checks.find(check => check.label === 'inUse')?.ok, false);
      assert.equal(preview.canInstall, false);
      const confirm = await f.api('/api/plugins/install?action=confirm', { token: preview.token });
      assert.equal(confirm.status, 400, 'busy package cannot pass confirmation');
      assert.equal(JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version, '1.0.0');
      if (scope === 'application') applicationBusy = false;
      else { finishTurn({ stopReason: 'done' }); finishTurn = undefined; await new Promise(resolve => setImmediate(resolve)); }
      const refreshed = await f.api('/api/plugins/install?action=preview&id=' + preview.token);
      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.value.checks.find(check => check.label === 'inUse')?.ok, true, 'idle package releases the upgrade guard');
      assert.equal(refreshed.value.canInstall, true);
    } finally {
      finishTurn?.({ stopReason: 'done' });
      await f.app.shutdown();
    }
  });
}

test('shutdown aborts an incomplete skill body and never executes its late installation', async () => {
  let commands = 0, upload, shutdown, timer;
  const f = await fixture({ modules: { 'node:child_process': { ...require('node:child_process'),
    execFile(_file, _args, _options, callback) { commands++; setImmediate(() => callback(Error('unexpected installation command'))); },
  } } });
  try {
    assert.equal((await f.api('/api/skills/installed')).status, 200);
    const body = JSON.stringify({ id: 'github:fixture/late-install' });
    const arrived = new Promise(resolve => f.app.server.once('request', incoming => incoming.once('data', resolve)));
    upload = http.request(f.base + '/api/skills/install', { method: 'POST', headers: {
      Origin: f.base, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    } });
    upload.on('error', () => {});
    upload.write(body.slice(0, 8));
    await arrived; await new Promise(resolve => setImmediate(resolve));
    shutdown = f.app.shutdown();
    await Promise.race([shutdown, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('shutdown waited indefinitely for an incomplete skill request body')), 1000);
    })]);
    clearTimeout(timer);
    assert.equal(f.app.server.listening, false);
    assert.equal(upload.destroyed, true, 'shutdown must close the incomplete upload connection');
    upload.end(body.slice(8));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(commands, 0, 'late body must never start git or install commands');
    assert.equal(fs.existsSync(path.join(f.e.dir, 'skills', 'late-install')), false);
  } finally {
    clearTimeout(timer); upload?.destroy();
    await (shutdown ?? f.app.shutdown()).catch(() => {});
  }
});

test('shutdown preserves a fully submitted skill installation and its final HTTP result', async () => {
  let entered, releaseGit, shutdown;
  const executing = new Promise(resolve => { entered = resolve; });
  const f = await fixture({ modules: { 'node:child_process': { ...require('node:child_process'),
    execFile(_file, args, _options, callback) {
      if (args[0] === '--version') { releaseGit = () => callback(null, 'git fixture', ''); entered(); return; }
      assert.equal(args[0], 'clone');
      const destination = args.at(-1);
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(path.join(destination, 'SKILL.md'), '# Accepted fixture');
      setImmediate(() => callback(null, '', ''));
    },
  } } });
  try {
    assert.equal((await f.api('/api/skills/installed')).status, 200);
    const installing = f.api('/api/skills/install', { id: 'github:fixture/accepted-install' });
    await executing;
    let stopped = false;
    shutdown = f.app.shutdown().then(() => { stopped = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false, 'accepted side effects must finish before core shutdown');
    releaseGit(); releaseGit = undefined;
    const response = await installing;
    assert.equal(response.status, 200); assert.equal(response.value.ok, true);
    await shutdown;
    assert.equal(f.app.server.listening, false);
    assert.equal(fs.readFileSync(path.join(f.e.dir, 'skills', 'accepted-install', 'SKILL.md'), 'utf8'), '# Accepted fixture');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.e.dir, 'skills', 'accepted-install', '.ashub-source.json'), 'utf8')).url, 'https://github.com/fixture/accepted-install.git');
  } finally {
    releaseGit?.();
    await (shutdown ?? f.app.shutdown()).catch(() => {});
  }
});

test('plugin dependency busy rejection leaves settings and live registry unchanged before an idle disable succeeds', async () => {
  const modules = {};
  let registry, release;
  const f = await fixture({ modules, beforeBoot(e) {
    const { ApplicationExtensionRegistry } = e.load('src/extensions/application.ts');
    modules['./extensions/application.js'] = { ApplicationExtensionRegistry: class extends ApplicationExtensionRegistry {
      constructor(options) { super(options); registry = this; }
    } };
    for (const [id, dependencies] of [['busy-base', []], ['busy-dependent', [{ id: 'busy-base', minVersion: '1.0.0' }]]]) {
      const directory = path.join(e.dir, 'extensions', id); fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: id, version: '1.0.0', type: 'module' }));
      fs.writeFileSync(path.join(directory, 'ashub-plugin.json'), JSON.stringify({ schemaVersion: 2, id, name: id, dependencies,
        ui: { version: 1, panels: [{ id: 'overview', title: id, components: [{ type: 'text', text: id }] }] },
      }));
    }
    fs.writeFileSync(path.join(e.dir, 'settings.json'), JSON.stringify({ unrelated: { preserve: true } }));
  } });
  try {
    const metadata = await f.api('/api/extensions'); assert.equal(metadata.status, 200);
    const { pluginCatalog } = f.e.load('src/plugins.ts');
    const catalog = pluginCatalog(path.join(f.e.dir, 'settings.json'));
    const base = catalog.find(p => p.manifest?.id === 'busy-base');
    const dependent = catalog.find(p => p.manifest?.id === 'busy-dependent');
    assert(base && dependent);
    const busy = registry.run('plugin-' + dependent.id, () => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    const file = path.join(f.e.dir, 'settings.json'), before = fs.readFileSync(file, 'utf8');
    const rejected = await f.api('/api/plugins', { id: base.id, enabled: false }, 'PUT');
    assert.equal(rejected.status, 409);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'busy rejection cannot first persist a disabled dependency');
    const unchanged = registry.snapshot().features;
    for (const id of [base.id, dependent.id]) {
      const feature = unchanged.find(value => value.pluginId === id);
      assert.equal(feature.enabled, true); assert.equal(feature.state, 'active');
    }
    release(); release = undefined; await busy;
    const disabled = await f.api('/api/plugins', { id: base.id, enabled: false }, 'PUT');
    assert.equal(disabled.status, 200, JSON.stringify(disabled.value));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(saved['ashub.plugins.disabled'].includes(base.id));
    assert.deepEqual(saved.unrelated, { preserve: true });
    const actual = registry.snapshot().features;
    assert.equal(actual.find(value => value.pluginId === base.id).enabled, false);
    assert.notEqual(actual.find(value => value.pluginId === dependent.id).state, 'active');
  } finally { release?.(); await f.app.shutdown(); }
});
