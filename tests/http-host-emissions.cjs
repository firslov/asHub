const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { env, Bridge, path } = require('./harness.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(read, message) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}
async function fixture() {
  const e = env(), bridges = [];
  const { startHub } = e.load('src/hub.ts');
  const app = startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(__dirname, '..', 'web'), makeBridge: options => {
    const bridge = new Bridge(options); bridge.writePty = () => {}; bridges.push(bridge); return bridge;
  } });
  if (!app.server.listening) await once(app.server, 'listening');
  await tick();
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const api = async (route, body, method) => {
    const response = await fetch(base + route, { method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Origin: base, 'Content-Type': 'application/json', 'x-ashub-local': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let value; try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, value };
  };
  let stream, connection;
  const events = [], frames = [];
  const subscribe = async () => {
    await new Promise((resolve, reject) => {
      let buffer = '';
      connection = http.get(base + '/api/host/events', response => {
        stream = response; response.setEncoding('utf8');
        response.on('data', chunk => {
          frames.push(chunk); buffer += chunk;
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const packet = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const event = packet.split('\n').find(line => line.startsWith('event: '))?.slice(7);
            const data = packet.split('\n').find(line => line.startsWith('data: '))?.slice(6);
            if (event && data) { events.push({ event, data: JSON.parse(data) }); if (event === 'snapshot') resolve(); }
          }
        });
      });
      connection.on('error', reject);
    });
  };
  return { e, bridges, app, api, base, events, frames, subscribe,
    async close() { stream?.destroy(); connection?.destroy(); await app.shutdown(); } };
}

test('shared network commit port publishes only after persistence and does not announce failed writes', () => {
  const e = env(), { HostEvents } = e.load('src/services/host-events.ts');
  const { SessionService } = e.load('src/services/session-service.ts');
  const { readNetworkPolicy } = e.load('src/network-policy.ts');
  const events = new HostEvents(), received = [];
  const service = new SessionService({ events, busy: () => false, thinking: () => 'default' });
  events.subscribe(event => received.push({ ...plain(event), policy: plain(readNetworkPolicy()) }));
  service.writeNetworkPolicy(false, 'abc123');
  assert.equal(received.length, 1); assert.equal(received[0].kind, 'network'); assert.equal(received[0].id, 'abc123');
  assert.equal(received[0].policy.sessions.abc123, false, 'observers see the committed policy');
  service.writeNetworkPolicy(null, 'abc123'); assert.equal(received[1].policy.sessions.abc123, undefined);
  service.writeNetworkPolicy(false); assert.equal(received[2].policy.proxyEnabled, false); assert.equal(received[2].id, undefined);
  const failing = new SessionService({ events, busy: () => false, thinking: () => 'default', writeNetworkPolicy() { throw Error('fixture persistence failure'); } });
  assert.throws(() => failing.writeNetworkPolicy(true, 'abc123'), /persistence failure/);
  assert.equal(received.length, 3); assert.equal(readNetworkPolicy().proxyEnabled, false);
});

test('approved source-bound conversation network updates emit network invalidation without bypassing approval or replaying receipts', { timeout: 8000 }, async () => {
  const f = await fixture();
  try {
    const source = await f.api('/sessions', { cwd: f.e.dir }), target = await f.api('/sessions', { cwd: f.e.dir });
    assert.equal(source.status, 200); assert.equal(target.status, 200);
    const id = target.value.instanceId, access = f.bridges[0].opts.hostAccess;
    await f.subscribe();
    const operation = { type: 'conversation.update', input: { id, proxyEnabled: false } };
    const denied = await access.execute({ idempotencyKey: 'network-event-denied', operations: [operation] }, async () => false);
    assert.equal(denied.status, 'denied'); await tick();
    assert(!f.events.some(event => event.data.kind === 'network'));
    assert.equal((await f.api('/api/settings/network')).value.sessions[id], undefined);
    let approvals = 0;
    const request = { idempotencyKey: 'network-event-committed', operations: [operation] };
    const committed = await access.execute(request, async () => { approvals++; return true; });
    assert.equal(committed.status, 'completed', committed.error);
    const networkEvent = await waitFor(() => f.events.find(event => event.event === 'invalidation' && event.data.kind === 'network' && event.data.id === id), 'approved proxy update did not publish a network invalidation');
    const snapshot = (await f.api('/api/host/snapshot')).value;
    assert(snapshot.revision >= networkEvent.data.revision); assert.equal(snapshot.epoch, networkEvent.data.epoch);
    assert.equal((await f.api('/api/settings/network')).value.sessions[id], false);
    assert(f.events.some(event => event.data.kind === 'sessions'));
    const beforeReplay = f.events.filter(event => event.data.kind === 'network').length;
    assert.equal((await access.execute(request, async () => { approvals++; return true; })).status, 'completed');
    await tick(); assert.equal(approvals, 1);
    assert.equal(f.events.filter(event => event.data.kind === 'network').length, beforeReplay, 'durable receipt replay does not rewrite or re-announce policy');
  } finally { await f.close(); }
});

test('legacy network settings route uses the same commit port without duplicate invalidations', { timeout: 8000 }, async () => {
  const f = await fixture();
  try {
    const created = await f.api('/sessions', { cwd: f.e.dir }); assert.equal(created.status, 200);
    await f.subscribe();
    const id = created.value.instanceId;
    const changed = await f.api('/api/settings/network', { enabled: false, session: id }, 'PUT');
    assert.equal(changed.status, 200); assert.equal(changed.value.sessions[id], false);
    await waitFor(() => f.events.find(event => event.data.kind === 'network'), 'legacy settings route did not invalidate network');
    await tick(); assert.equal(f.events.filter(event => event.data.kind === 'network').length, 1);
    assert.equal(f.events.find(event => event.data.kind === 'network').data.id, id);
    const invalid = await f.api('/api/settings/network', { enabled: 'invalid', session: id }, 'PUT');
    assert.equal(invalid.status, 400); await tick();
    assert.equal(f.events.filter(event => event.data.kind === 'network').length, 1);
  } finally { await f.close(); }
});

test('successful PTY input invalidates public session ordering while failed or invalid input does not', { timeout: 8000 }, async () => {
  const f = await fixture();
  try {
    const created = await f.api('/sessions', { cwd: f.e.dir, kind: 'terminal' }); assert.equal(created.status, 200);
    const id = created.value.instanceId, written = []; f.bridges[0].writePty = data => written.push(data);
    const before = (await f.api('/api/host/snapshot')).value; await f.subscribe();
    f.e.clock(200000);
    const sent = await f.api('/' + id + '/pty-input', { data: 'echo fixture\n' }); assert.equal(sent.status, 200);
    const invalidation = await waitFor(() => f.events.find(event => event.data.kind === 'sessions' && event.data.id === id), 'successful PTY input did not invalidate sessions');
    const after = (await f.api('/api/host/snapshot')).value;
    assert.deepEqual(written, ['echo fixture\n']);
    assert.equal(after.sessions.find(session => session.instanceId === id).lastModified, 200000);
    assert(after.revision > before.revision); assert(after.revision >= invalidation.data.revision);
    const revision = after.revision, count = f.events.filter(event => event.data.kind === 'sessions').length;
    f.e.clock(300000); f.bridges[0].writePty = () => { throw Error('fixture PTY failure'); };
    assert.equal((await f.api('/' + id + '/pty-input', { data: 'must fail' })).status, 500);
    assert.equal((await f.api('/' + id + '/pty-input', { data: 42 })).status, 400);
    await tick(); const unchanged = (await f.api('/api/host/snapshot')).value;
    assert.equal(unchanged.revision, revision); assert.equal(f.events.filter(event => event.data.kind === 'sessions').length, count);
    assert.equal(unchanged.sessions.find(session => session.instanceId === id).lastModified, 200000);
  } finally { await f.close(); }
});
