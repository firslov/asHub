const {ui,El}=require('./ui-harness.cjs');
const {env,Res,req,assert,fs,path,check,results}=require('./harness.cjs');
const response=x=>({ok:true,json:async()=>x});
const prove=check;
function config({catalogFailure=false}={}){const u=ui();u.e.context.CustomEvent=u.e.context.Event;u.doc.getElementById('config-auto-approve').closest=()=>null;u.modules['./sse.js']={invalidateModelCache(){},getModelCacheGeneration(){},setModelCache(){}};u.e.context.fetch=async url=>url==='/api/models'?(catalogFailure?{ok:false,status:503}:response({providers:[{name:'a',models:[]},{name:'b',models:[]}]})):response({defaultProvider:'a',providers:{a:{apiKey:'••••••••'},b:{apiKey:'••••••••'}}});const m=u.e.load('web/js/config-panel.js');const el=id=>u.doc.getElementById(id),mode=x=>el('config-mode-tabs').events.click[0]({target:{closest:()=>({dataset:{mode:x}})}});return{...u,m,el,mode}}
(async()=>{
 await prove('R17 advanced key removal survives simple save and backend persistence',async()=>{const u=config();await u.m.setConfigOpen(true);u.mode('advanced');const draft=JSON.parse(u.el('config-editor').value);delete draft.providers.a.apiKey;u.el('config-editor').value=JSON.stringify(draft);u.mode('simple');assert(u.el('config-apikey').value==='');const e=env(),h=e.hub(),file=path.join(e.dir,'settings.json');fs.writeFileSync(file,JSON.stringify({defaultProvider:'a',providers:{a:{apiKey:'fixture-old-key'},b:{apiKey:'fixture-b'}}}));let posted;u.e.context.fetch=async(url,opts)=>{posted=JSON.parse(opts.body);const r=new Res();await h.updateConfig(req(posted),r,new Map());return{ok:r.statusCode===200,json:async()=>r.json(),text:async()=>r.body}};await u.el('config-save-simple').events.click[0]();const kept=JSON.parse(fs.readFileSync(file,'utf8')).providers.a.apiKey;assert(kept===undefined);return{editorKeyWasEmpty:true,postedKey:posted.providers.a.apiKey,oldCredentialStillStored:false};});
 await prove('R17 provider switching retains unsaved key draft',async()=>{const u=config();await u.m.setConfigOpen(true);u.el('config-apikey').value='fixture-new-key';u.el('config-apikey').dispatchEvent({type:'input'});u.el('config-provider').value='b';u.el('config-provider').events.change[0]();u.el('config-provider').value='a';u.el('config-provider').events.change[0]();assert(u.el('config-apikey').value==='fixture-new-key');return{draftLost:false};});
 await prove('R17 pending reveal cannot overwrite a new advanced key draft',async()=>{const u=config();await u.m.setConfigOpen(true);let finish;u.e.context.fetch=()=>new Promise(r=>finish=r);const reveal=u.el('config-apikey-toggle').events.click[0]();u.mode('advanced');const draft=JSON.parse(u.el('config-editor').value);draft.providers.a.apiKey='fixture-new-key';u.el('config-editor').value=JSON.stringify(draft);u.el('config-editor').dispatchEvent({type:'input'});u.mode('simple');assert(u.el('config-apikey').value==='fixture-new-key');finish(response({apiKey:'fixture-old-key'}));await reveal;assert(u.el('config-apikey').value==='fixture-new-key');return{newDraftOverwritten:false};});
 await prove('R17 catalog failure disables simple save and permits advanced recovery',async()=>{const u=config({catalogFailure:true});await u.m.setConfigOpen(true);let puts=0;u.e.context.fetch=async()=>{puts++;return response({})};await u.el('config-save-simple').events.click[0]();assert(u.el('config-save-simple').disabled&&!u.el('config-save').disabled&&!u.el('config-body-advanced').inert&&puts===0&&!u.el('config-load-state').hidden&&!u.el('config-load-retry').hidden);return{saveEnabled:false,puts,loadErrorHidden:false};});
 await prove('R17 skill uninstall network failure reports feedback and allows retry',async()=>{const u=ui();u.doc.getElementById('skills-overlay').hidden=true;const row=new El();row.dataset.name='sample';u.doc.getElementById('skills-installed-list').querySelectorAll=()=>[row];u.e.context.fetch=async()=>response({installed:[{name:'sample',path:'/project/.agents/skills/sample'}]});const m=u.e.load('web/js/skills-panel.js','export const audit={refreshInstalled};');await m.audit.refreshInstalled();u.e.context.fetch=async()=>{throw Error('offline')};await row.events.click[0]();assert(!row.disabled&&u.toasts.length===1&&u.toasts[0][0]==='skills.uninstall.failed');return{buttonReenabled:true,toasts:1};});
 const changeProvider=(u,id)=>{u.el('config-provider').value=id;u.el('config-provider').events.change[0]();};
 const enterKey=(u,key)=>{u.el('config-apikey').value=key;u.el('config-apikey').dispatchEvent({type:'input'});};
 for (const initial of [{}, {providers:{a:{models:['existing-model']}}}]) {
   await check('Browsing providers before the first key does not set a default ('+(initial.providers?'old catalog':'new profile')+')', async () => {
     const u=config(); let saved;
     u.e.context.fetch=async (url, options)=>{
       if (url==='/api/models') return response({providers:[{name:'a',models:[]},{name:'b',models:[]}]});
       if (options?.method==='PUT') saved=JSON.parse(options.body);
       return response(initial);
     };
     await u.m.setConfigOpen(true);
     changeProvider(u,'b');
     enterKey(u,'fixture-only-key');
     await u.el('config-save-simple').events.click[0]();
     assert(saved.defaultProvider==='b','untouched first provider became the default');
     assert(saved.providers.b.apiKey==='fixture-only-key');
     assert(JSON.stringify(saved.providers.a)===JSON.stringify(initial.providers?.a),'browsing changed the untouched provider');
   });
 }
 await check('Saving other preferences after browsing providers leaves their configuration untouched',async()=>{
   const u=config(), stored={providers:{a:{models:['existing'],apiKey:'••••••••'}}}; let posted, writes=0;
   u.e.context.fetch=async(url,opts)=>{
     if(url==='/api/models') return response({providers:['a','b'].map(name=>({name,models:[]}))});
     if(opts?.method==='PUT'){writes++;posted=JSON.parse(opts.body);}
     return response(stored);
   };
   await u.m.setConfigOpen(true); changeProvider(u,'b'); await u.m.setConfigOpen(false);
   assert(writes===0,'closing settings must not write');
   await u.m.setConfigOpen(true); changeProvider(u,'b');
   u.el('config-default-cwd').value='/fixture';
   await u.el('config-save-simple').events.click[0]();
   assert(writes===1 && JSON.stringify(posted)===JSON.stringify(stored),'saving local preferences changed provider configuration');
 });
 await check('Removing the only credential from an old profile does not select its provider as default',async()=>{
   const u=config(); let posted;
   u.e.context.fetch=async(url,opts)=>{
     if(url==='/api/models')return response({providers:[{name:'a',models:[]}]});
     if(opts?.method==='PUT')posted=JSON.parse(opts.body);
     return response({providers:{a:{models:['existing'],apiKey:'••••••••'}}});
   };
   await u.m.setConfigOpen(true); enterKey(u,''); await u.el('config-save-simple').events.click[0]();
   assert(!Object.hasOwn(posted,'defaultProvider') && !Object.hasOwn(posted.providers.a,'apiKey') && posted.providers.a.models[0]==='existing');
 });
 for (const keepSecond of [false,true]) {
   await check('Reverting the first credential restores the final provider choices ('+keepSecond+')',async()=>{
     const u=config(); let saved; let writes=0;
     u.e.context.fetch=async(url,opts)=>{
       if(url==='/api/models')return response({providers:['a','b'].map(name=>({name,models:[]}))});
       if(opts?.method==='PUT'){writes++;saved=JSON.parse(opts.body);}
       return response({keep:'original'});
     };
     await u.m.setConfigOpen(true);
     enterKey(u,'fixture-temporary'); changeProvider(u,'b');
     if(keepSecond)enterKey(u,'fixture-retained');
     u.mode('advanced');
     const json=JSON.parse(u.el('config-editor').value);
     json.keep='edited separately';
     if(keepSecond)json.providers.other={models:['custom-model']};
     u.el('config-editor').value=JSON.stringify(json);
     u.mode('simple');
     changeProvider(u,'a'); enterKey(u,'');
     await u.el('config-save-simple').events.click[0]();
     assert(writes===1 && saved.keep==='edited separately');
     assert(!saved.providers?.a,'reverted credential left an empty provider entry');
     if(keepSecond) assert(saved.defaultProvider==='b' && saved.providers.b.apiKey==='fixture-retained' && saved.providers.other.models[0]==='custom-model');
     else assert(!Object.hasOwn(saved,'defaultProvider') && !Object.hasOwn(saved,'providers'));
   });
 }
 for (const explicitDefault of [null,'b']) {
   await check('Advanced default edit survives undo of a separate temporary credential ('+explicitDefault+')',async()=>{
     const u=config(); let saved;
     u.e.context.fetch=async(url,opts)=>{
       if(url==='/api/models')return response({providers:['a','b'].map(name=>({name,models:[]}))});
       if(opts?.method==='PUT')saved=JSON.parse(opts.body);
       return response({});
     };
     await u.m.setConfigOpen(true); enterKey(u,'temporary-key'); changeProvider(u,'b'); enterKey(u,'retained-key');
     u.mode('advanced'); const draft=JSON.parse(u.el('config-editor').value);
     if(explicitDefault) draft.defaultProvider=explicitDefault; else delete draft.defaultProvider;
     u.el('config-editor').value=JSON.stringify(draft); u.mode('simple');
     changeProvider(u,'a'); enterKey(u,''); await u.el('config-save-simple').events.click[0]();
     assert(!Object.hasOwn(saved.providers,'a') && saved.providers.b.apiKey==='retained-key');
     assert(explicitDefault ? saved.defaultProvider===explicitDefault : !Object.hasOwn(saved,'defaultProvider'));
   });
 }
 for (const replacement of [false,true]) {
   await check('Editing model metadata does not make an inferred provider default permanent ('+replacement+')', async()=>{
     const u=config();let saved;
     u.e.context.fetch=async(url,opts)=>{
       if(url==='/api/models')return response({providers:['a','b'].map(name=>({name,models:[]}))});
       if(opts?.method==='PUT')saved=JSON.parse(opts.body);
       return response({});
     };
     await u.m.setConfigOpen(true);
     enterKey(u,'temporary-a'); changeProvider(u,'b');
     if(replacement)enterKey(u,'retained-b');
     u.mode('advanced'); const draft=JSON.parse(u.el('config-editor').value);
     draft.providers.a.models=['custom-model']; draft.providers.a.contextWindow=32768;
     u.el('config-editor').value=JSON.stringify(draft); u.mode('simple');
     changeProvider(u,'a'); enterKey(u,'');
     await u.el('config-save-simple').events.click[0]();
     assert(saved.providers.a.models[0]==='custom-model' && saved.providers.a.contextWindow===32768 && !Object.hasOwn(saved.providers.a,'apiKey'));
     assert(replacement ? saved.defaultProvider==='b' : !Object.hasOwn(saved,'defaultProvider'), 'metadata edit promoted the temporary default');
   });
 }
 for (const edit of ['replace-key','delete-provider','clear-key']) {
   await check('An inferred default follows the surviving credentials after advanced '+edit,async()=>{
     const u=config();let saved;
     u.e.context.fetch=async(url,opts)=>{
       if(url==='/api/models')return response({providers:['a','b'].map(name=>({name,models:[]}))});
       if(opts?.method==='PUT')saved=JSON.parse(opts.body);
       return response({});
     };
     await u.m.setConfigOpen(true); enterKey(u,'first-a'); changeProvider(u,'b'); enterKey(u,'keep-b');
     u.mode('advanced');const draft=JSON.parse(u.el('config-editor').value);
     if(edit==='delete-provider')delete draft.providers.a;
     else {
       draft.providers.a.models=['custom-a'];
       if(edit==='replace-key')draft.providers.a.apiKey='second-a';
       else delete draft.providers.a.apiKey;
     }
     u.el('config-editor').value=JSON.stringify(draft);u.mode('simple');
     if(edit!=='replace-key')assert(u.el('config-provider').value==='b','simple form must show the effective default');
     if(edit==='replace-key'){
       changeProvider(u,'a');assert(u.el('config-apikey').value==='second-a');enterKey(u,'');
     }
     await u.el('config-save-simple').events.click[0]();
     assert(saved.defaultProvider==='b' && saved.providers.b.apiKey==='keep-b','inferred default is still bound to the removed credential');
     if(edit==='delete-provider')assert(!Object.hasOwn(saved.providers,'a'));
     else assert(!Object.hasOwn(saved.providers.a,'apiKey') && saved.providers.a.models[0]==='custom-a');
   });
 }
 await check('Settings drafts and onboarding saves use their own provider revision', async () => {
   const u=config(), sent=[];
   let revision='first-version';
   u.e.context.fetch=async (url,opts)=>{
     if(url==='/api/models')return response({providers:[{name:'a',models:[]}]});
     if(opts?.method==='PUT'){
       sent.push(opts.headers['X-asHub-Provider-Revision']);
       return {ok:false,text:async()=>'Provider settings changed'};
     }
     const current=revision;
     return {...response({defaultProvider:'a',providers:{a:{apiKey:'••••••••'}}}),
       headers:{get:name=>name.toLowerCase()==='x-ashub-provider-revision'?current:null}};
   };
   await u.m.setConfigOpen(true);
   revision='second-version';
   await u.m.saveProviderApiKey('a','fixture-onboarding');
   enterKey(u,'fixture-panel');
   await u.el('config-save-simple').events.click[0]();
   assert(u.el('config-apikey').value==='fixture-panel');
   await u.m.setConfigOpen(false);await u.m.setConfigOpen(true);
   u.mode('advanced');await u.el('config-save').events.click[0]();
   assert(JSON.stringify(sent)===JSON.stringify(['second-version','first-version','second-version']));
 });
 await check('Clearing a simple-mode credential survives a provider switch and save', async () => {
   const u = config();
   await u.m.setConfigOpen(true);
   enterKey(u, '');
   changeProvider(u, 'b');
   changeProvider(u, 'a');
   assert(u.el('config-apikey').value === '', 'deleted key returned after switching providers');
   let posted;
   u.e.context.fetch = async (_url, opts) => { posted = JSON.parse(opts.body); return response({}); };
   await u.el('config-save-simple').events.click[0]();
   assert(!('apiKey' in posted.providers.a) && posted.providers.b.apiKey === '••••••••');
 });
 await check('Saving a revealed but unedited credential preserves a concurrent rotation', async () => {
   const u = config(), e = env(), hub = e.hub(), file = path.join(e.dir, 'settings.json');
   await u.m.setConfigOpen(true);
   u.e.context.fetch = async () => response({apiKey:'fixture-old'});
   await u.el('config-apikey-toggle').events.click[0]();
   assert(u.el('config-apikey').value === 'fixture-old');
   fs.writeFileSync(file, JSON.stringify({providers:{a:{apiKey:'fixture-rotated'}, b:{apiKey:'fixture-b'}}}));
   let posted;
   u.e.context.fetch = async (_url, opts) => {
     posted = JSON.parse(opts.body);
     const res = new Res();
     await hub.updateConfig(req(posted), res, new Map());
     return {ok:res.statusCode === 200, text:async () => res.body};
   };
   await u.el('config-save-simple').events.click[0]();
   assert(JSON.parse(fs.readFileSync(file,'utf8')).providers.a.apiKey === 'fixture-rotated', 'showing a key rolled back its rotation');
   assert(posted.providers.a.apiKey === '••••••••');
 });
 await check('Typing during a pending reveal keeps the selected visibility and the new draft', async () => {
   const u = config();
   await u.m.setConfigOpen(true);
   let finish;
   u.e.context.fetch = () => new Promise(resolve => { finish = resolve; });
   const reveal = u.el('config-apikey-toggle').events.click[0]();
   enterKey(u, 'fixture-new');
   finish(response({apiKey:'fixture-old'}));
   await reveal;
   assert(u.el('config-apikey').value === 'fixture-new' && u.el('config-apikey').type === 'text');
   await u.el('config-apikey-toggle').events.click[0]();
   assert(u.el('config-apikey').value === 'fixture-new' && u.el('config-apikey').type === 'password');
 });
 await check('Reset restores the description for the selected provider', async () => {
   const u = config();
   u.e.context.fetch = async url => response(url === '/api/models'
     ? {providers:[{name:'a',defaultModel:'alpha',models:[]},{name:'b',defaultModel:'beta',models:[]}]}
     : {defaultProvider:'a',providers:{a:{},b:{}}});
   await u.m.setConfigOpen(true);
   changeProvider(u,'b');
   assert(u.el('config-provider-desc').textContent === 'default: beta');
   u.el('config-reset').events.click[0]();
   assert(u.el('config-provider').value === 'a' && u.el('config-provider-desc').textContent === 'default: alpha');
 });
 await check('Saving the simple form preserves custom provider IDs that match object properties', async () => {
   const u = config(), ids = ['a','constructor','__proto__'];
   const providers = Object.fromEntries(ids.map(id => [id,{apiKey:'••••••••',defaultModel:id+'-model'}]));
   u.e.context.fetch = async url => response(url === '/api/models'
     ? {providers:ids.map(name=>({name,models:[]}))}
     : {defaultProvider:'a',providers});
   await u.m.setConfigOpen(true);
   enterKey(u,'new-a');
   let posted;
   u.e.context.fetch = async (_url, opts) => { posted = JSON.parse(opts.body); return response({}); };
   await u.el('config-save-simple').events.click[0]();
   for (const id of ids) assert(Object.hasOwn(posted.providers,id) && posted.providers[id].defaultModel === id+'-model');
   assert(u.m.providerLabel('constructor') === 'constructor');
 });
 await check('R17 saving B includes edits to A and preserves model capabilities',async()=>{const u=config();await u.m.setConfigOpen(true);u.mode('advanced');const draft=JSON.parse(u.el('config-editor').value);draft.providers.a.models=[{id:'vision',modalities:['image'],contextWindow:32000}];u.el('config-editor').value=JSON.stringify(draft);u.mode('simple');enterKey(u,'new-a');changeProvider(u,'b');enterKey(u,'new-b');let posted;u.e.context.fetch=async(url,opts)=>{posted=JSON.parse(opts.body);return response({})};await u.el('config-save-simple').events.click[0]();assert(posted.providers.a.apiKey==='new-a'&&posted.providers.b.apiKey==='new-b'&&posted.providers.a.models[0].modalities[0]==='image');});
 await check('R17 advanced roundtrip preserves keys for multiple providers',async()=>{const u=config();await u.m.setConfigOpen(true);enterKey(u,'new-a');changeProvider(u,'b');enterKey(u,'new-b');u.mode('advanced');const draft=JSON.parse(u.el('config-editor').value);assert(draft.providers.a.apiKey==='new-a'&&draft.providers.b.apiKey==='new-b');draft.providers.a.apiKey='advanced-a';delete draft.providers.b.apiKey;u.el('config-editor').value=JSON.stringify(draft);u.mode('simple');changeProvider(u,'b');assert(u.el('config-apikey').value==='');changeProvider(u,'a');assert(u.el('config-apikey').value==='advanced-a');u.mode('advanced');assert(!JSON.parse(u.el('config-editor').value).providers.b.apiKey);});
 await check('R17 revealing an unsaved advanced key never fetches stored credentials',async()=>{const u=config();await u.m.setConfigOpen(true);u.mode('advanced');const draft=JSON.parse(u.el('config-editor').value);draft.providers.a.apiKey='draft';u.el('config-editor').value=JSON.stringify(draft);u.mode('simple');let reads=0;u.e.context.fetch=async()=>{reads++;return response({apiKey:'old'})};await u.el('config-apikey-toggle').events.click[0]();assert(!reads&&u.el('config-apikey').value==='draft'&&u.el('config-apikey').type==='text');});
 await check('R17 pending reveal cannot overwrite reset settings',async()=>{const u=config();await u.m.setConfigOpen(true);let finish;u.e.context.fetch=()=>new Promise(r=>finish=r);const pending=u.el('config-apikey-toggle').events.click[0]();u.el('config-reset').events.click[0]();finish(response({apiKey:'old'}));await pending;assert(u.el('config-apikey').value==='••••••••'&&u.el('config-apikey').type==='password');});
 await check('R17 successful reveal hides back to placeholder before changing provider',async()=>{const u=config();await u.m.setConfigOpen(true);u.e.context.fetch=async()=>response({apiKey:'fixture-revealed'});await u.el('config-apikey-toggle').events.click[0]();assert(u.el('config-apikey').value==='fixture-revealed');changeProvider(u,'b');changeProvider(u,'a');assert(u.el('config-apikey').value==='••••••••'&&u.el('config-apikey').type==='password');});
 await check('R17 reset discards all unsaved provider drafts',async()=>{const u=config();await u.m.setConfigOpen(true);enterKey(u,'new-a');changeProvider(u,'b');enterKey(u,'new-b');u.el('config-reset').events.click[0]();assert(u.el('config-apikey').value==='••••••••');changeProvider(u,'b');assert(u.el('config-apikey').value==='••••••••');});
 await check('R17 catalog failure recovers through visible retry',async()=>{const u=config({catalogFailure:true});await u.m.setConfigOpen(true);u.e.context.fetch=async url=>response(url==='/api/models'?{providers:[{name:'a',models:[]}]}:{defaultProvider:'a',providers:{a:{apiKey:'••••••••'}}});await u.el('config-load-retry').events.click[0]();assert(!u.el('config-save-simple').disabled&&!u.el('config-save').disabled&&u.el('config-load-state').hidden);});
 await check('R17 empty provider catalog still allows advanced settings',async()=>{const u=config();u.e.context.fetch=async url=>response(url==='/api/models'?{providers:[]}:{providers:{}});await u.m.setConfigOpen(true);assert(u.el('config-save-simple').disabled&&!u.el('config-save').disabled);u.mode('advanced');assert(u.el('config-body-advanced').hidden===undefined);});
 await check('R17 late catalog failure cannot affect a reopened settings panel',async()=>{const u=config();let finish;u.e.context.fetch=()=>new Promise(r=>finish=r);const old=u.m.setConfigOpen(true);await u.m.setConfigOpen(false);u.doc.dispatchEvent({type:'ash:models-changed'});u.e.context.fetch=async url=>response(url==='/api/models'?{providers:[{name:'a',models:[]}]}:{defaultProvider:'a',providers:{a:{}}});await u.m.setConfigOpen(true);finish({ok:false,status:503});await old;assert(!u.el('config-save-simple').disabled&&u.el('config-load-state').hidden);});
 await check('R17 HTTP uninstall failure reports once and a later retry succeeds',async()=>{const u=ui();u.doc.getElementById('skills-overlay').hidden=true;const m=u.e.load('web/js/skills-panel.js','export const audit={uninstall};');u.e.context.fetch=async()=>({ok:false,status:403,text:async()=>'denied'});try{await m.audit.uninstall('sample',{path:'/tmp/sample',cwd:'project A'})}catch{}assert(u.toasts.length===1&&u.toasts[0][1].detail==='denied');u.e.context.fetch=async()=>response({});assert(await m.audit.uninstall('sample',{path:'/tmp/sample',cwd:'project A'}));assert(u.toasts.length===1);});
 console.log(JSON.stringify({checks:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length}));
})();
