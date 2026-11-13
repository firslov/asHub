import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {BackendConnections} from '../dist/extensions/backends.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t){
 const host=new AbortController(),plugin=new AbortController(),vault=new Map(),opened=[];
 const registry=new BackendConnections({signal:host.signal,secrets:{read:k=>vault.get(k)||null,write:(k,v)=>v===null?vault.delete(k):vault.set(k,v)},open:(...v)=>opened.push(v)});
 const scoped=registry.bind('test-plugin',plugin.signal);
 const server=http.createServer(async(req,res)=>{if(!await registry.handle(req,res,async r=>{let text='';for await(const c of r)text+=c;return text;})){res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 t.after(()=>{host.abort();server.closeAllConnections();server.close();});
 const request=(id,op,args={})=>fetch(url+'/api/backends/'+id+'/request',{method:'POST',body:JSON.stringify({op,args})});
 return {host,plugin,vault,opened,registry,scoped,url,request};
}
const adapter=(extra={})=>({label:'Work computer',online:()=>true,request:async(op,args)=>({op,args}),subscribe:async()=>{},...extra});
test('backend registration and secrets are plugin scoped; open is explicit; arbitrary local/admin operations denied',async t=>{
 const f=await fixture(t),a=f.scoped.register('machine',adapter()),other=f.registry.bind('another-plugin',new AbortController().signal),b=other.register('machine',adapter());
 assert.notEqual(a.id,b.id);f.scoped.secrets.write('login','secret');assert.equal(other.secrets.read('login'),null);assert.equal(f.scoped.secrets.read('login'),'secret');assert.match([...f.vault.keys()][0],/^[a-f0-9]{64}$/);
 assert.throws(()=>f.scoped.secrets.write('../escape','x'));assert.throws(()=>f.scoped.register('machine',adapter()),/already/);
 assert.equal((await (await fetch(f.url+'/api/backends')).json()).length,2);assert.equal(f.opened.length,0);
 assert.equal((await fetch(f.url+'/api/backends/'+a.id+'/open',{method:'POST'})).status,404);assert.equal(f.opened.length,0);
 await a.open();assert.equal(f.opened[0][0],a.id);
 for(const op of ['shell','settings','install-plugin','artifact'])assert.equal((await f.request(a.id,op)).status,400);
 assert.equal((await f.request(a.id,'permission',{sessionWide:true})).status,403);
 assert.equal((await f.request(a.id,'permission',{onceOnly:false})).status,403);
 assert.equal((await f.request(a.id,'submit',{session:'abc',query:'hello'})).status,200);
 f.plugin.abort();assert.equal((await f.request(a.id,'sessions')).status,410);assert.equal(f.registry.list().length,1);
 await assert.rejects(a.open());assert.equal(f.opened.length,1,'disabled plugin cannot open windows');
});
test('revocation cancels pending requests and late results cannot become successful responses',async t=>{
 const f=await fixture(t),started=deferred(),late=deferred();let signal;
 const entry=f.scoped.register('machine',adapter({request:async(_o,_a,s)=>{signal=s;started.resolve();return late.promise;}}));
 const pending=f.request(entry.id,'sessions');await started.promise;entry.dispose();assert(signal.aborted);late.resolve([{instanceId:'bad'}]);const r=await pending;assert.notEqual(r.status,200);assert(!JSON.stringify(await r.json()).includes('bad'));
 const next=f.scoped.register('machine',adapter());assert.equal(next.id,entry.id);assert.equal((await f.request(next.id,'sessions')).status,200);
});
test('disconnect and host shutdown cancel streams; bounded resources preserve preview metadata and force safe MIME',async t=>{
 const f=await fixture(t),started=deferred();let streamSignal;
 const e=f.scoped.register('machine',adapter({subscribe:async(sid,emit,signal)=>{streamSignal=signal;emit({meta:{name:'hub:replay-done'},payload:{session:sid}});started.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));},resource:async args=>({data:args.method==='HEAD'?new Uint8Array():Buffer.from('abc'),type:'text/html',size:3,version:'abc123'})}));
 const controller=new AbortController(),r=await fetch(f.url+'/api/backends/'+e.id+'/events?session=abc',{signal:controller.signal});await started.promise;const reader=r.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/replay-done/);controller.abort();await new Promise(r=>setTimeout(r,25));assert(streamSignal.aborted);
 const url=f.url+'/api/backends/'+e.id+'/resource?kind=artifact&session=abc&path=x';
 const head=await fetch(url,{method:'HEAD'});assert.equal(head.headers.get('content-length'),'3');assert.equal(head.headers.get('x-artifact-version'),'abc123');assert.match(head.headers.get('content-disposition'),/^attachment;/);assert.equal(head.headers.get('content-type'),'application/octet-stream');
 assert.equal(await (await fetch(url)).text(),'abc');f.host.abort();assert.equal(f.registry.list().length,0);assert.throws(()=>f.scoped.register('later',adapter()));
});
test('late event callbacks after disposal are harmless and cannot leak into a replacement connection',async t=>{
 const f=await fixture(t),started=deferred();let emitOld;
 const old=f.scoped.register('machine',adapter({subscribe:async(_sid,emit,signal)=>{emitOld=emit;emit({meta:{name:'old:ready'}});started.resolve();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}}));
 const stream=await fetch(f.url+'/api/backends/'+old.id+'/events?session=abc');await started.promise;const reader=stream.body.getReader();await reader.read();old.dispose();
 const replacement=f.scoped.register('machine',adapter());assert.equal(replacement.id,old.id);
 assert.doesNotThrow(()=>emitOld({meta:{name:'late:old-account'}}),'a late plugin callback must not crash the host');
 let rest='';while(true){const {value,done}=await reader.read();if(done)break;rest+=new TextDecoder().decode(value);}assert(!rest.includes('late:old-account'));assert.equal((await f.request(replacement.id,'sessions')).status,200);
});


test('workspace handles cannot retarget or reopen disposed registrations',async t=>{
 const f=await fixture(t),old=f.scoped.register('machine',adapter());old.dispose();
 const replacement=f.scoped.register('machine',adapter());assert.equal(replacement.id,old.id);
 await assert.rejects(old.open(),/unavailable/);assert.equal(f.opened.length,0);
 await replacement.open();assert.equal(f.opened[0][0],replacement.id);
 const offline=f.scoped.register('offline',adapter({online:()=>false}));await assert.rejects(offline.open(),/offline/);assert.equal(f.opened.length,1);
 const other=f.registry.bind('other-plugin',new AbortController().signal).register('machine',adapter());
 await replacement.open(other.id);assert.equal(f.opened[1][0],replacement.id,'extra arguments cannot retarget a scoped handle');
});
