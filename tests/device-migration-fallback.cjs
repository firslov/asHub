const test=require('node:test'),assert=require('node:assert/strict'),{once}=require('node:events');
const {env,Bridge,fs,path,root}=require('./harness.cjs');
test('partial migration starts only the compatibility publisher and keeps local conversations available',async t=>{
 const e=env({globals:{fetch,WebSocket,setTimeout,clearTimeout,setInterval,clearInterval,Response,ReadableStream}});
 e.context.process.env.ASHUB_TOKEN='migration-fixture-token';
 const saved=JSON.stringify({deviceId:'same-device',deviceToken:'same-token',username:'fixture',deviceName:'Workstation',roots:[fs.realpathSync(e.dir)]}),vault=new Map();
 let sockets=0;const transport=e.load('src/remote/transport.ts').remoteTransport;
 t.mock.method(transport,'socket',()=>{sockets++;return{close(){}};});
 const rename=fs.renameSync;t.mock.method(fs,'renameSync',(from,to)=>{if(to.endsWith('device-interconnect-migrated.json'))throw Error('marker unavailable');return rename(from,to);});
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new Bridge(o),remoteSecretStore:{read:()=>saved,write(){}},pluginSecretStore:{read:k=>vault.get(k)||null,write:(k,v)=>vault.set(k,v)}});
 t.after(()=>hub.shutdown());await once(hub.server,'listening');const base='http://127.0.0.1:'+hub.server.address().port,headers={Authorization:'Bearer migration-fixture-token','X-Ashub-Local':'1','Content-Type':'application/json'};
 let features;for(let i=0;i<100;i++){features=(await(await fetch(base+'/api/extensions',{headers})).json()).features;if(features.some(f=>f.id==='mobile-access'&&f.state==='active'))break;await new Promise(r=>setTimeout(r,10));}
 assert(features.some(f=>f.id==='mobile-access'&&f.state==='active'));assert(!features.some(f=>f.capabilities?.includes('shared-conversations')));assert.equal(sockets,1);assert.equal(vault.size,1,'credentials copied before the marker failure');
 const status=await(await fetch(base+'/api/mobile',{headers})).json();assert.equal(status.enabled,true);assert.equal(status.deviceName,'Workstation');
 assert.equal((await fetch(base+'/sessions',{headers,method:'POST',body:JSON.stringify({cwd:e.dir})})).status,200);
});
