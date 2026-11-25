const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-child-resume-'));
const requests = [];
const originalFetch = globalThis.fetch;
const defaultReply = () => ({ content: 'FIXTURE_DONE' });
let reply = defaultReply;
let server, AshBridge, withPluginIdentity, reloadSettings;

before(async () => {
  process.env.AGENT_SH_HOME = home;
  process.env.HISTFILE = path.join(home, 'shell-history');
  for (const key of Object.keys(process.env)) {
    if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
  }
  if (process.platform !== 'win32') {
    const shell = path.join(home, 'clean-bash');
    fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o755 });
    process.env.SHELL = shell;
  }
  server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ url: request.url, body });
      const base = { id: 'resume-fixture', object: 'chat.completion.chunk', created: 1, model: body.model };
      const delta = reply(body);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ ...base,
        choices: [{ index: 0, delta, finish_reason: null }],
      }) + '\n\n');
      response.write('data: ' + JSON.stringify({ ...base,
        choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }],
      }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const modelOrigin = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== modelOrigin) throw new Error('External network disabled for this fixture');
    return originalFetch(input, init);
  };
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    defaultProvider: 'fixture-a', startupBanner: false, disabledBuiltins: ['rolling-history'],
    providers: Object.fromEntries(['fixture-a', 'fixture-b'].map(id => [id, {
      apiKey: 'fixture-key', baseURL: `${modelOrigin}/${id}/v1`, defaultModel: 'fixture-model',
      models: ['fixture-model', 'alternate-model'], contextWindow: 32000,
    }])),
  }));
  ({ AshBridge } = await import('../dist/bridges/ash.js'));
  ({ withPluginIdentity } = await import('../dist/plugin-approvals.js'));
  ({ reloadSettings } = await import('agent-sh/settings'));
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  fs.rmSync(home, { recursive: true, force: true });
});

async function newBridge(t) {
  const cwd = fs.mkdtempSync(path.join(home, 'work-'));
  const bridge = new AshBridge({ cwd, provider: 'fixture-a', model: 'fixture-model' });
  t.after(() => bridge.close());
  await bridge.ready();
  return bridge;
}

async function run(bridge, options = {}) {
  const result = await bridge.core.handlers.call('subagent:run', {
    task: 'Investigate the original fixture', tools: [], ...options,
  });
  const id = /\bSubagent id: (\S+)/.exec(result)?.[1];
  assert.match(result, /FIXTURE_DONE/);
  assert(id);
  return id;
}

function resume(bridge, id, task = 'Continue investigating the fixture') {
  return bridge.core.handlers.call('subagent:resume', { id, task });
}

function registerFixtureTool(bridge, name, overrides = {}) {
  const definition = {
    name, description: name, input_schema: { type: 'object', properties: {} },
    execute: async () => ({ content: 'fixture tool result', exitCode: 0, isError: false }),
    ...overrides,
  };
  bridge.extCtx.agent.registerTool(definition);
  return definition;
}

const toolNames = () => (requests.at(-1).body.tools ?? []).map(tool => tool.function.name).sort();

test('continuation preserves an explicit empty allowlist for a broad preset', { timeout: 8000 }, async t => {
  const bridge = await newBridge(t);
  const id = await run(bridge, { type: 'implement' });
  assert.deepEqual(toolNames(), []);
  registerFixtureTool(bridge, 'fixture_added_after_run');
  const beforeResume = requests.length;
  assert.match(await resume(bridge, id), /FIXTURE_DONE/);
  assert.equal(requests.length, beforeResume + 1);
  assert.deepEqual(toolNames(), []);
});

test('continuation offers only original tool implementations still registered', { timeout: 8000 }, async t => {
  const bridge = await newBridge(t);
  const keep = registerFixtureTool(bridge, 'fixture_keep');
  const removed = registerFixtureTool(bridge, 'fixture_removed');
  const replaced = registerFixtureTool(bridge, 'fixture_replaced');
  const changedPermission = registerFixtureTool(bridge, 'fixture_changed_permission', { modifiesFiles: true });
  const changedSchema = registerFixtureTool(bridge, 'fixture_changed_schema');
  const id = await run(bridge, { tools: [keep, removed, replaced, changedPermission, changedSchema] });
  assert.deepEqual(toolNames(), [changedPermission.name, changedSchema.name, keep.name, removed.name, replaced.name]);
  registerFixtureTool(bridge, 'fixture_unrelated');
  bridge.extCtx.agent.unregisterTool(removed.name);
  bridge.extCtx.agent.unregisterTool(replaced.name);
  registerFixtureTool(bridge, replaced.name, { description: 'Replacement implementation' });
  bridge.extCtx.agent.unregisterTool(changedPermission.name);
  registerFixtureTool(bridge, changedPermission.name, {
    execute: changedPermission.execute, modifiesFiles: false,
  });
  bridge.extCtx.agent.unregisterTool(changedSchema.name);
  registerFixtureTool(bridge, changedSchema.name, {
    execute: changedSchema.execute, input_schema: { type: 'object', properties: { target: { type: 'string' } } },
  });
  assert.match(await resume(bridge, id), /FIXTURE_DONE/);
  assert.deepEqual(toolNames(), ['fixture_keep']);
});

for (const when of ['during the model response', 'while tool approval is pending', 'with an in-place schema change']) {
  test(`continuation rejects a tool capability change ${when}`, { timeout: 8000 }, async t => {
    const bridge = await newBridge(t);
    const name = 'fixture_replace_live';
    let offered = false, replaced = false, executions = 0;
    const execute = async () => {
      executions++;
      return { content: 'this implementation must not be called', exitCode: 0, isError: false };
    };
    const insideApproval = when === 'while tool approval is pending';
    const tool = registerFixtureTool(bridge, name, { execute, modifiesFiles: insideApproval });
    const id = await run(bridge, { tools: [tool] });
    const replaceTool = () => {
      if (when === 'with an in-place schema change') {
        tool.input_schema.properties.target = { type: 'string' };
      } else {
        bridge.extCtx.agent.unregisterTool(name);
        registerFixtureTool(bridge, name, { execute: async () => execute(), modifiesFiles: insideApproval });
      }
      replaced = true;
    };
    const off = bridge.onEvent(event => {
      if (event.name === 'permission:request' && insideApproval && !replaced) queueMicrotask(() => {
        replaceTool();
        bridge.decidePermission(event.payload.requestId, 'approved');
      });
    });
    reply = body => {
      if (offered) return defaultReply();
      assert(body.tools.some(definition => definition.function.name === name));
      offered = true;
      if (!insideApproval) replaceTool();
      return { tool_calls: [{ index: 0, id: 'fixture-race-call', type: 'function', function: {
        name, arguments: '{}',
      } }] };
    };
    try {
      await resume(bridge, id);
      assert(offered && replaced);
      assert.equal(executions, 0);
    } finally {
      off();
      reply = defaultReply;
    }
  });
}

test('a child run is addressable only from its original live bridge and caller', { timeout: 8000 }, async t => {
  const owner = await newBridge(t);
  const other = await newBridge(t);
  const id = await withPluginIdentity('fixture-owner', () => run(owner));
  const otherId = await withPluginIdentity('fixture-owner', () => run(other));
  assert.notEqual(id, otherId, 'IDs cannot name different live checkpoints in different bridges');
  const beforeResume = requests.length;
  assert.match(await withPluginIdentity('fixture-owner', () => resume(other, id)), /^Error:/);
  assert.match(await withPluginIdentity('fixture-owner', () => resume(owner, otherId)), /^Error:/);
  assert.match(await withPluginIdentity('fixture-other', () => resume(owner, id)), /^Error:/);
  assert.match(await resume(owner, id), /^Error:/);
  assert.equal(requests.length, beforeResume);
  assert.match(await withPluginIdentity('fixture-owner', () => resume(owner, id)), /FIXTURE_DONE/);
  assert.equal(requests.length, beforeResume + 1);
});

test('continuation stays on the original model without changing the main model', { timeout: 8000 }, async t => {
  const bridge = await newBridge(t);
  const id = await run(bridge);
  await bridge.execCommand('/model', 'alternate-model@fixture-a');
  assert.equal(bridge.getThinking().model, 'alternate-model');
  assert.match(await resume(bridge, id), /FIXTURE_DONE/);
  assert.equal(requests.at(-1).body.model, 'fixture-model');
  assert.equal(bridge.getThinking().model, 'alternate-model');
  assert.match(requests.at(-1).url, /^\/fixture-a\//);

  await t.test('removing the original model prevents any new request', async () => {
    const file = path.join(home, 'settings.json');
    const prior = fs.readFileSync(file, 'utf8');
    const updated = JSON.parse(prior);
    updated.providers['fixture-a'].models = ['alternate-model'];
    updated.providers['fixture-a'].defaultModel = 'alternate-model';
    try {
      fs.writeFileSync(file, JSON.stringify(updated));
      await reloadSettings();
      await bridge.reloadProviders();
      assert.equal(bridge.getThinking().model, 'alternate-model');
      assert(!(await bridge.getModels()).models.some(model => model.provider === 'fixture-a' && model.id === 'fixture-model'));
      const beforeResume = requests.length;
      assert.match(await resume(bridge, id), /^Error: .*original model is unavailable/);
      assert.equal(requests.length, beforeResume);
    } finally {
      fs.writeFileSync(file, prior);
      await reloadSettings();
      await bridge.reloadProviders();
    }
  });

  await bridge.execCommand('/model', 'fixture-model@fixture-b');
  assert.equal(bridge.getThinking().provider, 'fixture-b');
  const beforeResume = requests.length;
  assert.match(await resume(bridge, id), /^Error:/);
  assert.equal(requests.length, beforeResume);
});

test('continuation cannot send history to a new endpoint under the same provider name', { timeout: 8000 }, async t => {
  const bridge = await newBridge(t);
  const id = await run(bridge);
  const file = path.join(home, 'settings.json');
  const prior = fs.readFileSync(file, 'utf8');
  const updated = JSON.parse(prior);
  const nextEndpoint = updated.providers['fixture-a'].baseURL.replace('/fixture-a/', '/fixture-a-replaced/');
  updated.providers['fixture-a'].baseURL = nextEndpoint;
  try {
    fs.writeFileSync(file, JSON.stringify(updated));
    await reloadSettings();
    await bridge.reloadProviders();
    assert.equal(bridge.core.handlers.call('llm:get-client').config.baseURL, nextEndpoint);
    const beforeResume = requests.length;
    assert.match(await resume(bridge, id), /^Error:/);
    assert.equal(requests.length, beforeResume);
  } finally {
    fs.writeFileSync(file, prior);
    await reloadSettings();
  }
});

async function assertWaitingContinuationCancelled(bridge, id) {
  let reachedTool = 0, occupy;
  const occupied = new Promise(resolve => { occupy = resolve; });
  let finished = 0, release;
  const released = new Promise(resolve => { release = resolve; });
  const off = bridge.onEvent(event => {
    if (event.name === 'subagent:done' && event.payload.task.startsWith('Occupy fixture slot') && ++finished === 10) release();
  });
  const blocker = registerFixtureTool(bridge, 'fixture_hold_subagent_slot', {
    async execute(_args, _onChunk, context) {
      if (++reachedTool === 10) occupy();
      if (!context.signal.aborted) await once(context.signal, 'abort');
      return { content: 'released fixture slot', exitCode: 0, isError: false };
    },
  });
  reply = body => {
    if (!body.messages.some(message => message.role === 'user' && message.content.startsWith('Occupy fixture slot'))) return defaultReply();
    return { tool_calls: [{ index: 0, id: 'fixture-hold-call', type: 'function', function: {
      name: blocker.name, arguments: '{}',
    } }] };
  };
  try {
    await Promise.all(Array.from({ length: 10 }, (_, index) => bridge.core.handlers.call('subagent:run', {
      task: `Occupy fixture slot ${index}`, tools: [blocker], async: true,
    })));
    await occupied;
    const beforeStop = requests.length;
    const waiting = resume(bridge, id, 'Must not start after stop');
    bridge.cancel();
    assert.deepEqual(await waiting, { subagentCancelled: true, message: 'Subagent cancelled.' });
    assert.equal(requests.length, beforeStop);
    await released;
  } finally {
    off();
    reply = defaultReply;
    bridge.cancel();
  }
}

async function assertContinuationIgnoresLateParentStop(bridge, id) {
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocker = registerFixtureTool(bridge, 'fixture_hold_parent_turn', {
    async execute(_args, _onChunk, context) {
      enter();
      if (!context.signal.aborted) await once(context.signal, 'abort');
      return { content: 'released fixture parent', exitCode: 0, isError: false };
    },
  });
  reply = body => {
    if (!body.messages.some(message => message.role === 'user' && message.content.includes('Hold the main turn'))) return defaultReply();
    return { tool_calls: [{ index: 0, id: 'fixture-parent-call', type: 'function', function: {
      name: blocker.name, arguments: '{}',
    } }] };
  };
  try {
    const main = bridge.submit('Hold the main turn');
    await entered;
    bridge.cancel();
    const continued = resume(bridge, id, 'Start new work after stop');
    assert.deepEqual(await main, { stopReason: 'cancelled' });
    assert.match(await continued, /FIXTURE_DONE/);
  } finally {
    reply = defaultReply;
    bridge.cancel();
  }
}

async function assertSwarmCancelsOnce(bridge, queued = false) {
  const controller = new AbortController();
  const initial = queued ? 10 : 2;
  const items = Array.from({ length: queued ? 12 : initial }, (_, index) => String(index));
  let active = 0, started = 0, ready;
  const initialActive = new Promise(resolve => { ready = resolve; });
  const blocker = registerFixtureTool(bridge, queued ? 'fixture_hold_queued_swarm_child' : 'fixture_hold_swarm_child', {
    async execute(_args, _onChunk, context) {
      if (++active === initial) ready();
      if (!context.signal.aborted) await once(context.signal, 'abort');
      return { content: 'released fixture member', exitCode: 0, isError: false };
    },
  });
  reply = () => ({ tool_calls: [{ index: 0, id: 'fixture-swarm-call', type: 'function', function: {
    name: blocker.name, arguments: '{}',
  } }] });
  const swarm = bridge.extCtx.agent.getTools().find(tool => tool.name === 'agentswarm');
  const events = [];
  const off = bridge.onEvent(event => {
    if (event.name.startsWith('subagent:swarm-')) events.push(event.name);
    if (event.name === 'subagent:started' && ++started > initial) queueMicrotask(() => bridge.cancel());
  });
  try {
    const pending = swarm.execute({ type: 'implement', prompt_template: 'Hold member {{item}}', items }, undefined,
      queued ? undefined : { signal: controller.signal });
    await initialActive;
    if (queued) bridge.cancel();
    else controller.abort();
    assert.match((await pending).content, new RegExp(`0 succeeded, ${items.length} failed`));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(started, initial, 'stop must not launch queued swarm members');
    assert.deepEqual(events, ['subagent:swarm-started', ...Array(initial).fill('subagent:swarm-progress'), 'subagent:swarm-done']);
  } finally {
    if (queued) bridge.cancel();
    else controller.abort();
    off();
    reply = defaultReply;
  }
}

test('continuations follow the current bridge lifecycle', { timeout: 8000 }, async t => {
  const bridge = await newBridge(t);
  const id = await run(bridge);
  await t.test('stop cancels a queued continuation without a caller signal', () => assertWaitingContinuationCancelled(bridge, id));
  await t.test('late parent cancellation leaves a new continuation running', () => assertContinuationIgnoresLateParentStop(bridge, id));
  await t.test('parallel child cancellations emit one swarm completion after progress', () => assertSwarmCancelsOnce(bridge));
  await t.test('stop prevents queued swarm members from launching without a caller signal', () => assertSwarmCancelsOnce(bridge, true));
  await t.test('a fresh child cannot use a changed tool capability', async () => {
    const tool = registerFixtureTool(bridge, 'fixture_fresh_capability_replace', { readOnly: true });
    let executions = 0;
    reply = body => {
      reply = defaultReply;
      assert(body.tools.some(entry => entry.function.name === tool.name));
      bridge.extCtx.agent.unregisterTool(tool.name);
      registerFixtureTool(bridge, tool.name, {
        modifiesFiles: true,
        async execute() {
          executions++;
          return { content: 'replacement fixture result', exitCode: 0, isError: false };
        },
      });
      return { tool_calls: [{ index: 0, id: 'fixture-replaced-call', type: 'function', function: {
        name: tool.name, arguments: '{}',
      } }] };
    };
    try {
      await run(bridge, { tools: [tool] });
      assert.equal(executions, 0, 'the child must not dispatch an unapproved replacement');
    } finally {
      reply = defaultReply;
    }
  });
  await t.test('workspace changes prevent a continuation from transferring history', async () => {
    const changed = fs.mkdtempSync(path.join(home, 'new-workspace-'));
    bridge.core.bus.emit('shell:cwd-change', { cwd: changed });
    assert.equal(bridge.core.handlers.call('cwd'), changed);
    const beforeResume = requests.length;
    assert.match(await resume(bridge, id), /^Error:/);
    assert.equal(requests.length, beforeResume);
  });
});
