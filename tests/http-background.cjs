const test=require('node:test'),assert=require('node:assert/strict'),{once}=require('node:events');
const {env,Bridge,fs,path,root}=require('./harness.cjs');
for(const memory of [true,false])test(`real HTTP host creates one dedicated conversation, scopes history and isolates remote confirmations (memory=${memory})`,{timeout:15000},async t=>{
 const modules={},e=env({modules,globals:{setTimeout,clearTimeout,setInterval,clearInterval,Date}});process.env.AGENT_SH_HOME=e.dir;
 const installed=await import('../dist/extensions/installed.js');
 const catalog=e.load('src/plugins.ts'),readCatalog=catalog.pluginCatalog;
 let catalogReads=0,boundServices,foreignServices;
 catalog.pluginCatalog=(...args)=>{catalogReads++;return readCatalog(...args);};
 modules['./extensions/installed.js']={...installed,installedApplicationDefinitions:(file,options)=>installed.installedApplicationDefinitions(file,{...options,bindServices:(id,context,manifest)=>{
  const readsBeforeBinding=catalogReads;
  const services=options.bindServices(id,context,manifest);
  assert.equal(catalogReads,readsBeforeBinding,'application service binding uses the discovered manifest');
  if(manifest.id==='ashub-personal-assistant')boundServices=services;
  if(manifest.id==='unrelated-plugin')foreignServices=services;
  return services;
 }})};
 const target=path.join(e.dir,'extensions','personal-assistant');fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(path.join(root,'examples/extensions/personal-assistant'),target,{recursive:true});
 const unrelated=path.join(e.dir,'extensions','unrelated-plugin');fs.mkdirSync(unrelated);
 fs.writeFileSync(path.join(unrelated,'package.json'),JSON.stringify({name:'unrelated-plugin',version:'1.0.0',type:'module'}));
 fs.writeFileSync(path.join(unrelated,'ashub-plugin.json'),JSON.stringify({schemaVersion:2,id:'unrelated-plugin',entries:{application:'app.mjs'}}));
 fs.writeFileSync(path.join(unrelated,'app.mjs'),'export function activate() {}');
 const settings=path.join(e.dir,'settings.json');
 const pluginId=catalog.pluginCatalog(settings).find(p=>p.manifest?.id==='ashub-personal-assistant').id;
 catalog.setPluginEnabled(settings,pluginId,true);
 const loaded=[];let inference=0;
 const projectFile=path.join(e.dir,'hub-sessions','projects.json');
 fs.mkdirSync(path.dirname(projectFile),{recursive:true});
 fs.writeFileSync(projectFile,JSON.stringify([{id:'legacy',name:'原项目名',sessionIds:[]}]));
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:options=>{
  const bound=options.pluginConversation?.(pluginId,['assistant'])===true;loaded.push({id:options.sessionId,bound});
  const b=new Bridge(options);b.getPluginStatus=()=>bound?[{id:pluginId,name:'个人助手',state:'loaded'}]:[];b.backgroundComplete=async()=>{inference++;return '{}';};setTimeout(()=>b.emit('event',{name:'agent:info',payload:{model:'tiny',provider:'mock'}}),0);return b;
 }});
 if(!hub.server.listening)await once(hub.server,'listening');const base='http://127.0.0.1:'+hub.server.address().port;
 const api=async(route,body)=>{const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:base},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 try{
  assert(Number.isSafeInteger(JSON.parse(fs.readFileSync(projectFile,'utf8'))[0].nameSince),'startup persists the first observation');
  await new Promise(r=>setTimeout(r,5));
  assert.equal((await api('/api/projects',{action:'rename',id:'legacy',name:'现项目名'})).status,200);
  assert.equal('nameHistory' in (await api('/api/host/snapshot')).body.projects[0],false);
  const ordinaryRoot=path.join(e.dir,'ordinary');fs.mkdirSync(ordinaryRoot);
  const ordinary=(await api('/sessions',{cwd:ordinaryRoot,kind:'agent',provider:'mock',model:'tiny'})).body.instanceId;
  let feature;for(let i=0;i<150;i++){feature=(await api('/api/extensions')).body.features.find(f=>f.name==='个人助手');if(feature?.state==='active'&&foreignServices)break;await new Promise(r=>setTimeout(r,20));}assert.equal(feature?.state,'active',JSON.stringify(feature));assert(foreignServices,'the unrelated application plugin is active too');
  const resource='/api/plugin-resources/'+feature.pluginId+'/assistant';
  assert.equal((await api('/api/plugin-conversations')).body[0].sessionId,null);
  const draft=await api(resource,{action:'create-assistant',values:{model:JSON.stringify({provider:'mock',model:'tiny'}),memory}});assert.equal(draft.status,200,JSON.stringify(draft));assert(draft.body.confirmation);
  const [a,b]=await Promise.all([api(resource,{confirm:draft.body.confirmation.id}),api(resource,{confirm:draft.body.confirmation.id})]);assert.equal(a.status,200,JSON.stringify(a));assert.equal(b.status,200);assert.equal(a.body.view.actions.some(a=>a.id==='pause'),memory,'creation respects the memory opt-in');assert.equal(a.body.view.form,undefined);
  const entries=(await api('/api/plugin-conversations')).body;assert.equal(entries.length,1);const sid=entries[0].sessionId;assert.notEqual(sid,ordinary);assert.equal((await api('/sessions')).body.length,2);
  const [{SharedConversations},{DevicePublisher}]=await Promise.all([
   import('../dist/extensions/shared-conversations.js'),import('../examples/extensions/multi-machine/publisher.mjs'),
  ]);
  const sharing=new SharedConversations(path.join(e.dir,'fixture-sharing.json'));
  sharing.start(hub.server.address().port);
  const owner=new AbortController();
  t.after(()=>owner.abort());
  const service=sharing.bind('fixture-device-interconnect',owner.signal);
  const publisherFor=roots=>{
   const plan=sharing.prepare('fixture-device-interconnect',{roots});
   const grantId=sharing.approve('fixture-device-interconnect',plan);
   const publisher=new DevicePublisher({dataDir:e.dir,access:id=>service.open(id)});
   publisher.config={enabled:true,roots:plan.roots,grantId};
   publisher.access=service.open(grantId);
   return publisher;
  };
  const fullPublisher=publisherFor([e.dir]), limitedPublisher=publisherFor([ordinaryRoot]);
  const remoteEntries=entries.map(({setupResource,...entry})=>entry);
  assert.equal((await api('/'+ordinary+'/title',{title:'个人助手'})).status,200);
  assert.equal((await fullPublisher.execute('sessions',{})).filter(row=>row.title==='个人助手').length,2);
  assert.deepEqual(await fullPublisher.execute('plugin-entries',{}),remoteEntries,'the registered entry distinguishes two chats with the same title');
  assert.deepEqual((await limitedPublisher.execute('sessions',{})).map(row=>row.instanceId),[ordinary]);
  assert.deepEqual(await limitedPublisher.execute('plugin-entries',{}),[],'an assistant outside sharing scope has no remote entry');
  const legacyPublisher=new DevicePublisher({dataDir:e.dir});
  legacyPublisher.localUrl=base;
  legacyPublisher.config={enabled:true,roots:[fs.realpathSync(e.dir)]};
  assert.deepEqual(await legacyPublisher.execute('plugin-entries',{}),remoteEntries,'direct compatibility publisher returns the same catalog');
  legacyPublisher.config.roots=[fs.realpathSync(ordinaryRoot)];
  assert.deepEqual(await legacyPublisher.execute('plugin-entries',{}),[]);
  assert.deepEqual(loaded,[{id:ordinary,bound:false},{id:sid,bound:true}]);
  assert.deepEqual((await api('/api/plugins')).body.plugins.find(p=>p.id===pluginId).sessions.map(s=>s.sessionId),[sid]);
  await new Promise(r=>setTimeout(r,30));const auth=await api(resource,{action:'authorize',values:{}});assert.equal(auth.status,200,JSON.stringify(auth));assert.equal(auth.body.confirmation.preview.fields.length,3);assert.match(auth.body.confirmation.preview.fields[0].value,/仅处理「个人助手」对话.*不读取其他对话/);assert.deepEqual(auth.body.confirmation.preview.details.map(f=>f.label),['单次请求上限']);assert(!JSON.stringify(auth.body.confirmation.preview).includes(sid));
  assert.equal((await api(resource+'?remoteSession='+sid,{confirm:auth.body.confirmation.id})).status,409);
  assert.equal((await api(resource,{confirm:auth.body.confirmation.id})).status,200);
  const grantFile=path.join(e.dir,'hub-sessions','background-grants.json');
  const grant=JSON.parse(fs.readFileSync(grantFile,'utf8')).grants[0].id;
  assert.equal('nameHistory' in boundServices.host.snapshot().projects[0],false);
  const projectFacts=boundServices.host.projectNameHistory('assistant',sid,grant);
  assert.equal(projectFacts.projects[0].nameHistory[0].name,'原项目名');
  assert.deepEqual(Object.keys(projectFacts.projects[0]).sort(),['id','name','nameHistory','nameSince']);
  assert.throws(()=>boundServices.host.projectNameHistory('assistant',ordinary,grant));
  assert.throws(()=>boundServices.host.projectNameHistory('other',sid,grant));
  assert.equal(foreignServices.host,undefined,'unrelated installed extensions receive only the original public host service');
  const pilot=await api(resource,{action:'enable-theme-overviews',values:{}});
  assert.equal(pilot.status,200);assert(pilot.body.confirmation);
  assert.equal((await api(resource+'?remoteSession='+sid,{confirm:pilot.body.confirmation.id})).status,409);
  assert.equal((await api(resource,{confirm:pilot.body.confirmation.id})).status,200);
  assert((await api(resource)).body.view.actions.some(a=>a.id==='disable-theme-overviews'));
  const remote=await api(resource+'?remoteSession='+sid);assert.equal(remote.status,200);assert.equal(remote.body.view.rows.length,0);assert.equal(remote.body.view.form,undefined);
  assert.deepEqual(remote.body.view.actions.map(a=>a.id),['pause']);
  assert.equal((await api(resource+'?remoteSession='+ordinary)).status,409);
  const memories=await api(resource+'?remoteSession='+sid,{action:'memories',values:{}});assert.equal(memories.status,409);
  const pause=await api(resource+'?remoteSession='+sid,{action:'pause',values:{}});assert.equal(pause.status,200);assert.equal(pause.body.confirmation,undefined);assert.match(pause.body.view.note,/长期记忆已关闭/);
  assert.throws(()=>boundServices.host.projectNameHistory('assistant',sid,grant));
  const off=await api(resource+'?remoteSession='+sid);assert.deepEqual(off.body.view.actions,[]);assert.equal((await api(resource+'?remoteSession='+sid,{action:'authorize',values:{}})).status,409);
  assert.match((await api(resource)).body.view.note,/关闭/);assert.equal(inference,0);
  const reauthorize=await api(resource,{action:'authorize',values:{}});
  assert.equal((await api(resource,{confirm:reauthorize.body.confirmation.id})).status,200);
  assert((await api(resource)).body.view.actions.some(a=>a.id==='enable-theme-overviews'),'pause clears the separate pilot opt-in');
  const featureRoute='/api/extensions/'+feature.id+'/enabled';
  await api(featureRoute,{enabled:false});
  assert.deepEqual(await fullPublisher.execute('plugin-entries',{}),[],'disabling the assistant removes its dedicated entry');
  assert((await fullPublisher.execute('sessions',{})).some(row=>row.instanceId===sid),'a former plugin conversation is still an authorized conversation');
  await api(featureRoute,{enabled:true});
  assert.deepEqual(await fullPublisher.execute('plugin-entries',{}),remoteEntries);
  service.revoke(fullPublisher.config.grantId);
  await assert.rejects(fullPublisher.execute('plugin-entries',{}),'a revoked channel cannot return the catalog');
 }finally{await hub.shutdown();}
});


test('fresh and lazily restored kernels receive the same session-bound plugin gate',async()=>{
 const e=env(),h=e.hub(),sessions=new Map(),owner='aa0011223344',other='bb0011223344',calls=[];
 const opts={pluginConversation:(id,plugin,keys)=>id===owner&&plugin==='plugin'&&keys.includes('assistant'),makeBridge:o=>{
  calls.push({id:o.sessionId,allowed:o.pluginConversation('plugin',['assistant']),otherPlugin:o.pluginConversation('other',['assistant']),otherEntry:o.pluginConversation('plugin',['other'])});return new Bridge(o);
 }};
 try{
  for(const id of [owner,other])await h.createSession(sessions,opts,e.dir,undefined,'agent',{instanceId:id});
  const expected=[{id:owner,allowed:true,otherPlugin:false,otherEntry:false},{id:other,allowed:false,otherPlugin:false,otherEntry:false}];assert.deepEqual(calls,expected);
  await h.shutdownHub(undefined,sessions);calls.length=0;
  for(const id of [owner,other]){
   const s=await h.createSession(sessions,opts,e.dir,{id,title:'same title',startedAt:1,replay:[]});assert.equal(s.bridge,null);await s._ensureBridge();
  }
  assert.deepEqual(calls,expected);
 }finally{await h.shutdownHub(undefined,sessions);}
});

test('the Hub keeps a durable foreground model revision across A to B to A and restart', {timeout:15000}, async t=>{
 const {pathToFileURL}=require('node:url');
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-24T04:00:00Z')});
 const modules={},e=env({modules,globals:{setTimeout,clearTimeout,setInterval,clearInterval,Date}});
 process.env.AGENT_SH_HOME=e.dir;
 modules['./extensions/installed.js']=await import('../dist/extensions/installed.js');
 const target=path.join(e.dir,'extensions','personal-assistant');
 fs.cpSync(path.join(root,'examples/extensions/personal-assistant'),target,{recursive:true});
 const {current}=await import(pathToFileURL(path.join(target,'shared.mjs')).href);
 const {pluginDataDirectory}=await import('../dist/extensions/data-directory.js');
 const settingsFile=path.join(e.dir,'settings.json');
 const grantFile=path.join(e.dir,'hub-sessions','background-grants.json');
 const source='我的职业是一名大学教师';
 const received=[];let title='旧模型整理结果';
 const options={host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:options=>{
  const bridge=new Bridge(options);
  bridge.ready=async()=>{bridge.emit('event',{name:'agent:info',payload:{model:options.model,provider:options.provider}});};
  bridge.getModels=async()=>({models:[{model:'model-a',provider:'provider-a'},{model:'model-b',provider:'provider-b'}]});
  bridge.execCommand=(command,target)=>{
   assert.equal(command,'/model');
   const [model,provider]=target.split('@');bridge.emit('event',{name:'agent:info',payload:{model,provider}});
  };
  bridge.backgroundComplete=async(messages,_signal,model)=>{
   received.push({...model});
   const record=JSON.parse(messages[1].content).records.find(row=>row.text===source);assert(record);
   return JSON.stringify({memories:[{title,content:'用户是一名大学教师',kind:'fact',scope:'personal',subject:'user',certainty:'explicit',topic:'occupation-test',aliases:[],evidence:[{id:record.id,quote:record.text}]}]});
  };
  return bridge;
 }};
 let hub,base;
 const start=async()=>{
  hub=e.hub().startHub(options);
  if(!hub.server.listening)await once(hub.server,'listening');
  base='http://127.0.0.1:'+hub.server.address().port;
 };
 const api=async(route,body,method=body?'POST':'GET')=>{
  const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',Origin:base},body:body?JSON.stringify(body):undefined});
  const raw=await response.text();assert.equal(response.status,200,raw);return JSON.parse(raw);
 };
 const wait=async fn=>{
  for(let i=0;i<150;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,15));}
  throw Error('Timed out waiting for the dedicated assistant');
 };
 const feature=()=>wait(async()=>(await api('/api/extensions')).features.find(row=>row.name==='个人助手'&&row.state==='active'));
 const diskGrant=()=>JSON.parse(fs.readFileSync(grantFile,'utf8')).grants[0];
 const modelA={model:'model-a',provider:'provider-a'},modelB={model:'model-b',provider:'provider-b'};
 try{
  await start();const installed=await feature();
  const ordinary=await api('/sessions',{cwd:e.dir,kind:'agent',...modelA});
  const resource='/api/plugin-resources/'+installed.pluginId+'/assistant';
  const setup=await api(resource,{action:'create-assistant',values:{model:JSON.stringify(modelA),memory:true}});
  await api(resource,{confirm:setup.confirmation.id});
  const [{sessionId:id}]=await api('/api/plugin-conversations');assert(id);
  const dataDirectory=pluginDataDirectory(settingsFile,installed.pluginId),first=current(dataDirectory);assert(first);
  await api('/'+id+'/submit',{query:source});
  const record=await wait(()=>first.services.background.read(diskGrant().id,id).entries.find(row=>row.text===source));
  t.mock.timers.tick(120000);
  first.store.learn=()=>{throw Error('SQLITE_BUSY before saving memory');};
  await first.learning.tick();
  assert(first.store.state('learning-result:'+id));assert.equal(first.store.activeMemories().length,0);
  const cursor=first.store.state('scan:'+id)?.cursor??null;
  assert.notEqual(cursor,record.id,'a failed write does not advance the learning cursor');
  const original=diskGrant();assert.equal(original.calls,1);
  await api('/'+ordinary.instanceId+'/model',modelB,'PUT');
  assert.equal(diskGrant().modelRevision??0,original.modelRevision??0,'another conversation does not change the assistant revision');
  await api('/'+id+'/model',modelB,'PUT');assert.equal(diskGrant().modelRevision,(original.modelRevision??0)+1);
  await api('/'+id+'/model',modelA,'PUT');assert.equal(diskGrant().modelRevision,(original.modelRevision??0)+2);
  await api('/'+id+'/model',modelA,'PUT');assert.equal(diskGrant().modelRevision,(original.modelRevision??0)+2,'the same model does not advance the revision');
  await hub.shutdown();await start();await feature();
  await wait(async()=>(await api('/api/plugin-conversations')).some(row=>row.sessionId===id));
  const restored=current(dataDirectory);assert(restored);assert.notEqual(restored,first);
  const stamp=restored.services.background.status(original.id);
  assert.equal(stamp.modelRevision,(original.modelRevision??0)+2);
  assert.deepEqual(Array.from(stamp.includedIds),[id]);assert.equal(stamp.since,original.since);assert.equal(stamp.calls,1);
  assert.equal(restored.store.state('scan:'+id)?.cursor??null,cursor);
  title='重启后重新整理的结果';t.mock.timers.tick(61000);await restored.learning.tick();
  assert.deepEqual(restored.store.activeMemories().map(row=>row.title),[title],restored.learning.error);
  assert.equal(restored.store.state('scan:'+id)?.cursor,record.id);
  assert.deepEqual(received,[modelA,modelA]);assert.equal(diskGrant().calls,2);
 }finally{await hub?.shutdown();}
});
