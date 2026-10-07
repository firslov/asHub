const {env,Res,req,Bridge,assert,ts,vm,fs,path,root}=require('./harness.cjs');
const {ui,El,signal}=require('./ui-harness.cjs');const {EventEmitter}=require('events');
const tick=()=>new Promise(r=>setImmediate(r));const findings=[];
function ast(file){return ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true)}
function find(sf,p){let out;function walk(n){if(!out&&p(n))out=n;if(!out)ts.forEachChild(n,walk)}walk(sf);assert(out,'AST missing');return out;}
function variable(file,name,ctx){const sf=ast(file),n=find(sf,n=>ts.isVariableDeclaration(n)&&n.name?.text===name);return vm.runInContext('('+n.initializer.getText(sf)+')',ctx)}
function method(file,name,ctx){const sf=ast(file),n=find(sf,n=>ts.isMethodDeclaration(n)&&n.name?.text===name);return vm.runInContext(ts.transpileModule('({'+n.getText(sf)+'})['+JSON.stringify(name)+']',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx)}
function callback(file,expression,event,ctx){const sf=ast(file),n=find(sf,n=>ts.isCallExpression(n)&&n.expression.getText(sf)===expression&&n.arguments[0]?.text===event);return vm.runInContext(ts.transpileModule('('+n.arguments[1].getText(sf)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx)}
function hub(e){return e.load('src/hub.ts','export const audit={startHub,createSession,closeSession,forkEndpoint,rewindContext,saveSessionMeta,archiveSession,unarchiveSession,shutdownHub,_flushBuf,persistReplayFile,routeEvent,submit,dropContext,openSseMulti,getContext,setCwdEndpoint,updateConfig,setAutoApprove,uploadImage,serveUpload,readBody,updateTitle,flushPtyBuffer,setSubagentModel,setSubagentBudget,loadArchivedSessions,listSessions,restoreSessions,rewindToTurn,execCommand,tagLastQueryFrame,setSessionTitle,setModelEndpoint,uninstallSkill,listInstalledSkills,searchSkills,getBalance,getModels,_writeLocks};').audit}
async function create(extra={}){const e=env(extra),h=hub(e),ss=new Map(),s=await h.createSession(ss,{makeBridge:o=>new Bridge(o)},e.dir);return{e,h,ss,s}}
const frame=f=>JSON.parse(f.split('data: ')[1]);
async function check(id,fn){if(process.env.ONLY&&!process.env.ONLY.split(',').some(x=>id.startsWith(x)))return;try{const detail=await fn();findings.push({id,passed:true,detail});console.log('PASS',id,JSON.stringify(detail))}catch(e){findings.push({id,passed:false,error:e.stack});console.log('FAIL',id,e.stack)}}
const watchdog=setTimeout(()=>{console.error('TIMEOUT');process.exit(1)},30000);
(async()=>{
await check('AB01 background completion preserves active file autocomplete selection',async()=>{
 const u=ui();delete u.modules['./autocomplete.js'];u.doc.createElement=()=>{const el=new El();el.scrollIntoView=()=>{};return el};const list=u.doc.getElementById('autocomplete');Object.defineProperty(list,'innerHTML',{get:()=>'',set:()=>list.children=[]});const input=u.doc.getElementById('query');input.value='@';input.selectionStart=1;u.e.context.fetch=async()=>({ok:true,json:async()=>({files:[{name:'alpha.txt',kind:'file'},{name:'beta.txt',kind:'file'}]})});const ac=u.e.load('web/js/at-mention.js').attachAtMentionAutocomplete(input);
 const fire=async()=>{const timers=[...u.e.timers].filter(([id,t])=>t.ms===60);for(const [id,t] of timers){u.e.timers.delete(id);await t.fn()}await tick()};input.dispatchEvent({type:'input'});await fire();input.dispatchEvent({type:'keydown',key:'ArrowDown',preventDefault(){}});assert(list.children[1].classList.contains('active'),'second item not selected');
 const noop=()=>{};Object.assign(u.e.context,{CustomEvent:class{constructor(type,opts){this.type=type;this.detail=opts?.detail}},activeSession:u.active,closeReply:noop,hideThinking:noop,finalizeThinking:noop,finalizeLiveOutput:noop,renderUsage:noop,settleTodoBlock:noop,setBusy:noop,setSessionStatus:noop,refreshGitBranch:noop,sendSystemNotification:noop,sessionLabel:()=> 'background',t:x=>x});method('web/js/sse.js','agent:processing-done',u.e.context).call({id:'bbbbbb',state:{replaying:false},scheduleReplayFlush:noop});await fire();input.dispatchEvent({type:'keydown',key:'Tab',preventDefault(){}});const detail={intendedFile:'beta.txt',inserted:input.value,backgroundSession:'bbbbbb',activeSession:u.active.peek().id};console.log('AB01 observed',JSON.stringify(detail));assert(input.value==='@beta.txt ','background completion changed selection');return detail;
});
await check('AB02 terminal fallback failure displays error and ended state',async()=>{
 let spawn=0,closed=0;const e=env({modules:{'node-pty':{spawn:()=>{if(++spawn===2)throw Error('fallback unavailable');return{onData(){},onExit(){},kill(){},write(){},resize(){}}}}}});e.context.process={...e.context.process,platform:'win32',env:{COMSPEC:'cmd.exe'},stderr:{write(){}}};const T=e.load('src/bridges/terminal.ts').TerminalBridge,b=new T({cwd:e.dir});const u=ui(),events=[],writes=[],receive=method('web/js/terminal-view.js','receiveFrame',u.e.context),view={term:{options:{},write:x=>writes.push(x)}};b.onEvent(ev=>{events.push(ev);receive.call(view,{meta:{name:ev.name},payload:ev.payload})});b.onClose(()=>closed++);await b.ready();[...e.timers.values()].find(t=>t.ms===2500).fn();await tick();assert(closed===1&&events.some(x=>x.name==='ui:error')&&writes[0].includes('retrying')&&writes.join('').includes('fallback unavailable')&&writes.join('').includes('process exited')&&view.ended&&view.term.options.disableStdin,'fallback failure hidden or input enabled');return{bridgeClosed:closed,emittedEvents:events.map(e=>e.name),terminalText:writes.join(''),visibleFailure:true};
});
await check('AB03 changing configured account immediately returns new balance',async()=>{
 let calls=0;const e=env({globals:{fetch:async(url,opts)=>{calls++;const amount=opts.headers.Authorization.includes('account-B')?'2.00':'100.00';return{ok:true,json:async()=>({is_available:true,balance_infos:[{currency:'USD',total_balance:amount}]})}}}}),h=hub(e),file=path.join(e.dir,'settings.json');fs.writeFileSync(file,JSON.stringify({providers:{deepseek:{apiKey:'test-account-A'}}}));e.auth.resolveApiKey=()=>({key:JSON.parse(fs.readFileSync(file,'utf8')).providers.deepseek.apiKey});e.settings.reloadSettings=async()=>{};
 const read=async()=>{const r=new Res();await h.getBalance(req({},'/api/balance?provider=deepseek','GET'),r);return r.json().balance_infos[0].total_balance};const first=await read(),saved=new Res();await h.updateConfig(req({providers:{deepseek:{apiKey:'test-account-B'}}}),saved,new Map());const after=await read(),callsBeforeTTL=calls;e.clock(160001);const fresh=await read();assert(saved.statusCode===200&&first==='100.00'&&after==='2.00'&&fresh==='2.00'&&callsBeforeTTL===2,'old account balance survived config save');return{configSaveStatus:saved.statusCode,balanceBefore:first,balanceAfterAccountChange:after,actualNewAccountBalance:fresh,networkCallsBeforeTTL:callsBeforeTTL};
});
await check('AB04 old model lookup retries after config invalidation',async()=>{
 const e=env(),h=hub(e);e.settings.reloadSettings=async()=>{};e.auth.listAllProviders=()=>[{id:'custom'}];let mode='old',release,started,calls=0;const ready=new Promise(r=>started=r),gate=new Promise(r=>release=r);const bridge={getModels:async()=>{calls++;const snapshot=mode;if(calls===1){started();await gate}return{models:[{model:snapshot,provider:'custom'}]}},reloadProviders:()=>mode='new'},ss=new Map([['aaaaaa',{kind:'agent',bridge}]]);
 const first=new Res(),pending=h.getModels(req({},'/api/models','GET'),first,ss);await ready;const saved=new Res();await h.updateConfig(req({providers:{custom:{models:['new'],defaultModel:'new'}}}),saved,ss);release();await pending;const second=new Res();await h.getModels(req({},'/api/models','GET'),second,ss);const cached=second.json().providers[0].models.map(m=>m.id),callsBeforeTTL=calls;e.clock(130001);const expired=new Res();await h.getModels(req({},'/api/models','GET'),expired,ss);assert(saved.statusCode===200&&mode==='new'&&cached.join()==='new'&&callsBeforeTTL===2&&first.json().providers[0].models[0].id==='new'&&expired.json().providers[0].models[0].id==='new','old model catalog survived invalidation');return{configSaveStatus:saved.statusCode,activeCatalog:mode,freshRequestCatalog:cached,callsBeforeTTL,afterTTL:expired.json().providers[0].models.map(m=>m.id)};
});

// Exercise all actual lifecycle producers, including events from inactive sessions.
await check('AB01 lifecycle events identify their source session', async () => {
  const u = ui(), events = [];
  u.doc.addEventListener('sse:processing-change', event => events.push(event));
  const noop = () => {};
  Object.assign(u.e.context, {
    CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    activeSession: u.active, t: x => x, sessionLabel: () => 'background',
    classifyError: () => null, renderErrorCard: () => new El(),
  });
  for (const name of ['hideUsage', 'setBusy', 'setSessionStatus', 'hideThinking',
    'sweepOrphanThinking', 'finalizeThinking', 'finalizeLiveOutput', 'resetCompletedTools',
    'startNewSegment', 'showThinking', 'closeReply', 'renderUsage', 'settleTodoBlock',
    'refreshGitBranch', 'sendSystemNotification', 'cancelReply', 'append']) u.e.context[name] = noop;
  const session = { id: 'bbbbbb', state: { replaying: false }, scheduleReplayFlush: noop };
  for (const name of ['agent:processing-start', 'agent:processing-done', 'agent:cancelled', 'agent:error']) {
    method('web/js/sse.js', name, u.e.context).call(session, { message: 'test failure' });
  }
  assert(events.length === 4 && events.every(e => e.detail?.sessionId === 'bbbbbb'), 'lifecycle event lost session identity');
});

await check('AB01 active completion refreshes the active directory', async () => {
  const u = ui(); let opts, reads = 0, closes = 0;
  u.modules['./autocomplete.js'] = { attachAutocomplete: o => { opts = o; return { close: () => closes++ }; } };
  u.e.context.fetch = async () => ({ ok: true, json: async () => ({ files: [{ name: ++reads === 1 ? 'old.txt' : 'new.txt', kind: 'file' }] }) });
  const input = new El(); input.value = '@'; input.selectionStart = 1;
  u.e.load('web/js/at-mention.js').attachAtMentionAutocomplete(input);
  await opts.fetcher();
  const noop = () => {};
  Object.assign(u.e.context, { CustomEvent: class { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } }, activeSession: u.active,
    closeReply: noop, hideThinking: noop, finalizeThinking: noop, finalizeLiveOutput: noop,
    renderUsage: noop, settleTodoBlock: noop, setBusy: noop, setSessionStatus: noop,
    refreshGitBranch: noop, sendSystemNotification: noop, sessionLabel: () => '', t: x => x });
  // Separate object with the active ID avoids unrelated balance/tree refresh work.
  method('web/js/sse.js', 'agent:processing-done', u.e.context).call({ id: 'aaaaaa', state: {}, scheduleReplayFlush: noop });
  assert((await opts.fetcher())[0].name === 'new.txt' && closes === 1 && reads === 2, 'active completion failed to refresh');
});

await check('AB02 normal exit blocks input and replay restores a live terminal', async () => {
  const u = ui(); let dataHandler, TerminalView;
  u.modules['./sse.js'] = { hidePageLoader() {} };
  Object.assign(u.modules['./session-manager.js'], { registerSession() {}, unregisterSession() {}, subscribeSession() {}, unsubscribeSession() {} });
  u.e.context.HTMLElement = El;
  u.e.context.customElements = { define: (name, cls) => { TerminalView = cls; } };
  u.e.context.ResizeObserver = class { observe() {} };
  u.e.context.getComputedStyle = () => ({ getPropertyValue: () => '' });
  u.e.context.window.Terminal = class {
    constructor() { this.options = {}; this.output = ''; }
    open() {} onData(fn) { dataHandler = fn; } write(s) { this.output += s; } reset() { this.output = ''; }
  };
  u.e.load('web/js/terminal-view.js');
  const view = new TerminalView(); view.getAttribute = () => 'aaaaaa'; view.fit = () => {};
  view.connectedCallback();
  dataHandler('before'); assert(u.calls.length === 1, 'live terminal cannot send input');
  view.receiveFrame({ meta: { name: 'ui:error' }, payload: { message: 'recoverable error' } });
  assert(!view.ended && view.term.output.includes('recoverable error'), 'nonfatal error ended terminal');
  view.receiveFrame({ meta: { name: 'shell:exit' }, payload: { exitCode: 7 } });
  dataHandler('after'); assert(u.calls.length === 1 && view.term.options.disableStdin && view.term.output.includes('code 7'), 'ended terminal sent input');
  view.receiveFrame({ meta: { name: 'hub:replay-starting' } });
  dataHandler('reconnected'); assert(u.calls.length === 2 && !view.ended && !view.term.options.disableStdin, 'replay did not reset terminal');
});

for (const failure of [false, true]) {
  await check(`AB03 late old-account ${failure ? 'failure' : 'success'} cannot overwrite new balance`, async () => {
    let release, started, calls = 0;
    const gate = new Promise(r => release = r), ready = new Promise(r => started = r);
    const e = env({ globals: { fetch: async (url, opts) => {
      calls++; const old = opts.headers.Authorization.includes('account-A');
      if (old) { started(); await gate; if (failure) throw Error('old account rejected'); }
      return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ total_balance: old ? '100.00' : '2.00' }] }) };
    } } }), h = hub(e), file = path.join(e.dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ providers: { deepseek: { apiKey: 'test-account-A' } } }));
    e.auth.resolveApiKey = () => ({ key: JSON.parse(fs.readFileSync(file)).providers.deepseek.apiKey });
    e.settings.reloadSettings = async () => {};
    const read = async () => { const res = new Res(); await h.getBalance(req({}, '/api/balance?provider=deepseek', 'GET'), res); return res.json(); };
    const old = read(); await ready;
    await h.updateConfig(req({ providers: { deepseek: { apiKey: 'test-account-B' } } }), new Res(), new Map());
    assert((await read()).balance_infos[0].total_balance === '2.00', 'fresh account fetch failed');
    release();
    assert((await old).balance_infos[0].total_balance === '2.00', 'late response returned old account');
    assert((await read()).balance_infos[0].total_balance === '2.00' && calls === 2, 'late response poisoned cache');
  });
}

await check('AB03 reload failure still invalidates prior-account balance cache', async () => {
  let account = 'A', calls = 0;
  const e = env({ globals: { fetch: async () => { calls++; return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ total_balance: account }] }) }; } } }), h = hub(e);
  e.settings.reloadSettings = async () => { throw Error('reload unavailable'); };
  const read = async () => { const r = new Res(); await h.getBalance(req({}, '/api/balance?provider=deepseek', 'GET'), r); return r.json().balance_infos[0].total_balance; };
  assert(await read() === 'A'); account = 'B';
  await h.updateConfig(req({}), new Res(), new Map());
  assert(await read() === 'B' && calls === 2, 'reload error preserved stale account cache');
});

await check('AB03 frontend config notification clears balances and rejects late old-account responses', async () => {
  const u = ui(), requests = [], session = { agentInfo: { provider: 'deepseek' }, balanceEl: new El() };
  Object.assign(u.e.context, { sessions: new Map([['aaaaaa', session]]), refreshModelChip() {},
    fetch: url => new Promise(resolve => requests.push({ url, resolve })) });
  // Evaluate the actual balance declarations and listener as one block, with UI dependencies controlled.
  const sf = ast('web/js/sse.js');
  const wanted = new Set(['BALANCE_PROVIDERS', '_balanceCache', '_balanceGeneration', 'fetchProviderBalance', 'renderBalance', 'syncAllBalanceChips', 'refreshProviderBalance']);
  const nodes = sf.statements.filter(n =>
    (ts.isFunctionDeclaration(n) && wanted.has(n.name?.text)) ||
    (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => wanted.has(d.name.getText(sf)))) ||
    (ts.isExpressionStatement(n) && ts.isCallExpression(n.expression) && n.expression.expression.getText(sf) === 'document.addEventListener' && n.expression.arguments[0]?.text === 'ash:models-changed'));
  vm.runInContext(nodes.map(n => n.getText(sf)).join('\n'), u.e.context);
  const refresh = vm.runInContext('refreshProviderBalance', u.e.context);
  const response = amount => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: amount }] }) });
  const first = refresh('deepseek'); requests[0].resolve(response('100.00')); await first;
  assert(session.balanceEl._balanceLabel.includes('100.00'), 'initial balance missing');
  const pending = refresh('deepseek');
  u.doc.dispatchEvent({ type: 'ash:models-changed' });
  assert(session.balanceEl._balanceLabel === '', 'old account remains visible after config change');
  const fresh = requests.find((r, i) => i > 1 && r.url.includes('deepseek'));
  assert(fresh, 'config save did not request new balance');
  fresh.resolve(response('2.00')); await tick();
  requests[1].resolve(response('100.00')); await pending;
  assert(session.balanceEl._balanceLabel.includes('2.00'), 'late old-account response replaced new balance');
  vm.runInContext('syncAllBalanceChips()', u.e.context);
  assert(session.balanceEl._balanceLabel.includes('2.00'), 'frontend cache still contains old balance');
});

await check('AB04 single-provider query retries after configuration changes', async () => {
  const e = env(), h = hub(e); let mode = 'old', release, started, calls = 0;
  const ready = new Promise(r => started = r), gate = new Promise(r => release = r);
  e.settings.reloadSettings = async () => {}; e.auth.listAllProviders = () => [{ id: 'custom' }];
  const bridge = { getModels: async () => { const model = mode; if (++calls === 1) { started(); await gate; } return { models: [{ provider: 'custom', model }] }; }, reloadProviders: () => mode = 'new' };
  const sessions = new Map([['aaaaaa', { kind: 'agent', bridge }]]), res = new Res();
  const pending = h.getModels(req({}, '/api/models/custom', 'GET'), res, sessions); await ready;
  await h.updateConfig(req({}), new Res(), sessions); release(); await pending;
  assert(res.json().provider === 'custom' && res.json().models[0].id === 'new' && calls === 2, 'single-provider query returned stale catalog');
});

await check('AB04 catalog fetched during reload is invalidated when reload finishes', async () => {
  const e = env(), h = hub(e); let mode = 'old', release, started, calls = 0;
  const ready = new Promise(r => started = r), gate = new Promise(r => release = r);
  e.settings.reloadSettings = async () => { started(); await gate; }; e.auth.listAllProviders = () => [{ id: 'custom' }];
  const bridge = { getModels: async () => { calls++; return { models: [{ provider: 'custom', model: mode }] }; }, reloadProviders: () => mode = 'new' };
  const sessions = new Map([['aaaaaa', { kind: 'agent', bridge }]]);
  const save = h.updateConfig(req({}), new Res(), sessions); await ready;
  const during = new Res(); await h.getModels(req({}, '/api/models', 'GET'), during, sessions);
  assert(during.json().providers[0].models[0].id === 'old');
  release(); await save;
  const after = new Res(); await h.getModels(req({}, '/api/models', 'GET'), after, sessions);
  const cached = new Res(); await h.getModels(req({}, '/api/models', 'GET'), cached, sessions);
  assert(after.json().providers[0].models[0].id === 'new' && cached.json().providers[0].models[0].id === 'new' && calls === 2, 'reload did not invalidate interim cache or caching stopped working');
});

clearTimeout(watchdog);console.log(JSON.stringify({checks:findings.length,passed:findings.filter(x=>x.passed).length,failed:findings.filter(x=>!x.passed).length}));if(findings.some(x=>!x.passed))process.exitCode=1;
})().catch(e=>{clearTimeout(watchdog);console.error(e);process.exitCode=1});
