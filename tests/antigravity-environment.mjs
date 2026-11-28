import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

const credentials = ['AGY_ADC_AUTH', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS'];

const testOptions = {
  skip: process.platform === 'win32' ? 'The fake CLI uses a POSIX executable script' : false,
  timeout: 20000,
};

async function proxyFixture(t, beforeCleanup) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashub-agy-env-test-'));
  const report = path.join(dir, 'environment.jsonl');
  const agy = path.join(dir, 'agy');
  await fs.writeFile(agy, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const readline = require('node:readline');
const keys = ${JSON.stringify(credentials)};
fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify({
  args: process.argv.slice(2),
  inherited: keys.filter(key => Object.hasOwn(process.env, key)),
  marker: process.env.ASHUB_FIXTURE_MARKER,
  proxy: process.env.HTTPS_PROXY ?? null,
  lowercaseProxy: process.env.https_proxy ?? null,
}) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  const result = message.method === 'initialize'
    ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
    : { sessionId: 'fake-session' };
  console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
});
`, { mode: 0o755 });
  const oldEnv = process.env;
  process.env = { PATH: dir, AGENT_SH_HOME: dir, ASHUB_TOKEN: 'fixture', ASHUB_FIXTURE_MARKER: 'present', ...Object.fromEntries(credentials.map(key => [key, key === 'AGY_ADC_AUTH' ? 'true' : 'fixture'])) };
  t.after(async () => {
    try { await beforeCleanup?.(); }
    finally { process.env = oldEnv; await fs.rm(dir, { recursive: true, force: true }); }
  });
  const { createAntigravityBridge } = await import('../dist/builtin-plugins/google-antigravity/bridge.js');
  return {
    dir, createAntigravityBridge,
    reports: async () => (await fs.readFile(report, 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
  };
}

test('Antigravity resolves the current route per launch and preserves explicit HTTPS proxies and account login', testOptions, async t => {
  const { dir, createAntigravityBridge, reports } = await proxyFixture(t);
  let lookups = 0;
  let route = 'PROXY 127.0.0.1:7897';
  const resolveProxy = async () => { lookups++; return route; };
  const launch = async (resolve = resolveProxy) => {
    const bridge = createAntigravityBridge({ cwd: dir }, resolve);
    try { await bridge.ready(); } finally { bridge.close(); }
    return (await reports()).at(-1);
  };
  assert.deepEqual(await launch(), {
    args: ['acp'], inherited: [], marker: 'present', proxy: 'http://127.0.0.1:7897/', lowercaseProxy: null,
  });
  route = 'DIRECT';
  assert.equal((await launch()).proxy, null);
  assert.equal(lookups, 2);

  process.env.HTTPS_PROXY = 'http://127.0.0.1:7101';
  assert.equal((await launch()).proxy, process.env.HTTPS_PROXY);
  delete process.env.HTTPS_PROXY;
  process.env.https_proxy = 'http://127.0.0.1:7102';
  assert.equal((await launch()).lowercaseProxy, process.env.https_proxy);
  delete process.env.https_proxy;
  assert.equal(lookups, 2, 'explicit environment proxies do not need a system lookup');

  const late = Promise.withResolvers();
  assert.equal((await launch(() => late.promise)).proxy, null, 'lookup timeout must still start the CLI');
  late.reject(Error('late proxy lookup failure'));
});

test('Antigravity restores with the current proxy and a cancelled preparation never launches the CLI', testOptions, async t => {
  let hub;
  const { dir, createAntigravityBridge, reports } = await proxyFixture(t, () => hub?.shutdown());
  const { startHub } = await import('../dist/hub.js');
  let route = 'PROXY 127.0.0.1:7897';
  let pending;
  const start = async () => {
    hub = startHub({
      host: '127.0.0.1', port: 0, webRoot: path.resolve(import.meta.dirname, '../web'),
      makeBridge: () => { throw Error('Expected only Antigravity sessions'); },
      makeAntigravityBridge: opts => {
        const bridge = createAntigravityBridge(opts, () => {
          if (!pending) return Promise.resolve(route);
          pending.entered.resolve(bridge);
          return pending.release.promise;
        });
        return bridge;
      },
    });
    await once(hub.server, 'listening');
  };
  const request = (endpoint, body, method = body ? 'POST' : 'GET') => fetch(`http://127.0.0.1:${hub.server.address().port}${endpoint}`, {
    method, body: JSON.stringify(body), headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
  });
  const create = async () => {
    const result = await request('/sessions', { cwd: dir, kind: 'antigravity' });
    assert.equal(result.status, 200);
    return (await result.json()).instanceId;
  };
  const holdProxyLookup = () => pending = { entered: Promise.withResolvers(), release: Promise.withResolvers() };

  await start();
  const id = await create();
  const deleteId = await create();
  assert.equal((await reports()).at(-1).proxy, 'http://127.0.0.1:7897/');
  await hub.shutdown();
  route = 'DIRECT';
  await start();
  const restore = await request(`/${id}/context`);
  assert.equal(restore.status, 200);
  await restore.text();
  assert.equal((await reports()).at(-1).proxy, null, 'restoration must resolve the current proxy');
  const starts = (await reports()).length;

  const deleting = holdProxyLookup();
  const abandonedRestore = request(`/${deleteId}/context`);
  const restoring = await deleting.entered.promise;
  const restoreCancelled = assert.rejects(restoring.ready(), /ACP bridge closed/);
  assert.equal((await request(`/${deleteId}/`, undefined, 'DELETE')).status, 200);
  await restoreCancelled;
  deleting.release.resolve('PROXY 127.0.0.1:7101');
  await (await abandonedRestore).text();
  assert.equal((await request(`/${deleteId}/context`)).status, 404);

  const stopping = holdProxyLookup();
  const abandonedCreate = request('/sessions', { cwd: dir, kind: 'antigravity' }).then(response => response.status, () => 0);
  const creating = await stopping.entered.promise;
  const createCancelled = assert.rejects(creating.ready(), /ACP bridge closed/);
  await hub.shutdown();
  await createCancelled;
  stopping.release.resolve('PROXY 127.0.0.1:7101');
  assert.notEqual(await abandonedCreate, 200);
  assert.equal((await reports()).length, starts);
});
