process.env.ASHUB_TEST_ROOT=process.env.ASHUB_TEST_ROOT || require('path').resolve(__dirname,'..');
const {env,Res,req,Bridge,assert,ts,vm,fs,path,root}=require('./harness.cjs');
const {ui,El,signal}=require('./ui-harness.cjs');const {EventEmitter}=require('events');
const tick=()=>new Promise(r=>setImmediate(r));const findings=[];
function ast(file){return ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true)}
function find(sf,p){let out;function walk(n){if(!out&&p(n))out=n;if(!out)ts.forEachChild(n,walk)}walk(sf);assert(out,'AST missing');return out;}
function variable(file,name,ctx){let sf=ast(file),n=find(sf,n=>ts.isVariableDeclaration(n)&&n.name?.text===name);return vm.runInContext('('+n.initializer.getText(sf)+')',ctx)}
function method(file,name,ctx){const sf=ast(file),n=find(sf,n=>ts.isMethodDeclaration(n)&&n.name?.text===name);return vm.runInContext(ts.transpileModule('({'+n.getText(sf)+'})['+JSON.stringify(name)+']',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx)}
function hub(e){return e.load('src/hub.ts','export const audit={createSession,closeSession,forkEndpoint,rewindContext,saveSessionMeta,archiveSession,unarchiveSession,shutdownHub,_flushBuf,persistReplayFile,routeEvent,submit,dropContext,openSseMulti,getContext,setCwdEndpoint,updateConfig,setAutoApprove,uploadImage,serveUpload,readBody,updateTitle,flushPtyBuffer,rewindToTurn,rewindToEntry,loadPersistedSessions,loadArchivedSessions,contextTransaction};').audit}
async function create(extra={}){const e=env(extra),h=hub(e),ss=new Map(),s=await h.createSession(ss,{makeBridge:o=>new Bridge(o)},e.dir);return{e,h,ss,s}}
const frame=f=>JSON.parse(f.split('data: ')[1]);
async function check(id,fn){try{const detail=await fn();findings.push({id,passed:true,detail});console.log('PASS',id,JSON.stringify(detail))}catch(e){findings.push({id,passed:false,error:e.stack});console.log('FAIL',id,e.stack)}}
function acp(){const calls=[],child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.kill=()=>{};child.stdin={writable:true,end(){},write:raw=>{const m=JSON.parse(raw);calls.push(m);if(m.method==='initialize'||m.method==='session/new')queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:1,agentCapabilities:{loadSession:true}}:{sessionId:'remote'}})+'\n'));}};const e=env({modules:{'node:child_process':{spawn:()=>child}}}),A=e.load('src/bridges/acp.ts').AcpBridge;return{e,A,calls,child}}
const watchdog=setTimeout(()=>{console.error('AUDIT TIMEOUT');process.exit(1)},30000);
(async()=>{
await check('T01 malformed ACP options are cancelled without timer exceptions',async()=>{
 const {e,A,calls}=acp(),b=new A({extra:{command:'fake'}});await b.ready();b.onChunk(JSON.stringify({jsonrpc:'2.0',id:'bad',method:'session/request_permission',params:{options:[{optionId:'x',name:'x',kind:123}]}})+'\n');let error;try{[...e.timers.values()].find(t=>t.ms===30000).fn()}catch(e){error=e.message}assert(!error,'permission timeout threw');assert(calls.at(-1).result?.outcome?.outcome==='cancelled','malformed permission was not cancelled');return{uncaughtTimerException:error};
});
await check('T02 failed leaf commit rolls back kernel and capture',async()=>{
 let fail=false;const real=require('fs');const {e,h,s}=await create({modules:{'node:fs':{...real,appendFileSync:(file,...args)=>{if(fail&&String(file).endsWith('.jsonl'))throw Error('ENOSPC leaf commit');return real.appendFileSync(file,...args)}}}});s.bridge.messages=[{role:'user',content:'one'},{role:'assistant',content:'two'},{role:'user',content:'three'}];await s.capture.flush();const first=s.store.buildBranchWithIds().entryIds[0];fail=true;const r=new Res();await h.forkEndpoint(req({entryId:first}),r,s);fail=false;assert(r.statusCode===500&&s.bridge.messages.length===3&&s.store.buildMessages().length===3,'failed fork left split history');s.bridge.messages.push({role:'user',content:'new branch'});await s.capture.flush();assert(s.store.buildMessages().map(m=>m.content).join('|')===s.bridge.messages.map(m=>m.content).join('|'),'next append diverged');return{status:r.statusCode,liveMessages:s.bridge.messages.map(m=>m.content),diskBranch:s.store.buildMessages().map(m=>m.content)};
});
await check('T03 failed replay save recovers complete history from the tree',async()=>{
 let fail=false;const real=require('fs');const {e,h,s,ss}=await create({modules:{'node:fs':{...real,promises:{...real.promises,writeFile:async(file,...args)=>{if(fail&&String(file).endsWith('.replay.jsonl.tmp'))throw Error('ENOSPC');return real.promises.writeFile(file,...args)}}}}});
 await h.submit(req({query:'kept'}),new Res(),s);await tick();await s.contextLock;await h.shutdownHub(undefined,ss);
 const s2=await h.createSession(ss,{makeBridge:o=>new Bridge(o)},e.dir,{id:s.id,title:'restored',replay:[],startedAt:1});await s2._ensureBridge();fail=true;await h.submit(req({query:'lost replay'}),new Res(),s2);await tick();await s2.contextLock;await h.shutdownHub(undefined,ss);fail=false;
 const s3=await h.createSession(ss,{makeBridge:o=>new Bridge(o)},e.dir,{id:s.id,title:'restored',replay:[],startedAt:1});await s3._ensureBridge();const queries=s3.replay.map(frame).filter(f=>f.meta.name==='agent:query').map(f=>f.payload.query);assert(s3.store.buildMessages().length===2&&queries.includes('lost replay'),'history not repaired');return{treeMessages:s3.store.buildMessages().map(m=>m.content),visibleQueries:queries};
});
await check('T04 failed deletion is visible, excluded from restore and retryable',async()=>{
 let fail=false;const real=require('fs');const {e,h,s,ss}=await create({modules:{'node:fs':{...real,promises:{...real.promises,unlink:async(file)=>{if(fail&&String(file).endsWith('.meta.json'))throw Error('EACCES');return real.promises.unlink(file)}}}}});fail=true;const r=new Res();await h.closeSession(r,ss,s.id);assert(r.statusCode===500&&fs.existsSync(path.join(e.dir,'hub-sessions',s.id+'.meta.json')),'deletion falsely succeeded');assert((await h.loadPersistedSessions()).length===0,'deleted session resurrected');fail=false;const retry=new Res();await h.closeSession(retry,ss,s.id);assert(retry.statusCode===200&&!fs.existsSync(path.join(e.dir,'hub-sessions',s.id+'.meta.json')),'delete retry failed');return{status:r.statusCode,retry:retry.statusCode};
});
await check('T05 rewind completion stays bound to its originating session',async()=>{
 const u=ui(),a=u.active.peek();let release;const response=new Promise(r=>release=r),resynced=[],texts=[];Object.assign(u.e.context,{state:a.state,currentSessionId:()=>u.active.peek().id,activeSession:u.active,rewindInFlightFor:new Set(),rewindToTurn:()=>response,toast(){},t:x=>x,setComposerTextForSession:(sid,text)=>texts.push({sid,text}),CustomEvent:class{constructor(type){this.type=type}}});a.resync=()=>resynced.push('A');const fn=variable('web/js/actions.js','rewindFromBox',u.e.context),box=new El();box.dataset.entryId='entry';box._queryText='A private query';const p=fn(box);u.active.value={id:'bbbbbb',state:{},resync:()=>resynced.push('B')};release({stats:{leafId:'x'}});await p;assert(texts[0]?.sid==='aaaaaa'&&resynced[0]==='A','rewind crossed sessions');return{texts,resynced};
});
await check('T06 concurrent settings updates preserve approval, models and budgets',async()=>{
 const {e,h,ss}=await create(),file=path.join(e.dir,'settings.json');fs.writeFileSync(file,JSON.stringify({'ashub.permissions.autoApprove':true,subagentModels:{coder:'old'},providers:{A:{apiKey:'secret'}}}));
 const settings=e.load('src/settings-store.ts');
 const edit=h.updateConfig(req({marker:'editor',providers:{A:{apiKey:'••••'}}}),new Res(),ss);
 const toggle=new Res(),approval=h.setAutoApprove(req({autoApprove:false}),toggle,ss);
 settings.updateSettingsFile(file,d=>({...d,subagentModels:{coder:'new'},subagentBudgets:{coder:{budgetTokens:5000}}}));
 await Promise.all([edit,approval]);const stored=JSON.parse(fs.readFileSync(file));
 assert(stored['ashub.permissions.autoApprove']===false&&stored.marker==='editor'&&stored.subagentModels.coder==='new'&&stored.subagentBudgets.coder.budgetTokens===5000,'settings update lost another writer');return{autoApprove:stored['ashub.permissions.autoApprove'],marker:stored.marker};
});
await check('T07 branch reset retains cwd and context capacity',async()=>{
 const u=ui(),s={state:{cwd:'/project',contextWindow:128000,replaying:false},streamEl:new El()};Object.assign(u.e.context,{STATE_DEFAULTS:{cwd:'',contextWindow:0,replaying:false},hideUsage(){},discardPendingThinking(){}});method('web/js/session-view.js','resetForBranchSwitch',u.e.context).call(s);assert(s.state.cwd==='/project'&&s.state.contextWindow===128000,'static state lost');return{cwd:s.state.cwd,contextWindow:s.state.contextWindow};
});
await check('T08 ACP context and export use readable saved history',async()=>{
 const {e,A}=acp(),h=hub(e),ss=new Map(),s=await h.createSession(ss,{makeBridge:o=>new A({...o,extra:{command:'fake'}})},e.dir);s.replay.push('data: '+JSON.stringify({meta:{name:'agent:query'},payload:{query:'persisted ACP query'}})+'\n\n');const r=new Res();await h.getContext(r,s);assert(r.statusCode===200&&r.json().readOnly&&r.json().messages[0].content==='persisted ACP query','read-only snapshot missing');return{status:r.statusCode,error:r.body};
});
await check('T09 uploads for deleted sessions are rejected',async()=>{
 const {e,h,s,ss}=await create();await h.closeSession(new Res(),ss,s.id);const r=new Res();await h.uploadImage(req({sessionId:s.id,data:Buffer.from('private image').toString('base64'),mimeType:'image/png'}),r,ss);assert(r.statusCode===404,'orphan accepted');return{status:r.statusCode};
});
await check('T10 backend cwd changes update Hub and persisted metadata',async()=>{
 const {e,h,s}=await create();const original=s.cwd;h.routeEvent(s,{name:'shell:cwd-change',payload:{cwd:'/new/project'}});await h.saveSessionMeta(s);const meta=JSON.parse(fs.readFileSync(path.join(e.dir,'hub-sessions',s.id+'.meta.json')));assert(s.cwd==='/new/project'&&meta.cwd==='/new/project','cwd not synchronized');return{eventCwd:'/new/project',hubCwd:s.cwd,persistedCwd:meta.cwd};
});
await check('T11 late API key reveals cannot cross providers',async()=>{
 const u=ui();u.e.context.CustomEvent=u.e.context.Event;u.doc.getElementById('config-auto-approve').closest=()=>null;u.modules['./sse.js']={invalidateModelCache(){},getModelCacheGeneration(){},setModelCache(){}};
 u.e.context.fetch=async url=>({ok:true,json:async()=>url==='/api/models'?{providers:[{name:'A',models:[]},{name:'B',models:[]}]}:{defaultProvider:'A',providers:{A:{apiKey:'masked'},B:{apiKey:'masked'}}}});
 const m=u.e.load('web/js/config-panel.js');await m.setConfigOpen(true);const key=u.doc.getElementById('config-apikey'),provider=u.doc.getElementById('config-provider'),pendingRequests=new Map();
 u.e.context.fetch=url=>new Promise(resolve=>pendingRequests.set(url,resolve));const reveal=u.doc.getElementById('config-apikey-toggle').events.click[0];
 const pendingA=reveal();provider.value='B';provider.events.change[0]();const pendingB=reveal();
 const finish=([...pendingRequests.keys()].find(url=>url.includes('B')));assert(finish,'provider B reveal request missing');pendingRequests.get(finish)({ok:true,json:async()=>({apiKey:'FAKE-B-KEY'})});await pendingB;
 const first=[...pendingRequests.keys()].find(url=>url!==finish);pendingRequests.get(first)({ok:true,json:async()=>({apiKey:'FAKE-A-KEY'})});await pendingA;
 assert(provider.value==='B'&&key.value==='FAKE-B-KEY'&&key.type==='text','late provider A key overwrote provider B reveal');return{provider:provider.value,key:key.value};
});
await check('T12 failed initialization closes the new bridge',async()=>{
 const e=env(),h=hub(e),ss=new Map();let closed=0;const b=new Bridge();b.ready=async()=>{throw Error('failed after starting backend')};b.close=()=>closed++;let error;try{await h.createSession(ss,{makeBridge:()=>b},e.dir)}catch(e){error=e.message}assert(error&&closed===1&&ss.size===0,'failed bridge leaked');return{error,closeCalls:closed,registeredSessions:ss.size};
});
await check('T13 terminal reconnect preserves scrollback and uses its own cursor',async()=>{
 const u=ui(),sources=[];u.modules['./store.js']={activeSessionId:signal(''),openTabs:signal([])};u.e.context.EventSource=class{constructor(url){this.url=url;sources.push(this)}close(){this.closed=true}};
 const manager=u.e.load('web/js/session-manager.js');manager.sessionKinds.set('aaaaaa','terminal');let display='';const terminal={term:{options:{},reset:()=>display='',write:x=>display+=x},fit(){}};
 const receive=method('web/js/terminal-view.js','receiveFrame',u.e.context);manager.sessions.set('aaaaaa',{receiveFrame:f=>receive.call(terminal,f)});
 manager.subscribeSession('aaaaaa');await tick();let source=sources.at(-1);source.onopen();
 const send=(name,raw,id)=>source.onmessage({lastEventId:String(id),data:JSON.stringify({meta:{source:'aaaaaa',name},payload:{raw}})});
 send('hub:replay-starting','',100);for(let i=1;i<=3;i++)send('shell:pty-data',String(i).repeat(30000),i);send('hub:replay-done','',101);
 // A different session can have arbitrarily higher frame ids.
 source.onmessage({lastEventId:'9999',data:JSON.stringify({meta:{source:'bbbbbb',name:'agent:query'},payload:{query:'other'}})});
 source.onerror();assert(source.closed,'native reconnect keeps stale all URL');const retry=[...u.e.timers.values()].find(t=>t.ms===1000);assert(retry,'retry missing');retry.fn();await tick();source=sources.at(-1);
 assert(new URL(source.url,'http://localhost').searchParams.get('subs')==='aaaaaa:0:3','terminal did not retain its cursor');source.onopen();send('shell:pty-data','delta',4);assert(display.length===90005,'terminal scrollback reset');return{scrollback:display.length,subs:new URL(source.url,'http://localhost').searchParams.get('subs')};
});
await check('T14 unsupported cwd changes return conflict without changing metadata',async()=>{
 const {e,A,calls}=acp(),h=hub(e),ss=new Map(),s=await h.createSession(ss,{makeBridge:o=>new A({...o,extra:{command:'fake'}})},e.dir);const initial=calls.find(c=>c.method==='session/new').params.cwd;const r=new Res();await h.setCwdEndpoint(req({cwd:'/other/project'}),r,s);assert(r.statusCode===409&&s.cwd===initial&&!calls.some(c=>c.params?.cwd==='/other/project'),'unsupported cwd acknowledged');return{status:r.statusCode,displayedCwd:s.cwd,backendInitializedCwd:initial,protocolMethods:calls.map(c=>c.method)};
});
await check('T15 lazy rename wins over an obsolete replay title',async()=>{
 const {e,h,s,ss}=await create();await h.submit(req({query:'hello'}),new Res(),s);await tick();await s.contextLock;await h.updateTitle(req({title:'old title'}),new Res(),s);await h.shutdownHub(undefined,ss);
 const restored=await h.createSession(ss,{makeBridge:o=>new Bridge(o)},e.dir,{id:s.id,title:'old title',startedAt:1,replay:[]});await h.updateTitle(req({title:'new title'}),new Res(),restored);const r=new Res();await h.openSseMulti(Object.assign(new EventEmitter(),{headers:{}}),r,ss,s.id+':all','').catch(e=>{throw e});
 const titles=r.body.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6))).filter(f=>f.meta.name==='session:title').map(f=>f.payload.title);assert(restored.title==='new title'&&titles.at(-1)==='new title','replay used obsolete title');return{metadataTitle:restored.title,replayedTitles:titles};
});

await check('T02 rewind by index, entry and turn all roll back failed commits',async()=>{
 for(const kind of ['index','entry','turn']){
  let fail=false;const real=require('fs');const {e,h,s}=await create({modules:{'node:fs':{...real,appendFileSync:(f,...args)=>{if(fail&&String(f).endsWith('.jsonl'))throw Error('ENOSPC');return real.appendFileSync(f,...args)}}}});
  s.bridge.messages=[{role:'user',content:'one'},{role:'assistant',content:'two'},{role:'user',content:'three'}];await s.capture.flush();const ids=s.store.buildBranchWithIds().entryIds;fail=true;const response=new Res();
  const context=new Res();await h.getContext(context,s);const revision=JSON.parse(context.body).revision;
  if(kind==='index')await h.rewindContext(req({toIndex:1,revision}),response,s);else if(kind==='entry')await h.rewindToEntry(response,s,ids[2]);else await h.rewindToTurn(req({turn:1,revision}),response,s);
  assert(response.statusCode===500&&s.bridge.messages.length===3&&s.capture.length()===3&&s.store.getActiveLeaf()===ids[2],'rewind failed to roll back '+kind);
 }
});
await check('T02 a partially written leaf commit is rolled back on disk',async()=>{
 let fail=false;const real=require('fs'),e=env({modules:{'node:fs':{...real,appendFileSync:(file,data,...args)=>{if(fail&&String(file).endsWith('.jsonl')){real.appendFileSync(file,data.slice(0,10));throw Error('partial write')}return real.appendFileSync(file,data,...args)}}}}),Store=e.load('src/history/session-store.ts').SessionStore,file=path.join(e.dir,'tree.jsonl'),store=new Store(file,{create:{cwd:e.dir,sessionId:'aaaaaa'}});const ids=await store.appendMessages([{role:'user',content:'one'},{role:'assistant',content:'two'}]);const before=fs.readFileSync(file,'utf8');fail=true;try{store.setActiveLeaf(ids[0])}catch{}fail=false;assert(fs.readFileSync(file,'utf8')===before,'partial commit survived');assert(new Store(file).getActiveLeaf()===ids[1],'reloaded wrong leaf');await store.appendMessages([{role:'user',content:'three'}]);assert(new Store(file).buildMessages().length===3,'next append damaged');
});
await check('T02 failed rollback blocks subsequent submits and context edits',async()=>{
 let fail=false;const real=require('fs'),{h,s}=await create({modules:{'node:fs':{...real,appendFileSync:(f,...args)=>{if(fail&&String(f).endsWith('.jsonl'))throw Error('ENOSPC');return real.appendFileSync(f,...args)}}}});s.bridge.messages=[{role:'user',content:'one'},{role:'user',content:'two'}];await s.capture.flush();let edits=0;const compact=s.bridge.compact.bind(s.bridge);s.bridge.compact=async strategy=>{if(++edits===2)throw Error('backend rollback unavailable');return compact(strategy)};fail=true;await h.forkEndpoint(req({entryId:s.store.buildBranchWithIds().entryIds[0]}),new Res(),s);assert(s._contextBroken,'unsafe context not blocked');const response=new Res();await h.submit(req({query:'must not run'}),response,s);assert(response.statusCode===409&&s.bridge.messages.length===1,'unsafe submit accepted');
});
await check('T03 failed atomic replay replacement keeps previous file and retries',async()=>{
 let fail=false;const real=require('fs'),{e,h,s}=await create({modules:{'node:fs':{...real,promises:{...real.promises,rename:async(from,to)=>{if(fail&&String(to).endsWith('.replay.jsonl'))throw Error('ENOSPC rename');return real.promises.rename(from,to)}}}}});h.routeEvent(s,{name:'agent:query',payload:{query:'before'}});await h.persistReplayFile(s.id,s.replay);const file=path.join(e.dir,'hub-sessions',s.id+'.replay.jsonl'),before=fs.readFileSync(file,'utf8');h.routeEvent(s,{name:'agent:query',payload:{query:'after'}});fail=true;await h.persistReplayFile(s.id,s.replay);assert(fs.readFileSync(file,'utf8')===before,'failed replacement truncated history');const retry=[...e.timers.values()].find(t=>t.ms===5000);assert(retry,'missing retry');fail=false;retry.fn();await h.persistReplayFile(s.id,s.replay);assert(fs.readFileSync(file,'utf8').includes('after'),'retry lost new frame');
});
await check('T03 archive refuses to discard unsaved replay',async()=>{
 let fail=false;const real=require('fs'),{e,h,s,ss}=await create({modules:{'node:fs':{...real,promises:{...real.promises,writeFile:async(file,...args)=>{if(fail&&String(file).endsWith('.replay.jsonl.tmp'))throw Error('ENOSPC');return real.promises.writeFile(file,...args)}}}}});h.routeEvent(s,{name:'agent:query',payload:{query:'unsaved'}});fail=true;let error;try{await h.archiveSession(req({id:s.id}),new Res(),ss)}catch(e){error=e}assert(error&&ss.get(s.id)===s&&!s._closed&&!s._closing,'archive discarded live unsaved state');fail=false;await h.archiveSession(req({id:s.id}),new Res(),ss);assert(!ss.has(s.id)&&fs.readFileSync(path.join(e.dir,'hub-sessions',s.id+'.replay.jsonl'),'utf8').includes('unsaved'),'archive retry lost data');
});
await check('T06 actual subagent model and budget writers preserve unrelated settings',async()=>{
 const e=env(),file=path.join(e.dir,'settings.json');fs.writeFileSync(file,JSON.stringify({'ashub.permissions.autoApprove':false,providers:{A:{apiKey:'fake'}}}));Object.assign(e.context,{path,CONFIG_DIR:e.dir,updateSettingsFile:e.load('src/settings-store.ts').updateSettingsFile,reloadSettings(){},SUBAGENT_TYPES:{coder:{}},REASONING_LEVELS:new Set(['high'])});
 const sf=ast('src/bridges/ash.ts');const handler=name=>{const n=find(sf,n=>ts.isCallExpression(n)&&n.expression.getText(sf)==='core.handlers.define'&&n.arguments[0]?.text===name);return vm.runInContext(ts.transpileModule('('+n.arguments[1].getText(sf)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,e.context)};
 handler('subagent:set-model')({type:'coder',model:'chosen'});handler('subagent:set-budget')({type:'coder',budgetTokens:7000,maxIterations:3,reasoning:'high'});let data=JSON.parse(fs.readFileSync(file));assert(data.subagentModels.coder==='chosen'&&data.subagentBudgets.coder.budgetTokens===7000&&data['ashub.permissions.autoApprove']===false,'writer discarded settings');handler('subagent:set-model')({type:'coder',model:'inherit'});handler('subagent:set-budget')({type:'coder',budgetTokens:null,maxIterations:null,reasoning:null});data=JSON.parse(fs.readFileSync(file));assert(!('coder' in data.subagentModels)&&!('coder' in data.subagentBudgets)&&data.providers.A.apiKey==='fake','inherit did not clear settings');
});
await check('T06 failed settings rename preserves valid original',async()=>{
 const real=require('fs'),e=env({modules:{'node:fs':{...real,renameSync:()=>{throw Error('EACCES')}}}}),file=path.join(e.dir,'settings.json');fs.writeFileSync(file,'{"keep":true}');let failed=false;try{e.load('src/settings-store.ts').updateSettingsFile(file,()=>({keep:false}))}catch{failed=true}assert(failed&&JSON.parse(fs.readFileSync(file)).keep&&fs.readdirSync(e.dir).filter(f=>f.endsWith('.tmp')).length===0,'failed config write damaged original');
});
await check('T09 concurrent delete drains image upload before success',async()=>{
 let started,release,block=false;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r),real=require('fs');const {e,h,s,ss}=await create({modules:{'node:fs':{...real,promises:{...real.promises,writeFile:async(file,...args)=>{if(block&&String(file).includes('/uploads/')){started();await gate}return real.promises.writeFile(file,...args)}}}}});block=true;const uploaded=new Res(),writing=h.uploadImage(req({sessionId:s.id,data:'YQ==',mimeType:'image/png'}),uploaded,ss);await ready;const deleted=new Res(),second=new Res(),closing=h.closeSession(deleted,ss,s.id),again=h.closeSession(second,ss,s.id);await tick();assert(!deleted.writableEnded&&!second.writableEnded,'delete returned while upload pending');release();await Promise.all([writing,closing,again]);assert(deleted.statusCode===200&&second.statusCode===200&&fs.readdirSync(path.join(e.dir,'hub-sessions','uploads')).length===0,'upload resurrected private data');
});
await check('T09 supported uploads succeed and invalid mime types never write',async()=>{
 const {e,h,s,ss}=await create();const ok=new Res();await h.uploadImage(req({sessionId:s.id,data:'YQ==',mimeType:'image/png'}),ok,ss);assert(ok.statusCode===200&&ok.json().id.startsWith(s.id+'_'),'valid upload failed');const bad=new Res();await h.uploadImage(req({sessionId:s.id,data:'YQ==',mimeType:'../../evil'}),bad,ss);assert(bad.statusCode===400&&fs.readdirSync(path.join(e.dir,'hub-sessions','uploads')).length===1,'invalid upload wrote file');
});
await check('T14 supported cwd change reaches backend; busy changes are refused',async()=>{
 const {e,h,s}=await create();const cwd=path.join(e.dir,'new');fs.mkdirSync(cwd);let backendCwd;s.bridge.supportsCwdChange=true;s.bridge.relayEvent=(name,p)=>{backendCwd=p.cwd;h.routeEvent(s,{name,payload:p})};const response=new Res();await h.setCwdEndpoint(req({cwd}),response,s);assert(response.statusCode===200&&backendCwd===cwd&&s.cwd===cwd,'cwd change was not applied');s.isProcessing=true;const busy=new Res();await h.setCwdEndpoint(req({cwd:e.dir}),busy,s);assert(busy.statusCode===409&&s.cwd===cwd,'busy cwd changed');
});
await check('T13 server honors per-terminal cursor over unrelated global since',async()=>{
 const {e,h,ss}=await create();const s=await h.createSession(ss,{makeBridge:o=>new Bridge(o)},e.dir,undefined,'terminal');h.routeEvent(s,{name:'shell:pty-data',payload:{raw:'before'}});h.flushPtyBuffer(s);const cursor=s.lastFrameSeq;h.routeEvent(s,{name:'shell:pty-data',payload:{raw:'after'}});h.flushPtyBuffer(s);const response=new Res();await h.openSseMulti(Object.assign(new EventEmitter(),{headers:{}}),response,ss,s.id+':0:'+cursor,'999999');assert(response.body.includes('after')&&!response.body.includes('before')&&!response.body.includes('hub:replay-starting'),'incremental replay dropped or reset terminal output');
});
await check('T05 background composer draft is restored only when its session activates',async()=>{
 const u=ui();u.composer();const m=u.e.load('web/js/composer.js'),input=u.ids.get('query');u.active.value={id:'bbbbbb',state:{}};input.value='B draft';m.setComposerTextForSession('aaaaaa','A rewind');assert(input.value==='B draft','background rewind changed current composer');u.active.value={id:'aaaaaa',state:{}};assert(input.value==='A rewind','origin draft not restored');
});

console.log('Round 3:',findings.filter(f=>f.passed).length+'/'+findings.length+' passed');clearTimeout(watchdog);if(findings.some(f=>!f.passed))process.exitCode=1;
})().catch(e=>{clearTimeout(watchdog);console.error(e);process.exitCode=1});
