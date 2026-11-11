const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const path=require('node:path');
const {setup,delay}=require('./project-continuation-fixture.cjs');
test('installed project plugin: explicit consent -> worker receipt -> single idle wake -> stop', {timeout:35000},async()=>{
 const f=await setup();let db;
 try{
  const owner=(await f.api('/sessions',{cwd:f.e.dir,kind:'agent'})).value.instanceId;
  const member=(await f.api('/sessions',{cwd:f.e.dir,kind:'agent'})).value.instanceId;
  const created=await f.api('/api/projects',{action:'create',name:'Synthetic project',cwd:f.e.dir,add:[owner,member]});assert.equal(created.status,200,JSON.stringify(created));const project=created.value[0].id;
  const task=f.collaboration.create(owner,member,'Synthetic task','task');f.collaboration.start(task.id);
  db=new DatabaseSync(path.join(f.e.dir,'hub-sessions','plugin-data',encodeURIComponent(f.feature.pluginId),'work.sqlite'));
  const plan={spec:{goal:'Synthetic scope'},goal:'Synthetic scope',steps:[{id:'one',member,dependsOn:[],attempts:[{id:'attempt',taskId:task.id}]}]};
  db.prepare('INSERT INTO work VALUES(?,?,?,?)').run(project,owner,'workflow',JSON.stringify(plan));
  const view=(await f.api(f.resource)).value.view;assert.equal(view.rows[0].status,'自动接续未开启');assert.equal(f.instances[0].messages.length,0);
  const act=view.rows[0].actions[0],pending=await f.api(f.resource,{action:act.id,values:act.values});assert.equal(pending.status,200,JSON.stringify(pending));assert(pending.value.confirmation);
  assert.equal((await f.api(f.resource)).value.view.rows[0].status,'自动接续未开启');
  // A stop must invalidate a preview even before the first grant exists.
  assert.equal((await f.api('/'+owner+'/cancel',{})).status,200);
  assert.equal((await f.api(f.resource,{confirm:pending.value.confirmation.id})).status,409);
  const fresh=await f.api(f.resource,{action:act.id,values:act.values});
  const confirm=await f.api(f.resource,{confirm:fresh.value.confirmation.id});assert.equal(confirm.status,200,JSON.stringify(confirm));
  assert.equal((await f.api('/api/projects')).value[0].activities[0].state,'waiting');
  f.collaboration.finish(task.id,'completed');
  for(let i=0;i<90&&!f.instances[0].messages.length;i++)await delay(200);
  assert.equal(f.instances[0].messages.length,1);assert.match(f.instances[0].messages[0].content,/project_work_status/);
  await f.api(f.resource);await delay(1200);assert.equal(f.instances[0].messages.length,1);
  assert.equal((await f.api('/api/projects')).value[0].activities[0].state,'running');
  assert.equal((await f.api('/'+owner+'/cancel',{})).status,200);f.instances[0].finish?.();
  const stopped=await f.api(f.resource);assert.equal(stopped.value.view.rows[0].status,'已暂停');
  const groups=(await f.api('/api/projects')).value;assert.equal(groups[0].activities[0].state,'paused');
  await f.api('/api/extensions/'+f.feature.id+'/enabled',{enabled:false});assert.equal((await f.api('/api/projects')).value[0].activities,undefined);
 }finally{f.instances.forEach(b=>b.finish?.());db?.close();await f.hub.shutdown();}
});
