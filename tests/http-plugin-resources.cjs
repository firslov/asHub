const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { env, Bridge, fs, path, root } = require('./harness.cjs');
async function fixture() {
    const modules = {};
    const e = env({ modules, globals: { setTimeout, clearTimeout, setInterval, clearInterval, Date } });
    process.env.AGENT_SH_HOME = e.dir;
    modules['./extensions/installed.js'] = await import('../dist/extensions/installed.js');
    const target = path.join(e.dir, 'extensions', 'scheduled-tasks');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(root, 'examples/extensions/scheduled-tasks'), target, { recursive: true });
    const instances = [];
    let release;
    const hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: options => { const b = new Bridge(options); b.submit = q => { b.messages.push({ role: 'user', content: q }); return new Promise(r => release = r); }; instances.push(b); return b; } });
    if (!hub.server.listening)
        await once(hub.server, 'listening');
    const base = 'http://127.0.0.1:' + hub.server.address().port;
    const api = async (route, body) => { const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Origin: base, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, value: await res.json() }; };
    let feature;
    for (let i = 0; i < 100; i++) {
        feature = (await api('/api/extensions')).value.features.find(f => f.name === '定时任务');
        if (feature?.state === 'active')
            break;
        await new Promise(r => setTimeout(r, 20));
    }
    if (feature?.state !== 'active') {
        await hub.shutdown();
        assert.fail(JSON.stringify(feature));
    }
    const resource = '/api/plugin-resources/' + encodeURIComponent(feature.pluginId) + '/tasks';
    return { e, hub, api, feature, resource, instances, finish: () => { release?.({ stopReason: 'done' }); release = undefined; } };
}
test('real host plugin approval, durable delivery, deduplication, pause and menu lifecycle', { timeout: 15000 }, async () => {
    const f = await fixture();
    try {
        const id = (await f.api('/sessions', { cwd: f.e.dir, kind: 'agent' })).value.instanceId;
        assert(id);
        const listing = await f.api(f.resource);
        assert.equal(listing.status, 200);
        assert.equal(listing.value.view.rows.length, 0);
        const draft = { action: 'save', values: { title: 'Scheduled review', targetId: id, message: 'Synthetic task only', timezone: 'Asia/Shanghai', cadence: 'interval', intervalMinutes: 5, graceMinutes: 30, missed: 'skip' } };
        const review = await f.api(f.resource, draft);
        assert.equal(review.status, 200, JSON.stringify(review.value));
        assert(review.value.confirmation);
        assert.equal((await f.api(f.resource)).value.view.rows.length, 0, 'preview must not create a task');
        assert.equal(f.instances[0].messages.length, 0);
        const confirm = { confirm: review.value.confirmation.id };
        const [a, b] = await Promise.all([f.api(f.resource, confirm), f.api(f.resource, confirm)]);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(a.value.view.rows.length, 1);
        const row = a.value.view.rows[0], run = row.actions.find(a => a.id === 'run');
        const proposal = (await f.api(f.resource, { action: run.id, values: run.values })).value;
        assert(proposal.confirmation);
        await f.api(f.resource, { confirm: proposal.confirmation.id });
        for (let i = 0; i < 100 && !f.instances[0].messages.length; i++)
            await new Promise(r => setTimeout(r, 20));
        assert.equal(f.instances[0].messages.length, 1);
        assert.match(f.instances[0].messages[0].content, /Synthetic task only/);
        assert.match(f.instances[0].messages[0].content, /tool permissions are unchanged/);
        await f.api(f.resource, { confirm: proposal.confirmation.id });
        assert.equal(f.instances[0].messages.length, 1);
        const busy = await f.api(f.resource, { action: run.id, values: run.values });
        assert.equal(busy.status, 409);
        f.finish();
        await new Promise(r => setTimeout(r, 20));
        const history = row.actions.find(a => a.id === 'history');
        const logs = await f.api(f.resource, { action: history.id, values: history.values });
        assert.equal(logs.value.view.rows[0].status, '本轮已结束（请查看结果）');
        assert.equal(logs.value.view.rows[0].conversationId, id);
        assert.equal(logs.value.view.refresh, false);
        const pause = row.actions.find(a => a.id === 'pause');
        const p = (await f.api(f.resource, { action: pause.id, values: pause.values })).value;
        const paused = await f.api(f.resource, { confirm: p.confirmation.id });
        assert.equal(paused.status, 200);
        assert(paused.value.view.rows[0].actions.some(a => a.id === 'resume'));
        const pending = await f.api(f.resource, draft);
        await f.api('/api/extensions/' + f.feature.id + '/enabled', { enabled: false });
        assert.equal((await f.api(f.resource, { confirm: pending.value.confirmation.id })).status, 409, 'disabled plugin must invalidate outstanding approvals');
        await f.api('/api/extensions/' + f.feature.id + '/enabled', { enabled: true });
        assert.equal((await f.api(f.resource)).value.view.rows.length, 1, 'persistent tasks survive plugin restart');
    }
    finally {
        f.finish();
        await f.hub.shutdown();
    }
});
test('a corrupt optional message store does not block core startup or durable shutdown', async () => {
    const e = env();
    fs.mkdirSync(path.join(e.dir, 'hub-sessions'), { recursive: true });
    fs.writeFileSync(path.join(e.dir, 'hub-sessions', 'extension-messages.json'), 'corrupt');
    const hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: options => new Bridge(options) });
    if (!hub.server.listening)
        await once(hub.server, 'listening');
    try {
        assert.equal((await fetch('http://127.0.0.1:' + hub.server.address().port + '/sessions')).status, 200);
    }
    finally {
        await assert.rejects(hub.shutdown(), /cleanup failed/);
        assert.equal(hub.server.listening, false);
    }
});
