const test = require('node:test');
const assert = require('node:assert/strict');
const { env, fs, path } = require('./harness.cjs');
function fixture() {
    const e = env();
    const { ExtensionMessages } = e.load('src/services/extension-messages.ts');
    let now = 1000, busy = false, binding = 'original';
    const sent = [];
    const port = { target: id => id === 'target' && binding ? { title: 'Target', binding } : undefined, busy: () => busy, async dispatch(d, before, settled) { before(); sent.push({ d, settled }); } };
    const file = path.join(e.dir, 'deliveries.json'), service = new ExtensionMessages(file, port, () => now), control = new AbortController(), api = service.bind('example', control.signal);
    const grant = (overrides = {}) => service.approve('example', service.prepare('example', { targetId: 'target', label: 'Task', template: 'Check {{date}}', variables: ['date'], minIntervalMs: 0, ...overrides }));
    const request = (grantId, key = 'run') => ({ grantId, key, values: { date: '2026-11-01' }, expiresAt: 5000 });
    return { service, api, control, port, sent, grant, request, file, ExtensionMessages, time: v => now = v, busy: v => busy = v, binding: v => binding = v };
}
test('approval scopes template, target, variables and idempotent receipt', async () => {
    const f = fixture(), g = f.grant({ maxRuns: 1 });
    assert.throws(() => f.api.submit(f.request('missing')), /authorization/);
    const r = f.api.submit(f.request(g));
    assert.equal(f.api.submit(f.request(g)).id, r.id);
    assert.throws(() => f.api.submit({ ...f.request(g), values: { date: 'changed' } }), /already bound/);
    assert.throws(() => f.api.submit(f.request(g, 'next')), /exhausted/);
    await f.service.pump();
    await f.service.pump();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].d.message, 'Check 2026-11-01');
    f.sent[0].settled('completed');
    assert.equal(f.api.status(r.id).state, 'completed');
    assert.equal(f.api.lookup('run').id, r.id);
    f.service.close();
});
test('busy admission waits, expiry prevents a late send, revoke cancels pending', async () => {
    const f = fixture(), g = f.grant();
    f.busy(true);
    const r = f.api.submit(f.request(g));
    await f.service.pump();
    assert.equal(f.sent.length, 0);
    f.time(5000);
    f.busy(false);
    await f.service.pump();
    assert.equal(f.api.status(r.id).state, 'expired');
    assert.equal(f.sent.length, 0);
    f.time(1000);
    const next = f.api.submit(f.request(g, 'next'));
    f.api.revoke(g);
    await f.service.pump();
    assert.equal(f.api.status(next.id).state, 'cancelled');
    assert.equal(f.sent.length, 0);
    f.service.close();
});
test('admission race is retried safely; pre-dispatch failures settle instead of retrying forever', async () => {
    const f = fixture(), g = f.grant();
    const r = f.api.submit(f.request(g));
    const dispatch = f.port.dispatch;
    f.port.dispatch = async (d, before) => { f.busy(true); before(); };
    await f.service.pump();
    assert.equal(f.api.status(r.id).state, 'queued');
    f.busy(false);
    f.port.dispatch = async () => { throw Error('bridge unavailable'); };
    await f.service.pump();
    assert.equal(f.api.status(r.id).state, 'failed');
    f.port.dispatch = dispatch;
    await f.service.pump();
    assert.equal(f.sent.length, 0);
    f.service.close();
});
test('expiry and target binding are rechecked inside the dispatch lock', async () => {
    for (const change of ['expiry', 'binding']) {
        const f = fixture(), g = f.grant(), r = f.api.submit(f.request(g));
        f.port.dispatch = async (d, before) => { change === 'expiry' ? f.time(6000) : f.binding('new'); before(); };
        await f.service.pump();
        await f.service.pump();
        assert.equal(f.sent.length, 0);
        assert.equal(f.api.status(r.id).state, change === 'expiry' ? 'expired' : 'cancelled');
        f.service.close();
    }
});
test('plugin stop cancels waiting work but preserves running receipt and denies stale service', async () => {
    const f = fixture(), g = f.grant(), r = f.api.submit(f.request(g));
    await f.service.pump();
    const waiting = f.api.submit(f.request(g, 'next'));
    f.control.abort();
    assert.throws(() => f.api.status(r.id));
    f.sent[0].settled('completed');
    const api = f.service.bind('example', new AbortController().signal);
    assert.equal(api.status(r.id).state, 'completed');
    assert.equal(api.status(waiting.id).state, 'cancelled');
    f.service.close();
});
test('restart preserves deduplication and never replays ambiguous unfinished work', async () => {
    const f = fixture(), g = f.grant(), input = f.request(g), r = f.api.submit(input);
    await f.service.pump();
    const recovered = new f.ExtensionMessages(f.file, f.port, () => 1001), api = recovered.bind('example', new AbortController().signal);
    assert.equal(api.submit(input).state, 'interrupted');
    await recovered.pump();
    assert.equal(f.sent.length, 1);
    assert.equal(api.status(r.id).state, 'interrupted');
    recovered.close();
});
test('double pumps dispatch once, unknown post-admission error is not replayed', async () => {
    const f = fixture(), g = f.grant(), r = f.api.submit(f.request(g));
    let release;
    f.port.dispatch = async (d, before) => { before(); await new Promise(resolve => release = resolve); throw Error('uncertain delivery'); };
    const a = f.service.pump();
    await f.service.pump();
    release();
    await a;
    assert.equal(f.api.status(r.id).state, 'interrupted');
    await f.service.pump();
    f.service.close();
});
test('foreign plugin and invalid substitution cannot use an authorization', () => {
    const f = fixture(), g = f.grant(), other = f.service.bind('other', new AbortController().signal);
    assert.throws(() => other.submit(f.request(g)), /authorization/);
    assert.throws(() => f.api.submit({ ...f.request(g), values: { date: 'a\nb' } }), /variables/);
    assert.throws(() => f.api.submit({ ...f.request(g), values: { extra: 'x' } }), /variables/);
    assert.throws(() => f.api.submit({ ...f.request(g), values: {} }), /Missing variable/);
    f.service.close();
});
test('a slow bridge startup does not block other targets or duplicate in-flight admission', async () => {
    const f = fixture();
    const original = f.port.target;
    f.port.target = id => id === 'second' ? { title: 'Second', binding: 'second' } : original(id);
    const g = f.grant(), g2 = f.grant({ targetId: 'second' }), first = f.api.submit(f.request(g));
    let release;
    f.port.dispatch = async (d, before, settled) => { if (d.targetId === 'target')
        await new Promise(r => release = r); before(); f.sent.push({ d, settled }); };
    const pending = f.service.pump();
    const second = f.api.submit(f.request(g2, 'second'));
    await f.service.pump();
    assert.equal(f.api.status(second.id).state, 'running');
    assert.equal(f.api.status(first.id).state, 'queued');
    assert.equal(f.sent.length, 1);
    release();
    await pending;
    assert.equal(f.sent.length, 2);
    f.service.close();
});
test('broken optional message storage fails closed without throwing from host construction', () => {
    const e = env(), { ExtensionMessages } = e.load('src/services/extension-messages.ts');
    const file = path.join(e.dir, 'broken.json');
    fs.writeFileSync(file, 'broken');
    const service = new ExtensionMessages(file, { target() { }, busy() { return false; }, async dispatch() { throw Error('must not dispatch'); } });
    const api = service.bind('a', new AbortController().signal);
    assert.throws(() => api.submit({}), /unavailable/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
    assert.throws(() => service.close(), /persistence/);
});
