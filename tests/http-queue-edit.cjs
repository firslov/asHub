const {env,Bridge,path,root,fs}=require('./harness.cjs');
const assert=require('node:assert/strict');
const {once}=require('node:events');
(async()=>{
 const e=env(); e.context.process.env.ASHUB_TOKEN='queue-test';
 const Ash=e.load('src/bridges/ash.ts').AshBridge;
 const bridges=[];
 class Fixture extends Bridge {
  constructor(opts){super(opts);Object.assign(this,{supportsQueue:true,queryQueue:[],queuedIds:[],closed:false,core:{bus:{emit:(name,p)=>{if(name==='agent:submit')this.delivered.push(p);}}},delivered:[]});}
  isProcessing(){return Ash.prototype.isProcessing.call(this);}
  parseSubmission(text){return Ash.prototype.parseSubmission.call(this,text);}
  assertOpen(){}
  submit(text,id){if(this.isProcessing())return Ash.prototype.submit.call(this,text,id);return new Promise(resolve=>{this.pendingTurn={resolve};});}
  withdrawQueued(id){return Ash.prototype.withdrawQueued.call(this,id);}
  dropQueued(){return Ash.prototype.dropQueued.call(this);}
  drain(){return Ash.prototype.drainQueue.call(this);}
 }
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{const b=new Fixture(o);bridges.push(b);return b;}});
 await once(hub.server,'listening');const base=`http://127.0.0.1:${hub.server.address().port}`;
 const headers={Authorization:'Bearer queue-test','Content-Type':'application/json'};
 const call=(url,body)=>fetch(base+url,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});
 const api=async(...args)=>{const r=await call(...args);assert(r.ok,await r.clone().text());return r.json();};
 try{
  const a=await api('/sessions',{cwd:e.dir}),b=await api('/sessions',{cwd:e.dir}),sid=a.instanceId;
  await api(`/${sid}/submit`,{query:'active'});
  const image=await api('/api/upload',{sessionId:sid,mimeType:'image/png',data:'aW1hZ2U='});
  const first=await api(`/${sid}/submit`,{query:'same'});
  const second=await api(`/${sid}/submit`,{query:'same',images:[{id:image.id,mimeType:'image/png'}]});
  assert(first.queued&&second.queued);assert.notEqual(first.queueId,second.queueId);
  const queued=await api(`/${sid}/queue`);assert.equal(queued.length,2);assert.equal(queued[1].images[0].id,image.id);
  assert.equal((await call(`/${b.instanceId}/queue/withdraw`,{id:second.queueId,requestId:'withdraw-test-request'})).status,409);
  assert.equal((await call(`/${sid}/queue/withdraw`,{id:second.queueId})).status,400);
  const withdrawn=await api(`/${sid}/queue/withdraw`,{id:second.queueId,requestId:'withdraw-test-request'});
  assert.equal(withdrawn.query,'same');assert.equal(withdrawn.images[0].id,image.id);
  assert.deepEqual(await api(`/${sid}/queue/withdraw`,{id:second.queueId,requestId:'withdraw-test-request'}),withdrawn,'retry must recover same receipt');
  assert.equal((await call(`/${sid}/queue/withdraw`,{id:second.queueId,requestId:'other-client-request'})).status,409);
  assert.equal(bridges[0].isProcessing(),true);assert.equal(bridges[0].queryQueue.length,1);
  assert.deepEqual((await api(`/${sid}/queue`)).map(m=>m.id),[first.queueId]);
  const active=(await api('/sessions')).find(s=>s.instanceId===sid);assert.equal(active.isProcessing,true);assert.equal(active.queuedCount,1);
  bridges[0].pendingTurn.resolve({stopReason:'done'});bridges[0].pendingTurn=null;await new Promise(r=>setImmediate(r));bridges[0].drain();
  assert.equal(bridges[0].delivered.length,1);assert.equal(bridges[0].delivered[0].query,'same');
  assert.equal((await api(`/${sid}/queue`)).length,0);
  assert.equal((await call(`/${sid}/queue/withdraw`,{id:first.queueId,requestId:'already-running-test'})).status,409,'a running turn cannot be withdrawn');
  const third=await api(`/${sid}/submit`,{query:'drop'});bridges[0].dropQueued();
  assert.equal((await api(`/${sid}/queue`)).length,0);assert.equal(bridges[0].queuedIds.length,0);
  assert.equal((await call(`/${sid}/queue/withdraw`,{id:third.queueId,requestId:'already-dropped-test'})).status,409);
  console.log('PASS queue withdrawal: duplicate text, image refs, retries, session isolation, dequeue race, active turn preservation');
 }finally{await hub.shutdown();fs.rmSync(e.dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
