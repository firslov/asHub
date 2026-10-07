const {env,Bridge,assert,fs,path,root}=require('./harness.cjs');
const {once}=require('node:events');
const watchdog=setTimeout(()=>{console.error('HTTP round19 timed out');process.exit(1)},15000);
(async()=>{
 const modules={},e=env({modules,globals:{setTimeout,clearTimeout,setInterval,clearInterval}});
 const real=e.load('node_modules/agent-sh/dist/core/settings.js');Object.assign(e.settings,{getSettings:real.getSettings,reloadSettings:real.reloadSettings});
 const kernel=e.load('node_modules/agent-sh/dist/agent/skills.js');modules['agent-sh/skills']=kernel;
 const skill=path.join(e.dir,'standalone');fs.mkdirSync(skill);fs.writeFileSync(path.join(skill,'SKILL.md'),'---\nname: sample\ndescription: Test skill\n---\nBody');
 assert(kernel.discoverGlobalSkills().length===0);
 const app=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new Bridge(o)});await once(app.server,'listening');const origin=`http://127.0.0.1:${app.server.address().port}`;
 const send=(route,body,method='POST')=>fetch(origin+route,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try {
  assert((await send('/api/config',{skillPaths:[skill]},'PUT')).ok);
  assert(kernel.discoverGlobalSkills().length===1,'saved skill path not used by kernel');
  const installed=await fetch(origin+'/api/skills/installed').then(r=>r.json());assert(installed.installed.length===1&&installed.installed[0].path===skill);
  assert((await fetch(origin+'/api/skills?source=gitee')).status===502,'offline catalog claimed success');
  e.context.fetch=async()=>({ok:true,json:async()=>[]});const recovered=await fetch(origin+'/api/skills?source=gitee');assert(recovered.ok&&(await recovered.json()).skills.length===0);
  assert((await send('/api/skills/uninstall',{name:'standalone',path:skill})).ok);assert(!fs.existsSync(skill)&&kernel.discoverGlobalSkills().length===0);
  console.log('PASS real HTTP skill path cache refresh, standalone listing/uninstall and marketplace failure/recovery');
 } finally {await app.shutdown();app.server.closeAllConnections?.();clearTimeout(watchdog)}
})().then(()=>process.exit(0),err=>{console.error(err);process.exit(1)});
