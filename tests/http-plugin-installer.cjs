const {env,Bridge,path,root,fs}=require('./harness.cjs'),{zip,plugin}=require('./plugin-zip-fixture.cjs');
const assert=require('node:assert/strict'),{once}=require('node:events');
(async()=>{
 const e=env({globals:{setTimeout,clearTimeout}});e.context.process.env.ASHUB_TOKEN='install-test';
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new Bridge(o)});
 await once(hub.server,'listening');const base=`http://127.0.0.1:${hub.server.address().port}`;
 const headers={Authorization:'Bearer install-test'},bytes=zip(plugin());
 const req=(action,body,extra={})=>fetch(base+'/api/plugins/install'+action,{headers:{...headers,...extra},method:'POST',body});
 try{
  assert.equal((await fetch(base+'/api/plugins/install?action=preview',{method:'POST',headers:{'Content-Type':'application/zip'},body:bytes})).status,401);
  assert.equal((await req('?action=preview',bytes,{'Content-Type':'application/zip',Origin:'https://foreign.invalid'})).status,403);
  assert.equal((await req('?action=preview','{}',{'Content-Type':'application/json'})).status,400);
  let r=await req('?action=preview',bytes,{'Content-Type':'application/zip'});assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');const p=await r.json();
  for(let n=0;n<4;n++){
   r=await fetch(base+'/api/plugins/install?action=preview&id='+p.token,{headers});assert.equal(r.status,200);
   assert.equal((await r.json()).token,p.token);assert(!fs.existsSync(p.target));
  }
  assert.equal((await fetch(base+'/api/plugins/install?action=preview&id=expired',{headers})).status,404);
  assert(!fs.existsSync(p.target));assert.equal((await req('?action=confirm','{"token":"forged"}',{'Content-Type':'application/json'})).status,400);
  r=await req('?action=confirm',JSON.stringify({token:p.token}),{'Content-Type':'application/json'});assert.equal(r.status,200);const job=await r.json();
  assert.equal((await fetch(base+'/api/plugins/install?action=preview&id='+p.token,{headers})).status,409);
  let result;for(let n=0;n<100;n++){result=await(await fetch(base+'/api/plugins/install?id='+job.id,{headers})).json();if(result.state!=='running')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(result.state,'succeeded',result.error);
  const list=await(await fetch(base+'/api/plugins',{headers})).json();assert(list.plugins.some(p=>p.name==='Sample'&&p.version==='1.0.0'));
  assert.equal((await fetch(base+'/api/plugins/install?id=missing',{headers})).status,404);
  assert.equal((await req('?action=confirm','x'.repeat(1100),{'Content-Type':'application/json'})).status,413);
  console.log('PASS plugin installation HTTP: auth, origin, bounds, preview/confirm separation, job status and discovery');
 }finally{await hub.shutdown();fs.rmSync(e.dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
