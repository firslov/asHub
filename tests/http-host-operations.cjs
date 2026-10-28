const {env,Bridge,path,root,fs}=require('./harness.cjs');
const assert=require('node:assert/strict'),{once}=require('node:events');
(async()=>{
 let failMetadata=false,modelHook,beforeModelHook,writeHook;
 const testFs={...fs,promises:{...fs.promises,async writeFile(file,...args){
  await writeHook?.(String(file));
  if(failMetadata && String(file).endsWith('.meta.json.tmp')) throw new Error('fixture metadata write failed');
  return fs.promises.writeFile(file,...args);
 }}};
 const e=env({modules:{'node:fs':testFs}});e.context.process.env.ASHUB_TOKEN='host-test';
 const instances=[]; const {ExplicitApprovals}=e.load('src/host-operations.ts');
 class Fixture extends Bridge {
  constructor(o){super(o);instances.push(this);this.model=o.model||'deepseek-v4-flash';this.provider=o.provider||'deepseek';this.level='off';this.approvals=new ExplicitApprovals((name,payload)=>this.emit('event',{name,payload}));}
  decidePermission(id,outcome){this.approvals.decide(id,outcome);}
  info(){this.emit('event',{name:'agent:info',payload:{model:this.model,provider:this.provider,thinkingLevel:this.level}});}
  async ready(){this.info();}
  async execCommand(name,target){assert.equal(name,'/model');await beforeModelHook?.(this);[this.model,this.provider]=target.split('@');this.info();await modelHook?.(this);}
  getThinking(){return {supported:true,level:this.level,levels:this.model==='fixture-model'?['low','high']:['off','low','high','max']};}
  setThinking(level){this.level=level;this.info();}
  getRestoreState(){return {conversationInstructions:this.opts.instructions,thinkingSelections:[[JSON.stringify([this.provider,this.model]),this.level]]};}
  async getModels(){await this.onGetModels?.();return {models:[{model:'deepseek-v4-flash',provider:'deepseek',thinkingLevels:['off','low','high','max']},{model:'fixture-model',provider:'fixture-provider',thinkingLevels:['low','high']}],active:null};}
 }
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new Fixture(o)});await once(hub.server,'listening');
 const base=`http://127.0.0.1:${hub.server.address().port}`,headers={Authorization:'Bearer host-test','Content-Type':'application/json'};
 const api=async(url,body)=>{const r=await fetch(base+url,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});assert(r.ok,await r.clone().text());return r.json();};
 try {
  const from=await api('/sessions',{cwd:e.dir});const bridge=instances[0],access=bridge.opts.hostAccess;assert(access);
  const request=(key,type,input)=>({idempotencyKey:key,operations:[{type,input}]});let approvals=0;const approve=async p=>{approvals++;assert(p.items.length);return true;};
  const projectResult=await access.execute(request('project-001','project.create',{name:'Review',cwd:e.dir,members:[from.instanceId]}),approve);
  const project=projectResult.results[0].project;assert(project.sessionIds.includes(from.instanceId));
  const input={title:'Reviewer',projectId:project.id,model:'deepseek-v4-flash',provider:'deepseek',thinking:'max',proxyEnabled:false,instructions:'Review citations and report evidence gaps.'};
  const plan=request('members-001','conversation.create',input);
  assert.equal((await access.execute(plan,async()=>false)).status,'denied');assert.equal((await api('/sessions')).length,1);
  const result=await access.execute(plan,approve);assert.equal(result.status,'completed',result.error);const id=result.results[0].instanceId;
  const member=(await api('/sessions')).find(s=>s.instanceId===id);assert.equal(member.projectId,project.id);assert.equal(member.cwd,e.dir);assert.equal(member.title,'Reviewer');assert.equal(member.thinkingLevel,'max');
  assert.equal((await api('/api/settings/network')).sessions[id],false);
  assert.equal(instances[1].opts.instructions,input.instructions);assert.equal(instances[1].messages.length,0,'no automatic prompt');
  const meta=JSON.parse(fs.readFileSync(path.join(e.dir,'hub-sessions',id+'.meta.json'),'utf8'));assert.equal(meta.backendState.conversationInstructions,input.instructions);
  const again=await access.execute(plan,async()=>{throw Error('duplicate approval');});assert.equal(again.results[0].instanceId,id);assert.equal((await api('/sessions')).length,2);
  for(const [n,extra] of [{thinking:'ultra'},{model:'invented'},{cwd:path.dirname(e.dir)},{proxyEnabled:'yes'}].entries()) {
   await assert.rejects(access.execute(request('invalid-00'+n,'conversation.create',{...input,...extra}),async()=>{throw Error('must reject before approval');}));
  }
  const changed=request('changed-001','conversation.create',input);
  await assert.rejects(access.execute(changed,async()=>{await api('/api/projects',{action:'rename',id:project.id,name:'Changed'});return true;}),/Project changed/);
  assert.equal((await api('/sessions')).length,2);
  const solo=await access.execute(request('solo-001','conversation.create',{...input,projectId:null,cwd:e.dir,proxyEnabled:null}),approve);assert.equal(solo.status,'completed');
  assert.equal((await api('/sessions')).find(s=>s.instanceId===solo.results[0].instanceId).projectId,null);
  assert.equal(approvals,3);
  let preview;const pendingPreview=new Promise(resolve=>bridge.once('event',e=>{preview=e.payload;resolve();}));
  const approvedThroughHttp=access.execute(request('http-approval-01','conversation.create',{...input,projectId:null,cwd:e.dir}),
    (p,signal)=>bridge.approvals.request(p,signal));
  await pendingPreview;
  assert.equal((await api('/sessions')).length,3,'pending approval creates nothing');
  let response=await fetch(base+'/api/permission/decide',{method:'POST',headers,body:JSON.stringify({sessionId:id,requestId:preview.requestId,outcome:'approved'})});
  assert.equal(response.status,409,'another conversation cannot approve this request');
  await api('/api/permission/decide',{sessionId:from.instanceId,requestId:preview.requestId,outcome:'approved',sessionWide:true});
  assert.equal((await approvedThroughHttp).status,'completed');
  response=await fetch(base+'/api/permission/decide',{method:'POST',headers,body:JSON.stringify({sessionId:from.instanceId,requestId:preview.requestId,outcome:'approved'})});assert.equal(response.status,409);
  // Stop while the final asynchronous model check is in flight, after approval.
  const beforeCancel=(await api('/sessions')).length,controller=new AbortController();
  let releaseCheck,enteredCheck,checks=0;
  const blockedCheck=new Promise(r=>releaseCheck=r),checkStarted=new Promise(r=>enteredCheck=r);
  const cancelPlan=request('cancel-in-setup-01','conversation.create',{...input,projectId:null,cwd:e.dir});
  const cancelling=access.execute(cancelPlan,async()=>{
   bridge.onGetModels=async()=>{if(++checks===3){enteredCheck();await blockedCheck;}};return true;
  },controller.signal);
  await checkStarted;controller.abort();releaseCheck();
  const cancelled=await cancelling;bridge.onGetModels=null;
  assert.equal(cancelled.status,'failed','cancel during execution must not report completed');
  assert.match(cancelled.error,/abort/i);
  assert.equal((await api('/sessions')).length,beforeCancel,'no conversation created after cancellation');
  const cancelledAgain=await access.execute(cancelPlan,async()=>{throw Error('cancelled execution must not replay');});
  assert.equal(cancelledAgain.status,'failed');
  // A cancellation after creation preserves the ID but never starts later members.
  const duringModel=new AbortController(),beforePartial=instances.length;
  modelHook=()=>duringModel.abort();
  const partialPlan={idempotencyKey:'cancel-batch-01',operations:[
   {type:'conversation.create',input},{type:'conversation.create',input:{...input,title:'Second member'}}]};
  const partial=await access.execute(partialPlan,async()=>true,duringModel.signal);modelHook=null;
  assert.equal(partial.status,'failed');assert.equal(instances.length,beforePartial+1);
  const partialBridge=instances.at(-1),partialId=partialBridge.opts.sessionId;
  assert(partial.error.includes(partialId),'report the resource already created');
  assert.equal(partialBridge.level,'off','do not apply further settings after cancellation');
  assert.equal((await api('/sessions')).find(s=>s.instanceId===partialId).projectId,null);
  assert.equal((await access.execute(partialPlan,async()=>{throw Error('must not retry partial creation');})).status,'failed');
  assert.equal(instances.length,beforePartial+1);
  // Failed persistence must not obscure that a conversation already exists.
  const failedSavePlan=request('save-failure-01','conversation.create',{...input,projectId:null,cwd:e.dir});
  modelHook=()=>{failMetadata=true;};
  let saveFailure;
  try {saveFailure=await access.execute(failedSavePlan,async()=>true);}
  finally {failMetadata=false;modelHook=null;}
  const savedId=instances.at(-1).opts.sessionId;
  assert.equal(saveFailure.status,'failed');
  assert(saveFailure.error.includes(savedId),'metadata failure must preserve created conversation ID');
  assert.match(saveFailure.error,/metadata write failed/);
  assert((await api('/sessions')).some(s=>s.instanceId===savedId));
  const afterSaveFailure=instances.length;
  assert.equal((await access.execute(failedSavePlan,async()=>{throw Error('must use failed receipt');})).error,saveFailure.error);
  assert.equal(instances.length,afterSaveFailure);
  // Existing conversation operations: explicit approval, exact before/after values,
  // capability discovery, stale plans, busy targets, persistence and lifecycle.
  const catalog=await access.catalog();
  for(const type of ['update','detach','archive','delete']) assert(catalog.operations.includes('conversation.'+type));
  assert(catalog.conversations.some(s=>s.id===id && s.projectId===project.id));
  const oldTitle=(await api('/sessions')).find(s=>s.instanceId===id).title;
  const updatePlan=request('update-member-001','conversation.update',{id,title:'Final reviewer',thinking:'high',proxyEnabled:true});
  assert.equal((await access.execute(updatePlan,async()=>false)).status,'denied');
  assert.equal((await api('/sessions')).find(s=>s.instanceId===id).title,oldTitle);
  const updated=await access.execute(updatePlan,async preview=>{
   assert.match(preview.items[0].title,/Update conversation/);
   assert(preview.items[0].fields.some(f=>f.value===oldTitle+' → Final reviewer'));
   assert(preview.items[0].fields.some(f=>f.value==='max → high'));
   return true;
  });
  assert.equal(updated.status,'completed',updated.error);
  assert.equal((await api('/sessions')).find(s=>s.instanceId===id).thinkingLevel,'high');
  assert.equal((await api('/api/settings/network')).sessions[id],true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.dir,'hub-sessions',id+'.meta.json'))).title,'Final reviewer');
  assert.equal((await access.execute(updatePlan,async()=>{throw Error('do not reapprove');})).status,'completed');
  for (const [n,extra] of [{thinking:'ultra'},{model:'invented',provider:'deepseek'},{model:'deepseek-v4-flash'},{proxyEnabled:'yes'},{cwd:e.dir},{instructions:'changed'},{}].entries()) {
   await assert.rejects(access.execute(request('bad-update-'+n,'conversation.update',{id,...extra}),async()=>{throw Error('invalid update reached approval');}));
  }
  const switched=await access.execute(request('update-model-01','conversation.update',{id,model:'fixture-model',provider:'fixture-provider',thinking:'high'}),async()=>true);
  assert.equal(switched.status,'completed',switched.error);
  assert.equal(instances[1].model,'fixture-model');assert.equal(instances[1].provider,'fixture-provider');assert.equal(instances[1].level,'high');
  await assert.rejects(access.execute(request('invalid-target-level-01','conversation.update',{id,thinking:'max'}),async()=>{throw Error('target thinking must be validated');}),/Unsupported thinking/);
  const reset=await access.execute(request('update-reset-01','conversation.update',{id,model:'deepseek-v4-flash',provider:'deepseek',proxyEnabled:null}),async()=>true);
  assert.equal(reset.status,'completed',reset.error);assert.equal(instances[1].level,'default');
  assert.equal((await api('/api/settings/network')).sessions[id],undefined);
  assert.equal((await api('/sessions')).find(s=>s.instanceId===id).title,'Final reviewer','unspecified fields retained');
  const setLevel=instances[1].setThinking;
  instances[1].setThinking=()=>{};
  const ignoredThinking=await access.execute(request('ignored-thinking-01','conversation.update',{id,thinking:'max',title:'Must not save'}),async()=>true);
  instances[1].setThinking=setLevel;
  assert.equal(ignoredThinking.status,'failed');assert.match(ignoredThinking.error,/Thinking selection was not applied/);
  assert.equal((await api('/sessions')).find(s=>s.instanceId===id).title,'Final reviewer');
  await assert.rejects(access.execute(request('stale-membership-01','conversation.detach',{id}),async()=>{
   await api('/api/projects',{action:'members',id:project.id,remove:[id]});return true;
  }),/Conversation changed/);
  await api('/api/projects',{action:'members',id:project.id,add:[id]});
  await assert.rejects(access.execute(request('stale-update-01','conversation.update',{id,title:'Wrong stale title'}),async()=>{
   await api('/'+id+'/title',{title:'User edit'});return true;
  }),/Conversation changed/);
  assert.equal((await api('/sessions')).find(s=>s.instanceId===id).title,'User edit');
  instances[1].isProcessing=()=>true;
  await assert.rejects(access.execute(request('busy-delete-01','conversation.delete',{id}),async()=>{throw Error('busy target must not reach approval');}),/busy/);
  instances[1].isProcessing=()=>false;
  await assert.rejects(access.execute(request('busy-after-01','conversation.archive',{id}),async()=>{instances[1].isProcessing=()=>true;return true;}),/busy/);
  instances[1].isProcessing=()=>false;
  for (const type of ['archive','delete']) await assert.rejects(access.execute(request('self-'+type+'-01','conversation.'+type,{id:from.instanceId}),async()=>true),/requesting conversation/);
  await assert.rejects(access.execute({idempotencyKey:'duplicate-target-01',operations:[{type:'conversation.update',input:{id,title:'One'}},{type:'conversation.delete',input:{id}}]},async()=>{throw Error('duplicate target must not reach approval');}),/one operation/);
  // Hold the actual model mutation in flight; HTTP mutations and another host plan cannot race it.
  let unblockModel,modelEntered;
  const waitModel=new Promise(r=>unblockModel=r),enteredModel=new Promise(r=>modelEntered=r);
  modelHook=async()=>{modelEntered();await waitModel;};
  const changingModel=access.execute(request('blocking-update-01','conversation.update',{id,model:'deepseek-v4-flash',provider:'deepseek',thinking:'low'}),async()=>true);
  await enteredModel;
  try {
   for (const [url,body,method='POST'] of [
    ['/'+id+'/title',{title:'Racing edit'}],['/'+id+'/thinking',{level:'max'}],
    ['/'+id+'/submit',{query:'must not start'}],['/api/sessions/archive',{id}],
    ['/'+id+'/',null,'DELETE'],['/api/settings/network',{session:id,enabled:false},'PUT']]) {
    const r=await fetch(base+url,{headers,method,body:body?JSON.stringify(body):undefined});
    assert(r.status>=400,'concurrent mutation must be blocked: '+url);
   }
   await assert.rejects(access.execute(request('concurrent-detach-01','conversation.detach',{id}),async()=>true),/operation in progress/);
  } finally {unblockModel();modelHook=null;}
  assert.equal((await changingModel).status,'completed');assert.equal(instances[1].level,'low');
  const detachPlan=request('detach-001','conversation.detach',{id});
  assert.equal((await access.execute(detachPlan,async()=>false)).status,'denied');
  assert.equal((await access.execute(detachPlan,async preview=>{assert(preview.items[0].fields.some(f=>/Keep history/.test(f.value)));return true;})).status,'completed');
  const detached=(await api('/sessions')).find(s=>s.instanceId===id);assert.equal(detached.projectId,null);assert.equal(detached.cwd,e.dir);
  assert(fs.existsSync(path.join(e.dir,'hub-sessions',id+'.meta.json')));
  assert.equal((await access.execute(detachPlan,async()=>{throw Error('detach must be idempotent');})).status,'completed');
  await assert.rejects(access.execute(request('detach-solo-01','conversation.detach',{id}),async()=>true),/not in a project/);
  let memberSeq=0;
  const newMember=async()=>{
   const r=await access.execute(request('lifecycle-member-'+(++memberSeq),'conversation.create',input),async()=>true);assert.equal(r.status,'completed',r.error);return r.results[0].instanceId;
  };
  const archiveId=await newMember(),archivePlan=request('archive-001','conversation.archive',{id:archiveId});
  assert.equal((await access.execute(archivePlan,async()=>false)).status,'denied');
  assert((await api('/sessions')).some(s=>s.instanceId===archiveId));
  // A failed archive must preserve project membership and not delete the history.
  failMetadata=true;
  const archiveFailure=await access.execute(request('archive-failure-01','conversation.archive',{id:archiveId}),async()=>true);
  failMetadata=false;assert.equal(archiveFailure.status,'failed');assert(archiveFailure.error.includes(archiveId));
  assert((await api('/api/projects')).find(p=>p.id===project.id).sessionIds.includes(archiveId));
  assert.equal((await access.execute(archivePlan,async()=>true)).status,'completed');
  assert(!(await api('/sessions')).some(s=>s.instanceId===archiveId));
  assert((await api('/api/sessions/archived')).some(s=>s.id===archiveId));
  assert(!(await api('/api/projects')).find(p=>p.id===project.id).sessionIds.includes(archiveId));
  assert(fs.existsSync(path.join(e.dir,'hub-sessions',archiveId+'.meta.json')));
  await api('/api/sessions/unarchive',{id:archiveId});
  assert.equal((await api('/sessions')).find(s=>s.instanceId===archiveId).projectId,null,'archive restores as independent conversation');
  const initializedBeforeCatalog=instances.length;
  const lazyCatalog=(await access.catalog()).conversations.find(s=>s.id===archiveId);
  assert.equal(lazyCatalog.thinking,'max','catalog must report the saved thinking level before lazy bridge initialization');
  assert.equal(lazyCatalog.thinking,(await api('/sessions')).find(s=>s.instanceId===archiveId).thinkingLevel,'plugin and UI must agree');
  assert.equal(instances.length,initializedBeforeCatalog,'catalog reads must not initialize restored kernels');
  const lazyRename=await access.execute(request('rename-lazy-01','conversation.update',{id:archiveId,title:'Restored reviewer'}),async()=>true);
  assert.equal(lazyRename.status,'completed',lazyRename.error);
  assert.equal(lazyRename.results[0].conversation.thinking,'max','unrelated edits retain saved reasoning configuration');
  assert.equal(instances.length,initializedBeforeCatalog,'title edits do not initialize restored kernels');
  assert.equal((await access.execute(archivePlan,async()=>{throw Error('restored target must not be archived again by replay');})).status,'completed');
  assert((await api('/sessions')).some(s=>s.instanceId===archiveId));
  assert((await access.catalog()).conversations.some(s=>s.id===archiveId),'catalog includes lazy restored conversations');
  assert.equal((await access.execute(request('archive-lazy-01','conversation.archive',{id:archiveId}),async()=>true)).status,'completed');
  assert(fs.existsSync(path.join(e.dir,'hub-sessions',archiveId+'.meta.json')),'lazy archive preserves history');
  const deleteId=await newMember(),deletePlan=request('delete-001','conversation.delete',{id:deleteId});
  fs.writeFileSync(path.join(e.dir,'workspace.txt'),'keep');
  const upload=path.join(e.dir,'hub-sessions','uploads',deleteId+'_fixture.txt');fs.mkdirSync(path.dirname(upload),{recursive:true});fs.writeFileSync(upload,'remove');
  assert.equal((await access.execute(deletePlan,async()=>false)).status,'denied');assert(fs.existsSync(upload));
  assert.equal((await access.execute(deletePlan,async preview=>{assert(preview.items[0].fields.some(f=>/permanently/.test(f.value)));return true;})).status,'completed');
  assert(!(await api('/sessions')).some(s=>s.instanceId===deleteId));
  assert(!fs.existsSync(upload));assert(!fs.existsSync(path.join(e.dir,'hub-sessions',deleteId+'.meta.json')));assert(fs.existsSync(path.join(e.dir,'workspace.txt')));
  assert(!(await api('/api/projects')).find(p=>p.id===project.id).sessionIds.includes(deleteId));
  assert.equal((await access.execute(deletePlan,async()=>{throw Error('deleted target must use receipt');})).status,'completed');
  // Cancellation after partial configuration must report failure, retain the target and not change later fields.
  const cancelUpdate=new AbortController();modelHook=()=>cancelUpdate.abort();
  const partialUpdate=await access.execute(request('partial-update-01','conversation.update',{id,title:'Must not apply',model:'deepseek-v4-flash',provider:'deepseek',thinking:'max'}),async()=>true,cancelUpdate.signal);modelHook=null;
  assert.equal(partialUpdate.status,'failed');assert(partialUpdate.error.includes(id));
  assert.equal((await api('/sessions')).find(s=>s.instanceId===id).title,'User edit');
  assert.equal(instances[1].level,'low');
  // A command, durable title commit, or deletion can be pending even when
  // no model turn is running. Such targets must never receive a new host plan.
  const pendingId=await newMember();
  const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
  const assertPending=async(key)=>{
   for(const type of ['update','detach','archive','delete']) {
    await assert.rejects(access.execute(request(key+'-'+type,'conversation.'+type,{id:pendingId,...(type==='update'?{title:'Must not apply'}:{})}),async()=>{throw Error('pending mutation must not reach approval');}),/busy|unavailable/i);
   }
   assert.equal((await access.catalog()).conversations.find(c=>c.id===pendingId)?.busy,true,'pending mutations must be visible as busy');
  };
  let entered=deferred(),release=deferred();
  beforeModelHook=async b=>{if(b.opts.sessionId===pendingId){entered.resolve();await release.promise;}};
  const command=api('/'+pendingId+'/command',{name:'/model',args:'fixture-model@fixture-provider'});
  await entered.promise;
  try {await assertPending('pending-command');}
  finally {release.resolve();await command;beforeModelHook=null;}
  assert.equal((await access.catalog()).conversations.find(c=>c.id===pendingId).busy,false);
  // A target can also become busy while its approval card is open.
  entered=deferred();release=deferred();
  beforeModelHook=async b=>{if(b.opts.sessionId===pendingId){entered.resolve();await release.promise;}};
  let laterCommand;
  try {
   await assert.rejects(access.execute(request('busy-while-approval','conversation.update',{id:pendingId,title:'Stale approved title'}),async()=>{
    laterCommand=api('/'+pendingId+'/command',{name:'/model',args:'deepseek-v4-flash@deepseek'});
    await entered.promise;return true;
   }),/busy/);
  } finally {release.resolve();await laterCommand;beforeModelHook=null;}
  assert.notEqual((await api('/sessions')).find(s=>s.instanceId===pendingId).title,'Stale approved title');
  beforeModelHook=()=>{throw Error('fixture command failed');};
  const failedCommand=await fetch(base+'/'+pendingId+'/command',{method:'POST',headers,body:JSON.stringify({name:'/model',args:'deepseek-v4-flash@deepseek'})});beforeModelHook=null;
  assert.equal(failedCommand.status,500);
  assert.equal((await access.catalog()).conversations.find(c=>c.id===pendingId).busy,false,'failed command releases busy state');
  entered=deferred();release=deferred();
  writeHook=async file=>{if(file.endsWith('/'+pendingId+'.meta.json.tmp')){entered.resolve();await release.promise;}};
  const titleCommit=api('/'+pendingId+'/title',{title:'Pending user title'});
  await entered.promise;
  try {await assertPending('pending-title');}
  finally {release.resolve();await titleCommit;writeHook=null;}
  assert.equal((await access.catalog()).conversations.find(c=>c.id===pendingId).busy,false);
  const stillUsable=await access.execute(request('after-pending-title','conversation.update',{id:pendingId,proxyEnabled:false}),async()=>true);
  assert.equal(stillUsable.status,'completed',stillUsable.error);
  entered=deferred();release=deferred();
  writeHook=async file=>{if(file.endsWith('/'+pendingId+'.deleted')){entered.resolve();await release.promise;}};
  const deleting=fetch(base+'/'+pendingId+'/',{method:'DELETE',headers});
  await entered.promise;
  try {await assertPending('pending-delete');}
  finally {release.resolve();assert.equal((await deleting).status,200);writeHook=null;}
  assert(!(await access.catalog()).conversations.some(c=>c.id===pendingId));
  console.log('PASS pending HTTP mutations: commands, title commits and deletion intent block host operations; busy status clears on success/failure');
  console.log('PASS existing conversation operations: approval, stale/busy guards, model/thinking/VPN, concurrent mutations, detach, archive/restore, deletion and cancellation');
  console.log('PASS host operation integration: authorization, project root, model, reasoning, VPN, persistent instructions, independent creation and idempotency');
 } finally {await hub.shutdown();fs.rmSync(e.dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
