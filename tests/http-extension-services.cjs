const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { env, Bridge, path, root } = require('./harness.cjs');
const { zip } = require('./plugin-zip-fixture.cjs');

async function waitFor(read, message, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('committed UI-only ZIP installation activates its feature and invalidates SSE without catalog polling', { timeout: 8000 }, async () => {
  const e = env({ globals: { setTimeout, clearTimeout, setInterval, clearInterval } });
  const { startHub } = e.load('src/hub.ts');
  const app = startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: options => new Bridge(options) });
  const requests = [], events = [], streamController = new AbortController();
  let reader, pumping, streamError;
  app.server.on('request', request => requests.push(request.url));
  try {
    if (!app.server.listening) await once(app.server, 'listening');
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const headers = { Origin: base, 'x-ashub-local': '1' };
    await new Promise(resolve => setImmediate(resolve));
    const snapshotResponse = await fetch(base + '/api/host/snapshot', { headers });
    assert.equal(snapshotResponse.status, 200);
    const before = await snapshotResponse.json();
    const streaming = await fetch(base + '/api/host/events', { headers, signal: streamController.signal });
    assert.equal(streaming.status, 200); reader = streaming.body.getReader();
    pumping = (async () => {
      const decoder = new TextDecoder(); let buffer = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const event = packet.split('\n').find(line => line.startsWith('event: '))?.slice(7);
          const data = packet.split('\n').find(line => line.startsWith('data: '))?.slice(6);
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    })().catch(error => { if (!streamController.signal.aborted) streamError = error; });
    const ready = await waitFor(() => events.find(event => event.event === 'snapshot'), 'host SSE did not send its initial snapshot');
    assert.equal(ready.data.epoch, before.epoch);
    const featureName = 'HTTP install notification fixture';
    assert(!before.extensions.features.some(feature => feature.name === featureName));
    const manifest = { schemaVersion: 2, id: 'http-notification-fixture', name: featureName,
      ui: { version: 1, panels: [{ id: 'overview', title: 'Installed fixture', components: [{ type: 'text', text: 'Installed without reopening the plugin panel.' }] }] } };
    const archive = zip({
      'release/package.json': JSON.stringify({ name: manifest.id, version: '1.0.0', type: 'module' }),
      'release/ashub-plugin.json': JSON.stringify(manifest),
    });
    const previewResponse = await fetch(base + '/api/plugins/install?action=preview', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/zip' }, body: archive });
    assert.equal(previewResponse.status, 200); const preview = await previewResponse.json();
    assert.equal(preview.canInstall, true, JSON.stringify(preview.checks));
    const confirmResponse = await fetch(base + '/api/plugins/install?action=confirm', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: preview.token }) });
    assert.equal(confirmResponse.status, 200); const confirmed = await confirmResponse.json();
    // No installation panel or catalog client is mounted. A detached observer
    // polls only the committed job while the independent host stream stays open.
    let job = confirmed;
    const jobDeadline = Date.now() + 2000;
    while (job.state === 'running' && Date.now() < jobDeadline) {
      const status = await fetch(base + '/api/plugins/install?id=' + encodeURIComponent(confirmed.id), { headers });
      assert.equal(status.status, 200); job = await status.json();
      if (job.state === 'running') await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(job.state, 'succeeded', job.error); assert.equal(job.notificationError, undefined);
    // Check the push before any post-install snapshot: a snapshot GET itself
    // publishes fingerprints, so checking later would hide a missing callback.
    const invalidation = await waitFor(() => {
      if (streamError) throw streamError;
      return events.find(event => event.event === 'invalidation' && event.data.kind === 'extensions' && event.data.revision > before.revision);
    }, 'successful installation did not proactively publish an extension invalidation');
    const afterResponse = await fetch(base + '/api/host/snapshot', { headers });
    assert.equal(afterResponse.status, 200); const after = await afterResponse.json();
    assert.equal(after.epoch, before.epoch); assert(after.revision > before.revision);
    assert.equal(invalidation.data.epoch, after.epoch); assert(invalidation.data.revision <= after.revision);
    const feature = after.extensions.features.find(feature => feature.name === featureName);
    assert(feature, 'new UI feature must appear without GET /api/extensions or plugin catalog discovery');
    assert.match(feature.id, /^plugin-[a-f0-9]{24}$/); assert.equal(feature.enabled, true);
    assert.equal(feature.state, 'active'); assert.equal(feature.scope, 'frontend'); assert.deepEqual(feature.ui, manifest.ui);
    assert(!requests.some(route => /^\/api\/extensions(?:[/?]|$)/.test(route)));
    assert(!requests.some(route => route.split('?')[0] === '/api/plugins'));
  } finally {
    streamController.abort(); await reader?.cancel().catch(() => {}); await pumping;
    await app.shutdown();
  }
});
