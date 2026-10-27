const test = require('node:test');
const assert = require('node:assert/strict');
const {env, Bridge, fs, path} = require('./harness.cjs');
const tick = () => new Promise(r => setImmediate(r));
function fixture(t) {
  const e = env(); t.after(() => fs.rmSync(e.dir, {recursive:true, force:true}));
  const {ProjectStore} = e.load('src/projects.ts');
  const store = new ProjectStore(path.join(e.dir, 'projects.json'));
  return {e, store, ProjectStore};
}
test('projects persist across reload; moving membership is unique and deletion preserves unrelated data', t => {
  const {e, store, ProjectStore} = fixture(t);
  const can = id => ['a','b','c'].includes(id);
  const a = store.update({action:'create',cwd:e.dir,name:' Alpha ',add:['a','b','a']},can)[0];
  const b = store.update({action:'create',cwd:e.dir,name:'Beta'},can)[1];
  store.update({action:'members',id:b.id,add:['b','c']},can);
  const restored = new ProjectStore(path.join(e.dir,'projects.json'));
  assert.deepEqual(JSON.parse(JSON.stringify(restored.list().map(p=>p.sessionIds))), [['a'],['b','c']]);
  store.update({action:'edit',id:a.id,name:'Renamed',remove:['a']},can);
  assert.equal(store.list()[0].name,'Renamed');
  store.update({action:'delete',id:a.id},can);
  assert.equal(store.list().length,1);
  assert.equal(store.list()[0].id,b.id);
});
test('invalid edits are atomic and corrupt storage is never overwritten', t => {
  const {e,store} = fixture(t); const p = store.update({action:'create',cwd:e.dir,name:'Keep'},()=>true)[0];
  const file = path.join(e.dir,'projects.json'), before = fs.readFileSync(file,'utf8');
  assert.throws(()=>store.update({action:'edit',id:p.id,name:'Changed',add:['missing']},()=>false));
  assert.equal(fs.readFileSync(file,'utf8'),before);
  for (const name of ['', ' ', 'x'.repeat(81), 8]) assert.throws(()=>store.update({action:'create',cwd:e.dir,name},()=>true));
  fs.writeFileSync(file,'{broken');
  assert.throws(()=>store.update({action:'create',cwd:e.dir,name:'New'},()=>true));
  assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
async function communication(t) {
  const {e,store} = fixture(t);
  const {createSession, conversationAccess} = e.load('src/hub.ts','export { createSession, conversationAccess };');
  const sessions = new Map();
  const opts = {makeBridge:o=>new Bridge(o), conversationAccess:id=>conversationAccess(id,sessions,store)};
  const a = await createSession(sessions,opts,e.dir), b = await createSession(sessions,opts,e.dir), c = await createSession(sessions,opts,e.dir);
  const project = store.update({action:'create',cwd:e.dir,name:'Project',add:[a.id,b.id]},()=>true)[0];
  const access = a.bridge.opts.conversationAccess;
  return {e,store,project,sessions,a,b,c,access};
}
test('communication lists only same-project live agents and refuses self/outside reads', async t => {
  const {access,a,b,c,store,project} = await communication(t);
  assert.equal(access.list().conversations.length,2);
  await assert.rejects(access.read(a.id,10),/current context/);
  await assert.rejects(access.read(c.id,10),/outside this project/);
  await assert.rejects(access.send(c.id,'hi'),/outside this project/);
  store.update({action:'members',id:project.id,remove:[b.id]},()=>true);
  await assert.rejects(access.read(b.id,10),/outside this project/);
});
test('reads retain formatting, bound Unicode safely, and omit tool/system-only messages', async t => {
  const {access,b} = await communication(t);
  b.bridge.messages = [{role:'system',content:'hidden'},{role:'tool',content:'hidden'}, {role:'user',content:'line1\nline2'},
    {role:'assistant',content:'a'.repeat(1999)+'😀tail'}, {role:'assistant',content:null,tool_calls:[]},
    {role:'user',content:'[Project skills available: hidden]'}];
  const data = await access.read(b.id,10);
  assert.equal(data.messages.length,2); assert.equal(data.messages[0].text,'line1\nline2');
  assert.equal(data.messages[1].text,'a'.repeat(1999)); assert.equal(data.messages[1].truncated,true);
  for (const limit of [0,41,1.5,NaN]) await assert.rejects(access.read(b.id,limit));
});
test('delivery returns before recipient completes and uses normal replay and queue handling', async t => {
  const {access,b} = await communication(t);
  let finish, received;
  b.bridge.submit = text => {received=text; return new Promise(resolve=>finish=resolve);};
  const receipt = await access.send(b.id,'Please review the plan');
  assert.equal(receipt.ok,true); assert.equal(receipt.queued,false); assert.equal(b.isProcessing,true);
  assert.match(received,/not new user authorization/); assert.match(received,/Please review/);
  assert(b.replay.some(frame=>frame.includes('Please review')));
  b.bridge.isProcessing = () => true;
  await assert.rejects(access.send(b.id,'busy'),/already in progress/);
  b.bridge.supportsQueue = true;
  b.bridge.submit = async () => ({stopReason:'queued'});
  assert.equal((await access.send(b.id,'queued message')).queued,true);
  await tick(); assert(b.replay.some(frame=>frame.includes('agent:queued')&&frame.includes('queued message')));
  finish({stopReason:'done'}); await tick(); await tick();
});
test('membership changes and cancellation while waiting for a lock prevent delivery', async t => {
  const {access,b,store,project} = await communication(t);
  let release; b.contextLock = new Promise(r=>release=r);
  const pending = access.send(b.id,'must not arrive');
  await tick(); store.update({action:'members',id:project.id,remove:[b.id]},()=>true); release();
  await assert.rejects(pending,/outside this project/); assert.equal(b.bridge.messages.length,0);
  store.update({action:'members',id:project.id,add:[b.id]},()=>true);
  const controller = new AbortController(); b.contextLock = new Promise(r=>release=r);
  const cancelled = access.send(b.id,'cancelled',controller.signal); await tick(); controller.abort(); release();
  await assert.rejects(cancelled); assert.equal(b.bridge.messages.length,0);
});
test('archived and closed conversations cannot receive messages; membership is retained', async t => {
  const {access,b,store} = await communication(t);
  b._closing=true; await assert.rejects(access.send(b.id,'hi')); assert.equal(access.list().conversations.length,1);
  assert(store.list()[0].sessionIds.includes(b.id));
  b._closing=false; b._closed=true; await assert.rejects(access.read(b.id,10));
});
test('conversation tools forward cancellation and report errors as tool failures', async t => {
  const {e} = fixture(t); const {conversationTools} = e.load('src/conversation-tools.ts');
  const calls=[]; const tools=conversationTools({list:()=>({conversations:[]}),read:async(...a)=>{calls.push(a);return {};},send:async()=>{throw Error('unavailable');}});
  const controller=new AbortController();
  const read=tools.find(x=>x.name==='conversation_read'); await read.execute({id:'a'},null,{signal:controller.signal});
  assert.equal(calls[0][1],10); assert.equal(calls[0][2],controller.signal);
  assert.equal((await tools.find(x=>x.name==='conversation_send').execute({id:'b',message:'hi'})).isError,true);
  controller.abort(); assert.equal((await read.execute({id:'a'},null,{signal:controller.signal})).isError,true);
  assert.equal(calls.length,1);
});

test('project root persists independently of membership and validates folder edits atomically', t => {
 const {e,store,ProjectStore}=fixture(t),root=path.join(e.dir,'root'),other=path.join(e.dir,'other');fs.mkdirSync(root);fs.mkdirSync(other);
 const p=store.update({action:'create',name:'Rooted',cwd:root,add:['external']},()=>true)[0];
 store.update({action:'members',id:p.id,remove:['external'],add:['new']},()=>true);
 assert.equal(new ProjectStore(path.join(e.dir,'projects.json')).list()[0].cwd,root);
 const file=path.join(e.dir,'not-a-folder');fs.writeFileSync(file,'data');
 for(const cwd of [undefined,null,'','relative',path.join(e.dir,'missing'),file]){
  assert.throws(()=>store.update({action:'create',name:'Invalid',cwd},()=>true));
  if(cwd!==undefined)assert.throws(()=>store.update({action:'edit',id:p.id,name:'Wrong',cwd},()=>true));
  assert.equal(store.list()[0].cwd,root);assert.equal(store.list()[0].name,'Rooted');
 }
 store.update({action:'edit',id:p.id,name:'Rooted',cwd:other},()=>true);
 assert.equal(store.list()[0].cwd,other);assert.deepEqual([...store.list()[0].sessionIds],['new']);
});
test('legacy groups remain readable and allow explicitly setting a root without changing membership', t => {
 const {e,store}=fixture(t);const legacy={id:'legacy',name:'Existing',sessionIds:['a','archived']};
 fs.writeFileSync(path.join(e.dir,'projects.json'),JSON.stringify([legacy]));
 assert.equal(store.list()[0].cwd,undefined);
 store.update({action:'edit',id:'legacy',name:'Existing',cwd:e.dir},()=>false);
 assert.equal(store.list()[0].cwd,e.dir);assert.deepEqual([...store.list()[0].sessionIds],legacy.sessionIds);
});

test('an unchanged unavailable root does not block project metadata or membership edits', t => {
 const {e,store}=fixture(t),root=path.join(e.dir,'removable');fs.mkdirSync(root);
 const p=store.update({action:'create',name:'Project',cwd:root},()=>true)[0];fs.rmdirSync(root);
 store.update({action:'edit',id:p.id,name:'Renamed',cwd:root,add:['a']},()=>true);
 assert.equal(store.list()[0].name,'Renamed');assert.equal(store.list()[0].cwd,root);assert.deepEqual([...store.list()[0].sessionIds],['a']);
});
