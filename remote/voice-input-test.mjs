import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';import {randomUUID} from 'node:crypto';
import {createGateway} from './server.mjs';import {ComposerInputs} from '../dist/extensions/composer-inputs.js';import {SharedConversations} from '../dist/extensions/shared-conversations.js';import {DevicePublisher} from '../examples/extensions/multi-machine/publisher.mjs';
import {transcribeWithDefault} from '../examples/extensions/voice-input/app.mjs';
import {wavBlob} from '../web/js/composer-pcm.js';
process.env.NODE_ENV='test';
test('real gateway -> optional publisher -> scoped channel -> media host: ownership, cancellation, no conversation send or audio journal',async t=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ashub-voice-sharing-'))),controller=new AbortController();let transforms=0,finish;
 const media=new ComposerInputs(controller.signal,id=>{assert(['aaaa','bbbb'].includes(id));});
 media.bind('speech',controller.signal).register('dictate',{label:'语音',description:'fixture',kind:'audio',maxDuration:60,maxBytes:4000000,transform:async({signal})=>{transforms++;return new Promise(resolve=>finish=()=>resolve(signal.aborted?'late':'remote transcript'));}});
 const local=http.createServer(async(req,res)=>{
  if(await media.handle(req,res,async req=>{let raw='';for await(const c of req)raw+=c;return raw;}))return;
  if(req.url==='/sessions'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{instanceId:'aaaa',kind:'agent',cwd:dir},{instanceId:'bbbb',kind:'agent',cwd:os.tmpdir()}]));return;}
  res.writeHead(404);res.end('{}');
 });local.listen(0,'127.0.0.1');await once(local,'listening');
 const sharing=new SharedConversations(path.join(dir,'grants.json'));sharing.start(local.address().port);const grant=sharing.approve('devices',sharing.prepare('devices',{roots:[dir]}));const bound=sharing.bind('devices',controller.signal);
 const gateway=createGateway({database:path.join(dir,'db.sqlite'),publicUrl:'http://127.0.0.1/mobile/',testing:true});gateway.server.listen(0,'127.0.0.1');await once(gateway.server,'listening');const base='http://127.0.0.1:'+gateway.server.address().port+'/mobile/';
 let publisher;
 t.after(async()=>{controller.abort();publisher?.stopConnection();local.closeAllConnections();local.close();await gateway.close();fs.rmSync(dir,{force:true,recursive:true});});
 const request=async(route,body,cookie)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],data:await r.json()};};
 const enrollment=await request('api/device/enroll',{username:'voice-user',password:'voice-integration-password',create:true,deviceName:'executor'});assert.equal(enrollment.status,200,JSON.stringify(enrollment));
 const identity={...enrollment.data,roots:[dir],grantId:grant,deviceName:'executor'};
 publisher=new DevicePublisher({dataDir:dir,gateway:base,store:{read:()=>JSON.stringify(identity),write(){}},access:id=>bound.open(id)});publisher.start();
 const user=await request('api/login',{username:'voice-user',password:'voice-integration-password'}),other=await request('api/register',{username:'another-user',password:'another-integration-password'});
 const wait=async fn=>{for(let i=0;i<150;i++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw Error('Timeout');};await wait(async()=>(await request('api/devices',undefined,user.cookie)).data[0]?.online);
 const rpc=(args,cookie=user.cookie)=>request('api/devices/'+identity.deviceId+'/rpc',{op:'composer-input',args:{session:'aaaa',...args}},cookie);
 const list=await rpc({action:'list'});assert.equal(list.status,200,JSON.stringify(list));assert.equal(list.data.length,1);
 assert.equal((await rpc({action:'list'},other.cookie)).status,404);assert.equal((await rpc({action:'list',session:'bbbb'})).status,403);
 const [input]=list.data,args={input:input.id,requestId:randomUUID(),revision:input.revision,data:Buffer.from('test audio').toString('base64'),mimeType:'audio/mp4'};
 assert.equal((await rpc({...args,action:'start'})).data.state,'pending');assert.equal((await rpc({...args,action:'start'})).data.state,'pending');assert.equal(transforms,1);
 finish();await wait(async()=>(await rpc({...args,action:'status'})).data.state==='done');assert.equal((await rpc({...args,action:'status'})).data.text,'remote transcript');
 const cancelled={...args,requestId:randomUUID()};await rpc({...cancelled,action:'cancel'});assert.equal((await rpc({...cancelled,action:'start'})).data.state,'cancelled');assert.equal(transforms,1);
 assert(!fs.existsSync(path.join(dir,'remote-requests.json')),'media/audio are not journaled as message sends');
 bound.revoke(grant);assert.notEqual((await rpc({action:'list'})).status,200);
});

test('managed voice uses only the server credential, limits usage across restarts and leaves other APIs intact', async t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-managed-voice-'));
 const endpoint = 'https://tokenhub.tencentmaas.com/v1/wand/asrproxy/sync_transcribe';
 const voiceConfig = { endpoint, model: 'hy-asr-3.0-preview', apiKey: 'fixture-shared-key', dailyLimit: 2, dailyIpLimit: 1 };
 const wav = async samples => Buffer.from(await wavBlob([new Int16Array(samples)], samples).arrayBuffer());
 const audio = { data: await wav(60 * 16000), mimeType: 'audio/wav' };
 let gateway, address, attempts = 0;
 t.after(async () => {
  await gateway?.close();
  fs.rmSync(dir, {recursive:true, force:true});
 });
 async function start(config) {
  gateway = createGateway({
   database: path.join(dir, 'db.sqlite'), publicUrl: 'http://127.0.0.1/mobile/',
   testing: true, voiceConfig: config,
   voiceFetch: async (url, options) => {
    assert.equal(url, endpoint);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-shared-key');
    assert.deepEqual(JSON.parse(options.body), {model: 'hy-asr-3.0-preview', data: audio.data.toString('base64')});
    attempts++;
    if (attempts === 2) return new Response('fixture-shared-key', {status: 401});
    return Response.json({status: 'completed', output: {text: ' 转写文本 ', unrelated: 'private provider metadata'}});
   },
  });
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  address = 'http://127.0.0.1:' + gateway.server.address().port + '/mobile/';
 }
 const payload = {mimeType: audio.mimeType, data: audio.data.toString('base64')};
 const post = (data, headers = {}) => fetch(address + 'voice/transcribe', {
  method: 'POST', headers: {'Content-Type':'application/json', ...headers}, body: JSON.stringify(data),
 });
 await start(undefined);
 const disabled = await post(payload);
 assert.equal(disabled.status, 503);
 await disabled.json();
 assert.equal((await fetch(address + 'health')).status, 200);
 await gateway.close();

 await start(voiceConfig);
 const rejectedOrigin = await post(payload, {Origin: 'https://other.test'});
 assert.equal(rejectedOrigin.status, 403);
 await rejectedOrigin.json();
 const malformed = await post({...payload, data:'!!!'});
 assert.equal(malformed.status, 400);
 await malformed.json();
 const compressed = await post({...payload, mimeType:'audio/webm'});
 assert.equal(compressed.status, 400);
 await compressed.json();
 const inconsistent = await post({...payload, data:audio.data.subarray(0, 48).toString('base64')});
 assert.equal(inconsistent.status, 400);
 await inconsistent.json();
 const tooLong = await post({...payload, data:(await wav(60 * 16000 + 1)).toString('base64')});
 assert.equal(tooLong.status, 413);
 await tooLong.json();
 assert.equal(attempts, 0);
 const text = await transcribeWithDefault({...audio, signal: new AbortController().signal}, async (url, options) => {
  assert.equal(url, 'https://ashub.aihao.world/mobile/voice/transcribe');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(options.body), payload);
  return fetch(address + 'voice/transcribe', options);
 });
 assert.equal(text, '转写文本');
 assert.equal(attempts, 1);
 await gateway.close();

 await start(voiceConfig);
 const sameIp = await post(payload);
 assert.equal(sameIp.status, 429);
 await sameIp.json();
 const otherIp = await post({...payload, endpoint: 'https://ignored.test', apiKey:'ignored', model:'ignored'}, {'X-Real-IP': '192.0.2.1'});
 assert.equal(otherIp.status, 502);
 assert.deepEqual(await otherIp.json(), {error:'asHub 免费转写暂不可用'});
 const exhausted = await post(payload, {'X-Real-IP': '192.0.2.2'});
 assert.equal(exhausted.status, 429);
 await exhausted.json();
 assert.equal(attempts, 2);
});
