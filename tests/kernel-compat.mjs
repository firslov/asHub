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
  const bridge = new AshBridge({ cwd: dir, provider: 'compat', model: 'compat-model', conversationAccess: {
    list: () => ({ currentId: 'fixture', project: { name: 'Fixture' }, conversations: [] }),
    read: async () => ({ messages: [] }), send: async () => ({ ok: true }),
  } }); bridges.add(bridge);
  await check('real AshBridge initializes with ESM TypeScript extension', async () => {
    await within(bridge.ready());
    assert.match(bridge.core.bus.emitPipe('compat:extension-loaded', { url: '' }).url, /compat\.ts/);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'extensions/package.json'))).type, 'module');
    assert.equal(bridge.core.handlers.call('agent:get-model').model, 'compat-model');
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
    for (const name of ['conversation_list', 'conversation_read', 'conversation_send']) assert(names.includes(name), name);
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
  await check('bridge subagent delegates through the installed upstream runner', async () => {
    const result = await within(bridge.core.handlers.call('subagent:run', { task: 'compatibility child', systemPrompt: 'Reply briefly', tools: [], maxIterations: 2 }));
    assert.match(typeof result === 'string' ? result : JSON.stringify(result), /KERNEL_REPLY_OK/);
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
      llmClient: { stream: async function* () { streams++; yield { choices: [{ delta: { content: 'one round', tool_calls: [{ index: 0, id: 't1', function: { name: 'probe', arguments: '{}' } }] } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }; } },
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
