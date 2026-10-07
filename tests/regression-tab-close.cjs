// Browser event order: click can detach its target before the trailing dblclick.
const {env,check,assert,results,root,ts,vm,fs,path}=require('./harness.cjs');
class Node {
 constructor(cls=''){this.className=cls;this.children=[];this.events={};this.dataset={};this.style={};this.classList={add(){},remove(){},contains(){return false},toggle(){}};}
 get isConnected(){return !!this.root || !!this.parentNode?.isConnected;}
 set innerHTML(html){for(const c of this.children)c.parentNode=null;this.children=[];if(html){const label=new Node('session-tab-label');label.textContent=html.match(/>(.*?)<\/span>/)?.[1]??'';this.appendChild(label)}}
 appendChild(n){n.parentNode=this;this.children.push(n);return n;}
 querySelector(s){return this.querySelectorAll(s)[0]??null;}
 querySelectorAll(s){return this.children.flatMap(c=>[...(c.className===s.slice(1)?[c]:[]),...c.querySelectorAll(s)]);}
 addEventListener(type,fn){(this.events[type]??=[]).push(fn);}
 dispatch(type,props={}){const event={type,target:this,preventDefault(){},stopPropagation(){this.stopped=true},...props};const route=[];for(let n=this;n;n=n.parentNode)route.push(n);for(const n of route){for(const f of n.events[type]??[])f(event);if(event.stopped)break}return event;}
 replaceWith(n){const p=this.parentNode;if(p){p.children.splice(p.children.indexOf(this),1,n);n.parentNode=p;this.parentNode=null}}
 remove(){const p=this.parentNode;if(p)p.children.splice(p.children.indexOf(this),1);this.parentNode=null;}
 focus(){} select(){} blur(){this.dispatch('blur');}
}
function setup({terminal=false}={}){
 const modules={},strip=new Node(),app=new Node(),posts=[];strip.root=true;app.dataset.uiTabsEnabled='true';
 let resolveDelete;const pendingDelete=new Promise(resolve=>resolveDelete=resolve);
 const document={events:{},getElementById:()=>strip,querySelector:()=>app,createElement:()=>new Node(),addEventListener:Node.prototype.addEventListener,dispatchEvent(e){for(const f of this.events[e.type]??[])f(e);}};
 const e=env({modules,globals:{document,window:{},history:{replaceState(){}},Image:class{},MutationObserver:class{observe(){}},Event:class{},fetch:async(url,opts)=>{posts.push({url,...opts});return opts.method==='DELETE'?pendingDelete:{ok:true}},toast(){}}});
 const {signal}=e.load('web/vendor/signals-core.js');
 const openTabs=signal(['aaaa','bbbb','cccc']),activeSessionId=signal('cccc'),allSessions=signal(new Map()),pinnedIds=signal(new Set());
 const switchTo=id=>activeSessionId.value=id;
 const sessions=new Map(['aaaa','bbbb','cccc'].map(id=>[id,{remove(){if(activeSessionId.peek()===id)activeSessionId.value=''}}]));
 const sessionKinds=new Map(terminal?[['aaaa','terminal']]:[]);
 Object.assign(e.context,{openTabs,activeSessionId,sessionKinds,sessions,switchTo,closingTerminals:new Set()});
 const sf=ts.createSourceFile('session-manager.js',fs.readFileSync(path.join(root,'web/js/session-manager.js'),'utf8'),ts.ScriptTarget.Latest,true);
 let initializer;function visit(n){if(ts.isVariableDeclaration(n)&&n.name?.text==='closeTab')initializer=n.initializer.getText(sf);ts.forEachChild(n,visit)}visit(sf);
 const closeTab=vm.runInContext('('+initializer+')',e.context);
 modules['./session-manager.js']={openTabs,activeSessionId,closeTab,openTab(id){if(!openTabs.peek().includes(id))openTabs.value=[...openTabs.peek(),id];switchTo(id)}};
 modules['./store.js']={allSessions,pinnedIds,getSession:id=>({title:id})};
 modules['./i18n.js']={t:s=>s};modules['./utils.js']={escape:s=>s};modules['./toast.js']={toast(){}};
 e.load('web/js/tabs.js');
 return {strip,openTabs,activeSessionId,allSessions,closeTab,posts,resolveDelete,tab:id=>strip.children.find(c=>c.dataset.sessionId===id),assertSynced(){assert(JSON.stringify(strip.children.map(c=>c.dataset.sessionId))===JSON.stringify(openTabs.peek()),'visible tabs differ from open sessions')}};
}
(async()=>{
 await check('TAB rapid close plus trailing dblclick never freezes remaining tabs',async()=>{
  const s=setup();
  const first=s.tab('aaaa').querySelector('.session-tab-close');first.dispatch('click');
  const second=s.tab('bbbb').querySelector('.session-tab-close');second.dispatch('click');second.dispatch('dblclick');
  await s.closeTab('cccc');s.assertSynced();assert(s.strip.hidden&&s.activeSessionId.peek()==='','last tab did not close');
 });
 await check('TAB double-click close while terminal deletion is pending does not rename',async()=>{
  const s=setup({terminal:true}),close=s.tab('aaaa').querySelector('.session-tab-close');
  close.dispatch('click');close.dispatch('click');close.dispatch('dblclick');
  assert(!s.strip.querySelector('.session-tab-rename'),'close started a rename');
  assert(s.posts.length===1,'duplicate terminal deletion');s.resolveDelete({ok:true});await new Promise(setImmediate);
  await s.closeTab('bbbb');s.assertSynced();assert(s.activeSessionId.peek()==='cccc','closing background tabs changed current session');
 });
 await check('TAB stale detached label cannot enter rename mode',async()=>{
  const s=setup(),old=s.tab('aaaa');s.allSessions.value=new Map([['aaaa',{}]]);
  await s.closeTab('aaaa');old.querySelector('.session-tab-label').dispatch('dblclick');await s.closeTab('bbbb');s.assertSynced();
 });
 await check('TAB external closure of a renamed tab clears its editor and continues rendering',async()=>{
  const s=setup();s.tab('aaaa').querySelector('.session-tab-label').dispatch('dblclick');
  assert(s.strip.querySelector('.session-tab-rename'),'rename did not open');
  await s.closeTab('aaaa',{backendClosed:true});await s.closeTab('bbbb');s.assertSynced();assert(!s.strip.querySelector('.session-tab-rename'),'closed editor remains');
 });
 await check('TAB detached rename input cannot block later tab updates',async()=>{
  const s=setup();s.tab('aaaa').querySelector('.session-tab-label').dispatch('dblclick');s.strip.querySelector('.session-tab-rename').remove();
  await s.closeTab('bbbb');s.assertSynced();
 });
 await check('TAB ordinary rename survives metadata refresh and saves on Enter',async()=>{
  const s=setup();s.tab('cccc').querySelector('.session-tab-label').dispatch('dblclick');const input=s.strip.querySelector('.session-tab-rename');
  input.value='Updated title';s.allSessions.value=new Map();assert(s.strip.querySelector('.session-tab-rename')===input,'refresh discarded editor');
  input.dispatch('keydown',{key:'Enter'});await new Promise(setImmediate);
  assert(s.posts.length===1&&s.posts[0].url==='/cccc/title'&&JSON.parse(s.posts[0].body).title==='Updated title','rename not saved');
  await s.closeTab('cccc');s.assertSynced();assert(s.activeSessionId.peek()==='bbbb','active tab did not select neighbor');
 });
 for(const closeId of ['aaaa','cccc'])await check('TAB first close click during rename closes '+closeId,async()=>{
  const s=setup();s.tab('cccc').querySelector('.session-tab-label').dispatch('dblclick');
  const input=s.strip.querySelector('.session-tab-rename'),close=s.tab(closeId).querySelector('.session-tab-close');
  input.value='Updated title';let prevented=false;
  close.dispatch('mousedown',{button:0,preventDefault(){prevented=true}});
  if(!prevented)input.blur();
  assert(close.isConnected,'blur detached the pending close target');close.dispatch('click');await new Promise(setImmediate);
  assert(!s.openTabs.peek().includes(closeId),'first click did not close tab');s.assertSynced();
  assert(s.posts.some(p=>p.url==='/cccc/title'),'closing dropped pending rename');
 });
 await check('TAB blur restores the label without detaching other close targets',async()=>{
  const s=setup();s.tab('cccc').querySelector('.session-tab-label').dispatch('dblclick');
  const close=s.tab('aaaa').querySelector('.session-tab-close');s.strip.querySelector('.session-tab-rename').blur();
  assert(close.isConnected,'blur replaced the tab strip');close.dispatch('click');s.assertSynced();
 });
 await check('TAB Escape cancels rename and subsequent closes remain functional',async()=>{
  const s=setup();s.tab('cccc').querySelector('.session-tab-label').dispatch('dblclick');const input=s.strip.querySelector('.session-tab-rename');input.value='Canceled';input.dispatch('keydown',{key:'Escape'});
  assert(!s.strip.querySelector('.session-tab-rename')&&!s.posts.length,'cancel saved title or left editor');
  await s.closeTab('cccc');await s.closeTab('bbbb');await s.closeTab('aaaa');s.assertSynced();assert(s.strip.hidden);
 });
 console.log(JSON.stringify({checks:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length}));
})();
