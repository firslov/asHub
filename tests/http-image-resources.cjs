const {env,Bridge,path,root,fs}=require('./harness.cjs');const assert=require('node:assert/strict');const {once}=require('node:events');
(async()=>{
 const e=env();e.context.process.env.ASHUB_TOKEN='image-test';const bridges=[];
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{const b=new Bridge(o);bridges.push(b);return b;}});await once(hub.server,'listening');
 const base=`http://127.0.0.1:${hub.server.address().port}`,headers={Authorization:'Bearer image-test','Content-Type':'application/json'};
 const cwd=path.join(e.dir,'workspace');fs.mkdirSync(cwd);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ZkAAAAASUVORK5CYII=','base64');fs.writeFileSync(path.join(cwd,'image.png'),png);
 try{
 const create=async()=>{const r=await fetch(base+'/sessions',{method:'POST',headers,body:JSON.stringify({cwd})});assert(r.ok);return(await r.json()).instanceId;};
 const id=await create(),other=await create();const resource=await bridges[0].opts.imageResources.publish('image.png');const url=base+`/${id}/image-resources/${resource.id}`;
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(base+`/${other}/image-resources/${resource.id}`,{headers})).status,404);
 const meta=await(await fetch(url+'?meta=1',{headers})).json();assert.equal(meta.version,resource.id);
 const head=await fetch(url,{method:'HEAD',headers});assert.equal(head.status,200);assert.equal(head.headers.get('content-type'),'image/png');assert.equal(head.headers.get('cache-control'),'no-store');assert.equal(head.headers.get('x-content-type-options'),'nosniff');
 const response=await fetch(url,{headers});assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 const chunk=await(await fetch(url+'?offset=0',{headers})).json();assert.deepEqual(Buffer.from(chunk.data,'base64'),png);
 assert.equal((await fetch(url+'?offset=-1',{headers})).status,400);
 await fetch(base+`/${id}/`,{method:'DELETE',headers});assert.equal((await fetch(url,{headers})).status,404);await assert.rejects(bridges[0].opts.imageResources.publish('image.png'));
 console.log('PASS image resources: real HTTP auth, session isolation, snapshots, HEAD, chunk reads, deletion and stale services');
 }finally{await hub.shutdown();fs.rmSync(e.dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
