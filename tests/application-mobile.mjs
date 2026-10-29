import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { RemoteConnector } from '../dist/remote/connector.js';
import { MobileAccessExtension } from '../dist/remote/extension.js';

process.env.NODE_ENV = 'test';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { disabled = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-app-mobile-'));
  const sockets = [], writes = [];
  let reads = 0;
  const identity = { deviceId: 'desktop', deviceToken: 'secret', username: 'alice', deviceName: 'Desktop', roots: [fs.realpathSync(dir)], ...(disabled ? { enabled: false } : {}) };
  let saved = JSON.stringify(identity);
  const nativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 1;
    bufferedAmount = 0;
    sent = [];
    closed = false;
    constructor(url) { this.url = String(url); sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.closed = true; }
  };
  const connector = new RemoteConnector({ dataDir: dir, gateway: 'http://127.0.0.1/mobile/', store: {
    read() { reads++; return saved; }, write(value) { writes.push(value); saved = value; },
  } });
  const mobile = new MobileAccessExtension(connector);
  t.after(async () => { connector.close(); await connector.drain(); globalThis.WebSocket = nativeWebSocket; fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, connector, mobile, sockets, writes, identity, reads: () => reads, saved: () => saved };
}
function activate(mobile) {
  const controller = new AbortController(), cleanups = [];
  const instance = mobile.definition.create({ signal: controller.signal, onDispose: fn => cleanups.push(fn) });
  return { instance, controller, cleanups };
}
function response() {
  const result = {};
  return { result, writeHead(status, headers) { result.status = status; result.headers = headers; }, end(data) { result.body = JSON.parse(data); } };
}
function request(url, body = {}, method = 'POST') {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { url, method, headers: { 'x-ashub-local': '1' } });
}

test('application lifecycle pauses and resumes the one injected connector without rereading credentials', async t => {
  const f = fixture(t);
  f.mobile.start(1234);
  assert.equal(f.reads(), 0); assert.equal(f.sockets.length, 0);
  const disabledStatus = response();
  await f.mobile.handle(request('/api/mobile', {}, 'GET'), disabledStatus);
  assert.equal(disabledStatus.result.status, 200);
  assert.equal(disabledStatus.result.body.featureEnabled, false);
  assert.equal(disabledStatus.result.body.enabled, false);
  const disabledPost = response();
  await f.mobile.handle(request('/api/mobile/connect'), disabledPost);
  assert.equal(disabledPost.result.status, 409);
  const first = activate(f.mobile);
  assert.equal(f.sockets.length, 1); assert.equal(f.reads(), 1);
  f.mobile.start(1234); f.connector.start(1234);
  assert.equal(f.sockets.length, 1); assert.equal(f.reads(), 1);
  await first.instance.stop(); await first.instance.stop();
  assert.equal(f.mobile.status().featureEnabled, false); assert.equal(f.sockets[0].closed, true);
  assert.deepEqual(JSON.parse(f.saved()), f.identity);
  const second = activate(f.mobile);
  assert.equal(f.mobile.status().featureEnabled, true); assert.equal(f.sockets.length, 2); assert.equal(f.reads(), 1);
  f.sockets[0].onopen(); assert.deepEqual(f.sockets[0].sent, []);
  f.sockets[1].onopen(); assert.equal(f.sockets[1].sent[0].token, f.identity.deviceToken);
  await second.instance.stop();
});

test('resuming the application respects a separately disabled device identity', async t => {
  const f = fixture(t, { disabled: true });
  f.mobile.start(1234);
  const first = activate(f.mobile);
  assert.equal(f.mobile.status().featureEnabled, true);
  assert.equal(f.mobile.status().enabled, false); assert.equal(f.sockets.length, 0);
  await first.instance.stop();
  const second = activate(f.mobile);
  assert.equal(f.sockets.length, 0);
  await assert.rejects(f.connector.execute('projects', {}), e => e.status === 403);
  await second.instance.stop();
});

test('duplicate start preserves pending durable effects and stop drains before resume', async t => {
  const f = fixture(t), effect = deferred(); let effects = 0;
  f.mobile.start(1234); const activation = activate(f.mobile);
  f.connector.local = async () => { effects++; return effect.promise; };
  const project = (await f.connector.execute('projects', {}))[0].id;
  const requestId = 'application-pending-0001';
  const receipt = await f.connector.execute('create', { project, requestId });
  assert.equal(receipt.state, 'pending'); assert.equal(f.connector.isBusy(), true); assert.equal(activation.instance.canStop(), false);
  f.connector.start(1234);
  assert.equal(receipt.state, 'pending'); assert.equal(f.sockets.length, 1); assert.equal(f.reads(), 1);
  let stopped = false; const stopping = activation.instance.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false); assert.equal(f.mobile.status().featureEnabled, false);
  assert.throws(() => f.connector.start(1234), e => e.status === 409);
  effect.resolve({ instanceId: 'abcdef' }); await stopping;
  assert.equal(receipt.state, 'done'); assert.equal(effects, 1); assert.equal(f.connector.isBusy(), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'remote-requests.json'), 'utf8'))['desktop:' + requestId].state, 'done');
  const next = activate(f.mobile);
  assert.equal((await f.connector.execute('request-status', { requestId })).state, 'done');
  await f.connector.execute('create', { project, requestId }); assert.equal(effects, 1);
  await next.instance.stop();
});

test('application stop revokes authorization still in progress and waits for it to finish', async t => {
  const f = fixture(t), lookup = deferred(); let effects = 0;
  f.mobile.start(1234); const activation = activate(f.mobile);
  f.connector.local = async route => route === '/sessions' ? lookup.promise : ++effects;
  const pending = f.connector.execute('permission', { session: 'abcdef', requestId: 'approval', outcome: 'approved' });
  const rejected = assert.rejects(pending, e => e.status === 403);
  assert.equal(activation.instance.canStop(), false);
  let stopped = false; const stopping = activation.instance.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  lookup.resolve([{ instanceId: 'abcdef', kind: 'agent', cwd: f.dir }]);
  await rejected; await stopping;
  assert.equal(effects, 0); assert.equal(f.connector.isBusy(), false);
});

test('close cancels an unfinished request body before it can enroll or replace credentials', async t => {
  const f = fixture(t); let enrollments = 0;
  t.mock.method(globalThis, 'fetch', async () => { enrollments++; throw Error('Unexpected enrollment'); });
  f.mobile.start(1234); const activation = activate(f.mobile);
  const req = Object.assign(new PassThrough(), { method: 'POST', url: '/api/mobile/connect', headers: { 'x-ashub-local': '1' } });
  const res = response(), pending = f.mobile.handle(req, res);
  req.write('{"username":"late'); await tick();
  assert.equal(activation.instance.canStop(), false);
  await activation.instance.stop(); await pending;
  assert.equal(res.result.status, 409); assert.equal(enrollments, 0); assert.equal(f.writes.length, 0);
  req.end('-body"}');
  const resumed = activate(f.mobile);
  assert.equal(f.mobile.status().username, 'alice');
  await resumed.instance.stop();
});

test('stop during enrollment prevents late binding and credentials persistence', async t => {
  const f = fixture(t), enrolled = deferred(), enrollmentStarted = deferred();
  t.mock.method(globalThis, 'fetch', async () => { enrollmentStarted.resolve(); return enrolled.promise; });
  f.mobile.start(1234); const activation = activate(f.mobile), res = response();
  const pending = f.mobile.handle(request('/api/mobile/connect', { username: 'bob', roots: [f.dir] }), res);
  await enrollmentStarted.promise;
  assert.equal(activation.instance.canStop(), false);
  const stopping = activation.instance.stop();
  enrolled.resolve(Response.json({ protocol: 1, deviceId: 'new-device', deviceToken: 'new-token', username: 'bob' }));
  await pending; await stopping;
  assert.equal(res.result.status, 409); assert.equal(f.writes.length, 0); assert.equal(f.sockets.length, 1);
  assert.equal(f.mobile.status().username, 'alice');
});

test('connection-level disconnect allows explicit rebind while the application remains enabled', async t => {
  const f = fixture(t); let enrollments = 0;
  t.mock.method(globalThis, 'fetch', async () => { enrollments++; return Response.json({ protocol: 1, deviceId: 'desktop', deviceToken: 'secret', username: 'alice' }); });
  f.mobile.start(1234); const activation = activate(f.mobile);
  const disconnected = response(); await f.mobile.handle(request('/api/mobile/disconnect'), disconnected);
  assert.equal(disconnected.result.status, 200); assert.equal(f.mobile.status().enabled, false); assert.equal(f.mobile.status().featureEnabled, true);
  const rebound = response(); await f.mobile.handle(request('/api/mobile/connect', { username: 'alice', roots: [f.dir] }), rebound);
  assert.equal(rebound.result.status, 200); assert.equal(enrollments, 1); assert.equal(f.mobile.status().enabled, true);
  assert.equal(f.sockets.length, 2); await activation.instance.stop();
});

test('aborting the activation closes admission synchronously and cleanup stays idempotent', async t => {
  const f = fixture(t); f.mobile.start(1234); const activation = activate(f.mobile);
  activation.controller.abort(); assert.equal(f.mobile.status().featureEnabled, false); assert.equal(f.sockets[0].closed, true);
  await Promise.all(activation.cleanups.map(fn => fn())); await activation.instance.stop();
  const denied = response(); await f.mobile.handle(request('/api/mobile/connect'), denied);
  assert.equal(denied.result.status, 409); assert.equal(f.sockets.length, 1);
});

test('abort retains cleanup failures for registry stop and disposal', async () => {
  let closes = 0;
  const mobile = new MobileAccessExtension({ start() {}, close() { closes++; }, isBusy: () => false,
    drain: async () => { throw new Error('receipt drain failed'); }, status: () => ({}) });
  mobile.start(1234); const activation = activate(mobile);
  activation.controller.abort();
  assert.equal(mobile.status().featureEnabled, false); assert.equal(closes, 1);
  await assert.rejects(activation.instance.stop(), /receipt drain failed/);
  await assert.rejects(activation.cleanups[0](), /receipt drain failed/);
  assert.equal(closes, 1);
});
