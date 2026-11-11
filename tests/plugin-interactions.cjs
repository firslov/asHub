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

test('remote resource confirmation binds to conversation, filters desktop controls and rechecks revocation',async()=>{
 const f=fixture();let sid='abc123',changed=0;
 f.ui.bind('plugin',f.plugin.signal).register('scoped',{remote:{conversationId:()=>sid,actions:['edit']},view:()=>({actions:[{id:'edit',label:'edit',values:{}},{id:'grant',label:'grant',values:{}}],rows:[]}),prepare:action=>({preview:{title:'Review',fields:[]},execute:()=>{changed++;return {actions:[],rows:[]};}})});
 const call=async(body,scope='abc123')=>{const r=req(body,'/api/plugin-resources/plugin/scoped'+(scope===null?'':'?remoteSession='+scope),body?'POST':'GET'),res=new Res();await f.ui.handle(r,res,async()=>JSON.stringify(body));return {status:res.statusCode,value:res.json()};};
 assert.equal((await call(null,'other')).status,409);
 const view=await call();assert.deepEqual(view.value.view.actions.map(a=>a.id),['edit']);
 assert.equal((await call({action:'grant',values:{}})).status,409);
 const desktop=await call({action:'edit',values:{}},null);assert.equal((await call({confirm:desktop.value.confirmation.id})).status,409);
 const remote=await call({action:'edit',values:{}});const confirm={confirm:remote.value.confirmation.id};await Promise.all([call(confirm),call(confirm)]);assert.equal(changed,1);
 sid='other';assert.equal((await call(confirm)).status,409);f.messages.close();
});


test('plugins cannot move mandatory authorization fields into collapsed diagnostics',async()=>{
 const f=fixture();
 f.ui.bind('plugin',f.plugin.signal).register('collapse',{view:()=>({}),prepare:()=>({preview:{title:'Review',fields:[],details:[{label:'Scope',value:'fake'}]},authorization:{targetId:'target',label:'Task',template:'Task',minIntervalMs:0,maxRuns:1},execute:()=>({rows:[],actions:[]})})});
 const result=await f.call({action:'create',values:{}},'collapse');assert.equal(result.status,200);
 assert.equal(result.value.confirmation.preview.details,undefined);assert(result.value.confirmation.preview.fields.length>0);assert.equal(f.commits(),0);f.messages.close();
});
