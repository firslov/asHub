const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopFetch } = require('../electron/network.cjs');

test('desktop API calls use system transport without inheriting browser cookies', async () => {
  let received;
  const controller = new AbortController();
  const request = new Request('https://provider.invalid/v1/responses', {
    method: 'POST', headers: { Authorization: 'Bearer isolated-fixture' }, body: '{"stream":true}',
  });
  const fetch = createDesktopFetch(async (input, init) => {
    received = { input, init };
    return new Response('data: result\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }, () => { throw Error('unexpected direct transport'); }, {});
  const response = await fetch(request, { signal: controller.signal });
  assert.equal(received.input, request);
  assert.equal(received.init.signal, controller.signal);
  assert.equal(received.init.credentials, 'omit');
  assert.equal(received.input.headers.get('authorization'), 'Bearer isolated-fixture');
  assert.equal(await response.text(), 'data: result\n\n');
});

test('local Hub and Codex proxy bypass system transport', async () => {
  const seen = [];
  const fetch = createDesktopFetch(() => { throw Error('local request entered system proxy'); },
    (input, init) => { seen.push([input, init]); return Promise.resolve('local'); }, {});
  for (const url of ['http://127.0.0.1:56549/v1', 'http://127.0.0.2/', 'http://localhost:7878/', 'http://[::1]/', 'http://app.localhost/', 'data:text/plain,test']) {
    const init = { method: 'GET' };
    assert.equal(await fetch(url, init), 'local');
    assert.deepEqual(seen.at(-1), [url, init]);
  }
});

test('explicit environment proxy retains the existing Node dispatcher', () => {
  const nodeFetch = () => {};
  for (const env of [{ HTTPS_PROXY: 'http://proxy.invalid:80' }, { http_proxy: 'http://proxy.invalid:80' }]) {
    assert.equal(createDesktopFetch(() => {}, nodeFetch, env), nodeFetch);
  }
});

test('system transport failures are not retried directly or duplicated', async () => {
  let calls = 0;
  const failure = new TypeError('upstream unavailable');
  const fetch = createDesktopFetch(async () => { calls++; throw failure; },
    () => { throw Error('must not bypass system proxy'); }, {});
  await assert.rejects(fetch('https://provider.invalid/'), e => e === failure);
  assert.equal(calls, 1);
});
