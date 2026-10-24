import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { once } from 'node:events';
import { test } from 'node:test';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createEnvironmentProxy } from '../dist/network.js';

async function listen(server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}

// Real HTTP CONNECT tunnel and Node fetch; no account or external network used.
test('environment proxy routes Node fetch while preserving loopback access', async () => {
  const origin = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, body }));
  });
  const port = await listen(origin);
  const connections = [];
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    connections.push(req.url);
    const upstream = net.connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
    }
  });
  const proxyPort = await listen(proxy);
  const dispatcher = createEnvironmentProxy({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}` });
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(dispatcher);
  try {
    const response = await fetch('http://ashub-proxy-test.invalid/oauth/token', {
      method: 'POST', body: 'grant_type=diagnostic', signal: AbortSignal.timeout(3000),
    });
    assert.deepEqual(await response.json(), { path: '/oauth/token', body: 'grant_type=diagnostic' });
    assert.deepEqual(connections, ['ashub-proxy-test.invalid:80']);
    for (const host of ['127.0.0.1', 'localhost']) {
      const local = await fetch(`http://${host}:${port}/local`, { signal: AbortSignal.timeout(3000) });
      assert.equal((await local.json()).path, '/local');
    }
    assert.equal(connections.length, 1, 'local session traffic must not enter the proxy');
  } finally {
    setGlobalDispatcher(previous);
    await dispatcher.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => origin.close(r))]);
  }
});

test('unset proxy leaves the default transport untouched', () => {
  assert.equal(createEnvironmentProxy({}), undefined);
  assert.equal(createEnvironmentProxy({ ALL_PROXY: 'socks5://127.0.0.1:1' }), undefined);
});

test('NO_PROXY wildcard and lowercase precedence are preserved', async (t) => {
  const host = Object.values(networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal)?.address;
  if (!host) return t.skip('No non-loopback IPv4 interface available');
  const origin = http.createServer((_req, res) => res.end('direct'));
  const port = await listen(origin, host);
  try {
    for (const env of [
      { NO_PROXY: '*' },
      { no_proxy: host, NO_PROXY: 'unrelated.invalid' },
    ]) {
      const dispatcher = createEnvironmentProxy({ HTTP_PROXY: 'http://127.0.0.1:1', ...env });
      try {
        const r = await fetch(`http://${host}:${port}`, { dispatcher, signal: AbortSignal.timeout(3000) });
        assert.equal(await r.text(), 'direct');
      } finally { await dispatcher.destroy(); }
    }
  } finally { await new Promise(r => origin.close(r)); }
});
