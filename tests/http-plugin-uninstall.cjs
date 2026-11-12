const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { env, Bridge, fs, path, root } = require('./harness.cjs');

for (const waitForOtherPlugin of [false, true]) for (const failInitialization of [false, true]) test(`uninstall cannot miss an unpublished conversation; initialization releases its reservation (other=${waitForOtherPlugin}, failure=${failInitialization})`, { timeout: 15000 }, async () => {
  const e = env({ globals: { setTimeout, clearTimeout, setInterval, clearInterval, Date } });
  process.env.AGENT_SH_HOME = e.dir;
  for (const key of Object.keys(process.env)) if (/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
  const { PluginRuntime, preparePluginRegistrations } = await import(pathToFileURL(path.join(root, 'dist/plugin-runtime.js')));
  const repoRequire = createRequire(path.join(root, 'package.json'));
  const { createCore } = await import(pathToFileURL(repoRequire.resolve('agent-sh')));
  const { activateAgent } = await import(pathToFileURL(repoRequire.resolve('agent-sh/agent')));
  const directory = path.join(e.dir, 'extensions', 'uninstall-fixture');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'uninstall-fixture', version: '1.0.0', type: 'module' }));
  fs.writeFileSync(path.join(directory, 'ashub-plugin.json'), JSON.stringify({ schemaVersion: 2, id: 'uninstall-fixture', entries: { session: 'index.mjs' } }));
  const gateKey = '__ashubUninstallTest_' + path.basename(e.dir);
  fs.writeFileSync(path.join(directory, 'index.mjs'), `export default async ctx => {
    ctx.agent.registerTool({name:'uninstall_probe', description:'Offline fixture', input_schema:{type:'object',properties:{}}, execute:async()=>({content:'fixture'})});
    ${waitForOtherPlugin ? '' : `globalThis[${JSON.stringify(gateKey)}].enter(); await globalThis[${JSON.stringify(gateKey)}].wait;`}
  };`);
  if (waitForOtherPlugin) {
    const other = path.join(e.dir, 'extensions', 'zz-wait-fixture'); fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'wait-fixture', version: '1.0.0', type: 'module' }));
    fs.writeFileSync(path.join(other, 'ashub-plugin.json'), JSON.stringify({ schemaVersion: 2, id: 'wait-fixture', entries: { session: 'index.mjs' } }));
    fs.writeFileSync(path.join(other, 'index.mjs'), `export default async ctx => {
      ctx.agent.registerTool({name:'unrelated_probe', description:'Offline fixture', input_schema:{type:'object',properties:{}}, execute:async()=>({content:'fixture'})});
      globalThis[${JSON.stringify(gateKey)}].enter(); await globalThis[${JSON.stringify(gateKey)}].wait;
    };`);
  }
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
  globalThis[gateKey] = { enter, wait };
  const pluginId = e.load('src/plugins.ts').pluginCatalog(path.join(e.dir, 'settings.json')).find(p => p.packageName === 'uninstall-fixture').id;
  let bridge, pending;
  const hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: options => {
    const b = new Bridge(options); bridge = b;
    const core = createCore({ apiKey: 'offline-test-only', baseURL: 'http://127.0.0.1:1/v1', model: 'offline' });
    const context = core.extensionContext({ quit() {} });
    preparePluginRegistrations(context); activateAgent(context); preparePluginRegistrations(context);
    const runtime = new PluginRuntime(path.join(e.dir, 'settings.json'));
    const ready = runtime.load(context).then(() => { if (failInitialization) throw Error('Fixture backend initialization failed'); });
    b.ready = () => ready;
    b.getPluginStatus = () => runtime.status;
    b.uninstallPlugin = id => runtime.uninstall(id);
    b.close = () => { b.wasClosed = true; runtime.close(); core.kill(); b.emit('closed'); };
    b.hasProbe = () => context.agent.getTools().some(tool => tool.name === 'uninstall_probe');
    b.hasOtherProbe = () => context.agent.getTools().some(tool => tool.name === 'unrelated_probe');
    return b;
  }});
  if (!hub.server.listening) await once(hub.server, 'listening');
  const base = 'http://127.0.0.1:' + hub.server.address().port;
  const api = async (route, body, method = 'POST') => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.text() };
  };
  try {
    pending = api('/sessions', { cwd: e.dir, kind: 'agent' });
    await entered;
    assert.equal(bridge.getPluginStatus().find(plugin => plugin.id === pluginId).state, waitForOtherPlugin ? 'loaded' : 'loading');
    assert.equal(JSON.parse((await api('/sessions', undefined, 'GET')).body).length, 0, 'unfinished conversations stay out of the public list');
    const settings = path.join(e.dir, 'settings.json');
    const settingsBefore = fs.existsSync(settings) ? fs.readFileSync(settings) : null;
    const blocked = await api('/api/plugins', { id: pluginId }, 'DELETE');
    assert.equal(blocked.status, 409, 'uninstall must see the unpublished initializing bridge');
    assert.match(blocked.body, /等待会话初始化完成后再卸载/);
    assert(fs.existsSync(directory), 'a rejected uninstall must preserve the installed package');
    assert.deepEqual(fs.existsSync(settings) ? fs.readFileSync(settings) : null, settingsBefore, 'a rejected uninstall must not change settings bytes');
    release();
    const created = await pending;
    assert.equal(created.status, failInitialization ? 500 : 200, created.body);
    assert.equal(bridge.hasProbe(), !failInitialization, 'failed initialization cleans the partially loaded kernel');
    const removed = await api('/api/plugins', { id: pluginId }, 'DELETE');
    assert.equal(removed.status, 200, removed.body);
    assert(!fs.existsSync(directory));
    assert(!bridge.hasProbe(), 'successful uninstall leaves no plugin tool in the published kernel');
    if (failInitialization) assert.equal(bridge.wasClosed, true, 'the failed kernel is closed and never published');
    else assert(!bridge.getPluginStatus().some(plugin => plugin.id === pluginId));
    assert.equal(bridge.hasOtherProbe(), waitForOtherPlugin && !failInitialization, 'uninstall leaves other plugins in the completed kernel intact');
    assert.equal(JSON.parse((await api('/sessions', undefined, 'GET')).body).length, failInitialization ? 0 : 1, 'uninstall preserves completed conversations');
  } finally {
    release();
    await pending?.catch(() => {});
    await hub.shutdown();
    delete globalThis[gateKey];
  }
});
