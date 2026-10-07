const {env,Res,req,Bridge,assert,ts,vm,fs,path,root}=require('./harness.cjs');
const {ui,El}=require('./ui-harness.cjs');
const {EventEmitter}=require('events');
const tick=()=>new Promise(r=>setImmediate(r)), findings=[];
function ast(file){return ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true)}
function find(sf,p){let out;function walk(n){if(!out&&p(n))out=n;if(!out)ts.forEachChild(n,walk)}walk(sf);assert(out,'AST missing');return out;}
function variable(file,name,ctx){const sf=ast(file),n=find(sf,n=>ts.isVariableDeclaration(n)&&n.name?.text===name);return vm.runInContext('('+n.initializer.getText(sf)+')',ctx)}
function hub(e){return e.load('src/hub.ts','export const audit={getModels,getBalance,updateConfig,reloadConfig,createSession,shutdownHub,routeEvent};').audit}
async function check(id,fn){if(process.env.ONLY&&!id.startsWith(process.env.ONLY))return;try{const detail=await fn();findings.push({id,passed:true,detail});console.log('PASS',id,JSON.stringify(detail))}catch(e){findings.push({id,passed:false,error:e.stack});console.log('FAIL',id,e.stack)}}
const catalog = (id, provider='custom') => ({providers:[{name:provider,models:[{id}]}]});
const response = data => ({ok:true,json:async()=>data});
function cacheUi() {
 const u=ui();
 vm.runInContext('let _allModelsCache=null, _modelCacheGeneration=0;',u.e.context);
 const set=variable('web/js/sse.js','setModelCache',u.e.context),invalidate=variable('web/js/sse.js','invalidateModelCache',u.e.context);
 const generation=variable('web/js/sse.js','getModelCacheGeneration',u.e.context);
 Object.assign(u.e.context,{setModelCache:set,invalidateModelCache:invalidate,getModelCacheGeneration:generation});
 return {u,set,invalidate,generation,read:()=>vm.runInContext('_allModelsCache',u.e.context)};
}
function panelUi() {
 const c=cacheUi(),reads=[];c.u.doc.getElementById('subagent-panel').hidden=true;
 c.u.modules['./sse.js']={setModelCache:c.set};
 c.u.e.context.fetch=()=>new Promise(resolve=>reads.push(resolve));
 const m=c.u.e.load('web/js/subagent-panel.js','export const audit={fetchModelsCatalog};');
 return {...c,reads,fetch:m.audit.fetchModelsCatalog,change(){c.invalidate();c.u.doc.dispatchEvent({type:'ash:models-changed'})}};
}
function pickerUi() {
 const c=cacheUi(),u=c.u,s=u.active.peek(),dropdown=new El();dropdown.hidden=true;
 s.modelEl=new El();s.modelEl.getBoundingClientRect=()=>({left:0,top:100});
 Object.assign(u.e.context,{activeSession:u.active,getSharedDropdown:()=>dropdown,hideModelDropdown:()=>{dropdown.hidden=true},_dropdownOwner:null,_dropdownBuiltFor:null,_dropdownAnchor:null,_dropdownObserver:null,
 buildModelDropdown(){},updateModelDropdownSelection(){},MutationObserver:class{observe(){}},toast:(...x)=>u.toasts.push(x),t:x=>x});
 const toggle=variable('web/js/sse.js','toggleModelDropdown',u.e.context);
 return {...c,dropdown,open:()=>toggle(s)};
}
function routerBridge() {
 const reads=[],e=env({globals:{fetch:()=>new Promise(resolve=>reads.push(resolve))}}),A=e.load('src/bridges/ash.ts').AshBridge,b=Object.create(A.prototype);EventEmitter.call(b);
 let key='fake-key-A',registered,provider='openrouter';const registrations=[];
 e.auth.resolveApiKey=()=>({key});b.providerGeneration=0;b.closed=false;
 b.extCtx={agent:{providers:{register:r=>{registered=r;registrations.push(r)}}}};
 b.core={bus:{emit(){}},handlers:{call:n=>n==='agent:get-model'?{provider,model:'common'}:registered?.models.map(m=>({...m,provider:'openrouter'}))??[]}};
 return{e,b,reads,registrations,key:v=>key=v,provider:v=>provider=v};
}
const routerResponse=id=>response({data:[{id:'common'},{id,architecture:{input_modalities:['text','image']}}]});
function shellEnv({fail=false,windows=false}={}) {
 let killed=0,shells=0,shellKilled=0;const noop=()=>{};
 const core={handlers:{define:noop,advise:noop,call:noop},bus:{on:noop,emit:noop,emitPipe:(_,p)=>p},extensionContext:()=>({agent:{registerInstruction:noop,registerTool:noop,registerContextProducer:()=>noop}}),activateBackend:async()=>{},kill:()=>killed++};
 const e=env({modules:{'agent-sh':{createCore:()=>core},'agent-sh/agent':{activateAgent:noop},'agent-sh/extensions':{loadBuiltinExtensions:async()=>[]},'agent-sh/extension-loader':{loadExtensions:async()=>[]},'agent-sh/shell/host':{registerShellHandlers:noop},'agent-sh/shell':{Shell:class{constructor(){shells++;if(fail)throw Error('spawn ENOENT')}onExit(){}kill(){shellKilled++}}},'agent-sh/shell/terminal':{headlessTerminal:()=>({}),BridgedTerminal:class{},surfaceFromTerminal:()=>({})}}});
 e.context.process={...e.context.process,platform:windows?'win32':'darwin',stderr:{write(){}}};
 const A=e.load('src/bridges/ash.ts').AshBridge;A.prototype.wire=noop;A.prototype.registerUserProviders=noop;A.prototype.gateImageToolResults=noop;
 return{e,A,stats:()=>({killed,shells,shellKilled})};
}
const watchdog=setTimeout(()=>{console.error('TIMEOUT');process.exit(1)},30000);
(async()=>{
await check('AC01 stale subagent response cannot overwrite either model cache',async()=>{
 const x=panelUi(),old=x.fetch();x.change();x.set(catalog('new'));
 x.reads[0](response(catalog('old')));await tick();assert(x.reads.length===2,'old request did not retry');
 x.reads[1](response(catalog('new')));assert((await old).providers[0].models[0].id==='new');
 assert((await x.fetch()).providers[0].models[0].id==='new'&&x.read().providers[0].models[0].id==='new'&&x.reads.length===2,'stale catalog cached');
});
await check('AC01 old request joins current request without clearing its promise',async()=>{
 const x=panelUi(),old=x.fetch();x.change();const current=x.fetch();x.reads[0](response(catalog('old')));await tick();
 const joined=x.fetch();assert(x.reads.length===2,'duplicate current request');x.reads[1](response(catalog('new')));
 for(const p of [old,current,joined])assert((await p).providers[0].models[0].id==='new');
});
await check('AC01 failure from obsolete request still joins the current catalog',async()=>{
 const x=panelUi(),old=x.fetch();x.change();const current=x.fetch();x.reads[0]({ok:false,status:500});await tick();
 x.reads[1](response(catalog('new')));assert((await old).providers[0].models[0].id==='new'&&(await current).providers[0].models[0].id==='new');
});
await check('AC01 stale model picker response cannot overwrite newly saved catalog',async()=>{
 const x=pickerUi();let release;x.u.e.context.fetch=()=>new Promise(r=>release=r);const pending=x.open();
 x.invalidate();x.set(catalog('new'));release(response(catalog('old')));await pending;
 assert(x.read().providers[0].models[0].id==='new'&&x.dropdown.hidden,'stale picker response applied');
});
await check('AC01 superseded config polling cannot write the old model catalog',async()=>{
 const x=cacheUi(),u=x.u,reads=[];
 Object.assign(u.e.context,{originalConfig:null,CustomEvent:class{constructor(type){this.type=type}},setConfigOpen(){},autoApproveToggle:{checked:false},toast(){},t:x=>x,
 fetch:async(url,opts)=>opts?.method==='PUT'?{ok:true}:new Promise(r=>reads.push(r))});
 const save=variable('web/js/config-panel.js','doSave',u.e.context);await save('{}');
 const first=[...u.e.timers].find(([id,t])=>t.ms===1500);u.e.timers.delete(first[0]);const pending=first[1].fn();await tick();
 await save('{}');x.set(catalog('new'));reads[0](response({providers:[{name:'openrouter',models:[{id:'old-a'},{id:'old-b'}]}]}));await pending;
 assert(x.read().providers[0].models[0].id==='new','old polling overwrote new model cache');
});
await check('AC04 HTTP model errors remain retryable and show feedback',async()=>{
 const x=pickerUi();let calls=0;x.u.e.context.fetch=async()=>++calls===1?{ok:false,status:500,json:async()=>({error:'temporary failure'})}:response(catalog('recovered'));
 await x.open();assert(x.read()===null&&x.dropdown.hidden&&x.u.toasts.length===1,'error cached or no feedback');
 await x.open();assert(calls===2&&!x.dropdown.hidden&&x.read().providers[0].models[0].id==='recovered','picker failed to recover');
});
await check('AC04 malformed successful model response remains retryable',async()=>{
 const x=pickerUi();let calls=0;x.u.e.context.fetch=async()=>response(++calls===1?{providers:[{name:'bad',models:[null]}]}:catalog('valid'));
 await x.open();assert(x.read()===null,'invalid catalog cached');await x.open();assert(calls===2&&!x.dropdown.hidden,'invalid response prevented retry');
});
await check('AC04 empty catalog is valid while failed subagent response is not cached',async()=>{
 const x=panelUi(),failed=x.fetch();x.reads[0](response({error:'invalid response'}));assert(await failed===null&&x.read()===null);
 const next=x.fetch();x.reads[1](response({providers:[]}));assert((await next).providers.length===0);
 await x.fetch();assert(x.reads.length===2,'empty valid catalog repeatedly fetched');
});
await check('AC02 old OpenRouter refresh cannot replace newer bridge or Hub catalog',async()=>{
 const x=routerBridge(),h=hub(x.e),sessions=new Map([['aaaaaa',{kind:'agent',bridge:x.b}]]);x.e.settings.reloadSettings=async()=>{};x.e.auth.listAllProviders=()=>[{id:'openrouter'}];
 await h.updateConfig(req({}),new Res(),sessions);x.key('fake-key-B');await h.updateConfig(req({}),new Res(),sessions);
 x.reads[1](routerResponse('new'));await tick();const first=new Res();await h.getModels(req({},'/api/models','GET'),first,sessions);
 x.reads[0](routerResponse('old'));await tick();x.e.clock(130001);const later=new Res();await h.getModels(req({},'/api/models','GET'),later,sessions);
 assert(x.registrations.length===1&&first.json().providers[0].models[1].id==='new'&&later.json().providers[0].models[1].id==='new','late refresh changed catalog');
});
await check('AC02 removing credentials invalidates older model refresh',async()=>{
 const x=routerBridge();x.b.reloadProviders();x.key('');x.b.reloadProviders();x.reads[0](routerResponse('old'));await tick();assert(x.registrations.length===0,'removed credential request registered models');
});
await check('AC02 closed bridge never registers delayed catalog',async()=>{
 const x=routerBridge();x.b.reloadProviders();x.b.releaseResources=()=>{};x.b.close();x.reads[0](routerResponse('old'));await tick();assert(x.registrations.length===0,'closed bridge registered models');
});
await check('AC02 current refresh preserves model capability metadata',async()=>{
 const x=routerBridge();x.b.reloadProviders();x.reads[0](routerResponse('current'));await tick();assert(x.registrations.length===1&&x.registrations[0].models[1].modalities.includes('image'),'valid refresh lost capabilities');
});
await check('AC03 failed ash-terminal initialization rejects and cleans up resources',async()=>{
 const x=shellEnv({fail:true}),h=hub(x.e),sessions=new Map();let b,error;
 try{await h.createSession(sessions,{makeBridge:o=>(b=new x.A(o))},x.e.dir,undefined,'ash-terminal')}catch(err){error=err}
 assert(error&&sessions.size===0&&b.closed&&x.stats().killed>=1&&!b.shell,'failed terminal published or resources leaked');
});
await check('AC03 optional Shell failure still permits ordinary agent sessions',async()=>{
 const x=shellEnv({fail:true}),h=hub(x.e),sessions=new Map();const s=await h.createSession(sessions,{makeBridge:o=>new x.A(o)},x.e.dir);
 assert(s.kind==='agent'&&sessions.size===1&&!s.bridge.shell&&!s.bridge.closed,'optional shell failure broke agent initialization');await h.shutdownHub(undefined,sessions);
});
await check('AC03 healthy ash-terminal creates and closes its shell',async()=>{
 const x=shellEnv(),h=hub(x.e),sessions=new Map();const s=await h.createSession(sessions,{makeBridge:o=>new x.A(o)},x.e.dir,undefined,'ash-terminal');
 assert(sessions.size===1&&s.bridge.shell,'healthy terminal rejected');await h.shutdownHub(undefined,sessions);assert(x.stats().shellKilled===1,'terminal shell leaked');
});
await check('AC03 unsupported Windows ash-terminal fails explicitly before shell creation',async()=>{
 const x=shellEnv({windows:true}),b=new x.A({kind:'ash-terminal',cwd:x.e.dir});let error;try{await b.ready()}catch(err){error=err}
 assert(error?.message.includes('regular terminal on Windows')&&b.closed&&x.stats().shells===0&&x.stats().killed>=1,'unsupported terminal silently created');
});
clearTimeout(watchdog);console.log(JSON.stringify({checks:findings.length,passed:findings.filter(x=>x.passed).length,failed:findings.filter(x=>!x.passed).length}));if(findings.some(x=>!x.passed))process.exitCode=1;
})().catch(e=>{clearTimeout(watchdog);console.error(e);process.exitCode=1});
