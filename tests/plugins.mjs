import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-plugins-'));
process.env.AGENT_SH_HOME = home;
for (const key of Object.keys(process.env)) if (/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
globalThis.fetch = async () => { throw new Error('External network disabled'); };
const { pluginCatalog, builtinPluginCatalog, setPluginEnabled, getPluginConfig, savePluginConfig, PluginConfigConflict, PLUGIN_DISABLED } = await import('../dist/plugins.js');
const { PluginRuntime, pluginScope, preparePluginRegistrations } = await import('../dist/plugin-runtime.js');
const { createCore } = await import('agent-sh');
const { activateAgent } = await import('agent-sh/agent');
const { loadBuiltinExtensions, BUILTIN_EXTENSIONS } = await import('agent-sh/extensions');
const cores = [];
const makeContext = async () => {
  const core = createCore({}); cores.push(core);
  const ctx = core.extensionContext({ quit() {} }); preparePluginRegistrations(ctx); activateAgent(ctx); preparePluginRegistrations(ctx);
  await loadBuiltinExtensions(ctx, ['codex-provider', 'file-autocomplete']);
  return { core, ctx };
};
let sequence = 0;
function fixture(code = 'export default () => {};', filename = 'sample.mjs') {
  const root = path.join(home, String(++sequence)); fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  const file = path.join(root, 'settings.json'); fs.writeFileSync(file, '{}');
  const entry = path.join(root, 'extensions', filename); fs.writeFileSync(entry, code);
  return { file, entry, root };
}
test.after(() => { for (const c of cores) c.kill(); fs.rmSync(home, { recursive: true, force: true }); });
test('catalog never executes a plugin; toggle preserves unrelated settings', () => {
  const f = fixture('throw new Error("must not execute")');
  fs.writeFileSync(f.file, JSON.stringify({ providers: { private: { apiKey: 'fixture-only' } }, untouched: 42 }));
  const [p] = pluginCatalog(f.file); assert.equal(p.name, 'sample'); assert(p.enabled);
  setPluginEnabled(f.file, p.id, false); assert.equal(pluginCatalog(f.file)[0].enabled, false);
  setPluginEnabled(f.file, p.id, true); assert.equal(pluginCatalog(f.file)[0].enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).providers.private.apiKey, 'fixture-only');
  assert.equal(JSON.parse(fs.readFileSync(f.file)).untouched, 42);
  assert.throws(() => setPluginEnabled(f.file, '../other', false));
});
test('native disabled flag, explicit entry precedence and path deduplication', () => {
  const f = fixture();
  fs.writeFileSync(f.file, JSON.stringify({ disabledExtensions: ['sample'] }));
  assert.equal(pluginCatalog(f.file)[0].enabled, false);
  const relative = path.relative(process.cwd(), f.entry);
  fs.writeFileSync(f.file, JSON.stringify({ disabledExtensions: ['sample'], extensions: [relative] }));
  assert.equal(pluginCatalog(f.file).length, 1); assert(pluginCatalog(f.file)[0].enabled);
  setPluginEnabled(f.file, pluginCatalog(f.file)[0].id, false);
  assert(!pluginCatalog(f.file)[0].enabled);
  setPluginEnabled(f.file, pluginCatalog(f.file)[0].id, true);
  assert(pluginCatalog(f.file)[0].enabled);
});
test('malformed settings cannot be replaced by a plugin toggle', () => {
  const f = fixture(); fs.writeFileSync(f.file, '{broken');
  assert.throws(() => setPluginEnabled(f.file, 'x', false));
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
});
const toolCode = `export default ctx => {
  ctx.agent.registerTool({ name: 'plugin_probe', description: 'probe', parameters: { type: 'object', properties: {} }, execute: async () => ({ output: 'ok' }) });
  ctx.bus.on('plugin:probe', () => ctx.bus.emit('ui:info', { message: 'probe' }));
  ctx.registerCommand('/plugin-probe', 'probe', () => ctx.bus.emit('ui:info', { message: 'command-probe' }));
};`;
test('real kernel: same plugin in two conversations stays isolated when another closes', async () => {
  const f = fixture(toolCode), a = await makeContext(), b = await makeContext();
  const ra = new PluginRuntime(f.file), rb = new PluginRuntime(f.file);
  assert.deepEqual(await ra.load(a.ctx), ['sample']); await rb.load(b.ctx);
  assert(a.ctx.agent.getTools().some(t => t.name === 'plugin_probe'));
  assert(b.ctx.agent.getTools().some(t => t.name === 'plugin_probe'));
  let count = 0; a.ctx.bus.on('ui:info', p => { if (p.message === 'probe') count++; });
  a.ctx.bus.emit('plugin:probe', {}); assert.equal(count, 1);
  rb.close(); a.ctx.bus.emit('plugin:probe', {}); assert.equal(count, 2);
  assert(a.ctx.agent.getTools().some(t => t.name === 'plugin_probe'));
  assert(!b.ctx.agent.getTools().some(t => t.name === 'plugin_probe'));
  ra.close(); a.ctx.bus.emit('plugin:probe', {}); assert.equal(count, 2);
});
test('failed activation cleans registrations and does not block another plugin', async () => {
  const f = fixture(toolCode.replace('\n};', '\nthrow new Error("activation failed");\n};'));
  fs.writeFileSync(path.join(f.root, 'extensions', 'healthy.mjs'), 'export default () => {};');
  const { ctx } = await makeContext(), runtime = new PluginRuntime(f.file);
  assert.deepEqual(await runtime.load(ctx), ['healthy']);
  assert(!ctx.agent.getTools().some(t => t.name === 'plugin_probe'));
  assert.equal(runtime.status.find(s => s.name === 'sample').state, 'error'); runtime.close();
});
test('disabled extension is not imported and an already running kernel stays intact', async () => {
  const f = fixture(toolCode), { ctx } = await makeContext(), runtime = new PluginRuntime(f.file);
  await runtime.load(ctx);
  setPluginEnabled(f.file, pluginCatalog(f.file)[0].id, false);
  assert(ctx.agent.getTools().some(t => t.name === 'plugin_probe'));
  const next = new PluginRuntime(f.file); await next.load((await makeContext()).ctx);
  assert.equal(next.status.length, 0); runtime.close(); next.close();
});
test('timeout revokes late registration and reports failure', async () => {
  const f = fixture(`export default async ctx => {
    await new Promise(r => setTimeout(r, 50));
    ctx.agent.registerInstruction('too-late', 'must not appear');
  };`);
  const { ctx } = await makeContext(), runtime = new PluginRuntime(f.file, 10);
  await runtime.load(ctx); await new Promise(r => setTimeout(r, 80));
  assert.equal(runtime.status[0].state, 'error');
  assert(!ctx.bus.emitPipe('agent:instructions', { instructions: [] }).instructions.some(i => i.name === 'too-late'));
  runtime.close();
});
test('closing a session during activation prevents later registration', async () => {
  const f = fixture(`export default async ctx => { await new Promise(r => setTimeout(r, 30)); ctx.registerCommand('/late', 'late', () => {}); };`);
  const { ctx } = await makeContext(), runtime = new PluginRuntime(f.file);
  let writes = 0; const original = ctx.registerCommand;
  ctx.registerCommand = (...args) => { writes++; original(...args); };
  const pending = runtime.load(ctx); runtime.close(); await pending;
  assert.equal(writes, 0);
});
test('TypeScript directory plugin supports spaces and URL-special characters', async () => {
  const f = fixture('', 'ignored.txt'), dir = path.join(f.root, 'extensions', '插件 # example'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export default (ctx: any) => { ctx.agent.registerInstruction("ts-probe", "ready"); };');
  const { ctx } = await makeContext(), runtime = new PluginRuntime(f.file);
  assert.deepEqual(await runtime.load(ctx), ['插件 # example']); runtime.close();
});

test('failed override restores the earlier tool instead of deleting it', async () => {
  const f = fixture(toolCode.replace('\n};', '\nthrow new Error("failed override");\n};'));
  const { ctx } = await makeContext();
  const prior = { name: 'plugin_probe', description: 'original', parameters: { type: 'object', properties: {} }, execute: async () => ({ output: 'original' }) };
  ctx.agent.registerTool(prior);
  const runtime = new PluginRuntime(f.file); await runtime.load(ctx);
  assert.equal(ctx.agent.getTools().find(t => t.name === 'plugin_probe').description, 'original'); runtime.close();
});
test('unreadable plugin configuration does not prevent a core from starting', async () => {
  const f = fixture(); fs.writeFileSync(f.file, '{broken');
  const runtime = new PluginRuntime(f.file);
  assert.deepEqual(await runtime.load((await makeContext()).ctx), []); runtime.close();
});
test('asHub bridge exposes plugin status and keeps reload session-safe', async () => {
  const dir = path.join(home, 'extensions'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bridge-probe.mjs'), toolCode);
  const { AshBridge } = await import('../dist/bridges/ash.js');
  const a = new AshBridge({ cwd: home, sessionId: 'plugin-a' }), b = new AshBridge({ cwd: home, sessionId: 'plugin-b' });
  try {
    await Promise.all([a.ready(), b.ready()]);
    assert.equal(a.getPluginStatus()[0].state, 'loaded'); assert.equal(b.getPluginStatus()[0].state, 'loaded');
    let notice = ''; a.onEvent(e => { if (e.name === 'ui:info') notice = e.payload.message; });
    await a.execCommand('/reload', ''); assert.match(notice, /Restart asHub/);
    b.close(); assert.equal(a.getPluginStatus()[0].state, 'loaded');
  } finally { a.close(); b.close(); }
});

test('onDispose can notify the host while late callbacks remain revoked', async () => {
  const f = fixture(`export default ctx => { ctx.onDispose(() => ctx.bus.emit('ui:info', { message: 'disposed' })); };`);
  const { ctx } = await makeContext(), runtime = new PluginRuntime(f.file); let notices = 0;
  ctx.bus.on('ui:info', p => { if (p.message === 'disposed') notices++; });
  await runtime.load(ctx); runtime.close(); runtime.close(); assert.equal(notices, 1);
});

test('a rejected duplicate command does not remove the built-in command during rollback', async () => {
  const f = fixture(`export default ctx => { ctx.registerCommand('/help', 'duplicate', () => {}); throw Error('setup failed'); };`);
  const { ctx } = await makeContext(), runtime = new PluginRuntime(f.file);
  await runtime.load(ctx);
  let message = ''; ctx.bus.on('ui:info', p => { message = p.message; });
  ctx.bus.emit('command:execute', { name: '/help', args: '' });
  assert(!message.includes('Unknown command'), message); runtime.close();
});
test('failed provider replacement restores the original registration', async () => {
  const f = fixture(`export default ctx => { ctx.agent.providers.register({ id: 'original-provider', baseURL: 'https://bad.invalid', models: ['bad'] }); throw Error('setup failed'); };`);
  const { ctx } = await makeContext(), runtime = new PluginRuntime(f.file);
  const original = { id: 'original-provider', baseURL: 'https://original.invalid', models: ['original'] };
  ctx.agent.providers.register(original);
  await runtime.load(ctx);
  assert.deepEqual(ctx.bus.emitPipe('agent:providers', { providers: [] }).providers.find(p => p.id === original.id), original);
  runtime.close();
});

test('failed plugin replacements preserve providers registered by activateAgent', async () => {
  const f = fixture(`export default ctx => {
    ctx.agent.providers.register({ id: 'openai', baseURL: 'https://fixture.invalid', models: ['replacement'] });
    ctx.agent.providers.register({ id: 'deepseek', baseURL: 'https://fixture.invalid', models: ['replacement'] });
    throw Error('activation failed');
  };`);
  const { ctx } = await makeContext(), runtime = new PluginRuntime(f.file);
  const read = id => ctx.bus.emitPipe('agent:providers', { providers: [] }).providers.find(p => p.id === id);
  const originals = ['openai', 'deepseek'].map(read);
  assert(originals.every(Boolean), 'use actual built-in providers, not registrations added after scope setup');
  await runtime.load(ctx);
  assert.equal(runtime.status[0].state, 'error');
  assert.deepEqual(['openai', 'deepseek'].map(read), originals);
  runtime.close();
  assert.deepEqual(['openai', 'deepseek'].map(read), originals);
});

test('native provider baseline survives layered disposal and yields to a newer host update', async () => {
  const { ctx } = await makeContext(), a = pluginScope(ctx), b = pluginScope(ctx);
  const read = () => ctx.bus.emitPipe('agent:providers', { providers: [] }).providers.find(p => p.id === 'openai');
  const original = read(); assert(original);
  const offA = a.ctx.agent.providers.register({ ...original, models: ['a'] });
  const offB = b.ctx.agent.providers.register({ ...original, models: ['b'] });
  offA(); a.dispose(); assert.deepEqual(read().models, ['b']);
  offB(); b.dispose(); assert.deepEqual(read(), original);
  const c = pluginScope(ctx);
  c.ctx.agent.providers.register({ ...original, models: ['c'] });
  const newest = { ...original, models: ['new-host-model'] };
  ctx.agent.providers.register(newest);
  c.dispose(); assert.deepEqual(read(), newest);
});

test('failed activation restores native provider reasoning, cache and request-header hooks', async () => {
  const f = fixture(`export default ctx => {
    ctx.agent.providers.configure('openai', {
      reasoningParams: () => ({ invalid: true }), cacheTokens: () => 999,
      requestHeaders: () => ({ 'x-fixture': 'failed-plugin' }),
    });
    throw Error('activation failed');
  };`);
  const { ctx } = await makeContext(), runtime = new PluginRuntime(f.file);
  ctx.agent.providers.register({ id: 'openai', apiKey: 'fixture-only', models: ['gpt-5'] });
  const endpoint = () => ctx.call('agent:resolve-endpoint', { provider: 'openai', id: 'gpt-5' });
  const usage = { prompt_tokens_details: { cached_tokens: 7 } };
  const read = () => { const e = endpoint(); return [e.buildReasoningParams('off'), e.extractCachedTokens(usage), e.buildRequestHeaders?.({})]; };
  const before = read(); assert.deepEqual(before[0], { reasoning_effort: 'minimal' });
  await runtime.load(ctx); assert.equal(runtime.status[0].state, 'error');
  assert.deepEqual(read(), before); runtime.close(); assert.deepEqual(read(), before);
});

test('provider hook disposal restores defaults for a newly configured provider', async () => {
  const { ctx } = await makeContext(), scope = pluginScope(ctx);
  ctx.agent.providers.register({ id: 'hook-fixture', apiKey: 'fixture-only', models: ['fixture'] });
  const read = () => {
    const e = ctx.call('agent:resolve-endpoint', { provider: 'hook-fixture', id: 'fixture' });
    return [e.buildReasoningParams('low'), e.extractCachedTokens({ prompt_tokens_details: { cached_tokens: 8 } }), e.buildRequestHeaders?.({})];
  };
  const baseline = read();
  scope.ctx.agent.providers.configure('hook-fixture', { reasoningParams: () => ({ owned: true }), cacheTokens: () => 999, requestHeaders: () => ({ 'x-fixture': 'owned' }) });
  assert.notDeepEqual(read(), baseline); scope.dispose(); scope.dispose();
  assert.deepEqual(read(), baseline);
  assert.throws(() => scope.ctx.agent.providers.configure('hook-fixture', { cacheTokens: () => 0 }), /activation has ended/);
});

test('layered provider hook cleanup preserves newer plugin fields and host updates', async () => {
  const { ctx } = await makeContext(), a = pluginScope(ctx), b = pluginScope(ctx);
  ctx.agent.providers.register({ id: 'openai', apiKey: 'fixture-only', models: ['gpt-5'] });
  ctx.agent.providers.configure('openai', { requestHeaders: () => ({ 'x-fixture': 'host-before' }) });
  const read = () => {
    const e = ctx.call('agent:resolve-endpoint', { provider: 'openai', id: 'gpt-5' });
    return [e.buildReasoningParams('off'), e.extractCachedTokens({}), e.buildRequestHeaders?.({})];
  };
  a.ctx.agent.providers.configure('openai', { reasoningParams: () => ({ owner: 'a' }), cacheTokens: () => 1 });
  a.ctx.agent.providers.configure('openai', { reasoningParams: () => ({ owner: 'a2' }) });
  b.ctx.agent.providers.configure('openai', { reasoningParams: () => ({ owner: 'b' }), requestHeaders: () => ({ 'x-fixture': 'b' }) });
  ctx.agent.providers.configure('openai', { cacheTokens: () => 42 });
  a.dispose(); assert.deepEqual(read(), [{ owner: 'b' }, 42, { 'x-fixture': 'b' }]);
  b.dispose(); assert.deepEqual(read(), [{ reasoning_effort: 'minimal' }, 42, { 'x-fixture': 'host-before' }]);
});

test('timed-out plugin provider hooks roll back and late configure calls are rejected', async () => {
  const f = fixture(`export default async ctx => {
    ctx.agent.providers.configure('openai', { reasoningParams: () => ({ wrong: true }) });
    await new Promise(resolve => setTimeout(resolve, 25));
    ctx.agent.providers.configure('openai', { reasoningParams: () => ({ late: true }) });
  };`);
  const { ctx } = await makeContext(), runtime = new PluginRuntime(f.file, 5);
  ctx.agent.providers.register({ id: 'openai', apiKey: 'fixture-only', models: ['gpt-5'] });
  await runtime.load(ctx); assert.equal(runtime.status[0].state, 'error');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(ctx.call('agent:resolve-endpoint', { provider: 'openai', id: 'gpt-5' }).buildReasoningParams('off'), { reasoning_effort: 'minimal' });
  runtime.close();
});

test('actual AshBridge captures native provider hooks before a failed extension replaces them', async () => {
  const directory = path.join(home, 'extensions'); fs.mkdirSync(directory, { recursive: true });
  const entry = path.join(directory, 'provider-hook-failure.mjs');
  fs.writeFileSync(entry, `export default ctx => {
    ctx.agent.providers.configure('openai', { reasoningParams: () => ({ invalid: true }) });
    throw Error('fixture hook failure');
  };`);
  const { AshBridge } = await import('../dist/bridges/ash.js');
  const bridge = new AshBridge({ cwd: home, sessionId: 'plugin-hook-audit' });
  try {
    await bridge.ready();
    assert.equal(bridge.getPluginStatus().find(p => p.name === 'provider-hook-failure').state, 'error');
    bridge.extCtx.agent.providers.register({ id: 'openai', apiKey: 'fixture-only', models: ['gpt-5'] });
    const endpoint = bridge.core.handlers.call('agent:resolve-endpoint', { provider: 'openai', id: 'gpt-5' });
    assert.deepEqual(endpoint.buildReasoningParams('off'), { reasoning_effort: 'minimal' });
  } finally { bridge.close(); fs.unlinkSync(entry); }
});


test('failed instruction and skill replacements restore their original values and advice', async () => {
  const f = fixture(`export default ctx => {
    ctx.agent.registerInstruction('shared-instruction', 'replacement');
    ctx.agent.registerSkill('shared-skill', 'replacement', '/replacement.md');
    throw Error('setup failed');
  };`);
  const { ctx } = await makeContext(), runtime = new PluginRuntime(f.file);
  ctx.agent.registerInstruction('shared-instruction', 'original');
  ctx.agent.adviseInstruction('shared-instruction', next => next() + ' advised');
  ctx.agent.registerSkill('shared-skill', 'original', '/original.md');
  ctx.agent.adviseSkill('shared-skill', next => ({ ...next(), description: next().description + ' advised' }));
  await runtime.load(ctx);
  assert.equal(runtime.status[0].state, 'error');
  assert.deepEqual(ctx.bus.emitPipe('agent:instructions', { instructions: [] }).instructions.find(i => i.name === 'shared-instruction'), { name: 'shared-instruction', text: 'original advised' });
  assert.deepEqual(ctx.bus.emitPipe('agent:skills', { skills: [] }).skills.find(i => i.name === 'shared-skill'), { name: 'shared-skill', description: 'original advised', filePath: '/original.md' });
  runtime.close();
});
test('out-of-order provider disposal keeps the active replacement and never resurrects a disposed plugin', async () => {
  const { ctx } = await makeContext(), a = pluginScope(ctx), b = pluginScope(ctx);
  const original = { id: 'layered-provider', baseURL: 'https://original.invalid', models: ['original'] };
  ctx.agent.providers.register(original);
  const offA = a.ctx.agent.providers.register({ ...original, models: ['a'] });
  b.ctx.agent.providers.register({ ...original, models: ['b'] });
  const current = () => ctx.bus.emitPipe('agent:providers', { providers: [] }).providers.find(p => p.id === original.id);
  offA(); offA(); a.dispose();
  assert.deepEqual(current().models, ['b']);
  b.dispose(); assert.deepEqual(current(), original);
});
test('repeated instruction and skill registrations unwind across scopes without reviving closed scopes', async () => {
  const { ctx } = await makeContext(), a = pluginScope(ctx), b = pluginScope(ctx);
  ctx.agent.registerInstruction('layered', 'original');
  ctx.agent.registerSkill('layered', 'original', '/original.md');
  for (const value of ['a1', 'a2']) {
    a.ctx.agent.registerInstruction('layered', value);
    a.ctx.agent.registerSkill('layered', value, '/' + value + '.md');
  }
  b.ctx.agent.registerInstruction('layered', 'b');
  b.ctx.agent.registerSkill('layered', 'b', '/b.md');
  const current = () => [
    ctx.bus.emitPipe('agent:instructions', { instructions: [] }).instructions.find(i => i.name === 'layered').text,
    ctx.bus.emitPipe('agent:skills', { skills: [] }).skills.find(i => i.name === 'layered').description,
  ];
  a.dispose(); assert.deepEqual(current(), ['b', 'b']);
  b.dispose(); assert.deepEqual(current(), ['original', 'original']);
});
test('ended plugin callbacks cannot remove another plugin registrations', async () => {
  const { ctx } = await makeContext(), scope = pluginScope(ctx);
  ctx.agent.registerInstruction('late-target', 'keep');
  ctx.agent.registerSkill('late-target', 'keep', '/keep.md');
  ctx.agent.registerTool({ name: 'late-target', description: 'keep', input_schema: { type: 'object', properties: {} }, execute: async () => ({ output: 'keep' }) });
  ctx.agent.providers.register({ id: 'late-target', baseURL: 'https://keep.invalid', models: [] });
  scope.dispose();
  for (const remove of [scope.ctx.agent.removeInstruction, scope.ctx.agent.removeSkill, scope.ctx.agent.unregisterTool, scope.ctx.agent.providers.unregister]) {
    assert.throws(() => remove('late-target'), /activation has ended/);
  }
  assert(ctx.agent.getTools().some(t => t.name === 'late-target'));
  assert(ctx.bus.emitPipe('agent:instructions', { instructions: [] }).instructions.some(i => i.name === 'late-target'));
  assert(ctx.bus.emitPipe('agent:skills', { skills: [] }).skills.some(i => i.name === 'late-target'));
  assert(ctx.bus.emitPipe('agent:providers', { providers: [] }).providers.some(i => i.id === 'late-target'));
});

test('explicit plugin cleanup restores earlier registrations without removing a newer owner', async () => {
  const { ctx } = await makeContext(), a = pluginScope(ctx), b = pluginScope(ctx);
  ctx.agent.registerInstruction('cleanup', 'original');
  ctx.agent.registerSkill('cleanup', 'original', '/original.md');
  ctx.agent.providers.register({ id: 'cleanup', models: ['original'] });
  a.ctx.agent.registerInstruction('cleanup', 'a');
  a.ctx.agent.registerSkill('cleanup', 'a', '/a.md');
  a.ctx.agent.providers.register({ id: 'cleanup', models: ['a'] });
  a.ctx.onDispose(() => {
    a.ctx.agent.removeInstruction('cleanup');
    a.ctx.agent.removeSkill('cleanup');
    a.ctx.agent.providers.unregister('cleanup');
  });
  b.ctx.agent.registerInstruction('cleanup', 'b');
  b.ctx.agent.registerSkill('cleanup', 'b', '/b.md');
  b.ctx.agent.providers.register({ id: 'cleanup', models: ['b'] });
  const current = () => [
    ctx.bus.emitPipe('agent:instructions', { instructions: [] }).instructions.find(i => i.name === 'cleanup')?.text,
    ctx.bus.emitPipe('agent:skills', { skills: [] }).skills.find(i => i.name === 'cleanup')?.description,
    ctx.bus.emitPipe('agent:providers', { providers: [] }).providers.find(i => i.id === 'cleanup')?.models[0],
  ];
  a.dispose(); assert.deepEqual(current(), ['b', 'b', 'b']);
  b.dispose(); assert.deepEqual(current(), ['original', 'original', 'original']);
});


test('a rejected host duplicate tool registration preserves the plugin cleanup owner', async () => {
  const { ctx } = await makeContext(), scope = pluginScope(ctx);
  const tool = { name: 'duplicate-owner', description: 'plugin', input_schema: { type: 'object', properties: {} }, execute: async () => ({ output: 'ok' }) };
  scope.ctx.agent.registerTool(tool);
  assert.throws(() => ctx.agent.registerTool({ ...tool, description: 'duplicate' }), /already registered/);
  assert.equal(ctx.agent.getTools().find(t => t.name === tool.name)?.description, 'plugin');
  scope.dispose();
  assert(!ctx.agent.getTools().some(t => t.name === tool.name), 'a failed registration must not strand the original tool');
});
for (const explicit of [false, true]) test(`retired slash command cleanup preserves its replacement (explicit cleanup: ${explicit})`, async () => {
  const { ctx } = await makeContext(), a = pluginScope(ctx), b = pluginScope(ctx);
  let calls = 0;
  a.ctx.registerCommand('reused-command', 'old', () => {});
  if (explicit) a.ctx.onDispose(() => a.ctx.bus.emit('command:unregister', { name: 'reused-command' }));
  a.ctx.bus.emit('command:unregister', { name: '/reused-command' });
  b.ctx.registerCommand('/reused-command', 'new', () => { calls++; });
  a.dispose();
  ctx.bus.emit('command:execute', { name: '/reused-command', args: '' });
  assert.equal(calls, 1, 'the replacement command must remain callable');
  b.dispose();
  ctx.bus.emit('command:execute', { name: '/reused-command', args: '' });
  assert.equal(calls, 1, 'the replacement still cleans up its own command');
});


for (const [on, off, emit] of [['on', 'off', 'emit'], ['onPipe', 'offPipe', 'emitPipe'], ['onPipeAsync', 'offPipeAsync', 'emitPipeAsync']]) {
  test(`manual ${off} and subsequent disposal preserve other subscriptions to the same callback`, async () => {
    const { ctx } = await makeContext(), a = pluginScope(ctx), b = pluginScope(ctx);
    let calls = 0;
    const callback = payload => { calls++; return payload; };
    ctx.bus[on]('plugin:subscription-probe', callback);
    a.ctx.bus[on]('plugin:subscription-probe', callback);
    b.ctx.bus[on]('plugin:subscription-probe', callback);
    a.ctx.bus[off]('plugin:subscription-probe', callback);
    a.ctx.bus[off]('plugin:subscription-probe', callback);
    a.ctx.bus[on]('plugin:subscription-probe', callback);
    await ctx.bus[emit]('plugin:subscription-probe', {});
    assert.equal(calls, 3, 'the same callback can subscribe again after removal');
    a.ctx.bus[off]('plugin:subscription-probe', callback);
    a.dispose(); calls = 0;
    assert.throws(() => a.ctx.bus[off]('plugin:subscription-probe', callback), /activation has ended/);
    await ctx.bus[emit]('plugin:subscription-probe', {});
    assert.equal(calls, 2, 'host and other plugin subscriptions must survive');
    b.dispose(); calls = 0;
    await ctx.bus[emit]('plugin:subscription-probe', {});
    assert.equal(calls, 1, 'only the host subscription must remain');
    ctx.bus[off]('plugin:subscription-probe', callback);
  });
}
test('onAny manual unsubscribe and automatic cleanup do not remove another subscription', async () => {
  const { ctx } = await makeContext(), a = pluginScope(ctx), b = pluginScope(ctx);
  let calls = 0;
  const callback = event => { if (event === 'plugin:subscription-probe') calls++; };
  const hostOff = ctx.bus.onAny(callback);
  const off = a.ctx.bus.onAny(callback);
  b.ctx.bus.onAny(callback);
  off(); off(); a.dispose();
  ctx.bus.emit('plugin:subscription-probe', {});
  assert.equal(calls, 2, 'host and other plugin subscriptions must survive');
  b.dispose(); calls = 0;
  ctx.bus.emit('plugin:subscription-probe', {});
  assert.equal(calls, 1);
  hostOff();
});


test('plugin config saves only its namespace and detects concurrent edits', () => {
  const f = fixture('throw Error("configuration must never import the plugin")');
  fs.writeFileSync(f.file, JSON.stringify({ providers: { test: { apiKey: 'fixture-secret' } }, other: { keep: true }, sample: { nested: { count: 1 } } }));
  const id = pluginCatalog(f.file)[0].id, initial = getPluginConfig(f.file, id, 'sample');
  assert.deepEqual(initial.config, { nested: { count: 1 } });
  const saved = savePluginConfig(f.file, id, 'sample', { nested: { count: 2 } }, initial.revision);
  assert.notEqual(saved.revision, initial.revision);
  assert.throws(() => savePluginConfig(f.file, id, 'sample', { lost: true }, initial.revision), PluginConfigConflict);
  const data = JSON.parse(fs.readFileSync(f.file));
  assert.deepEqual(data.sample, { nested: { count: 2 } }); assert.deepEqual(data.other, { keep: true });
  assert.equal(data.providers.test.apiKey, 'fixture-secret');
  const empty = getPluginConfig(f.file, id, 'custom-name'); assert.deepEqual(empty.config, {});
  savePluginConfig(f.file, id, 'custom-name', { configured: true }, empty.revision);
  assert.deepEqual(getPluginConfig(f.file, id, 'sample').config, saved.config);
});
test('plugin config rejects global namespaces and malformed input without modifying settings', () => {
  const f = fixture(), id = pluginCatalog(f.file)[0].id, before = fs.readFileSync(f.file, 'utf8');
  for (const name of ['providers', 'extensions', 'disabledExtensions', 'ashub.network', '__proto__', 'constructor', '', ' sample', 'subagentBudgets']) {
    assert.throws(() => getPluginConfig(f.file, id, name));
    assert.throws(() => savePluginConfig(f.file, id, name, {}, 'x'));
  }
  const initial = getPluginConfig(f.file, id, 'sample');
  for (const config of [null, [], 'text', 5]) assert.throws(() => savePluginConfig(f.file, id, 'sample', config, initial.revision));
  assert.throws(() => savePluginConfig(f.file, id, 'sample', {}, undefined));
  assert.throws(() => getPluginConfig(f.file, 'missing', 'sample'));
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
test('new plugin kernels see saved config while running kernels retain their snapshot', async () => {
  const f = fixture(`export default ctx => {
    ctx.bus.on('plugin:read-config', () => ctx.agent.registerInstruction('config-value', JSON.stringify(ctx.getExtensionSettings('different-name', { limit: 1, retained: true }))));
    ctx.getExtensionSettings('different-name', {});
  };`);
  const id = pluginCatalog(f.file)[0].id, a = await makeContext(), b = await makeContext();
  const ra = new PluginRuntime(f.file), rb = new PluginRuntime(f.file);
  await ra.load(a.ctx);
  const empty = getPluginConfig(f.file, id, 'different-name');
  savePluginConfig(f.file, id, 'different-name', { limit: 5 }, empty.revision);
  await rb.load(b.ctx);
  const read = ctx => { ctx.bus.emit('plugin:read-config', {}); return JSON.parse(ctx.bus.emitPipe('agent:instructions', { instructions: [] }).instructions.find(i => i.name === 'config-value').text); };
  assert.deepEqual(read(a.ctx), { limit: 1, retained: true }); assert.deepEqual(read(b.ctx), { limit: 5, retained: true });
  assert.deepEqual(rb.status[0].configNamespaces, ['different-name']); ra.close(); rb.close();
});


test('built-in catalog covers bundled kernel extensions and providers without loading them', () => {
  const f = fixture('throw Error("do not import")');
  const entries = builtinPluginCatalog(f.file);
  for (const { name } of BUILTIN_EXTENSIONS) assert(entries.some(p => p.extensionName === name), name);
  for (const id of ['openai', 'deepseek', 'ollama', 'ollama-cloud', 'openrouter', 'opencode', 'opencode-go', 'zai-coding-plan', 'openai-compatible']) {
    assert(entries.some(p => p.providerId === id), id);
  }
  assert.equal(new Set(entries.map(p => p.id)).size, entries.length);
  assert(!JSON.stringify(entries).includes('apiKey'));
  const before = fs.readFileSync(f.file, 'utf8');
  for (const entry of entries) assert.throws(() => setPluginEnabled(f.file, entry.id, false));
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  fs.writeFileSync(f.file, JSON.stringify({ disabledBuiltins: ['codex-provider', 'slash-commands'] }));
  assert(!builtinPluginCatalog(f.file).find(p => p.id === 'builtin:codex-provider').enabled);
  assert(builtinPluginCatalog(f.file).find(p => p.required).enabled);
});
test('built-in configuration uses fixed paths and preserves sibling provider settings', () => {
  const f = fixture();
  fs.writeFileSync(f.file, JSON.stringify({ providers: { openai: { defaultModel: 'test' }, deepseek: { apiKey: 'keep' } }, other: { retained: true } }));
  const id = 'builtin:provider:openai', ns = 'providers.openai';
  const initial = getPluginConfig(f.file, id, ns);
  assert.equal(initial.config.defaultModel, 'test');
  savePluginConfig(f.file, id, ns, { defaultModel: 'new', apiKey: 'fixture-only' }, initial.revision);
  assert.throws(() => savePluginConfig(f.file, id, ns, {}, initial.revision), PluginConfigConflict);
  const current = getPluginConfig(f.file, id, ns);
  assert.throws(() => savePluginConfig(f.file, id, ns, { models: 'invalid' }, current.revision));
  for (const name of ['providers.deepseek', 'providers', '__proto__', 'ashub.network', 'codex-provider']) assert.throws(() => getPluginConfig(f.file, id, name));
  assert.throws(() => getPluginConfig(f.file, 'builtin:agent', 'anything'));
  assert.throws(() => getPluginConfig(f.file, 'builtin:missing', 'anything'));
  const data = JSON.parse(fs.readFileSync(f.file));
  assert.equal(data.providers.deepseek.apiKey, 'keep'); assert.deepEqual(data.other, { retained: true });
  assert(!Object.hasOwn(data, ns), 'provider overrides must be nested rather than a dotted top-level key');
  const codex = getPluginConfig(f.file, 'builtin:codex-provider', 'codex-provider');
  savePluginConfig(f.file, 'builtin:codex-provider', 'codex-provider', { headersTimeoutMs: 900000 }, codex.revision);
  assert.equal(getPluginConfig(f.file, 'builtin:codex-provider', 'codex-provider').config.headersTimeoutMs, 900000);
});
test('built-in provider config can create missing provider storage without changing local config', () => {
  const f = fixture();
  const id = 'builtin:provider:deepseek', ns = 'providers.deepseek';
  const initial = getPluginConfig(f.file, id, ns);
  savePluginConfig(f.file, id, ns, { defaultModel: 'test' }, initial.revision);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).providers.deepseek.defaultModel, 'test');
  fs.writeFileSync(f.file, '{"providers":[]}');
  assert.throws(() => getPluginConfig(f.file, id, ns));
  assert.throws(() => savePluginConfig(f.file, id, ns, {}, initial.revision));
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{"providers":[]}');
});

test('Codex configuration rejects known field type errors before writing, including local namespace access', async () => {
  const f = fixture(), id = 'builtin:codex-provider', namespace = 'codex-provider';
  const localId = pluginCatalog(f.file)[0].id;
  const initial = getPluginConfig(f.file, id, namespace), before = fs.readFileSync(f.file, 'utf8');
  for (const config of [
    { models: 'example-model' }, { models: null }, { models: [7] }, { models: [''] }, { models: [{}] },
    { providerId: 3 }, { upstreamURL: null }, { originator: [] },
    { credentialsTimeoutMs: '120000' }, { headersTimeoutMs: -1 }, { idleTimeoutMs: null },
  ]) {
    for (const pluginId of [id, localId]) assert.throws(() => savePluginConfig(f.file, pluginId, namespace, config, initial.revision), /codex-provider\./);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  }
  const valid = { providerId: 'custom-codex', models: ['custom-model'], headersTimeoutMs: 900000, extensionOption: { retained: true } };
  savePluginConfig(f.file, id, namespace, valid, initial.revision);
  assert.deepEqual(getPluginConfig(f.file, id, namespace).config, valid);
  const { resolveModels } = await import('../node_modules/agent-sh/dist/agent/extensions/codex-provider/models.js');
  assert.equal(resolveModels(getPluginConfig(f.file, id, namespace).config.models)[0].id, 'custom-model');
  const current = getPluginConfig(f.file, id, namespace);
  savePluginConfig(f.file, id, namespace, { models: [] }, current.revision);
  assert.deepEqual(getPluginConfig(f.file, id, namespace).config.models, []);
});
