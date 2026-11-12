const test=require('node:test'),assert=require('node:assert/strict'),{once}=require('node:events');
const {env,Bridge,fs,path,root}=require('./harness.cjs');
for(const memory of [true,false])test(`real HTTP host creates one dedicated conversation, scopes history and isolates remote confirmations (memory=${memory})`,{timeout:15000},async()=>{
 const modules={},e=env({modules,globals:{setTimeout,clearTimeout,setInterval,clearInterval,Date}});process.env.AGENT_SH_HOME=e.dir;
 modules['./extensions/installed.js']=await import('../dist/extensions/installed.js');
 const target=path.join(e.dir,'extensions','personal-assistant');fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(path.join(root,'examples/extensions/personal-assistant'),target,{recursive:true});
 const pluginId=e.load('src/plugins.ts').pluginCatalog(path.join(e.dir,'settings.json')).find(p=>p.manifest?.id==='ashub-personal-assistant').id;
 const loaded=[];let inference=0;
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:options=>{
  const bound=options.pluginConversation?.(pluginId,['assistant'])===true;loaded.push({id:options.sessionId,bound});
  const b=new Bridge(options);b.getPluginStatus=()=>bound?[{id:pluginId,name:'个人助手',state:'loaded'}]:[];b.backgroundComplete=async()=>{inference++;return '{}';};setTimeout(()=>b.emit('event',{name:'agent:info',payload:{model:'tiny',provider:'mock'}}),0);return b;
 }});
 if(!hub.server.listening)await once(hub.server,'listening');const base='http://127.0.0.1:'+hub.server.address().port;
 const api=async(route,body)=>{const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:base},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 try{
  const ordinary=(await api('/sessions',{cwd:e.dir,kind:'agent',provider:'mock',model:'tiny'})).body.instanceId;
  let feature;for(let i=0;i<150;i++){feature=(await api('/api/extensions')).body.features.find(f=>f.name==='个人助手');if(feature?.state==='active')break;await new Promise(r=>setTimeout(r,20));}assert.equal(feature?.state,'active',JSON.stringify(feature));
  const resource='/api/plugin-resources/'+feature.pluginId+'/assistant';
  assert.equal((await api('/api/plugin-conversations')).body[0].sessionId,null);
  const draft=await api(resource,{action:'create-assistant',values:{model:JSON.stringify({provider:'mock',model:'tiny'}),memory}});assert.equal(draft.status,200,JSON.stringify(draft));assert(draft.body.confirmation);
  const [a,b]=await Promise.all([api(resource,{confirm:draft.body.confirmation.id}),api(resource,{confirm:draft.body.confirmation.id})]);assert.equal(a.status,200,JSON.stringify(a));assert.equal(b.status,200);assert.equal(a.body.view.actions.some(a=>a.id==='pause'),memory,'creation respects the memory opt-in');assert.equal(a.body.view.form,undefined);
  const entries=(await api('/api/plugin-conversations')).body;assert.equal(entries.length,1);const sid=entries[0].sessionId;assert.notEqual(sid,ordinary);assert.equal((await api('/sessions')).body.length,2);
  assert.deepEqual(loaded,[{id:ordinary,bound:false},{id:sid,bound:true}]);
  assert.deepEqual((await api('/api/plugins')).body.plugins.find(p=>p.id===pluginId).sessions.map(s=>s.sessionId),[sid]);
  await new Promise(r=>setTimeout(r,30));const auth=await api(resource,{action:'authorize',values:{}});assert.equal(auth.status,200,JSON.stringify(auth));assert.equal(auth.body.confirmation.preview.fields.length,3);assert.match(auth.body.confirmation.preview.fields[0].value,/仅处理「个人助手」对话.*不读取其他对话/);assert.deepEqual(auth.body.confirmation.preview.details.map(f=>f.label),['单次请求上限']);assert(!JSON.stringify(auth.body.confirmation.preview).includes(sid));
  assert.equal((await api(resource+'?remoteSession='+sid,{confirm:auth.body.confirmation.id})).status,409);
  assert.equal((await api(resource,{confirm:auth.body.confirmation.id})).status,200);
  const remote=await api(resource+'?remoteSession='+sid);assert.equal(remote.status,200);assert.equal(remote.body.view.rows.length,0);assert.equal(remote.body.view.form,undefined);
  assert.equal((await api(resource+'?remoteSession='+ordinary)).status,409);
  const memories=await api(resource+'?remoteSession='+sid,{action:'memories',values:{}});assert.equal(memories.status,409);
  const pause=await api(resource+'?remoteSession='+sid,{action:'pause',values:{}});assert.equal(pause.status,200);assert.equal(pause.body.confirmation,undefined);assert.equal(pause.body.view.toggle.checked,false);
  const off=await api(resource+'?remoteSession='+sid);assert.equal(off.body.view.toggle.checked,false);assert.deepEqual(off.body.view.actions,[]);assert.equal((await api(resource+'?remoteSession='+sid,{action:'authorize',values:{}})).status,409);
  assert.match((await api(resource)).body.view.note,/关闭/);assert.equal(inference,0);
  const featureRoute='/api/extensions/'+feature.id+'/enabled';await api(featureRoute,{enabled:false});assert.equal((await api('/api/plugin-conversations')).body.length,0);await api(featureRoute,{enabled:true});assert.equal((await api('/api/plugin-conversations')).body[0].sessionId,sid);
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
