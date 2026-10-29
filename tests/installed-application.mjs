import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { zip } = require('./plugin-zip-fixture.cjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-installed-app-'));
process.env.AGENT_SH_HOME = home;
const { PluginInstaller } = await import('../dist/plugin-installer.js');
const { pluginCatalog, setPluginEnabled } = await import('../dist/plugins.js');
const { ApplicationExtensionRegistry } = await import('../dist/extensions/application.js');
const { installedApplicationDefinitions } = await import('../dist/extensions/installed.js');
const { PluginRuntime, preparePluginRegistrations } = await import('../dist/plugin-runtime.js');
const { createCore } = await import('agent-sh');
const { activateAgent } = await import('agent-sh/agent');
test.after(() => fs.rmSync(home, {recursive:true,force:true}));
async function installed(t, manifest, code) {
  const dir=fs.mkdtempSync(path.join(home,'fixture-')),file=path.join(dir,'settings.json');fs.writeFileSync(file,'{}');
  const installer=new PluginInstaller(file);
  t.after(()=>installer.close());
  const preview=await installer.preview(zip({
    'release/package.json':JSON.stringify({name:manifest.id,version:'1.0.0',type:'module'}),
    'release/ashub-plugin.json':JSON.stringify(manifest),
    ...Object.fromEntries(Object.entries(code).map(([name,value])=>['release/'+name,value])),
  }));
  assert(preview.canInstall);
  const job=installer.confirm(preview.token);
  for(let i=0;i<200&&installer.status(job.id).state==='running';i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(installer.status(job.id).state,'succeeded',installer.status(job.id).error);
  return {file,dir};
}
function kernel(t){
  const core=createCore({}),ctx=core.extensionContext({quit(){}});preparePluginRegistrations(ctx);activateAgent(ctx);preparePluginRegistrations(ctx);t.after(()=>core.kill());return ctx;
}

test('real ZIP application entry activates once per Hub, session entry once per kernel, shared install disable applies to both',async t=>{
  const f=await installed(t,{schemaVersion:2,id:'dual-example',entries:{session:'session.mjs',application:'application.mjs'},configNamespaces:['example'],defaults:{example:{greeting:'hello'}},requires:{hostApi:'^1',capabilities:['application-lifecycle','session-extensions']}},{
    'application.mjs':`export default ctx=>{ctx.services.record('application:'+ctx.getExtensionSettings('example',{}).greeting);ctx.onDispose(()=>ctx.services.record('cleanup'));return {stop(){ctx.services.record('stop')}}}`,
    'session.mjs':`export default ctx=>{ctx.agent.registerTool({name:'dual_probe',description:'probe',parameters:{type:'object',properties:{}},execute:async()=>({output:'ok'})})}`,
  });
  const events=[];
  const registry=new ApplicationExtensionRegistry({settingsFile:f.file,definitions:[],discover:()=>installedApplicationDefinitions(f.file,{services:{record:value=>events.push(value)}})});
  t.after(()=>registry.close());
  await registry.start();await registry.refresh();assert.deepEqual(events,['application:hello']);
  const feature=registry.snapshot().features[0],entry=pluginCatalog(f.file)[0];assert.equal(feature.pluginId,entry.id);
  const a=kernel(t),b=kernel(t),ra=new PluginRuntime(f.file),rb=new PluginRuntime(f.file);t.after(()=>{ra.close();rb.close()});
  await ra.load(a);await rb.load(b);assert(a.agent.getTools().some(t=>t.name==='dual_probe'));assert(b.agent.getTools().some(t=>t.name==='dual_probe'));
  assert.deepEqual(events,['application:hello'],'session kernels never activate application entry');
  await registry.setEnabled(feature.id,false);assert.deepEqual(events,['application:hello','stop','cleanup']);
  await registry.setEnabled(feature.id,true);assert.equal(events.filter(x=>x==='application:hello').length,2);
  setPluginEnabled(f.file,entry.id,false);await registry.refresh();assert.equal(registry.snapshot().features[0].enabled,false);
  const disabled=new PluginRuntime(f.file),c=kernel(t);t.after(()=>disabled.close());assert.deepEqual(await disabled.load(c),[]);assert(!c.agent.getTools().some(t=>t.name==='dual_probe'));
  assert(a.agent.getTools().some(t=>t.name==='dual_probe'),'running session kernel retains its snapshot');
});

test('application-only packages never import into a session; discovery exposes UI and bound namespaces',async t=>{
  const f=await installed(t,{schemaVersion:2,id:'app-ui-example',entries:{application:'app.mjs'},configNamespaces:['preferences'],defaults:{preferences:{label:'Hi'}},ui:{version:1,panels:[{id:'overview',title:'Example',components:[{type:'form',id:'settings',mode:'config',namespace:'preferences',fields:[{id:'label',label:'Label',type:'text'}]}]}]}},{
    'app.mjs':`export default ctx=>{ctx.services.record(ctx.pluginId);try{ctx.getExtensionSettings('providers',{})}catch(e){ctx.services.record('namespace-rejected')}}`,
  });
  const calls=[],registry=new ApplicationExtensionRegistry({settingsFile:f.file,definitions:[],discover:()=>installedApplicationDefinitions(f.file,{services:{record:v=>calls.push(v)}})});t.after(()=>registry.close());
  const ctx=kernel(t),runtime=new PluginRuntime(f.file);t.after(()=>runtime.close());
  assert.deepEqual(await runtime.load(ctx),[]);assert.deepEqual(calls,[]);
  await registry.start();const snapshot=registry.snapshot(),feature=snapshot.features[0];assert.deepEqual(feature.configNamespaces,['preferences']);assert.equal(feature.ui.panels[0].components[0].namespace,'preferences');assert.deepEqual(calls,[feature.pluginId,'namespace-rejected']);
});

test('manually copied unsupported application capability remains visible and never imports code',async t=>{
  const dir=fs.mkdtempSync(path.join(home,'incompatible-')),root=path.join(dir,'extensions','bad-example');fs.mkdirSync(root,{recursive:true});const file=path.join(dir,'settings.json');fs.writeFileSync(file,'{}');
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'bad-example',version:'1.0.0',type:'module'}));
  fs.writeFileSync(path.join(root,'ashub-plugin.json'),JSON.stringify({schemaVersion:2,id:'bad-example',entries:{application:'app.mjs'},requires:{capabilities:['unknown-capability']}}));
  fs.writeFileSync(path.join(root,'app.mjs'),'throw Error("must never import")');
  const registry=new ApplicationExtensionRegistry({settingsFile:file,definitions:[],discover:()=>installedApplicationDefinitions(file)});t.after(()=>registry.close());
  await registry.start();assert.equal(registry.snapshot().features[0].state,'error');assert.match(registry.snapshot().features[0].error,/unknown-capability/);assert(!registry.snapshot().features[0].error.includes('must never import'));
});

test('v2 session settings enforce declared namespaces and roll back a rejected activation',async t=>{
  const f=await installed(t,{schemaVersion:2,id:'session-config-example',entries:{session:'session.mjs'},configNamespaces:['declared']},{
    'session.mjs':`export default ctx=>{ctx.agent.registerTool({name:'must_rollback',description:'probe',parameters:{type:'object',properties:{}},execute:async()=>({output:'ok'})});ctx.getExtensionSettings('providers',{})}`,
  });
  const ctx=kernel(t),runtime=new PluginRuntime(f.file);t.after(()=>runtime.close());
  assert.deepEqual(await runtime.load(ctx),[]);assert.match(runtime.status[0].error,/not declared/);assert(!ctx.agent.getTools().some(t=>t.name==='must_rollback'));
});

test('v2 entry-path migration is rejected before replacing a disabled package or either persisted choice',async t=>{
  const f=await installed(t,{schemaVersion:2,id:'entry-migration-example',entries:{application:'app.mjs'}},{'app.mjs':'export default()=>{}'});
  const entry=pluginCatalog(f.file)[0],registry=new ApplicationExtensionRegistry({settingsFile:f.file,definitions:[],discover:()=>installedApplicationDefinitions(f.file)});t.after(()=>registry.close());
  await registry.start();await registry.setEnabled('plugin-'+entry.id,false);setPluginEnabled(f.file,entry.id,false);
  const before=JSON.parse(fs.readFileSync(f.file));
  const installer=new PluginInstaller(f.file);t.after(()=>installer.close());
  const next={schemaVersion:2,id:'entry-migration-example',entries:{application:'app/start.mjs'}};
  await assert.rejects(installer.preview(zip({
    'release/package.json':JSON.stringify({name:next.id,version:'2.0.0',type:'module'}),
    'release/ashub-plugin.json':JSON.stringify(next),
    'release/app/start.mjs':'export default()=>{throw Error("must never activate upgraded entry")}',
  })),/entry changed; update this package manually to preserve its settings and enable state/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),before);const current=pluginCatalog(f.file)[0];assert.equal(current.id,entry.id);assert.equal(current.enabled,false);assert.equal(current.version,'1.0.0');
  assert.equal(current.manifest.entries.application,'app.mjs');assert(fs.existsSync(path.join(current.packageRoot,'app.mjs')));assert(!fs.existsSync(path.join(current.packageRoot,'app/start.mjs')));
});
