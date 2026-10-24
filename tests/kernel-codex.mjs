import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const watchdog = setTimeout(() => { console.error('Codex integration timed out'); process.exit(1); }, 30000);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashub-codex-audit-'));
process.env.AGENT_SH_HOME = dir;
process.env.ASHUB_TOKEN = 'isolated-audit-token';
if (process.platform !== 'win32') {
 const shell=path.join(dir,'clean-bash');
 await fs.writeFile(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', {mode:0o755});
 process.env.SHELL=shell;
}
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key) || key === 'OPENAI_BASE_URL') delete process.env[key];
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('External requests disabled');
  return originalFetch(input, init);
};
const upstreamBodies = [];
const upstreamSessions = [];
let cachedTokens = 5;
const upstream = http.createServer(async (req, res) => {
  let raw=''; for await (const part of req) raw += part;
  upstreamBodies.push(JSON.parse(raw));
  upstreamSessions.push(req.headers.session_id);
  if (req.url === '/v1/chat/completions') {
    if (!JSON.parse(raw).stream) {
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'API_PROVIDER_OK'}}]}));
      return;
    }
    res.writeHead(200, {'content-type':'text/event-stream'});
    for (const chunk of [
      {choices:[{index:0,delta:{role:'assistant',content:'API_PROVIDER_OK'},finish_reason:null}]},
      {choices:[{index:0,delta:{},finish_reason:'stop'}]},
    ]) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end('data: [DONE]\n\n');
    return;
  }
  res.writeHead(200, {'content-type':'text/event-stream'});
  for (const ev of [
    {type:'response.output_text.delta',delta:'CODEX_PROXY_OK'},
    {type:'response.completed',response:{status:'completed',usage:{input_tokens:10,output_tokens:3,
      ...(cachedTokens === undefined ? {} : {input_tokens_details:{cached_tokens:cachedTokens}}),
      diagnostic_secret:'must never be retained'}}},
  ]) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  res.end();
});
upstream.listen(0, '127.0.0.1'); await once(upstream,'listening');
await fs.writeFile(path.join(dir,'settings.json'), JSON.stringify({defaultProvider:'codex',startupBanner:false,'codex-provider':{models:['audit-codex-model','gpt-5.4'],upstreamURL:`http://127.0.0.1:${upstream.address().port}/responses`}}));
await fs.mkdir(path.join(dir,'codex-provider'));
// Fake credentials only; no real account login or token is read.
await fs.writeFile(path.join(dir,'codex-provider/auth.json'), JSON.stringify({access:'fake-audit-access',refresh:'fake-audit-refresh',accountId:'fake-audit-account',expires:Date.now()+3600000}));
const { AshBridge } = await import('../dist/bridges/ash.js');
const { startHub } = await import('../dist/hub.js');
const bridges=[];
const hub=startHub({host:'127.0.0.1',port:0,webRoot:path.resolve('web'),makeBridge:opts=>{const b=new AshBridge(opts);bridges.push(b);return b;}});
await once(hub.server,'listening');
const url=`http://127.0.0.1:${hub.server.address().port}`;
const headers={Authorization:'Bearer isolated-audit-token','Content-Type':'application/json'};
try {
  const response=await fetch(url+'/sessions',{method:'POST',headers,body:JSON.stringify({cwd:dir})});
  const session=await response.json(); assert(response.ok,JSON.stringify(session));
  const b=bridges[0]; await b.ready();
  const models=await b.getModels();
  assert(models.models.some(m=>m.provider==='codex'));
  console.log('PASS real AshBridge registers built-in codex from isolated credentials');
  const infoFrames=[];
  const unsubscribe=b.onEvent(e=>{if(e.name==='agent:info' && e.payload.model)infoFrames.push(e.payload);});
  const unregister=b.extCtx.agent.providers.register({
    id:'same-model-api',apiKey:'fake-api-key',baseURL:`http://127.0.0.1:${upstream.address().port}/v1`,
    defaultModel:'audit-codex-model',models:[{id:'audit-codex-model',contextWindow:8192,modalities:['text']}],
  });
  try {
    await b.execCommand('/model','audit-codex-model@same-model-api');
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(infoFrames.at(-1).provider,'same-model-api');
    assert.deepEqual(infoFrames.at(-1).modalities,['text']);
    const messages=()=>[{role:'user',content:[{type:'text',text:'Describe this'},
      {type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]}];
    const textOnly=b.core.handlers.call('conversation:prepare',messages());
    assert.equal(textOnly[0].content.length,1,'text-only provider strips unsupported images');
    await b.execCommand('/model','audit-codex-model@codex');
    const multimodal=b.core.handlers.call('conversation:prepare',messages());
    assert.equal(multimodal[0].content.length,2,'Codex retains images despite a matching API model ID');
    assert.deepEqual(infoFrames.at(-1).modalities,['text','image']);
    console.log('PASS same model IDs retain provider-specific UI and conversation image capabilities');
  } finally { unregister(); unsubscribe(); }
  await b.execCommand('/model','gpt-5.4@codex');
  const thinkingURL=url+'/'+session.instanceId+'/thinking';
  const nativeState=await (await fetch(thinkingURL,{headers})).json();
  assert.deepEqual(nativeState.levels,['low','medium','high','xhigh']);
  const selected=await fetch(thinkingURL,{method:'POST',headers,body:JSON.stringify({model:'gpt-5.4',provider:'codex',level:'xhigh'})});
  assert.equal(selected.status,200); assert.equal((await selected.json()).level,'xhigh');
  await b.submit('Verify native reasoning request');
  assert.equal(upstreamBodies.at(-1).reasoning.effort,'xhigh');
  const thinkingRestore=b.getRestoreState();
  assert(thinkingRestore.thinkingSelections.some(([key,value])=>key.includes('gpt-5.4')&&value==='xhigh'));
  await b.complete([{role:'user',content:'Independent title budget'}]);
  assert.notEqual(upstreamBodies.at(-1).reasoning?.effort,'xhigh','main reasoning must not leak into title generation');
  const invalid=await fetch(thinkingURL,{method:'POST',headers,body:JSON.stringify({level:'ultra'})});
  assert.equal(invalid.status,400);
  await b.execCommand('/model','audit-codex-model@codex');
  assert.equal(b.getThinking().supported,false,'unknown models do not inherit a universal ladder');
  const restoredThinkingBridge=new AshBridge({cwd:dir,restoreState:thinkingRestore}); bridges.push(restoredThinkingBridge);
  await restoredThinkingBridge.ready();await restoredThinkingBridge.execCommand('/model','gpt-5.4@codex');
  assert.equal(restoredThinkingBridge.getThinking().level,'xhigh');
  assert.equal(restoredThinkingBridge.readOnlyContext,false);restoredThinkingBridge.close();
  console.log('PASS native thinking API, actual Codex request, session restore and independent completion budgets');
  const usageFrames=[];
  b.onEvent(e=>{if(e.name==='agent:usage')usageFrames.push(e.payload)});
  await b.submit('Local mock response only');
  assert(JSON.stringify((await b.snapshot()).messages).includes('CODEX_PROXY_OK'));
  assert.equal(upstreamBodies.at(-1).model,'audit-codex-model');
  console.log('PASS main conversation travels through Codex Responses proxy');
  assert.equal(upstreamBodies.at(-1).prompt_cache_key,session.instanceId);
  assert.equal(upstreamSessions.at(-1),session.instanceId);
  assert.equal(usageFrames.at(-1).prompt_cache_hit_tokens,5);
  assert.equal(usageFrames.at(-1).cache_reported,true);
  assert.equal(usageFrames.at(-1).codex_usage.input_tokens_details.cached_tokens,5);
  assert(!JSON.stringify(usageFrames).includes('must never be retained'));
  cachedTokens=0;await b.submit('Explicit zero cache');
  assert.equal(usageFrames.at(-1).cache_reported,true);
  assert.equal(usageFrames.at(-1).prompt_cache_hit_tokens,0);
  assert.equal(usageFrames.at(-1).prompt_cache_miss_tokens,10);
  cachedTokens=undefined;await b.submit('Missing cache information');
  assert.equal(usageFrames.at(-1).cache_reported,false);
  assert.equal(usageFrames.at(-1).prompt_cache_hit_tokens,undefined);
  assert.equal(usageFrames.at(-1).cached_prompt_tokens,undefined);
  assert.equal(upstreamBodies.at(-1).prompt_cache_key,session.instanceId);
  cachedTokens=5;
  console.log('PASS stable session headers and cache keys; raw positive/zero/missing usage stays distinct');
  const child=await b.core.handlers.call('subagent:run',{task:'Local mock child',systemPrompt:'Reply briefly',tools:[],maxIterations:2});
  assert(JSON.stringify(child).includes('CODEX_PROXY_OK'));
  console.log('PASS subagent travels through Codex Responses proxy');
  assert.equal(await b.complete([{role:'user',content:'Local mock completion'}]),'CODEX_PROXY_OK');
  console.log('PASS non-streaming completion travels through Codex Responses proxy');
  const catalog=await (await fetch(url+'/api/models',{headers})).json();
  const cfg=await (await fetch(url+'/api/config',{headers})).json();
  assert(catalog.providers.some(p=>p.name==='codex'));
  console.log('PASS signed-in Codex appears in Hub model catalog');
  assert.equal(cfg.anyProviderConfigured,true);
  assert(!JSON.stringify(cfg).includes('fake-audit-access'));
  console.log('PASS OAuth-only configuration bypasses API key onboarding without leaking tokens');
  const endpoint=b.core.handlers.call('agent:resolve-endpoint',{provider:'codex',id:'audit-codex-model'});
  b.close();
  let leaked=false;
  try {const r=await fetch(endpoint.baseURL+'/chat/completions',{method:'POST',body:'{}',signal:AbortSignal.timeout(1500)});leaked=r.status===401;} catch {}
  assert.equal(leaked,false);
  console.log('PASS session close releases Codex proxy listener');

  // Existing sessions must gain models after another session signs in.
  await fs.rm(path.join(dir,'codex-provider/auth.json'));
  const late = new AshBridge({cwd:dir}); bridges.push(late); await late.ready();
  assert(!(await late.getModels()).models.some(m=>m.provider==='codex'));
  await fs.writeFile(path.join(dir,'codex-provider/auth.json'), JSON.stringify({access:'fake-access-2',refresh:'fake-refresh-2',accountId:'fake-account-2',expires:Date.now()+3600000}));
  let releaseActivation, activationStarted;
  const activationGate=new Promise(resolve=>releaseActivation=resolve);
  const started=new Promise(resolve=>activationStarted=resolve);
  const activateBackend=late.core.activateBackend.bind(late.core);
  late.core.activateBackend=async()=>{activationStarted();await activationGate;return activateBackend();};
  const firstDiscovery=late.getModels();await started;
  let secondFinished=false;
  const secondDiscovery=late.getModels().then(result=>{secondFinished=true;return result;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(secondFinished,false,'concurrent discovery must await backend activation');
  releaseActivation();await Promise.all([firstDiscovery,secondDiscovery]);
  late.core.activateBackend=activateBackend;
  await late.execCommand('/model', 'audit-codex-model@codex');
  await late.submit('First request after sign-in');
  assert(JSON.stringify((await late.snapshot()).messages).includes('CODEX_PROXY_OK'));
  const firstEndpoint=late.core.handlers.call('agent:resolve-endpoint',{provider:'codex',id:'audit-codex-model'});
  await late.core.handlers.call('command:/codex-logout','');
  assert(!(await late.getModels()).models.some(m=>m.provider==='codex'));
  assert.equal((await (await fetch(url+'/api/config',{headers})).json()).anyProviderConfigured,false);
  await assert.rejects(fetch(firstEndpoint.baseURL+'/chat/completions',{signal:AbortSignal.timeout(1500)}));
  await fs.writeFile(path.join(dir,'codex-provider/auth.json'), JSON.stringify({access:'fake-access-3',refresh:'fake-refresh-3',accountId:'fake-account-3',expires:Date.now()+3600000}));
  await late.submit('Request after signing back in');
  assert.equal(upstreamBodies.at(-1).model,'audit-codex-model');
  console.log('PASS late sign-in, concurrent discovery, sign-out and re-login reuse the session safely');

  const { updateSettings } = await import('agent-sh/settings');
  updateSettings({defaultProvider:'api-fixture',providers:{'api-fixture':{
    apiKey:'fake-fixture-key',baseURL:`http://127.0.0.1:${upstream.address().port}/v1`,
    defaultModel:'api-fixture-model',models:['api-fixture-model'],
  }},'codex-provider':{models:'malformed-extension-setting'}});
  // A broken optional Codex extension must not prevent a healthy API session.
  const independent=new AshBridge({cwd:dir});bridges.push(independent);
  const loadErrors=[];
  independent.onEvent(e=>{if(e.name==='ui:error' && e.payload.message?.includes('Codex provider'))loadErrors.push(e.payload.message);});
  await independent.ready();
  assert((await independent.getModels()).models.some(m=>m.provider==='api-fixture'));
  await independent.submit('Use the independent API fixture');
  assert(JSON.stringify((await independent.snapshot()).messages).includes('API_PROVIDER_OK'));
  assert.equal(await independent.complete([{role:'user',content:'API completion'}]),'API_PROVIDER_OK');
  assert.equal(loadErrors.length,1,'repeated discovery and requests must not repeat the same extension error');
  // The already active Codex session should fail clearly, but allow switching away.
  // Keep its preferred provider Codex so the kernel does not select the new API default.
  updateSettings({defaultProvider:'codex'});
  await assert.rejects(late.submit('Broken Codex must not use a stale endpoint'),/Codex provider/);
  await late.execCommand('/model','api-fixture-model@api-fixture');
  await late.submit('Continue with the independent provider');
  assert(JSON.stringify((await late.snapshot()).messages).includes('API_PROVIDER_OK'));
  updateSettings({'codex-provider':{models:['audit-codex-model']}});
  assert((await independent.getModels()).models.some(m=>m.provider==='codex'));
  await independent.execCommand('/model','audit-codex-model@codex');
  await independent.submit('Codex after repairing configuration');
  assert(JSON.stringify((await independent.snapshot()).messages).includes('CODEX_PROXY_OK'));
  console.log('PASS optional Codex failure isolates API sessions, permits switching away and recovers after repair');
  independent.close();
  late.close();
} finally {
  for(const b of bridges)b.close();
  await hub.shutdown(); upstream.closeAllConnections(); await new Promise(r=>upstream.close(r));
  await fs.rm(dir,{recursive:true,force:true});
  clearTimeout(watchdog);
}
