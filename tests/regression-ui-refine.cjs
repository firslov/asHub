// Functional regressions discovered while refining the workspace UI.
const {env,check,assert,results,root,ts,vm,fs,path}=require('./harness.cjs');
const {El}=require('./ui-harness.cjs');
function method(file,name,context){
 const sf=ts.createSourceFile(file,fs.readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true);
 let found;function visit(n){if(ts.isMethodDeclaration(n)&&n.name?.text===name)found=n;ts.forEachChild(n,visit)}visit(sf);
 assert(found,'Missing method '+name);
 return vm.runInContext(ts.transpileModule('({'+found.getText(sf)+'})['+JSON.stringify(name)+']',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
}
function session(){
 const e=env({globals:{STATE_DEFAULTS:{replaying:false},hideUsage(){},discardPendingThinking(){},hidePageLoader(){},onReplayDone(){}}});
 const stream=new El();Object.defineProperty(stream,'innerHTML',{set(){this.children=[]}});
 stream.querySelector=()=>null;
 const empty=new El(),loading=new El();empty.hidden=true;loading.hidden=false;
 const s={state:{replaying:true,cwd:'/project',contextWindow:128000},streamEl:stream,emptyStateEl:empty,loadingEl:loading,pillEl:new El()};
 return {e,s,reset:method('web/js/session-view.js','resetForBranchSwitch',e.context),finish:method('web/js/session-view.js','_finishReplayInsert',e.context)};
}
function panels(){
 const elements=new Map(),document=new El(),observers=[];document.getElementById=id=>elements.get(id);
 let focused;for(const id of ['one','two','one-button','two-button']){const e=new El();e.hidden=!id.endsWith('button');e.focus=()=>focused=id;elements.set(id,e)}
 const e=env({globals:{document,Event:class{constructor(type){this.type=type}},MutationObserver:class{constructor(callback){this.callback=callback}observe(){observers.push(this.callback)}}}});
 const mod=e.load('web/js/panel-manager.js');
 const register=(name)=>mod.registerPanel(name,{toggleBtnId:name+'-button',panelId:name,open(){elements.get(name).hidden=false},close(){elements.get(name).hidden=true}});
 return {document,elements,register,focused:()=>focused,flush:()=>observers.forEach(fn=>fn())};
}
(async()=>{
 await check('UI empty replay preserves connected welcome and loading nodes',()=>{
  const {s,reset,finish}=session();reset.call(s);assert(s.streamEl.children.includes(s.emptyStateEl)&&s.streamEl.children.includes(s.loadingEl),'reset detached empty/loading state');
  finish.call(s);assert(!s.emptyStateEl.hidden&&s.loadingEl.hidden,'empty replay did not reveal welcome');
 });
 await check('UI repeated branch resets do not duplicate welcome or loading nodes',()=>{
  const {s,reset}=session();reset.call(s);reset.call(s);assert(s.streamEl.children.length===2,'duplicate shell nodes');assert(s.state.cwd==='/project'&&s.state.contextWindow===128000&&s.state.replaying,'session state lost');
 });
 await check('UI non-empty replay does not reveal welcome over content',()=>{
  const {s,reset,finish}=session();reset.call(s);s.streamEl.querySelector=()=>new El();finish.call(s);assert(s.emptyStateEl.hidden,'welcome shown over response');
 });
 await check('UI panel state follows toggles, exclusive switching, and close buttons',async()=>{
  const p=panels();p.register('one');p.register('two');
  const a=p.elements.get('one-button'),b=p.elements.get('two-button');
  assert(a['aria-controls']==='one'&&a['aria-expanded']==='false');
  await a.events.click[0]();p.flush();assert(a['aria-expanded']==='true');
  await b.events.click[0]();p.flush();assert(a['aria-expanded']==='false'&&b['aria-expanded']==='true'&&p.elements.get('one').hidden);
  p.elements.get('two').hidden=true;p.flush();assert(b['aria-expanded']==='false','external close left stale accessible state');
 });
 await check('UI Escape closes panel, restores its trigger focus, and consumes cancel shortcut',async()=>{
  const p=panels();p.register('one');await p.elements.get('one-button').events.click[0]();let consumed=false;
  p.document.dispatchEvent({type:'keydown',key:'Escape',stopImmediatePropagation(){consumed=true}});
  assert(p.elements.get('one').hidden&&p.focused()==='one-button'&&consumed,'Escape did not restore panel navigation');
 });
 console.log(JSON.stringify({checks:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length}));
})();
