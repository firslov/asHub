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
test('bound message service waits for application activation, including at final admission', async () => {
    const f = fixture(), g = f.grant({recoverQueued:true});
    const receipt = f.api.submit(f.request(g));
    let active = false;
    f.port.activePlugin = () => active;
    await f.service.pump();
    assert.equal(f.api.status(receipt.id).state,'queued');
    assert.equal(f.sent.length,0);
    active = true;
    const dispatch = f.port.dispatch;
    f.port.dispatch = async (_delivery, before) => { active = false; before(); };
    await f.service.pump();
    assert.equal(f.api.status(receipt.id).state,'queued');
    active = true;
    f.port.dispatch = dispatch;
    await f.service.pump();
    assert.equal(f.sent.length,1);
    f.service.close();
});
test('suspending an activation stops its queued messages but allows revoking them', async () => {
    const f = fixture(), g = f.grant(), receipt = f.api.submit(f.request(g));
    f.port.dispatch = async (_delivery, before) => { f.api.suspendAdmission(); before(); };
    await f.service.pump();
    assert.equal(f.api.status(receipt.id).state,'queued');
    await f.service.pump();
    assert.equal(f.sent.length,0);
    assert.throws(()=>f.api.submit(f.request(g,'more')),/admission suspended/);
    f.api.revoke(g);
    assert.equal(f.api.status(receipt.id).state,'cancelled');
    f.service.close();
});
test('suspending one plugin durably revokes only its recoverable grants', async () => {
    const f = fixture(), recoverable = f.grant({ recoverQueued: true }), ordinary = f.grant();
    const queued = f.api.submit(f.request(recoverable));
    const otherSignal = new AbortController(), other = f.service.bind('other', otherSignal.signal);
    const otherGrant = f.service.approve('other', f.service.prepare('other', {
        targetId:'target',label:'Task',template:'work',minIntervalMs:0,recoverQueued:true,
    }));
    const independent = other.submit({grantId:otherGrant,key:'other work',expiresAt:5000});
    f.api.suspendAdmission();
    assert(f.api.authorization(recoverable).revoked);
    assert(!f.api.authorization(ordinary).revoked);
    assert(!other.authorization(otherGrant).revoked);
    await f.service.pump();
    assert.equal(f.api.status(queued.id).state,'cancelled');
    assert.equal(other.status(independent.id).state,'running');
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

test('opt-in unstarted messages survive restart but running uncertain turns never replay', async () => {
 for(const running of [false,true]) {
  const f=fixture(),g=f.grant({recoverQueued:true,pauseOnStop:true});const r=f.api.submit(f.request(g));
  if(running)await f.service.pump();
  f.service.prepareShutdown();f.control.abort();f.service.close();f.service.finishShutdown();
  const next=new f.ExtensionMessages(f.file,f.port,()=>1000),control=new AbortController(),api=next.bind('example',control.signal);
  assert.equal(api.status(r.id).state,running?'interrupted':'queued');await next.pump();assert.equal(f.sent.length,1);next.close();control.abort();
 }
});
for (const legacy of [false,true]) test(`unverified shutdown needs a fresh continuation grant (${legacy?'legacy':'dirty'})`,async()=>{
 const f=fixture(),continuation=f.grant({recoverQueued:true,pauseOnStop:true}),ordinary=f.grant();
 const queued=f.api.submit(f.request(continuation));
 if(legacy){
  const state=JSON.parse(fs.readFileSync(f.file,'utf8'));delete state.cleanShutdown;
  fs.writeFileSync(f.file,JSON.stringify(state));
 }
 const next=new f.ExtensionMessages(f.file,f.port,()=>1000),api=next.bind('example',new AbortController().signal);
 await next.pump();
 assert(api.authorization(continuation).revoked);
 assert(!api.authorization(ordinary).revoked);
 assert.equal(api.status(queued.id).state,'cancelled');
 assert.equal(f.sent.length,0);
 const fresh=next.approve('example',next.prepare('example',{targetId:'target',label:'Continue',template:'Fresh confirmation',minIntervalMs:0,recoverQueued:true}));
 const resumed=api.submit({grantId:fresh,key:'fresh',expiresAt:5000});
 await next.pump();
 assert.equal(api.status(resumed.id).state,'running');
 assert.equal(f.sent.length,1);
 next.close();
});
test('explicit stop and plugin disable cancel queued continuation without revoking unrelated grants', async () => {
 const f=fixture(),g=f.grant({pauseOnStop:true,recoverQueued:true}),other=f.grant();const r=f.api.submit(f.request(g));
 f.service.stopTarget('target');assert.equal(f.api.authorization(g).revoked,true);assert.equal(f.api.authorization(other).revoked,false);
 await f.service.pump();assert.equal(f.sent.length,0);assert.equal(f.api.status(r.id).state,'cancelled');
 const enabled=f.grant({pauseOnStop:true,recoverQueued:true}),waiting=f.api.submit(f.request(enabled,'another'));f.control.abort();f.service.close();
 const next=new f.ExtensionMessages(f.file,f.port,()=>1000),api=next.bind('example',new AbortController().signal);assert.equal(api.status(waiting.id).state,'cancelled');next.close();
});
test('project scope is revalidated during delayed bridge admission', async () => {
 const f=fixture();let project='p';f.port.target=()=>({title:'T',binding:'original',projectId:project});
 const g=f.grant({projectId:'p'}),r=f.api.submit(f.request(g));f.port.dispatch=async(d,before)=>{project='other';before();};await f.service.pump();await f.service.pump();
 assert.equal(f.sent.length,0);assert.equal(f.api.status(r.id).state,'cancelled');f.service.close();
});

test('Stop invalidates older continuation confirmations, including before the first grant',()=>{
 const f=fixture(),input={targetId:'target',label:'Continue',template:'Continue scoped work',minIntervalMs:0,pauseOnStop:true};
 const prepared=f.service.prepare('example',input),scheduled=f.service.prepare('example',{...input,pauseOnStop:false});
 f.service.stopTarget('target');
 assert.throws(()=>f.service.approve('example',prepared),/stopped|changed|review/i);
 assert(f.service.approve('example',scheduled),'unrelated scheduled confirmation remains valid');
 assert(f.service.approve('example',f.service.prepare('example',input)),'fresh user confirmation after Stop can resume');f.service.close();
});

test('stopping a coordinator revokes every continuation grant in one durable commit',async()=>{
 const f=fixture(),a=f.grant({pauseOnStop:true,recoverQueued:true}),b=f.grant({pauseOnStop:true,recoverQueued:true});
 f.api.submit(f.request(a,'first-work'));f.api.submit(f.request(b,'second-work'));
 const checkpoints=[],save=f.service.save.bind(f.service);f.service.save=()=>{save();checkpoints.push(fs.readFileSync(f.file,'utf8'))};
 f.service.stopTarget('target');assert(checkpoints.length);
 // Restore the first durable stop checkpoint, as if the process exited there.
 fs.writeFileSync(f.file,checkpoints[0]);const recovered=new f.ExtensionMessages(f.file,f.port,()=>1000),api=recovered.bind('example',new AbortController().signal);
 await recovered.pump();assert.equal(f.sent.length,0,'all workflows sharing the stopped coordinator must stay stopped');
 assert(api.authorization(a).revoked&&api.authorization(b).revoked);recovered.close();f.service.close();
});

test('late bridge initialization after shutdown cannot overwrite a recoverable queued receipt',async()=>{
 for(const restartFirst of [false,true]){
 const f=fixture(),g=f.grant({pauseOnStop:true,recoverQueued:true}),request=f.request(g);
 const receipt=f.api.submit(request),dispatch=f.port.dispatch;let release;
 f.port.dispatch=async(d,before,settled)=>{await new Promise(r=>release=r);before();f.sent.push({d,settled});};
 const pumping=f.service.pump();assert(release);
 f.service.prepareShutdown();f.control.abort();f.service.close();f.service.finishShutdown();
 // The bridge finishes initialization only after the durable shutdown commit.
 if(!restartFirst){release();await pumping;assert.equal(f.sent.length,0);}
 f.port.dispatch=dispatch;
 const recovered=new f.ExtensionMessages(f.file,f.port,()=>1000),api=recovered.bind('example',new AbortController().signal);
 assert.equal(api.status(receipt.id).state,'queued','late aborted admission must not change the shutdown checkpoint');
 await recovered.pump();await recovered.pump();assert.equal(f.sent.length,1);assert.equal(f.sent[0].d.id,receipt.id);
 if(restartFirst){release();await pumping;assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).deliveries[receipt.id].state,'running','old callbacks cannot overwrite the new host receipt');}
 recovered.close();
 }
});

test('shutdown preparation blocks new admission, while ordinary Stop still cancels delayed admission',async()=>{
 for(const mode of ['shutdown','stop']){
 const f=fixture(),g=f.grant({pauseOnStop:true,recoverQueued:true}),r=f.api.submit(f.request(g));let release;
 f.port.dispatch=async(d,before,settled)=>{await new Promise(resolve=>release=resolve);before();f.sent.push({d,settled});};
 const running=f.service.pump();assert(release);
 if(mode==='shutdown')f.service.prepareShutdown();else f.service.stopTarget('target');
 release();await running;assert.equal(f.sent.length,0);await f.service.pump();
 if(mode==='stop')assert.equal(f.api.status(r.id).state,'cancelled');
 f.service.close();
 if(mode==='shutdown')f.service.finishShutdown();
 const recovered=new f.ExtensionMessages(f.file,f.port,()=>1000),api=recovered.bind('example',new AbortController().signal);
 assert.equal(api.status(r.id).state,mode==='shutdown'?'queued':'cancelled');recovered.close();
 }
});
