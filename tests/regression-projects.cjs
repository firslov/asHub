const test = require('node:test');
const assert = require('node:assert/strict');
const {env, Bridge, fs, path} = require('./harness.cjs');
const tick = () => new Promise(r => setImmediate(r));
function fixture(t, sessions) {
  const e = env();
  t.after(async () => {
    // Delivery receipts can arrive before the Hub finishes writing replay and metadata.
    if (sessions) await e.load('src/hub.ts').shutdownHub(undefined, sessions);
    fs.rmSync(e.dir, {recursive:true, force:true});
  });
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
test('project pins persist separately, support retries and are cleared on membership changes', t => {
  const {e,store,ProjectStore} = fixture(t);
  const [a] = store.update({action:'create',cwd:e.dir,name:'A',add:['a','b','c']},()=>true);
  const [,b] = store.update({action:'create',cwd:e.dir,name:'B'},()=>true);
  const pin = (group,id,pinned) => store.update({action:'pin',id:group.id,sessionId:id,pinned},()=>true);
  pin(a,'a',true); pin(a,'b',true); pin(a,'a',true);
  const read = () => JSON.parse(JSON.stringify(new ProjectStore(path.join(e.dir,'projects.json')).list()));
  assert.deepEqual(read()[0].pinnedSessionIds,['b','a']);
  assert.throws(()=>pin(b,'a',true));
  assert.throws(()=>pin(a,'c','yes'));
  store.update({action:'members',id:b.id,add:['b']},()=>true);
  assert.deepEqual(read()[0].pinnedSessionIds,['a']);
  assert.deepEqual(read()[1].pinnedSessionIds ?? [],[]);
  pin(a,'a',false); pin(b,'b',true);
  store.update({action:'members',id:b.id,remove:['b']},()=>true);
  assert.deepEqual(read().map(p=>p.pinnedSessionIds),[[],[]]);
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
  const sessions = new Map();
  const {e,store} = fixture(t, sessions);
  const {createSession, conversationAccess} = e.load('src/hub.ts','export { createSession, conversationAccess };');
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

test('legacy project name observation is durable; a later same-name project cannot claim earlier evidence', t => {
  const {e,store,ProjectStore}=fixture(t), file=path.join(e.dir,'projects.json');
  const raw=JSON.stringify([{id:'legacy',name:'行星',sessionIds:[]}]);
  fs.writeFileSync(file,raw);
  e.clock(1000);
  assert.equal(store.list()[0].name,'行星');
  assert.equal(fs.readFileSync(file,'utf8'),raw,'ordinary public reads leave the legacy file untouched');
  assert.equal(store.nameHistory().projects[0].nameSince,1000);
  const evidenceAt=1500;
  e.clock(2000);
  const restarted=new ProjectStore(file);
  assert(restarted.nameHistory().projects[0].nameSince<evidenceAt,'startup observation survives restart without project edits');
  restarted.update({action:'rename',id:'legacy',name:'银河'},()=>true);
  const [,reuse]=restarted.update({action:'create',cwd:e.dir,name:'行星'},()=>true);
  const [prior,newProject]=new ProjectStore(file).nameHistory().projects;
  assert.deepEqual(JSON.parse(JSON.stringify(prior.nameHistory)),[{name:'行星',from:1000,to:2000}]);
  assert(prior.nameHistory[0].from<evidenceAt&&evidenceAt<prior.nameHistory[0].to);
  assert.equal(newProject.id,reuse.id);
  assert(newProject.nameSince>evidenceAt);
  for(const project of restarted.list())for(const key of ['nameHistory','nameSince','nameObserved'])assert(!(key in project));
});

test('simultaneous names remain visible as separate candidates and an old rename cannot inherit a stale interval', t => {
  const {e,store}=fixture(t), file=path.join(e.dir,'projects.json');
  e.clock(1000);
  const [first]=store.update({action:'create',cwd:e.dir,name:'行星'},()=>true);
  e.clock(1100);
  const [,second]=store.update({action:'create',cwd:e.dir,name:'行星'},()=>true);
  e.clock(1200);
  assert.deepEqual([...store.nameHistory().projects].filter(p=>p.name==='行星'&&p.nameSince<1200).map(p=>p.id),[first.id,second.id]);
  store.update({action:'rename',id:first.id,name:'银河'},()=>true);
  const oldClient=JSON.parse(fs.readFileSync(file,'utf8'));
  oldClient[0].name='行星';
  fs.writeFileSync(file,JSON.stringify(oldClient));
  e.clock(1300);
  const {projects:[corrected],gaps}=store.nameHistory();
  assert.equal(corrected.nameSince,1300);
  assert.equal(corrected.nameHistory.length,0);
  assert.equal(corrected.name,'行星');
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)),[{from:1000,to:1300}]);
});

test('a deleted project leaves a name-free coverage gap without modifying other name facts', t => {
  const {e,store,ProjectStore}=fixture(t), file=path.join(e.dir,'projects.json');
  e.clock(1000);
  const [remaining]=store.update({action:'create',cwd:e.dir,name:'A号'},()=>true);
  e.clock(1100);
  const [,removed]=store.update({action:'create',cwd:e.dir,name:'Ａ号'},()=>true);
  const [,,unrelated]=store.update({action:'create',cwd:e.dir,name:'北辰'},()=>true);
  e.clock(1500);
  store.update({action:'delete',id:removed.id},()=>true);
  e.clock(2000);
  const {projects,gaps}=new ProjectStore(file).nameHistory();
  const survivor=projects.find(p=>p.id===remaining.id);
  assert.equal(survivor.nameSince,1000);
  assert.equal(survivor.nameHistory.length,0);
  assert.equal(projects.find(p=>p.id===unrelated.id).nameSince,1100);
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)),[{from:1100,to:1500}]);
  for(const data of [fs.readFileSync(file,'utf8'),fs.readFileSync(file+'.name-coverage','utf8')]) {
    assert(!data.includes('Ａ号'));
    assert(!data.includes(removed.id));
  }
});

test('a deletion made by a legacy writer leaves a name-free gap after restart', t => {
  const {e,store,ProjectStore}=fixture(t), file=path.join(e.dir,'projects.json');
  e.clock(1000);
  const [remaining]=store.update({action:'create',cwd:e.dir,name:'乙'},()=>true);
  e.clock(1100);
  const [,removed]=store.update({action:'create',cwd:e.dir,name:'乙'},()=>true);
  e.clock(1200);
  store.update({action:'rename',id:removed.id,name:'旧独有名'},()=>true);
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,JSON.stringify(raw.filter(p=>p.id!==removed.id)));
  e.clock(1500);
  const history=new ProjectStore(file).nameHistory();
  assert.equal(history.projects[0].id,remaining.id);
  assert.deepEqual(JSON.parse(JSON.stringify(history.gaps)),[{from:1100,to:1500}]);
  const coverage=fs.readFileSync(file+'.name-coverage','utf8');
  assert(!coverage.includes(removed.id));
  assert(!coverage.includes('旧独有名'));
  assert.deepEqual(new ProjectStore(file).nameHistory().gaps,history.gaps);
});

test('an unsuccessful project commit retains the observation until a later legacy deletion', t => {
  const {e,store,ProjectStore}=fixture(t), file=path.join(e.dir,'projects.json');
  e.clock(1000);
  store.update({action:'create',cwd:e.dir,name:'乙'},()=>true);
  e.clock(1100);
  const [,removed]=store.update({action:'create',cwd:e.dir,name:'乙'},()=>true);
  e.clock(1200);
  const rename=fs.renameSync;
  const fault=t.mock.method(fs,'renameSync',(from,to)=>{
    if(to===file) throw Object.assign(Error('project commit failed'),{code:'EPERM'});
    return rename(from,to);
  });
  assert.throws(()=>store.update({action:'delete',id:removed.id},()=>true),/project commit failed/);
  fault.mock.restore();
  assert(store.list().some(p=>p.id===removed.id));
  const legacy=JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,JSON.stringify(legacy.filter(p=>p.id!==removed.id)));
  e.clock(1500);
  assert.deepEqual(JSON.parse(JSON.stringify(new ProjectStore(file).nameHistory().gaps)),[{from:1100,to:1500}]);
});

test('loss of an initialized coverage file cannot reattribute old evidence',t=>{
  const {e,store,ProjectStore}=fixture(t), file=path.join(e.dir,'projects.json');
  e.clock(1000);
  store.update({action:'create',cwd:e.dir,name:'乙'},()=>true);
  fs.unlinkSync(file+'.name-coverage');
  e.clock(1500);
  assert.deepEqual(JSON.parse(JSON.stringify(store.nameHistory().gaps)),[{from:0,to:1500}]);
  e.clock(1800);
  assert.deepEqual(JSON.parse(JSON.stringify(new ProjectStore(file).nameHistory().gaps)),[{from:0,to:1500}]);
});

test('a same-millisecond rename leaves its boundary ambiguous',t=>{
  const {e,store}=fixture(t);
  e.clock(1000);
  store.update({action:'create',cwd:e.dir,name:'乙'},()=>true);
  e.clock(1200);
  const [,renamed]=store.update({action:'create',cwd:e.dir,name:'乙'},()=>true);
  store.update({action:'rename',id:renamed.id,name:'甲'},()=>true);
  assert.deepEqual(JSON.parse(JSON.stringify(store.nameHistory().gaps)),[{from:1200,to:1200}]);
});

test('corrupt name coverage is rebuilt conservatively during a project deletion',t=>{
  const {e,store,ProjectStore}=fixture(t), file=path.join(e.dir,'projects.json');
  e.clock(1000);
  const [removed]=store.update({action:'create',cwd:e.dir,name:'旧项目'},()=>true);
  const [,remaining]=store.update({action:'create',cwd:e.dir,name:'保留项目'},()=>true);
  fs.writeFileSync(file+'.name-coverage','{ invalid');
  e.clock(1500);
  assert.deepEqual([...store.update({action:'delete',id:removed.id},()=>true)].map(p=>p.id),[remaining.id]);
  const history=new ProjectStore(file).nameHistory();
  assert.deepEqual(JSON.parse(JSON.stringify(history.gaps)),[{from:0,to:1500}]);
  assert(!JSON.stringify(history).includes('旧项目'));
});

test('evicting a bounded historical alias records its original time range without rewriting names', t => {
  const {e,store}=fixture(t);
  e.clock(1000);
  const [old]=store.update({action:'create',cwd:e.dir,name:'海鸥'},()=>true);
  e.clock(1100);
  const [,matching]=store.update({action:'create',cwd:e.dir,name:'海鸥'},()=>true);
  for(let i=0;i<17;i++) {
    e.clock(1200+i*100);
    store.update({action:'rename',id:old.id,name:`海鸥 ${i}`},()=>true);
  }
  const {projects:names,gaps}=store.nameHistory();
  assert.equal(names.find(p=>p.id===old.id).nameHistory.length,16);
  assert.equal(names.find(p=>p.id===matching.id).nameSince,1100);
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)),[{from:1000,to:1200}]);
});

test('an unchanged unavailable root does not block project metadata or membership edits', t => {
 const {e,store}=fixture(t),root=path.join(e.dir,'removable');fs.mkdirSync(root);
 const p=store.update({action:'create',name:'Project',cwd:root},()=>true)[0];fs.rmdirSync(root);
 store.update({action:'edit',id:p.id,name:'Renamed',cwd:root,add:['a']},()=>true);
 assert.equal(store.list()[0].name,'Renamed');assert.equal(store.list()[0].cwd,root);assert.deepEqual([...store.list()[0].sessionIds],['a']);
});

test('membership changes saved by an earlier desktop version do not invalidate projects with pins', t => {
 const {e,store} = fixture(t);
 const [a] = store.update({action:'create',cwd:e.dir,name:'A',add:['moved','kept']},()=>true);
 const [,b] = store.update({action:'create',cwd:e.dir,name:'B'},()=>true);
 store.update({action:'pin',id:a.id,sessionId:'kept',pinned:true},()=>true);
 store.update({action:'pin',id:a.id,sessionId:'moved',pinned:true},()=>true);
 const file=path.join(e.dir,'projects.json');
 const oldClient=JSON.parse(fs.readFileSync(file,'utf8'));
 oldClient[0].sessionIds=['kept'];oldClient[1].sessionIds=['moved'];
 fs.writeFileSync(file,JSON.stringify(oldClient));
 const groups=JSON.parse(JSON.stringify(store.list()));
 assert.deepEqual(groups[0].pinnedSessionIds,['kept']);
 assert.deepEqual(groups[1].pinnedSessionIds ?? [],[]);
 store.update({action:'pin',id:b.id,sessionId:'moved',pinned:true},()=>true);
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).map(p=>p.pinnedSessionIds),[['kept'],['moved']]);
});

test('legacy rename preserves surviving name facts and records the unverified window', t => {
  const {e,store,ProjectStore}=fixture(t), file=path.join(e.dir,'projects.json');
  e.clock(1000);const [first]=store.update({action:'create',cwd:e.dir,name:'同名'},()=>true);
  e.clock(1100);const [,second]=store.update({action:'create',cwd:e.dir,name:'同名'},()=>true);
  const [,,unrelated]=store.update({action:'create',cwd:e.dir,name:'不相关'},()=>true);
  const legacy=JSON.parse(fs.readFileSync(file,'utf8'));legacy[1].name='旧客户端新名';fs.writeFileSync(file,JSON.stringify(legacy));
  e.clock(1500);const {projects:rows,gaps}=new ProjectStore(file).nameHistory();
  const survivor=rows.find(p=>p.id===first.id),renamed=rows.find(p=>p.id===second.id);
  assert.equal(survivor.nameSince,1000);
  assert.equal(survivor.nameHistory.length,0);
  assert.equal(rows.find(p=>p.id===unrelated.id).nameSince,1100);
  assert.equal(renamed.nameSince,1500);assert.equal(renamed.name,'旧客户端新名');
  assert.deepEqual(JSON.parse(JSON.stringify(gaps)),[{from:1100,to:1500}]);
  assert.deepEqual(new ProjectStore(file).nameHistory().gaps,gaps);
});
