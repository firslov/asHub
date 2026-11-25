// Uses the installed kernel, real native PTYs and a loopback-only model server.
// Run with Node 22, or Electron's ELECTRON_RUN_AS_NODE mode, after npm run build.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashub-kernel-compat-'));
process.env.AGENT_SH_HOME = dir;
process.env.HISTFILE = path.join(dir, 'shell-history');
// Use a wrapper that skips user startup files, including on contributors' machines.
const shell = path.join(dir, 'clean-bash');
if (process.platform !== 'win32') {
  await fs.writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o755 });
  process.env.SHELL = shell;
}
for (const key of Object.keys(process.env)) {
  if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete process.env[key];
}
const originalFetch = globalThis.fetch;
let modelOrigin;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.origin !== modelOrigin) throw new Error('Non-local network is disabled in kernel compatibility tests');
  return originalFetch(input, init);
};
const requests = [];
let modelReply = () => ({ content: 'KERNEL_REPLY_OK' });
let cutModelStream;
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    const validUnicode = value => {
      if (typeof value === 'string') return value.isWellFormed();
      if (!value || typeof value !== 'object') return true;
      return Object.entries(value).every(([key, item]) => key.isWellFormed() && validUnicode(item));
    };
    if (!validUnicode(data)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'lone surrogate in request', type: 'invalid_request_error' } }));
      return;
    }
    requests.push(data);
    const delta = modelReply(data);
    const base = { id: 'compat', object: 'chat.completion.chunk', created: 1, model: 'compat-model' };
    if (!data.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: delta.content ?? '' }, finish_reason: 'stop' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    const interruption = cutModelStream?.(data);
    if (interruption === 'eof') {
      res.end();
      return;
    }
    if (interruption) {
      setTimeout(() => res.destroy(), 30);
      return;
    }
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  } catch (err) { res.writeHead(500); res.end(String(err)); }
});
const bridges = new Set();
const watchdog = setTimeout(() => { console.error('FAIL kernel compatibility timeout'); process.exit(1); }, 45000);
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS kernel ' + name); }
async function within(promise, ms = 10000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('operation timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  modelOrigin = `http://127.0.0.1:${server.address().port}`;
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({
    defaultProvider: 'compat', providers: { deepseek: { apiKey: 'fake-deepseek-key', baseURL: modelOrigin + '/v1' }, compat: { apiKey: 'fake-test-key', baseURL: modelOrigin + '/v1', defaultModel: 'compat-model', models: ['compat-model'], contextWindow: 32000 } },
    startupBanner: false, disabledBuiltins: ['rolling-history'],
  }));
  await fs.writeFile(path.join(dir, 'AGENTS.md'), 'GLOBAL_PROMPT_RULE_PRESERVED');
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), 'PROJECT_PROMPT_RULE_PRESERVED');
  const skillDir = path.join(dir, 'skills', 'prompt-fixture');
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: prompt-fixture\ndescription: GLOBAL_SKILL_PRESERVED\n---\nFixture skill');
  await fs.mkdir(path.join(dir, 'extensions'));
  await fs.writeFile(path.join(dir, 'extensions', 'compat.ts'), `
    await Promise.resolve();
    export default function activate(ctx: any) {
      ctx.bus.onPipe('compat:extension-loaded', () => ({ url: import.meta.url }));
      ctx.agent.registerInstruction('compat-prompt', 'EXTENSION_PROMPT_RULE_PRESERVED');
    }
  `);
  const { AshBridge } = await import('../dist/bridges/ash.js');
  const { TerminalBridge } = await import('../dist/bridges/terminal.js');
  const { runSubagent } = await import('agent-sh');
  const pty = await import('node-pty');
  console.log(JSON.stringify({ node: process.versions.node, electron: process.versions.electron, abi: process.versions.modules, kernel: JSON.parse(await fs.readFile(new URL('../node_modules/agent-sh/package.json', import.meta.url))).version }));

  if (process.platform !== 'win32') await check('native PTY spawn/output/exit', async () => {
    const proc = pty.spawn('/bin/sh', ['-c', 'printf NATIVE_PTY_OK; exit 7'], { cwd: dir, env: { PATH: process.env.PATH } });
    let output = ''; proc.onData(chunk => { output += chunk; });
    try { const exit = await within(new Promise(resolve => proc.onExit(resolve))); assert.equal(exit.exitCode, 7); assert.match(output, /NATIVE_PTY_OK/); }
    finally { try { proc.kill(); } catch {} }
  });
  const { CollaborationTasks } = await import('../dist/collaboration.js');
  const { ProjectStore } = await import('../dist/projects.js');
  const { createConversationAccess } = await import('../dist/services/conversation-service.js');
  const tasksDirectory = path.join(dir, 'collaboration'), tasks = new CollaborationTasks(tasksDirectory);
  const projects = new ProjectStore(path.join(dir, 'projects.json'));
  projects.update({ action: 'create', name: 'Fixture', cwd: dir, add: ['fixture', 'coordinator'] }, () => true);
  const sessions = new Map(['fixture', 'coordinator'].map(id => [id, { id, kind: 'agent', title: id, cwd: dir }]));
  const access = createConversationAccess('fixture', { sessions, projects, tasks, tasksDirectory,
    withContextLock: async (_session, fn) => fn(), submitQuery: async () => { throw Error('No model dispatch in fixture'); } });
  const bridge = new AshBridge({ cwd: dir, provider: 'compat', model: 'compat-model', conversationAccess: access }); bridges.add(bridge);
  await check('real AshBridge initializes with ESM TypeScript extension', async () => {
    await within(bridge.ready());
    assert.match(bridge.core.bus.emitPipe('compat:extension-loaded', { url: '' }).url, /compat\.ts/);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'extensions/package.json'))).type, 'module');
    assert.equal(bridge.core.handlers.call('agent:get-model').model, 'compat-model');
  });
  await check('task supplement handler is discoverable and propagates cancellation', async () => {
    assert(bridge.extCtx.list().includes('ashub:collaboration:supplement'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(bridge.core.handlers.call('ashub:collaboration:supplement', {id:'missing', requestKey:'update-001', message:'No dispatch', signal:controller.signal}));
    await assert.rejects(bridge.core.handlers.call('ashub:collaboration:supplement', {id:'missing', requestKey:'update-001'}), /Task not found/);
  });
  await check('task notification handler is discoverable and rejects invalid task access', async () => {
    assert(bridge.extCtx.list().includes('ashub:collaboration:signal'));
    const controller=new AbortController();controller.abort();
    await assert.rejects(bridge.core.handlers.call('ashub:collaboration:signal',{id:'missing',requestKey:'notice-001',message:'No dispatch',signal:controller.signal}));
    await assert.rejects(bridge.core.handlers.call('ashub:collaboration:signal',{id:'missing',requestKey:'notice-001'}),/Task not found/);
  });
  await check('built-in plugin status reflects live registrations without exposing credentials', async () => {
    const plugins = bridge.getPluginStatus();
    assert.equal(plugins.find(p => p.id === 'builtin:agent').state, 'loaded');
    assert.equal(plugins.find(p => p.id === 'builtin:slash-commands').state, 'loaded');
    assert.equal(plugins.find(p => p.id === 'builtin:file-autocomplete').state, 'frontend');
    const registry = bridge.core.bus.emitPipe('agent:providers', { providers: [] }).providers;
    for (const p of plugins.filter(p => p.id.startsWith('builtin:provider:'))) {
      const id = p.id.slice('builtin:provider:'.length);
      assert.equal(p.state, registry.some(r => r.id === id) ? 'registered' : 'inactive');
      assert.deepEqual(p.configNamespaces, ['providers.' + id]);
    }
    assert.equal(plugins.find(p => p.id === 'builtin:codex-provider').state, 'inactive');
    assert(!JSON.stringify(plugins).includes('apiKey'));
  });
  await check('asHub prompt replaces identity while preserving kernel context', async () => {
    const prompt = bridge.core.handlers.call('system-prompt:build');
    assert.match(prompt, /^你是 asHub 中的 AI 助手/);
    assert.match(prompt, /# asHub 协作方式/);
    assert.match(prompt, /行动范围与授权/);
    for (const marker of ['GLOBAL_PROMPT_RULE_PRESERVED', 'PROJECT_PROMPT_RULE_PRESERVED', 'GLOBAL_SKILL_PRESERVED', 'EXTENSION_PROMPT_RULE_PRESERVED']) assert(prompt.includes(marker), marker);
    assert(prompt.includes('Current working directory: ' + dir));
    assert.match(prompt, /result previews/);
    assert(!prompt.includes('You are ash,'));
    assert(!prompt.includes('FILE MODIFICATION POLICY:'));
    assert(!prompt.includes('never instruct the user to run terminal commands themselves'));
    assert(!prompt.includes("the user doesn't see it directly"));
    assert.equal(prompt.split('# asHub 协作方式').length - 1, 1);
    assert.equal(bridge.core.handlers.call('system-prompt:build'), prompt);
  });
  await check('main agent streams a response and retains conversation', async () => {
    const events = []; const off = bridge.onEvent(e => events.push(e));
    try {
      await within(bridge.submit('compatibility main turn'));
      const snapshot = await bridge.snapshot();
      assert(snapshot.messages.some(m => JSON.stringify(m).includes('KERNEL_REPLY_OK')));
      assert(events.some(e => e.name === 'agent:response-chunk'));
      assert(requests.some(r => r.model === 'compat-model'));
      const actualSystem = requests.at(-1).messages.find(m => m.role === 'system').content;
      assert.match(actualSystem, /^你是 asHub 中的 AI 助手/);
      assert(actualSystem.includes('GLOBAL_PROMPT_RULE_PRESERVED'));
      assert(actualSystem.includes('EXTENSION_PROMPT_RULE_PRESERVED'));
    } finally { off(); }
  });
  await check('project tools reach the model and execute through the kernel', async () => {
    const names = requests.at(-1).tools.map(t => t.function.name);
    for (const name of ['conversation_list', 'conversation_read', 'conversation_send', 'conversation_task', 'conversation_wait', 'conversation_deliver']) assert(names.includes(name), name);
    let round = 0;
    modelReply = () => ++round === 1
      ? { tool_calls: [{ index: 0, id: 'project-list', type: 'function', function: { name: 'conversation_list', arguments: '{}' } }] }
      : { content: 'PROJECT_TOOLS_OK' };
    try {
      await within(bridge.submit('List project conversations'));
      const result = (await bridge.snapshot()).messages.find(m => m.role === 'tool' && m.tool_call_id === 'project-list');
      assert.equal(JSON.parse(result.content).currentId, 'fixture');
    } finally { modelReply = () => ({ content: 'KERNEL_REPLY_OK' }); }
  });
  await check('collaboration delivery and wait execute through real model tools and plugin handlers', async () => {
    const task = tasks.create('coordinator', 'fixture', 'Check evidence', 'Check evidence'); tasks.start(task.id);
    task.text = 'PROCESS LOG MUST NOT ENTER SUMMARY';
    const delivery = { summary: 'Evidence checked', artifacts: [{ label: 'Report', path: path.join(dir, 'report.md') }], unresolved: [] };
    let round = 0;
    modelReply = () => ++round === 1
      ? { tool_calls: [{ index: 0, id: 'deliver-call', type: 'function', function: { name: 'conversation_deliver', arguments: JSON.stringify({ id: task.id, ...delivery }) } }] }
      : { content: 'DELIVERY_SUBMITTED' };
    try {
      await within(bridge.submit('Submit the explicit delivery for this fixture task'));
      const result = (await bridge.snapshot()).messages.find(m => m.role === 'tool' && m.tool_call_id === 'deliver-call');
      assert.equal(JSON.parse(result.content).submitted, true);
      assert.deepEqual(tasks.get(task.id).delivery, delivery);
      assert.equal(tasks.get(task.id).state, 'running', 'delivery is not turn completion');
      const controller = new AbortController(); controller.abort();
      await assert.rejects(bridge.core.handlers.call('ashub:collaboration:wait', { targets: [{ id: task.id }], signal: controller.signal }));
      await assert.rejects(bridge.core.handlers.call('ashub:collaboration:deliver', { id: task.id, delivery, signal: controller.signal }));
      const pending = bridge.core.handlers.call('ashub:collaboration:wait', { targets: [{ id: task.id }], waitMs: 1000 });
      await bridge.core.handlers.call('ashub:collaboration:deliver', { id: task.id, delivery: { ...delivery, summary: 'Updated evidence checked' } });
      tasks.finish(task.id, 'completed');
      const first = await within(pending);
      assert.equal(first.results[0].delivery.summary, 'Updated evidence checked');
      assert(!JSON.stringify(first).includes('PROCESS LOG'));
      assert.equal((await bridge.core.handlers.call('ashub:collaboration:wait', { targets: first.cursors })).reason, 'settled');
      round = 0;
      modelReply = () => ++round === 1
        ? { tool_calls: [{ index: 0, id: 'wait-call', type: 'function', function: { name: 'conversation_wait', arguments: JSON.stringify({ targets: [{ id: task.id }], waitMs: 0 }) } }] }
        : { content: 'RESULT_COLLECTED' };
      await within(bridge.submit('Collect the completed fixture result'));
      const collected = (await bridge.snapshot()).messages.find(m => m.role === 'tool' && m.tool_call_id === 'wait-call');
      assert.equal(JSON.parse(collected.content).results[0].delivery.summary, 'Updated evidence checked');
      assert(!collected.content.includes('PROCESS LOG'));
    } finally { modelReply = () => ({ content: 'KERNEL_REPLY_OK' }); }
  });
  await check('large delivery batches survive actual kernel output limits with complete cursors', async () => {
    const targets = [], seen = new Set();
    const delivery = { summary: '结'.repeat(2000), artifacts: Array.from({ length: 8 }, (_, i) => ({ label: String(i) + '件'.repeat(119), path: 'p'.repeat(1000) })), unresolved: Array(8).fill('题'.repeat(300)) };
    for (let i = 0; i < 16; i++) {
      const task = tasks.create('coordinator', 'fixture', 'work' + i, 'work' + i); tasks.start(task.id);
      await access.deliver(task.id, delivery); tasks.finish(task.id, 'completed'); targets.push({ id: task.id });
    }
    let round = 0;
    modelReply = () => ++round === 1
      ? { tool_calls: [{ index: 0, id: 'large-wait-call', type: 'function', function: { name: 'conversation_wait', arguments: JSON.stringify({ targets, waitMs: 0 }) } }] }
      : { content: 'LARGE_PAGE_COLLECTED' };
    try {
      await within(bridge.submit('Collect the completed large fixture batch'));
      const toolResult = (await bridge.snapshot()).messages.find(m => m.role === 'tool' && m.tool_call_id === 'large-wait-call');
      let page = JSON.parse(toolResult.content);
      assert(page.hasMore); assert.equal(page.cursors.length, 16);
      for (let n = 0; n < 17; n++) {
        for (const result of page.results) { assert(!seen.has(result.id)); seen.add(result.id); assert.deepEqual(result.delivery, delivery); }
        if (!page.hasMore) break;
        page = await bridge.core.handlers.call('ashub:collaboration:wait', { targets: page.cursors, waitMs: 0 });
      }
      assert.equal(seen.size, 16);
      assert.equal((await access.waitTasks(page.cursors, 0)).reason, 'settled');
    } finally { modelReply = () => ({ content: 'KERNEL_REPLY_OK' }); }
  });
  await check('bridge subagent delegates through the installed upstream runner', async () => {
    const result = await within(bridge.core.handlers.call('subagent:run', { task: 'compatibility child', systemPrompt: 'Reply briefly', tools: [], maxIterations: 2 }));
    assert.match(typeof result === 'string' ? result : JSON.stringify(result), /KERNEL_REPLY_OK/);
  });
  const committedTool = {
    name: 'fixture_append_once', description: 'Append a receipt in the test directory', modifiesFiles: true,
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async ({ path: target }) => {
      assert.equal(path.dirname(target), dir);
      await fs.appendFile(target, 'one write\n');
      return { content: 'COMMITTED_TOOL_RECEIPT', exitCode: 0, isError: false };
    },
  };
  bridge.extCtx.agent.registerTool(committedTool);
  for (const mode of ['synchronous', 'background']) await check('subagent retries the interrupted request without repeating a completed tool (' + mode + ')', async () => {
    const task = 'Resume the ' + mode + ' fixture after a model stream interruption';
    const target = path.join(dir, 'subagent-retry-' + mode + '.txt');
    const hasReceipt = data => data.messages.some(message => message.role === 'tool' && message.content === 'COMMITTED_TOOL_RECEIPT');
    let cut = false, approvals = 0, toolStarts = 0, settled;
    const terminal = new Promise(resolve => { settled = resolve; });
    const off = bridge.onEvent(event => {
      if (event.name === 'permission:request') {
        approvals++;
        queueMicrotask(() => bridge.decidePermission(event.payload.requestId, 'approved'));
      }
      if (event.name === 'agent:tool-started' && event.payload.name === committedTool.name) toolStarts++;
      if (event.name === 'subagent:done' && event.payload.task === task) settled(event.payload);
    });
    const before = requests.length;
    modelReply = data => hasReceipt(data) ? { content: cut ? 'RECOVERED_CHILD' : 'ABANDONED_CHILD_FRAGMENT' }
      : { tool_calls: [{ index: 0, id: 'fixture-tool', type: 'function', function: { name: committedTool.name, arguments: JSON.stringify({ path: target }) } }] };
    cutModelStream = data => {
      if (cut || !hasReceipt(data)) return false;
      cut = true;
      return true;
    };
    try {
      const result = await within(bridge.core.handlers.call('subagent:run', { task, tools: [committedTool], maxIterations: 3, async: mode === 'background' }));
      if (mode === 'background') assert.match(result, /^subagent:sa\d+$/);
      else {
        assert.match(result, /RECOVERED_CHILD/);
        assert.doesNotMatch(result, /ABANDONED_CHILD_FRAGMENT/);
      }
      const done = await within(terminal);
      assert.equal(done.error, undefined);
      assert.equal(done.cancelled, undefined);
      assert.equal(done.degraded, null);
      assert.equal(done.tokensUsed, 6, 'charge the two successful model rounds once each');
      const rounds = requests.slice(before);
      assert.deepEqual(rounds.map(hasReceipt), [false, true, true]);
      assert.deepEqual(rounds[1].messages, rounds[2].messages);
      assert.equal(approvals, 1);
      assert.equal(toolStarts, 1);
      assert.equal(await fs.readFile(target, 'utf8'), 'one write\n');
      if (mode === 'background') {
        assert.equal(done.resumable, true);
        cutModelStream = undefined;
        modelReply = () => ({ content: 'BACKGROUND_CONTINUATION_OK' });
        const continued = await within(bridge.core.handlers.call('subagent:resume', {
          id: done.subagentId, task: 'Report the background receipt.'
        }));
        assert.match(continued, /BACKGROUND_CONTINUATION_OK/);
        assert.equal(requests.length, before + 4);
        assert(hasReceipt(requests.at(-1)));
        assert.equal(toolStarts, 1);
        assert.equal(await fs.readFile(target, 'utf8'), 'one write\n');
      }
    } finally {
      off();
      cutModelStream = undefined;
      modelReply = () => ({ content: 'KERNEL_REPLY_OK' });
    }
  });
  await check('subagent never dispatches a tool received before an unterminated clean SSE close', async () => {
    const target = path.join(dir, 'subagent-clean-eof.txt');
    const hasReceipt = data => data.messages.some(message => message.role === 'tool' && message.tool_call_id === 'committed-call');
    const write = id => ({ tool_calls: [{ index: 0, id, type: 'function', function: {
      name: committedTool.name, arguments: JSON.stringify({ path: target }),
    } }] });
    let cut = false, approvals = 0;
    const off = bridge.onEvent(event => {
      if (event.name !== 'permission:request') return;
      approvals++;
      queueMicrotask(() => bridge.decidePermission(event.payload.requestId, 'approved'));
    });
    const before = requests.length;
    modelReply = data => !hasReceipt(data) ? write('committed-call') : !cut ? write('uncommitted-call') : { content: 'CLEAN_EOF_RECOVERED' };
    cutModelStream = data => {
      if (cut || !hasReceipt(data)) return false;
      cut = true;
      return 'eof';
    };
    try {
      const result = await within(bridge.core.handlers.call('subagent:run', {
        task: 'Recover a receipt after the partial tool stream closed', tools: [committedTool], maxIterations: 3,
      }));
      assert.match(result, /CLEAN_EOF_RECOVERED/);
      const rounds = requests.slice(before);
      assert.deepEqual(rounds.map(hasReceipt), [false, true, true]);
      assert.deepEqual(rounds[1].messages, rounds[2].messages);
      assert(!JSON.stringify(rounds[2].messages).includes('uncommitted-call'));
      assert.equal(approvals, 1);
      assert.equal(await fs.readFile(target, 'utf8'), 'one write\n');
    } finally {
      off();
      cutModelStream = undefined;
      modelReply = () => ({ content: 'KERNEL_REPLY_OK' });
    }
  });
  const subagentProbeName = 'subagent_cancel_probe';
  const subagentProbeDelta = () => ({
    content: 'UNFINISHED_CHILD_TEXT',
    tool_calls: [{ index: 0, id: 'cancel-probe', type: 'function', function: { name: subagentProbeName, arguments: '{}' } }],
  });
  let onSubagentProbe;
  const subagentProbe = {
    name: subagentProbeName, description: 'Local subagent lifecycle probe', input_schema: { type: 'object', properties: {} },
    execute: async (_args, _onChunk, ctx) => {
      await onSubagentProbe?.(ctx.signal);
      return { content: 'PROBE_RESULT', exitCode: 0, isError: false };
    },
  };
  bridge.extCtx.agent.registerTool(subagentProbe);
  for (const mode of ['synchronous', 'background', 'timeout', 'swarm']) {
    await check('bridge settles real subagent cancellation consistently (' + mode + ')', async () => {
      const controller = new AbortController();
      const started = [], done = [];
      let settled;
      const children = mode === 'swarm' ? 2 : 1;
      const donePromise = new Promise(resolve => { settled = resolve; });
      const off = bridge.onEvent(event => {
        if (event.name === 'subagent:started') started.push(event.payload);
        if (event.name === 'subagent:done') {
          done.push(event.payload);
          if (done.length === children) settled();
        }
      });
      let probeCalls = 0;
      const probeSignals = [];
      onSubagentProbe = async signal => {
        probeSignals.push(signal);
        if (++probeCalls < children) {
          if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          return;
        }
        if (mode === 'background') bridge.cancel(); // No parent turn is active.
        else if (mode === 'timeout') controller.abort(new DOMException('fixture deadline', 'TimeoutError'));
        else controller.abort();
      };
      modelReply = subagentProbeDelta;
      try {
        const task = 'Cancellation fixture ' + mode;
        const before = requests.length;
        if (mode === 'swarm') {
          const tool = bridge.extCtx.agent.getTools().find(tool => tool.name === 'agentswarm');
          const aggregate = await within(tool.execute({ type: 'implement', prompt_template: task + ' {{item}}', items: ['first', 'second'] }, undefined, { signal: controller.signal }));
          assert.match(aggregate.content, /0 succeeded, 2 failed, 0 partial, 2 total/);
          assert.equal(aggregate.content.match(/Subagent cancelled\./g)?.length, 2);
          assert(!aggregate.content.includes('UNFINISHED_CHILD_TEXT'));
        } else {
          const result = await within(bridge.core.handlers.call('subagent:run', {
            task, tools: [subagentProbe], maxIterations: 2, signal: controller.signal, async: mode === 'background',
          }));
          if (mode === 'background') assert.match(result, /^subagent:sa\d+$/);
          else if (mode === 'timeout') {
            assert.equal(result.subagentTimedOut, true);
            assert.match(result.message, /timeout after 20min/);
          } else assert.deepEqual(result, { subagentCancelled: true, message: 'Subagent cancelled.' });
        }
        await within(donePromise);
        assert.equal(requests.length - before, children, 'cancellation must not retry model requests');
        assert.equal(probeCalls, children);
        assert(probeSignals.every(signal => signal.aborted));
        assert.equal(started.length, children);
        assert.equal(done.length, children);
        for (const event of done) {
          assert(started.some(start => start.subagentId === event.subagentId));
          assert.equal(event.degraded, null);
          assert.equal(event.tokensUsed, 3);
          if (mode === 'timeout') {
            assert.equal(event.error, 'timeout after 20min');
            assert.equal(event.cancelled, undefined);
          } else {
            assert.equal(event.cancelled, true);
            assert.equal(event.error, undefined);
            assert.equal(event.result, undefined);
            const resumed = await within(bridge.core.handlers.call('subagent:resume', { id: event.subagentId, task: 'Forbidden resume fixture' }));
            assert.match(resumed, /^Error: .*no (?:resumable result|completed subagent run)/);
          }
        }
        if (mode === 'background') {
          modelReply = () => ({ content: 'CANCELLATION_STATUS_READ' });
          await within(bridge.submit('Read the background state'));
          const context = JSON.stringify(requests.at(-1).messages);
          assert(context.includes('Cancelled: \\"Cancellation fixture background\\"'));
          assert(!context.includes('UNFINISHED_CHILD_TEXT'));
        }
      } finally {
        modelReply = () => ({ content: 'KERNEL_REPLY_OK' });
        onSubagentProbe = undefined;
        off();
      }
    });
  }
  await check('bridge reports actual subagent completion and partial progress independently', async () => {
    const done = [];
    const off = bridge.onEvent(event => { if (event.name === 'subagent:done') done.push(event.payload); });
    try {
      modelReply = () => ({ content: 'Quoted warning: [Subagent terminated: max iterations] from an old report.' });
      await within(bridge.core.handlers.call('subagent:run', { task: 'Complete fixture', tools: [], maxIterations: 1 }));
      modelReply = subagentProbeDelta;
      await within(bridge.core.handlers.call('subagent:run', { task: 'Partial fixture', tools: [subagentProbe], maxIterations: 1 }));
      assert.deepEqual(done.map(({ cancelled, degraded, error }) => [cancelled, degraded, error]), [
        [undefined, null, undefined], [undefined, 'iterations', undefined],
      ]);
      assert.equal(done[1].resumable, true);
      const before = requests.length;
      modelReply = () => ({ content: 'PARTIAL_CONTINUATION_OK' });
      const resumed = await within(bridge.core.handlers.call('subagent:resume', {
        id: done[1].subagentId, task: 'Continue from the available evidence',
      }));
      assert.match(resumed, /PARTIAL_CONTINUATION_OK/);
      assert.equal(requests.length - before, 1);
      assert(requests[before].messages.some(message => message.role === 'tool' && message.content === 'PROBE_RESULT'));
    } finally {
      off();
      modelReply = () => ({ content: 'KERNEL_REPLY_OK' });
    }
  });
  await check('child events carry the exact tool launch ID during a multi-tool turn', async () => {
    const ids = new Map([['First launch fixture', 'launch-a'], ['Second launch fixture', 'launch-b']]);
    const events = [];
    const off = bridge.onEvent(event => {
      if (event.name === 'subagent:started' || event.name === 'subagent:done') events.push(event);
    });
    let chooseTools = true;
    modelReply = () => {
      if (!chooseTools) return { content: 'LINKED_FIXTURE_RESULT' };
      chooseTools = false;
      return { tool_calls: Array.from(ids, ([task, id], index) => ({
        index, id, type: 'function', function: { name: 'plan', arguments: JSON.stringify({ task }) },
      })) };
    };
    try {
      await within(bridge.submit('Launch two child tasks'));
      assert.equal(events.length, 4);
      for (const [task, id] of ids) {
        const childEvents = events.filter(event => event.payload.task === task);
        assert.deepEqual(childEvents.map(event => event.name), ['subagent:started', 'subagent:done']);
        assert(childEvents.every(event => event.payload.toolCallId === id));
        assert.equal(childEvents[0].payload.subagentId, childEvents[1].payload.subagentId);
      }
    } finally {
      off();
      modelReply = () => ({ content: 'KERNEL_REPLY_OK' });
    }
  });
  await check('stopping a main turn also settles its linked synchronous child', async () => {
    const task = 'Stop the linked test child';
    const childEvents = [];
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const off = bridge.onEvent(event => {
      if (event.payload?.task !== task || !event.name.startsWith('subagent:')) return;
      childEvents.push(event);
      if (event.name === 'subagent:done') finish();
    });
    let chooseTool = true;
    modelReply = () => {
      if (!chooseTool) return subagentProbeDelta();
      chooseTool = false;
      return { tool_calls: [{ index: 0, id: 'stop-linked-child', type: 'function', function: {
        name: 'implement', arguments: JSON.stringify({ task }),
      } }] };
    };
    onSubagentProbe = () => bridge.cancel();
    try {
      assert.deepEqual(await within(bridge.submit('Launch a child and stop')), { stopReason: 'cancelled' });
      await within(finished);
      assert.deepEqual(childEvents.map(event => [event.name, event.payload.toolCallId]), [
        ['subagent:started', 'stop-linked-child'], ['subagent:done', 'stop-linked-child'],
      ]);
      const { cancelled, error, degraded } = childEvents[1].payload;
      assert.equal(cancelled, true);
      assert.equal(error, undefined);
      assert.equal(degraded, null);
    } finally {
      off();
      onSubagentProbe = undefined;
      modelReply = () => ({ content: 'KERNEL_REPLY_OK' });
    }
  });
  await check('stopping a launch waiting for a slot settles its card before any child starts', async () => {
    const task = 'Fixture waiting for a subagent slot';
    const unlinkedTask = 'Fixture without a launch card';
    const toolCallId = 'stop-waiting-child';
    const slots = 10;
    let started = 0, finished = 0, occupy, release, settle;
    const occupied = new Promise(resolve => { occupy = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const settled = new Promise(resolve => { settle = resolve; });
    const childEvents = [];
    const off = bridge.onEvent(event => {
      if (event.name === 'agent:tool-started' && event.payload.toolCallId === toolCallId) queueMicrotask(() => bridge.cancel());
      if (event.name === 'subagent:done' && event.payload.task.startsWith('Occupied fixture slot ')) {
        if (++finished === slots) release();
      }
      if ([task, unlinkedTask].includes(event.payload?.task) && event.name.startsWith('subagent:')) childEvents.push(event);
      if (event.name === 'subagent:done' && event.payload.toolCallId === toolCallId) settle();
    });
    onSubagentProbe = async signal => {
      if (++started === slots) occupy();
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    };
    modelReply = subagentProbeDelta;
    try {
      await within(Promise.all(Array.from({ length: slots }, (_, index) => bridge.core.handlers.call('subagent:run', {
        task: 'Occupied fixture slot ' + index, tools: [subagentProbe], async: true,
      }))));
      await within(occupied);
      const direct = new AbortController();
      const waiting = bridge.core.handlers.call('subagent:run', { task: unlinkedTask, signal: direct.signal });
      direct.abort();
      assert.deepEqual(await within(waiting), { subagentCancelled: true, message: 'Subagent cancelled.' });

      const before = requests.length;
      modelReply = () => ({ tool_calls: [{ index: 0, id: toolCallId, type: 'function', function: {
        name: 'plan', arguments: JSON.stringify({ task }),
      } }] });
      assert.deepEqual(await within(bridge.submit('Stop a waiting launch')), { stopReason: 'cancelled' });
      await within(settled);
      await within(released);
      assert.equal(requests.length - before, 1, 'only the parent model should be called');
      assert.equal(childEvents.length, 1);
      assert.equal(childEvents[0].name, 'subagent:done');
      assert.deepEqual(childEvents[0].payload, {
        task, toolCallId, cancelled: true, degraded: null, tokensUsed: 0,
      });
    } finally {
      bridge.cancel();
      off();
      onSubagentProbe = undefined;
      modelReply = () => ({ content: 'KERNEL_REPLY_OK' });
    }
  });
  await check('subagent continuation retains long task and tool evidence without crossing approval or cancellation boundaries', async () => {
    const task = 'Record one verified receipt.\n' + 'Original task constraint. '.repeat(160) + 'ORIGINAL_TASK_TAIL';
    const detail = 'Recorded detail. '.repeat(520) + 'TOOL_EVIDENCE_AT_END';
    const recap = 'The approved operation is complete. '.repeat(160) + 'ASSISTANT_RESULT_AT_END';
    const originalPath = path.join(dir, 'resumed-original.txt');
    const deniedPath = path.join(dir, 'resumed-denied.txt');
    const appendTool = {
      ...committedTool, name: 'fixture_continuation_receipt',
      async execute(args) {
        return { ...await committedTool.execute(args), content: detail };
      },
    };
    bridge.extCtx.agent.registerTool(appendTool);
    const toolCall = (id, target) => ({ tool_calls: [{ index: 0, id, type: 'function', function: {
      name: appendTool.name, arguments: JSON.stringify({ path: target }),
    } }] });
    const toolResult = (data, id) => data.messages.find(message => message.role === 'tool' && message.tool_call_id === id)?.content;
    const resultId = result => {
      const id = /\n\nSubagent id: (\S+) /.exec(result)?.[1];
      assert(id, 'completed child must carry its continuation ID');
      return id;
    };
    const assertEvidence = data => {
      assert(data.messages.some(message => message.role === 'user' && message.content === task));
      const call = data.messages.find(message => message.role === 'assistant' && message.tool_calls?.some(tool => tool.id === 'original-receipt'));
      assert.deepEqual(call?.tool_calls[0]?.function, { name: appendTool.name, arguments: JSON.stringify({ path: originalPath }) });
      assert.equal(toolResult(data, 'original-receipt'), detail);
      assert(data.messages.some(message => message.role === 'assistant' && message.content === recap));
    };
    let approvals = 0, decision = 'approved';
    const offApproval = bridge.onEvent(event => {
      if (event.name !== 'permission:request') return;
      approvals++;
      const verdict = decision;
      queueMicrotask(() => bridge.decidePermission(event.payload.requestId, verdict));
    });
    try {
      modelReply = data => toolResult(data, 'original-receipt') ? { content: recap } : toolCall('original-receipt', originalPath);
      const original = await within(bridge.core.handlers.call('subagent:run', { task, tools: [appendTool, subagentProbe] }));
      assert.match(original, /ASSISTANT_RESULT_AT_END/);
      const originalId = resultId(original);

      decision = 'denied';
      const followUp = 'Try appending a separate receipt, subject to fresh approval.';
      let before = requests.length;
      modelReply = data => toolResult(data, 'denied-receipt') ? { content: 'NEW_WRITE_DENIED' } : toolCall('denied-receipt', deniedPath);
      const continued = await within(bridge.core.handlers.call('subagent:resume', { id: originalId, task: followUp }));
      assert.match(continued, /NEW_WRITE_DENIED/);
      assert.equal(requests.length - before, 2);
      assertEvidence(requests[before]);
      assert.equal(requests[before].messages.at(-1).content, followUp);
      assert.match(toolResult(requests.at(-1), 'denied-receipt'), /Permission denied/);
      const continuedId = resultId(continued);

      const controller = new AbortController();
      const cancelledEvents = [];
      const offCancelled = bridge.onEvent(event => {
        if (event.name === 'subagent:done' && event.payload.cancelled) cancelledEvents.push(event.payload);
      });
      try {
        onSubagentProbe = () => controller.abort();
        modelReply = subagentProbeDelta;
        const cancelled = await within(bridge.core.handlers.call('subagent:resume', {
          id: continuedId, task: 'Interrupted follow-up must not become evidence', signal: controller.signal,
        }));
        assert.deepEqual(cancelled, { subagentCancelled: true, message: 'Subagent cancelled.' });
        assert.equal(cancelledEvents.length, 1);
        before = requests.length;
        assert.match(await within(bridge.core.handlers.call('subagent:resume', {
          id: cancelledEvents[0].subagentId, task: 'Attempt to reuse cancelled evidence',
        })), /^Error: .*no (?:resumable result|completed subagent run)/);
        assert.equal(requests.length, before);
      } finally { offCancelled(); }

      modelReply = () => ({ content: 'CHAINED_CONTINUATION_OK' });
      const chained = await within(bridge.core.handlers.call('subagent:resume', { id: continuedId, task: 'Report the earlier approval outcomes.' }));
      assert.match(chained, /CHAINED_CONTINUATION_OK/);
      const lastRequest = requests.at(-1);
      assertEvidence(lastRequest);
      assert.match(toolResult(lastRequest, 'denied-receipt'), /Permission denied/);
      assert.doesNotMatch(JSON.stringify(lastRequest.messages), /Interrupted follow-up|UNFINISHED_CHILD_TEXT/);
      assert.equal(approvals, 2);
      assert.equal(await fs.readFile(originalPath, 'utf8'), 'one write\n');
      await assert.rejects(fs.stat(deniedPath), { code: 'ENOENT' });
    } finally {
      offApproval();
      onSubagentProbe = undefined;
      modelReply = () => ({ content: 'KERNEL_REPLY_OK' });
    }
  });
  await check('concurrent continuations isolate retry history, late approvals and cancellation', async () => {
    const starting = 'Record the original concurrent fixture receipt';
    const retrying = 'Continue the branch that will recover from a cut';
    const stopping = 'Continue the branch that will stop during approval';
    const checking = 'Check the checkpoint without granting either continuation approval';
    const targets = new Map([starting, retrying, stopping, checking].map((task, index) => [task, path.join(dir, `parallel-receipt-${index}.txt`)]));
    const toolIds = new Map([...targets.keys()].map((task, index) => [task, `parallel-call-${index}`]));
    const taskOf = data => data.messages.findLast(message => message.role === 'user')?.content;
    const output = (data, task) => data.messages.find(message => message.role === 'tool' && message.tool_call_id === toolIds.get(task))?.content;
    let waitingApproval;
    const approvalReached = new Promise(resolve => { waitingApproval = resolve; });
    const controller = new AbortController();
    const completions = [], approvals = [], toolStarts = [];
    let cut = false, retryNotices = 0;
    const off = bridge.onEvent(event => {
      if (event.name === 'permission:request') {
        const task = [...targets].find(([, target]) => target === event.payload.metadata?.filePath)?.[0];
        if (!task) return;
        const {requestId} = event.payload;
        approvals.push(task);
        if (task === stopping) waitingApproval(requestId);
        else queueMicrotask(() => bridge.decidePermission(requestId, task === checking ? 'denied' : 'approved'));
      }
      if (event.name === 'agent:tool-started' && event.payload.name === committedTool.name) toolStarts.push(event.payload.rawInput.path);
      if (event.name === 'subagent:done' && targets.has(event.payload.task)) completions.push(event.payload);
      if (event.name === 'ui:info' && cut && /\bretrying\b/.test(event.payload?.message ?? '')) {
        retryNotices++;
        controller.abort();
      }
    });
    modelReply = data => {
      const task = taskOf(data);
      if (output(data, task) !== undefined) return { content: task === retrying && !cut ? 'DISCARDED_RETRY_FRAGMENT' : 'PARALLEL_RECEIPT_REVIEWED' };
      return { tool_calls: [{ index: 0, id: toolIds.get(task), type: 'function', function: {
        name: committedTool.name, arguments: JSON.stringify({ path: targets.get(task) }),
      } }] };
    };
    cutModelStream = data => {
      if (cut || taskOf(data) !== retrying || output(data, retrying) === undefined) return false;
      cut = true;
      return true;
    };
    const before = requests.length;
    try {
      const original = await within(bridge.core.handlers.call('subagent:run', { task: starting, tools: [committedTool] }));
      const id = /\n\nSubagent id: (\S+) /.exec(original)?.[1];
      assert(id);
      const resume = (task, signal) => bridge.core.handlers.call('subagent:resume', { id, task, signal });
      const cancelled = resume(stopping, controller.signal);
      const lateId = await within(approvalReached);
      const recovered = resume(retrying);
      const [cancelledResult, recoveredResult] = await within(Promise.all([cancelled, recovered]));
      assert.deepEqual(cancelledResult, { subagentCancelled: true, message: 'Subagent cancelled.' });
      assert.match(recoveredResult, /PARALLEL_RECEIPT_REVIEWED/);
      assert.doesNotMatch(recoveredResult, /DISCARDED_RETRY_FRAGMENT/);
      // An approval arriving after its child was cancelled must not grant a
      // write to this or any later continuation.
      bridge.decidePermission(lateId, 'approved', true);
      assert.match(await within(resume(checking)), /PARALLEL_RECEIPT_REVIEWED/);

      const observed = requests.slice(before);
      const resumedRequests = observed.filter(data => taskOf(data) === retrying);
      assert.equal(retryNotices, 1);
      assert.equal(resumedRequests.length, 3);
      assert.deepEqual(resumedRequests[1].messages, resumedRequests[2].messages);
      assert.equal(observed.filter(data => taskOf(data) === stopping).length, 1);
      assert(!JSON.stringify(resumedRequests[2].messages).includes(stopping));
      const checkingRequests = observed.filter(data => taskOf(data) === checking);
      assert.equal(checkingRequests.length, 2);
      assert.equal(output(checkingRequests[0], starting), 'COMMITTED_TOOL_RECEIPT');
      assert.equal(output(checkingRequests[0], retrying), undefined);
      assert.match(output(checkingRequests[1], checking), /Permission denied/);
      assert.deepEqual(approvals, [starting, stopping, retrying, checking]);
      assert.deepEqual(toolStarts, [targets.get(starting), targets.get(retrying)]);
      assert.equal(completions.filter(event => event.task === stopping && event.cancelled).length, 1);
      assert.equal(completions.filter(event => event.task === retrying && event.resumable && !event.cancelled && !event.error).length, 1);
      for (const task of [starting, retrying]) assert.equal(await fs.readFile(targets.get(task), 'utf8'), 'one write\n');
      for (const task of [stopping, checking]) await assert.rejects(fs.stat(targets.get(task)), { code: 'ENOENT' });
    } finally {
      controller.abort();
      off();
      cutModelStream = undefined;
      modelReply = () => ({ content: 'KERNEL_REPLY_OK' });
    }
  });
  await check('real tool execution and permission denial stay enforced', async () => {
    const target = path.join(dir, 'denied.txt');
    let round = 0; modelReply = () => ++round === 1
      ? { tool_calls: [{ index: 0, id: 'write-call', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: target, content: 'must not be written' }) } }] }
      : { content: 'DENIED_HANDLED' };
    let decisions = 0;
    const off = bridge.onEvent(e => { if (e.name === 'permission:request') { decisions++; queueMicrotask(() => bridge.decidePermission(e.payload.requestId, 'denied')); } });
    try { await within(bridge.submit('attempt a denied write')); assert.equal(decisions, 1); await assert.rejects(fs.stat(target), { code: 'ENOENT' }); assert(requests.at(-1).messages.some(m => m.role === 'tool' && JSON.stringify(m).includes('Permission denied'))); }
    finally { off(); modelReply = () => ({ content: 'KERNEL_REPLY_OK' }); }
  });
  const deepseek = new AshBridge({ cwd: dir, provider: 'deepseek' }); bridges.add(deepseek);
  await check('DeepSeek defaults to Flash 1017 with vision and correct limits', async () => {
    await within(deepseek.ready());
    assert.equal(deepseek.core.handlers.call('agent:get-model').model, 'deepseek-flash');
    const models = deepseek.core.handlers.call('agent:get-models').filter(m => m.provider === 'deepseek');
    assert.equal(models.length, 4);
    for (const model of models) {
      assert.equal(model.contextWindow, 1048576);
      assert.equal(model.maxTokens, 393216);
      assert.equal(model.echoReasoning, true);
      assert.equal(model.modalities.includes('image'), model.id !== 'deepseek-v4-pro');
    }
  });
  await check('DeepSeek sends each supported native thinking level on the actual request', async () => {
    for (const [level, expected] of [['off', null], ['low', 'low'], ['high', 'high'], ['max', 'max']]) {
      deepseek.setThinking(level);
      await within(deepseek.submit('thinking ' + level));
      const request = requests.at(-1);
      assert.equal(request.model, 'deepseek-flash');
      assert.equal(request.thinking.type, expected ? 'enabled' : 'disabled');
      assert.equal(request.reasoning_effort, expected ?? undefined);
    }
  });
  await check('DeepSeek new and legacy Flash IDs send images, Pro stays text-only', async () => {
    for (const id of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) {
      await deepseek.execCommand('/model', id + '@deepseek');
      await within(deepseek.submit(JSON.stringify({ query: 'image test', images: [{ data: 'AA==', mimeType: 'image/png' }] })));
      const request = requests.at(-1);
      assert.equal(request.model, id);
      const message = request.messages.filter(m => m.role === 'user').at(-1);
      assert.equal(Array.isArray(message.content) && message.content.some(c => c.type === 'image_url'), id !== 'deepseek-v4-pro');
    }
    await deepseek.execCommand('/model', 'deepseek-flash@deepseek');
  });
  await check('DeepSeek tool continuation preserves reasoning_content', async () => {
    let round = 0;
    modelReply = () => ++round === 1
      ? { reasoning_content: 'THINKING_FOR_TOOL', tool_calls: [{ index: 0, id: 'read-deepseek', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: path.join(dir, 'AGENTS.md') }) } }] }
      : { content: 'DEEPSEEK_TOOL_OK' };
    try {
      await within(deepseek.submit('read the fixture'));
      const request = requests.at(-1);
      assert(request.messages.some(m => m.role === 'assistant' && m.reasoning_content === 'THINKING_FOR_TOOL'));
      assert(request.messages.some(m => m.role === 'tool' && m.tool_call_id === 'read-deepseek'));
    } finally { modelReply = () => ({ content: 'KERNEL_REPLY_OK' }); }
  });
  await check('DeepSeek subagents use mapped effort and retain it after provider reload', async () => {
    for (const [level, expected] of [['medium', 'high'], ['xhigh', 'max']]) {
      deepseek.execCommand('/sa-budget', JSON.stringify({ type: 'review', reasoning: level }));
      deepseek.reloadProviders();
      await within(deepseek.core.handlers.call('subagent:run', { type: 'review', task: 'test child', tools: [], maxIterations: 1 }));
      assert.equal(requests.at(-1).reasoning_effort, expected);
      assert.equal(requests.at(-1).thinking.type, 'enabled');
    }
    const endpoint = deepseek.core.handlers.call('agent:resolve-endpoint', { provider: 'deepseek', id: 'deepseek-flash' });
    assert.equal(endpoint.extractCachedTokens({ prompt_cache_hit_tokens: 123 }), 123);
    // Provider changes keep the generic kernel vocabulary valid.
    await deepseek.execCommand('/model', 'compat-model@compat');
    assert.equal(deepseek.getThinking().supported, false);
    assert.throws(() => deepseek.setThinking('xhigh'));
    deepseek.core.bus.emit('config:set-thinking', {level:'xhigh'});
    await within(deepseek.submit('generic provider'));
    assert.equal(requests.at(-1).reasoning_effort, 'high');
    assert.equal(requests.at(-1).thinking, undefined);
  });
  await check('strict model rejects the original surrogate defect', async () => {
    const res = await originalFetch(modelOrigin + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '\ud83d' }] }),
    });
    assert.equal(res.status, 400);
  });
  await check('restored corrupt history sends safely without changing stored messages', async () => {
    const messages = [
      { role: 'user', content: 'Historical question 🟡' },
      { role: 'assistant', content: null, reasoning_content: 'Thinking \udfe1', tool_calls: [{ id: 'historical-read', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'historical-read', content: 'Historical output \ud83d' },
      { role: 'assistant', content: 'Done' },
    ];
    const original = JSON.stringify(messages);
    const b = new AshBridge({ cwd: dir, provider: 'deepseek', model: 'deepseek-flash', initialMessages: messages }); bridges.add(b);
    await within(b.ready()); await within(b.submit('Continue 🟡'));
    const request = requests.at(-1);
    assert(request.messages.some(m => m.role === 'tool' && m.content === 'Historical output �'));
    assert(request.messages.some(m => m.reasoning_content === 'Thinking �'));
    assert(JSON.stringify(request).includes('🟡'));
    assert.equal(JSON.stringify(messages.slice(0, 4)), original);
    assert(JSON.stringify((await b.snapshot()).messages).includes('\\ud83d'));
  });
  await check('subagent requests repair task, system prompt, tool schema and tool results', async () => {
    const probe = { name: 'unicode_probe', description: 'Description \ud83d', input_schema: { type: 'object', properties: {} }, execute: async () => ({ content: 'Tool \udfe1 🟡' }) };
    deepseek.extCtx.agent.registerTool(probe);
    let round = 0;
    modelReply = () => ++round === 1
      ? { tool_calls: [{ index: 0, id: 'unicode-tool', type: 'function', function: { name: 'unicode_probe', arguments: '{}' } }] }
      : { content: 'SUBAGENT_UNICODE_OK' };
    try {
      const result = await within(deepseek.core.handlers.call('subagent:run', {
        task: 'Task \ud83d 🟡', systemPrompt: 'System \udfe1', maxIterations: 2,
        tools: [probe],
      }));
      assert(JSON.stringify(result).includes('SUBAGENT_UNICODE_OK'));
      const request = requests.at(-1);
      assert(request.messages.some(m => m.role === 'tool' && m.content.includes('Tool � 🟡')), JSON.stringify(request.messages));
      assert(request.messages.some(m => m.role === 'system' && m.content.includes('System �')));
      assert.equal(request.tools[0].function.description, 'Description �');
    } finally { modelReply = () => ({ content: 'KERNEL_REPLY_OK' }); }
  });
  await check('non-streaming completion uses the same Unicode guard', async () => {
    assert.equal(await deepseek.complete([{ role: 'user', content: 'Title \ud83d 🟡' }]), 'KERNEL_REPLY_OK');
    assert.equal(requests.at(-1).messages[0].content, 'Title � 🟡');
  });
  await check('native grep never persists a split emoji at the 500-unit limit', async () => {
    const file = path.join(dir, 'unicode-grep.txt');
    // Scan adjacent positions because rg also prefixes file and line information.
    await fs.writeFile(file, Array.from({ length: 160 }, (_, i) => 'x'.repeat(350 + i) + '🟡' + 'x'.repeat(160)).join('\n'));
    const result = await bridge.core.handlers.call('tool:grep', { pattern: 'x', path: file, output_mode: 'content', head_limit: 0 });
    assert.equal(result.isError, false);
    assert(String(result.content).includes('[truncated]'));
    assert(String(result.content).isWellFormed());
    assert(!String(result.content).includes('�'));
  });
  await check('new subagent transcript/stop hooks preserve tools and usage', async () => {
    const messages = [], usages = [], meta = {}; let toolRuns = 0, streams = 0;
    const result = await runSubagent({
      llmClient: { stream: async function* () { streams++; yield { choices: [{ delta: { content: 'one round', tool_calls: [{ index: 0, id: 't1', function: { name: 'probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }; } },
      tools: [{ name: 'probe', description: 'local fixture', input_schema: { type: 'object', properties: {} }, execute: async () => { toolRuns++; return { content: 'tool-ok' }; } }],
      systemPrompt: 'fixture', task: 'probe', onMessage: m => messages.push(m), onUsage: u => usages.push(u), shouldStop: () => true, outMeta: meta,
    });
    assert.equal(result, 'one round'); assert.equal(streams, 1); assert.equal(toolRuns, 1);
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'tool']); assert.equal(messages[2].content, 'tool-ok'); assert.equal(usages[0].completion_tokens, 2); assert.equal(meta.tokensUsed, 2);
  });
  for (const kind of process.platform === 'win32' ? [] : ['terminal', 'ash-terminal']) await check(kind + ' real output/resize/natural exit/cleanup', async () => {
    const b = kind === 'terminal' ? new TerminalBridge({ cwd: dir }) : new AshBridge({ cwd: dir, kind, provider: 'compat', model: 'compat-model' }); bridges.add(b);
    const events = []; b.onEvent(e => events.push(e)); const closed = once(b, 'closed');
    await within(b.ready());
    if (kind === 'ash-terminal') {
      const prompt = b.core.handlers.call('system-prompt:build');
      assert.match(prompt, /^你是 asHub 中的 AI 助手/);
      assert.match(prompt, /当前是 asHub 的 agent 终端会话/);
      assert(!prompt.includes('当前是 asHub 的会话界面'));
    }
    b.resizePty(90, 25); b.writePty('printf "%s%s\\n" "ASH_NATIVE_" "OK"; exit 7\r');
    await within(closed);
    assert(events.some(e => e.name === 'shell:pty-data' && e.payload.raw.includes('ASH_NATIVE_OK')));
    assert.equal(events.filter(e => e.name === 'shell:exit').length, 1); assert.equal(events.find(e => e.name === 'shell:exit').payload.exitCode, 7);
    if (kind === 'ash-terminal') { assert.equal(b.shell, null); assert.equal(b.closed, true); }
    b.close(); bridges.delete(b);
  });
  if (process.platform === 'win32') console.log('SKIP native PTY cases: this fixture uses POSIX shells');
  console.log(JSON.stringify({ kernelCompatibilityChecks: passed, passed, network: 'loopback model fixture only' }));
} finally {
  for (const b of bridges) b.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  globalThis.fetch = originalFetch; clearTimeout(watchdog);
  await fs.rm(dir, { recursive: true, force: true });
}
