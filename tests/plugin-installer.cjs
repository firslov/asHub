const test=require('node:test'),assert=require('node:assert/strict');
const {env,fs,path}=require('./harness.cjs'),{zip,plugin}=require('./plugin-zip-fixture.cjs');
const manifest={schemaVersion:1,id:'sample-plugin',name:'Sample'};
async function finish(installer,id){for(let i=0;i<200;i++){const j=installer.status(id);if(j.state!=='running')return j;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');}
function fixture(run,extra={}) {const e=env({globals:{setTimeout,clearTimeout},...extra}),{PluginInstaller}=e.load('src/plugin-installer.ts'),file=path.join(e.dir,'settings.json');return {e,file,i:new PluginInstaller(file,run|| (async()=>{}),'darwin')};}
test('preview does not execute code; explicit confirmation installs once and preserves existing configuration',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;});
 fs.writeFileSync(f.file,JSON.stringify({providers:{secret:'keep'},sample:{enabled:true},'ashub.plugins.disabled':['keep']}));
 const p=await f.i.preview(zip(plugin({}, {...manifest,defaults:{sample:{enabled:false},fresh:{enabled:false}}})));
 assert.equal(calls,0);assert(!fs.existsSync(p.target));assert.equal(p.canInstall,true);
 const j=f.i.confirm(p.token);assert.equal((await finish(f.i,j.id)).state,'succeeded');
 assert(fs.existsSync(path.join(p.target,'index.mjs')));assert.equal(calls,1,'only syntax validation, no imported entry');
 const settings=JSON.parse(fs.readFileSync(f.file));assert.equal(settings.sample.enabled,true);assert.equal(settings.providers.secret,'keep');assert.equal(settings.fresh.enabled,false);
 assert.equal(f.i.confirm(p.token).state,'succeeded');assert.equal(calls,1);await f.i.close();
});
test('legacy ZIP import does not execute package lifecycle or arbitrary installation scripts',async()=>{
 const invoked=[];const f=fixture(async(file)=>invoked.push(file));
 const p=await f.i.preview(zip(plugin({'release/package.json':JSON.stringify({name:'sample-plugin',version:'1.0.0',scripts:{postinstall:'DANGER'}}),'release/install.mjs':'throw Error("do not run")'},null)));
 assert(p.legacy);assert.equal(p.setup,null);await finish(f.i,f.i.confirm(p.token).id);assert.deepEqual(invoked,['--check']);await f.i.close();
});
test('rejects traversal, symlinks, duplicate portable paths, node_modules, malformed and oversized archives',async()=>{
 const f=fixture();
 for(const extra of [{'../escape':'x'},{'/absolute':'x'},{'release/link':{data:'../escape',mode:0o120777}},{'release/INDEX.MJS':'x'},{'release/node_modules/a.js':'x'},{'release/C:evil':'x'},{'release/bomb':{data:'x',size:140*1024*1024}}]){
  await assert.rejects(f.i.preview(zip(plugin(extra))));
 }
 await assert.rejects(f.i.preview(Buffer.from('invalid')));await assert.rejects(f.i.preview(Buffer.alloc(32*1024*1024+1)));
 assert(!fs.existsSync(path.join(f.e.dir,'extensions')));await f.i.close();
});
test('checks host/platform and dependency prerequisites before any setup script',async()=>{
 const f=fixture(async()=>{throw Error('must not run');});
 for(const m of [{...manifest,platforms:['win32']},{...manifest,minNode:'99.0.0'},{...manifest,dependencies:[{id:'missing-plugin',minVersion:'1.0.0'}]}]){
  const p=await f.i.preview(zip(plugin({},m)));assert.equal(p.canInstall,false);assert.throws(()=>f.i.confirm(p.token),/prerequisites/);f.i.discard(p.token);
 }
 const p=await f.i.preview(zip(plugin({'release/package.json':JSON.stringify({name:'sample-plugin',version:'1.0.0',engines:{node:'>=99'}})})));assert.equal(p.canInstall,false);f.i.discard(p.token);
 await assert.rejects(f.i.preview(zip(plugin({}, {...manifest,defaults:{providers:{}}}))),/namespace/i);
 await f.i.close();
});
test('setup failure leaves old package and config intact, upgrades retain a recovery backup',async()=>{
 let fail=true;const f=fixture(async script=>{if(script!=='--check'&&fail)throw Error('fixture setup failure');});
 const target=path.join(f.e.dir,'extensions/sample-plugin');fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'sample-plugin',version:'0.9.0'}));fs.writeFileSync(path.join(target,'index.mjs'),'old');fs.writeFileSync(f.file,'{"sample":{"enabled":true}}');
 const bytes=zip(plugin({'release/setup.mjs':'console.log("setup")'}, {...manifest,setup:{script:'setup.mjs',description:'fixture setup'}}));
 const p=await f.i.preview(bytes);assert.equal(p.previousVersion,'0.9.0');const failed=await finish(f.i,f.i.confirm(p.token).id);assert.equal(failed.state,'failed');assert.equal(fs.readFileSync(path.join(target,'index.mjs'),'utf8'),'old');assert.equal(f.i.confirm(p.token).state,'failed');f.i.discard(p.token);
 fail=false;const next=await f.i.preview(bytes);const done=await finish(f.i,f.i.confirm(next.token).id);assert.equal(done.state,'succeeded');assert.equal(fs.readFileSync(path.join(done.backup,'index.mjs'),'utf8'),'old');assert.equal(JSON.parse(fs.readFileSync(f.file)).sample.enabled,true);await f.i.close();
});
test('revalidates stale previews, serializes installations, and waits for cancellation',async()=>{
 let release;const f=fixture(async(_s,_a,_c,_h,_d,signal)=>new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});}));
 const p=await f.i.preview(zip(plugin())),other=await f.i.preview(zip(plugin()));f.i.confirm(p.token);
 assert.throws(()=>f.i.confirm(other.token),/Another/);assert.throws(()=>f.i.discard(p.token),/running/);
 release();assert.equal((await finish(f.i,p.token)).state,'succeeded');assert.throws(()=>f.i.confirm(other.token),/changed/);
 f.i.discard(other.token);const again=await f.i.preview(zip(plugin()));f.i.confirm(again.token);await f.i.close();
 assert.equal(JSON.parse(fs.readFileSync(path.join(p.target,'package.json'))).version,'1.0.0');
});
test('configuration write failure rolls package placement back',async()=>{
 const f=fixture();const target=path.join(f.e.dir,'extensions/sample-plugin');fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'sample-plugin',version:'0.9.0'}));fs.writeFileSync(path.join(target,'index.mjs'),'old');
 const p=await f.i.preview(zip(plugin({}, {...manifest,defaults:{sample:{}}})));
 fs.mkdirSync(f.file); // deterministic write/read failure, after preview
 const result=await finish(f.i,f.i.confirm(p.token).id);assert.equal(result.state,'failed');assert.equal(fs.readFileSync(path.join(target,'index.mjs'),'utf8'),'old');await f.i.close();
});
test('real Node validation rejects invalid entry without installing or evaluating plugin code',async()=>{
 const e=env({globals:{setTimeout,clearTimeout}}),{PluginInstaller}=e.load('src/plugin-installer.ts'),i=new PluginInstaller(path.join(e.dir,'settings.json'));
 const p=await i.preview(zip(plugin({'release/index.mjs':'export default !!!'})));
 const result=await finish(i,i.confirm(p.token).id);assert.equal(result.state,'failed');assert.match(result.error,/SyntaxError/);assert(!fs.existsSync(p.target));await i.close();
});

test('entry selection matches host discovery, and active plugins cannot be replaced mid-task',async()=>{
 const f=fixture();
 await assert.rejects(f.i.preview(zip(plugin({'release/index.js':'export default ()=>{}'}))),/entry/);
 const p=await f.i.preview(zip(plugin({'release/package.json':JSON.stringify({name:'sample-plugin',version:'1.0.0',main:'./index.mjs'})})));
 await finish(f.i,f.i.confirm(p.token).id);await f.i.close();
 const {PluginInstaller}=f.e.load('src/plugin-installer.ts');let active=true;
 const installer=new PluginInstaller(f.file,async()=>{active=true;},'darwin',()=>active);
 const preview=await installer.preview(zip(plugin()));assert(!preview.canInstall);assert.throws(()=>installer.confirm(preview.token),/prerequisites/);
 active=false;const job=installer.confirm(preview.token);assert.equal((await finish(installer,job.id)).state,'failed');
 assert.equal(JSON.parse(fs.readFileSync(path.join(preview.target,'package.json'))).version,'1.0.0');await installer.close();
});

test('npm dependencies require a lockfile and lifecycle execution is disabled',async()=>{
 const commands=[],f=fixture(async(script,args)=>commands.push([script,args]));
 const deps={'release/package.json':JSON.stringify({name:'sample-plugin',version:'1.0.0',dependencies:{sample:'1.0.0'}})};
 await assert.rejects(f.i.preview(zip(plugin(deps))),/package-lock/);
 const preview=await f.i.preview(zip(plugin({...deps,'release/package-lock.json':'{}'})));
 if(preview.canInstall){assert.equal((await finish(f.i,f.i.confirm(preview.token).id)).state,'succeeded');assert.deepEqual(commands[0][1],['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund']);}
 else assert(preview.checks.some(c=>c.label==='npm'&&!c.ok));
 await f.i.close();
});


test('upgrade cannot silently change entry identity and bypass a disabled plugin',async()=>{
 const f=fixture(),target=path.join(f.e.dir,'extensions/sample-plugin');fs.mkdirSync(target,{recursive:true});
 fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'sample-plugin',version:'0.9.0'}));fs.writeFileSync(path.join(target,'index.js'),'old');
 const {pluginCatalog,setPluginEnabled}=f.e.load('src/plugins.ts');setPluginEnabled(f.file,pluginCatalog(f.file)[0].id,false);
 const before=fs.readFileSync(f.file,'utf8');await assert.rejects(f.i.preview(zip(plugin())),/entry changed/);
 assert.equal(fs.readFileSync(f.file,'utf8'),before);assert.equal(pluginCatalog(f.file)[0].enabled,false);await f.i.close();
});

test('setup cannot change the discovered entry and bypass an existing disabled state',async()=>{
 const f=fixture(async(script,_args,cwd)=>{if(script!=='--check')fs.writeFileSync(path.join(cwd,'index.js'),'export default ()=>{}');});
 const target=path.join(f.e.dir,'extensions/sample-plugin');fs.mkdirSync(target,{recursive:true});
 fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'sample-plugin',version:'0.9.0'}));fs.writeFileSync(path.join(target,'index.mjs'),'old');
 const {pluginCatalog,setPluginEnabled}=f.e.load('src/plugins.ts');const old=pluginCatalog(f.file)[0];setPluginEnabled(f.file,old.id,false);
 const before=fs.readFileSync(f.file,'utf8');
 const p=await f.i.preview(zip(plugin({'release/setup.mjs':'// build'}, {...manifest,setup:{script:'setup.mjs',description:'Build plugin'}})));
 const result=await finish(f.i,f.i.confirm(p.token).id);
 assert.equal(result.state,'failed');assert.match(result.error,/entry.*changed/i);
 assert.equal(fs.readFileSync(path.join(target,'index.mjs'),'utf8'),'old');assert.equal(fs.readFileSync(f.file,'utf8'),before);
 assert.equal(pluginCatalog(f.file)[0].id,old.id);assert.equal(pluginCatalog(f.file)[0].enabled,false);await f.i.close();
});

test('preview recovery reuses capacity without authorization and expires normally',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;});const p=await f.i.preview(zip(plugin()));
 for(let n=0;n<5;n++)assert.equal(f.i.previewStatus(p.token).token,p.token);
 assert.equal(calls,0);assert(!fs.existsSync(p.target));
 const second=await f.i.preview(zip(plugin())),third=await f.i.preview(zip(plugin()));
 await assert.rejects(f.i.preview(zip(plugin())),/Close an existing/);
 f.i.discard(second.token);f.i.discard(third.token);
 f.i.confirm(p.token);assert.throws(()=>f.i.previewStatus(p.token),e=>e.status===409);
 assert.equal((await finish(f.i,p.token)).state,'succeeded');assert.equal(calls,1);
 const pending=await f.i.preview(zip(plugin()));f.e.clock(pending.expiresAt+1);
 assert.throws(()=>f.i.previewStatus(pending.token),e=>e.status===404);await f.i.close();
});
