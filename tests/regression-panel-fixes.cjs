// Regressions for failed/racing settings reads and coordinated panel navigation.
const {ui,El,signal}=require('./ui-harness.cjs');
const {check,assert,results,root,ts,vm,fs,path}=require('./harness.cjs');
const tick=()=>new Promise(setImmediate);
const response=data=>({ok:true,json:async()=>data});
function config(){
 const u=ui();u.e.context.CustomEvent=u.e.context.Event;u.doc.getElementById('config-auto-approve').closest=()=>null;
 u.modules['./sse.js']={invalidateModelCache(){},getModelCacheGeneration(){},setModelCache(){}};
 const reads=[],writes=[];
 u.e.context.fetch=(url,opts)=>{
  if(url==='/api/models')return Promise.resolve(response({providers:[{name:'preview',models:[]}]}));
  if(opts?.method==='PUT'){writes.push(opts.body);return Promise.resolve(response({}));}
  return new Promise(resolve=>reads.push(resolve));
 };
 const mod=u.e.load('web/js/config-panel.js');
 return {...u,mod,reads,writes,el:id=>u.doc.getElementById(id)};
}
function keydown(file,context){
 const sf=ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true);
 let callback;for(const n of sf.statements){if(ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&n.expression.expression.getText(sf)==='document.addEventListener'&&n.expression.arguments[0]?.text==='keydown')callback=n.expression.arguments[1];}
 assert(callback,'missing key handler');return vm.runInContext('('+callback.getText(sf)+')',context);
}
(async()=>{
 for(const [label,res] of [['HTTP error',{ok:false,status:503,json:async()=>({error:'unavailable'})}],['malformed JSON',{ok:true,json:async()=>{throw Error('invalid JSON')}}],['null payload',response(null)],['array payload',response([])]]){
  await check('PANEL config '+label+' keeps both save paths locked',async()=>{
   const u=config(),pending=u.mod.setConfigOpen(true);await tick();
   assert(u.el('config-body-simple').inert&&u.el('config-save-simple').disabled,'loading form remains editable');
   u.reads[0](res);await pending;
   await u.el('config-save-simple').events.click[0]();await u.el('config-save').events.click[0]();
   assert(!u.writes.length&&u.el('config-save').disabled&&u.el('config-save-simple').disabled,'failed read allowed destructive save');
   assert(!u.el('config-load-state').hidden&&!u.el('config-load-retry').hidden,'missing recovery path');
  });
 }
 await check('PANEL retry restores editing and simple save retains unrelated settings',async()=>{
  const u=config(),first=u.mod.setConfigOpen(true);await tick();u.reads[0]({ok:false,status:503});await first;
  const retry=u.el('config-load-retry').events.click[0]();await tick();
  u.reads[1](response({defaultProvider:'preview',providers:{preview:{apiKey:'masked'},second:{apiKey:'retain'}},customSetting:'keep'}));await retry;
  assert(!u.el('config-save-simple').disabled&&!u.el('config-body-simple').inert&&u.el('config-load-state').hidden,'retry did not unlock form');
  await u.el('config-save-simple').events.click[0]();
  const saved=JSON.parse(u.writes[0]);assert(saved.customSetting==='keep'&&saved.providers.second.apiKey==='retain','save lost unrelated settings');
  assert(u.toasts.some(x=>x[0]==='config.save.done'),'successful save did not finish');
 });
 await check('PANEL old config response cannot overwrite reopened draft',async()=>{
  const u=config(),first=u.mod.setConfigOpen(true);await tick();await u.mod.setConfigOpen(false);
  const second=u.mod.setConfigOpen(true);await tick();u.reads[1](response({defaultProvider:'preview',marker:'current'}));await second;
  u.el('config-editor').value='{"marker":"unsaved draft"}';u.reads[0](response({marker:'stale'}));await first;
  assert(JSON.parse(u.el('config-editor').value).marker==='unsaved draft','old response overwrote draft');
  assert(!u.el('config-save').disabled,'old response changed current readiness');
 });
 await check('PANEL close invalidates pending load and keeps hidden form locked',async()=>{
  const u=config(),first=u.mod.setConfigOpen(true);await tick();await u.mod.setConfigOpen(false);
  u.reads[0](response({marker:'closed'}));await first;
  assert(u.el('config-save-simple').disabled&&u.el('config-editor').value==='','closed read applied');
 });
 await check('PANEL last-tab close clears URL and history root clears active session',async()=>{
  const u=ui(),signals=u.e.load('web/vendor/signals-core.js');u.modules['../vendor/signals-core.js']=signals;u.modules['./store.js']={activeSessionId:signals.signal('aaaaaa'),openTabs:signals.signal(['aaaaaa'])};
  const history=[];u.e.context.history.replaceState=(state,title,url)=>history.push({state,url});
  const m=u.e.load('web/js/session-manager.js');m.sessions.set('aaaaaa',new El());await m.closeTab('aaaaaa');
  assert(m.activeSessionId.peek()===''&&!m.openTabs.peek().length&&history[0].url==='/'&&history[0].state.sessionId==='','last close retained URL');
  m.sessions.set('bbbbbb',new El());m.openTab('bbbbbb');u.e.context.window.dispatchEvent({type:'popstate',state:{sessionId:''}});
  assert(m.activeSessionId.peek()==='','back to root retained conversation');
  u.e.context.window.dispatchEvent({type:'popstate',state:{sessionId:'bbbbbb'}});assert(m.activeSessionId.peek()==='bbbbbb','forward did not restore explicit session');
 });
 await check('PANEL current session fallback follows navigation instead of retaining initial ID',()=>{
  const u=ui();delete u.modules['./state.js'];const activeSessionId=signal('');u.modules['./store.js']={activeSessionId};u.e.context.location.pathname='/aaaaaa/';
  const m=u.e.load('web/js/state.js');assert(m.currentSessionId()==='aaaaaa','startup URL fallback failed');
  u.e.context.location.pathname='/';assert(m.currentSessionId()==='','closed URL reused initial ID');
  activeSessionId.value='bbbbbb';assert(m.currentSessionId()==='bbbbbb','active ID ignored');
 });
 await check('PANEL empty tree clears stale content and aborts pending session request',async()=>{
  const u=ui();let resolve,aborted=false;u.e.context.fetch=(url,opts)=>{opts.signal.addEventListener('abort',()=>aborted=true);return new Promise(r=>resolve=r)};
  const m=u.e.load('web/js/tree-panel.js','export const audit={refresh};');
  const body=u.doc.getElementById('tree-body');body.innerHTML='old branches';const pending=m.audit.refresh();u.active.value=null;await m.audit.refresh();
  assert(aborted&&body.innerHTML.includes('no.session.title')&&!body.innerHTML.includes('old branches'),'no-session tree stayed stale');
  resolve(response({entries:[]}));await pending;assert(body.innerHTML.includes('no.session.title'),'late response restored stale tree');
 });
 for(const mobile of [true,false])await check('PANEL '+(mobile?'mobile':'desktop')+' sidebar respects panel foreground and saved preference',async()=>{
  const u=ui(),app=u.doc.querySelector('.app'),writes=[];u.e.context.window.matchMedia=()=>({matches:mobile});
  u.e.context.localStorage={getItem:()=>null,setItem:(...x)=>writes.push(x),removeItem(){}};
  u.e.load('web/js/prefs.js');await tick();app.classList.remove('sidebar-collapsed');writes.length=0;
  delete u.modules['./panel-manager.js'];const m=u.e.load('web/js/panel-manager.js');u.e.context.MutationObserver=class{observe(){}};
  const panel=u.doc.getElementById('test-panel');panel.hidden=true;
  m.registerPanel('test',{toggleBtnId:'test-button',panelId:'test-panel',open(){panel.hidden=false},close(){panel.hidden=true}});
  await u.doc.getElementById('test-button').events.click[0]();
  assert(app.classList.contains('sidebar-collapsed')===mobile&&!panel.hidden,'panel/sidebar coordination failed');
  assert(!writes.some(x=>x[0]==='ash.sidebar-collapsed'),'mobile action changed saved desktop preference');
 });
 await check('PANEL cold context shortcut lazy-loads once and switches exclusively',async()=>{
  const u=ui();delete u.modules['./panel-manager.js'];u.e.context.MutationObserver=class{observe(){}};
  const m=u.e.load('web/js/panel-manager.js');const ctx=u.doc.getElementById('ctx-panel'),other=u.doc.getElementById('other-panel');ctx.hidden=true;other.hidden=false;
  const register=()=>m.registerPanel('ctx',{toggleBtnId:'ctx-toggle',panelId:'ctx-panel',open(){ctx.hidden=false},close(){ctx.hidden=true}});
  let loads=0,pending; m.registerPanel('other',{toggleBtnId:'other-toggle',panelId:'other-panel',open(){other.hidden=false},close(){other.hidden=true}});
  m.registerPanel('ctx',{toggleBtnId:'ctx-toggle',panelId:'ctx-panel',load:async()=>{loads++;register()}});
  u.doc.getElementById('ctx-toggle').click=()=>pending=u.doc.getElementById('ctx-toggle').events.click[0]();
  const handler=keydown('web/js/client.js',u.e.context);let prevented=false;const ev={key:'\\',ctrlKey:true,preventDefault(){prevented=true}};
  handler(ev);await pending;assert(loads===1&&prevented&&!ctx.hidden&&other.hidden,'cold shortcut failed exclusivity');
  handler(ev);await pending;assert(ctx.hidden&&loads===1,'repeat shortcut failed to close');
  other.hidden=false;handler({...ev,ctrlKey:false,metaKey:true});await pending;assert(!ctx.hidden&&other.hidden&&loads===1,'Mac shortcut failed');
 });
 await check('PANEL macOS tab help documents implemented Control keys',()=>{
  const html=fs.readFileSync(path.join(root,'web/index.html'),'utf8');
  assert(html.includes('os-mac"><kbd>Ctrl+⇧Tab')&&html.includes('os-mac"><kbd>Ctrl+Tab'),'wrong Mac tab key help');
 });
 console.log(JSON.stringify({checks:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length}));
})();
