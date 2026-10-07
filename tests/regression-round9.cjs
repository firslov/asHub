process.env.ASHUB_TEST_ROOT ||= require('path').resolve(__dirname,'..');
const {env,Res,req,Bridge,assert,ts,vm,fs,path,root}=require('./harness.cjs');
const {ui,El,signal}=require('./ui-harness.cjs');const {EventEmitter}=require('events');
const tick=()=>new Promise(r=>setImmediate(r));const findings=[];
function ast(file){return ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true)}
function find(sf,p){let out;function walk(n){if(!out&&p(n))out=n;if(!out)ts.forEachChild(n,walk)}walk(sf);assert(out,'AST missing');return out;}
function variable(file,name,ctx){const sf=ast(file),n=find(sf,n=>ts.isVariableDeclaration(n)&&n.name?.text===name);return vm.runInContext('('+n.initializer.getText(sf)+')',ctx)}
function method(file,name,ctx){const sf=ast(file),n=find(sf,n=>ts.isMethodDeclaration(n)&&n.name?.text===name);return vm.runInContext(ts.transpileModule('({'+n.getText(sf)+'})['+JSON.stringify(name)+']',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx)}
function callback(file,expression,event,ctx){const sf=ast(file),n=find(sf,n=>ts.isCallExpression(n)&&n.expression.getText(sf)===expression&&n.arguments[0]?.text===event);return vm.runInContext(ts.transpileModule('('+n.arguments[1].getText(sf)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx)}
function hub(e){return e.load('src/hub.ts','export const audit={startHub,createSession,closeSession,forkEndpoint,rewindContext,saveSessionMeta,archiveSession,unarchiveSession,shutdownHub,_flushBuf,persistReplayFile,routeEvent,submit,dropContext,openSseMulti,getContext,setCwdEndpoint,updateConfig,setAutoApprove,uploadImage,serveUpload,readBody,updateTitle,flushPtyBuffer,setSubagentModel,setSubagentBudget,loadArchivedSessions,listSessions,restoreSessions,rewindToTurn,execCommand,tagLastQueryFrame,setSessionTitle,setModelEndpoint,uninstallSkill,listInstalledSkills,searchSkills,_writeLocks};').audit}
async function create(extra={}){const e=env(extra),h=hub(e),ss=new Map(),s=await h.createSession(ss,{makeBridge:o=>new Bridge(o)},e.dir);return{e,h,ss,s}}
const frame=f=>JSON.parse(f.split('data: ')[1]);
async function check(id,fn){if(process.env.ONLY&&!process.env.ONLY.split(',').some(x=>id.startsWith(x)))return;try{const detail=await fn();findings.push({id,passed:true,detail});console.log('PASS',id,JSON.stringify(detail))}catch(e){findings.push({id,passed:false,error:e.stack});console.log('FAIL',id,e.stack)}}
const watchdog=setTimeout(()=>{console.error('TIMEOUT');process.exit(1)},30000);
(async()=>{
await check('Z01 failed title transaction cannot leak into earlier metadata save',async()=>{
 const real=require('fs');let hold=false,release,started,writes=0;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const {e,h,s}=await create({modules:{'node:fs':{...real,promises:{...real.promises,readFile:async(file,...args)=>{if(hold&&String(file).endsWith('.meta.json')){hold=false;started();await gate}return real.promises.readFile(file,...args)},writeFile:async(file,...args)=>{if(writes&&String(file).endsWith('.meta.json.tmp')&&++writes===3)throw Error('ENOSPC title transaction');return real.promises.writeFile(file,...args)}}}}});
 await h.setSessionTitle(s,'original',true);hold=true;const prior=h.saveSessionMeta(s);await ready;writes=1;const rename=h.setSessionTitle(s,'new-name',true).then(()=>null,e=>e);await tick();release();await prior;const error=await rename;
 const disk=JSON.parse(fs.readFileSync(path.join(e.dir,'hub-sessions',s.id+'.meta.json'),'utf8'));
 assert(error&&s.title==='original'&&disk.title==='original','regression');return{error:String(error),memoryTitle:s.title,diskTitle:disk.title,memoryUserTitle:s.userTitle,diskUserTitle:disk.userTitle};
});
await check('Z02 cross-session budget load retries snapshot from before pending global save',async()=>{
 const u=ui(),reads=[];let sid='aaaaaa',release,stored=40000,displayed=40000;const gate=new Promise(r=>release=r);Object.assign(u.e.context,{saTypes:new El(),panelRenderSeq:0,saModelSeq:0,saBudgetSeq:0,_renderedSid:'aaaaaa',_optionsSig:'',FALLBACK_TYPES:{},currentSessionId:()=>sid,renderCards:list=>{displayed=list[0].budgetTokens},toast(){},t:x=>x,fetch:async(url,opts)=>{if(opts?.method==='PUT'){await gate;stored=JSON.parse(opts.body).budgetTokens;return{ok:true}}const snapshot=stored;return new Promise(r=>reads.push(()=>r({ok:true,json:async()=>({types:[{type:'implement',budgetTokens:snapshot}]})})))}});
 const card=new El();card.dataset.type='implement';variable('web/js/subagent-panel.js','commitBudgetField',u.e.context)(card,'budgetTokens',90000,()=>{});sid='bbbbbb';variable('web/js/subagent-panel.js','renderSubagentPanel',u.e.context)();release();await tick();reads[0]();await tick();assert(reads.length===2,'stale new panel read was not retried');reads[1]();await tick();assert(stored===90000&&displayed===90000,'regression');return{activeSession:sid,storedGlobalBudget:stored,displayedBudget:displayed};
});
await check('Z03 prompt edits in a second window preserve first window saved prompts',async()=>{
 const values=new Map(),storage={get length(){return values.size},key:i=>[...values.keys()][i],getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const windows=[ui(),ui()];for(let i=0;i<2;i++){const u=windows[i];u.e.context.localStorage=storage;u.e.context.crypto={randomUUID:()=> 'id-'+i};u.mod=u.e.load('web/js/prompt-manager.js','export const audit={read:loadPrompts};')}
 const save=(u,name)=>{u.doc.getElementById('prompt-editor-name').value=name;u.doc.getElementById('prompt-editor-content').value='content '+name;u.doc.getElementById('prompt-editor-save').events.click[0]();return tick()};await save(windows[0],'A saved prompt');const first=windows[0].mod.audit.read();await save(windows[1],'B saved prompt');const final=windows[1].mod.audit.read();assert(first.length===1&&final.length===2&&final[0].name==='A saved prompt'&&final[1].name==='B saved prompt','regression');return{afterFirstSave:first,afterSecondWindowSave:final};
});
await check('Z04 older sessions response cannot overwrite confirmed newer metadata',async()=>{
 const u=ui(),reads=[],stored=[];Object.assign(u.e.context,{sessionsFetchSeq:0,sessionsRenderSeq:0,lastSessionsList:null,fullHashCache:'',storeContentHash:'',sessionsHash:'',editingId:null,filterQuery:()=>'',refreshPinned:async()=>false,setSessionKind(){},setSessions:list=>stored.push(list),getSession:()=>null,sidebarView:signal('sessions'),pinnedIds:signal(new Set()),homeDir:signal(''),sessionList:new El(),BUCKET_ORDER:[],sideEmpty:()=>new El(),t:x=>x,fetch:()=>new Promise(r=>reads.push(r))});
 const render=variable('web/js/sidebar.js','renderSessions',u.e.context),old=render(true),fresh=render(true);
 reads[1]({ok:true,json:async()=>[{instanceId:'aaaaaa',kind:'terminal',title:'confirmed new title'}]});await fresh;
 reads[0]({ok:true,json:async()=>[{instanceId:'aaaaaa',kind:'terminal',title:'old title'}]});await old;
 assert(stored.length===1&&stored[0][0].title==='confirmed new title'&&u.e.context.lastSessionsList[0].title==='confirmed new title','regression');return{appliedTitles:stored.map(list=>list[0].title),cachedTitle:u.e.context.lastSessionsList[0].title};
});
await check('Z05 transient GitHub outage preserves catalog and retries after recovery',async()=>{
 let online=true,calls=0;const e=env({globals:{fetch:async url=>{calls++;if(!online)return{ok:false,status:503};return String(url).includes('api.github.com')?{ok:true,json:async()=>[{name:'demo',type:'dir'}]}:{ok:true,text:async()=>'---\nname: demo\ndescription: Example\n---\nDemo'};}}}),h=hub(e);
 const search=async()=>{const r=new Res();await h.searchSkills(req({},'/api/skills/search?source=github','GET'),r);return{status:r.statusCode,count:r.json().skills.length}};
 const initial=await search();e.clock(100000+3600001);online=false;const outage=await search();const before=calls;online=true;const recovery=await search();assert(initial.count>0&&outage.count===initial.count&&recovery.count===initial.count&&calls>before,'regression');return{initial,outage,recovery,networkRequestsAfterRecovery:calls-before};
});
await check('Z06 Windows fallback spawn error reports failure and closes terminal',async()=>{
 let spawns=0,kills=0,closed=0,writes=0,exitHandler;const events=[],errors=[];
 const e=env({modules:{'node-pty':{spawn:()=>{if(++spawns===2)throw Error('ENOENT powershell.exe');return{onData(){},onExit:fn=>exitHandler=fn,kill(){kills++;exitHandler({exitCode:1})},write(){writes++},resize(){}}}}}});
 e.context.process={...e.context.process,platform:'win32',env:{COMSPEC:'cmd.exe'},stderr:{write:x=>errors.push(x)}};
 const T=e.load('src/bridges/terminal.ts').TerminalBridge,b=new T({cwd:e.dir});b.onClose(()=>closed++);b.onEvent(x=>events.push(x));await b.ready();[...e.timers.values()].find(x=>x.ms===2500).fn();await tick();b.writePty('echo hi\r');assert(spawns===2&&kills===1&&closed===1&&b.proc===null&&b.closed&&writes===0&&events.some(x=>x.name==='ui:error'),'regression');return{spawns,kills,closedEvents:closed,hasProcess:b.proc!==null,closedFlag:b.closed,acceptedWrites:writes,frontendEvents:events,stderr:errors};
});

for(const firstReadBeforeSave of [false,true]) await check('Z02 full module reloads new session budget '+(firstReadBeforeSave?'before':'after')+' save completion',async()=>{
 const u=ui(),reads=[];let releasePut,stored=40000;const put=new Promise(r=>releasePut=r);u.doc.getElementById('subagent-panel').hidden=true;const container=u.doc.getElementById('sa-types');let html='';Object.defineProperty(container,'innerHTML',{get:()=>html,set:v=>{html=v;container.children=[]}});
 u.modules['./sse.js']={setModelCache(){}};u.modules['./state.js'].agentInfo={provider:'test'};
 u.e.context.fetch=async(url,opts)=>{if(opts?.method==='PUT'){await put;stored=JSON.parse(opts.body).budgetTokens;return{ok:true}}if(!url.endsWith('/sa-types'))return{ok:true,json:async()=>({models:{}})};const snapshot=stored;return new Promise(r=>reads.push(()=>r({ok:true,json:async()=>({types:[{type:'implement',description:'test',budgetTokens:snapshot}]})})));};
 const m=u.e.load('web/js/subagent-panel.js','export const audit={commitBudgetField};');m.setSgOpen(true);reads.shift()();await tick();const card=container.children[0];m.audit.commitBudgetField(card,'budgetTokens',90000,()=>{});u.active.value={id:'bbbbbb',state:{}};
 if(firstReadBeforeSave){reads.shift()();await tick();assert(container.children[0]._saCfg.budgetTokens===40000,'initial read missing')}
 releasePut();await tick();for(let i=0;reads.length&&i<5;i++){reads.shift()();await tick()}
 assert(stored===90000&&container.children[0]._saCfg.budgetTokens===90000&&reads.length===0&&!card._budgetSaving.budgetTokens,'global budget remained stale');
});
function promptWindows(){
 const values=new Map(),storage={get length(){return values.size},key:i=>[...values.keys()][i],getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};let tail=Promise.resolve(),lockCalls=0;
 const locks={request:(key,fn)=>{assert(key==='ash.prompts','wrong lock');lockCalls++;const next=tail.then(fn);tail=next.catch(()=>{});return next}};
 const windows=[ui(),ui()];for(let i=0;i<2;i++){const u=windows[i];u.e.context.localStorage=storage;u.e.context.navigator={locks};u.e.context.crypto={randomUUID:()=> 'id-'+i};u.mod=u.e.load('web/js/prompt-manager.js','export const audit={startEdit,deletePrompt,get:()=>prompts,read:loadPrompts};')}
 const save=(u,name)=>{u.doc.getElementById('prompt-editor-name').value=name;u.doc.getElementById('prompt-editor-content').value='content '+name;return u.doc.getElementById('prompt-editor-save').events.click[0]()};return{windows,values,storage,save,get:()=>windows[0].mod.audit.read(),lockCalls:()=>lockCalls};
}
await check('Z03 simultaneous prompt writers serialize and stale delete preserves unrelated additions',async()=>{
 const p=promptWindows(),[a,b]=p.windows;await Promise.all([p.save(a,'A'),p.save(b,'B')]);assert(p.get().length===2&&p.lockCalls()===2,'parallel prompts lost');await a.mod.audit.deletePrompt('id-0');assert(p.get().length===1&&p.get()[0].name==='B','stale deletion lost new prompt');
});
await check('Z03 conflicting edits retain draft and do not resurrect deleted prompts',async()=>{
 const p=promptWindows(),[a,b]=p.windows;await p.save(a,'initial');a.mod.audit.startEdit('id-0');b.mod.audit.startEdit('id-0');await p.save(a,'changed A');await p.save(b,'changed B');assert(p.get()[0].name==='changed A'&&b.toasts.length===1&&b.doc.getElementById('prompt-editor-name').value==='changed B','conflict silently overwrote');b.mod.audit.startEdit('id-0');await a.mod.audit.deletePrompt('id-0');await p.save(b,'deleted draft');assert(p.get().length===0&&b.toasts.length===2,'deleted prompt resurrected');
});
await check('Z03 storage event refreshes autocomplete data and failed writes retain editor',async()=>{
 const p=promptWindows(),[a,b]=p.windows;await p.save(a,'A');b.e.context.window.dispatchEvent({type:'storage',key:'ash.prompt.id-0'});assert(b.mod.audit.get().length===1,'storage event did not synchronize');p.storage.setItem=()=>{throw Error('quota')};await p.save(b,'unsaved');assert(p.get().length===1&&b.toasts.length===1&&b.doc.getElementById('prompt-editor-name').value==='unsaved'&&!b.doc.getElementById('prompt-editor-save').disabled,'failed save lost draft');
});
function sidebarEnv(){const u=ui(),reads=[],stored=[],rendered=[];Object.assign(u.e.context,{sessionsFetchSeq:0,sessionsRenderSeq:0,lastSessionsList:null,fullHashCache:'',storeContentHash:'',sessionsHash:'',editingId:null,filterQuery:()=>'',refreshPinned:async()=>false,setSessionKind(){},setSessions:list=>stored.push(list),getSession:()=>null,sidebarView:signal('sessions'),pinnedIds:signal(new Set()),homeDir:signal('/home/test'),sessionList:new El(),BUCKET_ORDER:['today'],bucketKey:()=> 'today',sideEmpty:()=>new El(),renderSessionItem:s=>{rendered.push(s.title);return new El()},t:x=>x,fetch:()=>new Promise(r=>reads.push(r))});return{u,reads,stored,rendered,render:variable('web/js/sidebar.js','renderSessions',u.e.context)}}
const sessionResponse=title=>({ok:true,json:async()=>[{instanceId:'aaaaaa',kind:'agent',title,cwd:'/tmp'}]});
await check('Z04 cache-only render does not discard pending network refresh',async()=>{
 const x=sidebarEnv();x.u.e.context.lastSessionsList=[{instanceId:'aaaaaa',title:'cached',cwd:'/tmp'}];const pending=x.render(true);await x.render(true,{fromCache:true});x.reads[0](sessionResponse('fresh'));await pending;assert(x.stored.at(-1)[0].title==='fresh'&&x.rendered.at(-1)==='fresh','filter render suppressed fresh list');
});
await check('Z04 render delayed by pinned fetch cannot replace newer DOM',async()=>{
 const x=sidebarEnv();let release,started;const ready=new Promise(r=>started=r);let calls=0;x.u.e.context.refreshPinned=async()=>{if(++calls===1){started();await new Promise(r=>release=r)}return false};const old=x.render(true);x.reads[0](sessionResponse('old'));await ready;const next=x.render(true);x.reads[1](sessionResponse('fresh'));await next;release();await old;assert(x.stored.at(-1)[0].title==='fresh'&&x.rendered.join()==='fresh','older render overwrote newer DOM');
});
await check('Z05 partial source failure preserves its skills and successful empty source removes its skills',async()=>{
 let mode='initial',calls=[];const e=env({globals:{fetch:async url=>{url=String(url);calls.push(url);const bad=url.includes('/anthropics/');if(url.includes('api.github.com'))return mode==='outage'&&bad?{ok:false,status:429}:{ok:true,json:async()=>mode==='empty'&&bad?[]:[{name:'demo',type:'dir'}]};return{ok:true,text:async()=> '---\nname: demo\n---'};}}}),h=hub(e),search=async()=>{const r=new Res();await h.searchSkills(req({},'/api/skills/search?source=github','GET'),r);return r.json().skills};const initial=await search();assert(initial.some(x=>x.id.includes('anthropics/')),'missing test source');e.clock(3700001);mode='outage';const failed=await search();assert(failed.length===initial.length,'partial outage erased skills');calls=[];mode='empty';const recovered=await search();assert(recovered.length===initial.length-1&&calls.length===1&&calls[0].includes('/anthropics/'),'recovery did not retry only failed source or honor empty success');calls=[];await search();assert(calls.length===0,'successful catalog not cached');
});
await check('Z05 individual skill fetch failure retains source snapshot and remains retryable',async()=>{
 let fail=false,calls=0;const e=env({globals:{fetch:async url=>{calls++;return String(url).includes('api.github.com')?{ok:true,json:async()=>[{name:'demo',type:'dir'}]}:fail?{ok:false,status:503}:{ok:true,text:async()=> '---\nname: demo\n---'};}}}),h=hub(e),search=async()=>{const r=new Res();await h.searchSkills(req({},'/api/skills/search?source=github','GET'),r);return r.json().skills};const initial=await search();e.clock(3700001);fail=true;assert((await search()).length===initial.length,'file failure erased cache');const before=calls;fail=false;assert((await search()).length===initial.length&&calls>before,'file failure cached as success');
});
await check('Z06 fallback failure closes Hub session and emits error before SSE ends',async()=>{
 let spawn=0;const e=env({modules:{'node-pty':{spawn:()=>{if(++spawn===2)throw Error('fallback unavailable');return{onData(){},onExit(){},kill(){},write(){},resize(){}}}}}});e.context.process={...e.context.process,platform:'win32',env:{COMSPEC:'cmd.exe'},stderr:{write(){}}};const T=e.load('src/bridges/terminal.ts').TerminalBridge,h=hub(e),ss=new Map(),s=await h.createSession(ss,{makeBridge:o=>new T(o)},e.dir,undefined,'terminal');const res=new Res();s.sseClients.add(res);[...e.timers.values()].find(x=>x.ms===2500).fn();await tick();assert(!ss.has(s.id)&&s._closed&&res.writableEnded&&res.body.includes('fallback unavailable'),'failed terminal retained by Hub');
});
await check('Z01 successful title publishes only after durable commit and later metadata preserves it',async()=>{
 const real=require('fs');let hold=false,release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);const {e,h,s}=await create({modules:{'node:fs':{...real,promises:{...real.promises,rename:async(from,to)=>{if(hold&&String(to).endsWith('.meta.json')){hold=false;started();await gate}return real.promises.rename(from,to)}}}}});await h.setSessionTitle(s,'original',true);hold=true;const rename=h.setSessionTitle(s,'confirmed',true);await ready;assert(s.title==='original','uncommitted title visible');const later=h.saveSessionMeta(s);release();await rename;await later;const disk=JSON.parse(fs.readFileSync(path.join(e.dir,'hub-sessions',s.id+'.meta.json')));assert(s.title==='confirmed'&&disk.title==='confirmed'&&s.replay.map(frame).some(x=>x.meta.name==='session:title'&&x.payload.title==='confirmed'),'confirmed title lost');
});

await check('Z04 identical overlapping responses do not strand the initial DOM',async()=>{
 const x=sidebarEnv();let release,started;const ready=new Promise(r=>started=r);let calls=0;x.u.e.context.refreshPinned=async()=>{if(++calls===1){started();await new Promise(r=>release=r)}return false};const old=x.render();x.reads[0](sessionResponse('same'));await ready;const next=x.render();x.reads[1](sessionResponse('same'));await next;release();await old;assert(x.rendered.join()==='same','same-hash response left DOM empty');
});
await check('Z01 title commit cannot rewind activity timestamp changed during persistence',async()=>{
 const real=require('fs');let hold=false,release,started;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);const {e,h,s}=await create({modules:{'node:fs':{...real,promises:{...real.promises,rename:async(from,to)=>{if(hold&&String(to).endsWith('.meta.json')){hold=false;started();await gate}return real.promises.rename(from,to)}}}}});hold=true;const rename=h.setSessionTitle(s,'confirmed',true);await ready;s.lastModified=200000;const later=h.saveSessionMeta(s);release();await rename;await later;const disk=JSON.parse(fs.readFileSync(path.join(e.dir,'hub-sessions',s.id+'.meta.json')));assert(s.lastModified===200000&&disk.lastModified===200000,'title commit rewound activity');
});

await check('Z03 legacy prompts migrate on edit and tombstones prevent resurrection',async()=>{
 const p=promptWindows(),[a,b]=p.windows;p.values.set('ash.prompts',JSON.stringify([{id:'legacy',name:'old',content:'original'}]));a.mod.audit.startEdit('legacy');await p.save(a,'edited');assert(p.get()[0].name==='edited','legacy edit lost');await b.mod.audit.deletePrompt('legacy');assert(p.get().length===0&&p.values.get('ash.prompt.legacy')==='null','legacy delete resurrected');
});
await check('Z03 no-lock interleaved writes keep both independent prompt records',async()=>{
 const p=promptWindows(),[a,b]=p.windows;delete a.e.context.navigator;delete b.e.context.navigator;const original=p.storage.setItem;let other,interleave=true;p.storage.setItem=(key,value)=>{if(interleave){interleave=false;other=p.save(b,'B')}return original(key,value)};await p.save(a,'A');await other;assert(p.get().length===2&&p.get().some(x=>x.name==='A')&&p.get().some(x=>x.name==='B'),'interleaved unrelated write lost without Web Locks');
});

clearTimeout(watchdog);console.log(JSON.stringify({checks:findings.length,passed:findings.filter(x=>x.passed).length,failed:findings.filter(x=>!x.passed).length}));if(findings.some(x=>!x.passed))process.exitCode=1;
})().catch(e=>{clearTimeout(watchdog);console.error(e);process.exitCode=1});
