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
const watchdog = setTimeout(() => { console.error('Codex liveness integration timed out'); process.exit(1); }, 30000);
const originalFetch = globalThis.fetch;
let outputSent = false, mode = 'delayed', requests = 0, headersBeforeOutput = false, upstreamClosed, onHeaders, transientSent = false;
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
    if (mode !== 'truncated') res.write(`data: ${JSON.stringify({type: 'response.completed', response: {status: 'completed', usage: {input_tokens: 4, output_tokens: 2}}})}\n\n`);
    if (mode === 'complete-open') { res.on('close', () => upstreamClosed?.()); return; }
    res.end();
  }, 350);
  res.on('close', () => clearTimeout(timer));
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({
  defaultProvider: 'codex', startupBanner: false,
  'codex-provider': {models: ['audit-model'], upstreamURL: `http://127.0.0.1:${upstream.address().port}/responses`},
}));
await fs.mkdir(path.join(dir, 'codex-provider'));
await fs.writeFile(path.join(dir, 'codex-provider/auth.json'), JSON.stringify({access: 'fake-access', refresh: 'fake-refresh', accountId: 'fake-account', expires: Date.now() + 3600000}));
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
