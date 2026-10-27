// Real Chromium HTTP/2 -> Codex proxy -> SDK -> AshBridge, using only local
// fixtures and fake credentials. The bundled TLS key is public test material.
const { app, session } = require('electron');
const http2 = require('node:http2');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { createDesktopFetch } = require('../electron/network.cjs');
const root = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-codex-http2-'));
app.setPath('userData', path.join(dir, 'browser'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP codex-fixture.invalid 127.0.0.1');
process.env.AGENT_SH_HOME = dir;
if (process.platform !== 'win32') {
  const shell = path.join(dir, 'clean-bash');
  fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', { mode: 0o755 });
  process.env.SHELL = shell;
}
for (const key of Object.keys(process.env)) {
  if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key) || key === 'OPENAI_BASE_URL') delete process.env[key];
}
const originalFetch = globalThis.fetch;
const connections = new Set();
const sockets = new Set();
let bridge, upstream, isolated, requests = 0, mode = '', modeAttempts = 0;
let closeSignal, retrySignal, capturedNetworkError, subagentCancel;
const watchdog = setTimeout(() => { console.error('Codex HTTP/2 test timed out'); app.exit(1); }, 45000);
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const reset = stream => stream.close(http2.constants.NGHTTP2_PROTOCOL_ERROR);
const complete = stream => stream.end(sse({ type: 'response.output_text.delta', delta: 'HTTP2_OK' })
  + sse({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } }));

app.whenReady().then(async () => {
  const tls = path.join(__dirname, 'fixtures', 'codex-http2');
  upstream = http2.createSecureServer({ key: fs.readFileSync(path.join(tls, 'key.pem')), cert: fs.readFileSync(path.join(tls, 'cert.pem')) });
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.on('session', connection => { connections.add(connection); connection.on('close', () => connections.delete(connection)); });
  upstream.on('stream', (stream, headers) => {
    stream.on('error', () => {}); // The deliberately reset stream emits ERR_HTTP2_STREAM_ERROR.
    stream.resume();
    stream.on('end', () => {
      requests++; modeAttempts++;
      assert.equal(headers.cookie, undefined);
      assert.equal(headers.authorization, 'Bearer fake-access');
      assert.equal(stream.session.alpnProtocol, 'h2');
      const thisMode = mode;
      stream.once('close', () => closeSignal?.());
      if (thisMode === 'persistent' || thisMode === 'cancel-retry' || thisMode === 'cancel-subagent' || (thisMode === 'headers-once' && modeAttempts === 1)) {
        reset(stream); return;
      }
      stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
      stream.write(sse({ type: 'response.created', response: { id: 'fixture' } }));
      if (thisMode === 'body-once' && modeAttempts === 1) {
        setTimeout(() => reset(stream), 30); return;
      }
      if (thisMode === 'partial-text' || thisMode === 'partial-tool') {
        stream.write(sse(thisMode === 'partial-text'
          ? { type: 'response.output_text.delta', delta: 'PARTIAL' }
          : { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'item', call_id: 'call', name: 'bash', arguments: '{"command":"echo fixture"}' } }));
        setTimeout(() => reset(stream), 30); return;
      }
      if (thisMode === 'cancel-active') { retrySignal?.(); return; }
      complete(stream);
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamURL = `https://codex-fixture.invalid:${upstream.address().port}/responses`;
  isolated = session.fromPartition('codex-http2-fixture');
  await isolated.setProxy({ mode: 'direct' });
  isolated.setCertificateVerifyProc((request, callback) => callback(request.hostname === 'codex-fixture.invalid' ? 0 : -2));
  const desktopFetch = createDesktopFetch(async (input, init) => {
    assert.equal(String(input), upstreamURL, 'test must never contact an external provider');
    try { return await isolated.fetch(input, init); }
    catch (error) { capturedNetworkError = error.message; throw error; }
  }, originalFetch, {});
  globalThis.fetch = desktopFetch;
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    defaultProvider: 'codex', startupBanner: false,
    'codex-provider': { models: ['http2-fixture'], upstreamURL },
  }));
  fs.mkdirSync(path.join(dir, 'codex-provider'));
  fs.writeFileSync(path.join(dir, 'codex-provider/auth.json'), JSON.stringify({
    access: 'fake-access', refresh: 'fake-refresh', accountId: 'fake-account', expires: Date.now() + 3600000,
  }));
  const { AshBridge } = await import(pathToFileURL(path.join(root, 'dist', 'bridges', 'ash.js')).href);
  bridge = new AshBridge({ cwd: dir, sessionId: 'aabbcc' });
  await bridge.ready(); await bridge.execCommand('/model', 'http2-fixture@codex');
  let text = '', tools = 0, retryAnnouncements = 0, requestStates = [];
  bridge.on('event', event => {
    if (event.name === 'agent:response-chunk') text += (event.payload?.blocks ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
    if (event.name === 'agent:tool-started') tools++;
    if (event.name === 'agent:request-status') requestStates.push(event.payload.phase);
    if ((event.name === 'ui:info' && /retrying/.test(event.payload?.message ?? ''))
        || (event.name === 'agent:request-status' && event.payload?.phase === 'retrying')) {
      retryAnnouncements++;
      if (mode === 'cancel-retry') bridge.cancel();
      if (mode === 'cancel-subagent') subagentCancel.abort();
    }
  });
  const begin = value => { mode = value; modeAttempts = 0; text = ''; tools = 0; retryAnnouncements = 0; requestStates = []; };
  for (const value of ['headers-once', 'body-once']) {
    begin(value);
    await bridge.submit('Reply briefly');
    assert.equal(modeAttempts, 2);
    assert.equal(retryAnnouncements, 1);
    assert.equal(requestStates[0], 'sending');
    assert(requestStates.includes('waiting'));
    assert.equal(requestStates.at(-1), 'clear');
    assert.equal(text.trimEnd(), 'HTTP2_OK');
    assert.equal(tools, 0);
    assert.match(capturedNetworkError, /ERR_HTTP2_PROTOCOL_ERROR/);
    console.log(`PASS real Chromium HTTP/2 reset during ${value}: one retry, one reply`);
  }
  for (const value of ['partial-text', 'partial-tool']) {
    begin(value);
    // Chromium may expose a reset after headers as EOF instead of a rejected
    // read. Both must remain errors, with no replay after partial output.
    await assert.rejects(bridge.submit('Reply briefly'), /ERR_HTTP2_PROTOCOL_ERROR|ended before completion/);
    assert.equal(modeAttempts, 1);
    assert.equal(retryAnnouncements, 0);
    assert.equal(tools, 0, 'an incomplete tool call must not execute');
    assert.equal(text.trimEnd(), value === 'partial-text' ? 'PARTIAL' : '');
    console.log(`PASS ${value}: no replay and no incomplete tool execution`);
  }
  begin('cancel-retry');
  await bridge.submit('Wait').catch(() => {});
  assert.equal(modeAttempts, 1);
  assert.equal(retryAnnouncements, 1);
  console.log('PASS cancelling the HTTP/2 retry prevents another upload');

  begin('cancel-active');
  const closed = new Promise(resolve => { closeSignal = resolve; });
  const active = new Promise(resolve => { retrySignal = resolve; });
  const pending = bridge.submit('Wait').catch(() => {});
  await active; bridge.cancel(); await pending; await closed;
  assert.equal(modeAttempts, 1);
  console.log('PASS cancellation releases the real HTTP/2 stream');
  closeSignal = null;

  begin('persistent');
  await assert.rejects(bridge.submit('Reply briefly'), /ERR_HTTP2_PROTOCOL_ERROR/);
  assert.equal(modeAttempts, 5, 'the default retry budget is four retries; the SDK must not multiply it');
  assert.equal(retryAnnouncements, 4);
  assert.equal(text, '');
  console.log('PASS persistent HTTP/2 errors stop after the configured retry budget');

  begin('healthy');
  await bridge.submit('Reply briefly');
  assert.equal(modeAttempts, 1);
  assert.equal(text.trimEnd(), 'HTTP2_OK');
  console.log('PASS the same conversation remains usable after cancellation and exhausted retries');

  begin('headers-once');
  const result = await bridge.core.handlers.call('subagent:run', { task: 'Reply briefly', tools: [], maxIterations: 1 });
  assert.match(String(result), /HTTP2_OK/);
  assert.equal(modeAttempts, 2);
  assert.equal(tools, 0);
  console.log('PASS subagent recovers a real Chromium HTTP/2 failure');

  begin('partial-text');
  await assert.rejects(bridge.core.handlers.call('subagent:run', { task: 'Reply briefly', tools: [], maxIterations: 1 }),
    /ERR_HTTP2_PROTOCOL_ERROR|ended before completion/);
  assert.equal(modeAttempts, 1, 'the subagent wrapper must honor the no-retry marker');
  console.log('PASS subagent preserves the partial-output no-retry boundary');

  begin('cancel-subagent');
  subagentCancel = new AbortController();
  await assert.rejects(bridge.core.handlers.call('subagent:run', {
    task: 'Reply briefly', tools: [], maxIterations: 1, signal: subagentCancel.signal,
  }), /abort/i);
  assert.equal(modeAttempts, 1);
  assert.equal(retryAnnouncements, 1);
  console.log('PASS cancelling a subagent retry prevents another upload');
  const diagnostics = fs.readFileSync(path.join(dir, 'logs', 'requests.jsonl'), 'utf8');
  assert(!diagnostics.includes('fake-access') && !diagnostics.includes('fake-account') && !diagnostics.includes('Reply briefly'));
  const entries = diagnostics.trim().split('\n').map(JSON.parse);
  assert(entries.some(e => e.phase === 'error' && e.code === 'ERR_HTTP2_PROTOCOL_ERROR'));
  assert(entries.some(e => e.phase === 'request' && e.attempt === 5));
  assert(entries.some(e => e.phase === 'cancelled'));
  console.log('PASS real transport diagnostics distinguish retries, failures and cancellation without content or credentials');
}).then(() => finish(0), error => { console.error(error); finish(1); });

async function finish(code) {
  bridge?.close();
  globalThis.fetch = originalFetch;
  for (const connection of connections) connection.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.race([Promise.all([
    upstream ? new Promise(resolve => upstream.close(resolve)) : Promise.resolve(),
    isolated?.closeAllConnections(),
  ]), new Promise(resolve => setTimeout(resolve, 1000))]);
  // Give node-pty's close callbacks time to drain before Electron tears down V8.
  await new Promise(resolve => setTimeout(resolve, 150));
  clearTimeout(watchdog);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); }
  catch { /* Windows can retain Chromium cache handles until app.exit(). */ }
  app.exit(code);
}
