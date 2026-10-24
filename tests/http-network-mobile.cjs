const {env,Bridge,path,root,fs}=require('./harness.cjs');
const assert=require('node:assert/strict');
const {once}=require('node:events');
(async()=>{
 const e=env(); e.context.process.env.ASHUB_TOKEN='network-mobile-test';
 const bridges=[];
 class Fixture extends Bridge {
   async submit(query){
     this.emit('event',{name:'agent:tool-started',payload:{name:'read_file',toolCallId:query}});
     this.emit('event',{name:'agent:tool-completed',payload:{toolCallId:query,output:'content '.repeat(8000)}});
     this.emit('event',{name:'agent:response-chunk',payload:{blocks:[{type:'text',text:'answer '+query}]}});
     this.emit('event',{name:'agent:response-done',payload:{response:'answer '+query}});
     return{stopReason:'done'};
   }
 }
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{const b=new Fixture(o);bridges.push(b);return b;}});
 await once(hub.server,'listening'); const base=`http://127.0.0.1:${hub.server.address().port}`;
 const headers={Authorization:'Bearer network-mobile-test','Content-Type':'application/json'};
 const call=(url,body,method=body?'POST':'GET')=>fetch(base+url,{method,headers,body:body?JSON.stringify(body):undefined});
 const api=async(...args)=>{const r=await call(...args);assert(r.ok,await r.clone().text());return r.json();};
 const replay=async(url)=>{
   const c=new AbortController(), r=await fetch(base+url,{headers,signal:c.signal});assert(r.ok);
   const reader=r.body.getReader();let text='';
   try{while(!text.includes('hub:replay-done')){const chunk=await reader.read();if(chunk.done)break;text+=Buffer.from(chunk.value).toString();}}finally{await reader.cancel();c.abort();}
   return text;
 };
 try{
   assert.equal((await fetch(base+'/api/settings/network')).status,401);
   assert.equal((await fetch(base+'/api/settings/network',{method:'PUT',headers:{...headers,Origin:'https://bad.invalid'},body:'{"enabled":false}'})).status,403);
   const a=await api('/sessions',{cwd:e.dir});const b=await api('/sessions',{cwd:e.dir});
   assert.deepEqual(await api('/api/settings/network'),{proxyEnabled:true,sessions:{}});
   await api('/api/settings/network',{enabled:false},'PUT');
   await api('/api/settings/network',{enabled:true,session:a.instanceId},'PUT');
   assert.deepEqual(await api('/api/settings/network'),{proxyEnabled:false,sessions:{[a.instanceId]:true}});
   assert.equal((await call('/api/settings/network',{enabled:'false'},'PUT')).status,400);
   assert.equal((await call('/api/settings/network',{enabled:true,session:'ffff'},'PUT')).status,400);
   // Saving a previously opened settings editor cannot undo immediate toggles.
   await api('/api/config',{'ashub.network':{proxyEnabled:true,sessions:{}},custom:'keep'},'PUT');
   assert.deepEqual(await api('/api/settings/network'),{proxyEnabled:false,sessions:{[a.instanceId]:true}});
   await api('/api/settings/network',{enabled:null,session:a.instanceId},'PUT');
   assert.deepEqual(await api('/api/settings/network'),{proxyEnabled:false,sessions:{}});
   for(let i=0;i<25;i++){await api(`/${a.instanceId}/submit`,{query:'q'+i});await new Promise(r=>setImmediate(r));}
   const mobile=await replay(`/events?subs=${a.instanceId}:all&view=mobile`);
   const full=await replay(`/events?subs=${a.instanceId}:all`);
   const parse=text=>text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
   const recent=parse(mobile),all=parse(full);
   assert.equal(recent.filter(f=>f.meta.name==='agent:query').length,12);
   assert.equal(all.filter(f=>f.meta.name==='agent:query').length,25);
   assert(recent.some(f=>f.payload?.text==='answer q24'));
   assert(recent.some(f=>f.meta.name==='hub:history-window' && f.payload.hasEarlier));
   assert(recent.some(f=>f.payload?.detailsOmitted));
   assert(all.some(f=>f.payload?.output?.length===64000));
   assert(full.length/mobile.length>20);
   assert(!parse(await replay(`/events?subs=${b.instanceId}:all&view=mobile`)).some(f=>f.payload?.query));
   console.log(`PASS authenticated network preferences, config preservation and mobile/full replay isolation (${full.length} -> ${mobile.length} characters)`);
 }finally{await hub.shutdown();}
})().catch(e=>{console.error(e);process.exitCode=1});
