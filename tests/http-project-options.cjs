const {env,Bridge,path,root,fs}=require('./harness.cjs');
const assert=require('node:assert/strict');const {once}=require('node:events');
(async()=>{
 const e=env();e.context.process.env.ASHUB_TOKEN='options-test';
 class Fixture extends Bridge{
  constructor(o){super(o);this.model='deepseek-v4-flash';this.provider='deepseek';this.level='off';}
  info(){this.emit('event',{name:'agent:info',payload:{model:this.model,provider:this.provider,thinkingLevel:this.level}});}
  async ready(){this.info();}
  execCommand(name,target){assert.equal(name,'/model');[this.model,this.provider]=target.split('@');this.info();}
  getThinking(){return{model:this.model,provider:this.provider,supported:true,level:this.level,levels:['off','low','high','max']};}
  setThinking(level){this.level=level;this.info();}
  getRestoreState(){return{thinkingSelections:[[JSON.stringify([this.provider,this.model]),this.level]]};}
  async getModels(){return{models:[{model:this.model,provider:this.provider,thinkingLevels:['off','low','high','max']},{model:'gpt-5',provider:'openai',thinkingLevels:[]}],active:null};}
 }
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new Fixture(o)});await once(hub.server,'listening');
 const headers={Authorization:'Bearer options-test','Content-Type':'application/json'},base=`http://127.0.0.1:${hub.server.address().port}`;
 const call=(url,body)=>fetch(base+url,{headers,method:body?'POST':'GET',body:body?JSON.stringify(body):undefined});
 const api=async(...args)=>{const r=await call(...args);assert(r.ok,await r.clone().text());return r.json();};
 try{
  const project=(await api('/api/projects',{action:'create',cwd:e.dir,name:'Test'}))[0];
  const body={projectId:project.id,title:'Review literature',model:'deepseek-v4-flash',provider:'deepseek',thinking:'max',proxyEnabled:false};
  const created=await api('/api/projects/session',body);
  const session=(await api('/sessions')).find(s=>s.instanceId===created.instanceId);
  assert.equal(session.title,body.title);assert.equal(session.model,body.model);assert.equal(session.provider,body.provider);assert.equal(session.thinkingLevel,'max');assert.equal(session.projectId,project.id);
  assert.equal((await api('/api/settings/network')).sessions[created.instanceId],false);
  const catalog=await api('/api/models');assert.deepEqual(catalog.providers.find(p=>p.name==='openai').models[0].thinkingLevels,[],'explicit no-reasoning capability must win over family inference');
  assert.deepEqual(catalog.providers.find(p=>p.name==='deepseek').models[0].thinkingLevels,['off','low','high','max']);
  const other=await api('/api/projects/session',{...body,thinking:'default'});assert.equal((await api(`/${other.instanceId}/thinking`)).level,'default');
  for(const extra of [{thinking:'ultra'},{thinking:'high',model:undefined},{title:'x'.repeat(101)},{proxyEnabled:'false'},{model:'bad@injection'}]){const r=await call('/api/projects/session',{...body,...extra});assert.equal(r.status,400);}
  assert.equal((await api('/sessions')).length,2,'invalid options must not create sessions');
  console.log('PASS project creation options, metadata, native reasoning capabilities and validation');
 }finally{await hub.shutdown();fs.rmSync(e.dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
