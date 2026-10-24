import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createPolicyFetch, withNetworkSession, registerNetworkEndpoint, readNetworkPolicy, writeNetworkPolicy } from '../dist/network-policy.js';
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici';

test('concurrent conversations keep separate routes across async work and global changes', async () => {
  const routes = [];
  let policy = { proxyEnabled: true, sessions: { aaaa: false, bbbb: true } };
  const proxied = async (_, init) => { routes.push(['proxy', init.body]); return new Response('proxy'); };
  const direct = async (_, init) => { assert(init.dispatcher); routes.push(['direct', init.body]); return new Response('direct'); };
  const send = createPolicyFetch(proxied, direct, () => policy);
  await Promise.all(['aaaa', 'bbbb', 'cccc'].map(id => withNetworkSession(id, async () => {
    await new Promise(r => setImmediate(r));
    await send('https://provider.invalid/v1', { method: 'POST', body: id });
  })));
  assert.deepEqual(routes, [['direct','aaaa'],['proxy','bbbb'],['proxy','cccc']]);
  policy.proxyEnabled = false;
  assert.equal(await (await send('https://provider.invalid')).text(), 'direct');
  await withNetworkSession('bbbb', () => send('https://provider.invalid', { body: 'override' }));
  assert.deepEqual(routes.at(-1), ['proxy','override']);
});
test('Codex conversion server uses exact registered session and URL; cleanup is idempotent', async () => {
  const url = 'https://provider.invalid/responses';
  const policy = { proxyEnabled: true, sessions: { aaaa: false } };
  const send = createPolicyFetch(async () => new Response('proxy'), async () => new Response('direct'), () => policy);
  const clean = registerNetworkEndpoint(url, 'aaaa');
  const request = new Request(url, { headers: { session_id: 'aaaa' } });
  assert.equal(await (await send(request)).text(), 'direct');
  assert.equal(await (await send('https://other.invalid/responses', { headers: request.headers })).text(), 'proxy');
  const other = registerNetworkEndpoint(url, 'aaaa'); clean(); clean();
  assert.equal(await (await send(request)).text(), 'direct');
  other(); assert.equal(await (await send(request)).text(), 'proxy');
});
test('preferences persist overrides, reset inheritance and preserve unrelated settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-policy-')), file = path.join(dir, 'settings.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ custom: { keep: true } }));
    writeNetworkPolicy(false, undefined, file); writeNetworkPolicy(true, 'aaaa', file);
    assert.deepEqual(readNetworkPolicy(file), { proxyEnabled: false, sessions: { aaaa: true } });
    writeNetworkPolicy(null, 'aaaa', file);
    assert.deepEqual(readNetworkPolicy(file), { proxyEnabled: false, sessions: {} });
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).custom, { keep: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('direct mode really bypasses a broken environment proxy without changing the global dispatcher', async () => {
  const server = http.createServer((_, res) => res.end('direct')); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const previous = getGlobalDispatcher();
  // Force even loopback through an unreachable proxy in the default transport.
  const { ProxyAgent } = await import('undici');
  const broken = new ProxyAgent('http://127.0.0.1:1'); setGlobalDispatcher(broken);
  try {
    const send = createPolicyFetch(() => { throw Error('proxy selected'); }, fetch, () => ({proxyEnabled:false,sessions:{}}));
    const response = await send(`http://127.0.0.1:${server.address().port}`, { signal: AbortSignal.timeout(3000) });
    assert.equal(await response.text(), 'direct'); assert.equal(getGlobalDispatcher(), broken);
  } finally { setGlobalDispatcher(previous); await broken.destroy(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
