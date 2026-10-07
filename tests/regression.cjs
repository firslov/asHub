const {env,Res,req,Bridge,check,assert,results,root,ts,vm,fs,path}=require('./harness.cjs');
const {ui,El,signal}=require('./ui-harness.cjs');
const {EventEmitter}=require('node:events');
const tick=()=>new Promise(r=>setImmediate(r));
function ast(file){return ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true);}
function find(sf,pred){let found;function walk(n){if(!found&&pred(n))found=n;if(!found)ts.forEachChild(n,walk);}walk(sf);assert(found,'AST node missing');return found;}
function method(file,name,context){const sf=ast(file);const n=find(sf,n=>ts.isMethodDeclaration(n)&&n.name?.text===name);return vm.runInContext(ts.transpileModule('({'+n.getText(sf)+'})['+JSON.stringify(name)+']',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);}
const create=async()=>{const e=env(),h=e.hub(),ss=new Map(),s=await h.createSession(ss,{makeBridge:o=>new Bridge(o)},e.dir);return {e,h,ss,s};};
const frame=f=>JSON.parse(f.split('data: ')[1]);
const timeout=setTimeout(()=>{console.error('Regression suite hung');process.exit(1);},20000);
(async()=>{
await check('01 remote auth, login and Origin boundary',async()=>{
 const e=env(),{createAccessGuard}=e.load('src/http-auth.ts');const guard=createAccessGuard('0.0.0.0','test-token');
 const r=new Res();assert(!await guard.allow(req({},'/api/config/apikey','GET'),r)&&r.statusCode===401,'unauthenticated access');
 const q=req({},'/sessions','GET');q.headers={authorization:'Bearer test-token'};assert(await guard.allow(q,new Res()),'bearer rejected');
 q.headers.origin='https://foreign.invalid';q.headers.host='localhost';const denied=new Res();assert(!await guard.allow(q,denied)&&denied.statusCode===403,'foreign origin accepted');
 const login=require('stream').Readable.from([Buffer.from('token=test-token')]);login.method='POST';login.url='/auth';login.headers={};const response=new Res();await guard.allow(login,response);assert(response.statusCode===303&&response.headers['Set-Cookie'].includes('HttpOnly'),'login failed');
 q.headers={cookie:response.headers['Set-Cookie']};assert(await guard.allow(q,new Res()),'cookie rejected');
});
await check('02 malformed requests return errors without escaping HTTP callback',async()=>{
 let server;const http=require('http'),e=env({modules:{'node:http':{...http,createServer:f=>{server=http.createServer(f);server.listen=()=>server;return server;}}}});e.hub().startHub({host:'localhost',port:0,webRoot:path.join(root,'web')});
 for(const [url,body] of [['/api/skills/install',{}],['/api/upload',null]]){const q=req(body,url);q.headers={host:'localhost'};const r=new Res(),done=new Promise(a=>r.once('finish',a));server.emit('request',q,r);await done;assert(r.statusCode>=400&&r.statusCode<500,'malformed request accepted');}
 const r=new Res();await e.hub().submit(req({query:123}),r,{});assert(r.statusCode===400,'query type unchecked');
});
await check('03 dropped context survives restart and next append',async()=>{
 const {e,h,s}=await create();s.bridge.messages=[{role:'user',content:'old'},{role:'assistant',content:'answer'},{role:'user',content:'keep'}];await s.capture.flush();const context=new Res();await h.getContext(context,s);const r=new Res();await h.dropContext(req({indices:[0,1],revision:context.json().revision}),r,s);
 assert(r.statusCode===200,'drop rejected');assert(s.replay.map(frame).filter(f=>f.meta.name==='agent:query').length===1,'elision placeholder counted as user turn');s.bridge.messages.push({role:'assistant',content:'next'});await s.capture.flush();const store=new(e.load('src/history/session-store.ts').SessionStore)(path.join(e.dir,'hub-sessions',s.id+'.jsonl'));assert(store.buildMessages().length===3&&!store.buildMessages().some(m=>m.content==='old'),'old context resurrected');assert(store.getAllEntries().some(x=>x.message?.content==='old'),'explicit old branch lost');
});
await check('04 failed turn is captured before shutdown',async()=>{
 const {h,s}=await create();s.bridge.submit=async()=>{s.bridge.messages.push({role:'user',content:'failed'});throw Error('provider failed');};await h.submit(req({query:'failed'}),new Res(),s);await tick();await s.contextLock;assert(s.store.buildMessages().length===1,'failed turn lost');
});
await check('05 terminal transfer keeps backend; explicit close deletes',async()=>{
 const u=ui();u.modules['./store.js']={activeSessionId:signal('aaaaaa'),openTabs:signal(['aaaaaa','bbbbbb'])};const m=u.e.load('web/js/session-manager.js');m.sessionKinds.set('aaaaaa','terminal');m.sessions.set('aaaaaa',new El());m.sessions.set('bbbbbb',new El());m.closeTab('aaaaaa',{transfer:true});assert(!u.calls.some(c=>c.opts?.method==='DELETE'),'transfer deleted backend');m.openTabs.value=['aaaaaa','bbbbbb'];m.closeTab('aaaaaa');await tick();assert(u.calls.some(c=>c.opts?.method==='DELETE'),'normal close failed');
});
await check('06 Windows cwd listener updates effective directory',async()=>{
 const sf=ast('src/bridges/ash.ts'),init=find(sf,n=>ts.isMethodDeclaration(n)&&n.name?.text==='init'),ss=init.body.statements;const a=ss.findIndex(n=>n.getText(sf)==='this.liveCwd = startCwd;'),b=ss.findIndex(n=>n.getText(sf).startsWith('core.handlers.advise("cwd"'));
 const listeners={},handlers={},c=vm.createContext({process:{platform:'win32'},startCwd:'C:\\old',core:{bus:{on:(n,f)=>listeners[n]=f},handlers:{advise:(n,f)=>handlers[n]=f}},obj:{}});vm.runInContext(ts.transpileModule('(function(){'+Array.from(ss).slice(a,b+1).map(n=>n.getText(sf)).join('\n')+'}).call(obj)',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);listeners['shell:cwd-change']({cwd:'C:\\new'});assert(handlers.cwd()==='C:\\new','old cwd retained');
});
await check('07 custom home approval setting is authoritative',async()=>{
 const e=env(),h=e.hub();await h.setAutoApprove(req({autoApprove:false}),new Res(),new Map());const sf=ast('src/bridges/ash.ts'),n=find(sf,n=>ts.isMethodDeclaration(n)&&n.name?.text==='init');Object.assign(e.context,{fs,path,CONFIG_DIR:e.dir,obj:{autoApprove:true}});await vm.runInContext('(async function(){'+n.body.statements[0].getText(sf)+'}).call(obj)',e.context);assert(e.context.obj.autoApprove===false,'wrong config read');
});
await check('08 mutation rechecks processing after body arrives',async()=>{
 const {h,s}=await create();s.bridge.messages=[{role:'user',content:'keep'}];await s.capture.flush();const q=new EventEmitter(),r=new Res();const p=h.dropContext(q,r,s);s.isProcessing=true;q.emit('data',Buffer.from('{"indices":[0]}'));q.emit('end');await p;assert(r.statusCode===409&&s.bridge.messages[0].content==='keep','busy context replaced');
});
function acpEnv(){const calls=[],child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.kill=()=>{};child.stdin={writable:true,end(){},write:raw=>{const m=JSON.parse(raw);calls.push(m);if(m.id!==undefined&&m.method)queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:1,agentCapabilities:{loadSession:true}}:m.method==='session/new'?{sessionId:'remote-id'}:{}})+'\n'));}};const e=env({modules:{'node:child_process':{spawn:()=>child}}});return {e,calls,child,AcpBridge:e.load('src/bridges/acp.ts').AcpBridge};}
await check('09 ACP initialize uses integer protocol version',async()=>{const {AcpBridge,calls}=acpEnv();const b=new AcpBridge({extra:{command:'fake'}});await b.ready();assert(calls[0].params.protocolVersion===1,'wrong protocol');});
await check('10,35 ACP permissions use standard identifiers and outcomes',async()=>{
 const {AcpBridge,calls}=acpEnv(),b=new AcpBridge({extra:{command:'fake'}});await b.ready();for(const decision of ['approved','denied']){b.handleRequest({id:90,method:'session/request_permission',params:{toolCall:{title:'write'},options:[{optionId:'yes',name:'Allow',kind:'allow_once'},{optionId:'no',name:'Reject',kind:'reject_once'}]}});b.decidePermission('remote-id:90',decision);const sent=calls.at(-1);assert(sent.result.outcome.outcome==='selected'&&sent.result.outcome.optionId===(decision==='approved'?'yes':'no'),'invalid ACP decision');}
});
await check('11 ACP restoration loads saved remote ID; unsupported history fails visibly',async()=>{
 const {AcpBridge,calls}=acpEnv();const b=new AcpBridge({extra:{command:'fake'},isRestored:true,restoreState:{acpSessionId:'old-id'}});await b.ready();assert(calls[1].method==='session/load'&&calls[1].params.sessionId==='old-id'&&!calls.some(x=>x.method==='session/new'),'empty session created');
 const other=acpEnv();const bad=new other.AcpBridge({extra:{command:'fake'},isRestored:true});let failed=false;try{await bad.ready();}catch{failed=true;}assert(failed,'legacy session silently lost');
});
await check('12 quit waits for persistence even when update downloaded',async()=>{
 const sf=ast('electron/main.cjs'),n=find(sf,n=>ts.isCallExpression(n)&&n.expression.getText(sf)==='app.on'&&n.arguments[0]?.text==='before-quit');let prevented=false,quit=false,resolve;const c=vm.createContext({mainWindow:null,_shuttingDown:false,shutdownHubRef(){},prepareShutdown:()=>new Promise(r=>resolve=r),app:{quit:()=>quit=true},console});vm.runInContext('('+n.arguments[1].getText(sf)+')',c)({preventDefault:()=>prevented=true});assert(prevented&&!quit,'quit before save');resolve();await tick();assert(quit,'quit never resumed');
});
await check('13 lazy restoration retries a failed bridge',async()=>{
 const e=env(),h=e.hub();let calls=0;const s=await h.createSession(new Map(),{makeBridge:o=>{calls++;const b=new Bridge(o);b.ready=async()=>{if(calls===1){b.emit('closed');throw Error('temporary');}};return b;}},e.dir,{id:'aaaaaa',title:'saved',startedAt:1,replay:[]});try{await s._ensureBridge();}catch{}await s._ensureBridge();assert(calls===2&&!s._closed,'restore not retried');
});
await check('14 archive/unarchive preserve model, provider and explicit title',async()=>{
 const {h,s,ss,e}=await create();s.userTitle='custom';s.title='custom';h.routeEvent(s,{name:'agent:info',payload:{model:'chosen',provider:'custom'}});await h.archiveSession(req({id:s.id}),new Res(),ss);const meta=JSON.parse(fs.readFileSync(path.join(e.dir,'hub-sessions',s.id+'.meta.json')));assert(meta.model==='chosen','archive stale metadata');const r=new Res();await h.unarchiveSession(req({id:s.id}),r,ss,{makeBridge:o=>new Bridge(o)});const restored=ss.get(s.id);await restored._ensureBridge();assert(restored.bridge.opts.model==='chosen'&&restored.userTitle==='custom','restore lost metadata');
});
await check('15 concurrent archive index updates both survive',async()=>{const e=env(),h=e.hub();await Promise.all([h.saveArchivedSession('aaaaaa',1),h.saveArchivedSession('bbbbbb',2)]);assert((await h.loadArchivedSessions()).size===2,'archive entry lost');});
await check('16,17 reconnect requests complete replay and resets partial renderer',async()=>{
 const u=ui(),sources=[];u.modules['./store.js']={activeSessionId:signal(''),openTabs:signal([])};u.e.context.EventSource=class{constructor(url){this.url=url;sources.push(this);}close(){}};const m=u.e.load('web/js/session-manager.js');m.subscribeSession('aaaaaa');await tick();sources[0].onopen();m.forceReconnect();assert(sources.at(-1).url.includes('all'),'incremental reconnect loses transient chunks');
 let reset=false,entered=false;method('web/js/sse.js','hub:replay-starting',u.e.context).call({state:{replaying:false},resetForBranchSwitch:()=>reset=true,enterReplayMode:()=>entered=true});assert(reset&&entered,'partial stream not reset');
});
await check('18 disconnected SSE restore does not leak a client',async()=>{const e=env(),h=e.hub();let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);const s={id:'aaaaaa',sseClients:new Set(),replay:[],_ensureBridge:()=>{started();return gate}};const q=new EventEmitter();q.headers={};const r=new Res(),p=h.openSseMulti(q,r,new Map([[s.id,s]]),s.id+':all','');await ready;q.emit('close');release();await p;assert(s.sseClients.size===0,'closed client subscribed');});
await check('19 forced resync requests entire history',async()=>{const u=ui(),sources=[];u.modules['./store.js']={activeSessionId:signal(''),openTabs:signal([])};u.e.context.EventSource=class{constructor(url){sources.push(url);}close(){}};const m=u.e.load('web/js/session-manager.js');m.subscribeSession('aaaaaa');await tick();m.resyncSession('aaaaaa');await tick();assert(sources.at(-1).includes('all'),'truncated history');});
await check('20 hiding page preserves notifications stream',async()=>{const u=ui();let pauses=0;u.modules['./session-manager.js']={pauseSSE:()=>pauses++,resumeSSE(){}};u.e.load('web/js/lifecycle.js');u.doc.hidden=true;u.doc.dispatchEvent({type:'visibilitychange'});assert(pauses===0,'hidden page disconnected');});
function permissions(){const u=ui(),cards=[];Object.assign(u.e.context,{closeReply(){},escape:String,t:s=>s,insertStreamNode:(_,c)=>cards.push(c),sessionLabel:()=>'',sendSystemNotification(){},toast:(...x)=>u.toasts.push(x)});return {...u,cards,handler:method('web/js/sse.js','permission:request',u.e.context)};}
await check('21 pending permission remains actionable after replay; completed stays inert',async()=>{
 const u=permissions();for(const pending of [true,false])u.handler.call({id:'a',state:{replaying:true},streamEl:new El()},{requestId:'pending',pending,expiresAt:130000});assert(u.cards[0].querySelector('.approve').events.click?.length&&!u.cards[0].classList.contains('decided'),'pending disabled');assert(u.cards[1].classList.contains('decided'),'historical permission actionable');
 const {h,s}=await create();h.routeEvent(s,{name:'permission:request',payload:{requestId:'x',expiresAt:130000}});const f=s.replay.find(f=>frame(f).meta.name==='permission:request');assert(frame(h.permissionReplayFrame(s,f)).payload.pending,'server omits pending state');h.routeEvent(s,{name:'permission:resolved',payload:{requestId:'x',outcome:'denied'}});assert(!frame(h.permissionReplayFrame(s,f)).payload.pending,'resolved request pending');
});
await check('22 failed approval shows error and permits retry',async()=>{
 const u=permissions();u.e.context.fetch=async()=>{throw Error('offline')};u.handler.call({id:'a',state:{replaying:false},streamEl:new El()},{requestId:'x'});const card=u.cards[0];card.querySelector('.approve').dispatchEvent({type:'click'});await tick();assert(!card.classList.contains('allowed')&&!card.querySelector('.approve').disabled&&u.toasts.length===1,'failure falsely approved');
});
await check('23 cancelled queue preserves dropped flag',async()=>{const {h,s}=await create();h.routeEvent(s,{name:'agent:queued-done',payload:{query:'cancel',dropped:true}});assert(s.replay.map(frame).find(f=>f.meta.name==='agent:queued-done').payload.dropped,'flag lost');});
await check('24,25 queued and image-only submissions retain multimodal structure',async()=>{
 const e=env(),{AshBridge}=e.load('src/bridges/ash.ts'),b=Object.create(AshBridge.prototype);EventEmitter.call(b);const emitted=[];Object.assign(b,{initPromise:Promise.resolve(),core:{bus:{emit:(n,p)=>emitted.push({n,p})}},backendRegistered:true,pendingTurn:{},queryQueue:[],closed:false});await b.submit(JSON.stringify({query:'',images:[{data:'img',mimeType:'image/png'}]}));b.pendingTurn=null;b.drainQueue();const p=emitted.find(e=>e.n==='agent:submit').p;assert(p.query===''&&p.images[0].data==='img','images converted to text');
 const u=ui(),c=u.composer();c.setImages([{data:'img',mimeType:'image/png'}]);c.updateSendBtn();assert(!u.doc.getElementById('send-btn').disabled,'image only disabled');await c.doSubmit('');assert(u.calls.some(x=>x.url.endsWith('/submit')),'image not submitted');
});
await check('26 image drafts follow their session',async()=>{const u=ui(),c=u.composer();c.setImages([{data:'A',mimeType:'image/png'}]);u.active.value={id:'bbbbbb',state:{},agentInfo:{}};await c.doSubmit('B');assert(!u.calls.some(x=>x.url==='/api/upload'),'A image sent to B');u.active.value={id:'aaaaaa',state:{},agentInfo:{}};assert(c.getImages()[0].data==='A','A draft lost');});
await check('27 images added during upload remain in draft',async()=>{
 const u=ui(),c=u.composer();c.setImages([{data:'one',mimeType:'image/png'}]);let release;u.e.context.fetch=(url)=>url==='/api/upload'?new Promise(r=>release=r):Promise.resolve({ok:true});const p=c.doSubmit('one');await tick();c.getImages().push({data:'two'});release({ok:true,json:async()=>({id:'one'})});await p;assert(c.getImages().length===1&&c.getImages()[0].data==='two','unsent image lost');
});
await check('28 IME Enter does not send composing text',async()=>{const u=ui();u.composer();const input=u.doc.getElementById('query');input.value='nihao';input.dispatchEvent({type:'keydown',key:'Enter',isComposing:true,preventDefault(){}});await tick();assert(!u.calls.length&&input.value==='nihao','composing text sent');});
await check('29 shell and slash HTTP errors preserve text and report failure',async()=>{const u=ui(),c=u.composer();u.e.context.fetch=async()=>({ok:false,status:501,text:async()=> 'unsupported'});await c.doSubmit('/unknown');assert(u.toasts.length&&u.doc.getElementById('query').value==='/unknown','slash error swallowed');await c.doSubmit('!echo test');assert(u.toasts.length===2&&u.doc.getElementById('query').value.includes('echo test'),'shell error swallowed');});
await check('30 balance cache expires under frequent reads',async()=>{let calls=0;const e=env({globals:{fetch:async()=>{calls++;return {ok:true,json:async()=>({is_available:true,balance_infos:[]})}}}});for(let i=0;i<8;i++){e.clock(100000+i*20000);await e.hub().getBalance(req({},'/api/balance?provider=deepseek','GET'),new Res());}assert(calls===3,'cache expiry renewed by reads');});
await check('31 sparse skill can be installed and updated twice',async()=>{
 let version=0;const e=env({modules:{'node:child_process':{execFile:(cmd,args,opts,cb)=>{if(args.includes('clone')){const d=path.join(args.at(-1),'skills','demo');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'SKILL.md'),'v'+(++version));}assert(!args.includes('pull'),'sparse update attempts git pull');cb(null,'');}}}}),h=e.hub();for(let i=0;i<2;i++){const r=new Res();await h.installSkill(req({id:'github:owner/repo/demo'}),r);assert(r.statusCode===200,r.body);}assert(fs.readFileSync(path.join(e.dir,'skills','demo','SKILL.md'),'utf8')==='v2','update not installed');
});
await check('32 project skill removal uses selected path, refuses unrelated targets',async()=>{
 const e=env(),h=e.hub(),cwd=path.join(e.dir,'project'),d=path.join(cwd,'.agents','skills','demo');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'SKILL.md'),'test');let r=new Res();await h.uninstallSkill(req({name:'demo',path:d,cwd}),r);assert(r.statusCode===200&&!fs.existsSync(d),'project skill not removed');r=new Res();await h.uninstallSkill(req({name:'demo',path:e.dir,cwd}),r);assert(r.statusCode===403&&fs.existsSync(e.dir),'unrelated directory removed');
});
await check('33 old Windows PTY exit does not close replacement',async()=>{
 const procs=[],e=env({globals:{process:{...process,platform:'win32',env:{COMSPEC:'cmd.exe'}}},modules:{'node-pty':{spawn:()=>{const p={onData:f=>p.data=f,onExit:f=>p.exit=f,kill(){},write:s=>(p.writes??=[]).push(s),resize(){}};procs.push(p);return p;}}}}),b=new(e.load('src/bridges/terminal.ts').TerminalBridge)({cwd:e.dir});await b.ready();[...e.timers.values()].find(t=>t.ms===2500).fn();procs[0].exit({exitCode:1});b.writePty('hello');assert(!b.closed&&procs[1].writes[0]==='hello','replacement closed');
});
await check('34 directory picker uses requesting window',async()=>{const sf=ast('electron/main.cjs'),n=find(sf,n=>ts.isCallExpression(n)&&n.expression.getText(sf)==='ipcMain.handle'&&n.arguments[0]?.text==='pick-directory');const owner={isDestroyed:()=>false};let actual;const c=vm.createContext({BrowserWindow:{fromWebContents:()=>owner},dialog:{showOpenDialog:async w=>{actual=w;return {filePaths:['/project']};}}});const got=await vm.runInContext('('+n.arguments[1].getText(sf)+')',c)({sender:{}});assert(actual===owner&&got.cwd==='/project','main window required');});
await check('36 ACP standard nested tool text is rendered',async()=>{const e=env(),t=new(e.load('src/bridges/translator.ts').Translator)();const events=t.translateUpdate({sessionUpdate:'tool_call_update',toolCallId:'t',status:'completed',content:[{type:'content',content:{type:'text',text:'result'}}]});assert(events[0].payload.resultDisplay.body.lines[0]==='result','tool result lost');});
await check('37 download does not substitute ARM for Intel',async()=>{const html=fs.readFileSync(path.join(root,'website/download.html'),'utf8'),js=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1],sf=ts.createSourceFile('download.js',js,ts.ScriptTarget.Latest,true),n=find(sf,n=>ts.isFunctionDeclaration(n)&&n.name?.text==='getAsset');const c=vm.createContext({FILES:[{os:'mac',ext:'dmg',arch:'arm64'}]});assert(vm.runInContext('('+n.getText(sf)+')("mac","dmg","x64")',c)===null,'wrong architecture returned');});
await check('update install failure recovers stopped backend',async()=>{
 const sf=ast('electron/main.cjs'),n=find(sf,n=>ts.isCallExpression(n)&&n.expression.getText(sf)==='ipcMain.handle'&&n.arguments[0]?.text==='quit-and-install');let stopped=false,restarted=false;
 const c=vm.createContext({hasDownloadedUpdate:()=>true,isAdhocSigned:false,prepareShutdown:async()=>stopped=true,restartHubRef:()=>restarted=true,app:{once(){},removeListener(){}},autoUpdater:{quitAndInstall(){}},setTimeout:f=>{f();},console:{log(){},error(){}},shutdownPromise:true});
 const result=await vm.runInContext('('+n.arguments[1].getText(sf)+')',c)();assert(stopped&&restarted&&result.ok===false,'failed installer leaves dead backend');
});
clearTimeout(timeout);
console.log(JSON.stringify({checks:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length}));
})().catch(e=>{clearTimeout(timeout);console.error(e);process.exitCode=1;});
