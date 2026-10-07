// Full UI modules + real Hub endpoints; all credentials/files are disposable fixtures.
const {ui,El}=require('./ui-harness.cjs');
const {env,Res,req,assert,fs,path,check,results,root,ts,vm}=require('./harness.cjs');
const tick=()=>new Promise(setImmediate);
const response=(data,ok=true)=>({ok,status:ok?200:500,json:async()=>data,text:async()=>JSON.stringify(data)});
const configData={defaultProvider:'b',providers:{a:{apiKey:'••••••••'},b:{apiKey:'••••••••'}}};
const catalog={providers:[{name:'a',models:[]},{name:'b',models:[]}]};
function config(){
 const u=ui();u.e.context.CustomEvent=u.e.context.Event;u.doc.getElementById('config-auto-approve').closest=()=>null;
 u.modules['./sse.js']={invalidateModelCache(){},getModelCacheGeneration(){},setModelCache(){}};
 u.e.context.fetch=async url=>response(url==='/api/models'?catalog:structuredClone(configData));
 const m=u.e.load('web/js/config-panel.js');const el=id=>u.doc.getElementById(id),mode=x=>el('config-mode-tabs').events.click[0]({target:{closest:()=>({dataset:{mode:x}})}});return{...u,m,el,mode};
}
function subagents(){
 const u=ui();u.doc.getElementById('subagent-panel').hidden=true;u.modules['./state.js'].agentInfo={provider:'test'};u.modules['./sse.js']={setModelCache:()=>true};
 const label=new El(),wrap=new El(),card=new El();card.dataset.type='implement';label.closest=()=>card;label.parentElement=wrap;
 u.doc.getElementById('sa-types').querySelectorAll=q=>q==='.sa-model-label'?[label]:q==='.sa-model-select'?wrap.children:[];
 const m=u.e.load('web/js/subagent-panel.js','export const audit={buildModelSelects,refreshModelDropdowns};');m.audit.buildModelSelects();const select=wrap.children[0];select.options=[];
 const read=async()=>{m.audit.refreshModelDropdowns();await tick();await tick()};
 return{...u,m,select,read};
}
async function tabs(){
 const u=ui(),signals=u.e.load('web/vendor/signals-core.js');u.modules['../vendor/signals-core.js']=signals;
 u.modules['./store.js']={activeSessionId:signals.signal('aaaaaa'),openTabs:signals.signal(['aaaaaa']),allSessions:signals.signal(new Map()),pinnedIds:signals.signal(new Set()),getSession:id=>({title:id})};
 u.e.context.fetch=async()=>response([{instanceId:'aaaaaa',kind:'agent'}]);const m=u.e.load('web/js/session-manager.js');await tick();m.sessions.set('aaaaaa',new El());
 const created=[];u.doc.createElement=tag=>{const el=new El();el.tagName=tag;created.push(el);return el};u.doc.querySelector('.terminal').insertBefore=el=>{el.id=el['session-id'];m.registerSession(el)};
 let accept;u.e.context.window.electronAPI={onAcceptTab:f=>accept=f};u.e.context.Image=class{};u.e.context.MutationObserver=class{observe(){}};u.modules['./session-manager.js']=m;u.e.load('web/js/tabs.js');
 return{...u,m,created,accept};
}
(async()=>{
 await check('R18 old save cannot invalidate a reopened provider draft',async()=>{
  const u=config();await u.m.setConfigOpen(true);let finish;
  u.e.context.fetch=async(url,opts)=>opts?.method==='PUT'?new Promise(r=>finish=r):response(url==='/api/models'?catalog:structuredClone(configData));
  const pending=u.el('config-save-simple').events.click[0]();await u.m.setConfigOpen(false);await u.m.setConfigOpen(true);u.mode('advanced');
  const draft=JSON.parse(u.el('config-editor').value);draft.providers.b.apiKey='fixture-new-b';u.el('config-editor').value=JSON.stringify(draft);finish(response({}));await pending;u.mode('simple');
  assert(u.el('config-provider').value==='b'&&u.el('config-apikey').value==='fixture-new-b'&&!u.el('config-save-simple').disabled);
  let posted;u.e.context.fetch=async(url,opts)=>{posted=JSON.parse(opts.body);return response({})};await u.el('config-save-simple').events.click[0]();assert(posted.providers.b.apiKey==='fixture-new-b');
 });
 for(const malformed of [{models:{}},{models:[null]},{models:[{contextWindow:1}]},{apiKey:42},{models:[{id:'x',modalities:1}]},{models:[{id:'x',reasoning:'high'}]}]){
  await check('R18 invalid provider structure is rejected before writing '+JSON.stringify(malformed),async()=>{
   const e=env(),h=e.hub(),file=path.join(e.dir,'settings.json'),before=JSON.stringify({custom:'retain',providers:{b:{apiKey:'fixture'}}});fs.writeFileSync(file,before);
   const r=new Res();await h.updateConfig(req({providers:{b:malformed}}),r,new Map());assert(r.statusCode===400&&r.body.includes('providers.b')&&fs.readFileSync(file,'utf8')===before);
  });
 }
 await check('R18 valid model capabilities and extension settings remain supported by real kernel',async()=>{
  const e=env(),h=e.hub(),r=new Res(),models=['plain',{id:'vision',reasoning:true,contextWindow:32000,maxTokens:4096,modalities:['text','image'],echoReasoning:false}];
  await h.updateConfig(req({providers:{fixture:{apiKey:'fake',models}},skillPaths:['~/skills'],customExtension:{unknown:'keep'}}),r,new Map());assert(r.statusCode===200);
  const real=e.load('node_modules/agent-sh/dist/core/settings.js');assert(real.resolveProvider('fixture').models.join()==='plain,vision');assert(JSON.parse(fs.readFileSync(path.join(e.dir,'settings.json'))).customExtension.unknown==='keep');
 });
 await check('R18 corrupt provider catalog leaves advanced repair editable and simple save locked',async()=>{
  const e=env(),h=e.load('src/hub.ts','export const audit={getModels,updateConfig};').audit;fs.writeFileSync(path.join(e.dir,'settings.json'),JSON.stringify({providers:{fixture:{models:{}}}}));
  e.settings.resolveProvider=e.load('node_modules/agent-sh/dist/core/settings.js').resolveProvider;e.auth.listAllProviders=()=>[{id:'fixture'}];const models=new Res();await h.getModels(req({},'/api/models','GET'),models,new Map());assert(models.statusCode===500);
  const u=config();u.e.context.fetch=async(url,opts)=>{if(opts?.method==='PUT'){const r=new Res();await h.updateConfig(req(JSON.parse(opts.body)),r,new Map());return response({},r.statusCode===200)}return url==='/api/models'?response(models.json(),false):response({providers:{fixture:{models:{}}}})};
  await u.m.setConfigOpen(true);assert(u.el('config-save-simple').disabled&&!u.el('config-save').disabled&&!u.el('config-body-advanced').inert);
  u.el('config-editor').value=JSON.stringify({providers:{fixture:{models:['fixed']}}});await u.el('config-save').events.click[0]();assert(JSON.parse(fs.readFileSync(path.join(e.dir,'settings.json'))).providers.fixture.models[0]==='fixed');
 });
 await check('R18 retrying catalog does not replace an advanced draft',async()=>{
  const u=config();let fail=true;u.e.context.fetch=async url=>url==='/api/models'?response(catalog,!fail):response(configData);await u.m.setConfigOpen(true);
  const draft=JSON.stringify({...configData,custom:'unsaved'});u.el('config-editor').value=draft;fail=false;await u.el('config-load-retry').events.click[0]();assert(u.el('config-editor').value===draft&&u.el('config-load-state').hidden);u.mode('simple');assert(u.el('config-provider').value==='b');u.mode('advanced');assert(JSON.parse(u.el('config-editor').value).custom==='unsaved');
 });
 await check('R18 failed config read still blocks both editors even when catalog fails',async()=>{
  const u=config();u.e.context.fetch=async()=>response({},false);await u.m.setConfigOpen(true);assert(u.el('config-save').disabled&&u.el('config-save-simple').disabled&&u.el('config-body-advanced').inert);
 });
 for(const localSource of ['github:original/sample',undefined,'gitee:unrelated/sample']) await check('R18 skill marketplace identity '+(localSource??'unknown'),async()=>{
  const e=env(),h=e.hub(),skill=path.join(e.dir,'skills','sample');fs.mkdirSync(skill,{recursive:true});fs.writeFileSync(path.join(skill,'SKILL.md'),'local skill');
  if(localSource)fs.writeFileSync(path.join(skill,'.ashub-source.json'),JSON.stringify({url:'https://'+localSource.split(':')[0]+'.com/'+localSource.split(':')[1]+'.git',subdir:''}));
  const listed=new Res();await h.listInstalledSkills(req({},'/api/skills/installed','GET'),listed);assert(listed.json().installed[0].sourceId===localSource);
  const u=ui();u.doc.getElementById('skills-overlay').hidden=true;const btn=new El();btn.dataset={id:'gitee:unrelated/sample',name:'sample'};u.doc.getElementById('skills-list').querySelectorAll=()=>[btn];let deletes=0;
  u.e.context.fetch=async(url,opts)=>{if(url.startsWith('/api/skills/installed')){const r=new Res();await h.listInstalledSkills(req({},url,'GET'),r);return response(r.json())}if(url==='/api/skills/uninstall'){deletes++;const r=new Res();await h.uninstallSkill(req(JSON.parse(opts.body)),r);return response(r.json(),r.statusCode===200)}return response({skills:[{id:btn.dataset.id,name:'sample',description:'Market item'}]})};
  const m=u.e.load('web/js/skills-panel.js','export const audit={refreshSkills,refreshInstalled};');await m.audit.refreshSkills();await m.audit.refreshInstalled();await btn.events.click.at(-1)();const match=localSource===btn.dataset.id;assert(deletes===(match?1:0)&&fs.existsSync(skill)===!match);if(!match)assert(btn.disabled);
 });
 await check('R18 uninstall rechecks source on server before deleting',async()=>{
  const e=env(),h=e.hub(),skill=path.join(e.dir,'skills','sample');fs.mkdirSync(skill,{recursive:true});fs.writeFileSync(path.join(skill,'SKILL.md'),'retain');fs.writeFileSync(path.join(skill,'.ashub-source.json'),JSON.stringify({url:'https://github.com/new/sample.git',subdir:''}));
  const r=new Res();await h.uninstallSkill(req({name:'sample',path:skill,sourceId:'github:old/sample'}),r);assert(r.statusCode===409&&fs.existsSync(skill));const explicit=new Res();await h.uninstallSkill(req({name:'sample',path:skill}),explicit);assert(explicit.statusCode===200&&!fs.existsSync(skill));
 });
 await check('R18 sparse skill source identity includes subdirectory',async()=>{
  const e=env(),h=e.hub(),skill=path.join(e.dir,'skills','sample');fs.mkdirSync(skill,{recursive:true});fs.writeFileSync(path.join(skill,'SKILL.md'),'skill');fs.writeFileSync(path.join(skill,'.ashub-source.json'),JSON.stringify({url:'https://github.com/owner/skills.git',subdir:'skills/sample'}));const r=new Res();await h.listInstalledSkills(req({},'/api/skills/installed','GET'),r);assert(r.json().installed[0].sourceId==='github:owner/skills/sample');
 });
 await check('R18 legacy git installs retain their repository identity',async()=>{
  const e=env({modules:{'node:child_process':{execFile:(command,args,opts,done)=>done(null,'git@github.com:owner/sample.git\n')}}}),h=e.hub(),skill=path.join(e.dir,'skills','sample');fs.mkdirSync(path.join(skill,'.git'),{recursive:true});fs.writeFileSync(path.join(skill,'SKILL.md'),'legacy');const r=new Res();await h.listInstalledSkills(req({},'/api/skills/installed','GET'),r);assert(r.json().installed[0].sourceId==='github:owner/sample');
 });
 await check('R18 full-repository install records source for subsequent matching uninstall',async()=>{
  const e=env({modules:{'node:child_process':{execFile:(command,args,opts,done)=>{if(args[0]==='clone'){fs.mkdirSync(args.at(-1),{recursive:true});fs.writeFileSync(path.join(args.at(-1),'SKILL.md'),'installed')}done(null,'')}}}}),h=e.hub(),r=new Res();await h.installSkill(req({id:'github:owner/sample'}),r);assert(r.statusCode===200&&r.json().sourceId==='github:owner/sample');const listed=new Res();await h.listInstalledSkills(req({},'/api/skills/installed','GET'),listed);assert(listed.json().installed[0].sourceId==='github:owner/sample');const removed=new Res();await h.uninstallSkill(req({name:'sample',sourceId:'github:owner/sample'}),removed);assert(removed.statusCode===200);
 });
 for(const failure of ['http','network','malformed'])await check('R18 failed subagent '+failure+' read preserves confirmed selection and retries',async()=>{
  const u=subagents();let fail=false;u.e.context.fetch=async url=>{if(url==='/api/models')return response({providers:[{name:'test',models:[{id:'saved'}]}]});if(fail){if(failure==='network')throw Error('offline');return response(failure==='malformed'?{models:[]}:{error:'unavailable'},failure!=='http')}return response({models:{implement:'saved@test'}})};
  await u.read();assert(u.select.value==='saved@test'&&!u.select.disabled);fail=true;await u.read();assert(u.select.value==='saved@test'&&u.toasts.at(-1)[0]==='sa.model.load.failed');fail=false;await u.read();assert(u.select.value==='saved@test'&&!u.select.disabled);
 });
 await check('R18 valid empty subagent overrides enable inherit after initial load',async()=>{
  const u=subagents();u.e.context.fetch=async url=>response(url==='/api/models'?{providers:[]}:{models:{}});await u.read();assert(u.select.value==='inherit'&&!u.select.disabled&&u.select.innerHTML.includes('>inherit</option>'));
 });
 await check('R18 first subagent read failure keeps uninitialized controls disabled',async()=>{
  const u=subagents();u.e.context.fetch=async url=>response(url==='/api/models'?{providers:[]}:{error:'failed'},url==='/api/models');await u.read();assert(u.select.disabled&&!u.select._modelsLoaded&&u.toasts.length===1);
 });
 await check('R18 failed subagent write and failed reread retain last confirmed model',async()=>{
  const u=subagents();u.e.context.fetch=async url=>response(url==='/api/models'?{providers:[{name:'test',models:[{id:'saved'},{id:'new'}]}]}:{models:{implement:'saved@test'}});await u.read();u.e.context.fetch=async()=>response({error:'failed'},false);u.select.value='new@test';u.select.dispatchEvent({type:'change'});await tick();await tick();assert(u.select.value==='saved@test');
 });
 for(const kind of ['terminal','ash-terminal','agent'])await check('R18 transferred '+kind+' chooses its view before subscribing',async()=>{
  const u=await tabs();await u.accept({sessionId:'bbbbbb',kind});const view=u.created.find(el=>el['session-id']==='bbbbbb');assert(view.tagName===(kind==='agent'?'session-view':'terminal-view')&&u.m.sessionKinds.get('bbbbbb')===kind);
 });
 await check('R18 legacy transfer resolves unknown session kind before opening',async()=>{
  const u=await tabs();let resolve;u.e.context.fetch=()=>new Promise(r=>resolve=r);const pending=u.accept('bbbbbb');assert(!u.m.sessions.has('bbbbbb'));resolve(response([{instanceId:'bbbbbb',kind:'terminal'}]));await pending;assert(u.m.sessions.get('bbbbbb').tagName==='terminal-view');
 });
 await check('R18 legacy metadata failure reports error without opening a wrong view',async()=>{
  const u=await tabs();u.e.context.fetch=async()=>response({},false);await u.accept('bbbbbb');assert(!u.m.sessions.has('bbbbbb')&&u.toasts.length===1);
 });
 await check('R18 Electron forwards validated type in transfer IPC',()=>{
  const source=fs.readFileSync(path.join(root,'electron/main.cjs'),'utf8'),sf=ts.createSourceFile('main.cjs',source,ts.ScriptTarget.Latest,true);let fn;const visit=n=>{if(ts.isCallExpression(n)&&n.expression.getText(sf)==='ipcMain.handle'&&n.arguments[0]?.text==='move-tab-to-window-at')fn=n.arguments[1];ts.forEachChild(n,visit)};visit(sf);let sent;const e=env({globals:{isValidSessionId:id=>id==='bbbbbb',screen:{getCursorScreenPoint:()=>({x:1,y:2})},findWinAt:()=>({webContents:{send:(...a)=>sent=a},focus(){}})}});const handler=vm.runInContext('('+fn.getText(sf)+')',e.context);assert(handler({sender:{}},'bbbbbb','terminal').moved&&sent[1].kind==='terminal'&&sent[1].sessionId==='bbbbbb');assert(!handler({sender:{}},'bbbbbb','unknown').moved);
 });
 console.log(JSON.stringify({checks:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length}));
})();
