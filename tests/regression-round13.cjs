const {env,Res,req,check,assert,results}=require('./harness.cjs');
const {ui}=require('./ui-harness.cjs');
const {EventEmitter}=require('node:events');
const tick=()=>new Promise(r=>setImmediate(r));
const response=data=>({ok:true,json:async()=>data});
const catalog=name=>({providers:[{name,models:[{id:name+'-model'}]}]});
function shellEnv({killExits=false,coreKillThrows=false}={}) {
 let exitShell,killed=0,shellKilled=0;const inputs=[],noop=()=>{};
 const core={handlers:{define:noop,advise:noop,call:noop},bus:{on:noop,emit:noop,emitPipe:(_,p)=>p},extensionContext:()=>({agent:{registerInstruction:noop,registerTool:noop,registerContextProducer:()=>noop}}),activateBackend:async()=>{},kill:()=>{killed++;if(coreKillThrows)throw Error('cleanup failed')}};
 const e=env({modules:{'agent-sh':{createCore:()=>core},'agent-sh/agent':{activateAgent:noop},'agent-sh/extensions':{loadBuiltinExtensions:async()=>[]},'agent-sh/extension-loader':{loadExtensions:async()=>[]},'agent-sh/shell/host':{registerShellHandlers:noop},'agent-sh/shell':{Shell:class{onExit(fn){exitShell=fn}kill(){shellKilled++;if(killExits)exitShell({exitCode:0})}}},'agent-sh/shell/terminal':{headlessTerminal:()=>({}),BridgedTerminal:class{pushInput(data){inputs.push(data)}},surfaceFromTerminal:()=>({})}}});
 e.context.process={...e.context.process,platform:'darwin',stderr:{write(){}}};
 const A=e.load('src/bridges/ash.ts').AshBridge;A.prototype.wire=noop;A.prototype.registerUserProviders=noop;A.prototype.gateImageToolResults=noop;
 const h=e.load('src/hub.ts','export const audit={createSession,shutdownHub,routeEvent,ptyInput};').audit;
 return{e,A,h,inputs,exit:data=>exitShell(data),stats:()=>({killed,shellKilled})};
}
async function terminal(options) {
 const x=shellEnv(options),sessions=new Map();const s=await x.h.createSession(sessions,{makeBridge:o=>new x.A(o)},x.e.dir,undefined,'ash-terminal');
 return{...x,s,sessions};
}
function configUi() {
 const u=ui();for(const id of ['config-auto-approve','config-auto-approve-label'])u.doc.getElementById(id).closest=()=>null;
 let generation=0;u.modules['./sse.js']={invalidateModelCache:()=>++generation,getModelCacheGeneration:()=>generation,setModelCache:()=>true};
 u.e.context.CustomEvent=class{constructor(type){this.type=type}};
 const m=u.e.load('web/js/config-panel.js','export const audit={doSave,buildConfig};');
 return{u,m,change:()=>u.doc.dispatchEvent({type:'ash:models-changed'}),loading:()=>u.doc.getElementById('config-model-refresh').classList.contains('loading')};
}
function pendingCatalog() {
 const x=configUi(),reads=[];x.u.e.context.fetch=()=>new Promise((resolve,reject)=>reads.push({resolve,reject}));return{...x,reads};
}
const watchdog=setTimeout(()=>{console.error('TIMEOUT');process.exit(1)},30000);
(async()=>{
for(const exit of [{exitCode:0},{exitCode:7,signal:15}])await check('AD01 terminal exit '+exit.exitCode+' flushes output, emits status and removes session',async()=>{
 const x=await terminal({killExits:true}),b=x.s.bridge,sse=new Res(),order=[];x.s.sseClients.add(sse);
 b.onEvent(e=>{if(e.name==='shell:exit'){assert(x.sessions.has(x.s.id),'removed before exit delivery');order.push(e)}});b.onClose(()=>order.push('closed'));
 x.h.routeEvent(x.s,{name:'shell:pty-data',payload:{raw:'last output'}});assert(!sse.body.includes('last output'),'output was not buffered');
 x.exit(exit);x.exit(exit);b.close();
 assert(order.length===2&&order[0].payload.exitCode===exit.exitCode&&order[0].payload.signal===exit.signal&&order[1]==='closed','duplicate or missing exit/close');
 assert(sse.body.indexOf('last output')<sse.body.indexOf('shell:exit')&&sse.body.includes('shell:exit')&&sse.writableEnded,'SSE output/exit/close order wrong');
 assert(!x.sessions.size&&b.closed&&!b.shell&&x.stats().killed===1&&x.stats().shellKilled===1,'resources/session retained');
 const res=new Res();await x.h.ptyInput(req({data:'ignored'}),res,x.s);assert(res.statusCode===409&&!x.inputs.length,'closed session accepted input');
});
await check('AD01 explicit close tolerates synchronous Shell exit without duplicate close',async()=>{
 const x=await terminal({killExits:true}),events=[];x.s.bridge.onEvent(e=>events.push(e));let closed=0;x.s.bridge.onClose(()=>closed++);
 x.s.bridge.close();x.s.bridge.close();assert(closed===1&&x.stats().shellKilled===1&&x.stats().killed===1&&!events.some(e=>e.name==='shell:exit')&&!x.sessions.size,'close re-entered');
});
await check('AD01 optional agent Shell exit cleans only the Shell',async()=>{
 const x=shellEnv({killExits:true}),sessions=new Map(),s=await x.h.createSession(sessions,{makeBridge:o=>new x.A(o)},x.e.dir),events=[];s.bridge.onEvent(e=>events.push(e));
 x.exit({exitCode:1});assert(sessions.size===1&&!s.bridge.closed&&!s.bridge.shell&&x.stats().killed===0&&x.stats().shellKilled===1&&!events.some(e=>e.name==='shell:exit'),'optional Shell closed agent or leaked');
 await x.h.shutdownHub(undefined,sessions);assert(x.stats().shellKilled===1&&x.stats().killed===1,'optional Shell cleaned twice');
});
await check('AD01 terminal exit clears permissions and aborts subagents',async()=>{
 const x=await terminal();let aborted=0,decision;const timer=x.e.context.setTimeout(()=>{},1000);
 x.s.bridge._subagents.set('child',{controller:{abort(){aborted++}}});x.s.bridge.pendingPermissions.set('permission',{timer,resolve:v=>decision=v});
 x.exit({exitCode:0});assert(aborted===1&&decision.outcome==='denied'&&!x.e.timers.has(timer)&&!x.s.bridge.pendingPermissions.size&&!x.s.bridge._subagents.size,'pending work retained');
});
await check('AD01 failed Core cleanup still releases Shell and closes session',async()=>{
 const x=await terminal({coreKillThrows:true});x.exit({exitCode:0});assert(x.stats().shellKilled===1&&!x.sessions.size&&x.s._closed,'Core exception prevented cleanup');
});
await check('AD01 input waiting for its body is rejected if terminal exits meanwhile',async()=>{
 const x=await terminal(),r=new EventEmitter(),res=new Res();const pending=x.h.ptyInput(r,res,x.s);
 x.exit({exitCode:0});r.emit('data',Buffer.from(JSON.stringify({data:'echo stale\n'})));r.emit('end');await pending;
 assert(res.statusCode===409&&!x.inputs.length,'pending input silently acknowledged');
});
await check('AD01 live terminal continues accepting PTY input',async()=>{
 const x=await terminal(),res=new Res();await x.h.ptyInput(req({data:'echo live\n'}),res,x.s);assert(res.statusCode===200&&x.inputs[0]==='echo live\n','live input broken');await x.h.shutdownHub(undefined,x.sessions);
});
await check('AD02 saving and reopening configuration displays new provider without forced refresh',async()=>{
 const x=configUi();let config={defaultProvider:'old',providers:{old:{apiKey:'fake-old'}}},calls=0;
 x.u.e.context.fetch=async(url,opts)=>{if(url==='/api/models'){calls++;return response({providers:Object.keys(config.providers).map(name=>({name,models:[{id:name+'-model'}]}))})}if(opts?.method==='PUT'){config=JSON.parse(opts.body);return{ok:true}}return response(config)};
 await x.m.setConfigOpen(true);const next={defaultProvider:'new',providers:{old:{apiKey:'fake-old'},new:{apiKey:'fake-new',baseURL:'https://example.invalid'}}};
 await x.m.audit.doSave(JSON.stringify(next));await x.m.setConfigOpen(true);
 const select=x.u.doc.getElementById('config-provider');assert(select.value==='new'&&select.children.some(e=>e.value==='new')&&calls===2,'new provider absent');
 const built=x.m.audit.buildConfig();assert(built.defaultProvider==='new'&&built.providers.old.apiKey==='fake-old'&&built.providers.new.baseURL===next.providers.new.baseURL,'config fields lost');
});
await check('AD02 invalidation retries stale in-flight catalog and caches only current response',async()=>{
 const x=pendingCatalog(),old=x.m.loadProviderCatalog();x.change();x.reads[0].resolve(response(catalog('old')));await tick();assert(x.reads.length===2,'stale request not retried');
 x.reads[1].resolve(response(catalog('new')));assert((await old).providers[0].name==='new');assert((await x.m.loadProviderCatalog()).providers[0].name==='new'&&x.reads.length===2,'stale cache persisted');
});
for(const reject of [false,true])await check('AD02 stale '+(reject?'error':'response')+' joins current load without clearing its loading state',async()=>{
 const x=pendingCatalog(),old=x.m.loadProviderCatalog();x.change();const current=x.m.loadProviderCatalog();
 if(reject)x.reads[0].reject(Error('old request failed'));else x.reads[0].resolve(response(catalog('old')));await tick();
 const joined=x.m.loadProviderCatalog();assert(x.reads.length===2&&x.loading(),'obsolete request cleared current promise/loading');
 x.reads[1].resolve(response(catalog('new')));for(const p of [old,current,joined])assert((await p).providers[0].name==='new');assert(!x.loading(),'loading never cleared');
});
await check('AD02 force refresh supersedes earlier response even when new response finishes first',async()=>{
 const x=pendingCatalog(),old=x.m.loadProviderCatalog(),current=x.m.loadProviderCatalog({force:true});x.reads[1].resolve(response(catalog('new')));await current;
 x.reads[0].resolve(response(catalog('old')));assert((await old).providers[0].name==='new'&&(await x.m.loadProviderCatalog()).providers[0].name==='new'&&x.reads.length===2,'older refresh won');
});
await check('AD02 HTTP and malformed catalog errors remain retryable; empty catalogs are cached',async()=>{
 const x=configUi();let calls=0;x.u.e.context.fetch=async()=>++calls===1?{ok:false,status:500}:response(calls===2?{providers:[{name:'bad',models:[null]}]}:{providers:[]});
 assert(await x.m.loadProviderCatalog()===null&&!x.loading());assert(await x.m.loadProviderCatalog()===null&&!x.loading());assert((await x.m.loadProviderCatalog()).providers.length===0);await x.m.loadProviderCatalog();assert(calls===3,'error cached or valid empty catalog refetched');
});
await check('AD02 synchronous fetch failure leaves catalog retryable',async()=>{
 const x=configUi();x.u.e.context.fetch=()=>{throw Error('fetch unavailable')};assert(await x.m.loadProviderCatalog()===null&&!x.loading());x.u.e.context.fetch=async()=>response(catalog('recovered'));assert((await x.m.loadProviderCatalog()).providers[0].name==='recovered');
});
clearTimeout(watchdog);console.log(JSON.stringify({checks:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length}));
})().catch(e=>{clearTimeout(watchdog);console.error(e);process.exitCode=1});
