// Deployment-side compatibility test: unchanged gateway + unchanged desktop RPC.
const {env,Bridge,path,root}=require('../tests/harness.cjs');
const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const {once}=require('node:events');
(async()=>{
 process.env.NODE_ENV='test';const {createGateway}=await import('./server.mjs'),{BackendConnections}=await import('../dist/extensions/backends.js'),{RemoteAccount}=await import('../examples/extensions/multi-machine/client.mjs');
 const e=env({globals:{fetch,WebSocket,setTimeout,clearTimeout,setInterval,clearInterval,Response,ReadableStream}}),gateway=createGateway({database:path.join(e.dir,'gateway.sqlite'),publicUrl:'http://127.0.0.1/mobile/',testing:true});gateway.server.listen(0,'127.0.0.1');await once(gateway.server,'listening');const remote=`http://127.0.0.1:${gateway.server.address().port}/mobile/`;
 e.context.process.env.NODE_ENV='test';e.context.process.env.ASHUB_REMOTE_URL=remote;e.context.process.env.ASHUB_TOKEN='fixture-token';let saved,received=0;
 class RemoteBridge extends Bridge{async submit(query){received++;this.emit('event',{name:'agent:response-chunk',payload:{blocks:[{type:'text',text:'Remote reply'}]}});return {stopReason:'done'};}}
 const enrollment=await(await fetch(remote+'api/device/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'multi-test',password:'integration-only-password',create:true,deviceName:'Executor'})})).json();saved=JSON.stringify({...enrollment,roots:[fs.realpathSync(e.dir)],deviceName:'Executor'});const publisherSecrets=new Map();
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new RemoteBridge(o),pluginSecretStore:{read:k=>publisherSecrets.get(k)||null,write:(k,v)=>publisherSecrets.set(k,v)},remoteSecretStore:{read:()=>saved,write:v=>saved=v}});await once(hub.server,'listening');const local=`http://127.0.0.1:${hub.server.address().port}`,headers={Authorization:'Bearer fixture-token','X-Ashub-Local':'1','Content-Type':'application/json'};
 const control=new AbortController(),secrets=new Map(),registry=new BackendConnections({signal:control.signal,secrets:{read:k=>secrets.get(k)||null,write:(k,v)=>v===null?secrets.delete(k):secrets.set(k,v)}}),account=new RemoteAccount({backends:registry.bind('multi',control.signal),signal:control.signal,gateway:remote,fetch:(url,init)=>fetch(url,{...init,headers:{...init.headers,Origin:'http://127.0.0.1'}}),interval:3600000});
 const wait=async fn=>{for(let n=0;n<200;n++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,25));}throw Error('timeout');};let client,reader;
 try{
  const manageSharing=await require('./interconnect-fixture.cjs')(local,headers,wait);await wait(async()=>(await(await fetch(local+'/api/mobile',{headers})).json()).status==='online');
  await account.login('multi-test','integration-only-password');assert.equal(registry.list().length,1);
  client=http.createServer(async(req,res)=>{if(!await registry.handle(req,res,async req=>{let body='';for await(const c of req)body+=c;return body;}))res.writeHead(404).end();});client.listen(0,'127.0.0.1');await once(client,'listening');const base=`http://127.0.0.1:${client.address().port}/api/backends/${registry.list()[0].id}`;
  const rpc=async(op,args={})=>{const r=await fetch(base+'/request',{method:'POST',body:JSON.stringify({op,args})});const v=await r.json();assert(r.ok,JSON.stringify(v));return v;};
  assert((await rpc('capabilities')).queueActions);const project=(await rpc('projects'))[0];await rpc('create',{project:project.id,requestId:'multicreate-000000001'});const created=await wait(async()=>{const r=await rpc('request-status',{requestId:'multicreate-000000001'});return r.state==='done'&&r.result;});const sid=created.instanceId;assert((await rpc('sessions')).some(s=>s.instanceId===sid));
  const stream=await fetch(base+'/events?session='+sid);reader=stream.body.getReader();let content='';while(!content.includes('hub:replay-done'))content+=new TextDecoder().decode((await reader.read()).value);assert(content.includes('backend:reset'));
  const message={session:sid,query:'Integration request',requestId:'multisubmit-000000001',delivery:'queue'};await rpc('submit',message);await wait(async()=>(await rpc('request-status',{requestId:message.requestId})).state==='done');await rpc('submit',message);assert.equal(received,1);
  fs.writeFileSync(path.join(e.dir,'report.md'),'# Remote artifact');const file=base+'/resource?'+new URLSearchParams({session:sid,kind:'artifact',path:'report.md'});const head=await fetch(file,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),'17');const text=await fetch(file+'&version='+head.headers.get('x-artifact-version'));assert.equal(await text.text(),'# Remote artifact');
  const policy=await rpc('session-network',{session:sid});await rpc('set-session-network',{session:sid,enabled:false});assert.equal((await rpc('session-network',{session:sid})).enabled,false);assert.equal((await rpc('session-network',{session:sid})).globalEnabled,policy.globalEnabled);
  await reader.cancel();reader=null;
  const loginCookie=account.cookie,identity=JSON.parse([...publisherSecrets.values()][0]);
  const narrow=path.join(e.dir,'narrow');fs.mkdirSync(narrow);
  await manageSharing('update-roots',{roots:narrow});
  await wait(async()=>hub.remoteStatus().status==='online');await account.refresh();
  assert.deepEqual(await rpc('sessions'),[],'removed scope hides sessions from both controller and phone protocol');
  await manageSharing('update-roots',{roots:e.dir+'\n'+narrow});await wait(async()=>hub.remoteStatus().status==='online');await account.refresh();assert((await rpc('sessions')).some(s=>s.instanceId===sid));
  await manageSharing('update-roots',{roots:e.dir});await wait(async()=>hub.remoteStatus().status==='online');await account.refresh();assert((await rpc('sessions')).some(s=>s.instanceId===sid),'parent grant still covers removed child');
  const afterRoots=JSON.parse([...publisherSecrets.values()][0]);assert.equal(afterRoots.deviceId,identity.deviceId);assert.equal(afterRoots.deviceToken,identity.deviceToken);assert.equal(account.cookie,loginCookie);
  await manageSharing('disable-sharing');assert.equal(account.cookie,loginCookie);assert(secrets.has([...secrets.keys()][0]));
  await wait(async()=>{await account.refresh();return !registry.list()[0].online;});assert.equal(hub.remoteStatus().enabled,false);
  await manageSharing('configure-sharing',{username:'multi-test',password:'integration-only-password',deviceName:'Executor',roots:e.dir,create:false});
  await wait(async()=>hub.remoteStatus().status==='online');await account.refresh();assert.equal(account.cookie,loginCookie);assert.equal(registry.list()[0].online,true);
  assert.equal(JSON.parse([...publisherSecrets.values()][0]).deviceId,identity.deviceId);
  await account.logout();assert.equal(hub.remoteStatus().status,'online','logging out of control account keeps local publisher online');assert.equal(registry.list().length,0);assert.equal(secrets.size,0);assert.equal((await fetch(base+'/info')).status,410);
  console.log('PASS multi-machine plugin -> generic backend host -> existing gateway -> real Hub: login/create/replay/submit deduplication/files/remote-only VPN/independent publication and control switches/logout');
 }finally{await reader?.cancel();control.abort();account.close();client?.closeAllConnections();client?.close();await hub.shutdown();await gateway.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
