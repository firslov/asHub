// Exercise the actual AshBridge + installed kernel, never user credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashub-codex-liveness-'));
process.env.AGENT_SH_HOME = dir;
if (process.platform !== 'win32') {
  const shell = path.join(dir, 'clean-bash');
  await fs.writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', {mode: 0o755});
  process.env.SHELL = shell;
}
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key) || key === 'OPENAI_BASE_URL') delete process.env[key];
const watchdog = setTimeout(() => { console.error('Codex liveness integration timed out'); process.exit(1); }, 45000);
const originalFetch = globalThis.fetch;
let outputSent = false, mode = 'delayed', requests = 0, headersBeforeOutput = false, upstreamClosed, onHeaders, transientSent = false;
let diagnosticFailureSent = false, largeToolRequests = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'external requests disabled');
  const response = await originalFetch(input, init);
  if (url.pathname.endsWith('/chat/completions')) { headersBeforeOutput = !outputSent; }
  return response;
};
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* consume */ }
  requests++;
  if (mode === 'retry-large-tool') {
    largeToolRequests++;
    if (largeToolRequests === 1) {
      res.writeHead(504, {'content-type': 'application/json', 'retry-after': '0'});
      res.end(JSON.stringify({error: {message: 'temporary upstream timeout'}}));
      return;
    }
    if (largeToolRequests === 2) {
      const tool = {type: 'function_call', id: 'large-tool', call_id: 'large-tool-call', name: 'read_file', arguments: JSON.stringify({path: path.join(dir, 'fixture.txt')})};
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write(`data: ${JSON.stringify({type: 'response.output_item.added', output_index: 0, item: tool})}\n\n`);
      res.end(`data: ${JSON.stringify({type: 'response.completed', response: {status: 'completed', output: [{type: 'reasoning', summary: [{type: 'summary_text', text: 'x'.repeat(4 * 1024 * 1024)}]}, tool]}})}\n\n`);
      return;
    }
  }
  if (['done-only', 'bad-200', 'headers-timeout', 'idle-timeout'].includes(mode) && !diagnosticFailureSent) {
    diagnosticFailureSent = true;
    if (mode === 'headers-timeout') return;
    if (mode === 'bad-200') { res.writeHead(200, {'content-type': 'text/html'}); res.end('<html>gateway failure</html>'); return; }
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (mode === 'done-only') res.end('data: [DONE]\n\n');
    else res.write('data: {"type":"response.created","response":{"id":"fixture"}}\n\n');
    return;
  }
  if (mode === 'retryable' && !transientSent) {
    transientSent = true;
    res.writeHead(504, {'content-type': 'application/json', 'retry-after': '0'});
    res.end(JSON.stringify({error: {message: 'temporary upstream timeout'}}));
    return;
  }
  res.writeHead(200, {'content-type': 'text/event-stream'});
  res.write(`data: ${JSON.stringify({type: 'response.created', response: {id: 'fixture'}})}\n\n`);
  if (mode === 'cancel') { res.on('close', () => upstreamClosed?.()); onHeaders?.(); return; }
  const timer = setTimeout(() => {
    outputSent = true;
    res.write(`data: ${JSON.stringify({type: 'response.output_text.delta', delta: 'LIVENESS_OK'})}\n\n`);
    if (mode === 'large-event') res.write(`data: ${JSON.stringify({type: 'response.output_text.done', text: 'x'.repeat(4 * 1024 * 1024)})}\n\n`);
    if (mode !== 'truncated') res.write(`data: ${JSON.stringify({type: 'response.completed', response: {status: 'completed', usage: {input_tokens: 4, output_tokens: 2}, ...(mode === 'large-terminal' ? {output: [{type: 'message', content: [{type: 'output_text', text: 'x'.repeat(4 * 1024 * 1024)}]}]} : {})}})}\n\n`);
    if (mode === 'complete-open') { res.on('close', () => upstreamClosed?.()); return; }
    res.end();
  }, 350);
  res.on('close', () => clearTimeout(timer));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({
  defaultProvider: 'codex', startupBanner: false,
  'codex-provider': {models: ['audit-model'], upstreamURL: `http://127.0.0.1:${upstream.address().port}/responses`, headersTimeoutMs: 1500, idleTimeoutMs: 1500},
}));
await fs.mkdir(path.join(dir, 'codex-provider'));
await fs.writeFile(path.join(dir, 'codex-provider/auth.json'), JSON.stringify({access: 'fake-access', refresh: 'fake-refresh', accountId: 'fake-account', expires: Date.now() + 3600000}));
await fs.writeFile(path.join(dir, 'fixture.txt'), 'TOOL_ROUND_OK');
let bridge;
try {
  const { AshBridge } = await import('../dist/bridges/ash.js');
  bridge = new AshBridge({cwd: dir, sessionId: 'aabbcc'});
  await bridge.ready();
  await bridge.execCommand('/model', 'audit-model@codex');
  await bridge.submit('Reply briefly');
  assert(headersBeforeOutput, 'loopback response headers must arrive before model text');
  assert.equal(requests, 1, 'reasoning must not trigger duplicate upstream requests');
  assert(JSON.stringify((await bridge.snapshot()).messages).includes('LIVENESS_OK'));
  console.log('PASS AshBridge receives early Codex headers and one complete answer');

  mode = 'retryable';
  const beforeRetry = requests;
  await bridge.submit('Retry the temporary upstream failure');
  assert.equal(requests - beforeRetry, 2, 'one failed upstream request followed by one successful retry');
  assert(JSON.stringify((await bridge.snapshot()).messages).includes('LIVENESS_OK'));
  console.log('PASS AshBridge recovers an upstream 504 through the early SSE response');

  mode = 'complete-open';
  const completedClosed = new Promise(resolve => { upstreamClosed = resolve; });
  await bridge.submit('Complete without closing the connection');
  await completedClosed;
  console.log('PASS AshBridge finishes completed replies without waiting for upstream EOF');

  mode = 'truncated'; outputSent = false;
  await assert.rejects(bridge.submit('Next'), /ended before completion/);
  console.log('PASS AshBridge reports truncated Codex responses as errors');

  const readDiagnostics = async () => (await fs.readFile(path.join(dir, 'logs', 'requests.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const scenario of ['large-event', 'large-terminal']) {
    mode = scenario;
    const before = requests, logStart = (await readDiagnostics()).length;
    await bridge.submit('Complete a large event fixture');
    assert.equal(requests - before, 1, 'diagnostic size limits must not interrupt or retry a successful reply');
    const entries = (await readDiagnostics()).slice(logStart);
    assert.equal(entries.at(-1).phase, scenario === 'large-event' ? 'complete' : 'unobserved');
    if (scenario === 'large-terminal') assert.equal(entries.at(-1).code, 'OBSERVATION_LIMIT');
    assert(!entries.some(e => ['error', 'cancelled'].includes(e.phase)));
    assert.equal((await bridge.snapshot()).messages.at(-1).content, 'LIVENESS_OK');
    console.log(`PASS ${scenario}: reply completes once without a false failure diagnostic`);
  }
  mode = 'retry-large-tool';
  const toolLogStart = (await readDiagnostics()).length;
  await bridge.submit('Read the fixture and finish');
  assert.equal(largeToolRequests, 3, 'one retry followed by one fresh model round');
  const toolEntries = (await readDiagnostics()).slice(toolLogStart);
  assert(toolEntries.some(e => e.phase === 'unobserved'));
  assert.deepEqual(toolEntries.filter(e => e.phase === 'request').map(e => e.attempt), [1, 2, 1]);
  assert.equal(toolEntries.at(-1).phase, 'complete');
  const toolResults = (await bridge.snapshot()).messages.filter(m => m.role === 'tool' && m.tool_call_id === 'large-tool-call');
  assert.equal(toolResults.length, 1); assert(JSON.stringify(toolResults[0]).includes('TOOL_ROUND_OK'));
  console.log('PASS limited diagnostics preserve retry numbers across actual tool/model rounds');
  for (const [scenario, expectedCode] of [['done-only', 'STREAM_ENDED'], ['bad-200', 'STREAM_ENDED'], ['headers-timeout', 'UPSTREAM_HEADERS_TIMEOUT'], ['idle-timeout', 'UPSTREAM_IDLE_TIMEOUT']]) {
    mode = scenario; diagnosticFailureSent = false;
    const before = requests, logStart = (await readDiagnostics()).length;
    if (scenario.endsWith('timeout')) {
      // Local deadlines deliberately exhaust the request: the installed
      // kernel must not start another long upload automatically.
      await assert.rejects(bridge.submit('Wait for the deadline'), /timed out/);
      assert.equal(requests - before, 1, 'spent deadlines must not be automatically retried');
      mode = 'delayed';
      await bridge.submit('Continue after the deadline');
    } else await bridge.submit('Retry the incomplete fixture response');
    assert.equal(requests - before, 2);
    const entries = (await readDiagnostics()).slice(logStart);
    const firstRequest = entries.find(e => e.phase === 'request').requestId;
    const firstOutcome = entries.filter(e => e.requestId === firstRequest).at(-1);
    assert.equal(firstOutcome.phase, 'error'); assert.equal(firstOutcome.code, expectedCode);
    assert.equal(entries.at(-1).phase, 'complete');
    assert(!entries.some(e => e.phase === 'cancelled'), 'a deadline is not user cancellation');
    console.log(`PASS ${scenario}: diagnostic agrees with the kernel; retry/continuation policy is unchanged`);
  }

  mode = 'cancel';
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const started = new Promise(resolve => { onHeaders = resolve; });
  const pending = bridge.submit('Wait');
  const outcome = pending.catch(() => {});
  await started;
  bridge.cancel();
  await outcome;
  await closed;
  console.log('PASS cancelling AshBridge releases the upstream Codex stream');
} finally {
  bridge?.close();
  upstream.closeAllConnections();
  await new Promise(resolve => upstream.close(resolve));
  globalThis.fetch = originalFetch;
  clearTimeout(watchdog);
  await fs.rm(dir, {recursive: true, force: true});
}
