const {env,Bridge,path,root,fs}=require('./harness.cjs');
const assert=require('node:assert/strict'),{once}=require('node:events');
(async()=>{
 const e=env();e.context.process.env.ASHUB_TOKEN='queue-actions-test';const Ash=e.load('src/bridges/ash.ts').AshBridge;let b;
 class Fixture extends Bridge {
  constructor(o){super(o);Object.assign(this,{supportsQueue:true,supportsSteering:true,queryQueue:[],queuedIds:[],steering:new Map(),closed:false,core:{bus:{emit(){}}}});}
  assertOpen(){} isProcessing(){return !!this.pendingTurn;}
  parseSubmission(t){return Ash.prototype.parseSubmission.call(this,t);}
  submit(t,id,delivery){if(this.pendingTurn)return Ash.prototype.submit.call(this,t,id,delivery);return new Promise(resolve=>this.pendingTurn={resolve});}
  updateQueued(...args){return Ash.prototype.updateQueued.apply(this,args);}
  withdrawQueued(id){return Ash.prototype.withdrawQueued.call(this,id);}
 }
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>(b=new Fixture(o))});await once(hub.server,'listening');
 const base=`http://127.0.0.1:${hub.server.address().port}`,headers={Authorization:'Bearer queue-actions-test','Content-Type':'application/json'};
 const call=(url,body)=>fetch(base+url,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});
 const api=async(...args)=>{const r=await call(...args);assert(r.ok,await r.clone().text());return r.json();};
 try{
  const {instanceId:id}=await api('/sessions',{cwd:e.dir});await api(`/${id}/submit`,{query:'busy'});
  const image=await api('/api/upload',{sessionId:id,mimeType:'image/png',data:'aW1hZ2U='});
  const a=await api(`/${id}/submit`,{query:'same',delivery:'queue',images:[{id:image.id,mimeType:'image/png'}]});
  const c=await api(`/${id}/submit`,{query:'same',delivery:'queue'});
  const update={id:a.queueId,revision:0,action:'edit',query:'new text',requestId:'queue-actions-edit-01'};
  const changed=await api(`/${id}/queue/update`,update);assert.equal(changed.revision,1);assert.equal(changed.images[0].id,image.id);
  assert.equal(b.parseSubmission(b.queryQueue[0]).query,'new text');assert.equal(b.parseSubmission(b.queryQueue[0]).images[0].data,'aW1hZ2U=');
  assert.deepEqual((await api(`/${id}/queue`)).map(m=>m.id),[a.queueId,c.queueId]);
  assert.deepEqual(await api(`/${id}/queue/update`,update),changed,'retry returns receipt without editing twice');
  assert.equal((await call(`/${id}/queue/update`,{...update,query:'reuse'})).status,409);
  assert.equal((await call(`/${id}/queue/update`,{...update,requestId:'queue-actions-stale-01'})).status,409);
  assert.equal((await call(`/${id}/queue/update`,{...update,id:c.queueId,query:' ',requestId:'queue-actions-empty-01'})).status,400);
  assert.equal((await call(`/${id}/queue/update`,{...update,revision:-1})).status,400);
  // Reconnect must see the edited text and revision, not the original pending frame alone.
  const replayAbort=new AbortController();
  try {
    const response=await fetch(base+`/events?subs=${id}:all`,{headers,signal:AbortSignal.any([replayAbort.signal,AbortSignal.timeout(5000)])});
    let raw='';for await(const chunk of response.body){raw+=Buffer.from(chunk).toString();if(raw.includes('"hub:replay-done"'))break;}
    const frames=raw.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
    const edit=frames.find(f=>f.meta.name==='agent:queue-updated');
    assert.equal(edit?.payload.query,'new text');assert.equal(edit.payload.revision,1);assert.equal(edit.payload.queueId,a.queueId);
  } finally {replayAbort.abort();}
  const promote={id:a.queueId,revision:1,action:'promote',requestId:'queue-actions-promote-01'};
  const promoted=await api(`/${id}/queue/update`,promote);assert.equal(promoted.delivery,'steer');assert.equal(promoted.revision,2);
  assert.deepEqual(b.queuedIds,[c.queueId]);assert(b.steering.has(a.queueId));
  assert.deepEqual(await api(`/${id}/queue/update`,promote),promoted);
  // A later edit in the steering queue retains the same id and attachment refs.
  const edited=await api(`/${id}/queue/update`,{...update,revision:2,query:'final text',requestId:'queue-actions-edit-02'});
  assert.equal(edited.delivery,'steer');assert.equal(b.parseSubmission(b.steering.get(a.queueId)).query,'final text');
  b.steering.delete(a.queueId);b.emit('event',{name:'agent:steer-submit',payload:{query:'final text',queueId:a.queueId}});
  assert.equal((await call(`/${id}/queue/update`,{...promote,revision:3,requestId:'queue-actions-late-01'})).status,409);
  await api(`/${id}/queue/withdraw`,{id:c.queueId,requestId:'queue-actions-delete-01'});assert.equal((await api(`/${id}/queue`)).length,0);
  assert.equal((await call(`/${id}/queue/update`,{...update,id:c.queueId,requestId:'queue-actions-gone-01'})).status,409);
  assert.equal((await fetch(base+`/${id}/queue/update`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(update)})).status,401);
  b.pendingTurn.resolve({stopReason:'end_turn'});b.pendingTurn=null;
  console.log('PASS queue HTTP: stable position, preserved images, revisions, idempotency, promotion, consumed/withdrawn races and authentication');
 }finally{await hub.shutdown();fs.rmSync(e.dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
