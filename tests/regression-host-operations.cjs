const test = require('node:test');
const assert = require('node:assert/strict');
const { env, fs, path } = require('./harness.cjs');
const plain = v => JSON.parse(JSON.stringify(v));
const request = (key='request-001', input={title:'Reader'}) => ({idempotencyKey:key,operations:[{type:'conversation.create',input}]});
function fixture() {
 const e=env(), {HostOperations,ExplicitApprovals}=e.load('src/host-operations.ts');
 const gateway=new HostOperations(path.join(e.dir,'receipts')); let calls=0,previews=0;
 const prepare=async op=>({preview:{title:op.type,fields:[{label:'Name',value:op.input.title}]},validate(){},async execute(){calls++;return{id:calls,title:op.input.title};}});
 return {e,gateway,HostOperations,ExplicitApprovals,prepare,get calls(){return calls;}};
}
test('denial and cancellation never execute operations',async()=>{
 const f=fixture();assert.equal((await f.gateway.run('a',request(),f.prepare,async()=>false)).status,'denied');assert.equal(f.calls,0);
 const controller=new AbortController();
 await assert.rejects(f.gateway.run('a',request('request-002'),f.prepare,async()=>{controller.abort();return true;},controller.signal),/abort/i);assert.equal(f.calls,0);
});
test('exact immutable preview, concurrent idempotency, durable results, parameter conflicts and source isolation',async()=>{
 const f=fixture();let resolve;const approval=new Promise(r=>resolve=r),raw=request();let preview;
 const first=f.gateway.run('a',raw,f.prepare,async p=>{preview=p;return approval;});
 const duplicate=f.gateway.run('a',request(),f.prepare,async()=>{throw Error('duplicate approval');});
 raw.operations[0].input.title='Modified after approval request'; await new Promise(r=>setImmediate(r));
 assert.equal(preview.items[0].fields[0].value,'Reader');resolve(true);
 assert.deepEqual(plain(await first),plain(await duplicate));assert.equal(f.calls,1);
 const restored=new f.HostOperations(path.join(f.e.dir,'receipts'));
 assert.equal((await restored.run('a',request(),f.prepare,async()=>{throw Error('must use receipt');})).status,'completed');assert.equal(f.calls,1);
 await assert.rejects(restored.run('a',request('request-001',{title:'Changed'}),f.prepare,async()=>true),/different parameters/);
 await restored.run('b',request(),f.prepare,async()=>true);assert.equal(f.calls,2);
});
test('revalidation failure before execution leaves every item untouched',async()=>{
 const f=fixture();let changed=false;
 const prepare=async op=>({...await f.prepare(op),validate(){if(changed)throw Error('project changed');}});
 await assert.rejects(f.gateway.run('a',request(),prepare,async()=>{changed=true;return true;}),/project changed/);assert.equal(f.calls,0);
});
test('partial failures are durable and interrupted receipts are never replayed',async()=>{
 const f=fixture();const raw=request();raw.operations.push({type:'conversation.create',input:{title:'Bad'}});
 const prepare=async op=>op.input.title==='Bad'?{preview:{title:'Bad',fields:[]},validate(){},async execute(){throw Error('failed setup');}}:f.prepare(op);
 const result=await f.gateway.run('a',raw,prepare,async()=>true);assert.equal(result.status,'failed');assert.equal(result.results.length,1);
 await f.gateway.run('a',raw,prepare,async()=>true);assert.equal(f.calls,1);
 const file=fs.readdirSync(path.join(f.e.dir,'receipts'))[0],p=path.join(f.e.dir,'receipts',file),saved=JSON.parse(fs.readFileSync(p));saved.status='running';fs.writeFileSync(p,JSON.stringify(saved));
 assert.equal((await new f.HostOperations(path.dirname(p)).run('a',raw,prepare,async()=>true)).status,'interrupted');assert.equal(f.calls,1);
});
test('explicit approvals settle only once and expire, abort or close without approving',async()=>{
 const f=fixture(), events=[],gate=new f.ExplicitApprovals((name,payload)=>events.push({name,...payload}));
 const pending=gate.request({title:'Confirm',items:[]}),p=events[0];assert(p.explicit);assert.equal(p.durationMs,300000);
 assert.equal(gate.decide('forged','approved'),false);assert.equal(gate.decide(p.requestId,'approved'),true);assert.equal(await pending,true);assert.equal(gate.decide(p.requestId,'approved'),false);
 const timed=gate.request({title:'Timeout',items:[]});[...f.e.timers.values()][0].fn();assert.equal(await timed,false);
 const c=new AbortController(),aborted=gate.request({title:'Abort',items:[]},c.signal);c.abort();assert.equal(await aborted,false);
 const closed=gate.request({title:'Close',items:[]});gate.cancel();assert.equal(await closed,false);
});
test('AshBridge auto-approve and session-wide decisions cannot approve future explicit operations',async()=>{
 const e=env(),{ExplicitApprovals}=e.load('src/host-operations.ts'),{AshBridge}=e.load('src/bridges/ash.ts');
 const events=[],gate=new ExplicitApprovals((name,payload)=>events.push({name,...payload}));
 const b=Object.create(AshBridge.prototype);Object.assign(b,{explicitApprovals:gate,pendingPermissions:new Map(),permissionSessionApproved:new Set()});
 const first=gate.request({title:'Confirm',items:[]});b.setAutoApprove(true);assert.equal(events.length,1);
 b.decidePermission(events[0].requestId,'approved',true);assert.equal(await first,true);assert.equal(b.permissionSessionApproved.size,0);
 const second=gate.request({title:'Again',items:[]});assert.equal(events.at(-1).name,'permission:request');gate.cancel();assert.equal(await second,false);
});
test('approval preview uses text nodes and remains identical on mobile',()=>{
 const {ui,El}=require('./ui-harness.cjs'),u=ui(),{appendApprovalPreview}=u.e.load('web/js/approval-preview.js'),parent=new El();
 appendApprovalPreview(parent,[{title:'<script>bad</script>',fields:[{label:'<img>',value:'<b>raw</b>'}]}]);
 const section=parent.children[0].children[0];assert.equal(section.children[0].textContent,'<script>bad</script>');assert.equal(section.children[1].children[1].textContent,'<b>raw</b>');
 const desktop=fs.readFileSync(path.join(require('./harness.cjs').root,'web/js/approval-preview.js'),'utf8');
 const mobile=path.join(require('./harness.cjs').root,'remote/public/approval-preview.js');
 if(fs.existsSync(mobile)) assert.equal(desktop.replace('export function','function'),fs.readFileSync(mobile,'utf8'));
});


test('late approval cannot win an expired deadline even before the timer callback runs',async()=>{
 const f=fixture(),events=[],gate=new f.ExplicitApprovals((name,payload)=>events.push({name,...payload}),100);
 const pending=gate.request({title:'Confirm',items:[]});f.e.clock(events[0].expiresAt);
 gate.decide(events[0].requestId,'approved');assert.equal(await pending,false);
});
test('conversation instructions survive backend serialization without plugin state',()=>{
 const e=env(),{AshBridge}=e.load('src/bridges/ash.ts'),bridge=Object.create(AshBridge.prototype);
 bridge.opts={instructions:'Review evidence carefully'};
 const saved=bridge.getRestoreState();assert.equal(saved.conversationInstructions,'Review evidence carefully');
 bridge.opts={restoreState:saved};assert.deepEqual(plain(bridge.getRestoreState()),plain(saved));
});

test('oversized multibyte plans and unsupported request shapes are rejected before approval',async()=>{
 const f=fixture();let approved=false;
 await assert.rejects(f.gateway.run('a',request('large-001',{title:'中'.repeat(40000)}),f.prepare,async()=>{approved=true;return true;}),/Invalid operation request/);
 assert.equal(approved,false);assert.equal(f.calls,0);
});

test('receipt write failures retain known results and block replay of uncertain operations',async()=>{
 let failWrites=false,calls=0;
 const e=env({modules:{'node:fs':{...fs,writeFileSync(...args){
  if(failWrites)throw new Error('fixture receipt write failed');
  return fs.writeFileSync(...args);
 }}}});
 const {HostOperations}=e.load('src/host-operations.ts'),directory=path.join(e.dir,'receipts');
 const gateway=new HostOperations(directory);
 const prepare=async()=>({preview:{title:'Create',fields:[]},validate(){},async execute(){
  calls++;failWrites=true;return {instanceId:'created-before-storage-failure'};
 }});
 const result=await gateway.run('source',request(),prepare,async()=>true);
 assert.equal(result.status,'failed');assert.match(result.error,/receipt write failed/);
 assert.equal(result.results[0].instanceId,'created-before-storage-failure');
 failWrites=false;
 const retry=await new HostOperations(directory).run('source',request(),prepare,async()=>{throw Error('must not approve again');});
 assert.equal(retry.status,'interrupted');assert.equal(calls,1);
});
