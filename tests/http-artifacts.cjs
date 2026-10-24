const {env,Bridge,path,root,fs}=require('./harness.cjs');
const assert=require('node:assert/strict');
const {once}=require('node:events');
(async()=>{
 const e=env();e.context.process.env.ASHUB_TOKEN='artifact-test';
 let made=0;
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{made++;return new Bridge(o);}});
 await once(hub.server,'listening');
 const base=`http://127.0.0.1:${hub.server.address().port}`;
 const headers={Authorization:'Bearer artifact-test','Content-Type':'application/json'};
 const cwd=path.join(e.dir,'workspace');fs.mkdirSync(cwd);
 try {
  const created=await fetch(base+'/sessions',{method:'POST',headers,body:JSON.stringify({cwd})});
  const {instanceId:id}=await created.json();assert(created.ok);
  const endpoint=rel=>base+`/${id}/artifacts?path=`+encodeURIComponent(rel);
  for(const name of ['论文协作_20261023/审阅稿.docx','out/changes.md','out/package.zip','out/report.html','out/plot.svg','out/a #%.txt','out/no-extension']) {
    const bytes=Buffer.from('Fixture\0😀\n'+name);
    const file=path.join(cwd,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
    const urls=[endpoint(name)];
    if(name.includes('.'))urls.push(base+`/${id}/`+name.split('/').map(encodeURIComponent).join('/'));
    for(const url of urls) {
      const head=await fetch(url,{headers,method:'HEAD'});assert.equal(head.status,200,url);
      assert.equal(Number(head.headers.get('content-length')),bytes.length);assert.equal(await head.text(),'');
      const res=await fetch(url,{headers});assert.equal(res.status,200,url);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()),bytes);
      assert(res.headers.get('content-disposition').startsWith('attachment;'));
      assert.equal(res.headers.get('content-type'),'application/octet-stream');assert.equal(res.headers.get('x-content-type-options'),'nosniff');
      assert.equal(res.headers.get('cache-control'),'no-store');
    }
  }
  assert.equal((await fetch(endpoint('out/changes.md'))).status,401);
  assert.equal((await fetch(endpoint('missing.docx'),{headers})).status,404);
  assert.equal((await fetch(endpoint('out'),{headers})).status,404);
  assert.equal((await fetch(endpoint(''),{headers})).status,400);
  assert.equal((await fetch(endpoint('\0'),{headers})).status,400);
  assert.equal((await fetch(base+`/${id}/bad%xx.docx`,{headers})).status,400);
  fs.writeFileSync(path.join(e.dir,'secret.txt'),'outside');
  for(const name of ['../secret.txt',path.join(e.dir,'secret.txt')]) assert.equal((await fetch(endpoint(name),{headers})).status,403);
  if(process.platform!=='win32') {
    fs.symlinkSync(path.join(e.dir,'secret.txt'),path.join(cwd,'escape.txt'));
    assert.equal((await fetch(endpoint('escape.txt'),{headers})).status,403);
    const fifo=path.join(cwd,'pipe.txt');
    require('node:child_process').execFileSync('mkfifo',[fifo]);
    try {
      const response=await fetch(endpoint('pipe.txt'),{headers,signal:AbortSignal.timeout(1000)});
      assert.equal(response.status,404,'non-regular files must be rejected without blocking');
    } finally {
      // Release a blocked reader on the unfixed implementation so a failed
      // reproduction cannot leave a libuv worker or the test process hanging.
      try {fs.closeSync(fs.openSync(fifo,fs.constants.O_WRONLY|fs.constants.O_NONBLOCK));} catch(e) {if(e.code!=='ENXIO')throw e;}
    }
  }
  assert.equal((await fetch(base+`/${id}/js/client.js`,{headers})).status,200);
  assert.equal((await fetch(base+`/${id}/`,{headers})).status,200);
  assert.equal(made,1,'artifact reads must not create another kernel');
  console.log('PASS artifact GET/HEAD, legacy URLs, Unicode names, binary contents, auth, containment, attachment headers and app routes');
 } finally {await hub.shutdown();fs.rmSync(e.dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
