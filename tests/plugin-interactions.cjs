const test = require('node:test');
const assert = require('node:assert/strict');
const { env, req, Res, path } = require('./harness.cjs');
function fixture() {
    const e = env(), { ExtensionMessages } = e.load('src/services/extension-messages.ts'), { PluginInteractions } = e.load('src/extensions/interactions.ts');
    const life = new AbortController(), plugin = new AbortController();
    let commits = 0;
    const messages = new ExtensionMessages(path.join(e.dir, 'store.json'), { target: () => ({ title: 'Target', binding: 'a' }), busy: () => true, dispatch: async () => { } });
    messages.bind('plugin', plugin.signal);
    const ui = new PluginInteractions(messages, () => { }, life.signal);
    const view = { rows: [], actions: [] };
    const resource = { view: () => view, prepare: () => ({ authorization: { targetId: 'target', label: 'Example', template: 'One approved task', minIntervalMs: 0, maxRuns: 1 }, execute() { commits++; return view; } }) };
    ui.bind('plugin', plugin.signal).register('main', resource);
    ui.bind('plugin', plugin.signal).register('other', resource);
    const call = async (body, id = 'main') => { const r = req(body, '/api/plugin-resources/plugin/' + id, 'POST'), s = new Res(); await ui.handle(r, s, async () => JSON.stringify(body)); return { status: s.statusCode, value: s.json() }; };
    return { e, ui, messages, life, plugin, call, commits: () => commits };
}
test('confirmation is scoped to a resource, expires, and plugin disposal invalidates pending approval', async () => {
    const f = fixture(), a = await f.call({ action: 'create', values: {} });
    assert(a.value.confirmation);
    assert.equal(f.commits(), 0);
    assert.equal((await f.call({ confirm: a.value.confirmation.id }, 'other')).status, 409);
    assert.equal(f.commits(), 0);
    f.e.clock(500001);
    assert.equal((await f.call({ confirm: a.value.confirmation.id })).status, 409);
    const b = await f.call({ action: 'create', values: {} });
    f.plugin.abort();
    assert.equal((await f.call({ confirm: b.value.confirmation.id })).status, 409);
    assert.equal(f.commits(), 0);
    f.messages.close();
});
test('a failed commit revokes its new authorization and repeating confirmation does not rerun it', async () => {
    const f = fixture();
    let grant, attempts = 0;
    f.ui.bind('plugin', f.plugin.signal).register('broken', { view: () => ({}), prepare: () => ({ authorization: { targetId: 'target', label: 'Example', template: 'Task', minIntervalMs: 0 }, execute(id) { grant = id; attempts++; throw Error('save failed'); } }) });
    const p = await f.call({ action: 'create', values: {} }, 'broken');
    const body = { confirm: p.value.confirmation.id };
    assert.equal((await f.call(body, 'broken')).status, 409);
    assert.equal((await f.call(body, 'broken')).status, 409);
    assert.equal(attempts, 1);
    const data = JSON.parse(require('node:fs').readFileSync(path.join(f.e.dir, 'store.json'), 'utf8'));
    assert.equal(data.grants[grant].revoked, true);
    f.messages.close();
});
