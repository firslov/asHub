import test from 'node:test';
import http from 'node:http';
import {ProxyAgent,getGlobalDispatcher,setGlobalDispatcher} from 'undici';
import assert from 'node:assert/strict';
import {RemoteAccount} from '../client.mjs';
const did='A'.repeat(43),did2='B'.repeat(43),json=(v,status=200,headers={})=>new Response(JSON.stringify(v),{status,headers});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t,fetch,saved,gateway){
 const registrations=new Map(),opened=[],secrets=new Map(saved?[['login',saved]]:[]),signal=new AbortController();
 const backends={secrets:{available:true,read:k=>secrets.get(k)||null,write:(k,v)=>v===null?secrets.delete(k):secrets.set(k,v)},register:(id,adapter)=>{assert(!registrations.has(id));registrations.set(id,adapter);return {dispose:()=>registrations.delete(id),open:async()=>opened.push(id)};}};
 const account=new RemoteAccount({backends,signal:signal.signal,fetch,gateway,interval:3600000});t.after(()=>account.close());return {account,secrets,registrations,signal,opened};
}
test('login stores only session credential, registers authorized devices and restores after restart',async t=>{
 const calls=[];const request=async(url,init)=>{calls.push([url.pathname,init]);if(url.pathname.endsWith('/login'))return json({username:'user'},200,{'set-cookie':'ash_mobile=abc123; HttpOnly; Secure'});return json([{id:did,name:'Office',online:true}]);};
 const f=fixture(t,request);await f.account.login('user','password-not-persisted');assert.equal(f.registrations.size,1);assert(!f.secrets.get('login').includes('password-not-persisted'));assert.equal(calls[1][1].headers.Cookie,'ash_mobile=abc123');
 const restored=fixture(t,request,f.secrets.get('login'));await restored.account.refresh();assert.equal(restored.registrations.size,1);assert.equal(restored.account.user,'user');f.signal.abort();assert.equal(f.registrations.size,0);assert(f.secrets.has('login'));
});
test('relogin does not reuse old refresh; late account A response never registers in account B',async t=>{
 const old=deferred();const f=fixture(t,async(url,init)=>url.pathname.endsWith('/login')?json({},200,{'set-cookie':'ash_mobile=new'}):init.headers.Cookie==='ash_mobile=old'?old.promise:json([{id:did2,name:'New',online:true}]));
 f.account.cookie='ash_mobile=old';const pending=f.account.refresh().catch(e=>e);await f.account.login('new','pw');assert.deepEqual([...f.registrations.keys()],[did2]);old.resolve(json([{id:did,name:'Old',online:true}]));await pending;assert.deepEqual([...f.registrations.keys()],[did2]);
});
test('expired login removes registrations and credentials; failed discovery marks offline without losing binding',async t=>{
 let status=200;const f=fixture(t,async()=>status===200?json([{id:did,name:'Office',online:true}]):json({error:'unavailable'},status));f.account.cookie='ash_mobile=old';f.secrets.set('login','saved');await f.account.refresh();const original=f.registrations.get(did);status=502;await assert.rejects(f.account.refresh());assert.equal(original.online(),false);status=200;await f.account.refresh();assert.equal(f.registrations.get(did),original);assert.equal(original.online(),true);status=401;await assert.rejects(f.account.refresh());assert.equal(f.registrations.size,0);assert.equal(f.account.cookie,'');assert.equal(f.secrets.size,0);
});
test('split stream frames, reset and cancellation are handled; credential is never emitted',async t=>{
 const encoder=new TextEncoder(),f=fixture(t,async()=>new Response(new ReadableStream({start(c){c.enqueue(encoder.encode('event: reset\ndata: {}\n\ndata: {"meta":{"name":"hub:'));c.enqueue(encoder.encode('replay-done"},"payload":{}}\n\n'));c.close();}})));f.account.cookie='ash_mobile=secret';const emitted=[];await f.account.subscribe(did,'abc',e=>emitted.push(e),new AbortController().signal);assert.deepEqual(emitted.map(e=>e.meta.name),['backend:reset','hub:replay-done']);assert(!JSON.stringify(emitted).includes('secret'));
});
test('artifact HEAD and versioned GET preserve metadata and never download oversized payloads',async t=>{
 const calls=[],f=fixture(t,async(url,init)=>{calls.push([url,init]);return new Response(init.method==='HEAD'?null:'abc',{headers:{'content-length':'3','x-artifact-version':'v1','content-type':'text/html'}});});f.account.cookie='ash_mobile=token';const head=await f.account.resource(did,{session:'abc',kind:'artifact',path:'a.html',method:'HEAD'},new AbortController().signal);assert.equal(head.size,3);assert.equal(head.data.length,0);const body=await f.account.resource(did,{session:'abc',kind:'artifact',path:'a.html',version:head.version},new AbortController().signal);assert.equal(body.data.toString(),'abc');assert.equal(calls[1][0].searchParams.get('version'),'v1');
});

test('logout still revokes the remote cookie when deleting local encrypted storage fails',async t=>{
 let revoked=false;const f=fixture(t,async(url,init)=>{if(url.pathname.endsWith('/logout')){assert.equal(init.headers.Cookie,'ash_mobile=token');revoked=true;}return json({ok:true});});f.account.cookie='ash_mobile=token';f.account.backends.secrets.write=()=>{throw Error('storage read-only');};await assert.rejects(f.account.logout(),/read-only/);assert(revoked);assert.equal(f.account.cookie,'');assert.equal(f.registrations.size,0);
});

test('default plugin transport connects directly without replacing the model global dispatcher',async t=>{
 const oldEnv=process.env.NODE_ENV,original=getGlobalDispatcher(),broken=new ProxyAgent('http://127.0.0.1:1');process.env.NODE_ENV='test';setGlobalDispatcher(broken);
 const server=http.createServer((req,res)=>{req.resume();res.setHeader('Content-Type','application/json');if(req.url.endsWith('/login')){res.setHeader('Set-Cookie','ash_mobile=direct123; HttpOnly');res.end('{}');}else{assert.equal(req.headers.cookie,'ash_mobile=direct123');res.end(JSON.stringify([{id:did,name:'Direct',online:true}]));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{setGlobalDispatcher(original);await broken.close();if(oldEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=oldEnv;server.closeAllConnections();server.close();});
 const f=fixture(t,undefined,undefined,'http://127.0.0.1:'+server.address().port+'/mobile/');await f.account.login('user','password');assert.equal(f.registrations.size,1);assert.equal(getGlobalDispatcher(),broken,'model dispatcher remains untouched');f.account.close();
});


test('late stream and parsed discovery body from a logged-out account cannot reach the new account',async t=>{
 let releaseStream,releaseBody;
 const encoder=new TextEncoder(),emitted=[];
 const f=fixture(t,async(url,init)=>{
  if(url.pathname.endsWith('/login'))return json({username:'new'},200,{'set-cookie':'ash_mobile=new'});
  if(url.pathname.endsWith('/logout'))return json({ok:true});
  if(url.pathname.includes('/events'))return new Response(new ReadableStream({start(c){releaseStream=c;}}));
  if(init.headers.Cookie==='ash_mobile=old')return {ok:true,json:()=>new Promise(r=>releaseBody=r)};
  return json([{id:did2,name:'New',online:true}]);
 });
 f.account.cookie='ash_mobile=old';
 const oldDiscovery=assert.rejects(f.account.refresh(),/连接已变更/);
 const oldStream=assert.rejects(f.account.subscribe(did,'abc',e=>emitted.push(e),new AbortController().signal),/连接已变更/);
 await new Promise(r=>setImmediate(r));assert(releaseBody);assert(releaseStream);
 await f.account.logout();await f.account.login('new','pw');
 releaseBody([{id:did,name:'Old',online:true}]);
 releaseStream.enqueue(encoder.encode('data: {"meta":{"name":"agent:response-segment"},"payload":{"text":"old account"}}\n\n'));
 await Promise.all([oldDiscovery,oldStream]);
 assert.deepEqual(emitted,[]);assert.deepEqual([...f.registrations.keys()],[did2]);assert.equal(f.account.user,'new');
});


test('device opening revalidates membership, rejects offline/removed devices, and never opens another account',async t=>{
 let devices=[{id:did,name:'Office',online:true}],delay;
 const f=fixture(t,async()=>delay?delay.promise:json(devices));f.account.cookie='ash_mobile=old';
 await f.account.refresh();await f.account.openDevice(did);assert.deepEqual(f.opened,[did]);
 devices=[{id:did,name:'Office',online:false}];await assert.rejects(f.account.openDevice(did),/离线/);assert.equal(f.opened.length,1);
 devices=[];await assert.rejects(f.account.openDevice(did),/变更/);assert.equal(f.registrations.size,0);
 devices=[{id:did,name:'Office',online:true}];await f.account.refresh();
 delay=deferred();const pending=assert.rejects(f.account.openDevice(did),/连接已变更/);
 f.account.clear();f.account.cookie='ash_mobile=new';
 delay.resolve(json(devices));await pending;assert.equal(f.opened.length,1);
});
