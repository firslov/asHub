const root=process.env.ASHUB_TEST_ROOT || require('path').resolve(__dirname, '..');
process.env.ASHUB_TEST_ROOT=root;
const {env,Res,req,Bridge,assert,ts,vm,fs,path}=require('./harness.cjs');
const {ui,El}=require('./ui-harness.cjs');
const {EventEmitter}=require('events');
const tick=()=>new Promise(r=>setImmediate(r));
const findings=[];
function ast(file){return ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true);}
function find(sf,p){let out;function walk(n){if(!out&&p(n))out=n;if(!out)ts.forEachChild(n,walk);}walk(sf);assert(out,'AST not found');return out;}
function method(file,name,ctx){const sf=ast(file),n=find(sf,n=>ts.isMethodDeclaration(n)&&n.name?.text===name);return vm.runInContext(ts.transpileModule('({'+n.getText(sf)+'})['+JSON.stringify(name)+']',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);}
function hub(e){return e.load('src/hub.ts','export const audit={startHub,createSession,submit,openSseMulti,routeEvent,flushSegment,saveSessionMeta,savePinnedSessions,loadPinnedSessions,togglePin,closeSession,shutdownHub,archiveSession,unarchiveSession,dropContext,getContext,serveUpload,listInstalledSkills,uninstallSkill};').audit;}
async function create(extra={}){const e=env(extra),h=hub(e),ss=new Map(),s=await h.createSession(ss,{makeBridge:o=>new Bridge(o)},e.dir);return {e,h,ss,s};}
const frame=f=>JSON.parse(f.split('data: ')[1]);
async function check(id,fn){try{const detail=await fn();findings.push({id,passed:true,detail});console.log('PASS',id,JSON.stringify(detail));}catch(e){findings.push({id,passed:false,error:e.stack});console.log('FAIL',id,e.stack);}}
function acp(){const calls=[],child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.kill=()=>{};child.stdin={writable:true,end(){},write:raw=>{const m=JSON.parse(raw);calls.push(m);if(m.method==='initialize'||m.method==='session/new')queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:1,agentCapabilities:{loadSession:true}}:{sessionId:'remote'}})+'\n'));}};const e=env({modules:{'node:child_process':{spawn:()=>child}}}),A=e.load('src/bridges/acp.ts').AcpBridge;return {e,A,calls,child,answer:(id,result={stopReason:'end_turn'})=>child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id,result})+'\n')};}
const watchdog=setTimeout(()=>{console.error('Round 2 regression suite hung');process.exit(1);},30000);
(async()=>{
await check('R01 ACP busy prompts are rejected before query frames',async()=>{
 const {e,A,calls,answer}=acp(),h=hub(e),ss=new Map(),s=await h.createSession(ss,{makeBridge:o=>new A({...o,extra:{command:'fake'}})},e.dir);
 await h.submit(req({query:'first'}),new Res(),s);await tick();const second=new Res();await h.submit(req({query:'second'}),second,s);await tick();
 const prompts=calls.filter(x=>x.method==='session/prompt');assert(prompts.length===1&&second.statusCode===409,'busy ACP accepted second prompt');assert(s.isProcessing&&s.bridge.isProcessing(),'busy flag lost');await s.bridge.submit('direct second').then(()=>{throw Error('direct prompt accepted')},e=>assert(e.message.includes('progress'),'wrong busy error'));const queries=s.replay.map(frame).filter(x=>x.meta.name==='agent:query').map(x=>x.payload.query);
 answer(prompts[0].id);await tick();assert(queries.length===1&&!s.isProcessing&&!s.bridge.isProcessing(),'state not reproduced');return {promptsAccepted:1,recordedQueries:queries};
});
await check('R02 saved page and deletion survive backend restore failure',async()=>{
 let server,listen;const listening=new Promise(r=>listen=r),http=require('http');const e=env({modules:{'node:http':{...http,createServer:f=>{server=http.createServer(f);server.listen=()=>{listen();return server;};return server;}}}}),h=hub(e),dir=path.join(e.dir,'hub-sessions');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'aaaaaa.meta.json'),JSON.stringify({id:'aaaaaa',title:'old ACP',kind:'agent',cwd:e.dir,startedAt:1}));
 h.startHub({host:'localhost',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{const b=new Bridge(o);b.ready=async()=>{throw Error('cannot resume ACP');};return b;}});await listening;
 const statuses=[];for(const m of ['GET','DELETE']){const q=req({},'/aaaaaa/',m);q.headers={host:'localhost'};const r=new Res();const done=new Promise(a=>r.once('finish',a));server.emit('request',q,r);await done;statuses.push(r.statusCode);}
 assert(statuses.every(x=>x===200),'page or deletion requires backend');return {GET:statuses[0],DELETE:statuses[1]};
});
await check('R03 concurrent pins both persist',async()=>{
 const e=env(),h=hub(e);await h.savePinnedSessions(new Set());const a=new Res(),b=new Res();await Promise.all([h.togglePin(req(),a,{id:'aaaaaa'}),h.togglePin(req(),b,{id:'bbbbbb'})]);const pins=[...await h.loadPinnedSessions()];assert(a.statusCode===200&&b.statusCode===200&&pins.length===2,'concurrent pin lost');return {statuses:[a.statusCode,b.statusCode],pins};
});
await check('R04 failed text stays in its originating session',async()=>{
 const u=ui(),c=u.composer();let reject;u.e.context.fetch=()=>new Promise((_,r)=>reject=r);const p=c.doSubmit('session A secret');await tick();u.active.value={id:'bbbbbb',state:{},agentInfo:{}};u.doc.getElementById('query').value='B draft';reject(Error('offline'));await p;const value=u.doc.getElementById('query').value;assert(value==='B draft','A text leaked into B');u.active.value={id:'aaaaaa',state:{},agentInfo:{}};assert(u.doc.getElementById('query').value==='session A secret','A draft lost');return {active:u.active.peek().id,input:value};
});
await check('R05 shell failure preserves newly typed text',async()=>{
 const u=ui(),c=u.composer();let reject;u.e.context.fetch=()=>new Promise((_,r)=>reject=r);const p=c.doSubmit('!echo original');await tick();u.doc.getElementById('query').value='new unsent draft';reject(Error('offline'));await p;const value=u.doc.getElementById('query').value;assert(value.includes('new unsent draft')&&value.includes('echo original'),'shell failure lost text');return {input:value};
});
await check('R06 replay cannot clear an in-flight upload guard',async()=>{
 const u=ui(),c=u.composer(),sv=u.active.peek(),uploads=[];u.e.context.fetch=(url,opts)=>url==='/api/upload'?new Promise(r=>uploads.push(r)):Promise.resolve({ok:true});c.setImages([{data:'img',mimeType:'image/png'}]);const p=c.doSubmit('one');await tick();assert(sv.state.isSubmitting,'not uploading');
 Object.assign(u.e.context,{STATE_DEFAULTS:{isSubmitting:false,replaying:false},hideUsage(){},discardPendingThinking(){}});sv.streamEl=new El();method('web/js/session-view.js','resetForBranchSwitch',u.e.context).call(sv);
 const p2=c.doSubmit('two');await tick();assert(uploads.length===1,'duplicate upload accepted');for(const resolve of uploads)resolve({ok:true,json:async()=>({id:'img'})});await Promise.all([p,p2]);return {uploadsOfSameDraft:uploads.length};
});
await check('R07 replay and live Markdown share one reply',async()=>{
 const u=ui(),nodes=[];Object.assign(u.e.context,{hasReply:s=>!!s.reply.current,sawLiveSegment:s=>s.reply.liveSegment,finalizeThinking(){},mdToHtml:x=>x,stripAnsi:x=>x,append:(_,el)=>nodes.push(el),renderMathIn(){},highlightWithin(){},addReplyCopyBtn(){},performance:{now:()=>1000}});
 const sv={state:{replaying:true,currentTurn:0},reply:{current:null,text:'',liveSegment:false}};
 const sf=ast('web/js/stream/reply.js'),n=find(sf,n=>ts.isVariableDeclaration(n)&&n.name?.text==='appendReplyChunk');u.e.context.scheduleReplyRender=()=>{};
 const append=vm.runInContext('('+n.initializer.getText(sf)+')',u.e.context);u.e.context.appendReplyChunk=append;
 const segment=method('web/js/sse.js','agent:response-segment',u.e.context);
 segment.call(sv,{text:'```js\nconst x = '});segment.call(sv,{text:'1'});sv.state.replaying=false;
 append(sv,';\n```');segment.call(sv,{text:'duplicate live segment'});
 assert(nodes.length===1&&sv.reply.text==='```js\nconst x = 1;\n```','replay split or duplicated');return {blocks:nodes.length,text:sv.reply.text};
});
await check('R08 cancelled approval cannot mutate a file',async()=>{
 const e=env(),{AshBridge}=e.load('src/bridges/ash.ts'),b=Object.create(AshBridge.prototype);EventEmitter.call(b);const controller=new AbortController();let approve;
 const core={bus:{emit:()=>controller.abort(),emitPipeAsync:()=>new Promise(r=>approve=r)}};Object.assign(b,{core,autoApprove:false,backendRegistered:true,pendingPermissions:new Map()});Object.assign(e.context,{core});
 const sf=ast('src/bridges/ash.ts'),node=find(sf,n=>ts.isCallExpression(n)&&n.expression.getText(sf)==='core.handlers.advise'&&n.arguments[0]?.text==='tool:execute');const gate=vm.runInContext(ts.transpileModule('('+node.arguments[1].getText(sf)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,e.context).bind(b);
 const {createWriteFileTool}=await import(root+'/node_modules/agent-sh/dist/agent/tools/write-file.js');const tool=createWriteFileTool(()=>e.dir),file='cancelled-write.txt';const ctx={name:'write_file',args:{path:file,content:'WROTE AFTER CANCEL'},tool,signal:controller.signal};const pending=gate(c=>tool.execute(c.args),ctx);b.cancel();assert(controller.signal.aborted,'cancel not invoked');approve({decision:{outcome:'approved'}});await pending;assert(!fs.existsSync(path.join(e.dir,file)),'cancelled tool still wrote file');return {aborted:true,fileWritten:false};
});
await check('R09 malformed ACP frames do not throw',async()=>{const {A}=acp(),b=new A({extra:{command:'fake'}});await b.ready();let error;try{b.onChunk('null\n');}catch(e){error=e.message;}assert(!error,'malformed ACP threw');for(const value of [null,[],2,{jsonrpc:'2.0',method:8},{jsonrpc:'2.0',method:'session/request_permission',id:8,params:{options:[null,{},2]}}])b.onChunk(JSON.stringify(value)+'\n');return {uncaught:false};});
await check('R10 metadata saves preserve the latest state',async()=>{
 let blocked=false,release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);const real=require('fs');const fake={...real,promises:{...real.promises,writeFile:async(file,data,...args)=>{if(blocked&&String(file).endsWith('.meta.json.tmp')&&JSON.parse(data).title==='old'){started();await gate;}return real.promises.writeFile(file,data,...args);}}};
 const {h,s,e}=await create({modules:{'node:fs':fake}});blocked=true;s.title='old';const first=h.saveSessionMeta(s);await ready;s.title='new';const second=h.saveSessionMeta(s);release();await Promise.all([first,second]);const persisted=JSON.parse(fs.readFileSync(path.join(e.dir,'hub-sessions',s.id+'.meta.json'))).title;assert(persisted==='new','stale metadata overwrite');return {memoryTitle:s.title,diskTitle:persisted};
});
await check('R11 archive blocks late lazy backend creation',async()=>{
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),real=require('fs');const fake={...real,promises:{...real.promises,readFile:async(file,...args)=>{if(String(file).endsWith('.replay.jsonl')){started();await gate;}return real.promises.readFile(file,...args);}}};
 const e=env({modules:{'node:fs':fake}}),h=hub(e),ss=new Map();let made=0,closed=0;const s=await h.createSession(ss,{makeBridge:o=>{made++;const b=new Bridge(o);b.close=()=>closed++;return b;}},e.dir,{id:'aaaaaa',title:'saved',replay:[],startedAt:1});const restoring=s._ensureBridge();void restoring.catch(()=>{});await ready;await h.archiveSession(req({id:s.id}),new Res(),ss);release();await restoring.catch(()=>{});assert(made===0&&closed===0&&!ss.has(s.id),'orphan backend created');return {archived:s._closed,backendsCreated:made,backendsClosed:closed,visibleInSessionMap:ss.has(s.id)};
});
await check('R12 old close callback preserves replacement session',async()=>{
 const {h,s,ss,e}=await create();const old=s.bridge;old.close=()=>{};await h.archiveSession(req({id:s.id}),new Res(),ss);await h.unarchiveSession(req({id:s.id}),new Res(),ss,{makeBridge:o=>new Bridge(o)});assert(ss.has(s.id),'restore failed');old.emit('closed');assert(ss.has(s.id),'old callback removed replacement');return {replacementSurvived:true};
});
await check('R13 image replay preserves submission order',async()=>{
 let release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r),real=require('fs');const fake={...real,promises:{...real.promises,readFile:async(file,...args)=>{if(String(file).endsWith('first.png')){started();await gate;}return real.promises.readFile(file,...args);}}};
 const {h,s,e}=await create({modules:{'node:fs':fake}}),dir=path.join(e.dir,'hub-sessions','uploads');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'first.png'),'FIRST');fs.writeFileSync(path.join(dir,'second.png'),'SECOND');let submitted;s.bridge.submit=async text=>{submitted=JSON.parse(text);return {stopReason:'done'};};const pending=h.submit(req({query:'compare image 1 and 2',images:[{id:'first',mimeType:'image/png'},{id:'second',mimeType:'image/png'}]}),new Res(),s);await ready;await tick();await tick();release();await pending;await tick();const replay=s.replay.map(frame).find(f=>f.meta.name==='agent:query').payload.images.map(x=>x.id);assert(replay.join(',')==='first,second','image order changed');return {backendImages:submitted.images.map(x=>Buffer.from(x.data,'base64').toString()),replayImages:replay};
});
await check('R14 leaf journal survives failed cache writes',async()=>{
 let fail=false;const real=require('fs'),e=env({modules:{'node:fs':{...real,writeFileSync:(file,...args)=>{if(fail&&String(file).endsWith('.leaf'))throw Error('injected EACCES');return real.writeFileSync(file,...args);}}}}),Store=e.load('src/history/session-store.ts').SessionStore,file=path.join(e.dir,'history.jsonl'),store=new Store(file,{create:{cwd:e.dir,sessionId:'aaaaaa'}});await store.appendMessages([{role:'user',content:'old'}]);fail=true;await store.appendMessages([{role:'assistant',content:'new'}]);fail=false;const loaded=new Store(file);assert(loaded.buildMessages().length===2&&loaded.getAllEntries().length===3,'journal did not recover latest');store.setActiveLeaf(store.getRootId());assert(new Store(file).buildMessages().length===0,'explicit rewind did not persist');return {beforeReload:store.buildMessages().length,afterReload:loaded.buildMessages().length,persistedEntries:loaded.getAllEntries().length};
});
await check('R15 metadata timer catches failures and retries',async()=>{
 let fail=false;const real=require('fs'),{e,h,s}=await create({modules:{'node:fs':{...real,promises:{...real.promises,writeFile:async(file,...args)=>{if(fail&&String(file).endsWith('.meta.json.tmp'))throw Error('injected ENOSPC');return real.promises.writeFile(file,...args);}}}}});h.routeEvent(s,{name:'agent:info',payload:{model:'updated'}});fail=true;let error;try{await [...e.timers.values()].find(t=>t.ms===500).fn();}catch(e){error=e.message;}assert(!error,'metadata failure escaped timer');const retry=[...e.timers.values()].find(t=>t.ms===5000);assert(retry,'no retry scheduled');fail=false;await retry.fn();assert(JSON.parse(fs.readFileSync(path.join(e.dir,'hub-sessions',s.id+'.meta.json'))).model==='updated','retry failed');return {uncaught:false,retried:true};
});
await check('R16 different skill source returns conflict',async()=>{
 const calls=[],e=env({modules:{'node:child_process':{execFile:(cmd,args,opts,cb)=>{calls.push(args);cb(null,'');}}}}),h=e.hub(),dir=path.join(e.dir,'skills','common');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'SKILL.md'),'from owner A');const r=new Res();await h.installSkill(req({id:'github:ownerB/common'}),r);assert(r.statusCode===409&&!calls.some(a=>a.includes('pull')||a.includes('clone')),'source collision not blocked');return {status:r.statusCode,skillContent:fs.readFileSync(path.join(dir,'SKILL.md'),'utf8'),gitCalls:calls};
});

await check('R17 deletion drains writes and seals history',async()=>{
 let block=false,release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r),real=require('fs/promises');const {h,s,ss,e}=await create({modules:{'node:fs/promises':{...real,appendFile:async(file,...args)=>{if(block&&String(file).endsWith('.jsonl')){started();await gate;}return real.appendFile(file,...args);}}}});
 s.bridge.messages=[{role:'user',content:'first'}];await s.capture.flush();block=true;s.bridge.messages.push({role:'assistant',content:'private history'});const flush=s.capture.flush();await ready;const response=new Res(),closing=h.closeSession(response,ss,s.id);await tick();assert(!response.writableEnded,'delete acknowledged before pending write finished');release();await flush;await closing;await h.shutdownHub(undefined,ss);let refused=false;try{await s.store.appendMessages([{role:'user',content:'late'}]);}catch{refused=true;}assert(refused,'sealed store accepted write');const files=fs.readdirSync(path.join(e.dir,'hub-sessions')).filter(x=>x.startsWith(s.id)&&!x.endsWith('.deleted'));assert(!files.length,'files recreated after delete');return {remainingFiles:files};
});
await check('R18 title-only replay falls back to tree history',async()=>{
 const e=env(),h=hub(e),Store=e.load('src/history/session-store.ts').SessionStore,dir=path.join(e.dir,'hub-sessions');fs.mkdirSync(dir,{recursive:true});const store=new Store(path.join(dir,'aaaaaa.jsonl'),{create:{cwd:e.dir,sessionId:'aaaaaa'}});await store.appendMessages([{role:'user',content:'real historical question'},{role:'assistant',content:'real historical answer'}]);
 const ss=new Map(),s=await h.createSession(ss,{makeBridge:o=>new Bridge(o)},e.dir,{id:'aaaaaa',title:'saved',startedAt:1,replay:[]});assert(![...e.timers.values()].some(t=>t.ms===2000),'lazy startup wrote replay');fs.writeFileSync(path.join(dir,'aaaaaa.replay.jsonl'),'id: 1\ndata: '+JSON.stringify({meta:{name:'session:title',source:s.id},payload:{title:'saved'}})+'\n\n');
 await s._ensureBridge();const queries=s.replay.map(frame).filter(x=>x.meta.name==='agent:query');assert(s.store.buildMessages().length===2&&queries.length===1,'tree history hidden by title-only replay');return {contextMessages:s.store.buildMessages().length,visibleQueryFrames:queries.length,replayNames:s.replay.map(frame).map(x=>x.meta.name)};
});
await check('R19 model IDs are literal option values',async()=>{
 const u=ui(),sf=ast('web/js/config-panel.js'),n=find(sf,n=>ts.isVariableDeclaration(n)&&n.name?.text==='renderModelDatalist');const model='x"></option><img src="x" onerror="document.documentElement.dataset.audit=1">';const el=new El();Object.assign(u.e.context,{configModelList:el,providerEntry:()=>({models:[{id:model}]})});vm.runInContext('('+n.initializer.getText(sf)+')',u.e.context)('custom');assert(!(el.innerHTML??'').includes('<img')&&el.children.length===1&&el.children[0].value===model,'catalog interpreted as HTML');return {options:el.children.length};
});

await check('R08 cancellation settles pending permissions and removes their timer',async()=>{
 const e=env(),{AshBridge}=e.load('src/bridges/ash.ts'),b=Object.create(AshBridge.prototype);EventEmitter.call(b);Object.assign(b,{pendingPermissions:new Map(),permissionSessionApproved:new Set(),core:{bus:{emit(){}}},backendRegistered:true});
 const sf=ast('src/bridges/ash.ts'),node=find(sf,n=>ts.isCallExpression(n)&&n.expression.getText(sf)==='onPipe'&&n.arguments[0]?.text==='permission:request');
 e.context.testBridge=b;const permission=vm.runInContext(ts.transpileModule('(function(){ return ('+node.arguments[1].getText(sf)+'); }).call(testBridge)',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,e.context);
 const waiting=permission({kind:'file-write'});assert(b.pendingPermissions.size===1,'permission not registered');b.cancel();const result=await waiting;assert(result.decision.outcome==='denied'&&result.decision.reason==='cancelled'&&b.pendingPermissions.size===0&&e.timers.size===0,'cancel left permission pending');
 const controller=new AbortController();const waiting2=permission({kind:'file-write',signal:controller.signal});controller.abort();assert((await waiting2).decision.outcome==='denied'&&b.pendingPermissions.size===0,'signal did not deny');
});
await check('R11 archive storage failure leaves a retryable session',async()=>{
 let fail=false;const real=require('fs');const {e,h,s,ss}=await create({modules:{'node:fs':{...real,promises:{...real.promises,writeFile:async(file,...args)=>{if(fail&&String(file).endsWith('.meta.json.tmp'))throw Error('ENOSPC');return real.promises.writeFile(file,...args);}}}}});
 fail=true;let rejected=false;try{await h.archiveSession(req({id:s.id}),new Res(),ss);}catch{rejected=true;}assert(rejected&&!s._closing&&!s._closed&&ss.has(s.id),'failed archive stranded session');fail=false;const response=new Res();await h.archiveSession(req({id:s.id}),response,ss);assert(response.statusCode===200&&!ss.has(s.id),'archive retry failed');
});
await check('R11 backend awaiting ready is closed when archive wins',async()=>{
 let ready,release,made=0,closed=0;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r),e=env(),h=hub(e),ss=new Map();const s=await h.createSession(ss,{makeBridge:o=>{made++;const b=new Bridge(o);b.ready=async()=>{ready();await gate;};b.close=()=>closed++;return b;}},e.dir,{id:'aaaaaa',title:'saved',startedAt:1,replay:[]});
 const restoring=s._ensureBridge();void restoring.catch(()=>{});await started;await h.archiveSession(req({id:s.id}),new Res(),ss);release();await restoring.catch(()=>{});assert(made===1&&closed>=1&&!ss.has(s.id)&&!s.bridge,'initializing backend leaked');
});
await check('R12 concurrent unarchives share a single session identity',async()=>{
 const {h,s,ss}=await create();await h.archiveSession(req({id:s.id}),new Res(),ss);const a=new Res(),b=new Res();await Promise.all([h.unarchiveSession(req({id:s.id}),a,ss,{makeBridge:o=>new Bridge(o)}),h.unarchiveSession(req({id:s.id}),b,ss,{makeBridge:o=>new Bridge(o)})]);assert([a.statusCode,b.statusCode].sort().join(',')==='200,409'&&ss.size===1,'duplicate unarchive accepted');
});
await check('R14 legacy leaf selection and journal compaction remain compatible',async()=>{
 const e=env(),Store=e.load('src/history/session-store.ts').SessionStore,file=path.join(e.dir,'legacy.jsonl'),s=new Store(file,{create:{cwd:e.dir,sessionId:'aaaaaa'}});const ids=await s.appendMessages([{role:'user',content:'old'},{role:'assistant',content:'answer'},{role:'user',content:'new'}]);
 fs.writeFileSync(file,fs.readFileSync(file,'utf8').split('\n').filter(l=>!l||JSON.parse(l).type!=='leaf').join('\n'));fs.writeFileSync(file+'.leaf',ids[0]);const restored=new Store(file);assert(restored.buildMessages().length===1,'legacy chosen leaf ignored');restored.setActiveLeaf(ids[2]);const compacted=await restored.appendCompaction(ids[2],1000),loaded=new Store(file);assert(loaded.getActiveLeaf()===compacted&&loaded.buildMessages().at(-1).content==='new','compaction journal did not restore');
});
await check('R17 deletion drains pending metadata writes as well as history',async()=>{
 let block=false,ready,release;const started=new Promise(r=>ready=r),gate=new Promise(r=>release=r),real=require('fs');const {e,h,s,ss}=await create({modules:{'node:fs':{...real,promises:{...real.promises,writeFile:async(file,...args)=>{if(block&&String(file).endsWith('.meta.json.tmp')){ready();await gate;}return real.promises.writeFile(file,...args);}}}}});block=true;s.title='late';const writing=h.saveSessionMeta(s);await started;const response=new Res(),closing=h.closeSession(response,ss,s.id);await tick();assert(!response.writableEnded,'delete acknowledged before meta drain');release();await Promise.all([writing,closing]);assert(!fs.readdirSync(path.join(e.dir,'hub-sessions')).some(f=>f.startsWith(s.id)&&!f.endsWith('.deleted')),'metadata resurrected');
});
await check('R19 provider options use literal text and values',async()=>{
 const u=ui(),provider='evil"><img src=x onerror=alert(1)>',el=new El();Object.assign(u.e.context,{configProvider:el,panelProviderCatalog:{providers:[{name:provider}]},providerLabel:id=>id});const sf=ast('web/js/config-panel.js'),n=find(sf,n=>ts.isVariableDeclaration(n)&&n.name?.text==='populateProviderSelect');vm.runInContext('('+n.initializer.getText(sf)+')',u.e.context)();assert(el.children.length===1&&el.children[0].value===provider&&el.children[0].textContent===provider,'provider option interpreted as markup');
});

console.log(JSON.stringify({checks:findings.length,passed:findings.filter(f=>f.passed).length}));
clearTimeout(watchdog);
if(findings.some(f=>!f.passed))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
