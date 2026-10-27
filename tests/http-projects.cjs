const {env,Bridge,path,root,fs}=require('./harness.cjs');
const assert=require('node:assert/strict');
const {once}=require('node:events');
(async()=>{
 const e=env(); e.context.process.env.ASHUB_TOKEN='project-test';
 const bridges=[];
 const opts={host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{const b=new Bridge(o);bridges.push(b);return b;}};
 let hub=e.hub().startHub(opts); await once(hub.server,'listening');
 let base=`http://127.0.0.1:${hub.server.address().port}`;
 const headers={Authorization:'Bearer project-test','Content-Type':'application/json'};
 const api=async(url,body,method=body?'POST':'GET')=>{
  const res=await fetch(base+url,{method,headers,body:body?JSON.stringify(body):undefined});
  const text=await res.text(); assert(res.ok,`${url}: ${res.status} ${text}`);return text?JSON.parse(text):null;
 };
 try {
  assert.equal((await fetch(base+'/api/projects')).status,401);
  assert.equal((await fetch(base+'/api/projects',{method:'POST',headers:{...headers,Origin:'https://foreign.invalid'},body:'{}'})).status,403);
  for(const cwd of [undefined,'relative',path.join(e.dir,'missing')]) {
    const bad=await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify({action:'create',name:'Invalid',cwd})});assert.equal(bad.status,400);
  }
  assert.equal((await api('/api/projects')).length,0);
  const a=await api('/sessions',{cwd:e.dir}), b=await api('/sessions',{cwd:e.dir});
  assert.equal(bridges[0].opts.sessionId,a.instanceId);
  assert.equal(bridges[1].opts.sessionId,b.instanceId);
  const p=(await api('/api/projects',{action:'create',cwd:e.dir,name:'Shared',add:[a.instanceId,b.instanceId]}))[0];
  assert.equal((await fetch(base+'/api/projects/session',{method:'POST',headers:{...headers,Origin:'https://foreign.invalid'},body:'{}'})).status,403);
  const direct=await api('/api/projects/session',{projectId:p.id,isolated:false});
  assert.equal(p.cwd,e.dir);
  assert.equal(direct.cwd,e.dir);assert((await api('/api/projects'))[0].sessionIds.includes(direct.instanceId));
  assert.equal((await api('/sessions')).find(s=>s.instanceId===direct.instanceId).projectId,p.id);
  assert.equal((await api('/sessions')).find(s=>s.instanceId===a.instanceId).projectId,p.id);
  await api('/api/projects',{action:'members',id:p.id,remove:[a.instanceId]});
  assert.equal((await api('/sessions')).find(s=>s.instanceId===a.instanceId).projectId,null);
  await api('/api/projects',{action:'members',id:p.id,add:[a.instanceId]});
  await api('/'+direct.instanceId+'/',null,'DELETE');
  const empty=(await api('/api/projects',{action:'create',cwd:e.dir,name:'Empty'})).find(p=>p.name==='Empty');
  const first=await api('/api/projects/session',{projectId:empty.id});
  assert((await api('/api/projects')).find(p=>p.id===empty.id).sessionIds.includes(first.instanceId));
  await api('/'+first.instanceId+'/',null,'DELETE');await api('/api/projects',{action:'delete',id:empty.id});
  const projectFile=path.join(e.dir,'hub-sessions','projects.json');
  const savedGroups=JSON.parse(fs.readFileSync(projectFile,'utf8'));
  fs.writeFileSync(projectFile,JSON.stringify([...savedGroups,{id:'legacy',name:'Legacy',sessionIds:[]}]));
  const unconfigured=await fetch(base+'/api/projects/session',{method:'POST',headers,body:JSON.stringify({projectId:'legacy',cwd:e.dir})});
  assert.equal(unconfigured.status,400,'legacy group requires explicit root configuration');
  await api('/api/projects',{action:'edit',id:'legacy',name:'Legacy',cwd:e.dir});
  const legacyChat=await api('/api/projects/session',{projectId:'legacy'});assert.equal(legacyChat.cwd,e.dir);
  await api('/'+legacyChat.instanceId+'/',null,'DELETE');await api('/api/projects',{action:'delete',id:'legacy'});
  const count=(await api('/sessions')).length;
  for(const body of [null,{projectId:p.id,cwd:e.dir,isolated:'yes'},{projectId:'missing',cwd:e.dir},{projectId:p.id,cwd:'relative'},{projectId:p.id,cwd:path.join(e.dir,'missing')},{projectId:p.id,cwd:e.dir,isolated:true}]) {
    const bad=await fetch(base+'/api/projects/session',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(bad.status,400);
  }
  assert.equal((await api('/sessions')).length,count,'validation must not create orphan sessions');
  // A membership write can fail after session creation. The UI needs its ID
  // to open that retained session instead of submitting a duplicate create.
  const projectProto=e.load('src/projects.ts').ProjectStore.prototype, originalUpdate=projectProto.update;
  let partial;
  try {
    projectProto.update=function(input,...args){if(input.action==='members'&&input.id===p.id)throw Error('fixture membership write failed');return originalUpdate.call(this,input,...args);};
    const response=await fetch(base+'/api/projects/session',{method:'POST',headers,body:JSON.stringify({projectId:p.id,cwd:e.dir})});
    assert.equal(response.status,400);partial=await response.json();
  } finally {projectProto.update=originalUpdate;}
  assert.match(partial.instanceId,/^[0-9a-f]{4,32}$/i);
  assert((await api('/sessions')).some(s=>s.instanceId===partial.instanceId));
  assert(!(await api('/api/projects'))[0].sessionIds.includes(partial.instanceId));
  await api('/'+partial.instanceId+'/',null,'DELETE');
  const foreignDir=path.join(e.dir,'other-folder');fs.mkdirSync(foreignDir);
  const foreign=await api('/sessions',{cwd:foreignDir});
  await api('/api/projects',{action:'members',id:p.id,add:[foreign.instanceId]});
  let directoryList=await api('/sessions');
  assert.equal(directoryList.find(s=>s.instanceId===foreign.instanceId).cwd,foreignDir,'adding an external conversation must not change its working directory');
  assert.equal((await api('/api/projects'))[0].cwd,e.dir);
  assert.equal(directoryList.find(s=>s.instanceId===foreign.instanceId).projectExternal,true);
  const override=await fetch(base+'/api/projects/session',{method:'POST',headers,body:JSON.stringify({projectId:p.id,cwd:foreignDir})});assert.equal(override.status,400,'new conversations cannot override the project root');
  // An editor opened before another window changes the root must neither
  // reset that root on rename nor create a conversation using stale UI state.
  const beforeRootChange=(await api('/sessions')).length;
  await api('/api/projects',{action:'edit',id:p.id,name:p.name,cwd:foreignDir});
  await api('/api/projects',{action:'edit',id:p.id,name:'Renamed'});
  assert.equal((await api('/api/projects'))[0].cwd,foreignDir);
  const stale=await fetch(base+'/api/projects/session',{method:'POST',headers,body:JSON.stringify({projectId:p.id,cwd:e.dir})});
  assert.equal(stale.status,400);
  assert.equal((await api('/sessions')).length,beforeRootChange,'a stale root must not create an orphan session');
  assert.equal((await api('/sessions')).find(s=>s.instanceId===a.instanceId).cwd,e.dir,'changing a project root must not move existing conversations');
  const fresh=await api('/api/projects/session',{projectId:p.id,cwd:foreignDir});assert.equal(fresh.cwd,foreignDir);
  await api('/'+fresh.instanceId+'/',null,'DELETE');
  await api('/api/projects',{action:'edit',id:p.id,name:p.name,cwd:e.dir});
  // Removing all members must not remove or redefine the configured root.
  const liveIds=new Set((await api('/sessions')).map(s=>s.instanceId));
  const originalMembers=(await api('/api/projects'))[0].sessionIds.filter(id=>liveIds.has(id));
  await api('/api/projects',{action:'members',id:p.id,remove:originalMembers});
  const fromRoot=await api('/api/projects/session',{projectId:p.id});assert.equal(fromRoot.cwd,e.dir);
  await api('/'+fromRoot.instanceId+'/',null,'DELETE');
  await api('/api/projects',{action:'members',id:p.id,add:originalMembers});
  assert.equal(directoryList.find(s=>s.instanceId===a.instanceId).projectExternal,false);
  await api('/'+foreign.instanceId+'/title',{title:'Recently modified'});
  assert.equal((await api('/sessions')).find(s=>s.instanceId===a.instanceId).projectExternal,false,'activity order must not change project directory');
  await api('/api/sessions/archive',{id:foreign.instanceId});
  await api('/api/projects',{action:'members',id:p.id,remove:[foreign.instanceId]});
  assert((await api('/api/sessions/archived')).some(s=>s.id===foreign.instanceId));
  await api('/api/sessions/unarchive',{id:foreign.instanceId});
  const restoredForeign=(await api('/sessions')).find(s=>s.instanceId===foreign.instanceId);
  assert.equal(restoredForeign.projectId,null);assert.equal(restoredForeign.projectExternal,false);
  await api('/'+foreign.instanceId+'/',null,'DELETE');
  const access=bridges[0].opts.conversationAccess;
  assert.equal(access.list().conversations.length,2);
  await api('/api/sessions/archive',{id:b.instanceId});
  assert.equal(access.list().conversations.length,1);
  assert((await api('/api/projects'))[0].sessionIds.includes(b.instanceId));
  await api('/api/sessions/unarchive',{id:b.instanceId});
  assert.equal(access.list().conversations.length,2);
  await hub.shutdown();
  hub=e.hub().startHub(opts); await once(hub.server,'listening');base=`http://127.0.0.1:${hub.server.address().port}`;
  await new Promise(r=>setTimeout(r,100));
  assert.equal((await api('/api/projects'))[0].id,p.id);assert.equal((await api('/api/projects'))[0].cwd,e.dir);
  await api(`/${a.instanceId}/context`);
  const restored=bridges.at(-1).opts.conversationAccess;
  assert.equal(bridges.at(-1).opts.sessionId,a.instanceId,'lazy restore must keep the Hub session identity');
  assert.equal(restored.list().conversations.length,2);
  const receipt=await restored.send(b.instanceId,'Restored communication');
  await new Promise(r=>setImmediate(r));
  const taskBase='/api/projects/tasks?projectId='+p.id;
  assert.equal((await fetch(base+taskBase)).status,401);
  const tasks=await api(taskBase);assert(tasks.some(t=>t.id===receipt.taskId));
  assert(!tasks.some(t=>'query' in t || 'text' in t));
  assert.equal((await api(taskBase+'&taskId='+receipt.taskId)).state,'completed');
  assert.equal((await fetch(base+taskBase+'&taskId=unknown',{headers})).status,400);
  for (const offset of ['-1','NaN','1.5','999999']) {
    const invalid=await fetch(base+taskBase+'&taskId='+receipt.taskId+'&offset='+offset,{headers,signal:AbortSignal.timeout(2000)});
    assert.equal(invalid.status,400,'invalid result offset must not return success');
    assert.match(await invalid.text(),/offset/);
  }
  const download=await fetch(base+taskBase+'&taskId='+receipt.taskId+'&download=1',{headers});
  assert.equal(download.status,200);assert(download.headers.get('content-disposition').includes('attachment'));
  const git=require('node:child_process').execFileSync;
  const repo=path.join(e.dir,'repo');fs.mkdirSync(repo);
  fs.writeFileSync(path.join(e.dir,'empty.gitconfig'),'');
  const run=(...args)=>git('git',['-C',repo,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:path.join(e.dir,'empty.gitconfig'),GIT_CONFIG_NOSYSTEM:'1'}});
  run('init','-q');run('config','user.name','Test');run('config','user.email','test@example.invalid');
  fs.writeFileSync(path.join(repo,'file.txt'),'base');run('add','.');run('commit','-qm','Initial');
  fs.writeFileSync(path.join(repo,'file.txt'),'local edits');
  const gitChat=await api('/sessions',{cwd:repo});
  await api('/api/projects',{action:'members',id:p.id,add:[gitChat.instanceId]});
  assert.equal((await fetch(base+'/api/projects/worktree',{method:'POST',headers:{...headers,Origin:'https://foreign.invalid'},body:'{}'})).status,403);
  const legacy=await api('/api/projects/worktree',{projectId:p.id,sourceId:gitChat.instanceId});
  await api('/'+legacy.instanceId+'/',null,'DELETE');
  await api('/api/projects',{action:'edit',id:p.id,name:p.name,cwd:repo});
  const isolated=await api('/api/projects/session',{projectId:p.id,isolated:true});
  assert((await api('/api/projects'))[0].sessionIds.includes(isolated.instanceId));
  assert.equal(fs.readFileSync(path.join(isolated.cwd,'file.txt'),'utf8'),'base');
  assert.equal(fs.readFileSync(path.join(repo,'file.txt'),'utf8'),'local edits');
  const locations=await api('/api/projects/workspaces');assert.equal(locations[isolated.cwd].branch,isolated.branch);
  await api('/'+isolated.instanceId+'/',null,'DELETE');
  assert.equal(fs.readFileSync(path.join(isolated.cwd,'file.txt'),'utf8'),'base','closing chat must retain worktree');
  await api('/'+gitChat.instanceId+'/',null,'DELETE');
  const ctx=await api(`/${b.instanceId}/context`);
  assert(JSON.stringify(ctx).includes('Restored communication'));
  await api('/api/projects',{action:'delete',id:p.id});
  assert.equal((await api('/sessions')).length,2);
  assert.equal((await api('/api/projects')).length,0);
  assert((await api('/sessions')).every(s=>s.projectId===null),'kept chats become independent');
  const x=await api('/sessions',{cwd:e.dir}), y=await api('/sessions',{cwd:e.dir});
  const doomed=(await api('/api/projects',{action:'create',cwd:e.dir,name:'Delete together',add:[x.instanceId,y.instanceId]}))[0];
  await api('/api/sessions/archive',{id:y.instanceId});
  const invalid=await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify({action:'delete',id:doomed.id,deleteConversations:'true'})});
  assert.equal(invalid.status,400);assert((await api('/sessions')).some(s=>s.instanceId===x.instanceId));
  // Pause deletion at its durable marker to exercise concurrent membership edits.
  const write=fs.promises.writeFile;let release,entered;
  const paused=new Promise(r=>entered=r);
  fs.promises.writeFile=async function(file,...args){if(String(file).endsWith(x.instanceId+'.deleted')){entered();await new Promise(r=>release=r);}return write.call(this,file,...args);};
  const deleting=api('/api/projects',{action:'delete',id:doomed.id,deleteConversations:true});
  try {
    await paused;
    const conflict=await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify({action:'members',id:doomed.id,remove:[x.instanceId]})});
    assert.equal(conflict.status,400,'membership cannot change during destructive deletion');
  } finally {release();fs.promises.writeFile=write;}
  const deletedResult=await deleting;assert.deepEqual(deletedResult.deletedSessionIds,[x.instanceId,y.instanceId]);
  assert(!(await api('/sessions')).some(s=>[x.instanceId,y.instanceId].includes(s.instanceId)));
  assert(!(await api('/api/sessions/archived')).some(s=>s.id===y.instanceId));
  assert.equal((await api('/sessions')).length,2,'unrelated chats survive');
  assert.equal(fs.readFileSync(path.join(repo,'file.txt'),'utf8'),'local edits');
  // Failed cleanup retains the group for an idempotent retry.
  const retryChat=await api('/sessions',{cwd:e.dir});
  const retryGroup=(await api('/api/projects',{action:'create',cwd:e.dir,name:'Retry',add:[retryChat.instanceId]}))[0];
  const unlink=fs.promises.unlink;
  fs.promises.unlink=async function(file){if(String(file).endsWith(retryChat.instanceId+'.meta.json'))throw Error('fixture cleanup failed');return unlink.call(this,file);};
  try {
    const failed=await fetch(base+'/api/projects',{method:'POST',headers,body:JSON.stringify({action:'delete',id:retryGroup.id,deleteConversations:true})});
    assert.equal(failed.status,400);assert((await api('/api/projects')).some(p=>p.id===retryGroup.id));
  } finally {fs.promises.unlink=unlink;}
  await api('/api/projects',{action:'delete',id:retryGroup.id,deleteConversations:true});
  assert.equal((await api('/api/projects')).length,0);
  console.log('PASS project HTTP authentication, origin guard, archive/unarchive, restart, lazy tool wiring and non-destructive deletion');
 } finally {await hub.shutdown();fs.rmSync(e.dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
