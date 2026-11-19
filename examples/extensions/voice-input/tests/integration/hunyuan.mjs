import activate from '../../app.mjs';
import {wavBlob} from '../../../../../web/js/composer-pcm.js';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';import {randomUUID} from 'node:crypto';
import {createGateway} from '../../../../../remote/server.mjs';import {ComposerInputs} from '../../../../../dist/extensions/composer-inputs.js';import {SharedConversations} from '../../../../../dist/extensions/shared-conversations.js';import {DevicePublisher} from '../../../../../examples/extensions/multi-machine/publisher.mjs';
process.env.NODE_ENV='test';
test('TokenHub plugin through desktop HTTP and real remote gateway: formats, scoped access, cancellation and late results',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ashub-voice-sharing-'))),controller=new AbortController();let transforms=0,finish;
 const media=new ComposerInputs(controller.signal,id=>{assert(['aaaa','bbbb'].includes(id));});
 const config={endpoint:'https://tokenhub.tencentmaas.com/v1/wand/asrproxy/sync_transcribe',model:'hy-asr-3.0-preview',apiKey:'fixture-key'},originalFetch=globalThis.fetch;
 const managedData=Buffer.from(await wavBlob([new Int16Array([1, 2])], 2).arrayBuffer()).toString('base64');
 let expectedKey=config.apiKey, managedRoute;
 globalThis.fetch=async(url,opts)=>{
  if(String(url)==='https://ashub.aihao.world/mobile/voice/transcribe')return originalFetch(managedRoute,opts);
  if(String(url)!==config.endpoint)return originalFetch(url,opts);
  transforms++;assert.equal(opts.headers.Authorization,'Bearer '+expectedKey);assert.equal(opts.headers['Content-Type'],'application/json');assert.equal(opts.redirect,'error');
  assert.deepEqual(JSON.parse(opts.body),{model:config.model,data:Buffer.from('test audio').toString('base64')});
  return new Promise(resolve=>finish=()=>resolve(Response.json({status:'completed',output:{text:'remote transcript'}})));
 };
 let settings,saved=JSON.stringify(config);
 const plugin=activate({signal:controller.signal,services:{secrets:{available:true,read:()=>saved,write:(_,value)=>saved=value},interactions:{register:(_,r)=>settings=r},composerInputs:media.bind('speech',controller.signal)}});
 t.after(()=>{globalThis.fetch=originalFetch;plugin.stop();});
 const local=http.createServer(async(req,res)=>{
  if(await media.handle(req,res,async req=>{let raw='';for await(const c of req)raw+=c;return raw;}))return;
  if(req.url==='/sessions'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{instanceId:'aaaa',kind:'agent',cwd:dir},{instanceId:'bbbb',kind:'agent',cwd:os.tmpdir()}]));return;}
  res.writeHead(404);res.end('{}');
 });local.listen(0,'127.0.0.1');await once(local,'listening');
 const sharing=new SharedConversations(path.join(dir,'grants.json'));sharing.start(local.address().port);const grant=sharing.approve('devices',sharing.prepare('devices',{roots:[dir]}));const bound=sharing.bind('devices',controller.signal);
 const gateway=createGateway({
  database:path.join(dir,'db.sqlite'), publicUrl:'http://127.0.0.1/mobile/', testing:true,
  voiceConfig:{...config,apiKey:'managed-fixture-key'},
  voiceFetch:async(url,opts)=>{
   assert.equal(url,config.endpoint);
   assert.equal(opts.headers.Authorization,'Bearer managed-fixture-key');
   assert.deepEqual(JSON.parse(opts.body),{model:config.model,data:managedData});
   return Response.json({status:'completed',output:{text:'managed remote transcript'}});
  },
 });
 gateway.server.listen(0,'127.0.0.1');await once(gateway.server,'listening');
 const base='http://127.0.0.1:'+gateway.server.address().port+'/mobile/';
 managedRoute=base+'voice/transcribe';
 let publisher;
 t.after(async()=>{controller.abort();publisher?.stopConnection();local.closeAllConnections();local.close();await gateway.close();fs.rmSync(dir,{force:true,recursive:true});});
 const request=async(route,body,cookie)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],data:await r.json()};};
 const enrollment=await request('api/device/enroll',{username:'voice-user',password:'voice-integration-password',create:true,deviceName:'executor'});assert.equal(enrollment.status,200,JSON.stringify(enrollment));
 const identity={...enrollment.data,roots:[dir],grantId:grant,deviceName:'executor'};
 publisher=new DevicePublisher({dataDir:dir,gateway:base,store:{read:()=>JSON.stringify(identity),write(){}},access:id=>bound.open(id)});publisher.start();
 const user=await request('api/login',{username:'voice-user',password:'voice-integration-password'}),other=await request('api/register',{username:'another-user',password:'another-integration-password'});
 const wait=async fn=>{for(let i=0;i<150;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw Error('Timeout');};await wait(async()=>(await request('api/devices',undefined,user.cookie)).data[0]?.online);
 // Exercise the same plugin from the desktop's local HTTP route first.
 const localBase='http://127.0.0.1:'+local.address().port;
 const [localInput]=await (await fetch(localBase+'/aaaa/composer-inputs')).json();
 for(const mimeType of ['audio/wav','audio/mp4; codecs=mp4a.40.2','audio/mp4;codecs=opus','audio/webm;codecs=opus','audio/ogg;codecs=opus']) {
  const route=localBase+'/aaaa/composer-inputs/'+localInput.id+'/'+randomUUID();
  const r=await fetch(route,{method:'POST',body:JSON.stringify({revision:localInput.revision,data:Buffer.from('test audio').toString('base64'),mimeType})});
  assert.equal((await r.json()).state,'pending');finish();
  await wait(async()=>(await (await fetch(route)).json()).state==='done');assert.equal((await (await fetch(route)).json()).text,'remote transcript');
 }
 const beforeRemote=transforms;
 const rpc=(args,cookie=user.cookie)=>request('api/devices/'+identity.deviceId+'/rpc',{op:'composer-input',args:{session:'aaaa',...args}},cookie);
 const list=await rpc({action:'list'});assert.equal(list.status,200,JSON.stringify(list));assert.equal(list.data.length,1);
 assert.equal((await rpc({action:'list'},other.cookie)).status,404);assert.equal((await rpc({action:'list',session:'bbbb'})).status,403);
 const [input]=list.data,args={input:input.id,requestId:randomUUID(),revision:input.revision,data:Buffer.from('test audio').toString('base64'),mimeType:'audio/mp4'};
 assert.equal((await rpc({...args,action:'start'})).data.state,'pending');assert.equal((await rpc({...args,action:'start'})).data.state,'pending');assert.equal(transforms,beforeRemote+1);
 finish();await wait(async()=>(await rpc({...args,action:'status'})).data.state==='done');assert.equal((await rpc({...args,action:'status'})).data.text,'remote transcript');
 const cancelled={...args,requestId:randomUUID()};await rpc({...cancelled,action:'cancel'});assert.equal((await rpc({...cancelled,action:'start'})).data.state,'cancelled');assert.equal(transforms,beforeRemote+1);
 // Cancellation after upload, even if the provider ignores abort and succeeds late.
 const late={...args,requestId:randomUUID()};assert.equal((await rpc({...late,action:'start'})).data.state,'pending');
 const lateFinish=finish;await rpc({...late,action:'cancel'});
 const fresh={...args,requestId:randomUUID()};assert.equal((await rpc({...fresh,action:'start'})).data.state,'pending');const freshFinish=finish;
 lateFinish();await new Promise(r=>setTimeout(r,20));
 const receipt=(await rpc({...late,action:'status'})).data;assert.equal(receipt.state,'cancelled');assert.equal(receipt.text,undefined);
 assert.equal((await rpc({...fresh,action:'status'})).data.state,'pending');freshFinish();
 await wait(async()=>(await rpc({...fresh,action:'status'})).data.state==='done');assert.equal((await rpc({...fresh,action:'status'})).data.text,'remote transcript');
 // Confirmations opened in another desktop window cannot dispose the new input
 // registration or abort a remote recording made with the latest configuration.
 const oldClear=await settings.prepare('clear',{}),oldSave=await settings.prepare('save',{endpoint:config.endpoint,model:config.model});
 await (await settings.prepare('save',config)).execute();
 const [updated]=(await rpc({action:'list'})).data;assert.notEqual(updated.revision,input.revision);
 const current={...args,revision:updated.revision,requestId:randomUUID()};assert.equal((await rpc({...current,action:'start'})).data.state,'pending');
 assert.throws(()=>oldClear.execute(),/配置已变更/);assert.throws(()=>oldSave.execute(),/配置已变更/);
 assert.equal((await rpc({...current,action:'status'})).data.state,'pending');assert.deepEqual(JSON.parse(saved),config);finish();
 await wait(async()=>(await rpc({...current,action:'status'})).data.state==='done');
 // Clear while an old provider request is pending, rotate credentials, then
 // finish the old response while a new recording is awaiting its own result.
 const obsolete={...current,requestId:randomUUID()};assert.equal((await rpc({...obsolete,action:'start'})).data.state,'pending');const obsoleteFinish=finish;
 await (await settings.prepare('clear',{})).execute();assert.equal(saved,null);
 const [managed]=(await rpc({action:'list'})).data;
 assert.match(managed.description,/asHub 网关及腾讯混元/);
 assert.equal(managed.audioFormat, 'pcm-wav');
 const managedRequest={...args,revision:managed.revision,requestId:randomUUID(),data:managedData,mimeType:'audio/wav'};
 assert.equal((await rpc({...managedRequest,action:'start'})).data.state,'pending');
 await wait(async()=>(await rpc({...managedRequest,action:'status'})).data.state==='done');
 assert.equal((await rpc({...managedRequest,action:'status'})).data.text,'managed remote transcript');
 await assert.rejects(settings.prepare('save',{endpoint:config.endpoint,model:config.model}),/API Key/);
 expectedKey='rotated-fixture-key';await (await settings.prepare('save',{...config,apiKey:expectedKey})).execute();
 const [rotated]=(await rpc({action:'list'})).data;assert.notEqual(rotated.revision,updated.revision);
 const rerecorded={...args,revision:rotated.revision,requestId:randomUUID()};assert.equal((await rpc({...rerecorded,action:'start'})).data.state,'pending');const rerecordedFinish=finish;
 obsoleteFinish();await new Promise(r=>setTimeout(r,20));
 const obsoleteResult=(await rpc({...obsolete,action:'status'})).data;assert.equal(obsoleteResult.state,'cancelled');assert.equal(obsoleteResult.text,undefined);
 assert.equal((await rpc({...rerecorded,action:'status'})).data.state,'pending');rerecordedFinish();
 await wait(async()=>(await rpc({...rerecorded,action:'status'})).data.state==='done');assert.equal((await rpc({...rerecorded,action:'status'})).data.text,'remote transcript');
 assert(!fs.existsSync(path.join(dir,'remote-requests.json')),'media/audio are not journaled as message sends');
 bound.revoke(grant);assert.notEqual((await rpc({action:'list'})).status,200);
});
