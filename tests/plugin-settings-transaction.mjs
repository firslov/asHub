import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApplicationExtensionRegistry } from '../dist/extensions/application.js';
import { installedApplicationDefinitions } from '../dist/extensions/installed.js';
import { pluginCatalog } from '../dist/plugins.js';
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
async function fixture(t, {sessionOnly=false, canStop=()=>true, stop=()=>{}}={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-plugin-transaction-')),file=path.join(dir,'settings.json');fs.writeFileSync(file,JSON.stringify({unrelated:{keep:true}}));
 const events=[],live=new Map();
 for(const [id,dependencies] of [['base-example',[]],['child-example',[{id:'base-example',minVersion:'1.0.0'}]]]){
  const root=path.join(dir,'extensions',id);fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:id,version:'1.0.0',type:'module'}));
  fs.writeFileSync(path.join(root,'ashub-plugin.json'),JSON.stringify({schemaVersion:2,id,entries:id==='base-example'&&sessionOnly?{session:'session.mjs'}:{application:'app.mjs'},dependencies}));
  fs.writeFileSync(path.join(root,'session.mjs'),'export default()=>{}');
  fs.writeFileSync(path.join(root,'app.mjs'),`export default ctx=>{ctx.services.record('${id}',1);return {canStop:()=>${id==='child-example'?'ctx.services.canStop()':'true'},async stop(){await ctx.services.stop('${id}');ctx.services.record('${id}',-1)}}}`);
 }
 const services={canStop,stop,record:(id,direction)=>{events.push([id,direction]);const count=(live.get(id)||0)+direction;live.set(id,count);assert(count<=1,'must not overlap '+id)}};
 const registry=new ApplicationExtensionRegistry({settingsFile:file,definitions:[],discover:()=>installedApplicationDefinitions(file,{services})});
 t.after(async()=>{await registry.close().catch(()=>{});fs.rmSync(dir,{recursive:true,force:true})});await registry.start();
 const catalog=pluginCatalog(file),base=catalog.find(p=>p.manifest.id==='base-example'),child=catalog.find(p=>p.manifest.id==='child-example');
 return {registry,file,base,child,events,live};
}
test('package disable checks busy transitive dependents before persisting any flag',async t=>{
 let busy=true;const f=await fixture(t,{canStop:()=>!busy}),before=JSON.parse(fs.readFileSync(f.file));
 assert.equal(f.registry.isPluginBusy(f.base.id),true);
 await assert.rejects(f.registry.setPluginEnabled(f.base.id,false),e=>e.status===409);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),before);assert(f.registry.snapshot().features.every(p=>p.enabled&&p.state==='active'));
 busy=false;await f.registry.setPluginEnabled(f.base.id,false);assert.equal(pluginCatalog(f.file).find(p=>p.id===f.base.id).enabled,false);
 await f.registry.setPluginEnabled(f.base.id,true);assert(f.registry.snapshot().features.every(p=>p.enabled&&p.state==='active'));
});
test('session-only dependency packages also protect their busy application dependents',async t=>{
 const f=await fixture(t,{sessionOnly:true,canStop:()=>false}),before=JSON.parse(fs.readFileSync(f.file));
 assert.equal(f.registry.isPluginBusy(f.base.id),true);await assert.rejects(f.registry.setPluginEnabled(f.base.id,false),e=>e.status===409);assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),before);
});
test('admitted dependent calls reject package mutation and concurrent toggle paths serialize',async t=>{
 const f=await fixture(t),gate=deferred(),childFeature='plugin-'+f.child.id;
 const running=f.registry.run(childFeature,()=>gate.promise);
 await assert.rejects(f.registry.setPluginEnabled(f.base.id,false),e=>e.status===409);gate.resolve();await running;
 await Promise.all([f.registry.setPluginEnabled(f.base.id,false),f.registry.setPluginEnabled(f.base.id,true),f.registry.setEnabled(childFeature,false),f.registry.setPluginEnabled(f.base.id,false)]);
 const saved=JSON.parse(fs.readFileSync(f.file));assert(saved['ashub.plugins.disabled'].includes(f.base.id));assert(saved['ashub.features.disabled'].includes(childFeature));assert.deepEqual(saved.unrelated,{keep:true});
 assert.equal(f.registry.snapshot().features.find(p=>p.pluginId===f.base.id).enabled,false);assert.equal(f.registry.snapshot().features.find(p=>p.pluginId===f.child.id).enabled,false);
});
test('new calls cannot enter the package closure during an asynchronous stop',async t=>{
 const entered=deferred(),gate=deferred();const f=await fixture(t,{stop:async id=>{if(id==='base-example'){entered.resolve();await gate.promise}}});
 const stopping=f.registry.setPluginEnabled(f.base.id,false);await entered.promise;
 await assert.rejects(f.registry.run('plugin-'+f.base.id,()=>assert.fail('must not run')),e=>e.status===409);
 gate.resolve();await stopping;assert.equal(f.live.get('base-example'),0);
});
test('a late busy rejection restores only the affected flags and leaves live instances unchanged',async t=>{
 let checks=0;const f=await fixture(t,{canStop:()=>++checks===1}),before=JSON.parse(fs.readFileSync(f.file));
 await assert.rejects(f.registry.setPluginEnabled(f.base.id,false),e=>e.status===409);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),before);assert(f.registry.snapshot().features.every(p=>p.enabled&&p.state==='active'));
});

for (const broken of ['base-example', 'child-example']) test(`failed ${broken} cleanup keeps disabled state and isolates unrelated installed features`, async t => {
 const stops=[];
 const f=await fixture(t,{stop:id=>{stops.push(id);if(id===broken)throw Error('fixture cleanup failed')}});
 const root=path.join(path.dirname(f.file),'extensions','healthy-example');
 fs.mkdirSync(root,{recursive:true});
 fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'healthy-example',version:'1.0.0',type:'module'}));
 fs.writeFileSync(path.join(root,'ashub-plugin.json'),JSON.stringify({schemaVersion:2,id:'healthy-example',entries:{application:'app.mjs'}}));
 fs.writeFileSync(path.join(root,'app.mjs'),'export default()=>({stop(){}})');
 await f.registry.refresh();
 const healthy=pluginCatalog(f.file).find(p=>p.manifest.id==='healthy-example');
 await assert.rejects(f.registry.setPluginEnabled(f.base.id,false),/fixture cleanup failed/);
 assert.equal(pluginCatalog(f.file).find(p=>p.id===f.base.id).enabled,false);
 assert.equal(f.registry.snapshot().features.find(p=>p.pluginId===f.base.id).enabled,false);
 assert.equal(f.registry.snapshot().features.find(p=>p.pluginId===f.base.id).state,'error');
 // Catalog refresh must remain usable; the original cleanup must not repeat.
 await f.registry.refresh();await f.registry.refresh();
 assert.equal(stops.filter(id=>id===broken).length,1);
 assert.throws(()=>f.registry.requireActive('plugin-'+f.base.id),e=>e.status===409);
 await assert.rejects(f.registry.setEnabled('plugin-'+f.base.id,true),/restart the application/);
 await assert.rejects(f.registry.setPluginEnabled(f.base.id,true),e=>e.status===409);
 assert.equal(pluginCatalog(f.file).find(p=>p.id===f.base.id).enabled,false);
 await f.registry.setPluginEnabled(healthy.id,false);
 assert.equal(f.registry.snapshot().features.find(p=>p.pluginId===healthy.id).enabled,false);
 await f.registry.setPluginEnabled(healthy.id,true);
 f.registry.requireActive('plugin-'+healthy.id);
 assert.equal(f.events.filter(([id,direction])=>id===broken&&direction===1).length,1,'must never overlap the failed instance');
 if(broken==='child-example') assert.equal(stops.includes('base-example'),false,'retain dependencies still referenced by failed cleanup');
 // Actual registry HTTP adapter must return an authoritative usable catalog.
 const {Readable}=await import('node:stream');
 const req=Object.assign(Readable.from([]),{url:'/api/extensions',method:'GET'});
 let status,body;
 const res={writeHead(code){status=code},end(text){body=JSON.parse(text)}};
 assert.equal(await f.registry.handle(req,res),true);assert.equal(status,200);
 assert.equal(body.features.find(p=>p.pluginId===f.base.id).enabled,false);
 assert.equal(body.features.find(p=>p.pluginId===healthy.id).state,'active');
});
