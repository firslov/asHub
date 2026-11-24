import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DesktopService } from '../dist/service.js';
import { leaseService } from '../dist/leases.js';
import { activateDesktopControl, isDesktopControlTool } from '../dist/plugin.js';
import { isolateDesktopTools } from '../dist/isolation.js';
import { writeDesktopSettings, settingsRevision, readDesktopSettings } from '../dist/settings.js';
const run=promisify(execFile);
const home=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-extension-'));
process.env.AGENT_SH_HOME=home;
const {createCore}=await import('agent-sh');
const {activateAgent}=await import('agent-sh/agent');
const {loadBuiltinExtensions}=await import('agent-sh/extensions');
const host=process.env.ASHUB_TEST_ROOT;
const hostModule=async name=>import(pathToFileURL(path.join(host,'dist',name)).href);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const reply=data=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
function makeService(file){
 fs.writeFileSync(file,JSON.stringify({'desktop-control':{enabled:true,allowedApps:['com.test.App']}}));
 const calls=[];
 const service=new DesktopService(file,{platform:'darwin',factory:()=>({async call(name,args){
  calls.push(name);
  if(name==='status')return reply({permissions:{accessibility:true},background_input:true});
  if(name==='apps')return reply({apps:[{bundle_id:'com.test.App',pid:1}]});
  if(name==='windows')return reply({windows:[{window_id:100}]});
  if(name==='observe')return reply({snapshot:'s1',window_id:100,elements:[]});
  if(name==='release')return reply({});
  throw Error(name);
 },async close(){calls.push('closed');}})});
 return {service,calls};
}
test.after(()=>fs.rmSync(home,{recursive:true,force:true}));

test('installer produces a dependency-free, importable extension and preserves unrelated settings',async t=>{
 const targetHome=path.join(home,'install');fs.mkdirSync(targetHome);
 const settings=path.join(targetHome,'settings.json');fs.writeFileSync(settings,'{"unchanged":true}');
 const before=fs.readFileSync(settings,'utf8');
 const install=new URL('../scripts/install.mjs',import.meta.url).pathname;
 const uninstall=new URL('../scripts/uninstall.mjs',import.meta.url).pathname;
 await run(process.execPath,[install,'--home',targetHome]);
 const dir=path.join(targetHome,'extensions/ashub-desktop-control');
 assert(!fs.existsSync(path.join(dir,'node_modules')));
 fs.accessSync(path.join(dir,'native/capture'),fs.constants.X_OK);
 const entry=pathToFileURL(path.join(dir,'index.js')).href;
 const imported=await run(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(entry)});if(typeof m.default!=='function')throw Error('missing activation');console.log('ok')`],{cwd:os.tmpdir()});
 assert.match(imported.stdout,/ok/);
 await run(process.execPath,[install,'--home',targetHome]); // upgrade/reinstall
 assert.equal(fs.readFileSync(settings,'utf8'),before);
 fs.mkdirSync(path.join(targetHome,'extensions/other'));fs.writeFileSync(path.join(targetHome,'extensions/other/index.js'),'untouched');
 await run(process.execPath,[uninstall,'--home',targetHome]);assert(!fs.existsSync(dir));
 assert(fs.existsSync(path.join(targetHome,'extensions/other/index.js')));assert.equal(fs.readFileSync(settings,'utf8'),before);
 fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'index.js'),'unknown');
 await assert.rejects(run(process.execPath,[install,'--home',targetHome]));assert.equal(fs.readFileSync(path.join(dir,'index.js'),'utf8'),'unknown');
 await assert.rejects(run(process.execPath,[uninstall,'--home',targetHome]));
});

test('reference-counted lifecycle shares a driver and config changes revoke live ownership',async t=>{
 const file=path.join(home,'lease-settings.json');const {service,calls}=makeService(file);
 const a=await leaseService(file,()=>service),b=await leaseService(file,()=>{throw Error('must share driver');});
 t.after(async()=>{await a.release();await b.release();});
 const owner=Symbol();await service.acquire(owner,'com.test.App',100);
 await a.release();assert.equal((await service.status()).busy,true);assert(!calls.includes('closed'));
 fs.writeFileSync(file,JSON.stringify({'desktop-control':{enabled:false,allowedApps:[]}}));
 for(let i=0;i<100&&(await service.status()).busy;i++)await wait(10);
 assert.equal((await service.status()).busy,false);assert(calls.includes('release'));
 await b.release();assert(calls.includes('closed'));
});

test('saving via a command does not let the settings watcher cancel a later new task',async t=>{
 const file=path.join(home,'command-settings.json');const {service}=makeService(file);
 const lease=await leaseService(file,()=>service);t.after(()=>lease.release());
 await service.save({enabled:true,allowedApps:['com.test.App','com.test.Other']},settingsRevision(readDesktopSettings(file)));
 await service.acquire(Symbol(),'com.test.App',100);await wait(600);
 assert.equal((await service.status()).busy,true);
});

test('unchanged asHub discovers and loads the installed extension through PluginRuntime',{skip:!host},async t=>{
 const {PluginRuntime,preparePluginRegistrations}=await hostModule('plugin-runtime.js');
 const {pluginCatalog,getPluginConfig,savePluginConfig,setPluginEnabled}=await hostModule('plugins.js');
 await run(process.execPath,[new URL('../scripts/install.mjs',import.meta.url).pathname,'--home',home]);
 const file=path.join(home,'settings.json');fs.writeFileSync(file,'{}');
 const core=createCore({});t.after(()=>core.kill());const ctx=core.extensionContext({quit(){}});
 preparePluginRegistrations(ctx);activateAgent(ctx);preparePluginRegistrations(ctx);
 await loadBuiltinExtensions(ctx,['codex-provider','file-autocomplete']);
 const runtime=new PluginRuntime(file);t.after(()=>runtime.close());
 assert.deepEqual(await runtime.load(ctx),['桌面控制']);
 const status=runtime.status[0];assert.equal(status.state,'loaded');assert.deepEqual(status.configNamespaces,['desktop-control']);
 const installed=pluginCatalog(file).filter(entry=>entry.manifest?.id==='ashub-desktop-control');
 assert.equal(installed.length,1);
 const [plugin]=installed;
 assert.equal(plugin.packageRoot,path.join(home,'extensions','ashub-desktop-control'));
 const tools=ctx.agent.getTools().filter(t=>t.name.startsWith('desktop_'));assert.equal(tools.length,8);
 const info=[];ctx.bus.on('ui:info',p=>info.push(p.message));
 await ctx.call('command:/desktop','status');assert.match(info.at(-1),/"enabled": false/);
 await ctx.call('command:/desktop','allow com.apple.TextEdit');
 assert.deepEqual(readDesktopSettings(file).allowedApps,['com.apple.TextEdit']);
 const config=getPluginConfig(file,plugin.id,'desktop-control');
 savePluginConfig(file,plugin.id,'desktop-control',{enabled:false,allowedApps:[]},config.revision);
 assert.deepEqual(readDesktopSettings(file),{enabled:false,allowedApps:[]});
 setPluginEnabled(file,plugin.id,false);
 const disabled=new PluginRuntime(file);assert.deepEqual(await disabled.load(ctx),[]);disabled.close();
 runtime.close();assert(!ctx.agent.getTools().some(t=>t.name.startsWith('desktop_')));
 const saved=info.length;await ctx.call('command:/desktop','status');assert.equal(info.length,saved);
});

test('extension hooks isolate async subagents and swarms without altering main tools or approvals',{skip:!host},async t=>{
 const {pluginScope,preparePluginRegistrations}=await hostModule('plugin-runtime.js');
 const core=createCore({});t.after(()=>core.kill());const ctx=core.extensionContext({quit(){}});
 preparePluginRegistrations(ctx);activateAgent(ctx);preparePluginRegistrations(ctx);
 const file=path.join(home,'isolation.json');const {service,calls}=makeService(file);t.after(()=>service.close());
 const scope=pluginScope(ctx);t.after(()=>scope.dispose());activateDesktopControl(scope.ctx,service);isolateDesktopTools(scope.ctx,isDesktopControlTool);
 ctx.agent.registerTool({name:'ordinary',description:'fixture',input_schema:{type:'object',properties:{}},execute:async()=>({content:'ok',exitCode:0})});
 let approvals=0;ctx.bus.onPipeAsync('permission:request',p=>{approvals++;p.decision={outcome:'approved'};return p;});
 const native=ctx.agent.getTools().find(t=>t.name==='desktop_start');
 assert.equal((await native.execute({bundleId:'com.test.App',windowId:100,goal:'Main task'})).isError,false);assert.equal(approvals,1);
 const finish=ctx.agent.getTools().find(t=>t.name==='desktop_finish');
 for(const name of ['subagent:run','subagent:resume','tool:agentswarm']){
  // asHub defines these handlers AFTER plugins load; advice must survive.
  core.handlers.define(name,async()=>{
   await wait(1);
   const tools=ctx.agent.getTools();assert(!tools.some(t=>t.name.startsWith('desktop_')));assert(tools.some(t=>t.name==='ordinary'));
   assert.equal((await finish.execute({})).isError,true,'a borrowed parent tool must not release its window');
  });
  await core.handlers.call(name,{});
 }
 assert.equal((await service.status()).busy,true);assert(!calls.includes('release'));
 // Existing host gates still apply; the plugin must not bypass them.
 let hostChecks=0;
 core.handlers.define('tool:execute',p=>p.tool.execute(p.args));
 core.handlers.advise('tool:execute',(next,p)=>{hostChecks++;return {content:'denied by host',exitCode:1,isError:true};});
 assert.equal((await core.handlers.call('tool:execute',{tool:finish,args:{}})).isError,true);assert.equal(hostChecks,1);
 assert.equal((await service.status()).busy,true);
 await finish.execute({});assert.equal((await service.status()).busy,false);
 scope.dispose();assert(!ctx.agent.getTools().some(t=>t.name.startsWith('desktop_')));
});

test('a new activation waits for the last driver to close before creating another',async()=>{
 const file=path.join(home,'overlap.json');let finishClose,created=0;
 const first=await leaseService(file,()=>({syncSettings:async()=>{},close:()=>new Promise(r=>finishClose=r)}));
 const release=first.release();
 const pending=leaseService(file,()=>{created++;return {syncSettings:async()=>{},close:async()=>{}};});
 await wait(5);assert.equal(created,0);
 finishClose();await release;const next=await pending;assert.equal(created,1);await next.release();
});
