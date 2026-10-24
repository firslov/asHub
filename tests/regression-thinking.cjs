const test = require('node:test');
const assert = require('node:assert/strict');
const { env, req, Res, fs, path, root, vm, ts } = require('./harness.cjs');
const { ui, El } = require('./ui-harness.cjs');
const plain = v => JSON.parse(JSON.stringify(v));
const model = (id, provider = 'openai') => ({id,provider});

function thinkingUi() {
  const u=ui(), session=u.active.peek();
  const control=u.e.load('web/js/thinking-control.js');
  const source=ts.createSourceFile('sse.js',fs.readFileSync(path.join(root,'web/js/sse.js'),'utf8'),ts.ScriptTarget.Latest,true);
  let code;
  function visit(n) {
    if(ts.isMethodDeclaration(n)&&n.name?.text==='agent:info')code=n.getText(source);
    ts.forEachChild(n,visit);
  }
  visit(source);
  Object.assign(u.e.context,{activeSession:u.active,refreshModelChip(){},renderUsage(){},renderInstanceLabel(){},syncAllBalanceChips(){}});
  const handler=vm.runInContext('({'+code+'})["agent:info"]',u.e.context);
  const update=p=>handler.call(session,p);
  update({model:'gpt-5.2',provider:'openai',thinkingLevel:'low',thinkingLevels:['none','low','medium','high','xhigh'],thinkingSupported:true});
  return {...u,session,control,update};
}

function modelSwitchUi() {
  const u=thinkingUi();
  const source=ts.createSourceFile('sse.js',fs.readFileSync(path.join(root,'web/js/sse.js'),'utf8'),ts.ScriptTarget.Latest,true);
  let code;
  function visit(n) {
    if(ts.isVariableDeclaration(n)&&n.name?.text==='selectModel')code=n.initializer.getText(source);
    ts.forEachChild(n,visit);
  }
  visit(source);
  Object.assign(u.e.context,{BALANCE_PROVIDERS:new Set(),toast:(...args)=>u.toasts.push(args),t:s=>s});
  const selectModel=vm.runInContext('('+code+')',u.e.context);
  return {...u,selectModel};
}

for(const target of [{model:'gpt-5.1',provider:'openai'},{model:'gpt-5.2',provider:'codex'}]) {
  test(`late model PUT cannot overwrite newer live identity ${target.model}@${target.provider}`,async()=>{
    const {e,session,selectModel,update}=modelSwitchUi();let finish;
    e.context.fetch=()=>new Promise(resolve=>finish=resolve);
    const selecting=selectModel(session,'gpt-5.2','openai');
    // The original switch succeeds, then another client or command changes it.
    update({model:'gpt-5.2',provider:'openai',thinkingLevel:'high',thinkingLevels:['none','low','medium','high','xhigh']});
    update({...target,thinkingLevel:'low',thinkingLevels:['low','medium','high'],modalities:['text','image']});
    finish({ok:true});await selecting;
    assert.equal(session.agentInfo.model,target.model);assert.equal(session.agentInfo.provider,target.provider);
    assert.deepEqual(plain(session.agentInfo.thinkingLevels),['low','medium','high']);
    assert.deepEqual(plain(session.agentInfo.modalities),['text','image']);
  });
}

test('model PUT retains live capabilities and unchanged identity/status do not cancel its fallback',async()=>{
  const {e,session,selectModel,update}=modelSwitchUi();let finish;
  e.context.fetch=()=>new Promise(resolve=>finish=resolve);
  const confirmed=selectModel(session,'gpt-5.1','openai');
  update({model:'gpt-5.1',provider:'openai',thinkingLevel:'high',thinkingLevels:['none','low','medium','high']});
  finish({ok:true});await confirmed;
  assert.deepEqual(plain(session.agentInfo.thinkingLevels),['none','low','medium','high']);
  const fallback=selectModel(session,'gpt-5.2','openai');
  update({thinkingLevel:'low'});
  update({model:'gpt-5.1',provider:'openai'});
  finish({ok:true});await fallback;
  assert.equal(session.agentInfo.model,'gpt-5.2');assert.equal(session.agentInfo.thinkingLevels,undefined);
});

test('newer live thinking state supersedes an older GET and notifies the open picker', async () => {
  const {e,doc,session,control,update}=thinkingUi();let finish,notifications=0;
  doc.addEventListener('ash:thinking-changed',()=>notifications++);
  e.context.fetch=()=>new Promise(resolve=>finish=resolve);
  const loading=control.loadThinking(session);
  update({thinkingLevel:'high',thinkingSupported:true,thinkingLevels:['none','low','medium','high','xhigh']});
  assert.equal(notifications,1,'command/other-client changes must refresh the open menu');
  finish({ok:true,json:async()=>({model:'gpt-5.2',provider:'openai',level:'low',levels:['none','low','medium','high','xhigh'],supported:true})});
  assert.equal(await loading,false);
  assert.equal(session.agentInfo.thinkingLevel,'high');
});

test('switching away and back invalidates an old request even when the final model matches', async () => {
  const {e,session,control,update}=thinkingUi();let finish;
  e.context.fetch=()=>new Promise(resolve=>finish=resolve);
  const loading=control.loadThinking(session);
  update({model:'gpt-5.1',provider:'openai',thinkingLevel:'medium',thinkingLevels:['none','low','medium','high']});
  update({model:'gpt-5.2',provider:'openai',thinkingLevel:'xhigh',thinkingLevels:['none','low','medium','high','xhigh']});
  finish({ok:true,json:async()=>({model:'gpt-5.2',provider:'openai',level:'low',levels:['low'],supported:true})});
  assert.equal(await loading,false);assert.equal(session.agentInfo.thinkingLevel,'xhigh');
});

for (const failure of ['http','network','json']) test(`obsolete ${failure} failure cannot replace a newer live thinking state with an error`, async () => {
  const {e,session,control,update}=thinkingUi();let finish,fail;
  e.context.fetch=()=>new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
  const loading=control.loadThinking(session);
  update({thinkingLevel:'high'});
  if(failure==='network')fail(new Error('connection interrupted'));
  else finish(failure==='http'?{ok:false,status:500}:{ok:true,json:async()=>{throw new Error('invalid JSON');}});
  assert.equal(await loading,false);assert.equal(session.agentInfo.thinkingLevel,'high');
  // Genuine current-request failures still reach the retry UI.
  e.context.fetch=async()=>{throw new Error('current failure');};
  await assert.rejects(control.loadThinking(session),/current failure/);
});

for (const changedModel of [false,true]) test(`a pending shortcut does not change thinking after ${changedModel?'model switching':'a newer live update'}`, async () => {
  const u=thinkingUi(),{e,session,update}=u;u.composer();
  session.agentInfo.thinkingLevels=undefined;
  let finish;const writes=[];
  e.context.fetch=async(url,opts)=>{
    if(!opts)return new Promise(resolve=>finish=resolve);
    writes.push(JSON.parse(opts.body));
    return {ok:true,json:async()=>({model:session.agentInfo.model,provider:'openai',level:JSON.parse(opts.body).level,
      levels:session.agentInfo.thinkingLevels,supported:true})};
  };
  const press=Promise.all(u.ids.get('query').events.keydown.map(h=>h({key:'Tab',shiftKey:true,preventDefault(){}})));
  update({model:changedModel?'gpt-5.1':'gpt-5.2',provider:'openai',thinkingLevel:'high',thinkingLevels:['none','low','medium','high']});
  finish({ok:true,json:async()=>({model:'gpt-5.2',provider:'openai',level:'low',levels:['none','low','medium','high','xhigh'],supported:true})});
  await press;
  assert.equal(writes.length,0,'the cancelled shortcut must not submit a new selection');
  assert.equal(session.agentInfo.thinkingLevel,'high');assert.equal(session._thinkingCycleLoading,false);
});

test('shortcut still loads missing capabilities and submits the next supported level when current', async () => {
  const u=thinkingUi(),{e,session}=u;u.composer();session.agentInfo.thinkingLevels=undefined;
  const writes=[];
  e.context.fetch=async(url,opts)=>{
    const level=opts?JSON.parse(opts.body).level:'high';
    if(opts)writes.push(level);
    return {ok:true,json:async()=>({model:'gpt-5.2',provider:'openai',level,levels:['none','low','medium','high','xhigh'],supported:true})};
  };
  await Promise.all(u.ids.get('query').events.keydown.map(h=>h({key:'Tab',shiftKey:true,preventDefault(){}})));
  assert.deepEqual(writes,['xhigh']);assert.equal(session.agentInfo.thinkingLevel,'xhigh');
});

test('save succeeds when confirmed by SSE, but an older POST cannot overwrite a later change', async () => {
  const {e,session,control,update}=thinkingUi();let finish;
  e.context.fetch=()=>new Promise(resolve=>finish=resolve);
  const first=control.saveThinking(session,'high');
  update({thinkingLevel:'high'});
  finish({ok:true,json:async()=>({model:'gpt-5.2',provider:'openai',level:'high',levels:['none','low','medium','high','xhigh'],supported:true})});
  assert.equal(await first,true);assert.equal(session._thinkingPending,false);
  const second=control.saveThinking(session,'xhigh');
  update({thinkingLevel:'xhigh'});update({thinkingLevel:'medium'});
  finish({ok:true,json:async()=>({model:'gpt-5.2',provider:'openai',level:'xhigh',levels:['none','low','medium','high','xhigh'],supported:true})});
  assert.equal(await second,false);assert.equal(session.agentInfo.thinkingLevel,'medium');
});

test('live picker refresh preserves keyboard focus without stealing focus from the composer', () => {
  const u=ui(),session=u.active.peek(),rootEl=new El(),oldButton=new El(),newButton=new El();
  oldButton.dataset.level='high';u.doc.activeElement=oldButton;
  rootEl.contains=node=>node===oldButton;
  let html='';Object.defineProperty(rootEl,'innerHTML',{get:()=>html,set:v=>{html=v;if(u.doc.activeElement===oldButton)u.doc.activeElement=u.doc.body;}});
  rootEl.querySelector=()=>newButton;newButton.focus=()=>{u.doc.activeElement=newButton;};
  const source=fs.readFileSync(path.join(root,'web/js/sse.js'),'utf8');
  const start=source.indexOf('const renderThinkingDropdown ='),end=source.indexOf('\n};',start)+3;
  Object.assign(u.e.context,{_dropdownOwner:session,_sharedDropdown:{querySelector:()=>rootEl},_modelSelectionPending:false,
    thinkingChoices:()=>['default','low','high'],thinkingLabel:s=>s,escapeAttr:String,t:s=>s});
  vm.runInContext(source.slice(start,end)+'\nglobalThis.renderTestThinking=renderThinkingDropdown;',u.e.context);
  u.e.context.renderTestThinking(session);assert.equal(u.doc.activeElement,newButton);
  u.doc.activeElement=u.doc.getElementById('query');
  u.e.context.renderTestThinking(session);assert.equal(u.doc.activeElement,u.doc.getElementById('query'));
});

test('model profiles expose native levels, forced thinking, and no invented ladder', () => {
  const {reasoningProfile:p} = env().load('src/providers/reasoning.ts');
  assert.deepEqual(plain(p(model('gpt-5')).levels), ['minimal','low','medium','high']);
  assert.deepEqual(plain(p(model('gpt-5.1')).levels), ['none','low','medium','high']);
  assert.deepEqual(plain(p(model('gpt-5.2-2025-12-11')).levels), ['none','low','medium','high','xhigh']);
  assert.deepEqual(plain(p(model('deepseek-v4-flash','deepseek')).levels), ['off','low','high','max']);
  assert.deepEqual(plain(p(model('glm-5.3','zai-coding-plan')).levels), ['low','high','max']);
  assert.deepEqual(plain(p(model('glm-4.7','zai-coding-plan')).levels), ['off','on']);
  for (const m of [model('unknown'), model('gpt-5','private-provider'), {...model('gpt-5'),reasoning:false}]) assert.equal(p(m),null);
});

test('Codex cache supplies model-specific native max/ultra choices, including custom provider IDs', () => {
  const e=env(); e.settings.getSettings=()=>({'codex-provider':{providerId:'subscription'}});
  const cache=path.join(e.os.homedir(),'.codex','models_cache.json'); fs.mkdirSync(path.dirname(cache),{recursive:true});
  fs.writeFileSync(cache,JSON.stringify({models:[
    {slug:'gpt-6.1-sol',supported_reasoning_levels:['low','medium','high','xhigh','max','ultra'].map(effort=>({effort})),default_reasoning_level:'low'},
    {slug:'gpt-6-luna',supported_reasoning_levels:[{effort:'low'},{effort:'high'},{effort:'max'}]},
  ]}));
  const {reasoningProfile:p}=e.load('src/providers/reasoning.ts');
  assert.deepEqual(plain(p(model('gpt-6.1-sol','subscription')).levels),['low','medium','high','xhigh','max','ultra']);
  assert.deepEqual(plain(p(model('gpt-6-luna','subscription')).levels),['low','high','max']);
  assert.equal(p(model('unlisted-codex-model','subscription')),null);
});

test('selection persists per model/provider and native request values bypass legacy clamping', () => {
  const {SessionThinking}=env().load('src/providers/reasoning.ts');
  const s=new SessionThinking(), deep=model('deepseek-v4-flash','deepseek'), gpt=model('gpt-5.2');
  assert.equal(s.state(deep,'xhigh').level,'max');
  assert.equal(s.state(model('glm-4.7','zai-coding-plan'),'off').level,'off');
  assert.equal(s.state(model('gpt-5'),'off').level,'minimal');
  assert.equal(s.state(model('gpt-5.1'),'off').level,'none');
  s.set(deep,'max'); s.set(gpt,'xhigh');
  const restored=new SessionThinking(s.restoreState());
  assert.equal(restored.state(deep).level,'max'); assert.equal(restored.state(gpt).level,'xhigh');
  assert.equal(restored.state(model('gpt-5.1')).level,'none');
  assert.throws(()=>s.set(deep,'medium')); assert.throws(()=>s.set(model('glm-5.3','zai-coding-plan'),'off'));
  const request={model:deep.id,messages:[],reasoning_effort:'high',reasoning:{effort:'low'}};
  restored.apply(request,deep,'off');
  assert.deepEqual(plain(request),{model:deep.id,messages:[],thinking:{type:'enabled'},reasoning_effort:'max'});
  restored.apply(request,gpt,'off'); assert.equal(request.reasoning_effort,'xhigh'); assert.equal(request.thinking,undefined);
  restored.set(gpt,'default');restored.apply(request,gpt,'high');assert.equal(request.reasoning_effort,undefined);
});

test('Hub rejects stale model identities and invalid choices before mutating a session', async () => {
  const e=env(), {setThinking}=e.load('src/hub.ts','export {setThinking};');
  let level='high',writes=0;
  const session={id:'aaaaaa',bridge:{getThinking:()=>({model:'deepseek-v4-flash',provider:'deepseek',supported:true,levels:['off','low','high','max'],level}),setThinking:v=>{level=v;writes++;}}};
  for (const [body,status] of [[{level:'max',model:'old-model'},409],[{level:'medium'},400],[{level:'max',model:'deepseek-v4-flash',provider:'deepseek'},200]]) {
    const res=new Res();await setThinking(req(body),res,session);assert.equal(res.statusCode,status);
  }
  assert.equal(writes,1);assert.equal(level,'max');
});

test('UI waits for successful saves, rejects stale responses, and blocks duplicate writes', async () => {
  const u=ui(), {saveThinking,loadThinking}=u.e.load('web/js/thinking-control.js');
  const session=u.active.peek();session.agentInfo={model:'gpt-5.2',provider:'openai',thinkingLevel:'high',thinkingLevels:['none','low','medium','high','xhigh']};
  u.e.context.fetch=async()=>({ok:false,status:400,text:async()=>'unsupported'});
  await assert.rejects(saveThinking(session,'xhigh'));assert.equal(session.agentInfo.thinkingLevel,'high');assert.equal(session._thinkingPending,false);
  let finish;u.e.context.fetch=()=>new Promise(resolve=>finish=resolve);
  const pending=saveThinking(session,'xhigh');assert.equal(session.agentInfo.thinkingLevel,'high');
  const sequence=session._thinkingRequestSeq;
  assert.equal(await loadThinking(session),false,'reopening cannot supersede a pending write');
  assert.equal(session._thinkingRequestSeq,sequence);
  assert.equal(await saveThinking(session,'low'),false);
  session.agentInfo={model:'gpt-5.1',provider:'openai',thinkingLevel:'low'};
  finish({ok:true,json:async()=>({model:'gpt-5.2',provider:'openai',level:'xhigh',levels:['xhigh'],supported:true})});
  assert.equal(await pending,false);assert.equal(session.agentInfo.thinkingLevel,'low');
  const loading=loadThinking(session);session.agentInfo.provider='other-provider';
  finish({ok:true,json:async()=>({model:'gpt-5.1',provider:'openai',level:'high',levels:['high'],supported:true})});
  assert.equal(await loading,false);assert.equal(session.agentInfo.thinkingLevel,'low');
});

test('picker selection stops the outside-click listener before replacing its target', async () => {
  const u=ui(), session=u.active.peek(); let stopped=false,saved=false;
  const source=fs.readFileSync(path.join(root,'web/js/sse.js'),'utf8');
  const start=source.indexOf('const getSharedDropdown =');
  const end=source.indexOf('\n};',start)+3;
  Object.assign(u.e.context,{
    _sharedDropdown:null,_dropdownOwner:session,_modelSelectionPending:false,
    saveThinking:async()=>{saved=true;return true;},
    renderThinkingDropdown:()=>assert(stopped,'target replacement must happen after stopping propagation'),
    toast(){},t:s=>s,
  });
  vm.runInContext(source.slice(start,end)+'\nglobalThis.testDropdown=getSharedDropdown();',u.e.context);
  const effort=new El();effort.dataset.level='high';
  await u.e.context.testDropdown.events.click[0]({stopPropagation(){stopped=true;},target:{closest:selector=>selector==='.model-thinking-option'?effort:null}});
  assert(saved);
});
