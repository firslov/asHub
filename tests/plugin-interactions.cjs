const test = require('node:test');
const assert = require('node:assert/strict');
const { env, req, Res, path } = require('./harness.cjs');
function fixture() {
    const e = env(), { ExtensionMessages } = e.load('src/services/extension-messages.ts'), { PluginInteractions } = e.load('src/extensions/interactions.ts');
    const life = new AbortController(), plugin = new AbortController();
    let commits = 0;
    const messages = new ExtensionMessages(path.join(e.dir, 'store.json'), { target: () => ({ title: 'Target', binding: 'a' }), busy: () => true, dispatch: async () => { } });
    messages.bind('plugin', plugin.signal);
    const ui = new PluginInteractions(messages, () => { }, life.signal);
    const view = { rows: [], actions: [] };
    const resource = { view: () => view, prepare: () => ({ authorization: { targetId: 'target', label: 'Example', template: 'One approved task', minIntervalMs: 0, maxRuns: 1 }, execute() { commits++; return view; } }) };
    ui.bind('plugin', plugin.signal).register('main', resource);
    ui.bind('plugin', plugin.signal).register('other', resource);
    const call = async (body, id = 'main') => { const r = req(body, '/api/plugin-resources/plugin/' + id, 'POST'), s = new Res(); await ui.handle(r, s, async () => JSON.stringify(body)); return { status: s.statusCode, value: s.json() }; };
    return { e, ui, messages, life, plugin, call, commits: () => commits };
}
test('confirmation is scoped to a resource, expires, and plugin disposal invalidates pending approval', async () => {
    const f = fixture(), a = await f.call({ action: 'create', values: {} });
    assert(a.value.confirmation);
    assert.equal(f.commits(), 0);
    assert.equal((await f.call({ confirm: a.value.confirmation.id }, 'other')).status, 409);
    assert.equal(f.commits(), 0);
    f.e.clock(500001);
    assert.equal((await f.call({ confirm: a.value.confirmation.id })).status, 409);
    const b = await f.call({ action: 'create', values: {} });
    f.plugin.abort();
    assert.equal((await f.call({ confirm: b.value.confirmation.id })).status, 409);
    assert.equal(f.commits(), 0);
    f.messages.close();
});
test('a failed commit revokes its new authorization and repeating confirmation does not rerun it', async () => {
    const f = fixture();
    let grant, attempts = 0;
    f.ui.bind('plugin', f.plugin.signal).register('broken', { view: () => ({}), prepare: () => ({ authorization: { targetId: 'target', label: 'Example', template: 'Task', minIntervalMs: 0 }, execute(id) { grant = id; attempts++; throw Error('save failed'); } }) });
    const p = await f.call({ action: 'create', values: {} }, 'broken');
    const body = { confirm: p.value.confirmation.id };
    assert.equal((await f.call(body, 'broken')).status, 409);
    assert.equal((await f.call(body, 'broken')).status, 409);
    assert.equal(attempts, 1);
    const data = JSON.parse(require('node:fs').readFileSync(path.join(f.e.dir, 'store.json'), 'utf8'));
    assert.equal(data.grants[grant].revoked, true);
    f.messages.close();
});

test('remote resource confirmation binds to conversation, filters desktop controls and rechecks revocation',async()=>{
 const f=fixture();let sid='abc123',changed=0;
 f.ui.bind('plugin',f.plugin.signal).register('scoped',{remote:{conversationId:()=>sid,actions:['edit']},view:()=>({actions:[{id:'edit',label:'edit',values:{}},{id:'grant',label:'grant',values:{}}],rows:[]}),prepare:action=>({preview:{title:'Review',fields:[]},execute:()=>{changed++;return {actions:[],rows:[]};}})});
 const call=async(body,scope='abc123')=>{const r=req(body,'/api/plugin-resources/plugin/scoped'+(scope===null?'':'?remoteSession='+scope),body?'POST':'GET'),res=new Res();await f.ui.handle(r,res,async()=>JSON.stringify(body));return {status:res.statusCode,value:res.json()};};
 assert.equal((await call(null,'other')).status,409);
 const view=await call();assert.deepEqual(view.value.view.actions.map(a=>a.id),['edit']);
 assert.equal((await call({action:'grant',values:{}})).status,409);
 const desktop=await call({action:'edit',values:{}},null);assert.equal((await call({confirm:desktop.value.confirmation.id})).status,409);
 const remote=await call({action:'edit',values:{}});const confirm={confirm:remote.value.confirmation.id};await Promise.all([call(confirm),call(confirm)]);assert.equal(changed,1);
 sid='other';assert.equal((await call(confirm)).status,409);f.messages.close();
});


test('plugins cannot move mandatory authorization fields into collapsed diagnostics',async()=>{
 const f=fixture();
 f.ui.bind('plugin',f.plugin.signal).register('collapse',{view:()=>({}),prepare:()=>({preview:{title:'Review',fields:[],details:[{label:'Scope',value:'fake'}]},authorization:{targetId:'target',label:'Task',template:'Task',minIntervalMs:0,maxRuns:1},execute:()=>({rows:[],actions:[]})})});
 const result=await f.call({action:'create',values:{}},'collapse');assert.equal(result.status,200);
 assert.equal(result.value.confirmation.preview.details,undefined);assert(result.value.confirmation.preview.fields.length>0);assert.equal(f.commits(),0);f.messages.close();
});

test('combined entry grants reject hidden scope overrides and freeze the displayed budget',async()=>{
 const f=fixture(),{PluginInteractions}=f.e.load('src/extensions/interactions.ts');let approved;
 const bg={prepare:(_id,input)=>input,approve:(_id,input)=>{approved=input;return 'grant';},bind:()=>({revoke(){}})};
 const conversations={prepare:async()=>({fields:[],entry:{spec:{label:'Weekly review'}},input:{provider:'p',model:'m'},createsConversation:true}),approve:async()=> 'owned'};
 const ui=new PluginInteractions(f.messages,()=>{},f.life.signal,async(_,run)=>run(),bg,conversations);
 let config={dailyCalls:4,includeHistory:true,followModel:true,modelSessionId:'other',includedIds:['other']};
 ui.bind('plugin',f.plugin.signal).register('compound',{view:()=>({actions:[],rows:[]}),prepare:()=>({entryAuthorization:{key:'assistant',model:'m',provider:'p'},entryBackground:config,execute:()=>({actions:[],rows:[]})})});
 const call=async(body)=>{const res=new Res();await ui.handle(req(body,'/api/plugin-resources/plugin/compound','POST'),res,async()=>JSON.stringify(body));return {status:res.statusCode,...res.json()};};
 assert.equal((await call({action:'create',values:{}})).status,409,'unshown scopes must be rejected');
 config={dailyCalls:4,includeHistory:true,followModel:true};const preview=await call({action:'create',values:{}});config.dailyCalls=24;
 assert.equal((await call({confirm:preview.confirmation.id})).status,200);assert.equal(approved.dailyCalls,4);assert.deepEqual(Array.from(approved.includedIds),['owned']);f.messages.close();
});

function backgroundEntryFixture(t, execute) {
 const f=fixture();t.after(()=>f.messages.close());
 const {PluginInteractions}=f.e.load('src/extensions/interactions.ts'),{PluginBackground}=f.e.load('src/extensions/background.ts'),{ConversationEntries}=f.e.load('src/extensions/conversation-entries.ts');
 const targets=new Map([['ordinary',{id:'ordinary',cwd:f.e.dir,title:'Unrelated chat',provider:'mock',model:'tiny',busy:false}]]);
 let created=0;
 const backgroundRuntime={targets:()=>[...targets.values()],store:()=>undefined,complete:async()=>{throw Error('No model calls in permission tests');}};
 const background=new PluginBackground(path.join(f.e.dir,'background.json'),backgroundRuntime,f.life.signal);
 const entryRuntime={exists:id=>targets.has(id),models:()=>[{provider:'mock',model:'tiny'}],create:async(id,spec,input)=>{created++;targets.set(id,{id,cwd:spec.cwd,title:spec.label,provider:input.provider,model:input.model,busy:false});},changed(){}};
 const conversations=new ConversationEntries(path.join(f.e.dir,'entries.json'),entryRuntime);
 const entryApi=conversations.bind('plugin',f.plugin.signal),backgroundApi=background.bind('plugin',f.plugin.signal);
 entryApi.register('weekly-review',{label:'周报汇总',resource:'weekly-review',cwd:path.join(f.e.dir,'workspace')});
 const ui=new PluginInteractions(f.messages,()=>{},f.life.signal,async(_,run)=>run(),background,conversations);
 const config={dailyCalls:2,includeHistory:true,followModel:true};
 ui.bind('plugin',f.plugin.signal).register('weekly-review',{remote:{conversationId:()=>entryApi.get('weekly-review')||'ordinary',actions:['create']},view:()=>({actions:[],rows:[]}),prepare:()=>({preview:{title:'开启周报汇总',fields:[],details:[{label:'插件伪造说明',value:'不限制范围'}]},entryAuthorization:{key:'weekly-review',provider:'mock',model:'tiny'},entryBackground:config,execute})});
 const call=async(body,remote)=>{const res=new Res();await ui.handle(req(body,'/api/plugin-resources/plugin/weekly-review'+(remote?'?remoteSession='+remote:''),'POST'),res,async()=>JSON.stringify(body));return {status:res.statusCode,...res.json()};};
 return {...f,background,backgroundRuntime,backgroundApi,conversations,entryApi,entryRuntime,targets,config,call,created:()=>created};
}

for(const includeHistory of [true,false])test(`non-memory entry authorization uses generic host disclosures without widening scope (history=${includeHistory})`,async t=>{
 let grant,commits=0;
 const f=backgroundEntryFixture(t,id=>{grant=id;commits++;return {actions:[],rows:[]};});f.config.includeHistory=includeHistory;
 const draft=await f.call({action:'create',values:{}});assert.equal(draft.status,200,JSON.stringify(draft));
 const preview=draft.confirmation.preview,fields=preview.fields;
 assert.equal(preview.title,'开启周报汇总');
 assert(!JSON.stringify(preview).includes('记忆'),'generic host must not describe another plugin as long-term memory');
 assert.match(fields.find(x=>x.label==='读取范围').value,/本次新建的「周报汇总」对话.*不读取其他对话/);
 assert.match(fields.find(x=>x.label==='读取范围').value,includeHistory?/已有聊天记录及后续消息/:/仅包含本次确认生效时起的新消息，确认后才获得读取权/);
 assert.match(fields.find(x=>x.label==='后台模型').value,/今后切换的模型服务.*tiny.*mock/);
 assert.match(fields.find(x=>x.label==='后台模型').value,/VPN/);
 assert.match(fields.find(x=>x.label==='使用额度').value,/2.*失败也计入次数.*费用.*不执行工具/);
 assert.deepEqual(preview.details.map(x=>x.label),['单次请求上限']);
 assert.match(preview.details[0].value,/16000.*4096/);
 assert.equal(f.entryApi.get('weekly-review'),null,'preview never creates a conversation');
 f.config.dailyCalls=24;f.config.includeHistory=!includeHistory;
 const confirmed=await Promise.all([f.call({confirm:draft.confirmation.id}),f.call({confirm:draft.confirmation.id})]);
 assert(confirmed.every(x=>x.status===200),JSON.stringify(confirmed));assert.equal(commits,1);assert.equal(f.created(),1);
 const sid=f.entryApi.get('weekly-review'),status=f.backgroundApi.status(grant);
 assert.equal(status.dailyCalls,2);assert.equal(status.includeHistory,includeHistory);assert.equal(status.followModel,true);assert.equal(status.modelSessionId,sid);
 assert.deepEqual(Array.from(status.includedIds),[sid]);assert.deepEqual(Array.from(status.excludedIds),[]);
 assert.deepEqual(Array.from(f.backgroundApi.targets(grant),x=>x.id),[sid]);assert.throws(()=>f.backgroundApi.read(grant,'ordinary'),/outside/);
 const renewal=f.background.prepare('plugin',{modelSessionId:sid,includedIds:[sid],excludedIds:[],dailyCalls:2,includeHistory,followModel:true});
 for(const label of ['后台模型','使用额度'])assert.equal(renewal.fields.find(x=>x.label===label).value,fields.find(x=>x.label===label).value);
 assert.deepEqual(JSON.parse(JSON.stringify(renewal.details)),preview.details);
 f.targets.delete(sid);const replacement=await f.conversations.prepare('plugin',{key:'weekly-review',provider:'mock',model:'tiny'});
 assert.match(replacement.fields.find(x=>x.label==='恢复入口').value,/创建新的专属对话/);assert(!JSON.stringify(replacement.fields).includes('记忆'),'host cannot promise plugin memory migration');
});

test('non-memory combined grants remain desktop-only and failed commits revoke once',async t=>{
 let grant,commits=0;const f=backgroundEntryFixture(t,id=>{grant=id;commits++;throw Error('report configuration failed');});
 const remote=await f.call({action:'create',values:{}},'ordinary');assert.equal(remote.status,409);assert.match(remote.error,/桌面端确认授权/);assert.equal(f.created(),0);assert.equal(commits,0);
 const draft=await f.call({action:'create',values:{}});assert.equal(draft.status,200);
 assert.equal((await f.call({confirm:draft.confirmation.id},'ordinary')).status,409);assert.equal(f.created(),0);
 const first=await f.call({confirm:draft.confirmation.id});assert.equal(first.status,409);assert.match(first.error,/report configuration failed/);
 assert.equal((await f.call({confirm:draft.confirmation.id})).status,409);assert.equal(commits,1);assert.equal(f.created(),1);
 assert.throws(()=>f.backgroundApi.status(grant),/撤销/);assert.throws(()=>f.backgroundApi.targets(grant),/撤销/);
});

test('a separate stale creation confirmation cannot authorize the conversation created by another preview',async t=>{
 let grant,commits=0;const f=backgroundEntryFixture(t,id=>{grant=id;commits++;return {actions:[],rows:[]};});
 const first=await f.call({action:'create',values:{}}),stale=await f.call({action:'create',values:{}});
 assert.match(stale.confirmation.preview.fields.find(x=>x.label==='读取范围').value,/本次新建的/);
 assert.equal((await f.call({confirm:first.confirmation.id})).status,200);const originalGrant=grant,sid=f.entryApi.get('weekly-review');
 const rejected=await f.call({confirm:stale.confirmation.id});assert.equal(rejected.status,409);assert.match(rejected.error,/binding changed/);
 assert.equal(commits,1);assert.equal(f.created(),1);assert.equal(grant,originalGrant);assert.equal(f.backgroundApi.status(grant).modelSessionId,sid);
 const fresh=await f.call({action:'create',values:{}});
 assert.equal(fresh.confirmation.preview.fields.find(x=>x.value==='周报汇总').label,'使用对话');
 assert(!fresh.confirmation.preview.fields.find(x=>x.label==='读取范围').value.includes('本次新建的'));
 assert.equal((await f.call({confirm:fresh.confirmation.id})).status,200);assert.equal(f.created(),1);assert.equal(commits,2);
});

test('different plans cannot borrow a pending creation while the same plan remains idempotent',async t=>{
 const f=backgroundEntryFixture(t,()=>({actions:[],rows:[]})),input={key:'weekly-review',provider:'mock',model:'tiny'};
 const first=await f.conversations.prepare('plugin',input),other=await f.conversations.prepare('plugin',input);
 let started,release;const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve),create=f.entryRuntime.create;
 f.entryRuntime.create=async(...args)=>{started();await gate;return create(...args);};
 const pending=f.conversations.approve('plugin',first);await entered;
 const duplicate=f.conversations.approve('plugin',first);assert.equal(duplicate,pending);
 const rejected=assert.rejects(f.conversations.approve('plugin',other),/binding changed/);release();await rejected;
 const [a,b]=await Promise.all([pending,duplicate]);assert.equal(a,b);assert.equal(f.created(),1);
});

test('deletion and restoration invalidate a different preview without changing its authorization',async t=>{
 let grant,commits=0;const f=backgroundEntryFixture(t,id=>{grant=id;commits++;return {actions:[],rows:[]};});
 const initial=await f.call({action:'create',values:{}});await f.call({confirm:initial.confirmation.id});
 const sid=f.entryApi.get('weekly-review'),target=f.targets.get(sid),originalGrant=grant;
 const existing=await f.call({action:'create',values:{}});f.targets.delete(sid);
 const deleted=await f.call({confirm:existing.confirmation.id});assert.equal(deleted.status,409);assert.match(deleted.error,/binding changed/);assert.equal(f.created(),1);
 const missing=await f.call({action:'create',values:{}});f.targets.set(sid,target);
 const restored=await f.call({confirm:missing.confirmation.id});assert.equal(restored.status,409);assert.match(restored.error,/binding changed/);
 assert.equal(commits,1);assert.equal(grant,originalGrant);assert.equal(f.created(),1);assert.equal(f.backgroundApi.status(grant).modelSessionId,sid);
});

test('a replacement conversation invalidates another pending restoration preview',async t=>{
 let grant,commits=0;const f=backgroundEntryFixture(t,id=>{grant=id;commits++;return {actions:[],rows:[]};});
 const initial=await f.call({action:'create',values:{}});await f.call({confirm:initial.confirmation.id});
 const old=f.entryApi.get('weekly-review');f.targets.delete(old);
 const replacement=await f.call({action:'create',values:{}}),stale=await f.call({action:'create',values:{}});
 assert.equal((await f.call({confirm:replacement.confirmation.id})).status,200);const replacementGrant=grant,sid=f.entryApi.get('weekly-review');assert.notEqual(sid,old);
 const result=await f.call({confirm:stale.confirmation.id});assert.equal(result.status,409);assert.match(result.error,/binding changed/);
 assert.equal(f.created(),2);assert.equal(commits,2);assert.equal(grant,replacementGrant);assert.equal(f.backgroundApi.status(grant).modelSessionId,sid);
});

test('restoration during asynchronous model revalidation invalidates the creation snapshot',async t=>{
 let grant,commits=0;const f=backgroundEntryFixture(t,id=>{grant=id;commits++;return {actions:[],rows:[]};});
 const initial=await f.call({action:'create',values:{}});await f.call({confirm:initial.confirmation.id});
 const sid=f.entryApi.get('weekly-review'),target=f.targets.get(sid),originalGrant=grant;f.targets.delete(sid);
 const draft=await f.call({action:'create',values:{}});
 let started,release;const entered=new Promise(resolve=>started=resolve);f.entryRuntime.models=()=>new Promise(resolve=>{release=resolve;started();});
 const pending=f.call({confirm:draft.confirmation.id});await entered;f.targets.set(sid,target);release([{provider:'mock',model:'tiny'}]);
 const result=await pending;assert.equal(result.status,409);assert.match(result.error,/binding changed/);
 assert.equal(f.created(),1);assert.equal(commits,1);assert.equal(grant,originalGrant);assert.equal(f.entryApi.get('weekly-review'),sid);
});

for(const createsConversation of [true,false])test(`combined new-message consent starts when confirmation resolves the conversation (create=${createsConversation})`,async t=>{
 let grant,history,sid;const f=backgroundEntryFixture(t,id=>{grant=id;return {actions:[],rows:[]};});f.config.includeHistory=false;
 const {SessionStore}=f.e.load('src/history/session-store.ts'),{PluginBackground}=f.e.load('src/extensions/background.ts');
 const file=path.join(f.e.dir,'entry-history.jsonl'),before=[];
 f.backgroundRuntime.store=id=>id===sid?history:undefined;
 if(createsConversation){
  const create=f.entryRuntime.create;
  f.entryRuntime.create=async(id,...args)=>{
   await create(id,...args);sid=id;history=new SessionStore(file,{create:{sessionId:id,cwd:f.e.dir}});
   f.e.clock(130000);before.push(...await history.appendMessages([{role:'user',content:'组合范围-对话绑定尚未完成'}]));
   f.e.clock(140000);
  };
 }else{
  sid=await f.conversations.approve('plugin',await f.conversations.prepare('plugin',{key:'weekly-review',provider:'mock',model:'tiny'}));
  history=new SessionStore(file,{create:{sessionId:sid,cwd:f.e.dir}});
  f.e.clock(101000);before.push(...await history.appendMessages([{role:'user',content:'组合范围-预览前'}]));
 }
 f.e.clock(110000);const draft=await f.call({action:'create',values:{}});assert.equal(draft.status,200,JSON.stringify(draft));
 const scope=draft.confirmation.preview.fields.find(field=>field.label==='读取范围').value;
 assert.match(scope,/本次确认生效时起的新消息，确认后才获得读取权/);assert(!scope.includes('预览生成时'));
 assert.equal(grant,undefined,'the preview does not create a grant');
 f.e.clock(120000);
 if(!createsConversation){before.push(...await history.appendMessages([{role:'user',content:'组合范围-等待确认'}]));f.e.clock(140000);}
 assert.equal((await f.call({confirm:draft.confirmation.id})).status,200);
 assert.equal(f.backgroundApi.status(grant).since,140000,'combined grants retain their confirmation-time preparation boundary');
 assert.equal(f.backgroundApi.read(grant,sid).entries.length,0);
 for(const source of before)assert.throws(()=>f.backgroundApi.entry(grant,sid,source),/unavailable/);
 f.e.clock(150000);const [after]=await history.appendMessages([{role:'user',content:'组合范围-确认后'}]);
 assert.deepEqual(Array.from(f.backgroundApi.read(grant,sid).entries,entry=>entry.id),[after]);
 const restored=new PluginBackground(path.join(f.e.dir,'background.json'),f.backgroundRuntime,f.life.signal).bind('plugin',f.plugin.signal);
 assert.equal(restored.status(grant).since,140000);
 assert.deepEqual(Array.from(restored.search(grant,sid,'组合范围'),entry=>entry.id),[after]);
 assert.deepEqual(Array.from(restored.valid(grant,sid,[...before,after])),[after]);
});

test('sharing authorization is mandatory, desktop-only, idempotent and rolled back on failed plugin commit',async()=>{
 const e=env(),{PluginInteractions}=e.load('src/extensions/interactions.ts'),{SharedConversations}=e.load('src/extensions/shared-conversations.ts'),life=new AbortController();
 const sharing=new SharedConversations(path.join(e.dir,'grants.json'));let attempts=0,granted;
 const ui=new PluginInteractions({},()=>{},life.signal,async(_id,run)=>run(),undefined,undefined,sharing);
 ui.bind('plugin',life.signal).register('sharing',{remote:{conversationId:()=> 'aaaa',actions:['enable']},view:()=>({}),prepare:()=>({sharingAuthorization:{roots:[e.dir]},execute:id=>{attempts++;granted=id;throw Error('credential store locked');}})});
 const call=async(body,remote=false)=>{const r=req(body,'/api/plugin-resources/plugin/sharing'+(remote?'?remoteSession=aaaa':''),'POST'),s=new Res();await ui.handle(r,s,async()=>JSON.stringify(body));return{status:s.statusCode,value:s.json()};};
 assert.equal((await call({action:'enable',values:{}},true)).status,409);assert.equal(attempts,0);
 const prepared=await call({action:'enable',values:{}});assert(prepared.value.confirmation);assert.equal(attempts,0);assert(prepared.value.confirmation.preview.fields.some(f=>f.value.includes(e.dir.replace('/var/','/private/var/'))));
 const confirm={confirm:prepared.value.confirmation.id};assert.equal((await call(confirm,true)).status,409);assert.equal(attempts,0);
 assert.equal((await call(confirm)).status,409);assert.equal((await call(confirm)).status,409);assert.equal(attempts,1);assert.equal(sharing.bind('plugin',life.signal).scope(granted),null);life.abort();
});
