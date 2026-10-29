const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const moduleReady = import(pathToFileURL(path.resolve(__dirname, '../web/js/host-sync.js')).href);
const CAPS = { version: 1, hostApi: 1, queries: ['capabilities', 'snapshot'], events: { transport: 'sse', path: '/api/host/events' } };
const version = (revision = 0, epoch = 'first') => ({ version: 1, epoch, revision });
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture() {
  const { createHostSync } = await moduleReady;
  let next = 0, snapshot = version(), capabilities = CAPS;
  const timers = new Map(), sources = [], changes = [], requests = [], errors = [];
  const replies = [];
  class Source extends EventTarget {
    readyState = 0; closed = false;
    close() { this.closed = true; this.readyState = 2; }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    frame(name, value) { this.dispatchEvent(new MessageEvent(name, { data: typeof value === 'string' ? value : JSON.stringify(value) })); }
  }
  const sync = createHostSync({
    fetch: async (url, options) => {
      requests.push({ url, options });
      const result = url.endsWith('/capabilities') ? capabilities : replies.length ? await replies.shift() : snapshot;
      return typeof result === 'number' ? { ok: false, status: result } : { ok: true, status: 200, json: async () => result };
    },
    createEventSource: url => { assert.equal(url, '/api/host/events'); const source = new Source(); sources.push(source); return source; },
    onInvalidate: value => changes.push(value), onError: error => errors.push(error),
    setTimer: fn => { const id = ++next; timers.set(id, fn); return id; },
    clearTimer: id => timers.delete(id),
  });
  return { sync, sources, changes, requests, errors, timers, replies,
    snapshot(value) { snapshot = value; }, capabilities(value) { capabilities = value; },
    async tick() { const entry = timers.entries().next().value; if (entry) { timers.delete(entry[0]); entry[1](); } await settle(); },
    snapshotReads() { return requests.filter(r => r.url.endsWith('/snapshot')).length; },
  };
}

test('host connect discovers actual capabilities and coalesces open/ready into one snapshot', async () => {
  const f = await fixture(); await f.sync.start(); await f.sync.start();
  assert.equal(f.sources.length, 1);
  f.sources[0].open(); f.sources[0].frame('snapshot', version()); await f.tick();
  assert.equal(f.snapshotReads(), 1); assert.equal(f.changes.length, 1);
  assert.deepEqual(f.sync.state.applied, { epoch: 'first', revision: 0 });
  assert(f.changes[0].domains.includes('projects'));
  assert(f.requests.every(r => r.options.cache === 'no-store'));
  f.sync.stop();
});

test('actual invalidation frames refresh membership; bursts coalesce and duplicates are ignored', async () => {
  const f = await fixture(); await f.sync.start(); await f.tick();
  f.snapshot(version(2));
  f.sources[0].frame('invalidation', { ...version(1), kind: 'projects', id: 'project' });
  f.sources[0].frame('invalidation', { ...version(2), kind: 'sessions', id: 'chat' });
  await f.tick();
  assert.equal(f.snapshotReads(), 2); assert.equal(f.changes.length, 2);
  assert.deepEqual(f.changes[1].domains.sort(), ['projects', 'sessions']);
  f.sources[0].frame('invalidation', { ...version(1), kind: 'projects' });
  f.sources[0].frame('invalidation', { ...version(2), kind: 'projects' });
  assert.equal(f.timers.size, 0); f.sync.stop();
});

test('revision gaps, epoch changes and reconnects require a full fresh snapshot', async () => {
  const f = await fixture(); await f.sync.start(); await f.tick();
  f.snapshot(version(4)); f.sources[0].frame('invalidation', { ...version(4), kind: 'projects' }); await f.tick();
  assert.equal(f.changes.at(-1).reason, 'gap'); assert(f.changes.at(-1).domains.includes('sessions'));
  f.snapshot(version(0, 'second')); f.sources[0].frame('snapshot', version(0, 'second')); await f.tick();
  assert.equal(f.changes.at(-1).reason, 'epoch'); assert.equal(f.sync.state.applied.epoch, 'second');
  const before = f.snapshotReads(); f.sources[0].open(); f.sources[0].frame('snapshot', version(0, 'second')); await f.tick();
  assert.equal(f.snapshotReads(), before + 1); assert.equal(f.changes.at(-1).reason, 'connect'); f.sync.stop();
});

test('an in-flight snapshot older than an invalidation cannot publish stale state', async () => {
  const f = await fixture(); await f.sync.start(); await f.tick();
  const old = deferred(); f.replies.push(old.promise);
  f.sources[0].frame('invalidation', { ...version(1), kind: 'projects' }); await f.tick();
  f.sources[0].frame('invalidation', { ...version(2), kind: 'projects' });
  old.resolve(version(1)); await settle();
  assert.equal(f.changes.length, 1); assert.equal(f.timers.size, 1);
  f.snapshot(version(2)); await f.tick();
  assert.equal(f.changes.at(-1).revision, 2); assert.equal(f.snapshotReads(), 3); f.sync.stop();
});

test('stop closes the stream, aborts reads, and ignores old source and promise callbacks after restart', async () => {
  const f = await fixture(), old = deferred(); f.replies.push(old.promise);
  await f.sync.start(); await f.tick();
  const first = f.sources[0]; f.sync.stop();
  assert(first.closed); assert(f.requests.at(-1).options.signal.aborted); assert.equal(f.timers.size, 0);
  await f.sync.start(); f.snapshot(version(5, 'new')); await f.tick();
  old.resolve(version(0)); first.open(); first.frame('invalidation', version(99)); await settle();
  assert.equal(f.changes.length, 1); assert.deepEqual(f.sync.state.applied, { epoch: 'new', revision: 5 }); f.sync.stop();
});

test('only 404, 405 and 501 endpoints use legacy fallback', async () => {
  for (const status of [404, 405, 501]) {
    const f = await fixture(); f.capabilities(status); await f.sync.start();
    assert.equal(f.sync.state.legacy, true); assert.equal(f.sources.length, 0); assert.equal(f.timers.size, 0); f.sync.stop();
  }
  for (const status of [401, 403, 429, 500, 503]) {
    const f = await fixture(); f.capabilities(status); await f.sync.start();
    assert.equal(f.sync.state.legacy, false); assert.equal(f.errors.length, 1); assert.equal(f.timers.size, 1);
    f.capabilities(CAPS); await f.tick(); await f.tick(); assert.equal(f.changes.length, 1); f.sync.stop();
  }
});

test('snapshot failure is retried and future/malformed data does not claim old-host compatibility', async () => {
  const f = await fixture(); f.replies.push(500, { ...version(), version: 2 }, version());
  await f.sync.start(); await f.tick(); await f.tick(); await f.tick();
  assert.equal(f.errors.length, 2); assert.equal(f.changes.length, 1); assert.equal(f.sync.state.legacy, false);
  f.sources[0].frame('invalidation', 'not-json'); await f.tick();
  assert.equal(f.changes.length, 2); assert(f.changes.at(-1).domains.includes('projects')); f.sync.stop();
});

test('terminal EventSource errors rediscover once and page resume creates a new connection', async () => {
  const f = await fixture(); await f.sync.start(); await f.tick();
  f.sources[0].readyState = 2; f.sources[0].dispatchEvent(new Event('error')); await f.tick(); await f.tick();
  assert.equal(f.sources.length, 2); assert(f.sources[0].closed);
  f.sync.stop(); await f.sync.start(); await f.tick(); assert.equal(f.sources.length, 3); f.sync.stop();
});


test('a snapshot ahead of delivered events invalidates all domains before delayed frames are ignored', async () => {
  const f = await fixture(); await f.sync.start(); await f.tick();
  f.sources[0].frame('invalidation', { ...version(1), kind: 'projects' });
  // The HTTP snapshot sees a newer network change before its SSE frame arrives.
  f.snapshot(version(2)); await f.tick();
  assert.equal(f.sync.state.applied.revision, 2);
  assert.deepEqual(f.changes.at(-1).domains.sort(), ['configuration', 'extensions', 'network', 'projects', 'sessions']);
  f.sources[0].frame('invalidation', { ...version(2), kind: 'network' });
  assert.equal(f.timers.size, 0); assert.equal(f.changes.length, 2);
  assert(f.changes.at(-1).domains.includes('network')); f.sync.stop();
});

test('a terminal EventSource error before the initial snapshot timer forces fresh discovery', async () => {
  const f = await fixture(); await f.sync.start();
  assert.equal(f.timers.size, 1);
  // The pending connect-snapshot timer must not consume the reconnect retry.
  f.sources[0].readyState = 2; f.sources[0].dispatchEvent(new Event('error'));
  assert(f.sources[0].closed); assert.equal(f.timers.size, 1);
  await f.tick();
  assert.equal(f.sources.length, 2);
  assert.equal(f.requests.filter(r => r.url.endsWith('/capabilities')).length, 2);
  await f.tick(); assert.equal(f.changes.length, 1); assert.equal(f.sync.state.applied.revision, 0);
  f.sync.stop();
});
