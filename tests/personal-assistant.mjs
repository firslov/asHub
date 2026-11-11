import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { zip } = require('./plugin-zip-fixture.cjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-integration-'));
process.env.AGENT_SH_HOME = home;
for (const key of Object.keys(process.env)) if (/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
globalThis.fetch = async () => { throw Error('No external network in this test'); };
const { PluginInstaller } = await import('../dist/plugin-installer.js');
const { pluginCatalog } = await import('../dist/plugins.js');
const { PluginRuntime, preparePluginRegistrations } = await import('../dist/plugin-runtime.js');
const { ApplicationExtensionRegistry } = await import('../dist/extensions/application.js');
const { installedApplicationDefinitions } = await import('../dist/extensions/installed.js');
const { pluginDataDirectory } = await import('../dist/extensions/data-directory.js');
const { pluginCompatibility, parsePluginManifest } = await import('../dist/extensions/manifest.js');
const { createCore } = await import('agent-sh');
const { activateAgent } = await import('agent-sh/agent');
const { wrapTrailingWithDynamicContext } = await import('agent-sh/utils/message-utils.js');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('ZIP install, two real session kernels, host UI confirmation, pause and restart', async t => {
  const file = path.join(home, 'settings.json'); fs.writeFileSync(file, '{}');
  const source = new URL('../examples/extensions/personal-assistant/', import.meta.url);
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', source)));
  const files = Object.fromEntries(['package.json', ...pkg.files].map(n => [n, fs.readFileSync(new URL(n, source), 'utf8')]));
  const installer = new PluginInstaller(file); t.after(() => installer.close());
  const preview = await installer.preview(zip(files)); assert(preview.canInstall, JSON.stringify(preview));
  const job = installer.confirm(preview.token);
  for (let i = 0; i < 300 && installer.status(job.id).state === 'running'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(installer.status(job.id).state, 'succeeded', installer.status(job.id).error);
  const entry = pluginCatalog(file)[0], resources = new Map(), snapshot = { sessions: [
    { instanceId: 'a', title: '我的助手', cwd: home, kind: 'agent', projectId: null },
    { instanceId: 'b', title: '普通对话', cwd: home, kind: 'agent', projectId: null },
  ], projects: [] };
  let auto = false;
  const records=[{id:'source1',role:'user',at:Date.now(),text:'用中文写报告，先给结论 幻灯片使用蓝色'}];
  const registry = new ApplicationExtensionRegistry({ settingsFile: file, definitions: [],
    discover: () => installedApplicationDefinitions(file, { bindServices: (_id, context) => ({
      host: { snapshot: () => structuredClone(snapshot) },
      conversations:{register:()=>()=>{},get:()=> 'a',models:()=>[{provider:'mock',model:'tiny'}]},
      background: {status:()=>({includedIds:['a'],excludedIds:[]}),targets:()=>auto?[{...snapshot.sessions[0],id:'a',busy:true}]:[],search:()=>records,entry:(_g,_sid,id)=>{const row=records.find(r=>r.id===id);if(!row)throw Error('History source unavailable');return {...row,offset:0,nextOffset:row.text.length,more:false};},valid:(_g,_id,ids)=>ids,latestUser:()=>records.at(-1).id,revoke:()=>{auto=false;}},
      interactions: { register: (id, resource) => { resources.set(id, resource); return () => resources.delete(id); } },
    }) }),
  });
  t.after(() => registry.close()); await registry.start();
  assert.equal(registry.snapshot().features[0].state, 'active');
  const make = async id => {
    const core = createCore({ apiKey: 'offline-test-only', baseURL: 'http://127.0.0.1:1/v1', model: 'test-model' }), ctx = core.extensionContext({ quit() {} });
    preparePluginRegistrations(ctx); activateAgent(ctx); preparePluginRegistrations(ctx);
    core.handlers.define('session:current-id', () => id);
    const runtime = new PluginRuntime(file); t.after(() => { runtime.close(); core.kill(); });
    assert.deepEqual(await runtime.load(ctx), ['个人助手']);
    core.bus.emit('core:extensions-loaded', { names: [] });
    await core.activateBackend();
    return { ctx, core, runtime, tool: name => ctx.agent.getTools().find(t => t.name === name) };
  };
  const a = await make('a'), b = await make('b'), resource = resources.get('assistant');
  const visible = session => session.core.bus.emitPipe('agent:tools:visible', { tools: session.ctx.agent.getTools() }).tools.map(tool => tool.name);
  const instruction = session => session.core.handlers.call('instruction:personal-assistant');
  assert(!visible(a).some(name => name.startsWith('assistant_memory_')));
  assert.match(instruction(a), /常驻个人助手.*长期记忆未开启/);
  auto=true;const bind=resource.prepare('authorize');assert(bind.preview);bind.execute('grant');
  assert.equal(visible(a).filter(name => name.startsWith('assistant_memory_')).length, 5);
  assert.match(instruction(a), /常驻个人助手/);
  assert(!visible(b).some(name => name.startsWith('assistant_memory_')));
  assert.equal(instruction(b), '');
  const invoke = (name, args) => a.tool(name).execute(args);
  const proposed=JSON.parse((await invoke('assistant_memory_remember',{title:'报告格式',content:'用中文写报告，先给结论',kind:'preference',topic:'reports',quote:'用中文写报告，先给结论'})).content);
  assert.equal(proposed.state,'active');
  assert.equal(JSON.parse((await invoke('assistant_memory_search',{query:'报告'})).content).length,1);
  assert((await b.tool('assistant_memory_read').execute({ id: proposed.id })).isError);
  const raw = [{ role: 'system', content: 'unchanged' }, { role: 'user', content: [{ type: 'text', text: '报告' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] }];
  const prepared = a.core.handlers.call('conversation:prepare', raw);
  assert.equal(prepared[0], raw[0]); assert.match(prepared[1].content[0].text, /用中文写报告/);
  assert.equal(raw[1].content.length, 2);
  assert.deepEqual(b.core.handlers.call('conversation:prepare', raw), raw);
  await invoke('assistant_memory_remember',{title:'配色方案',content:'幻灯片使用蓝色',kind:'preference',topic:'slides',quote:'幻灯片使用蓝色'});
  const wrapped = wrapTrailingWithDynamicContext([{ role: 'user', content: '幻灯片' }], Array.from({ length: 90 }, (_, i) => 'context' + i).join(' '));
  const recalled = a.core.handlers.call('conversation:prepare', wrapped);
  assert.match(recalled[0].content, /幻灯片使用蓝色/, 'real kernel envelope must not crowd out the user query');
  assert(recalled[0].content.endsWith(wrapped[0].content));
  assert(fs.existsSync(path.join(pluginDataDirectory(file, entry.id), 'memory.sqlite')));
  const featureId = registry.snapshot().features[0].id;
  await registry.setEnabled(featureId, false);
  assert(!visible(a).some(name => name.startsWith('assistant_memory_')));
  assert.equal(instruction(a), '');
  assert((await invoke('assistant_memory_search', { query: '报告' })).isError);
  assert.deepEqual(a.core.handlers.call('conversation:prepare', raw), raw);
  await registry.setEnabled(featureId, true);
  assert.equal(visible(a).filter(name => name.startsWith('assistant_memory_')).length, 5);
  assert.equal(JSON.parse((await invoke('assistant_memory_search', { query: '报告' })).content).length, 1);
  assert(!visible(b).some(name=>name.startsWith('assistant_memory_')));
  resources.get('assistant').prepare('pause').execute();
  assert(!visible(a).some(name=>name.startsWith('assistant_memory_')));
  assert(!visible(b).some(name=>name.startsWith('assistant_memory_')));
  const cancelled = new AbortController(); cancelled.abort();
  assert((await a.tool('assistant_memory_propose').execute({ title: 'bad' }, undefined, { signal: cancelled.signal })).isError);
});

test('plugin data directory is package/profile scoped and old hosts reject the new plugin before activation', () => {
  assert.notEqual(pluginDataDirectory('/profile-a/settings.json', 'plugin-a'), pluginDataDirectory('/profile-b/settings.json', 'plugin-a'));
  assert.notEqual(pluginDataDirectory('/profile-a/settings.json', 'plugin-a'), pluginDataDirectory('/profile-a/settings.json', 'plugin-b'));
  assert.equal(path.dirname(pluginDataDirectory('/profile-a/settings.json', '../escape')), '/profile-a/hub-sessions/plugin-data');
  const raw = JSON.parse(fs.readFileSync(new URL('../examples/extensions/personal-assistant/ashub-plugin.json', import.meta.url)));
  const manifest = parsePluginManifest(raw, 'ashub-personal-assistant', 'session.mjs');
  const errors = pluginCompatibility(manifest, { capabilities: ['application-lifecycle', 'session-extensions', 'plugin-resources'], nodeVersion: '22.23.3' });
  assert(errors.errors.some(e => e.includes('plugin-data')));
});
