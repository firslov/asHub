const test = require('node:test');
const assert = require('node:assert/strict');
const { env, Res, req, Bridge, path, fs } = require('./harness.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

function services() {
  const e = env();
  const { HostEvents } = e.load('src/services/host-events.ts');
  const { SessionService } = e.load('src/services/session-service.ts');
  const { ProjectService } = e.load('src/services/project-service.ts');
  const events = new HostEvents();
  const service = new SessionService({ events, busy: s => !!s.isProcessing, thinking: s => s.savedThinking ?? 'default' });
  const sessions = service.sessions;
  const projects = new ProjectService(path.join(e.dir, 'projects.json'), { sessions, events, deleteSession: async id => sessions.delete(id), expandHome: v => v });
  const session = { id: 'abc123', title: 'Reader', kind: 'agent', cwd: e.dir,
    bridge: new Bridge(), isProcessing: false, hasUnread: true, startedAt: 1, lastModified: 2, savedThinking: 'high' };
  return { e, events, service, sessions, projects, session };
}

test('core registry owns invalidation hooks; revisions are monotonic and application epochs isolated', () => {
  const f = services(), received = [];
  const initial = f.events.version();
  const off = f.events.subscribe(event => received.push(plain(event)));
  f.sessions.set(f.session.id, f.session);
  f.session.title = 'Changed'; f.session._onHostChange('metadata');
  f.sessions.delete(f.session.id);
  assert.equal(f.session._onHostChange, undefined, 'removed session cannot emit late invalidations');
  assert.deepEqual(received.map(e => e.revision), [1, 2, 3]);
  assert(received.every(e => e.epoch === initial.epoch && !('title' in e)));
  off(); f.events.publish('network'); assert.equal(received.length, 3);
  assert.notEqual(services().events.version().epoch, initial.epoch);
});

test('legacy session read model and plugin describe share persisted thinking and project membership', async () => {
  const f = services(); f.sessions.set(f.session.id, f.session);
  const result = await f.projects.change({ action: 'create', name: 'Review', cwd: f.e.dir, add: [f.session.id] });
  const project = result[0];
  const legacy = f.service.list(f.projects)[0];
  const described = f.service.describe(f.session, f.projects.list());
  assert.equal(legacy.projectId, project.id); assert.equal(described.projectId, project.id);
  assert.equal(legacy.thinkingLevel, 'high'); assert.equal(described.thinking, 'high');
  f.session.bridge.snapshot = async () => { throw Error('read model must not initialize a kernel'); };
  assert.equal(f.service.list(f.projects)[0].instanceId, f.session.id);
  f.session._hostOperation = true;
  await assert.rejects(f.projects.change({ action: 'members', id: project.id, remove: [f.session.id] }), /operation in progress/);
  assert.equal(f.projects.list()[0].sessionIds[0], f.session.id);
});

test('project commands publish after commit and retain membership on partial deletion failure', async () => {
  const f = services(); f.sessions.set(f.session.id, f.session);
  const project = (await f.projects.change({ action: 'create', name: 'Review', cwd: f.e.dir, add: [f.session.id] }))[0];
  const revision = f.events.version().revision;
  await assert.rejects(f.projects.change({ action: 'rename', id: project.id, name: '' }));
  assert.equal(f.events.version().revision, revision, 'failed writes never announce committed project changes');
  const { ProjectService } = f.e.load('src/services/project-service.ts');
  let release;
  const deleting = new Promise(resolve => release = resolve);
  const projects = new ProjectService(path.join(f.e.dir, 'projects.json'), { sessions: f.sessions, events: f.events, expandHome: v => v,
    deleteSession: async () => { await deleting; throw Error('fixture deletion failed'); } });
  const pending = projects.change({ action: 'delete', id: project.id, deleteConversations: true });
  assert.equal(projects.isDeleting(), true);
  await assert.rejects(projects.change({ action: 'rename', id: project.id, name: 'Racing rename' }), /deletion in progress/);
  release(); await assert.rejects(pending, /deletion failed/);
  assert.equal(projects.isDeleting(), false);
  assert.equal(projects.list()[0].sessionIds[0], f.session.id);
});

test('host SSE starts with current version, carries invalidations, and releases subscriptions on disconnect/backpressure/shutdown', () => {
  const f = services(), { handleHostQuery } = f.e.load('src/transport/host-http.ts');
  const signal = new AbortController();
  const runtime = { events: f.events, signal: signal.signal, snapshot: () => ({ version: 1, ...f.events.version() }) };
  const r = new Res();
  assert.equal(handleHostQuery(req({}, '/api/host/events', 'GET'), r, runtime), true);
  assert.match(r.body, /event: snapshot/);
  f.events.publish('projects'); assert.match(r.body, /event: invalidation/);
  const before = r.body; r.emit('close'); f.events.publish('network');
  assert.equal(r.body, before); assert.equal(f.e.timers.size, 0);
  const slow = new Res(); slow.write = chunk => { slow.body += chunk; return false; };
  handleHostQuery(req({}, '/api/host/events', 'GET'), slow, runtime);
  assert.equal(slow.writableEnded, true); assert.equal(f.e.timers.size, 0);
  const shutdown = new Res(); handleHostQuery(req({}, '/api/host/events', 'GET'), shutdown, runtime);
  signal.abort(); assert.equal(shutdown.writableEnded, true); assert.equal(f.e.timers.size, 0);
});

test('snapshot errors are evaluated before writing a success status and capabilities never expose execution bypass', () => {
  const f = services(), { handleHostQuery } = f.e.load('src/transport/host-http.ts');
  const runtime = { events: f.events, signal: new AbortController().signal, snapshot: () => { throw Error('invalid project data'); } };
  const r = new Res(); let committed = false;
  r.writeHead = () => { committed = true; return r; };
  assert.throws(() => handleHostQuery(req({}, '/api/host/snapshot', 'GET'), r, runtime), /invalid project data/);
  assert.equal(committed, false);
  const cap = new Res(); handleHostQuery(req({}, '/api/host/capabilities', 'GET'), cap, runtime);
  assert.equal(cap.json().approval, 'source-bound-explicit');
  const mutate = new Res(); handleHostQuery(req({}, '/api/host/snapshot', 'POST'), mutate, runtime);
  assert.equal(mutate.statusCode, 405);
});

test('project creation cannot move a source conversation while another approved configuration is in flight', async () => {
  const f = services(); f.sessions.set(f.session.id, f.session);
  f.session._hostOperation = true;
  const { createHostAccess } = f.e.load('src/services/host-service.ts');
  const { HostOperations } = f.e.load('src/host-operations.ts');
  const access = createHostAccess(f.session.id, { sessions: f.sessions, projects: f.projects,
    operations: new HostOperations(path.join(f.e.dir, 'receipts')), deleting: f.projects.isDeleting,
    busy: session => !!session.isProcessing, describe: f.service.describe,
    version: () => f.events.version(), expandHome: value => value,
  });
  let approved = false;
  await assert.rejects(access.execute({ idempotencyKey: 'locked-source-project', operations: [{
    type: 'project.create', input: { name: 'Racing membership', cwd: f.e.dir, members: [f.session.id] },
  }] }, async () => { approved = true; return true; }), /operation in progress/);
  assert.equal(approved, false); assert.deepEqual(plain(f.projects.list()), []);
});

test('transport cancellation rejects late parsers, removes completed-body listeners, and admits no pre-aborted reads', async () => {
  const e = env(), { readBodyWithSignal } = e.load('src/transport/body-reader.ts');
  const controller = new AbortController(), incoming = req(), complete = req();
  let release, accepted = 0, reads = 0;
  const pending = readBodyWithSignal(incoming, () => { reads++; return new Promise(resolve => { release = resolve; }); }, controller.signal);
  pending.then(() => { accepted++; }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, error => error.status === 503);
  release('late valid body'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(accepted, 0); assert.equal(incoming.destroyed, true); assert.equal(reads, 1);
  const finished = new AbortController();
  assert.equal(await readBodyWithSignal(complete, async () => 'accepted body', finished.signal), 'accepted body');
  finished.abort(); assert.equal(complete.destroyed, false, 'accepted work no longer belongs to the read cancellation phase');
  const cancelled = new AbortController(), never = req(); cancelled.abort();
  await assert.rejects(readBodyWithSignal(never, async () => { reads++; return 'must not read'; }, cancelled.signal));
  assert.equal(reads, 1); assert.equal(never.destroyed, true);
});

test('transport drops lifecycle listeners after client disconnect and preserves complete unaccepted sockets', async () => {
  const { getEventListeners } = require('node:events');
  const e = env(), { readBodyWithSignal } = e.load('src/transport/body-reader.ts');
  const life = new AbortController(), incoming = req();
  const pending = readBodyWithSignal(incoming, async () => new Promise(() => {}), life.signal);
  assert.equal(getEventListeners(life.signal, 'abort').length, 1);
  incoming.destroy(); await assert.rejects(pending);
  assert.equal(getEventListeners(life.signal, 'abort').length, 0);
  const complete = req(), second = new AbortController(); complete.complete = true;
  const waiting = readBodyWithSignal(complete, async () => new Promise(() => {}), second.signal);
  second.abort(); await assert.rejects(waiting);
  assert.equal(complete.destroyed, false);
  assert.equal(getEventListeners(second.signal, 'abort').length, 0);
  const early = req(), third = new AbortController(); let reads = 0;
  const earlyPending = readBodyWithSignal(early, async () => { reads++; return 'late'; }, third.signal);
  early.emit('aborted'); await assert.rejects(earlyPending);
  assert.equal(reads, 0); assert.equal(getEventListeners(third.signal, 'abort').length, 0);
});
