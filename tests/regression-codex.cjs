const test = require('node:test');
const assert = require('node:assert/strict');
const { env, fs, path, Res } = require('./harness.cjs');

const credentials = { access: 'fixture-access', refresh: 'fixture-refresh', accountId: 'fixture-account', expires: 1 };
test('asHub supplies a 15 minute Codex header default while preserving explicit overrides', async () => {
  for (const override of [{}, {headersTimeoutMs:1234}]) {
    let config, other;
    const x=setup({'agent-sh/extensions':{BUILTIN_EXTENSIONS:[{name:'codex-provider',load:async()=>async ctx=>{
      config=ctx.getExtensionSettings('codex-provider',{headersTimeoutMs:600000,idleTimeoutMs:1800000});
      other=ctx.getExtensionSettings('other',{headersTimeoutMs:22});
    }}]}});
    const host=new x.module.CodexProviderHost({call:()=>null,list:()=>[],agent:{providers:{}},
      getExtensionSettings:(name, defaults)=>({...defaults,...(name==='codex-provider'?override:{})}),
    });
    try {await host.sync();assert.equal(config.headersTimeoutMs,override.headersTimeoutMs??900000);
      assert.equal(config.idleTimeoutMs,1800000);assert.equal(other.headersTimeoutMs,22);
    } finally {host.close();}
  }
});
function setup(modules = {}) {
  const e = env({ modules });
  let settings = {};
  e.settings.getSettings = () => settings;
  e.auth.anyProviderConfigured = () => false;
  const file = path.join(e.dir, 'codex-provider/auth.json');
  fs.mkdirSync(path.dirname(file));
  const write = value => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  const module = e.load('src/providers/codex.ts');
  return { e, file, write, module, settings: value => { settings = value; } };
}

test('OAuth readiness handles missing, corrupt, expired renewable and disabled credentials', async () => {
  const x = setup();
  assert.equal(x.module.codexStatus().configured, false);
  for (const value of ['broken', 'null', {}, {...credentials, access:''}, {...credentials, expires:'1'}]) {
    x.write(value); assert.equal(x.module.codexStatus().configured,false);
  }
  x.write(credentials);
  assert.equal(x.module.codexStatus().configured,true,'expired access token with a refresh token remains configured');
  x.settings({disabledBuiltins:['codex-provider']});
  assert.equal(x.module.codexStatus().configured,false);
  x.settings({'codex-provider':{providerId:'subscription'}});
  assert.equal(x.module.codexStatus().providerId,'subscription');
  const h=x.e.load('src/hub.ts','export const audit={getConfig};').audit;
  const res=new Res();const done=new Promise(resolve=>res.once('finish',resolve));h.getConfig(res);await done;
  assert.equal(res.json().anyProviderConfigured,true);
  assert(!res.body.includes(credentials.access));
});

test('model catalog merges runtime-only providers across sessions and invalidates on provider events', async () => {
  const x=setup();
  const h=x.e.load('src/hub.ts','export const audit={getModels,routeEvent};').audit;
  let second=[{model:'chat-model',provider:'codex',modalities:['text','image']}];
  const sessions=new Map([['one',{kind:'agent',bridge:{getModels:async()=>({models:[{model:'first',provider:'custom'}]})}}],['two',{kind:'agent',bridge:{getModels:async()=>({models:second})}}]]);
  const get=async(url='/api/models')=>{const r=new Res();await h.getModels({url},r,sessions);return r;};
  assert.deepEqual(JSON.parse((await get()).body).providers.map(p=>p.name),['custom','codex']);
  assert.equal((await get('/api/models/codex')).json().models[0].id,'chat-model');
  second=[];
  // No replay needed: the closed guard is tested elsewhere. Use the normal
  // session event path so cache invalidation is exercised, not called directly.
  const session={id:'two',kind:'agent',segmentSeq:0,replay:[],sseClients:new Set(),_replayBuf:[],eventCount:0};
  h.routeEvent(session,{name:'agent:providers:changed',payload:{}});
  assert(!(await get()).json().providers.some(p=>p.name==='codex'));
});

test('Codex resource lifetime closes late proxies and ignores late registrations', async () => {
  let context, release, loads=0, registrations=0, closes=0;
  const ready=new Promise(resolve=>release=resolve);
  const x=setup({'agent-sh/extensions':{BUILTIN_EXTENSIONS:[{name:'codex-provider',load:async()=>async ctx=>{
    loads++;context=ctx;let proxy=false;
    ctx.onDispose(()=>{if(proxy){closes++;proxy=false;}});
    await ready;
    proxy=true;
    ctx.onDispose(ctx.agent.providers.register({id:'codex'}));
  }}]}});
  const host=new x.module.CodexProviderHost({
    call:()=>null,list:()=>[],registerCommand(){},bus:{emit(){}},
    agent:{providers:{register(){registrations++;return()=>{registrations--;};}}},
  });
  const first=host.sync(),second=host.sync();
  await new Promise(resolve=>setImmediate(resolve));
  assert(context);host.close();host.close();release();await Promise.all([first,second]);
  assert.equal(loads,1);assert.equal(registrations,0);assert.equal(closes,1);
});

test('provider change frames invalidate the frontend model cache and notify its consumers', () => {
  const { ts, vm, root }=require('./harness.cjs');
  const { ui }=require('./ui-harness.cjs');
  const u=ui();
  const source=ts.createSourceFile('sse.js',fs.readFileSync(path.join(root,'web/js/sse.js'),'utf8'),ts.ScriptTarget.Latest,true);
  let handler, invalidate;
  function visit(n) {
    if(ts.isMethodDeclaration(n)&&n.name?.text==='agent:providers:changed')handler=n.getText(source);
    if(ts.isVariableDeclaration(n)&&n.name?.text==='invalidateModelCache')invalidate=n.initializer.getText(source);
    ts.forEachChild(n,visit);
  }
  visit(source);
  Object.assign(u.e.context,{_allModelsCache:{providers:[]},_modelCacheGeneration:2});
  u.e.context.invalidateModelCache=vm.runInContext(invalidate,u.e.context);
  let changes=0;u.doc.addEventListener('ash:models-changed',()=>changes++);
  vm.runInContext('({'+handler+'})["agent:providers:changed"]()',u.e.context);
  assert.equal(u.e.context._modelCacheGeneration,3);
  assert.equal(u.e.context._allModelsCache,null);
  assert.equal(changes,1);
});

test('late cleanup from an old Codex activation cannot unregister its replacement', async () => {
  const contexts=[];
  const providers=new Map();
  const x=setup({'agent-sh/extensions':{BUILTIN_EXTENSIONS:[{name:'codex-provider',load:async()=>async ctx=>{
    contexts.push(ctx);
    ctx.onDispose(ctx.agent.providers.register({id:'codex',generation:contexts.length}));
  }}]}});
  const host=new x.module.CodexProviderHost({
    call:()=>null,list:()=>[],registerCommand(){},bus:{emit(){}},
    agent:{providers:{register(reg){providers.set(reg.id,reg);return()=>providers.delete(reg.id);}}},
  });
  try {
    await host.sync();
    x.settings({'codex-provider':{models:['replacement']}});
    await host.sync();
    assert.equal(providers.get('codex').generation,2);
    // A login callback from the disposed instance tries to register late.
    contexts[0].agent.providers.register({id:'codex',generation:'stale'});
    assert.equal(providers.get('codex')?.generation,2);
  } finally { host.close(); }
  assert.equal(providers.size,0);
});

test('failed Codex reactivation can recover after reverting its settings', async () => {
  const providers=new Map();let fail=false,loads=0;
  const x=setup({'agent-sh/extensions':{BUILTIN_EXTENSIONS:[{name:'codex-provider',load:async()=>async ctx=>{
    loads++;
    if(fail)throw Error('temporary activation failure');
    ctx.onDispose(ctx.agent.providers.register({id:'codex'}));
  }}]}});
  const host=new x.module.CodexProviderHost({
    call:()=>null,list:()=>[],registerCommand(){},bus:{emit(){}},
    agent:{providers:{register(reg){providers.set(reg.id,reg);return()=>providers.delete(reg.id);}}},
  });
  try {
    await host.sync();
    x.settings({'codex-provider':{models:['replacement']}});fail=true;
    await assert.rejects(host.sync(),/temporary activation failure/);
    x.settings({});fail=false;
    await host.sync();
    assert(providers.has('codex'),'restoring the last working settings must register a provider again');
    assert.equal(loads,3);
  } finally { host.close(); }
});

test('same model IDs from different providers do not share image capabilities', async () => {
  const {EventEmitter}=require('node:events');
  const e=env();const {AshBridge}=e.load('src/bridges/ash.ts');
  const b=Object.create(AshBridge.prototype);
  const models=[
    {id:'shared-model',provider:'api',modalities:['text']},
    {id:'shared-model',provider:'codex',modalities:['text','image']},
  ];
  let provider='api';
  const bus=new EventEmitter();bus.onPipeAsync=()=>{};bus.emitPipe=(_n,p)=>p;
  b.core={bus,handlers:{call(name){
    if(name==='llm:get-client')return {model:'shared-model'};
    if(name==='agent:get-model')return {model:'shared-model',provider};
    if(name==='agent:get-models')return models;
  }}};
  const frames=[];b.emit=(_n,frame)=>frames.push(frame);b.wire(b.core);
  let gate;b.gateImageToolResults({advise(_n,fn){gate=fn;}});
  const image={content:[{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}]};
  const textOnly=await gate(async()=>image,{name:'read_file'});
  assert.equal(typeof textOnly.content,'string','text-only API model must not receive image tool content');
  provider='codex';
  assert.equal(await gate(async()=>image,{name:'read_file'}),image);
  bus.emit('agent:info',{name:'ash',model:'shared-model',provider});
  assert.deepEqual(Array.from(frames.at(-1).payload.modalities),['text','image']);
});

test('model identity without image capabilities clears the previous upload state, partial updates preserve it', () => {
  const {ts,vm,root}=require('./harness.cjs');
  const e=env();
  const source=ts.createSourceFile('sse.js',fs.readFileSync(path.join(root,'web/js/sse.js'),'utf8'),ts.ScriptTarget.Latest,true);
  let code;
  function visit(n) {
    if(ts.isMethodDeclaration(n)&&n.name?.text==='agent:info')code=n.getText(source);
    ts.forEachChild(n,visit);
  }
  visit(source);
  const session={agentInfo:{},state:{}};
  const button={hidden:true};
  Object.assign(e.context,{
    activeSession:{peek:()=>session},Event:class{constructor(type){this.type=type;}},
    document:{getElementById:()=>button,dispatchEvent(){}},
    refreshModelChip(){},renderUsage(){},renderInstanceLabel(){},syncAllBalanceChips(){},
  });
  const handler=vm.runInContext('({'+code+'})["agent:info"]',e.context);
  const update=payload=>handler.call(session,payload);
  update({model:'shared-model',provider:'codex',modalities:['text','image']});
  assert.equal(button.hidden,false);
  update({thinkingLevel:'high',thinkingSupported:true});
  assert.equal(button.hidden,false,'thinking-only frames must preserve the current model capabilities');
  update({model:'shared-model',provider:'api'});
  assert.deepEqual(Array.from(session.agentInfo.modalities),[]);
  assert.equal(button.hidden,true,'unknown API capabilities must not inherit Codex image support');
  update({model:'shared-model',provider:'codex',modalities:['text','image']});
  assert.equal(button.hidden,false);
  update({model:'text-only-model',provider:'codex'});
  assert.equal(button.hidden,true,'switching models within a provider also clears stale image support');
});

test('reconnect identity drops old image capabilities and preserves them on partial status updates', () => {
  const e=env();
  const {routeEvent}=e.load('src/hub.ts','export {routeEvent};');
  const session={id:'capability-reconnect',kind:'agent',segmentSeq:0,replay:[],sseClients:new Set(),lastFrameSeq:0,_needsRestore:true};
  const update=payload=>routeEvent(session,{name:'agent:info',payload});
  update({model:'shared-model',provider:'codex',modalities:['text','image']});
  update({thinkingLevel:'high'});
  assert.deepEqual(Array.from(session.lastAgentInfo.modalities),['text','image']);
  update({model:'shared-model',provider:'api'});
  assert.deepEqual(Array.from(session.lastAgentInfo.modalities),[], 'reconnect must not reintroduce stale Codex capabilities');
  update({model:'shared-model',provider:'codex',modalities:['text','image']});
  assert.deepEqual(Array.from(session.lastAgentInfo.modalities),['text','image']);
});

function delayedCodexBridge() {
  const {EventEmitter}=require('node:events');
  const e=env(),{AshBridge}=e.load('src/bridges/ash.ts');
  const b=Object.create(AshBridge.prototype);EventEmitter.call(b);
  let release,started;const syncing=new Promise(r=>started=r),pending=new Promise(r=>release=r);
  const emitted=[];
  Object.assign(b,{
    closed:false,initPromise:Promise.resolve(),backendRegistered:true,queryQueue:[],queuedIds:[],
    codexHost:{sync(){started();return pending;},close(){}},
    _subagents:new Map(),pendingPermissions:new Map(),permissionSessionApproved:new Set(),shellExchanges:[],
    core:{kill(){},handlers:{call(){return []; }},bus:{emit(name){
      emitted.push(name);
      if(name==='agent:submit') {
        b.pendingTurn.resolve({stopReason:'done'});
        b.pendingTurn=null;
      }
    }}},
  });
  return {e,b,release,syncing,emitted};
}
for (const operation of ['submit','model']) test(`closing while Codex synchronizes prevents late ${operation}`,async()=>{
  const {b,release,syncing,emitted}=delayedCodexBridge();
  const pending=operation==='submit'?b.submit('Do not start after closure'):b.execCommand('/model','new@codex');
  // Attach both handlers before releasing the asynchronous operation.
  const outcome=Promise.resolve(pending).then(()=>({ok:true}),error=>({error}));
  await syncing;b.close();release();
  const result=await outcome;
  assert.equal(emitted.length,0,'closed bridge dispatched an operation after provider synchronization');
  assert.match(String(result.error),/closed|backend not ready/);
});

test('cancelling during Codex synchronization prevents late submission and permits a fresh turn',async()=>{
  const {b,release,syncing,emitted}=delayedCodexBridge();
  const pending=b.submit('Cancelled before the provider is ready');
  await syncing;b.cancel();release();
  const result=await pending;
  assert.equal(emitted.filter(name=>name==='agent:submit').length,0,'cancelled turn started after provider synchronization');
  assert.equal(result.stopReason,'cancelled');
  assert.equal(b.queryQueue.length,0);
  assert.equal((await b.submit('A fresh request after cancellation')).stopReason,'done');
  assert.equal(emitted.filter(name=>name==='agent:submit').length,1);
});

test('cancelling before initialization finishes invalidates every waiting submission',async()=>{
  const {b,release,emitted}=delayedCodexBridge();
  const dropped=[];b.on('event',e=>{if(e.name==='agent:queued-done')dropped.push(e.payload);});
  let ready;b.initPromise=new Promise(resolve=>ready=resolve);
  const first=b.submit('First pending request'),second=b.submit('Second pending request');
  b.cancel();ready();release();
  const results=await Promise.all([first,second]);
  assert.equal(results[0].stopReason,'cancelled');
  assert.equal(results[1].stopReason,'queued');
  assert.equal(dropped.length,1);assert.equal(dropped[0].query,'Second pending request');assert.equal(dropped[0].dropped,true);
  assert.equal(emitted.filter(name=>name==='agent:submit').length,0);
  assert.equal(b.queryQueue.length,0,'cancelled submissions must not enter the queue');
});

test('Hub queues a second message while the first is synchronizing its provider',async()=>{
  const {Bridge}=require('./harness.cjs');
  const {e,b,release,syncing}=delayedCodexBridge();b.supportsQueue=true;
  const {createSession,submitQuery}=e.load('src/hub.ts','export {createSession,submitQuery};');
  const session=await createSession(new Map(),{makeBridge:o=>new Bridge(o)},e.dir);
  session.bridge=b;
  await submitQuery(session,'First');await syncing;
  const second=await submitQuery(session,'Second');
  assert.equal(second.queued,true,'provider synchronization was reported as idle');
  release();await new Promise(r=>setImmediate(r));
  const frames=session.replay.map(frame=>JSON.parse(frame.split('\ndata: ')[1].trim()));
  assert.equal(frames.filter(f=>f.meta.name==='agent:query'&&f.payload.query==='Second').length,0,'queued message rendered as an active query');
  assert.equal(frames.filter(f=>f.meta.name==='agent:queued'&&f.payload.query==='Second').length,1);
});

test('preparation failure clears queued messages and permits retry',async()=>{
  const {b,release,syncing,emitted}=delayedCodexBridge();
  const dropped=[];b.on('event',e=>{if(e.name==='agent:queued-done')dropped.push(e.payload);});
  b.backendRegistered=false;
  const outcome=b.submit('Cannot start').then(()=>null,error=>error);
  await syncing;
  assert.equal((await b.submit('Cannot queue forever')).stopReason,'queued');
  release();assert.match(String(await outcome),/No agent backend/);
  assert.equal(b.isProcessing(),false);assert.equal(b.queryQueue.length,0);
  assert.equal(dropped.length,1);assert.equal(dropped[0].dropped,true);
  assert.equal(emitted.length,0);
  b.backendRegistered=true;
  assert.equal((await b.submit('Retry')).stopReason,'done');
});

test('cancel settles preparation immediately and its late completion cannot settle a new turn',async()=>{
  const {b,release,syncing,emitted}=delayedCodexBridge();
  const first=b.submit('Old');await syncing;
  b.cancel();
  const result=await Promise.race([first,new Promise(r=>setImmediate(()=>r(null)))]);
  assert.equal(result?.stopReason,'cancelled','cancel waits for provider synchronization');
  assert.equal(b.isProcessing(),false);
  // Keep the new turn running while the older preparation finishes.
  b.codexHost.sync=async()=>{};
  b.core.bus.emit=name=>emitted.push(name);
  const next=b.submit('New');await new Promise(r=>setImmediate(r));
  const active=b.pendingTurn;
  release();await new Promise(r=>setImmediate(r));
  assert.equal(b.pendingTurn,active);assert.equal(b.isProcessing(),true);
  assert.equal(emitted.filter(name=>name==='agent:submit').length,1);
  active.resolve({stopReason:'done'});b.pendingTurn=null;await next;
});

test('close settles a preparing submission without waiting for provider synchronization',async()=>{
  const {b,release,syncing,emitted}=delayedCodexBridge();
  const outcome=b.submit('Old').then(()=>null,error=>error);await syncing;
  await b.submit('Queued');b.close();
  const result=await Promise.race([outcome,new Promise(r=>setImmediate(()=>r(null)))]);
  assert.match(String(result),/closed/);
  assert.equal(b.isProcessing(),false);assert.equal(b.queryQueue.length,0);
  release();await new Promise(r=>setImmediate(r));assert.equal(emitted.length,0);
});

test('messages submitted during provider preparation keep FIFO order and image payloads',async()=>{
  const {b,release,syncing}=delayedCodexBridge();
  const delivered=[];
  b.core.bus.emit=(name,payload)=>{if(name==='agent:submit'){
    delivered.push(payload);const turn=b.pendingTurn;b.pendingTurn=null;turn.resolve({stopReason:'done'});
  }};
  const first=b.submit('First');await syncing;
  await b.submit(JSON.stringify({query:'Second',images:[{data:'fixture',mimeType:'image/png'}]}));
  await b.submit('Third');release();await first;
  b.drainQueue();b.drainQueue();
  assert.deepEqual(delivered.map(p=>p.query),['First','Second','Third']);
  assert.equal(delivered[1].images[0].data,'fixture');
  assert.equal(b.isProcessing(),false);
});
