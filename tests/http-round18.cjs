process.env.ASHUB_TEST_ROOT ||= require('path').resolve(__dirname,'..');
const {env,Bridge,assert,fs,path,root}=require('./harness.cjs');const {once}=require('events');
const watchdog=setTimeout(()=>{console.error('HTTP round18 timed out');process.exit(1)},15000);
(async()=>{
 const e=env({globals:{setTimeout,clearTimeout,setInterval,clearInterval}}),file=path.join(e.dir,'settings.json');
 const original={providers:{fixture:{models:['original'],apiKey:'fake'}},extension:{preserve:true}};fs.writeFileSync(file,JSON.stringify(original));
 const real=e.load('node_modules/agent-sh/dist/core/settings.js');Object.assign(e.settings,{getSettings:real.getSettings,resolveProvider:real.resolveProvider,reloadSettings:real.reloadSettings});e.auth.listAllProviders=()=>[{id:'fixture'}];
 const app=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new Bridge(o)});await once(app.server,'listening');const url=`http://127.0.0.1:${app.server.address().port}`;
 const send=(route,body,method='POST')=>fetch(url+route,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try{
  const invalid=await send('/api/config',{providers:{fixture:{models:{id:'bad'}}}},'PUT');assert(invalid.status===400&&JSON.parse(fs.readFileSync(file)).extension.preserve,'invalid settings were saved');
  // Existing structurally broken files can be read and repaired without a working model catalog.
  fs.writeFileSync(file,JSON.stringify({providers:{fixture:{models:{}}}}));real.reloadSettings();assert((await fetch(url+'/api/models')).status===500,'expected fixture model failure');const loaded=await fetch(url+'/api/config');assert(loaded.ok,'advanced repair cannot read configuration');
  assert((await send('/api/config',original,'PUT')).ok,'valid repair failed');const models=await fetch(url+'/api/models');assert(models.ok&&(await models.json()).providers[0].models[0].id==='original','repair failed to restore catalog');
  const skill=path.join(e.dir,'skills','sample');fs.mkdirSync(skill,{recursive:true});fs.writeFileSync(path.join(skill,'SKILL.md'),'fixture');fs.writeFileSync(path.join(skill,'.ashub-source.json'),JSON.stringify({url:'https://github.com/owner/sample.git',subdir:''}));
  const installed=await fetch(url+'/api/skills/installed').then(r=>r.json());assert(installed.installed[0].sourceId==='github:owner/sample','source missing');
  const conflict=await send('/api/skills/uninstall',{name:'sample',path:skill,sourceId:'gitee:other/sample'});assert(conflict.status===409&&fs.existsSync(skill),'wrong-source uninstall deleted data');
  assert((await send('/api/skills/uninstall',{name:'sample',path:skill,sourceId:'github:owner/sample'})).ok&&!fs.existsSync(skill),'matching-source uninstall failed');
  console.log('PASS real HTTP rejects malformed config, repairs existing config, exposes skill identity and guards uninstall source');
 }finally{await app.shutdown();app.server.closeAllConnections?.();clearTimeout(watchdog)}
})().then(()=>process.exit(0),err=>{console.error(err);process.exit(1)});
