import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-bg-route-settings-'));
process.env.AGENT_SH_HOME = settingsDir;
process.on('exit', () => fs.rmSync(settingsDir, {recursive:true,force:true}));
const { AshBridge } = await import('../dist/bridges/ash.js');
const { createPolicyFetch, withNetworkSession } = await import('../dist/network-policy.js');

function fixture() {
  class TestBridge extends AshBridge { async init() {} }
  const bridge = new TestBridge({sessionId:'assistant-fixture',cwd:settingsDir});
  const models = [], endpoints = new Map();
  bridge.core = {handlers:{call(name, selection) {
    if (name === 'agent:get-models') return models;
    if (name === 'agent:resolve-endpoint') return endpoints.get(selection.provider);
    throw Error(`Specified inference cannot use the foreground handler ${name}`);
  }}};
  const register = (provider,endpoint,modalities) => {
    models.push({provider,id:'shared-model',modalities});
    endpoints.set(provider, endpoint);
    return {provider,model:'shared-model'};
  };
  return {bridge,endpoints,register};
}

async function endpoint(t, callback) {
  const requests = [];
  const server = http.createServer(async (req,res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = {path:req.url, headers:req.headers, body:JSON.parse(Buffer.concat(chunks).toString())};
    requests.push(request);
    const finish = () => {
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      const chunk = {
        id:'local-fixture',object:'chat.completion.chunk',created:1,model:'shared-model',
        choices:[{index:0,delta:{content:'{"memories":[]}'},finish_reason:'stop'}],
      };
      const usage = {...chunk,choices:[],usage:{prompt_tokens:27,completion_tokens:4}};
      res.end('data: '+JSON.stringify(chunk)+'\n\ndata: '+JSON.stringify(usage)+'\n\ndata: [DONE]\n\n');
    };
    if (callback) callback(finish); else finish();
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => {server.closeAllConnections();server.close();});
  return {base:`http://127.0.0.1:${server.address().port}`,requests};
}

const messages = [{role:'user',content:'合成整理请求'}];

test('specified inference routes the exact registered pair to an isolated client on the owning network scope',async t=>{
  const {base,requests}=await endpoint(t);
  const {bridge,endpoints,register}=fixture();
  const front=register('foreground-fixture',{apiKey:'foreground-fixture-key',baseURL:base+'/foreground/v1'});
  const selected=register('organizer-fixture',{apiKey:'organizer-fixture-key',baseURL:base+'/organizer/v1',
    buildRequestHeaders:({sessionId})=>({'X-Fixture-Session':sessionId})});
  register('missing-credentials',{baseURL:base+'/missing/v1'});
  register('missing-endpoint',{apiKey:'fixture'});
  register('image-only',{apiKey:'image-fixture',baseURL:base+'/image/v1'},['image']);
  assert.deepEqual(await bridge.backgroundModels(),[front,selected]);
  const approved=await bridge.describeBackgroundModel(selected);
  assert.equal(approved.origin,base);
  assert.match(approved.identity,/^[a-f0-9]{64}$/);
  const originalFetch=globalThis.fetch, network=[];
  globalThis.fetch=createPolicyFetch((...args)=>{network.push('proxy');return originalFetch(...args);},
    (...args)=>{network.push('direct');return originalFetch(...args);},
    ()=>({proxyEnabled:true,sessions:{'assistant-fixture':false,'other-fixture':true}}));
  t.after(()=>{globalThis.fetch=originalFetch;});
  const usage=[];
  const invoke=()=>bridge.backgroundCompleteSpecified(messages,new AbortController().signal,selected,approved.identity,value=>usage.push(value));
  assert.equal(await withNetworkSession('other-fixture',invoke),'{"memories":[]}');
  assert.deepEqual(network,['direct']);
  assert.equal(requests[0].path,'/organizer/v1/chat/completions');
  assert.equal(requests[0].headers.authorization,'Bearer organizer-fixture-key');
  assert.equal(requests[0].headers['x-fixture-session'],'assistant-fixture:background');
  assert.equal(requests[0].body.model,selected.model);
  assert.equal(requests[0].body.max_tokens,4096);
  assert(!('tools' in requests[0].body));
  assert.deepEqual(requests[0].body.messages,messages);
  assert.deepEqual(usage,[{inputTokens:27,outputTokens:4}]);

  endpoints.get(selected.provider).baseURL=base+'/different-service/v1';
  await assert.rejects(invoke,/服务已变化/);
  endpoints.delete(selected.provider);
  await assert.rejects(invoke,/后台模型不可用/);
  assert.equal(requests.length,1,'an invalid or changed selection cannot fall back to the foreground endpoint');
});

test('in-flight specified inference discards its reply when the authorized transport changes',async t=>{
  let received;
  const started = new Promise(resolve=>{received=resolve;});
  const {base,requests}=await endpoint(t,received);
  const {bridge,endpoints,register}=fixture();
  const selected=register('delayed-organizer',{apiKey:'old-fixture-key',baseURL:base+'/first/v1'});
  const approved=await bridge.describeBackgroundModel(selected);
  const pending=bridge.backgroundCompleteSpecified(messages,new AbortController().signal,selected,approved.identity);
  const finish=await started;
  endpoints.get(selected.provider).apiKey='replacement-fixture-key';
  finish();
  await assert.rejects(pending,/配置已变化/);
  assert.equal(requests.length,1);
  assert.equal(bridge.specifiedBackgroundControllers.size,0);
});

test('a new loopback port is a new destination and a previous authorization cannot reach it',async t=>{
  const firstServer=await endpoint(t), secondServer=await endpoint(t);
  const {bridge,endpoints,register}=fixture();
  const selected=register('local-endpoint-fixture',{apiKey:'fixture-key',baseURL:firstServer.base+'/v1'});
  const first=await bridge.describeBackgroundModel(selected);
  endpoints.get(selected.provider).baseURL=secondServer.base+'/v1';
  const changed=await bridge.describeBackgroundModel(selected);
  assert.equal(changed.origin,secondServer.base);
  assert.notEqual(changed.identity,first.identity);
  await assert.rejects(bridge.backgroundCompleteSpecified(messages,new AbortController().signal,selected,first.identity),/服务已变化/);
  assert.equal(secondServer.requests.length,0);
  assert.equal(await bridge.backgroundCompleteSpecified(messages,new AbortController().signal,selected,changed.identity),'{"memories":[]}');
  assert.equal(secondServer.requests.length,1);
  assert.equal(firstServer.requests.length,0);
});

test('Codex authorization identifies its configured upstream and survives a new loopback proxy port',async()=>{
  const dir=path.join(settingsDir,'codex-provider');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'auth.json'),JSON.stringify({access:'fixture',refresh:'fixture',accountId:'fixture',expires:1}));
  const {bridge,endpoints,register}=fixture();
  bridge.codexHost={lastRegisteredProviderId:'codex'};
  const selected=register('codex',{apiKey:'local-fixture',baseURL:'http://127.0.0.1:12301/v1'});
  const first=await bridge.describeBackgroundModel(selected);
  assert.equal(first.origin,'https://chatgpt.com');
  endpoints.get(selected.provider).baseURL='http://127.0.0.1:12302/v1';
  assert.deepEqual(await bridge.describeBackgroundModel(selected),first);
  fs.unlinkSync(path.join(dir,'auth.json'));
  assert.equal(await bridge.describeBackgroundModel(selected),null);
});
