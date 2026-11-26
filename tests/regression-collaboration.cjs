const test = require('node:test');
const assert = require('node:assert/strict');
const {env, Bridge, fs, path, req, Res} = require('./harness.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t) {
  const e = env();
  const {CollaborationTasks} = e.load('src/collaboration.ts');
  const tasks = new CollaborationTasks(path.join(e.dir, 'tasks'));
  const {ProjectStore} = e.load('src/projects.ts');
  const projects = new ProjectStore(path.join(e.dir,'projects.json'));
  const {createSession,conversationAccess,routeEvent,listSessions,closeSession,shutdownHub,submit,rebuildReplayFromKernel,tagLastQueryFrame,withContextLock} = e.load('src/hub.ts','export {createSession,conversationAccess,routeEvent,listSessions,closeSession,submit,rebuildReplayFromKernel,tagLastQueryFrame,withContextLock};');
  const sessions = new Map();
  t.after(async () => {
    // Replay and metadata writes can outlive a tool receipt. Drain the host
    // before deleting its directory, just as application shutdown does.
    await shutdownHub(undefined, sessions);
    fs.rmSync(e.dir, {recursive:true, force:true});
  });
  const opts = {collaboration:tasks, makeBridge:o=>new Bridge(o), conversationAccess:id=>conversationAccess(id,sessions,projects,tasks)};
  const a = await createSession(sessions,opts,e.dir), b = await createSession(sessions,opts,e.dir);
  const project = projects.update({action:'create',cwd:e.dir,name:'Team',add:[a.id,b.id]},()=>true)[0];
  return {e,tasks,projects,project,sessions,a,b,access:a.bridge.opts.conversationAccess,routeEvent,listSessions,closeSession,CollaborationTasks,submit,rebuildReplayFromKernel,tagLastQueryFrame,withContextLock};
}
function conversationQueries(session) {
  return session.replay.map(frame => JSON.parse(frame.match(/^data: (.+)$/m)[1]))
    .filter(frame => frame.meta.name === 'agent:query').map(frame => frame.payload);
}

test('trusted collaboration display preserves literal dispatch text and survives desktop and mobile replay', async t => {
  const f = await setup(t);
  const { mobileReplayFrame } = f.e.load('src/remote/replay.ts');
  f.a.title = '项目主控';
  const body = '  核对 R12/POOL。\n\n	例外：真空池。\n' + '长路径/'.repeat(550) + ' 🧪';
  const {taskId} = await f.access.send(f.b.id, body);
  await tick();
  const task = f.tasks.get(taskId);
  const [first] = conversationQueries(f.b);
  assert.equal(first.query, task.query);
  assert.equal(f.b.bridge.messages[0].content, task.query);
  const expected = {
    kind: 'task', taskId, sender: {id: f.a.id, title: '项目主控'}, body,
  };
  const {authorization, ...presentation} = first.collaboration;
  assert.deepEqual(plain(presentation), expected);
  assert.match(authorization, /不构成新的用户授权/);
  assert.equal(first.query, '[Cross-conversation message / 来自其他对话的消息]\n'
    + 'Task: ' + taskId + '\nFrom: ' + JSON.stringify(expected.sender)
    + '\n' + authorization + '\n\n' + body);
  const persisted = f.b.replay.find(frame => frame.includes('"agent:query"'));
  assert.equal(mobileReplayFrame(persisted), persisted, 'mobile replay must not truncate collaboration');

  // An ordinary submission can paste the exact same envelope, including its own
  // spoofed metadata field. Neither the text nor the extra request field is trusted.
  const response = new Res();
  await f.submit(req({query: task.query, collaboration: first.collaboration}), response, f.b);
  await tick();
  assert.equal(response.statusCode, 200);
  const queries = conversationQueries(f.b);
  assert.equal(queries.length, 2);
  assert.equal(queries[1].query, task.query);
  assert.equal(queries[1].collaboration, undefined);

  await f.withContextLock(f.b, async () => {
    await f.b.capture.flush();
    await f.tagLastQueryFrame(f.b);
    await f.rebuildReplayFromKernel(f.b);
  });
  const rebuilt = conversationQueries(f.b);
  assert.equal(rebuilt.length, 2);
  assert(rebuilt.every(query => query.entryId) && rebuilt[0].entryId !== rebuilt[1].entryId);
  assert.deepEqual(plain(rebuilt[0].collaboration), plain(first.collaboration));
  assert.equal(rebuilt[1].query, rebuilt[0].query);
  assert.equal(rebuilt[1].collaboration, undefined, 'branch reconstruction uses entry identity and not shared text');
});

test('queue consumption keeps provenance only for the original item and unedited query', async t => {
  const f = await setup(t);
  f.b.bridge.supportsQueue = true;
  f.b.bridge.isProcessing = () => true;
  f.b.bridge.submit = async () => ({stopReason: 'queued'});
  const [unchanged, edited] = await Promise.all([
    f.access.send(f.b.id, '复查 R12\n保留例外条件'),
    f.access.send(f.b.id, '复查 POOL\n保留返工条件'),
  ]);
  await tick();
  const [first, second] = [unchanged, edited].map(receipt => f.b.queuedItems.get(f.tasks.get(receipt.taskId).queueId));
  assert.equal(first.collaboration.taskId, unchanged.taskId);
  assert.equal(second.collaboration.taskId, edited.taskId);
  f.routeEvent(f.b, {name: 'agent:queued-submit', payload: {queueId: first.id, query: first.query}});
  f.routeEvent(f.b, {name: 'agent:queued-submit', payload: {queueId: second.id, query: first.query}});
  const [original, changed] = conversationQueries(f.b);
  assert.equal(original.collaboration.body, '复查 R12\n保留例外条件');
  assert.equal(changed.query, first.query);
  assert.equal(changed.collaboration, undefined, 'a modified queue item cannot borrow another message’s origin');
});

test('branch reconstruction keeps collaboration provenance with kernel query context', async t => {
  const f = await setup(t);
  let modelQuery;
  f.b.bridge.submit = async (query) => {
    modelQuery = query;
    f.b.bridge.messages.push({role:'user',content:'<query_context>\n<cwd>/fixture</cwd>\n</query_context>\n\n'+query});
    return {stopReason:'done'};
  };
  const body = 'Verify the table\n\n  Keep the original indent.\n';
  const {taskId} = await f.access.send(f.b.id, body);
  const original = modelQuery;
  await f.withContextLock(f.b, async () => {
    await f.b.capture.flush();
    await f.tagLastQueryFrame(f.b);
    assert(conversationQueries(f.b)[0]?.entryId);
    await f.rebuildReplayFromKernel(f.b);
  });
  const [restored] = conversationQueries(f.b);
  assert.equal(original, f.tasks.get(taskId).query);
  assert.equal(restored.query, original);
  assert.equal(restored.collaboration?.taskId, taskId);
  assert.equal(restored.collaboration?.body, body);

  const imitation = '<query_context>\nCopied wrapper\n</query_context>\n\n'+original;
  const response = new Res();
  await f.submit(req({query:imitation}),response,f.b);
  assert.equal(response.statusCode,200);
  await f.withContextLock(f.b, async () => {
    await f.b.capture.flush();
    await f.rebuildReplayFromKernel(f.b);
  });
  const [retained, copy] = conversationQueries(f.b);
  assert.deepEqual(plain(retained.collaboration),plain(restored.collaboration));
  assert.notEqual(copy.entryId, restored.entryId);
  assert.equal(copy.collaboration,undefined);
});

for (const wrapper of ['', '<query_context>\nFake wrapper\n</query_context>\n\n']) test(
  `reconstruction never assigns a failed dispatch origin to an identical captured ordinary message (${wrapper?'wrapped':'exact'})`, async t => {
  const f = await setup(t);
  const requestKey = 'display-proof-017', body = 'Same body on purpose';
  const {createHash} = require('node:crypto');
  const rawId = createHash('sha256').update(JSON.stringify([f.a.id, requestKey])).digest('hex').slice(0, 32);
  const id = rawId.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const {collaborationPresentation} = f.e.load('src/services/collaboration-presentation.ts');
  const presentation = collaborationPresentation('task', id, f.a, body);
  const raw = `[Cross-conversation message / 来自其他对话的消息]\nTask: ${id}\nFrom: ${JSON.stringify(presentation.sender)}\n${presentation.authorization}\n\n${body}`;

  // The ordinary turn was captured late because its first snapshot was unavailable.
  const snapshot = f.b.bridge.snapshot.bind(f.b.bridge);
  f.b.bridge.snapshot = async () => { throw Error('temporary snapshot failure'); };
  const response = new Res();
  await f.submit(req({query:wrapper+raw}), response, f.b);
  await tick();
  assert.equal(response.statusCode, 200);
  assert(!conversationQueries(f.b)[0].entryId);
  f.b.bridge.snapshot = snapshot;
  // The real dispatch emits its UI frame but the provider fails before recording an input.
  f.b.bridge.submit = async () => { throw Error('provider unavailable'); };
  const sent = await f.access.send(f.b.id, body, undefined, requestKey);
  assert.equal(sent.taskId, id);
  await tick();
  await f.withContextLock(f.b, async () => {
    await f.b.capture.flush();
    await f.tagLastQueryFrame(f.b);
    const original = conversationQueries(f.b);
    assert.equal(original.length, 2);
    assert.equal(original[0].query, wrapper+original[1].query);
    assert(original[1].collaboration);
    await f.rebuildReplayFromKernel(f.b);
  });
  const [restored] = conversationQueries(f.b);
  assert.equal(restored.query, wrapper+raw);
  assert.equal(restored.collaboration, undefined);
  });

test('receipts track exact turn, preserve long Unicode output, wait without polling, and survive restart',async t=>{
  const f=await setup(t);let done;
  f.b.bridge.submit=()=>new Promise(r=>done=r);
  const receipt=await f.access.send(f.b.id,'Review');
  assert.equal((await f.access.task(receipt.taskId)).state,'running');
  let finished=false;const wait=f.access.task(receipt.taskId,0,30000).then(v=>{finished=true;return v;});
  await tick();assert.equal(finished,false);
  const text='a'.repeat(7999)+'😀'+'z'.repeat(10000);
  f.routeEvent(f.b,{name:'agent:response-chunk',payload:{blocks:[{type:'text',text}]}});
  f.routeEvent(f.b,{name:'agent:tool-completed',payload:{isError:true}});
  assert.equal(f.tasks.get(receipt.taskId).state,'running','tool retry is not task failure');
  done({stopReason:'done'});await tick();
  const first=await wait;assert.equal(first.state,'completed');assert.equal(first.text.length,7999);
  let result='',offset=0,page;
  do {page=await f.access.task(receipt.taskId,offset);result+=page.text;offset=page.nextOffset;}while(page.hasMore);
  assert.equal(result,text);
  assert.throws(()=>f.tasks.page(receipt.taskId,8000),/offset/);
  assert.equal(new f.CollaborationTasks(path.join(f.e.dir,'tasks')).page(receipt.taskId).state,'completed');
});
test('keyed dispatch admits one exact attempt across simultaneous calls and restart', async t => {
  const f = await setup(t);
  let starts = 0, finish;
  f.b.bridge.submit = () => { starts++; return new Promise(resolve => { finish = resolve; }); };
  const key = 'attempt-12345678', message = 'Check this output';
  const send = () => f.access.send(f.b.id, message, undefined, key);
  const receipts = await Promise.all(Array.from({length:100}, send));
  const [first] = receipts;
  assert.equal(starts, 1);
  assert(receipts.every(r => r.taskId === first.taskId));
  assert.equal(receipts.filter(r => r.reused).length, 99);
  await assert.rejects(f.access.send(f.b.id, 'Another message', undefined, key), /different parameters/);
  assert.equal(f.tasks.get(first.taskId).state, 'running');
  assert.deepEqual(f.access.dispatchReceipt({ requestKey:key }), f.access.dispatchReceipt({ taskId:first.taskId }));
  assert.throws(() => f.b.bridge.opts.conversationAccess.dispatchReceipt({ taskId:first.taskId }), /outside this project or sender/);
  const persisted = new f.CollaborationTasks(path.join(f.e.dir,'tasks'));
  const { createConversationAccess } = f.e.load('src/services/conversation-service.ts');
  const reopened = createConversationAccess(f.a.id,{sessions:f.sessions,projects:f.projects,tasks:persisted,
    submitQuery:async()=>{throw Error('a recovered attempt must not be replayed');}});
  const recovered = await reopened.send(f.b.id,message,undefined,key);
  assert.equal(recovered.taskId,first.taskId);
  assert.equal(recovered.state,'interrupted');
  assert.equal(reopened.dispatchReceipt({requestKey:key}).state,'interrupted');
  finish({stopReason:'done'});await tick();
});
for (const queued of [false,true]) test(`collaboration preserves reply boundaries around tools (${queued?'queued':'direct'})`,async t=>{
  const f=await setup(t);let done;
  f.b.bridge.supportsQueue=true;
  f.b.bridge.isProcessing=()=>queued;
  f.b.bridge.submit=queued?async()=>({stopReason:'queued'}):()=>new Promise(r=>done=r);
  const receipt=await f.access.send(f.b.id,'Check formatting');
  if(queued)f.routeEvent(f.b,{name:'agent:queued-submit',payload:{query:f.tasks.get(receipt.taskId).query}});
  const chunk=text=>f.routeEvent(f.b,{name:'agent:response-chunk',payload:{blocks:[{type:'text',text}]}});
  chunk('```text\n');chunk('准备\n```');
  const first=await f.access.task(receipt.taskId);
  assert.equal(first.text,'```text\n准备\n```','stream chunks must remain contiguous');
  f.routeEvent(f.b,{name:'agent:tool-started',payload:{name:'read_file',toolCallId:'one'}});
  f.routeEvent(f.b,{name:'agent:tool-started',payload:{name:'read_file',toolCallId:'two'}});
  chunk('## 结果\n');chunk('\n完成');
  if(queued)f.routeEvent(f.b,{name:'agent:queued-done',payload:{}});
  else done({stopReason:'done'});
  await tick();
  const result=await f.access.task(receipt.taskId);
  assert.equal(result.text,'```text\n准备\n```\n\n## 结果\n\n完成','separate replies must not merge into one malformed Markdown block');
  assert.equal(result.state,'completed');
  assert.equal((await f.access.task(receipt.taskId,first.nextOffset)).text,'\n\n## 结果\n\n完成','live pagination offsets remain valid');
  assert.equal(new f.CollaborationTasks(path.join(f.e.dir,'tasks')).get(receipt.taskId).text,result.text);
});
test('queued task output belongs to its own turn; dropped tasks cannot finish the active task',async t=>{
  const f=await setup(t);let done;
  f.b.bridge.submit=()=>new Promise(r=>done=r);
  const first=await f.access.send(f.b.id,'first');
  f.b.bridge.supportsQueue=true;f.b.bridge.isProcessing=()=>true;f.b.bridge.submit=async()=>({stopReason:'queued'});
  const second=await f.access.send(f.b.id,'second'), dropped=await f.access.send(f.b.id,'third');await tick();
  assert.equal(f.b.queuedQueries.length,2);
  f.routeEvent(f.b,{name:'agent:queued-done',payload:{query:f.tasks.get(dropped.taskId).query,dropped:true}});
  assert.equal(f.b.isProcessing,true,'dropping a queued task must not end the running turn');
  assert.equal(f.tasks.get(dropped.taskId).state,'cancelled');assert.equal(f.tasks.get(first.taskId).state,'running');
  done({stopReason:'done'});await tick();
  f.routeEvent(f.b,{name:'agent:queued-submit',payload:{query:f.tasks.get(second.taskId).query}});
  assert.equal(f.b.queuedQueries.length,0);
  f.routeEvent(f.b,{name:'agent:response-chunk',payload:{blocks:[{type:'text',text:'SECOND'}]}});
  f.routeEvent(f.b,{name:'agent:queued-done',payload:{}});
  assert.equal(f.tasks.get(second.taskId).text,'SECOND');assert.equal(f.tasks.get(second.taskId).state,'completed');
  assert.equal(f.tasks.get(first.taskId).text,'');
});
test('final errors, cancellation and restart are distinct from completion; membership rechecked after wait',async t=>{
  const f=await setup(t);let fail;
  f.b.bridge.submit=()=>new Promise((_,r)=>fail=r);
  const failed=await f.access.send(f.b.id,'fail');fail(Error('upstream unavailable'));await tick();
  assert.equal((await f.access.task(failed.taskId)).state,'failed');assert.equal(f.b.lastTurnError,true);
  let done;f.b.bridge.submit=()=>new Promise(r=>done=r);
  const next=await f.access.send(f.b.id,'next');assert.equal(f.b.lastTurnError,false);
  const pending=f.access.task(next.taskId,0,30000);
  f.projects.update({action:'members',id:f.project.id,remove:[f.b.id]},()=>true);
  done({stopReason:'done'});await assert.rejects(pending,/outside this project/);
  f.projects.update({action:'members',id:f.project.id,add:[f.b.id]},()=>true);
  const third=await f.access.send(f.b.id,'cancel');
  f.routeEvent(f.b,{name:'agent:cancelled',payload:{}});done({stopReason:'cancelled'});await tick();
  assert.equal((await f.access.task(third.taskId)).state,'cancelled');
  const queued=f.tasks.create(f.a.id,f.b.id,'pending','pending');
  const reload=new f.CollaborationTasks(path.join(f.e.dir,'tasks'));
  assert.equal(reload.get(queued.id).state,'interrupted');
});
test('waiting can be cancelled; closing recipient settles receipts; status excludes expired permissions',async t=>{
  const f=await setup(t);f.b.bridge.submit=()=>new Promise(()=>{});
  const task=await f.access.send(f.b.id,'wait'),controller=new AbortController();
  const pending=f.access.task(task.taskId,0,30000,controller.signal);controller.abort();await assert.rejects(pending);
  f.b.pendingPermissions.set('expired',{expiresAt:0});f.b.pendingPermissions.set('live',{expiresAt:200000});
  const response=new Res();f.listSessions(response,f.sessions,f.projects);
  assert.equal(response.json().find(s=>s.instanceId===f.b.id).waitingApproval,true);
  f.b.pendingPermissions.delete('live');const response2=new Res();f.listSessions(response2,f.sessions,f.projects);
  assert.equal(response2.json().find(s=>s.instanceId===f.b.id).waitingApproval,false);
  const closed=new Res();await f.closeSession(closed,f.sessions,f.b.id);
  assert.equal((await f.access.task(task.taskId)).state,'cancelled');
});
test('project status prioritizes approval and failures; workspace conflicts include other projects',t=>{
  const e=env();const {projectSessionStatus:status,sharesActiveWorkspace:shared}=e.load('web/js/project-status.js');
  assert.equal(status({waitingApproval:true,isProcessing:true}),'approval');
  assert.equal(status({isProcessing:true,lastTurnError:true}),'running');
  assert.equal(status({hasUnread:true,lastTurnError:true}),'failed');
  assert.equal(status({hasUnread:true}),'unread');assert.equal(status({queuedCount:1}),'queued');
  const a={instanceId:'a',cwd:'/repo/sub',isProcessing:true},b={instanceId:'b',cwd:'/repo',isProcessing:true};
  assert(shared(a,[a,b],{'/repo/sub':{root:'/repo'}}));
  assert(!shared(a,[a,{...b,cwd:'/isolated'}],{'/repo/sub':{root:'/repo'}}));
});

test('corrupt receipt cannot prevent startup or overwrite the damaged file', async t=>{
 const f=await setup(t),file=path.join(f.e.dir,'tasks','00000000-0000-0000-0000-000000000000.json');
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{broken');
 const store=new f.CollaborationTasks(path.join(f.e.dir,'tasks'));
 assert.equal(store.list().length,0);assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});

test('structurally invalid receipt is excluded without hiding valid collaboration history',async t=>{
 const f=await setup(t),valid=f.tasks.create(f.a.id,f.b.id,'valid','valid');
 const id='00000000-0000-0000-0000-000000000000';
 const file=path.join(f.e.dir,'tasks',id+'.json');
 const damaged=JSON.stringify({id,text:'',sourceId:f.a.id,recipientId:f.b.id,state:'completed'});
 fs.writeFileSync(file,damaged);
 const store=new f.CollaborationTasks(path.join(f.e.dir,'tasks'));
 assert.equal(store.list().length,1,'malformed metadata must not enter the task list');
 assert.equal(store.list()[0].id,valid.id);assert.equal(fs.readFileSync(file,'utf8'),damaged);
});

const delivery = (summary = 'Verified result') => ({ summary, artifacts: [{ label: 'Report', path: '/workspace/report.md' }], unresolved: [] });
const plain = value => JSON.parse(JSON.stringify(value));
test('multi-task wait returns the first completed result, never process logs, and cursors exclude repeats', async t => {
 const f=await setup(t);
 const slow=f.tasks.create(f.a.id,f.b.id,'slow','slow'), fast=f.tasks.create(f.a.id,f.b.id,'fast','fast');
 f.tasks.start(fast.id);
 f.routeEvent(f.b,{name:'agent:response-chunk',payload:{blocks:[{type:'text',text:'PROCESS '.repeat(10000)}]}});
 let resolved=false;
 const waiting=f.access.waitTasks([{id:slow.id},{id:fast.id}]).then(r=>{resolved=true;return r;});
 await tick(); assert(!resolved);
 await f.b.bridge.opts.conversationAccess.deliver(fast.id,delivery());
 await tick(); assert(!resolved,'submitting a delivery must not pretend the turn ended');
 f.tasks.finish(fast.id,'completed');
 const first=await waiting;
 assert.equal(first.reason,'changed'); assert.deepEqual(plain(first.results.map(r=>r.id)),[fast.id]);
 assert.equal(first.results[0].delivery.summary,'Verified result');
 assert.equal(first.results[0].totalChars,80000); assert(!JSON.stringify(first).includes('PROCESS'));
 assert(JSON.stringify(first).length<2000,'result should remain small regardless of transcript size');
 resolved=false;
 const next=f.access.waitTasks(first.cursors).then(r=>{resolved=true;return r;});
 await tick(); assert(!resolved,'already completed task must not prevent waiting for the remaining one');
 f.tasks.start(slow.id); await tick(); assert(!resolved,'starting a task should not wake the coordinating model');
 f.tasks.finish(slow.id,'completed'); const second=await next;
 assert.deepEqual(plain(second.results.map(r=>r.id)),[slow.id]);
 assert.equal(second.results[0].delivery,null,'missing delivery must not be guessed from transcript');
 const settled=await f.access.waitTasks(second.cursors);
 assert.equal(settled.reason,'settled');assert.equal(settled.results.length,0);
 assert.equal(f.tasks.listeners.size,0);assert.equal(f.projects.listeners.size,0);
});

test('timeouts are compact, support 120 seconds without a model round trip, and preserve completion cursors',async t=>{
 const f=await setup(t),task=f.tasks.create(f.a.id,f.b.id,'work','work');f.tasks.start(task.id);
 await f.b.bridge.opts.conversationAccess.deliver(task.id,delivery());
 task.text='DO NOT REPEAT';
 const waiting=f.access.waitTasks([{id:task.id}]);
 const timer=[...f.e.timers.values()].find(t=>t.ms===120000);assert(timer);timer.fn();
 const timeout=await waiting;
 assert.equal(timeout.reason,'timeout');assert.equal(timeout.results.length,0);
 assert(!JSON.stringify(timeout).includes('DO NOT REPEAT'));assert(!JSON.stringify(timeout).includes('Verified result'));
 assert.equal(f.tasks.listeners.size,0);assert.equal(f.projects.listeners.size,0);
 f.tasks.finish(task.id,'completed');const done=await f.access.waitTasks(timeout.cursors,0);
 assert.equal(done.results[0].delivery.summary,'Verified result');
 await assert.rejects(f.access.waitTasks([{id:task.id}],120001),/waitMs/);
});

test('wait cancels promptly on abort, membership changes, source closure and shutdown without leaks',async t=>{
 const f=await setup(t),task=f.tasks.create(f.a.id,f.b.id,'work','work');f.tasks.start(task.id);
 const controller=new AbortController();const aborted=f.access.waitTasks([{id:task.id}],120000,controller.signal);
 controller.abort();await assert.rejects(aborted);
 assert.equal(f.tasks.listeners.size,0);assert.equal(f.projects.listeners.size,0);
 const removed=f.access.waitTasks([{id:task.id}]);
 f.projects.update({action:'members',id:f.project.id,remove:[f.b.id]},()=>true);
 await assert.rejects(removed,/outside this project/);
 assert.equal(f.tasks.listeners.size,0);assert.equal(f.projects.listeners.size,0);
 f.projects.update({action:'members',id:f.project.id,add:[f.b.id]},()=>true);
 const closed=f.access.waitTasks([{id:task.id}]);
 f.tasks.stopSession(f.a.id); f.a._closing=true;
 await assert.rejects(closed,/Source conversation unavailable/);f.a._closing=false;
 const shutdown=f.access.waitTasks([{id:task.id}]);
 f.tasks.stopSession(f.b.id);
 const result=await shutdown;assert.equal(result.results[0].state,'cancelled');
 assert.equal(f.tasks.listeners.size,0);assert.equal(f.projects.listeners.size,0);
});

test('task authorization covers every target, rejects malformed cursors, and snapshots plugin input',async t=>{
 const f=await setup(t),task=f.tasks.create(f.a.id,f.b.id,'work','work');
 const unrelated=f.tasks.create('other',f.b.id,'private','private');
 for(const targets of [[],null,[null],[{}],[{id:task.id},{id:task.id}],Array.from({length:17},(_,i)=>({id:String(i)})),[{id:task.id,afterRevision:-1}],[{id:task.id,afterRevision:0.5}]]) {
  await assert.rejects(f.access.waitTasks(targets,0));
 }
 await assert.rejects(f.access.waitTasks([{id:task.id,afterRevision:99}],0),/ahead/);
 await assert.rejects(f.access.waitTasks([{id:task.id},{id:unrelated.id}],0),/outside this conversation/);
 assert.equal(f.tasks.listeners.size,0);assert.equal(f.projects.listeners.size,0);
 const targets=[{id:task.id}];const waiting=f.access.waitTasks(targets);
 targets[0].id=unrelated.id;targets.push({id:unrelated.id});
 f.tasks.finish(task.id,'completed');const result=await waiting;
 assert.deepEqual(plain(result.results.map(r=>r.id)),[task.id]);
});

test('deliveries are recipient-only, bound to the running turn, durable and idempotent',async t=>{
 const f=await setup(t),task=f.tasks.create(f.a.id,f.b.id,'work','work'), access=f.b.bridge.opts.conversationAccess;
 await assert.rejects(access.deliver(task.id,delivery()),/currently running/);
 f.tasks.start(task.id);
 await assert.rejects(f.access.deliver(task.id,delivery()),/recipient/);
 const input=delivery();await access.deliver(task.id,input);const revision=task.revision;
 input.summary='mutated';input.artifacts[0].path='mutated';
 assert.equal(task.delivery.summary,'Verified result');assert.equal(task.delivery.artifacts[0].path,'/workspace/report.md');
 await access.deliver(task.id,delivery());assert.equal(task.revision,revision,'retry must not advance revision');
 await access.deliver(task.id,delivery('Updated conclusion'));assert.equal(task.revision,revision+1);
 const queued=f.tasks.create(f.a.id,f.b.id,'next','next');await assert.rejects(access.deliver(queued.id,delivery()),/currently running/);
 for(const bad of [null,{},delivery(' '),delivery('x'.repeat(2001)),{...delivery(),artifacts:Array(9).fill({label:'a',path:'p'})},{...delivery(),artifacts:[{label:'a',path:''}]},{...delivery(),unresolved:['x'.repeat(301)]}]) {
  await assert.rejects(access.deliver(task.id,bad),/Invalid delivery/);
 }
 const aborted=new AbortController();aborted.abort();await assert.rejects(access.deliver(task.id,delivery(),aborted.signal));
 const restored=new f.CollaborationTasks(path.join(f.e.dir,'tasks'));
 assert.equal(restored.get(task.id).state,'interrupted');assert.equal(restored.get(task.id).delivery.summary,'Updated conclusion');
 assert(restored.get(task.id).revision>task.revision);
 f.tasks.finish(task.id,'completed');await assert.rejects(access.deliver(task.id,delivery()),/currently running/);
 const result=await f.access.waitTasks([{id:task.id}],0);
 result.results[0].delivery.summary='caller mutation';assert.equal(task.delivery.summary,'Updated conclusion');
});

test('delivery persistence failure is reported without overwriting the previous result',async t=>{
 const f=await setup(t),task=f.tasks.create(f.a.id,f.b.id,'work','work');f.tasks.start(task.id);
 const access=f.b.bridge.opts.conversationAccess;await access.deliver(task.id,delivery());
 const revision=task.revision,rename=fs.renameSync;
 fs.renameSync=(from,to)=>{if(to===path.join(f.e.dir,'tasks',task.id+'.json'))throw Error('disk unavailable');return rename(from,to);};
 try { await assert.rejects(access.deliver(task.id,delivery('lost')),/disk unavailable/); }
 finally { fs.renameSync=rename; }
 assert.equal(task.delivery.summary,'Verified result');assert.equal(task.revision,revision);
 const file=JSON.parse(fs.readFileSync(path.join(f.e.dir,'tasks',task.id+'.json'),'utf8'));
 assert.equal(file.delivery.summary,'Verified result');
});

test('failed tasks retain explicit delivery without claiming success; legacy receipts and transcript remain compatible',async t=>{
 const f=await setup(t),task=f.tasks.create(f.a.id,f.b.id,'work','work');f.tasks.start(task.id);
 await f.b.bridge.opts.conversationAccess.deliver(task.id,delivery('Partial result'));
 task.text='Full original output 😀';f.tasks.finish(task.id,'failed','upstream failed');
 const result=await f.access.waitTasks([{id:task.id}],0);
 assert.equal(result.results[0].state,'failed');assert.equal(result.results[0].error,'upstream failed');
 assert.equal(result.results[0].delivery.summary,'Partial result');
 assert.equal((await f.access.task(task.id)).text,task.text);
 const file=path.join(f.e.dir,'tasks',task.id+'.json'),old=JSON.parse(fs.readFileSync(file));delete old.revision;delete old.delivery;fs.writeFileSync(file,JSON.stringify(old));
 const restored=new f.CollaborationTasks(path.join(f.e.dir,'tasks'));
 const legacy=await restored.waitMany([{id:task.id}],0);
 assert.equal(legacy.results[0].delivery,null);assert.equal(legacy.results[0].revision,0);
 assert.equal(restored.page(task.id).text,task.text);
 assert.equal((await restored.waitMany(legacy.cursors,0)).reason,'settled');
});

test('new generic tools forward cancellation, use concise wait by default, and expose delivery as a mutation',async t=>{
 const f=await setup(t),{conversationTools}=f.e.load('src/conversation-tools.ts'),calls=[];
 const tools=conversationTools({...f.access,waitTasks:async(...args)=>{calls.push(args);return {results:[]};},deliver:async(...args)=>{calls.push(args);return {submitted:true};}});
 const wait=tools.find(t=>t.name==='conversation_wait'),deliver=tools.find(t=>t.name==='conversation_deliver'),controller=new AbortController();
 assert(wait.readOnly);assert.equal(deliver.readOnly,false);
 assert.equal((await wait.execute({targets:[{id:'test'}]},null,{signal:controller.signal})).isError,false);
 assert.equal(calls[0][1],120000);assert.equal(calls[0][2],controller.signal);
 const value=delivery();assert.equal((await deliver.execute({id:'test',...value},null,{signal:controller.signal})).isError,false);
 assert.deepEqual(plain(calls[1][1]),value);assert.equal(calls[1][2],controller.signal);
 controller.abort();assert((await wait.execute({targets:[{id:'test'}]},null,{signal:controller.signal})).isError);
 assert((await deliver.execute({id:'test',...value},null,{signal:controller.signal})).isError);assert.equal(calls.length,2);
});

test('large simultaneous deliveries stay below the kernel limit and cursors never skip deferred results',async t=>{
 const f=await setup(t), targets=[], expected=new Map();
 const large={summary:'结'.repeat(2000),artifacts:Array.from({length:8},(_,i)=>({label:String(i)+'件'.repeat(119),path:'p'.repeat(1000)})),unresolved:Array(8).fill('题'.repeat(300))};
 for(let i=0;i<16;i++) {
  const task=f.tasks.create(f.a.id,f.b.id,'work'+i,'work'+i);f.tasks.start(task.id);
  await f.b.bridge.opts.conversationAccess.deliver(task.id,large);f.tasks.finish(task.id,'completed');
  targets.push({id:task.id});expected.set(task.id,large);
 }
 let cursors=targets, pages=0;const seen=new Set();
 for(let n=0;n<17;n++) {
  const result=await f.access.waitTasks(cursors,0);pages++;
  assert(JSON.stringify(result).length<100000,'kernel truncates a single-line JSON tool response above 100000 characters');
  for(const item of result.results) { assert(!seen.has(item.id),'result repeated');seen.add(item.id);assert.deepEqual(plain(item.delivery),expected.get(item.id)); }
  for(const cursor of result.cursors) if(!seen.has(cursor.id)) assert.equal(cursor.afterRevision,undefined,'unreturned delivery must not be acknowledged');
  cursors=result.cursors;
  if(!result.hasMore) break;
 }
 assert.equal(seen.size,16);assert(pages>1,'large batches need paging');
 assert.equal((await f.access.waitTasks(cursors,0)).reason,'settled');
});

test('terminal state change after failed persistence and restart is not hidden by a reused revision',async t=>{
 const f=await setup(t),task=f.tasks.create(f.a.id,f.b.id,'work','work');f.tasks.start(task.id);
 await f.b.bridge.opts.conversationAccess.deliver(task.id,delivery());
 const rename=fs.renameSync;
 fs.renameSync=(from,to)=>{if(to===path.join(f.e.dir,'tasks',task.id+'.json'))throw Error('disk unavailable');return rename(from,to);};
 try { f.tasks.finish(task.id,'completed'); } finally { fs.renameSync=rename; }
 const first=await f.access.waitTasks([{id:task.id}],0);assert.equal(first.results[0].state,'completed');
 const restored=new f.CollaborationTasks(path.join(f.e.dir,'tasks'));
 const next=await restored.waitMany(first.cursors,0);
 assert.equal(next.reason,'changed');assert.equal(next.results[0].state,'interrupted');
 assert.equal(next.results[0].delivery.summary,'Verified result');
 assert.equal((await restored.waitMany(next.cursors,0)).reason,'settled');
});

test('sparse delivery arrays from plugin handlers cannot persist unreadable receipts',async t=>{
 const f=await setup(t),task=f.tasks.create(f.a.id,f.b.id,'work','work');f.tasks.start(task.id);
 const access=f.b.bridge.opts.conversationAccess;await access.deliver(task.id,delivery());
 for(const bad of [{...delivery(),artifacts:Array(1)},{...delivery(),unresolved:Array(1)}]) await assert.rejects(access.deliver(task.id,bad),/Invalid delivery/);
 assert.equal(new f.CollaborationTasks(path.join(f.e.dir,'tasks')).get(task.id).delivery.summary,'Verified result');
});

test('escaped delivery fields and long errors remain bounded without dropping the explicit delivery',async t=>{
 const f=await setup(t),targets=[];
 const value={summary:'\u0001'.repeat(2000),artifacts:Array(8).fill({label:'\u0001'.repeat(120),path:'\u0001'.repeat(1000)}),unresolved:Array(8).fill('\u0001'.repeat(300))};
 for(let i=0;i<16;i++) {
  const task=f.tasks.create(f.a.id,f.b.id,'work','work');f.tasks.start(task.id);
  await f.b.bridge.opts.conversationAccess.deliver(task.id,value);f.tasks.finish(task.id,'failed','\u0001'.repeat(100000));targets.push({id:task.id});
 }
 const result=await f.access.waitTasks(targets,0);
 assert.equal(result.results.length,1);assert(result.hasMore);
 assert.equal(result.results[0].errorTruncated,true);assert.equal(result.results[0].error.length,1000);
 assert.deepEqual(plain(result.results[0].delivery),value);
 const {conversationTools}=f.e.load('src/conversation-tools.ts');
 const max=conversationTools(f.access).find(t=>t.name==='conversation_wait').maxResultBytes;
 assert(JSON.stringify(result).length<max);
 assert.equal((await f.access.task(targets[0].id)).error.length,100000,'original error must remain accessible');
});

test('deferred pages retain prior running cursors and detect lower revisions after multiple failed saves',async t=>{
 const f=await setup(t),targets=[];
 const value={summary:'结'.repeat(2000),artifacts:Array(8).fill({label:'x',path:'p'.repeat(1000)}),unresolved:[]};
 for(let i=0;i<8;i++){const task=f.tasks.create(f.a.id,f.b.id,'work','work');f.tasks.start(task.id);await f.b.bridge.opts.conversationAccess.deliver(task.id,value);targets.push({id:task.id});}
 const running=await f.access.waitTasks(targets,0);
 for(const target of targets)f.tasks.finish(target.id,'completed');
 const page=await f.access.waitTasks(running.cursors,0);assert(page.hasMore);
 const read=new Set(page.results.map(r=>r.id));
 for(let i=0;i<page.cursors.length;i++)if(!read.has(page.cursors[i].id))assert.deepEqual(plain(page.cursors[i]),plain(running.cursors[i]));
 const task=f.tasks.create(f.a.id,f.b.id,'disk failure','disk failure'),rename=fs.renameSync;
 fs.renameSync=(from,to)=>{if(to===path.join(f.e.dir,'tasks',task.id+'.json'))throw Error('disk unavailable');return rename(from,to);};
 try { f.tasks.start(task.id);f.tasks.finish(task.id,'completed'); } finally { fs.renameSync=rename; }
 const completed=await f.access.waitTasks([{id:task.id}],0);
 const restored=new f.CollaborationTasks(path.join(f.e.dir,'tasks'));
 assert(restored.get(task.id).revision<task.revision);
 assert.equal((await restored.waitMany(completed.cursors,0)).results[0].state,'interrupted');
 await assert.rejects(f.access.waitTasks([{id:task.id,afterState:'invalid'}],0));
});

async function supplementFixture(t, queued=false) {
 const f=await setup(t); f.b.bridge.supportsQueue=true;
 f.b.bridge.isProcessing=()=>queued || f.b.isProcessing;
 f.b.bridge.submit=queued?async()=>({stopReason:'queued'}):()=>new Promise(()=>{});
 const receipt=await f.access.send(f.b.id,'Original task'); await tick();
 f.id=receipt.taskId; f.steers=[]; f.edits=[];
 f.b.bridge.steer=(text,queueId)=>{f.steers.push({text,queueId});return true;};
 f.b.bridge.updateQueued=(id,text)=>{f.edits.push({id,text});return 'queue';};
 return f;
}
for (const [event, pending, edited] of [
 ['agent:queued-submit','pending',false],
 ['agent:steer-submit','uncertain',true],
]) test(`failed ${event} receipt cannot restore pre-supplement delivery (${pending})`,async t=>{
 const f=await supplementFixture(t), key='update-001', directory=path.join(f.e.dir,'tasks');
 const file=path.join(directory,f.id+'.json');
 await f.b.bridge.opts.conversationAccess.deliver(f.id,delivery('Pre-supplement evidence'));
 if(pending==='uncertain') f.b.bridge.steer=(text,queueId)=>{
  f.steers.push({text,queueId});throw Error('submission outcome unknown');
 };
 assert.equal((await f.access.supplement(f.id,key,'Exclude 2023')).state,pending);
 const running=await f.access.waitTasks([{id:f.id}],0);
 const {text,queueId}=f.steers[0], rename=fs.renameSync;
 let failures=0;
 const fault=t.mock.method(fs,'renameSync',(from,to)=>{
  if(to===file){failures++;throw Error('fixture receipt rename failed');}
  return rename(from,to);
 });
 const {createConversationAccess}=f.e.load('src/services/conversation-service.ts');
 const reopen=()=>{
  const tasks=new f.CollaborationTasks(directory);
  const access=createConversationAccess(f.a.id,{sessions:f.sessions,projects:f.projects,tasks,withContextLock:(_session,read)=>read()});
  return {tasks,access};
 };
 const verifyRecovery=async recovered=>{
  const waited=await recovered.access.waitTasks(running.cursors,0);
  assert.equal(waited.reason,'changed');
  assert.equal(waited.results[0].state,'interrupted');
  assert.equal(waited.results[0].delivery,null);
  assert.equal(waited.results[0].deliverySubmitted,false);
  assert.equal(recovered.tasks.snapshot(f.a.id)[0].deliverySubmitted,false);
  assert.equal((await recovered.access.task(f.id)).state,'interrupted','the transcript receipt remains readable');
  assert.equal((await recovered.access.supplement(f.id,key)).state,'interrupted');
 };
 try {
  f.routeEvent(f.b,{name:event,payload:{queueId,query:edited?'Edited correction':text}});
  assert.equal(failures,1,'the matching consumption receipt must hit the injected fault');
  assert.equal((await f.access.supplement(f.id,key)).state,edited?'modified':'consumed');
  assert.equal(f.tasks.get(f.id).delivery,undefined);
  const stale=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(stale.supplements[0].state,pending);
  assert.equal(stale.delivery.summary,'Pre-supplement evidence');
  await verifyRecovery(reopen()); // Even if writing the interrupted receipt also fails.
  assert.equal(failures,2);
 } finally { fault.mock.restore(); }
 await verifyRecovery(reopen());
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).delivery,undefined);
 await verifyRecovery(reopen()); // A second restart must not resurrect it either.
});

test('an older host may have persisted an interrupted supplement alongside its stale delivery',async t=>{
 const f=await supplementFixture(t), directory=path.join(f.e.dir,'tasks');
 await f.b.bridge.opts.conversationAccess.deliver(f.id,delivery('Old delivery'));
 await f.access.supplement(f.id,'update-001','Correction');
 const file=path.join(directory,f.id+'.json'), old=JSON.parse(fs.readFileSync(file,'utf8'));
 old.state='interrupted';old.supplements[0].state='interrupted';old.revision++;
 fs.writeFileSync(file,JSON.stringify(old));
 const restored=new f.CollaborationTasks(directory);
 const result=await restored.waitMany([{id:f.id,afterRevision:old.revision,afterState:old.state}],0);
 assert.equal(result.reason,'changed','coordinators with an old cursor must observe the correction');
 assert.equal(result.results[0].delivery,null);
 assert.equal(result.results[0].deliverySubmitted,false);
});

test('known unconsumed supplements preserve a valid partial delivery on restart',async t=>{
 const f=await supplementFixture(t), access=f.b.bridge.opts.conversationAccess;
 await access.deliver(f.id,delivery('Valid partial evidence'));
 const rename=fs.renameSync, file=path.join(f.e.dir,'tasks',f.id+'.json');
 const fault=t.mock.method(fs,'renameSync',(from,to)=>{
  if(to===file)throw Error('fixture receipt cannot be armed');
  return rename(from,to);
 });
 try { await assert.rejects(f.access.supplement(f.id,'update-failed','Never sent'),/cannot be armed/); }
 finally { fault.mock.restore(); }
 assert.equal(f.steers.length,0);
 f.b.bridge.steer=()=>false;
 assert.equal((await f.access.supplement(f.id,'update-rejected','Rejected')).state,'rejected');
 f.b.bridge.steer=(text,queueId)=>{f.steers.push({text,queueId});return true;};
 await f.access.supplement(f.id,'update-dropped','Withdrawn');
 const {queueId,text}=f.steers[0];
 f.routeEvent(f.b,{name:'agent:queued-done',payload:{queueId,query:text,dropped:true}});
 assert.equal((await f.access.supplement(f.id,'update-dropped')).state,'dropped');
 const restored=new f.CollaborationTasks(path.dirname(file));
 const {results}=await restored.waitMany([{id:f.id}],0);
 assert.equal(results[0].state,'interrupted');
 assert.deepEqual(plain(results[0].delivery),delivery('Valid partial evidence'));
});

test('running supplements retain one active task, deduplicate concurrent retries and expose consumption',async t=>{
 const f=await supplementFixture(t);
 await f.b.bridge.opts.conversationAccess.deliver(f.id,delivery('Earlier delivery'));
 const [a,b]=await Promise.all([f.access.supplement(f.id,'update-001','Exclude 2023'),f.access.supplement(f.id,'update-001','Exclude 2023')]);
 assert.equal(a.state,'pending');assert.deepEqual(a,b);assert.equal(f.steers.length,1);assert.equal(f.tasks.list().length,1);
 await assert.rejects(f.access.supplement(f.id,'update-001','Different'),/different content/);
 const {text,queueId}=f.steers[0];assert.equal(f.b.queuedItems.get(queueId).delivery,'steer');
 f.routeEvent(f.b,{name:'agent:steer-submit',payload:{query:text,queueId}});
 assert.equal(f.tasks.get(f.id).state,'running');assert.equal(f.b.queuedItems.size,0);
 assert.equal((await f.access.supplement(f.id,'update-001')).state,'consumed');assert.equal(f.tasks.get(f.id).delivery,undefined);
 f.routeEvent(f.b,{name:'agent:response-chunk',payload:{blocks:[{type:'text',text:'Updated result'}]}});
 assert.equal(f.tasks.get(f.id).text,'Updated result');
 await f.b.bridge.opts.conversationAccess.deliver(f.id,delivery('Corrected evidence'));
 f.tasks.finish(f.id,'completed');
 const restored=new f.CollaborationTasks(path.join(f.e.dir,'tasks'));
 const {results}=await restored.waitMany([{id:f.id}],0);
 assert.equal(results[0].state,'completed');
 assert.deepEqual(plain(results[0].delivery),delivery('Corrected evidence'));
 assert.equal((await f.access.supplement(f.id,'update-001','Exclude 2023')).state,'consumed');
 assert.equal((await f.access.supplement(f.id,'update-002','Later')).state,'task_ended');assert.equal(f.steers.length,1);
});
test('queued supplements merge in place and preserve identity and consumption after user editing',async t=>{
 const f=await supplementFixture(t,true),original=[...f.b.queuedItems.values()][0];
 f.b.queuedItems.set('other',{id:'other',query:'unrelated'});f.b.queuedQueries.push('unrelated');
 const result=await f.access.supplement(f.id,'update-001','New criterion');
 assert.equal(result.mode,'queue');assert.equal(f.edits.length,1);assert.equal(f.steers.length,0);
 assert.equal([...f.b.queuedItems.keys()][0],original.id);assert.equal(original.revision,1);
 assert.match(original.query,/Original task/);assert.match(original.query,/New criterion/);
 assert.equal(f.b.queuedQueries[0],original.query);assert.equal(f.b.queuedQueries[1],'unrelated');
 await f.access.supplement(f.id,'update-002','Second criterion');assert.equal(original.revision,2);
 f.routeEvent(f.b,{name:'agent:queued-submit',payload:{queueId:original.id,query:'User replaced the content'}});
 assert.equal(f.tasks.get(f.id).state,'running');
 assert.equal((await f.access.supplement(f.id,'update-001')).state,'modified');
 assert.equal((await f.access.supplement(f.id,'update-002')).state,'modified');
});
test('queued supplement arrives in the original task without another model turn',async t=>{
 const f=await supplementFixture(t,true);
 const supplement = 'New criterion\n\n  Exclude 2023';
 await f.access.supplement(f.id,'update-001',supplement);
 const item=[...f.b.queuedItems.values()][0];
 f.routeEvent(f.b,{name:'agent:queued-submit',payload:{queueId:item.id,query:item.query}});
 const [query] = conversationQueries(f.b);
 assert.equal(query.query, item.query);
 assert.equal(query.collaboration.body, 'Original task');
 assert.equal(query.collaboration.supplements[0].body, supplement);
 assert.equal(query.collaboration.supplements[0].kind, 'supplement');
 assert.equal((await f.access.supplement(f.id,'update-001')).state,'consumed');assert(f.tasks.isActive(f.id));
 f.routeEvent(f.b,{name:'agent:queued-done',payload:{}});
 assert.equal(f.tasks.get(f.id).state,'completed');
});
test('supplement authorization is source-bound and rechecked after context locking',async t=>{
 const f=await supplementFixture(t);
 await assert.rejects(f.b.bridge.opts.conversationAccess.supplement(f.id,'update-001','No'),/Only the task sender/);
 const pending=f.access.supplement(f.id,'update-001','No');
 f.projects.update({action:'members',id:f.project.id,remove:[f.b.id]},()=>true);
 await assert.rejects(pending,/outside this project|unavailable/i);assert.equal(f.steers.length,0);
});
test('aborted, invalid and unavailable supplements never reach the bridge',async t=>{
 const f=await supplementFixture(t),controller=new AbortController();controller.abort();
 await assert.rejects(f.access.supplement(f.id,'update-001','No',controller.signal));
 for(const [key,msg] of [['short','x'],['update-001',''],['update-001','x'.repeat(8001)]])await assert.rejects(f.access.supplement(f.id,key,msg));
 f.b._hostOperation=true;await assert.rejects(f.access.supplement(f.id,'update-001','No'),/unavailable/);delete f.b._hostOperation;
 assert.equal(f.steers.length,0);assert.equal(f.tasks.get(f.id).supplements,undefined);
});
test('strict steering refusal never falls back to a new queued task',async t=>{
 const f=await supplementFixture(t);f.b.bridge.steer=()=>false;
 assert.equal((await f.access.supplement(f.id,'update-001','No')).state,'rejected');assert.equal(f.b.queuedItems.size,0);assert.equal(f.b.queuedQueries.length,0);
 f.b.bridge.steer=()=>{throw Error('Must not retry');};
 assert.equal((await f.access.supplement(f.id,'update-001','No')).state,'rejected');
});
test('refused queued update restores the original task query and leaves the queue unchanged',async t=>{
 const f=await supplementFixture(t,true),query=f.tasks.get(f.id).query;f.b.bridge.updateQueued=()=>null;
 assert.equal((await f.access.supplement(f.id,'update-001','No')).state,'rejected');
 assert.equal(f.tasks.get(f.id).query,query);assert.equal(f.b.queuedQueries[0],query);
});
test('withdrawal and cancellation settle supplement receipts without completing the active task',async t=>{
 const f=await supplementFixture(t);await f.access.supplement(f.id,'update-001','No');const u=f.steers[0];
 f.routeEvent(f.b,{name:'agent:queued-done',payload:{queueId:u.queueId,query:u.text,dropped:true}});
 assert.equal((await f.access.supplement(f.id,'update-001')).state,'dropped');assert.equal(f.tasks.get(f.id).state,'running');
 await f.access.supplement(f.id,'update-002','No again');f.tasks.finish(f.id,'cancelled');
 assert.equal((await f.access.supplement(f.id,'update-002')).state,'dropped');
});
test('receipt persistence failure prevents delivery; restart does not replay pending supplements',async t=>{
 const f=await supplementFixture(t),save=f.tasks.save;
 f.tasks.save=()=>{throw Error('disk full');};await assert.rejects(f.access.supplement(f.id,'update-001','No'),/disk full/);
 assert.equal(f.steers.length,0);assert.equal(f.tasks.get(f.id).supplements,undefined);f.tasks.save=save;
 await f.access.supplement(f.id,'update-001','No');
 const reload=new f.CollaborationTasks(path.join(f.e.dir,'tasks'));
 assert.equal(reload.supplementReceipt(f.id,'update-001').state,'interrupted');assert.equal(reload.get(f.id).state,'interrupted');
 assert.equal(f.steers.length,1);
});

test('uncertain dispatch never retries automatically and can later acknowledge consumption',async t=>{
 const f=await supplementFixture(t);let attempt;
 f.b.bridge.steer=(text,queueId)=>{attempt={text,queueId};throw Error('Transport result unknown');};
 assert.equal((await f.access.supplement(f.id,'update-001','Check')).state,'uncertain');
 f.b.bridge.steer=()=>{throw Error('A retry must not send');};
 assert.equal((await f.access.supplement(f.id,'update-001','Check')).state,'uncertain');
 f.routeEvent(f.b,{name:'agent:steer-submit',payload:{queueId:attempt.queueId,query:attempt.text}});
 assert.equal((await f.access.supplement(f.id,'update-001')).state,'consumed');
});
test('supplement limits are enforced before bridge delivery',async t=>{
 const f=await supplementFixture(t);
 for(let i=0;i<32;i++)await f.access.supplement(f.id,'update-'+String(i).padStart(3,'0'),'Check');
 await assert.rejects(f.access.supplement(f.id,'update-033','Check'),/limit/);assert.equal(f.steers.length,32);
 const q=await supplementFixture(t,true);
 for(let i=0;i<7;i++)await q.access.supplement(q.id,'update-'+String(i).padStart(3,'0'),'x'.repeat(8000));
 await assert.rejects(q.access.supplement(q.id,'update-008','x'.repeat(8000)),/64000/);assert.equal(q.edits.length,7);
});
test('synchronous consumption does not recreate the pending UI entry',async t=>{
 const f=await supplementFixture(t);f.b.bridge.steer=(text,queueId)=>{
  f.routeEvent(f.b,{name:'agent:steer-submit',payload:{query:text,queueId}});return true;
 };
 assert.equal((await f.access.supplement(f.id,'update-001','Check')).state,'consumed');
 assert.equal(f.b.queuedItems.size,0);assert.equal(f.b.queuedQueries.length,0);
});
test('manual edits to a supplemental message are reported separately from exact consumption',async t=>{
 const f=await supplementFixture(t);await f.access.supplement(f.id,'update-001','Original correction');
 f.routeEvent(f.b,{name:'agent:steer-submit',payload:{query:'A user edited correction',queueId:f.steers[0].queueId}});
 assert.equal((await f.access.supplement(f.id,'update-001')).state,'modified');
});

async function notificationFixture(t,busy=true) {
 const f=await supplementFixture(t);f.notices=[];f.a.isProcessing=busy;f.a.bridge.isProcessing=()=>busy;f.a.bridge.supportsQueue=true;
 f.a.bridge.steer=(text,queueId)=>{f.notices.push({text,queueId});return true};
 f.child=f.b.bridge.opts.conversationAccess;
 return f;
}
test('task notifications steer only to the original coordinator, deduplicate, wake waits and preserve task ownership',async t=>{
 const f=await notificationFixture(t);let returned=false;
 const wait=f.access.waitTasks([{id:f.id}],120000).then(r=>{returned=true;return r});await tick();assert.equal(returned,false);
 const [a,b]=await Promise.all([f.child.signal(f.id,'blocker-001','Need missing input'),f.child.signal(f.id,'blocker-001','Need missing input')]);
 assert.deepEqual(a,b);assert.equal(a.mode,'steer');assert.equal(a.state,'pending');assert.equal(f.notices.length,1);
 const w=await wait;assert.equal(w.reason,'attention');assert.equal(w.results.length,0);assert.equal(w.attention[0].taskId,f.id);
 assert.equal(f.tasks.list().length,1);assert.equal(f.tasks.get(f.id).state,'running');
 const duplicate=await f.child.signal(f.id,'another-key','Need missing input');assert.equal(duplicate.duplicate,true);assert.equal(duplicate.requestKey,'blocker-001');
 await assert.rejects(f.child.signal(f.id,'blocker-001','Different'),/different content/);
 await assert.rejects(f.child.signal(f.id,'blocker-002','Other'),/pending/);
 const n=f.notices[0];f.routeEvent(f.a,{name:'agent:steer-submit',payload:{query:n.text,queueId:n.queueId}});
 const [shown] = conversationQueries(f.a);
 assert.equal(shown.query, n.text);
 assert.equal(shown.collaboration.kind, 'blocker');
 assert.equal(shown.collaboration.taskId, f.id);
 assert.equal(shown.collaboration.sender.id, f.b.id);
 assert.equal(shown.collaboration.body, 'Need missing input');
 assert.equal((await f.child.signal(f.id,'blocker-001')).state,'consumed');assert.equal(f.tasks.get(f.id).state,'running');
 assert.equal((await f.access.waitTasks(w.cursors,0)).reason,'timeout');
 f.tasks.finish(f.id,'completed');const final=await f.access.waitTasks(w.cursors,0);assert.equal(final.results[0].state,'completed');
 assert.equal((await f.child.signal(f.id,'after-end','New issue')).state,'task_ended');
});
test('idle notification starts one normal turn, keeps the original task, and a status read never starts another',async t=>{
 const f=await notificationFixture(t,false);let calls=0;
 f.a.bridge.submit=text=>{calls++;f.notices.push(text);return new Promise(()=>{})};
 const a=await f.child.signal(f.id,'blocker-001','Need a decision');assert.equal(a.mode,'turn');assert.equal(a.state,'consumed');assert.equal(calls,1);
 assert.equal((await f.child.signal(f.id,'blocker-001')).state,'consumed');assert.equal(calls,1);assert.equal(f.tasks.list().length,1);
 assert.equal(f.tasks.get(f.id).recipientId,f.b.id);assert.equal(f.tasks.get(f.id).state,'running');
});
test('notification validation enforces participant, active task, membership, cancellation and stopped coordinator',async t=>{
 const f=await notificationFixture(t);
 await assert.rejects(f.access.signal(f.id,'blocker-001','Wrong direction'),/recipient/);
 await assert.rejects(f.child.signal(f.id,'short','Bad key'),/requestKey/);
 await assert.rejects(f.child.signal(f.id,'blocker-001','x'.repeat(2001)),/2000/);
 await assert.rejects(f.child.signal(f.id,'blocker-001','Cancelled',AbortSignal.abort()));assert.equal(f.notices.length,0);
 f.a._cancelled=true;await assert.rejects(f.child.signal(f.id,'blocker-001','Stopped'),/stopped/);f.a._cancelled=false;
 const old=f.tasks.get(f.id);f.tasks.start(f.tasks.create(f.a.id,f.b.id,'another','another').id);
 await assert.rejects(f.child.signal(f.id,'blocker-001','Obsolete turn'),/currently running/);
 assert.equal(old.signals,undefined);
 f.projects.update({action:'members',id:f.project.id,remove:[f.b.id]},()=>true);
 await assert.rejects(f.child.signal(f.id,'blocker-001','No longer same project'),/project/);
});
test('notification rejected, uncertain, edited, dropped and restarted receipts never silently resend',async t=>{
 for(const action of ['reject','throw','edit','drop','restart']){
  const f=await notificationFixture(t);
  if(action==='reject')f.a.bridge.steer=()=>false;
  if(action==='throw')f.a.bridge.steer=()=>{throw Error('ambiguous')};
  const first=await f.child.signal(f.id,'blocker-001','Issue');
  if(action==='reject'){assert.equal(first.state,'rejected');assert.equal(f.a.queuedItems.size,0);}
  if(action==='throw')assert.equal(first.state,'uncertain');
  if(action==='edit'||action==='drop'){
   const n=f.notices[0];f.routeEvent(f.a,{name:action==='edit'?'agent:steer-submit':'agent:queued-done',payload:{queueId:n.queueId,query:action==='edit'?'Changed by user':n.text,...(action==='drop'?{dropped:true}:{})}});
   assert.equal((await f.child.signal(f.id,'blocker-001')).state,action==='edit'?'modified':'dropped');
  }
  if(action==='restart'){const reloaded=new f.CollaborationTasks(path.join(f.e.dir,'tasks'));assert.equal(reloaded.signalReceipt(f.id,'blocker-001').state,'interrupted');}
  const count=f.notices.length;await f.child.signal(f.id,'blocker-001','Issue');assert.equal(f.notices.length,count);
 }
});
test('notification limits bound new issues, suppress coordinator storms, and failures to persist prevent dispatch',async t=>{
 const f=await notificationFixture(t);
 await f.child.signal(f.id,'blocker-001','First');const n=f.notices[0];f.routeEvent(f.a,{name:'agent:steer-submit',payload:{query:n.text,queueId:n.queueId}});
 await assert.rejects(f.child.signal(f.id,'blocker-002','Second'),/60 seconds/);
 f.e.clock(161000);await f.child.signal(f.id,'blocker-002','Second');assert.equal(f.notices.length,2);
 const store=f.tasks;
 for(let i=0;i<5;i++){const task=store.create(f.a.id,'worker-'+i,'work','work');store.prepareSignal(task.id,{requestKey:'notice-key',message:'issue',text:'issue',queueId:'id-'+i,mode:'steer',state:'consumed',createdAt:161000});}
 const last=store.create(f.a.id,'last','work','work');assert.throws(()=>store.prepareSignal(last.id,{requestKey:'notice-key',message:'issue',text:'issue',queueId:'last',mode:'steer',state:'pending',createdAt:161000}),/6 per minute/);
 const another=await notificationFixture(t);const save=another.tasks.save;another.tasks.save=()=>{throw Error('Disk full')};
 await assert.rejects(another.child.signal(another.id,'blocker-001','Cannot save'),/Disk full/);assert.equal(another.notices.length,0);another.tasks.save=save;
});

test('notifications recheck membership after lazy restore and preserve a coordinator own active task',async t=>{
 const f=await notificationFixture(t);let resume;
 f.a._ensureBridge=()=>new Promise(r=>resume=r);
 const pending=f.child.signal(f.id,'blocker-001','Need input');await tick();
 f.projects.update({action:'members',id:f.project.id,remove:[f.b.id]},()=>true);resume();await assert.rejects(pending,/project/);assert.equal(f.notices.length,0);
 f.projects.update({action:'members',id:f.project.id,add:[f.b.id]},()=>true);delete f.a._ensureBridge;
 const parent=f.tasks.create('grandparent',f.a.id,'Coordinate','Coordinate');f.tasks.start(parent.id);
 f.tasks.deliver(parent.id,f.a.id,delivery('Keep this result'));
 await f.child.signal(f.id,'blocker-001','Need input');const n=f.notices[0];f.routeEvent(f.a,{name:'agent:steer-submit',payload:{query:n.text,queueId:n.queueId}});
 assert.equal(f.tasks.get(parent.id).state,'running');assert(f.tasks.get(parent.id).delivery);assert.equal(f.tasks.get(f.id).state,'running');
 f.a._ensureBridge=()=>{throw Error('Receipt reads must not restore a bridge')};assert.equal((await f.child.signal(f.id,'blocker-001')).state,'consumed');
});
test('idle-to-busy race queues a single notification and consumes the matching queue ID',async t=>{
 const f=await notificationFixture(t,false);
 // The first lock observes idle. The submit lock sees the newly started user turn.
 const original=f.tasks.prepareSignal.bind(f.tasks);f.tasks.prepareSignal=(...args)=>{original(...args);f.a.bridge.isProcessing=()=>true;f.a.isProcessing=true;};
 f.a.bridge.submit=async()=>({stopReason:'queued'});
 const receipt=await f.child.signal(f.id,'blocker-001','Decision needed');assert.equal(receipt.mode,'queue');assert.equal(receipt.state,'pending');await tick();
 const notice=f.tasks.get(f.id).signals[0];assert(f.a.queuedItems.has(notice.queueId));
 f.routeEvent(f.a,{name:'agent:error',payload:{message:'Previous unrelated turn failed'}});
 assert.equal((await f.child.signal(f.id,'blocker-001')).state,'pending','a prior turn error must not drop a queued notification');
 f.routeEvent(f.a,{name:'agent:queued-submit',payload:{query:notice.text,queueId:notice.queueId}});
 assert.equal((await f.child.signal(f.id,'blocker-001')).state,'consumed');assert.equal(f.tasks.list().length,1);
});

test('a blocker wakes a coordinator waiting for another task without acknowledging that task',async t=>{
 const f=await notificationFixture(t),other=f.tasks.create(f.a.id,f.b.id,'Future task','Future task');
 const pending=f.access.waitTasks([{id:other.id}],120000);await tick();
 await f.child.signal(f.id,'blocker-001','Requires decision');const result=await pending;
 assert.equal(result.reason,'attention');assert.equal(result.attention[0].taskId,f.id);assert.equal(result.cursors.length,1);assert.equal(result.cursors[0].id,other.id);assert.equal(result.results.length,0);
});

test('task event subscribers see terminal receipts without starting a model and unsubscribe cleanly', () => {
 const e=env();const {CollaborationTasks}=e.load('src/collaboration.ts');const tasks=new CollaborationTasks(path.join(e.dir,'events'));
 const task=tasks.create('owner','member','private input','private query');let notices=0;
 const off=tasks.subscribe(()=>{notices++;});tasks.subscribe(()=>{throw Error('broken observer')});tasks.start(task.id);tasks.finish(task.id,'completed');
 assert.equal(notices,2);const list=tasks.snapshot('owner');assert.equal(list[0].terminal,true);assert.equal(list[0].state,'completed');assert.equal('message' in list[0],false);assert.equal('text' in list[0],false);assert.equal(tasks.snapshot('other').length,0);off();tasks.wakeSignalWaiters();assert.equal(notices,2);
});
