import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { ApplicationExtensionRegistry, FEATURES_DISABLED } from '../dist/extensions/application.js';

function fixture(t, definitions, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-app-extensions-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ unrelated: { keep: true } }));
  const registry = new ApplicationExtensionRegistry({ settingsFile: file, definitions, ...options });
  t.after(async () => { await registry.close().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }); });
  return { registry, file, dir };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const next = () => new Promise(resolve => setImmediate(resolve));

test('one instance per registry, serialized toggles and retained settings across restarts', async t => {
  let starts = 0, stops = 0, active = 0;
  const definitions = [{ id: 'sample', name: 'Sample', create() { starts++; assert.equal(++active, 1); return { stop() { stops++; active--; } }; } }];
  const { registry, file } = fixture(t, definitions);
  await Promise.all([registry.start(), registry.start()]); assert.equal(starts, 1);
  await Promise.all([registry.setEnabled('sample', false), registry.setEnabled('sample', true), registry.setEnabled('sample', false)]);
  assert.equal(starts, 2); assert.equal(stops, 2); assert.equal(active, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).unrelated, { keep: true });
  const restarted = new ApplicationExtensionRegistry({ settingsFile: file, definitions });
  await restarted.start(); assert.equal(starts, 2); assert.equal(restarted.snapshot().features[0].enabled, false);
  await restarted.close();
});

test('feature admission protects in-flight effects and disabled feature routes reject', async t => {
  const gate = deferred(); const { registry } = fixture(t, [{ id: 'feature', name: 'Feature' }]);
  await registry.start();
  const pending = registry.run('feature', () => gate.promise);
  await assert.rejects(registry.setEnabled('feature', false), e => e.status === 409);
  gate.resolve('done'); assert.equal(await pending, 'done');
  await registry.setEnabled('feature', false);
  assert.throws(() => registry.requireActive('feature'), e => e.status === 409);
  await assert.rejects(registry.run('feature', () => assert.fail('must not run')), e => e.status === 409);
});

test('crashed factories roll back scoped resources and isolate other features', async t => {
  const cleaned = [];
  const { registry } = fixture(t, [
    { id: 'broken', name: 'Broken', create(ctx) { ctx.onDispose(() => cleaned.push(1)); ctx.onDispose(() => cleaned.push(2)); throw Error('activation exploded'); } },
    { id: 'healthy', name: 'Healthy' },
  ]);
  await registry.start(); assert.deepEqual(cleaned, [2, 1]);
  assert.equal(registry.snapshot().features[0].state, 'error');
  assert.match(registry.snapshot().features[0].error, /activation exploded/);
  registry.requireActive('healthy');
});

test('activation timeout cleans late resources and late returned instance', async t => {
  const gate = deferred(); let stopped = 0, cleaned = 0, lateError;
  const { registry } = fixture(t, [{ id: 'slow', name: 'Slow', async create(ctx) {
    ctx.onDispose(() => cleaned++); await gate.promise;
    try { ctx.onDispose(() => cleaned++); } catch (error) { lateError = error; }
    return { stop() { stopped++; } };
  } }], { timeoutMs: 25 });
  await registry.start(); assert.match(registry.snapshot().features[0].error, /timed out/);
  assert.equal(cleaned, 1); gate.resolve(); await next();
  assert.equal(cleaned, 2); assert.equal(stopped, 1); assert.match(lateError.message, /ended/);
});

test('shutdown aborts an asynchronous startup immediately and never resurrects it', async t => {
  const gate = deferred(), entered = deferred(); let cleaned = 0, stopped = 0;
  const { registry } = fixture(t, [{ id: 'startup', name: 'Startup', async create(ctx) {
    ctx.onDispose(() => cleaned++); entered.resolve(ctx.signal); await gate.promise; return { stop() { stopped++; } };
  } }], { timeoutMs: 1000 });
  const starting = registry.start(); const signal = await entered.promise;
  const closing = registry.close(); assert.equal(signal.aborted, true);
  await Promise.all([starting, closing]); assert.equal(cleaned, 1);
  gate.resolve(); await next(); assert.equal(stopped, 1);
  assert.notEqual(registry.snapshot().features[0].state, 'active');
});

test('dependencies start first, block disable, and cycles fail without factories', async t => {
  const order = [];
  const { registry } = fixture(t, [
    { id: 'child', name: 'Child', dependencies: ['parent'], create() { order.push('child'); } },
    { id: 'parent', name: 'Parent', create() { order.push('parent'); } },
  ]);
  await registry.start(); assert.deepEqual(order, ['parent', 'child']);
  await assert.rejects(registry.setEnabled('parent', false), e => e.status === 409);
  const cycles = fixture(t, [
    { id: 'first', name: 'First', dependencies: ['second'], create() { assert.fail(); } },
    { id: 'second', name: 'Second', dependencies: ['first'], create() { assert.fail(); } },
  ]).registry;
  await cycles.start(); assert(cycles.snapshot().features.every(f => f.state === 'error'));
});

test('failed settings write never discards unrelated data or reports enabled success', async t => {
  let started = 0, stopped = 0;
  const { registry, file } = fixture(t, [{ id: 'persist', name: 'Persist', create() { started++; return { stop() { stopped++; } }; } }]);
  await registry.start(); await registry.setEnabled('persist', false);
  fs.writeFileSync(file, '{broken');
  await assert.rejects(registry.setEnabled('persist', true));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken'); assert.equal(started, 2); assert.equal(stopped, 2);
  assert.equal(registry.snapshot().features[0].enabled, false);
});

test('failed teardown remains durably disabled and reports the cleanup failure', async t => {
  const { registry, file } = fixture(t, [{ id: 'stubborn', name: 'Stubborn', create: () => ({ stop() { throw Error('stop failed'); } }) }]);
  await registry.start(); await assert.rejects(registry.setEnabled('stubborn', false), /stop failed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file))[FEATURES_DISABLED], ['stubborn']);
  assert.equal(registry.snapshot().features[0].enabled, false); assert.equal(registry.snapshot().features[0].state, 'error');
});

test('discovery refresh reconciles install/toggle/uninstall and config-bound metadata', async t => {
  let installed = [], count = 0, stops = 0;
  const { registry } = fixture(t, [], { discover: () => installed }); await registry.start();
  installed = [{ id: 'plugin-abc', name: 'Installed', pluginId: 'abc', configNamespaces: ['settings'], revision: '1', create() { count++; return { stop() { stops++; } }; } }];
  await registry.refresh(); assert.equal(count, 1); assert.equal(registry.snapshot().features[0].pluginId, 'abc');
  await registry.refresh(); assert.equal(count, 1);
  installed = [{ ...installed[0], initiallyEnabled: false }]; await registry.refresh(); assert.equal(stops, 1); assert.equal(registry.snapshot().features[0].enabled, false);
  installed = []; await registry.refresh(); assert.deepEqual(registry.snapshot().features, []);
});

test('HTTP metadata and toggle input validation preserve the core request gate', async t => {
  const { registry } = fixture(t, [{ id: 'test', name: 'Test' }]); await registry.start();
  async function request(method, url, body, local = true) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), { method, url, headers: local ? { 'x-ashub-local': '1' } : {} });
    let status, value;
    const handled = await registry.handle(req, { writeHead(code) { status = code; }, end(data) { value = JSON.parse(data); } });
    return { status, value, handled };
  }
  assert.equal((await request('GET', '/api/extensions')).value.features[0].state, 'active');
  assert.equal((await request('POST', '/api/extensions/test/enabled', '{"enabled":"false"}')).status, 400);
  assert.equal((await request('POST', '/api/extensions/test/enabled', '{"enabled":false,"sourceId":"fake"}')).status, 400);
  assert.equal((await request('POST', '/api/extensions/test/enabled', '{"enabled":false}')).value.features[0].enabled, false);
  assert.equal((await request('GET', '/unrelated')).handled, false);
});


test('discovered startup failures are attempted once and status stays readable while starting', async t => {
  let attempts = 0; const gate = deferred(), entered = deferred();
  const { registry } = fixture(t, [], { discover: () => [
    {id:'plugin-broken',name:'Broken',pluginId:'broken',create(){ attempts++; throw Error('once only'); }},
    {id:'plugin-delayed',name:'Delayed',pluginId:'delayed',async create(){ entered.resolve(); await gate.promise; }}
  ] });
  const startup = registry.start(); await entered.promise;
  const req = Object.assign(Readable.from([]), {method:'GET',url:'/api/extensions',headers:{}});
  let snapshot;
  await registry.handle(req, {writeHead(status){assert.equal(status,200);},end(data){snapshot=JSON.parse(data);}});
  assert.equal(snapshot.features.find(f=>f.id==='plugin-delayed').state,'starting');
  gate.resolve(); await startup; assert.equal(attempts,1);
});

test('shutdown releases dependents before their dependencies', async t => {
  const order = [];
  const {registry}=fixture(t,[
    {id:'child',name:'Child',dependencies:['parent'],create:()=>({stop(){order.push('child');}})},
    {id:'parent',name:'Parent',create:()=>({stop(){order.push('parent');}})},
  ]);
  await registry.start(); await registry.close(); assert.deepEqual(order,['child','parent']);
});


test('shutdown bounds a stuck optional handler and still releases other features', async t => {
  let released = 0;
  const {registry}=fixture(t,[
    {id:'healthy',name:'Healthy',create:()=>({stop(){released++;}})},
    {id:'stuck',name:'Stuck'},
  ],{timeoutMs:25});
  await registry.start(); void registry.run('stuck',()=>new Promise(()=>{}));
  await assert.rejects(registry.close(),/stuck drain timed out/);
  assert.equal(released,1);
  assert.throws(()=>registry.requireActive('stuck'),e=>e.status===409);
});

test('shared failing dependency is attempted only once per startup', async t => {
  let attempts=0;
  const {registry}=fixture(t,[
    {id:'child-one',name:'Child one',dependencies:['parent']},
    {id:'child-two',name:'Child two',dependencies:['parent']},
    {id:'parent',name:'Parent',create(){attempts++;throw Error('dependency failed');}},
  ]);
  await registry.start();assert.equal(attempts,1);
  assert(registry.snapshot().features.every(feature=>feature.state==='error'));
});


test('failed cleanup cannot be overwritten by a second live instance', async t => {
  let active=0;
  const {registry}=fixture(t,[{id:'stubborn',name:'Stubborn',create(){active++;return {stop(){throw Error('still running');}}}}]);
  await registry.start();await assert.rejects(registry.setEnabled('stubborn',false),/still running/);
  await assert.rejects(registry.setEnabled('stubborn',true),/restart the application/);assert.equal(active,1);
});

test('timeout cannot overlap a replacement with its unfinished activation', async t => {
  const gate=deferred();let attempts=0;
  const {registry}=fixture(t,[{id:'slow',name:'Slow',async create(){attempts++;await gate.promise;}}],{timeoutMs:25});
  await registry.start();await registry.setEnabled('slow',false);await assert.rejects(registry.setEnabled('slow',true),/still finishing/);assert.equal(attempts,1);
  gate.resolve();await next();await registry.setEnabled('slow',true);assert.equal(attempts,2);
});

test('dependency replacement stops affected dependents before dependency then reactivates them',async t=>{
  const events=[];let revision='1';
  const definitions=()=>[
    {id:'plugin-parent',pluginId:'parent',name:'Parent',revision,create:()=>{events.push('parent+');return {stop(){events.push('parent-')}}}},
    {id:'plugin-child',pluginId:'child',name:'Child',revision:'1',dependencies:['plugin-parent'],create:()=>{events.push('child+');return {stop(){events.push('child-')}}}},
  ];
  const {registry}=fixture(t,[],{discover:definitions});await registry.start();revision='2';await registry.refresh();
  assert.deepEqual(events,['parent+','child+','child-','parent-','parent+','child+']);
});


test('dependency replacement busy preflight leaves all existing instances running',async t=>{
  const events=[];let revision='1',busy=true;
  const definitions=()=>[
    {id:'plugin-parent',pluginId:'parent',name:'Parent',revision,create:()=>{events.push('parent+');return {stop(){events.push('parent-')}}}},
    {id:'plugin-child',pluginId:'child',name:'Child',revision:'1',dependencies:['plugin-parent'],create:()=>{events.push('child+');return {canStop:()=>!busy,stop(){events.push('child-')}}}},
  ];
  const {registry}=fixture(t,[],{discover:definitions});await registry.start();revision='2';await assert.rejects(registry.refresh(),e=>e.status===409);
  assert.deepEqual(events,['parent+','child+']);busy=false;await registry.refresh();
  assert.deepEqual(events,['parent+','child+','child-','parent-','parent+','child+']);
});


test('cleanup failure freezes its replacement graph while independent replacements finish', async t => {
  const events=[];let revision='1';
  const definitions=()=>[
    {id:'plugin-parent',pluginId:'parent',name:'Parent',revision,create(){events.push('parent+');return {stop(){events.push('parent-')}}}},
    {id:'plugin-child',pluginId:'child',name:'Child',revision:'1',dependencies:['plugin-parent'],create(){events.push('child+');return {stop(){events.push('child-');throw Error('child cleanup failed')}}}},
    {id:'plugin-independent',pluginId:'independent',name:'Independent',revision,create(){events.push('independent+');return {stop(){events.push('independent-')}}}},
  ];
  const {registry}=fixture(t,[],{discover:definitions});await registry.start();revision='2';
  await assert.rejects(registry.refresh(),/child cleanup failed/);
  await registry.refresh();
  assert.equal(events.filter(x=>x==='parent+').length,1);
  assert.equal(events.filter(x=>x==='child+').length,1);
  assert.equal(events.includes('parent-'),false,'failed child may still reference parent resources');
  assert.equal(events.filter(x=>x==='independent+').length,2);
  registry.requireActive('plugin-independent');
  for(const id of ['plugin-parent','plugin-child']) {
    assert.throws(()=>registry.requireActive(id),e=>e.status===409);
    await assert.rejects(registry.setEnabled(id,true),/restart the application/);
  }
  await assert.rejects(registry.close(),/child cleanup failed/);
  assert.equal(events.filter(x=>x==='parent-').length,1,'shutdown still releases retained healthy dependency');
});


for (const fails of [false, true]) test(`replacement reserves admission while dependent cleanup ${fails ? 'fails' : 'finishes'}`, async t => {
  const entered=deferred(),gate=deferred();let revision='1',calls=0,parentStops=0;
  const definitions=()=>[
    {id:'plugin-peer',pluginId:'peer',name:'Peer',revision,create:()=>({})},
    {id:'plugin-parent',pluginId:'parent',name:'Parent',revision,create:()=>({stop(){parentStops++}})},
    {id:'plugin-child',pluginId:'child',name:'Child',revision:'1',dependencies:['plugin-parent'],create:()=>({async stop(){entered.resolve();await gate.promise;if(fails)throw Error('fixture stop failure')}})},
  ];
  const {registry}=fixture(t,[{id:'healthy',name:'Healthy'}],{discover:definitions});
  await registry.start();revision='2';
  const refreshing=registry.refresh();
  const completion=fails ? assert.rejects(refreshing,/fixture stop failure/) : refreshing;
  await entered.promise;
  try {
    await assert.rejects(registry.run('plugin-parent',()=>{calls++}),e=>e.status===409);
    assert.equal(calls,0,'no new operation may enter after replacement preflight');
    assert.equal(registry.isPluginBusy('peer'),true,'installer must not replace another affected package during this refresh');
    await assert.rejects(registry.run('plugin-peer',()=>{calls++}),e=>e.status===409);
    assert.equal(parentStops,0,'dependency stays alive until dependent stop finishes');
    assert.equal(await registry.run('healthy',()=> 'available'),'available');
  } finally {gate.resolve();await completion;}
  await registry.refresh();
  if(fails) {
    await assert.rejects(registry.run('plugin-parent',()=>{calls++}),e=>e.status===409);
    assert.equal(parentStops,0,'failed cleanup retains its dependency');
  } else {
    await registry.run('plugin-parent',()=>{calls++});
    assert.equal(calls,1,'replacement must not retain the old admission guard');
    assert.equal(parentStops,1);
    assert.equal(registry.isPluginBusy('parent'),false);
  }
  assert.equal(registry.isPluginBusy('peer'),false,'independent replacement releases its guard even after another cleanup fails');
  registry.requireActive('plugin-peer');
  await registry.setEnabled('healthy',false);await registry.setEnabled('healthy',true);
  assert.equal(await registry.run('healthy',()=> 'available'),'available');
});
