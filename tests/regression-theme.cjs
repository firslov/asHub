const {ui,El}=require('./ui-harness.cjs');
const {check,assert,results,fs,path,root,vm}=require('./harness.cjs');
function fixture(saved,systemDark=false,blocked=false){
 const u=ui(),storage=new Map(saved?[['ash-theme',saved]]:[]),native=[];
 u.doc.documentElement.getAttribute=k=>u.doc.documentElement[k]??null;
 u.e.context.window.matchMedia=q=>({matches:q.includes('prefers-color-scheme')&&systemDark});
 u.e.context.window.electronAPI={onThemeChange:t=>native.push(t)};
 u.e.context.localStorage={getItem:k=>{if(blocked)throw Error('blocked');return storage.get(k)??null},setItem:(k,v)=>{if(blocked)throw Error('blocked');storage.set(k,v)},removeItem:k=>storage.delete(k)};
 return {...u,storage,native};
}
(async()=>{
 for(const [saved,dark,expected] of [['academic',true,'light'],['dark',false,'dark'],['light',true,'light'],['unknown',true,'dark'],[null,false,'light']]){
  await check(`THEME initial ${saved} / system ${dark} agrees with first paint`,()=>{
   const u=fixture(saved,dark);
   const html=fs.readFileSync(path.join(root,'web/index.html'),'utf8');
   const initial=html.slice(html.indexOf('      try {\n        const theme'),html.indexOf('      document.documentElement.style'));
   u.e.context.matchMedia=u.e.context.window.matchMedia;
   vm.runInContext(initial,u.e.context);
   assert(u.doc.documentElement.dataset.theme===expected,'first paint mismatch');
   u.e.load('web/js/prefs.js');
   assert(u.doc.documentElement['data-theme']===expected,'prefs mismatch');
   assert(u.storage.get('ash-theme')===expected&&u.native.at(-1)===expected,'preference/native not synchronized');
  });
 }
 await check('THEME toggle cycles only light/dark and updates accessibility and language',()=>{
  const u=fixture('light');u.e.load('web/js/prefs.js');const btn=u.doc.getElementById('theme-toggle');
  for(const theme of ['dark','light','dark','light']){
   btn.dispatchEvent({type:'click'});
   assert(u.doc.documentElement['data-theme']===theme,'extra theme in cycle');
   assert(btn['aria-label']===btn.title&&btn.title.includes(theme==='dark'?'light':'dark'),'next action label mismatch');
  }
  u.modules['./i18n.js'].t=key=>'translated:'+key;u.doc.dispatchEvent({type:'langchange'});
  assert(btn.title.startsWith('translated:'),'language change left stale label');
 });
 await check('THEME detached windows follow storage without rewriting the preference',()=>{
  const u=fixture('light');u.e.load('web/js/prefs.js');
  u.e.context.window.dispatchEvent({type:'storage',key:'ash-theme',newValue:'dark'});
  assert(u.doc.documentElement['data-theme']==='dark'&&u.native.at(-1)==='dark','detached theme did not update');
  assert(u.storage.get('ash-theme')==='light','storage listener wrote preference back');
  u.e.context.window.dispatchEvent({type:'storage',key:'ash-theme',newValue:'unknown'});
  assert(u.doc.documentElement['data-theme']==='dark','invalid stored theme applied');
 });
 await check('THEME unavailable storage still permits switching',()=>{
  const u=fixture(null,true,true);u.e.load('web/js/prefs.js');u.doc.getElementById('theme-toggle').dispatchEvent({type:'click'});
  assert(u.doc.documentElement['data-theme']==='dark','storage failure broke toggle');
 });
 await check('THEME open terminal follows theme and releases observer when closed',()=>{
  const u=fixture('light');let View,observer,disposed=false,bg='#f3eddf',red='#904c40';
  u.e.context.HTMLElement=El;u.e.context.customElements={define:(_name,cls)=>View=cls};
  u.e.context.MutationObserver=class{constructor(cb){this.cb=cb;observer=this}observe(target,opts){this.opts=opts}disconnect(){this.closed=true}};
  u.e.context.ResizeObserver=class{observe(){}disconnect(){}};
  u.e.context.getComputedStyle=()=>({getPropertyValue:key=>({'--bg':bg,'--red':red,'--red-light':red,'--fg':'#494239'}[key]||'')});
  u.e.context.window.Terminal=class{constructor(options){this.options=options}open(){}onData(){}dispose(){disposed=true}};
  u.modules['./session-manager.js']={registerSession(){},unregisterSession(){},subscribeSession(){},unsubscribeSession(){}};
  u.modules['./sse.js']={hidePageLoader(){}};
  u.e.load('web/js/terminal-view.js');const view=new View();view.getAttribute=()=>'';view.fit=()=>{};view.connectedCallback();
  assert(view.term.options.theme.background===bg,'initial terminal palette mismatch');
  assert(view.term.options.theme.brightRed===red&&view.term.options.theme.red===red,'terminal ANSI palette missing');
  bg='#2d2a26';red='#d59c8f';observer.cb();assert(view.term.options.theme.brightRed===red,'terminal ANSI palette did not switch');assert(view.term.options.theme.background===bg,'existing terminal did not switch');
  assert(observer.opts.attributeFilter[0]==='data-theme','observer scope too broad');
  view.disconnectedCallback();observer.cb();assert(observer.closed&&disposed,'observer/terminal leaked');
 });
 console.log(JSON.stringify({checks:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length}));
})();
