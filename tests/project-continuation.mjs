import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Continuation } from '../examples/extensions/project-management/continuation.mjs';
import { ExtensionMessages } from '../dist/services/extension-messages.js';
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'continuation-'));let now=100000,busy=false;const sent=[];let control=new AbortController();
 const host={sessions:[{instanceId:'owner',kind:'agent',title:'Coordinator',isProcessing:false},{instanceId:'member',kind:'agent',title:'Member'}],projects:[{id:'p',name:'Project',sessionIds:['owner','member']}]};
 const tasks=[{id:'task',sourceId:'owner',recipientId:'member',state:'running',revision:1}];
 const messageFile=path.join(dir,'messages.json');const port={target:id=>id==='owner'?{title:'Coordinator',binding:'one',projectId:host.projects[0]?.id}:undefined,busy:()=>busy,dispatch:async(d,before,settled)=>{before();sent.push({d,settled});}};
 let messages=new ExtensionMessages(messageFile,port,()=>now),api=messages.bind('plugin',control.signal),hints=[];
 const services={dataDirectory:dir,messages:api,host:{snapshot:()=>structuredClone(host)},collaboration:{snapshot:()=>structuredClone(tasks),subscribe:()=>()=>{}},activities:{replace:v=>hints=v}};
 let app=new Continuation(services,{now:()=>now,delay:100});
 const plan={spec:{goal:'Test exact scope'},goal:'Test exact scope',steps:[{id:'build',member:'member',output:'file',criteria:'test',dependsOn:[],attempts:[{id:'attempt',taskId:'task'}]},{id:'check',member:'member',dependsOn:['build'],attempts:[]}]};
 const save=()=>app.db.prepare('INSERT INTO work VALUES(?,?,?,?) ON CONFLICT(project,owner,name) DO UPDATE SET data=excluded.data').run('p','owner','work',JSON.stringify(plan));save();
 const authorize=()=>{const row=app.view().rows[0],a=row.actions[0];const p=app.prepare(a.id,a.values);const id=messages.approve('plugin',messages.prepare('plugin',p.authorization));p.execute(id);return id;};
 const advance=(ms=31000)=>{now+=ms;app.tick();};
 t.after(()=>{app.stop();messages.close();control.abort();fs.rmSync(dir,{recursive:true,force:true});});
 const hostRestart=(checkpoint,{faulted=false}={})=>{
  app.stop();messages.prepareShutdown();control.abort();
  if(faulted)assert.throws(()=>messages.close(),/persistence/);
  else {messages.close();messages.finishShutdown();}
  if(checkpoint)fs.writeFileSync(messageFile,checkpoint.store);
  control=new AbortController();messages=new ExtensionMessages(messageFile,port,()=>now);api=messages.bind('plugin',control.signal);services.messages=api;
  app=new Continuation(services,{now:()=>now,delay:100});if(checkpoint)app.save(checkpoint.record);app.tick();
 };
 return {get app(){return app},host,tasks,plan,save,authorize,advance,get messages(){return messages},get api(){return api},services,messageFile,sent,hostRestart,get hints(){return hints},busy:v=>{busy=v;host.sessions[0].isProcessing=v},restart:()=>{app.stop();app=new Continuation(services,{now:()=>now,delay:100});app.tick();}};
}
test('existing workflows stay off; only user-confirmed grant enables continuation',t=>{
 const f=fixture(t);f.tasks[0].state='completed';f.advance();assert.equal(f.app.records().length,0);assert.equal(f.app.view().rows[0].status,'自动接续未开启');
 f.authorize();f.advance();assert.equal(f.app.records()[0].state,'queued');assert.equal(f.sent.length,0);
});
test('terminal completion wakes idle coordinator once and preserves pending receipt across plugin restart',async t=>{
 const f=fixture(t);f.authorize();f.advance();assert.equal(f.app.records()[0].state,'waiting');
 f.tasks[0].state='completed';f.tasks[0].revision=3;f.advance();f.advance();const key=f.app.records()[0].pending.key;
 f.restart();assert.equal(f.app.records()[0].pending.key,key);await f.messages.pump();await f.messages.pump();assert.equal(f.sent.length,1);assert.match(f.sent[0].d.message,/project_work_status/);
 f.app.tick();assert.equal(f.app.records()[0].state,'running');
});
test('active coordinator consumes deliveries without an extra wakeup when it reviews them',async t=>{
 const f=fixture(t);f.authorize();f.busy(true);f.tasks[0].state='completed';f.advance();f.advance();assert.equal(f.app.records()[0].pending,null);
 f.plan.steps.forEach(s=>s.attempts=[{id:'a',review:{decision:'accepted'}}]);f.save();f.busy(false);f.advance();await f.messages.pump();assert.equal(f.sent.length,0);assert.equal(f.app.records()[0].state,'completed');
});
test('coalesces multiple completions into one compact message',async t=>{
 const f=fixture(t);f.plan.steps[1].dependsOn=[];f.plan.steps[1].attempts=[{id:'b',taskId:'other'}];f.save();f.tasks.push({id:'other',sourceId:'owner',recipientId:'member',state:'running',revision:1});f.authorize();
 f.tasks.forEach(s=>{s.state='completed';s.revision++});f.advance();f.advance();await f.messages.pump();assert.equal(f.sent.length,1,JSON.stringify({records:f.app.records(),fault:f.app.fault}));assert.match(f.sent[0].d.message,/2 项待验收/);
});
for (const recovery of [false,true]) test(`a rejected submission pauses only its own workflow (${recovery?'recovery':'new'})`,async t=>{
 const f=fixture(t);f.tasks[0].state='completed';
 f.app.db.prepare('INSERT INTO work VALUES(?,?,?,?)').run('p','owner','other',JSON.stringify(f.plan));
 const ids=Object.fromEntries(f.app.view().rows.map(row=>[row.title,row.actions[0].values.id]));
 const grantFor=name=>{
  const plan=f.app.prepare('enable',{id:ids[name],epoch:''});
  const grant=f.messages.approve('plugin',f.messages.prepare('plugin',plan.authorization));
  plan.execute(grant);return grant;
 };
 const bad=grantFor('other'),healthy=grantFor('work');
 const submit=f.api.submit;
 // The real message service rejects only the malformed request before changing its grant or queue.
 f.services.messages={...f.api,submit:request=>request.grantId===bad
  ? (recovery?{state:'queued'}:submit({...request,values:{unexpected:'value'}}))
  : submit(request)};
 f.advance();
 if(recovery){
  assert(f.app.records().find(r=>r.id===ids.other).pending);
  f.services.messages={...f.api,submit:request=>request.grantId===bad
   ? submit({...request,values:{unexpected:'value'}}):submit(request)};
  f.advance();
 }
 await f.messages.pump();
 assert.equal(f.app.fault,null);
 assert.equal(f.app.records().find(r=>r.id===ids.other).state,'error');
 assert.equal(f.api.authorization(bad).revoked,true);
 assert.equal(f.api.authorization(healthy).revoked,false);
 assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].d.grantId,healthy);
});
test('an uncertain message service failure suspends every related grant', t=>{
 const f=fixture(t),first=f.authorize();
 f.app.db.prepare('INSERT INTO work VALUES(?,?,?,?)').run('p','owner','other',JSON.stringify(f.plan));
 const other=f.app.view().rows.find(row=>row.title==='other').actions[0];
 const p=f.app.prepare(other.id,other.values),second=f.messages.approve('plugin',f.messages.prepare('plugin',p.authorization));
 p.execute(second);
 f.services.messages={...f.api,submit:()=>{throw Error('unclassified storage error');}};
 f.tasks[0].state='completed';f.advance();f.advance();
 assert.match(f.app.fault,/storage error/);
 assert.equal(f.api.authorization(first).revoked,true);
 assert.equal(f.api.authorization(second).revoked,true);
});
test('a failed host storage commit cannot restart stale continuation grants',async t=>{
 const f=fixture(t);f.tasks[0].state='completed';const existing=f.authorize();f.advance();
 const key=f.app.records()[0].pending.key;
 assert.equal(f.api.lookup(key).state,'queued');
 f.app.db.prepare('INSERT INTO work VALUES(?,?,?,?)').run('p','owner','other',JSON.stringify(f.plan));
 const newGrant=f.authorize();
 const originalRename=fs.renameSync;
 fs.renameSync=(source,target)=>{
  if(target===f.messageFile)throw Object.assign(Error('injected host receipt I/O failure'),{code:'EIO'});
  return originalRename(source,target);
 };
 try{f.advance();}finally{fs.renameSync=originalRename;}
 assert.match(f.app.fault,/I\/O failure/);
 assert(f.app.records().every(r=>!r.enabled));
 await f.messages.pump();assert.equal(f.sent.length,0);
 f.hostRestart(undefined,{faulted:true});
 await f.messages.pump();
 assert.equal(f.api.lookup(key).state,'cancelled');
 assert.equal(f.api.authorization(existing).revoked,true);
 assert.equal(f.api.authorization(newGrant).revoked,true);
 assert.equal(f.sent.length,0);
});
test('a continuation ledger read failure durably revokes its queued authorization in the host',async t=>{
 const f=fixture(t);f.tasks[0].state='completed';const grant=f.authorize();f.advance();
 const pending=f.app.records()[0].pending;
 assert.equal(f.api.lookup(pending.key).state,'queued');
 f.app.records=()=>{throw Object.assign(Error('injected plugin ledger read failure'),{code:'SQLITE_IOERR'});};
 f.advance();
 assert.match(f.app.fault,/plugin ledger read failure/);
 assert.equal(f.api.authorization(grant).revoked,true);
 f.hostRestart();
 await f.messages.pump();
 assert.equal(f.app.records()[0].enabled,false);
 assert.equal(f.api.lookup(pending.key).state,'cancelled');
 assert.equal(f.sent.length,0);
});
test('a dual ledger outage does not restore old queued continuation after restart',async t=>{
 const f=fixture(t);f.tasks[0].state='completed';const grant=f.authorize();f.advance();
 const pending=f.app.records()[0].pending;
 const oldStore=fs.readFileSync(f.messageFile,'utf8');
 assert.equal(JSON.parse(oldStore).cleanShutdown,false);
 f.app.records=()=>{throw Object.assign(Error('plugin read failure'),{code:'SQLITE_IOERR'});};
 const rename=fs.renameSync;
 fs.renameSync=(source,target)=>{
  if(target===f.messageFile)throw Object.assign(Error('message write failure'),{code:'EIO'});
  return rename(source,target);
 };
 try{f.advance();}finally{fs.renameSync=rename;}
 assert.equal(fs.readFileSync(f.messageFile,'utf8'),oldStore);
 f.hostRestart(undefined,{faulted:true});
 await f.messages.pump();
 assert.equal(f.app.records()[0].enabled,false);
 assert.equal(f.api.authorization(grant).revoked,true);
 assert.equal(f.api.lookup(pending.key).state,'cancelled');
 assert.equal(f.sent.length,0);
});
test('restart at an in-progress submit checkpoint pauses instead of replaying an unknown commit',async t=>{
 const f=fixture(t);f.tasks[0].state='completed';const grant=f.authorize();
 const submit=f.api.submit;let checkpoint;
 f.services.messages={...f.api,submit:request=>{
  checkpoint={record:f.app.records()[0],store:fs.readFileSync(f.messageFile,'utf8')};
  return submit(request);
 }};
 f.advance();
 assert.equal(checkpoint.record.pending.submitting,true);
 checkpoint.store=JSON.stringify({...JSON.parse(checkpoint.store),cleanShutdown:true});
 f.hostRestart(checkpoint);
 await f.messages.pump();
 assert.equal(f.app.records()[0].state,'error');
 assert.equal(f.api.authorization(grant).revoked,true);
 assert.equal(f.sent.length,0);
});
test('unchanged workflow after successful model turn pauses rather than looping',async t=>{
 const f=fixture(t);f.authorize();f.tasks[0].state='completed';f.advance();f.advance();await f.messages.pump();f.sent[0].settled('completed');f.advance();assert.equal(f.app.records()[0].state,'stalled');f.advance();await f.messages.pump();assert.equal(f.sent.length,1);
});
test('accepted delivery releases successor; new real progress permits another wake',async t=>{
 const f=fixture(t);f.authorize();f.tasks[0].state='completed';f.advance();f.advance();await f.messages.pump();f.plan.steps[0].attempts[0].review={decision:'accepted'};f.save();f.sent[0].settled('completed');f.advance();f.advance();await f.messages.pump();assert.equal(f.sent.length,2);assert.match(f.sent[1].d.message,/1 项 ready/);
});
test('stop revokes continuation but not unrelated scheduled grants',async t=>{
 const f=fixture(t);f.authorize();const scheduled=f.messages.approve('plugin',f.messages.prepare('plugin',{targetId:'owner',label:'Calendar',template:'scheduled',minIntervalMs:0}));
 f.tasks[0].state='completed';f.advance();f.advance();f.messages.stopTarget('owner');f.advance();await f.messages.pump();assert.equal(f.sent.length,0);assert.equal(f.app.records()[0].state,'paused');assert.equal(f.api.authorization(scheduled).revoked,false);
});
test('scope changes and departed members revoke grants before admission',async t=>{
 for(const mode of ['member','scope','owner']){
 const f=fixture(t);f.authorize();f.tasks[0].state='completed';f.advance();f.advance();
 if(mode==='member')f.host.projects[0].sessionIds=['owner'];else if(mode==='owner')f.host.projects[0].sessionIds=['member'];else{f.plan.spec.goal='Expanded';f.save();}
 f.advance();await f.messages.pump();assert.equal(f.sent.length,0);assert.equal(f.app.records()[0].state,'blocked');}
});
test('partial delivery does not wake until task is terminal; failures wake for assessment, never auto-reexecute',async t=>{
 const f=fixture(t);f.authorize();f.tasks[0].deliverySubmitted=true;f.tasks[0].revision++;f.advance();assert.equal(f.app.records()[0].state,'waiting');
 f.tasks[0].state='failed';f.advance();f.advance();await f.messages.pump();assert.equal(f.sent.length,1);assert.match(f.sent[0].d.message,/failed/);f.sent[0].settled('failed');f.advance();assert.equal(f.app.records()[0].state,'error');
});
test('stale approval cannot widen scope and unfinished dispatch cannot be blindly resent',t=>{
 const f=fixture(t);const values=f.app.view().rows[0].actions[0].values;const preview=f.app.prepare('enable',values);f.plan.spec.goal='Changed';f.save();assert.throws(()=>preview.execute('grant'),/范围/);
 f.plan.steps[0].attempts=[{id:'uncertain'}];f.save();f.authorize();assert.equal(f.app.records()[0].state,'blocked');
});
test('queued obsolete notification is cancelled when coordinator progresses independently',async t=>{
 const f=fixture(t);f.authorize();f.tasks[0].state='completed';f.advance();f.advance();const key=f.app.records()[0].pending.key;
 f.plan.steps.forEach(s=>s.attempts=[{id:'a',review:{decision:'accepted'}}]);f.save();f.advance();await f.messages.pump();assert.equal(f.sent.length,0);assert.equal(f.api.lookup(key).state,'cancelled');f.advance();assert.equal(f.app.records()[0].state,'completed');
});

test('pause preserves an in-flight receipt; resume cannot overlap it or accept a stale approval',async t=>{
 const f=fixture(t);f.authorize();f.tasks[0].state='completed';f.advance();f.advance();await f.messages.pump();
 const row=f.app.view().rows[0];const stale=f.app.prepare('enable',row.actions[0].values);
 f.app.prepare('pause',row.actions[0].values).execute();
 assert.equal(f.app.records()[0].enabled,false);assert(f.app.records()[0].pending);
 assert.throws(()=>stale.execute('stale'),/变化/);
 assert.throws(()=>f.authorize(),/尚在运行/);
 f.sent[0].settled('completed');f.authorize();f.advance();await f.messages.pump();assert.equal(f.sent.length,2);
});

// Capture each durable plugin write together with the host receipt store. Each
// checkpoint is a possible process-loss boundary, not just a final-state assert.
test('restart at the first completion checkpoint cannot repeat a no-progress coordination turn',async t=>{
 const f=fixture(t);f.authorize();f.tasks[0].state='completed';f.advance();f.advance();await f.messages.pump();f.sent[0].settled('completed');
 const checkpoints=[],save=f.app.save.bind(f.app);f.app.save=r=>{save(r);checkpoints.push({record:structuredClone(r),store:fs.readFileSync(f.messageFile,'utf8')})};
 f.app.tick();assert(checkpoints.length);f.hostRestart(checkpoints[0]);f.advance();f.advance();await f.messages.pump();
 assert.equal(f.sent.length,1,'a finished no-progress turn must never be re-enqueued after a crash');assert.equal(f.app.records()[0].state,'stalled');
});
test('a pause checkpoint and legacy paused record cannot resurrect a queued notice after host restart',async t=>{
 for(const legacy of [false,true]){
 const f=fixture(t);f.authorize();f.tasks[0].state='completed';f.advance();f.advance();const previousStore=fs.readFileSync(f.messageFile,'utf8');
 const checkpoints=[],save=f.app.save.bind(f.app);f.app.save=r=>{save(r);checkpoints.push({record:structuredClone(r),store:fs.readFileSync(f.messageFile,'utf8')})};
 const a=f.app.view().rows[0].actions[0];checkpoints.length=0;f.app.prepare(a.id,a.values).execute();
 const checkpoint=checkpoints.find(c=>!c.record.enabled);assert(checkpoint);
 checkpoint.store=JSON.stringify({...JSON.parse(legacy?previousStore:checkpoint.store),cleanShutdown:true});
 f.hostRestart(checkpoint);await f.messages.pump();assert.equal(f.sent.length,0,'paused work cannot recover a queued delivery');assert.equal(f.app.records()[0].enabled,false);
 }
});
test('expired authorization in the pre-submission crash window pauses only its workflow',async t=>{
 const f=fixture(t);f.authorize();f.tasks[0].state='completed';f.advance();
 // Reserve the plugin intent but emulate process loss before the host submission.
 const submit=f.services.messages.submit;f.services.messages={...f.services.messages,submit:()=>({state:'queued'})};f.advance();f.services.messages={...f.services.messages,submit};
 const r=f.app.records()[0];assert(r.pending);assert.equal(f.api.lookup(r.pending.key),undefined);
 f.advance(8*86400000);assert.equal(f.app.fault,null,'normal expiry must not disable the whole plugin');assert.equal(f.app.records()[0].enabled,false);assert.equal(f.sent.length,0);
});
test('full host restart recovers only unstarted notices and never replays a running turn',async t=>{
 for(const running of [false,true]){
 const f=fixture(t);f.authorize();f.tasks[0].state='completed';f.advance();f.advance();const key=f.app.records()[0].pending.key;
 if(running)await f.messages.pump();f.hostRestart();await f.messages.pump();await f.messages.pump();
 assert.equal(f.sent.length,1);assert.equal(f.api.lookup(key).state,running?'interrupted':'running');if(running)assert.equal(f.app.records()[0].enabled,false);
 }
});

test('clean restart after cancelling an obsolete notice continues the new ready step without repeating the old notice',async t=>{
 const f=fixture(t);f.authorize();f.tasks[0].state='completed';f.advance();f.advance();const key=f.app.records()[0].pending.key;
 f.plan.steps[0].attempts[0].review={decision:'accepted'};f.save();
 let checkpoint;const cancel=f.api.cancel;
 f.services.messages={...f.api,cancel:k=>{cancel(k);checkpoint={record:structuredClone(f.app.records()[0]),store:fs.readFileSync(f.messageFile,'utf8')}}};
 f.app.tick();assert(checkpoint);assert.equal(f.api.lookup(key).state,'cancelled');
 checkpoint.store=JSON.stringify({...JSON.parse(checkpoint.store),cleanShutdown:true});
 f.hostRestart(checkpoint);f.advance();f.advance();await f.messages.pump();await f.messages.pump();
 assert.equal(f.sent.length,1,'internal supersession must not pause the workflow as an interrupted execution');
 assert.notEqual(f.sent[0].d.key,key);assert.match(f.sent[0].d.message,/1 项 ready/);assert.equal(f.api.lookup(key).state,'cancelled');
});

test('supersession recovery never overrides user stop or replays an uncertain running notice',async t=>{
 for(const mode of ['stop','running']){
 const f=fixture(t);f.authorize();f.tasks[0].state='completed';f.advance();f.advance();
 const r=f.app.records()[0];r.pending.superseded=true;f.app.save(r);
 if(mode==='stop'){f.api.cancel(r.pending.key);f.messages.stopTarget('owner');}else await f.messages.pump();
 f.hostRestart();f.advance();await f.messages.pump();
 assert.equal(f.sent.length,mode==='stop'?0:1);assert.equal(f.app.records()[0].enabled,false);
 assert.equal(f.app.records()[0].state,mode==='stop'?'paused':'error');
 }
});
