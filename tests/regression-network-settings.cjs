const test = require('node:test');
const assert = require('node:assert/strict');
const { env } = require('./harness.cjs');
const { fs, path, root, vm } = require('./harness.cjs');
const { El } = require('./ui-harness.cjs');
const settle = () => new Promise(r => setImmediate(r));
const ok = policy => ({ ok: true, json: async () => structuredClone(policy) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('successful proxy save stays visible when the follow-up read fails', async () => {
  let policy = { proxyEnabled: true, sessions: {} }, reads = 0;
  const e = env({globals:{document:{addEventListener(){}},window:{addEventListener(){}},fetch:async (_url,init) => {
    if (init?.method === 'PUT') { policy = {...policy,proxyEnabled:JSON.parse(init.body).enabled}; return ok(policy); }
    if (++reads > 1) throw Error('connection interrupted after save');
    return ok(policy);
  }}});
  const ui = e.load('web/js/network-settings.js'); await settle();
  assert.equal(ui.networkPolicy.peek().proxyEnabled,true);
  await ui.saveNetworkPolicy(false); await settle();
  assert.equal(policy.proxyEnabled,false);
  assert.equal(ui.networkPolicy.peek().proxyEnabled,false,'a confirmed save must not revert to the old display');
});

test('overlapping global and session saves preserve both edits and ignore stale refreshes', async () => {
  let policy = { proxyEnabled: true, sessions: {} };
  const firstWrite = deferred(), staleRead = deferred(), puts = [];
  let reads = 0;
  const e = env({globals:{document:{addEventListener(){}},window:{addEventListener(){}},fetch:async (_url,init) => {
    if (init?.method !== 'PUT') {
      if (++reads === 2) return staleRead.promise;
      return ok(policy);
    }
    const body = JSON.parse(init.body); puts.push(body);
    if (puts.length === 1) await firstWrite.promise;
    if (body.session) policy = {...policy,sessions:{...policy.sessions,[body.session]:body.enabled}};
    else policy = {...policy,proxyEnabled:body.enabled};
    return ok(policy);
  }}});
  const ui = e.load('web/js/network-settings.js'); await settle();
  const globalSave = ui.saveNetworkPolicy(false);
  const sessionSave = ui.saveNetworkPolicy(true,'aabbcc');
  await settle(); assert.equal(puts.length,1,'a later save waits for the pending write');
  firstWrite.resolve(); await Promise.all([globalSave,sessionSave]); await settle();
  assert.equal(puts.length,2);
  staleRead.resolve(ok({proxyEnabled:true,sessions:{}})); await settle();
  assert.equal(ui.networkPolicy.peek().proxyEnabled,false);
  assert.equal(ui.networkPolicy.peek().sessions.aabbcc,true);
});

test('a failed save leaves the confirmed state intact and does not block the next save', async () => {
  let puts = 0;
  const e = env({globals:{document:{addEventListener(){}},window:{addEventListener(){}},fetch:async (_url,init) => {
    if (init?.method === 'PUT') {
      if (++puts === 1) return {ok:false,status:503};
      return ok({proxyEnabled:false,sessions:{}});
    }
    if (puts) throw Error('refresh unavailable');
    return ok({proxyEnabled:true,sessions:{}});
  }}});
  const ui = e.load('web/js/network-settings.js'); await settle();
  await assert.rejects(ui.saveNetworkPolicy(false),/HTTP 503/);
  assert.equal(ui.networkPolicy.peek().proxyEnabled,true);
  await ui.saveNetworkPolicy(false); await settle();
  assert.equal(ui.networkPolicy.peek().proxyEnabled,false);
});

for (const succeeds of [true, false]) test(`recreated sidebar proxy buttons recover after a ${succeeds ? 'successful' : 'failed'} pending save`, async () => {
  const pending = deferred(); let buttons = [], saves = 0;
  const e = env();
  const { signal, effect } = e.load('web/vendor/signals-core.js');
  const networkPolicy = signal({proxyEnabled:true,sessions:{}});
  Object.assign(e.context, {
    networkPolicy, effect, t: key => key, toast() {},
    document: {createElement: () => new El()},
    sessionList: {querySelectorAll: () => buttons},
    saveNetworkPolicy: async (enabled, id) => {
      saves++; await pending.promise;
      if (!succeeds) throw Error('save failed');
      networkPolicy.value = {proxyEnabled:true,sessions:{[id]:enabled}};
    },
  });
  // Exercise the production controls and their signal subscription. Replacing
  // a row represents filtering it out and back in while the request is pending.
  const source = fs.readFileSync(path.join(root,'web/js/sidebar.js'),'utf8');
  vm.runInContext(source.slice(source.indexOf('const networkSaving ='),source.indexOf('const renderSessionItem =')),e.context);
  const create = () => vm.runInContext('createNetworkButton("aabbcc")',e.context);
  const original = create(); buttons = [original];
  original.dispatchEvent({type:'click',preventDefault(){},stopPropagation(){}});
  assert.equal(original.disabled,true);
  const replacement = create(); buttons = [replacement];
  assert.equal(replacement.disabled,true);
  pending.resolve(); await settle();
  assert.equal(replacement.disabled,false,'the currently visible control must recover, not just its detached predecessor');
  assert.equal(replacement.dataset.enabled,String(!succeeds));
  replacement.dispatchEvent({type:'click',preventDefault(){},stopPropagation(){}}); await settle();
  assert.equal(saves,2,'the replacement remains usable after completion');
});
