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
    const data = JSON.parse(raw); requests.push(data);
    const delta = modelReply(data);
    const base = { id: 'compat', object: 'chat.completion.chunk', created: 1, model: 'compat-model' };
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
    defaultProvider: 'compat', providers: { compat: { apiKey: 'fake-test-key', baseURL: modelOrigin + '/v1', defaultModel: 'compat-model', models: ['compat-model'], contextWindow: 32000 } },
    startupBanner: false, disabledBuiltins: ['rolling-history'],
  }));
  await fs.mkdir(path.join(dir, 'extensions'));
  await fs.writeFile(path.join(dir, 'extensions', 'compat.ts'), `
    await Promise.resolve();
    export default function activate(ctx: any) {
      ctx.bus.onPipe('compat:extension-loaded', () => ({ url: import.meta.url }));
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
  const bridge = new AshBridge({ cwd: dir, provider: 'compat', model: 'compat-model' }); bridges.add(bridge);
  await check('real AshBridge initializes with ESM TypeScript extension', async () => {
    await within(bridge.ready());
    assert.match(bridge.core.bus.emitPipe('compat:extension-loaded', { url: '' }).url, /compat\.ts/);
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'extensions/package.json'))).type, 'module');
    assert.equal(bridge.core.handlers.call('agent:get-model').model, 'compat-model');
  });
  await check('main agent streams a response and retains conversation', async () => {
    const events = []; const off = bridge.onEvent(e => events.push(e));
    try {
      await within(bridge.submit('compatibility main turn'));
      const snapshot = await bridge.snapshot();
      assert(snapshot.messages.some(m => JSON.stringify(m).includes('KERNEL_REPLY_OK')));
      assert(events.some(e => e.name === 'agent:response-chunk'));
      assert(requests.some(r => r.model === 'compat-model'));
    } finally { off(); }
  });
  await check('bridge subagent delegates through the actual 0.15.17 runner', async () => {
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
    await within(b.ready()); b.resizePty(90, 25); b.writePty('printf "%s%s\\n" "ASH_NATIVE_" "OK"; exit 7\r');
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
