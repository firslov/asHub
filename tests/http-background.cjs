const test=require('node:test'),assert=require('node:assert/strict'),{once}=require('node:events');
const {env,Bridge,fs,path,root}=require('./harness.cjs');
test('real HTTP host authorizes once, automatically learns persisted history and revokes background access', {timeout:15000},async()=>{
 const modules={},e=env({modules,globals:{setTimeout,clearTimeout,setInterval,clearInterval,Date}});process.env.AGENT_SH_HOME=e.dir;
 modules['./extensions/installed.js']=await import('../dist/extensions/installed.js');
 const target=path.join(e.dir,'extensions','personal-assistant');fs.mkdirSync(path.dirname(target),{recursive:true});fs.cpSync(path.join(root,'examples/extensions/personal-assistant'),target,{recursive:true});
 let inference=0, bridge;
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:options=>{
  const b=bridge=new Bridge(options);b.backgroundComplete=async messages=>{inference++;const data=JSON.parse(messages[1].content),user=data.records.find(r=>r.role==='user');return JSON.stringify({memories:[{title:'汇报偏好',content:'汇报先给结论',kind:'preference',topic:'report-style',scope:'personal',certainty:'explicit',aliases:['presentation'],evidence:[{id:user.id,quote:user.text}]}]});};return b;
 }});
 if(!hub.server.listening)await once(hub.server,'listening');
 const base='http://127.0.0.1:'+hub.server.address().port;
 const api=async(route,body)=>{const response=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:base},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 try{
  const created=await api('/sessions',{cwd:e.dir,kind:'agent',title:'后台来源',provider:'mock',model:'tiny'});assert.equal(created.status,200,JSON.stringify(created));const id=created.body.instanceId;bridge.emit('event',{name:'agent:info',payload:{model:'tiny',provider:'mock'}});
  await api('/'+id+'/submit',{query:'以后写汇报时，请先给结论再列依据'});
  let feature;for(let i=0;i<150;i++){feature=(await api('/api/extensions')).body.features.find(f=>f.name==='个人助手');if(feature?.state==='active')break;await new Promise(r=>setTimeout(r,20));}assert.equal(feature?.state,'active');
  // Wait for the normal capture to persist the submitted user message.
  await new Promise(r=>setTimeout(r,50));
  const resource='/api/plugin-resources/'+encodeURIComponent(feature.pluginId)+'/assistant';
  const draft=await api(resource,{action:'learning-start',values:{modelSessionId:id,dailyCalls:'2',excludedIds:'',includeHistory:true}});
  assert.equal(draft.status,200,JSON.stringify(draft));assert(draft.body.confirmation);assert.equal(inference,0);
  assert(draft.body.confirmation.preview.fields.some(f=>f.label==='后台模型'));
  const result=await api(resource,{confirm:draft.body.confirmation.id});assert.equal(result.status,200,JSON.stringify(result));
  let memories;for(let i=0;i<150;i++){memories=await api(resource,{action:'memories',values:{}});if(memories.body.view?.rows.length)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(memories.body.view.rows[0]?.title,'汇报偏好',JSON.stringify(memories));assert.equal(inference,1);
  await api(resource,{confirm:draft.body.confirmation.id});assert.equal(inference,1,'duplicate confirmation never starts another inference');
  const pause=await api(resource,{action:'learning-pause',values:{}});assert(pause.body.confirmation);await api(resource,{confirm:pause.body.confirmation.id});
  assert.match((await api(resource)).body.view.note,/后台学习未开启/);
 }finally{await hub.shutdown();}
});
