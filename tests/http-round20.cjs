const {env,Bridge,assert,fs,path,root}=require('./harness.cjs');
const {once}=require('node:events');
const watchdog=setTimeout(()=>{console.error('HTTP round20 timed out');process.exit(1)},15000);
(async()=>{
 const e=env({globals:{setTimeout,clearTimeout,setInterval,clearInterval}}),cwd=path.join(e.os.homedir(),'project'),home=path.join(e.os.homedir(),'.agents/skills/demo'),project=path.join(cwd,'.agents/skills/demo');
 for(const dir of [home,project]){fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'SKILL.md'),'---\nname: demo\ndescription: Test\n---\nBody')}
 const kernel=e.load('node_modules/agent-sh/dist/agent/skills.js');
 const app=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new Bridge(o)});await once(app.server,'listening');const origin=`http://127.0.0.1:${app.server.address().port}`;
 const read=dir=>fetch(origin+'/api/skills/installed?cwd='+encodeURIComponent(dir)).then(r=>r.json());
 try {
  const first=await read(cwd);assert(first.installed.length===1&&first.installed[0].path===project&&kernel.discoverSkills(cwd)[0].baseDir===project);
  const removed=await fetch(origin+'/api/skills/uninstall',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...first.installed[0],cwd})});assert(removed.ok&&!fs.existsSync(project)&&fs.existsSync(home));
  const next=await read(cwd);assert(next.installed[0].path===home&&kernel.discoverSkills(cwd)[0].baseDir===home);
  const outside=path.join(e.dir,'outside');fs.mkdirSync(outside);assert((await read(outside)).installed.length===0&&kernel.discoverSkills(outside).length===0);
  const helper=await fetch(origin+'/js/file-mention.js');assert(helper.ok&&(await helper.text()).includes('formatFileMention'));
  console.log('PASS real HTTP skill precedence, exact uninstall, fallback discovery and file-mention module serving');
 } finally {await app.shutdown();app.server.closeAllConnections?.();clearTimeout(watchdog)}
})().then(()=>process.exit(0),err=>{console.error(err);process.exit(1)});
