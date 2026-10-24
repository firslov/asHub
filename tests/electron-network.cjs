// Real Chromium transport, isolated session and local proxy; no model credentials.
const { app, session, net } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createDesktopFetch } = require('../electron/network.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-desktop-network-'));
app.setPath('userData', dir);
const watchdog = setTimeout(() => { console.error('Desktop network test timed out'); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  const servers = [], sockets = new Set();
  const listen = async handler => {
    const server = http.createServer(handler); servers.push(server);
    server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return server.address().port;
  };
  try {
    let calls = 0;
    const proxyPort = await listen(async (req, res) => {
      calls++;
      assert.equal(req.headers.cookie, undefined);
      if (req.url.endsWith('/stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: first\n\n'); return;
      }
      let body = ''; for await (const c of req) body += c;
      res.end(JSON.stringify({ body, authorization: req.headers.authorization }));
    });
    const isolated = session.fromPartition('ashub-network-test');
    await isolated.setProxy({ proxyRules: `http://127.0.0.1:${proxyPort}`, proxyBypassRules: '<-loopback>' });
    await isolated.cookies.set({ url: 'http://ashub-network.invalid/', name: 'browser-cookie', value: 'must-not-leak' });
    const fetch = createDesktopFetch(isolated.fetch.bind(isolated), globalThis.fetch, {});
    const request = new Request('http://ashub-network.invalid/api', {
      method: 'POST', headers: { Authorization: 'Bearer isolated-fixture' }, body: 'payload',
    });
    assert.deepEqual(await (await fetch(request)).json(), { body: 'payload', authorization: 'Bearer isolated-fixture' });
    const controller = new AbortController();
    const response = await fetch('http://ashub-network.invalid/stream', { signal: controller.signal });
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: first/);
    controller.abort(); await assert.rejects(reader.read());
    const localPort = await listen((_req, res) => res.end('local'));
    assert.equal(await (await fetch(`http://127.0.0.1:${localPort}/`)).text(), 'local');
    assert.equal(calls, 2, 'loopback must bypass even a system proxy configured to intercept localhost');
    const { createPolicyFetch, withNetworkSession } = await import('../dist/network-policy.js');
    const scoped = createPolicyFetch((input, init) => isolated.fetch(input, { ...init, credentials: 'omit' }), globalThis.fetch,
      () => ({ proxyEnabled: true, sessions: { aaaa: false } }));
    const localUrl = `http://127.0.0.1:${localPort}/`;
    const [directResult, proxyResult] = await Promise.all([
      withNetworkSession('aaaa', () => scoped(localUrl).then(r => r.text())),
      withNetworkSession('bbbb', () => scoped(localUrl).then(r => r.json())),
    ]);
    assert.equal(directResult, 'local'); assert.deepEqual(proxyResult, { body: '' });
    assert.equal(calls, 3, 'only the enabled conversation should use Chromium proxy');
    console.log('PASS per-conversation proxy isolation with real Chromium and Node transports');
    console.log('PASS Chromium proxy routing, POST/auth, cookie isolation, streaming, cancellation and local bypass');
    if (process.env.ASHUB_NETWORK_PROBE === '1') {
      // Connectivity only: no Authorization header, body or model request.
      const real = createDesktopFetch(net.fetch.bind(net), globalThis.fetch, {});
      const r = await real('https://chatgpt.com/backend-api/codex/responses', { signal: AbortSignal.timeout(10000) });
      assert.equal(r.status, 405);
      await r.body?.cancel();
      console.log('PASS system proxy reaches Codex upstream (unauthenticated GET: 405)');
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
  }
}).then(() => finish(0), err => { console.error(err); finish(1); });
function finish(code) {
  clearTimeout(watchdog);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* OS may retain Chromium cache handles until exit. */ }
  app.exit(code);
}
