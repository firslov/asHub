import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {ComposerInputs} from '../dist/extensions/composer-inputs.js';
const wait=async fn=>{for(let i=0;i<100;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');};
async function fixture(t,transform,presentation={}){
 const lifecycle=new AbortController(),owner=new AbortController(),sessions=new Set(['aaaa','bbbb']);
 const service=new ComposerInputs(lifecycle.signal,id=>{if(!sessions.has(id))throw Object.assign(Error('No session'),{status:403});});
 const server=http.createServer(async(req,res)=>{if(!await service.handle(req,res,async req=>{let body='';for await(const c of req)body+=c;return body;})){res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{owner.abort();lifecycle.abort();server.closeAllConnections();server.close();});
 const dispose=service.bind('fixture',owner.signal).register('input',{label:'语音',description:'test',kind:'audio',maxDuration:60,maxBytes:1000,transform,...presentation});
 const base='http://127.0.0.1:'+server.address().port;
 const call=async(route,body,method=body?'POST':'GET')=>{const r=await fetch(base+route,{method,body:body?JSON.stringify(body):undefined});return {status:r.status,...await r.json()};};
 const catalog=await (await fetch(base+'/aaaa/composer-inputs')).json(),input=catalog[0];
 const route='/aaaa/composer-inputs/'+input.id+'/'+randomUUID(),payload={revision:input.revision,data:Buffer.from('audio').toString('base64'),mimeType:'audio/mp4; codecs=mp4a.40.2'};
 return {service,owner,sessions,dispose,call,route,payload,input};
}
test('ephemeral input: bounded audio, final text, duplicate launch, session binding and cancellation-before-start',async t=>{
 let count=0,resolve;const f=await fixture(t,async input=>{count++;assert.equal(input.sessionId,'aaaa');assert.equal(input.mimeType,'audio/mp4; codecs=mp4a.40.2');return new Promise(r=>resolve=r);});
 assert.equal((await f.call(f.route,{...f.payload,mimeType:'text/html'})).status,413);
 assert.equal((await f.call(f.route,{...f.payload,data:'A'.repeat(2000)})).status,413);
 assert.equal((await f.call(f.route,{...f.payload,revision:'old'})).status,409);
 assert.equal((await f.call(f.route,f.payload)).state,'pending');
 assert.equal((await f.call(f.route,f.payload)).state,'pending');assert.equal(count,1);
 assert.equal((await f.call(f.route,{...f.payload,data:'aGk='})).status,409);
 assert.equal((await f.call(f.route.replace('/aaaa/','/bbbb/'))).status,404);
 resolve('测试 English');await wait(async()=>((await f.call(f.route)).state==='done'));
 assert.equal((await f.call(f.route)).text,'测试 English');
 const cancel=f.route.slice(0,-36)+randomUUID();assert.equal((await f.call(cancel,undefined,'DELETE')).state,'cancelled');
 assert.equal((await f.call(cancel,f.payload)).state,'cancelled');assert.equal(count,1);
});
test('disable, deletion, lifecycle and late results cannot resurrect cancelled jobs',async t=>{
 let resolve;const f=await fixture(t,()=>new Promise(r=>resolve=r));
 await f.call(f.route,f.payload);f.dispose();resolve('late');await new Promise(r=>setTimeout(r,15));
 assert.equal((await f.call(f.route)).state,'cancelled');assert.equal((await f.call(f.route)).text,undefined);
 assert.equal((await f.call(f.route,f.payload)).status,409);
 const g=await fixture(t,()=>new Promise(r=>resolve=r));await g.call(g.route,g.payload);g.sessions.delete('aaaa');resolve('deleted');
 await new Promise(r=>setTimeout(r,15));assert.equal((await g.call(g.route)).status,403);
});
test('completion error is bounded and no transform retry is performed',async t=>{
 let count=0;const f=await fixture(t,async()=>{count++;throw Error('provider unavailable');});
 await f.call(f.route,f.payload);await wait(async()=>((await f.call(f.route)).state==='error'));
 assert.equal((await f.call(f.route)).error,'provider unavailable');await f.call(f.route,f.payload);assert.equal(count,1);
});
test('the catalog carries optional English labels and rejects malformed localization metadata', async t => {
 const presentation = {labelEn:'Voice input', descriptionEn:'Transcripts go into your draft'};
 const f = await fixture(t, async () => '', presentation);
 assert.equal(f.input.label, '语音');
 assert.equal(f.input.labelEn, presentation.labelEn);
 assert.equal(f.input.descriptionEn, presentation.descriptionEn);
 const register = f.service.bind('fixture', f.owner.signal).register;
 const prototype = {kind:'audio', label:'语音', description:'test', maxDuration:60, maxBytes:1000, transform:async () => ''};
 for (const malformed of [{labelEn:123}, {labelEn:' '}, {labelEn:'a'.repeat(81)}, {descriptionEn:null}, {descriptionEn:'a'.repeat(301)}]) {
  assert.throws(() => register('other', {...prototype, ...malformed}), /Invalid composer input/);
 }
 register('legacy', prototype);
 const catalog = await f.call('/aaaa/composer-inputs');
 assert(!Object.hasOwn(catalog[1], 'labelEn'));
 assert(!Object.hasOwn(catalog[1], 'descriptionEn'));
});
test('an optional bounded error code accompanies the legacy error until cancellation', async t => {
 for (const code of ['providerAuth', 'code with details', 'a'.repeat(41)]) {
  const f = await fixture(t, async () => { throw Object.assign(Error('legacy error text'), {code}); });
  await f.call(f.route, f.payload);
  const failed = await wait(async () => {
   const result = await f.call(f.route);
   if (result.state === 'error') return result;
  });
  assert.equal(failed.error, 'legacy error text');
  assert.equal(failed.errorCode, code === 'providerAuth' ? code : undefined);
  assert.deepEqual(await f.call(f.route, undefined, 'DELETE'), {status:200,state:'cancelled'});
 }
});
