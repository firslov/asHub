const {env,Bridge,path,root,fs}=require('./harness.cjs');
const assert=require('node:assert/strict'),{once}=require('node:events');
(async()=>{
 const e=env();e.context.process.env.ASHUB_TOKEN='steer-test';const Ash=e.load('src/bridges/ash.ts').AshBridge;let b;
 class Fixture extends Bridge {
  constructor(o){super(o);Object.assign(this,{supportsQueue:true,supportsSteering:true,queryQueue:[],queuedIds:[],steering:new Map(),closed:false,core:{bus:{emit:(name,p)=>{
   if(name==='agent:steer'&&this.consumeImmediately)this.consume(p.id);
   if(name==='agent:steer-cancel'&&this.steering.has(p.id)){const query=this.parseSubmission(this.steering.get(p.id)).query;this.steering.delete(p.id);this.emit('event',{name:'agent:queued-done',payload:{queueId:p.id,query,dropped:true}});}
  }}}});}
  assertOpen(){} isProcessing(){return !!this.pendingTurn;}
  parseSubmission(t){return Ash.prototype.parseSubmission.call(this,t);}
  submit(t,id,delivery){if(this.pendingTurn)return Ash.prototype.submit.call(this,t,id,delivery);this.messages.push({role:'user',content:t});return new Promise(resolve=>this.pendingTurn={resolve});}
  withdrawQueued(id){return Ash.prototype.withdrawQueued.call(this,id);}
  consume(id){const payload=this.parseSubmission(this.steering.get(id));this.steering.delete(id);this.messages.push({role:'user',content:payload.query});this.emit('event',{name:'agent:steer-submit',payload:{...payload,queueId:id}});}
 }
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>(b=new Fixture(o))});await once(hub.server,'listening');
 const base=`http://127.0.0.1:${hub.server.address().port}`,headers={Authorization:'Bearer steer-test','Content-Type':'application/json'};
 const call=(url,body)=>fetch(base+url,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});
 const api=async(...args)=>{const r=await call(...args);assert(r.ok,await r.clone().text());return r.json();};
 let stream,reading;const frames=[];
 try{
  const {instanceId:id}=await api('/sessions',{cwd:e.dir});
  stream=new AbortController();const r=await fetch(base+`/events?subs=${id}`,{headers,signal:stream.signal});
  reading=(async()=>{let text='';for await(const chunk of r.body){text+=Buffer.from(chunk).toString();let at;while((at=text.indexOf('\n\n'))>=0){const block=text.slice(0,at);text=text.slice(at+2);const d=block.split('\n').find(l=>l.startsWith('data: '));if(d)frames.push(JSON.parse(d.slice(6)));}}})().catch(()=>{});
  await api(`/${id}/submit`,{query:'active'});
  b.emit('event',{name:'agent:todo',payload:{todos:[{title:'Keep initial plan',status:'in_progress'}]}});
  assert.equal((await call(`/${id}/submit`,{query:'invalid',delivery:'interrupt'})).status,400);
  const q=await api(`/${id}/submit`,{query:'later',delivery:'queue'});
  const image=await api('/api/upload',{sessionId:id,mimeType:'image/png',data:'aW1hZ2U='});
  const first=await api(`/${id}/submit`,{query:'same',delivery:'steer'});
  const second=await api(`/${id}/submit`,{query:'same',delivery:'steer',images:[{id:image.id,mimeType:'image/png'}]});
  assert.deepEqual((await api(`/${id}/queue`)).map(i=>i.delivery),['queue','steer','steer']);
  await api(`/${id}/queue/withdraw`,{id:first.queueId,requestId:'withdraw-steer-001'});
  b.emit('event',{name:'agent:response-chunk',payload:{blocks:[{type:'text',text:'Before steer'}]}});
  b.consume(second.queueId);
  assert.equal((await call(`/${id}/queue/withdraw`,{id:second.queueId,requestId:'withdraw-steer-002'})).status,409);
  assert.deepEqual((await api(`/${id}/queue`)).map(m=>m.id),[q.queueId]);
  assert.equal((await api('/sessions'))[0].isProcessing,true,'steer must not finish the current task');
  b.consumeImmediately=true;const fast=await api(`/${id}/submit`,{query:'fast',delivery:'steer'});
  await new Promise(r=>setTimeout(r,30));
  const consumed=frames.filter(f=>f.meta.name==='agent:query'&&f.payload.steering);
  assert.equal(consumed.length,2);assert.equal(consumed[0].payload.images[0].id,image.id,'persisted image refs, not raw data');
  assert(frames.findIndex(f=>f.meta.name==='agent:response-segment')<frames.indexOf(consumed[0]));
  assert(!frames.some(f=>f.meta.name==='agent:queued'&&f.payload.queueId===fast.queueId),'late acknowledgement cannot recreate a consumed item');
  assert.equal(frames.filter(f=>f.meta.name==='agent:processing-start').length,1);
  assert.equal(frames.filter(f=>f.meta.name==='agent:processing-done').length,0);
  // The mobile reconnect must include the task start even with >12 follow-ups.
  for(let i=0;i<15;i++)await api(`/${id}/submit`,{query:`follow-up ${i}`,delivery:'steer'});
  const reconnect=new AbortController();
  try{
   const response=await fetch(base+`/events?subs=${id}:all&view=mobile`,{headers,signal:AbortSignal.any([reconnect.signal,AbortSignal.timeout(5000)])});
   let raw='';for await(const chunk of response.body){raw+=Buffer.from(chunk).toString();if(raw.includes('"hub:replay-done"'))break;}
   const replay=raw.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
   assert(replay.some(f=>f.meta.name==='agent:query'&&f.payload.query==='active'),'mobile replay retains the original task');
   assert(replay.some(f=>f.meta.name==='agent:todo'&&f.payload.todos[0].title==='Keep initial plan'),'mobile replay retains the task plan');
   assert.equal(replay.filter(f=>f.meta.name==='agent:processing-start').length,1);
   assert.equal(replay.filter(f=>f.meta.name==='agent:query'&&f.payload.steering).length,17);
  }finally{reconnect.abort();}
  b.pendingTurn.resolve({stopReason:'end_turn'});b.pendingTurn=null;await new Promise(r=>setTimeout(r,20));
  for(let i=0;i<100 && frames.filter(f=>f.meta.name==='agent:query-tagged').length<18;i++)await new Promise(r=>setTimeout(r,10));
  const tags=frames.filter(f=>f.meta.name==='agent:query-tagged');
  assert.equal(tags.length,18,'initial and consumed follow-ups receive persistent history IDs');
  assert.equal(new Set(tags.map(f=>f.payload.entryId)).size,18);
  console.log('PASS steering HTTP: validation, queue modes, exact withdrawal, image refs, stream ordering, fast consumption and active-turn lifecycle');
 }finally{stream?.abort();await reading;await hub.shutdown();fs.rmSync(e.dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
