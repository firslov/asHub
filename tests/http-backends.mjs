import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
const home=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-backend-host-'));
process.env.AGENT_SH_HOME=home;delete process.env.ASHUB_TOKEN;
const {startHub}=await import('../dist/hub.js');
const root=fileURLToPath(new URL('..',import.meta.url));
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));
test('real Hub binds only opted-in application plugins, preserves access guard and revokes registered backends on disable',async t=>{
 fs.writeFileSync(path.join(home,'settings.json'),'{}');
 for(const [name,capability]of [['backend-fixture',true],['no-backend-fixture',false]]){
  const dir=path.join(home,'extensions',name);fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name,version:'1.0.0',type:'module'}));
  fs.writeFileSync(path.join(dir,'ashub-plugin.json'),JSON.stringify({schemaVersion:2,id:name,name,entries:{application:'app.mjs'},requires:{hostApi:'^1',capabilities:['application-lifecycle',...(capability?['backend-connections','plugin-resources']:[])]}}));
  fs.writeFileSync(path.join(dir,'app.mjs'),capability?`export default ctx=>{ctx.services.backends.secrets.write('login','opaque-fixture-secret');const registration=ctx.services.backends.register('remote',{label:'Fixture remote',online:()=>true,request:async(op,args)=>({op,args,target:'remote'}),subscribe:async(sid,emit,signal)=>{emit({meta:{name:'hub:replay-done'},payload:{}});await new Promise(r=>signal.addEventListener('abort',r,{once:true}));}});ctx.services.interactions.register('connections',{view:()=>({rows:[],actions:[]}),prepare:async()=>({execute:async()=>{await registration.open();return {rows:[],actions:[]};}})});}`:`export default ctx=>{if(ctx.services.backends)throw Error('Unexpected backend authority');}`);
 }
 const vault=new Map(),opened=[];let localCalls=0;
 const hub=startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge(){localCalls++;throw Error('No local execution expected');},pluginSecretStore:{read:k=>vault.get(k)||null,write:(k,v)=>vault.set(k,v)},openBackendWorkspace:(...v)=>opened.push(v)});
 t.after(()=>hub.shutdown());await once(hub.server,'listening');const base='http://127.0.0.1:'+hub.server.address().port,headers={Origin:base,'Content-Type':'application/json'};
 const call=async(route,body)=>{const r=await fetch(base+route,{headers,method:body===undefined?'GET':'POST',body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert(r.ok,JSON.stringify(data));return data;};
 let features;
 for(let i=0;i<100;i++){features=await call('/api/extensions');if(features.features.filter(f=>f.name.endsWith('-fixture')).every(f=>f.state==='active')&&features.features.some(f=>f.name==='backend-fixture'))break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(features.features.find(f=>f.name==='no-backend-fixture').state,'active');
 const feature=features.features.find(f=>f.name==='backend-fixture');assert.equal(feature.state,'active',JSON.stringify(feature));
 const [entry]=await call('/api/backends');assert(entry);assert(!JSON.stringify(await call('/api/backends')).includes('opaque-fixture-secret'));assert.equal(vault.size,1);
 const route='/api/backends/'+entry.id;assert.equal((await call(route+'/request',{op:'submit',args:{session:'abcd',query:'remote-only'}})).target,'remote');assert.equal(localCalls,0);
 const forbidden=await fetch(base+route+'/open',{method:'POST',headers:{Origin:'https://untrusted.invalid'}});assert.equal(forbidden.status,403);assert.equal(opened.length,0);
 assert.equal((await fetch(base+route+'/open',{method:'POST',headers})).status,404);
 const resource='/api/plugin-resources/'+feature.pluginId+'/connections';
 const remoteOpen=await fetch(base+resource+'?remoteSession=abcd',{method:'POST',headers,body:JSON.stringify({action:'open',values:{}})});
 assert.equal(remoteOpen.status,409);assert.match((await remoteOpen.json()).error,/outside authorized conversation/);assert.equal(opened.length,0);
 await call(resource,{action:'open',values:{}});assert.equal(opened[0][0],entry.id);
 const page=await fetch(base+'/backend.html');assert(page.ok);assert((await page.text()).includes('backend-workspace.js'));
 await call('/api/extensions/'+feature.id+'/enabled',{enabled:false});assert.deepEqual(await call('/api/backends'),[]);assert.equal((await fetch(base+route+'/info')).status,410);
 await call('/api/extensions/'+feature.id+'/enabled',{enabled:true});assert.equal((await call('/api/backends'))[0].id,entry.id);assert.equal(localCalls,0);
});
