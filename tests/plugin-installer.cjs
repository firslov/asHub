const test=require('node:test'),assert=require('node:assert/strict');
const {env,fs,path}=require('./harness.cjs'),{zip,plugin}=require('./plugin-zip-fixture.cjs');
const manifest={schemaVersion:1,id:'sample-plugin',name:'Sample'};
async function finish(installer,id){for(let i=0;i<200;i++){const j=installer.status(id);if(j.state!=='running')return j;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');}
function fixture(run,extra={}) {
 const {runtimes,inUse,...envExtra}=extra,e=env({globals:{setTimeout,clearTimeout},...envExtra});
 // Match the simulated macOS 14.4 platform in the synchronous host checks.
 e.os.release=()=> '23.4.0';
 const {PluginInstaller}=e.load('src/plugin-installer.ts'),file=path.join(e.dir,'settings.json');
 return {e,file,i:new PluginInstaller(file,run|| (async()=>{}),'darwin',inUse,undefined,10000,runtimes)};
}
test('confirmation and final commit reject a runtime different from the approved preview',async t=>{
 for(const when of ['confirm','commit','version'])await t.test(when,async()=>{
  let selected='/fixture/approved/python3', version='3.12.8', setupCalls=0;
  const f=fixture(async script=>{
   if(script.endsWith('setup.mjs')){setupCalls++;if(when==='commit')selected='/fixture/other/python3';}
  },{runtimes:{probePython:async()=>({kind:'python',ok:true,path:selected,version,detail:selected})}});
  const p=await f.i.preview(zip(plugin({'release/setup.mjs':'export {}'},{
   ...manifest,runtimes:[{kind:'python',version:'>=3.12'}],setup:{script:'setup.mjs',description:'Prepare runtime'}
  })));
  if(when==='confirm')selected='/fixture/other/python3';
  if(when==='version')version='3.12.9';
  const j=await finish(f.i,f.i.confirm(p.token).id);
  assert.equal(j.state,'failed'); assert.match(j.error,/runtime.*changed/i);
  assert.equal(setupCalls,when==='commit'?1:0);assert(!fs.existsSync(p.target));
  await f.i.close();
 });
});
test('an explicit refreshed preview approves the new executable for setup',async()=>{
 let selected='/fixture/original/git';
 const paths=[],f=fixture(async(script,_args,_cwd,_home,_data,_signal,setupEnv)=>{
  if(script.endsWith('setup.mjs'))paths.push(setupEnv.ASHUB_RUNTIME_GIT);
 },{runtimes:{probeGit:async()=>({kind:'git',ok:true,path:selected,version:'2.51.0',detail:selected})}});
 const p=await f.i.preview(zip(plugin({'release/setup.mjs':'export {}'},{
  ...manifest,runtimes:[{kind:'git',version:'>=2.50'}],setup:{script:'setup.mjs',description:'Prepare runtime'}
 })));
 selected='/fixture/new/git';
 const refreshed=await f.i.previewStatus(p.token);
 assert(refreshed.canInstall);
 assert.throws(()=>f.i.confirm(p.token,p.environmentRevision),error=>error.status===409);
 assert.deepEqual(paths,[]);
 assert.notEqual(refreshed.environmentRevision,p.environmentRevision);
 const started=f.i.confirm(p.token,refreshed.environmentRevision);
 assert.equal(f.i.confirm(p.token,refreshed.environmentRevision).id,started.id);
 assert.throws(()=>f.i.confirm(p.token,p.environmentRevision),error=>error.status===409);
 const j=await finish(f.i,started.id);
 assert.equal(j.state,'succeeded',j.error);assert.deepEqual(paths,[selected]);
 assert.equal(f.i.confirm(p.token,refreshed.environmentRevision).state,'succeeded');
 assert.throws(()=>f.i.confirm(p.token,p.environmentRevision),error=>error.status===409);
 await f.i.close();
});
test('a slow refresh from one window cannot overwrite the newer preview shown in another', async t => {
 let selected = '/fixture/first/git';
 let holdProbe = false;
 const entered = Promise.withResolvers(), release = Promise.withResolvers();
 const paths = [], f = fixture(async (script, _args, _cwd, _home, _data, _signal, setupEnv) => {
  if (script.endsWith('setup.mjs')) paths.push(setupEnv.ASHUB_RUNTIME_GIT);
 },{ runtimes: { probeGit: async () => {
  const candidate = selected;
  if (holdProbe) { holdProbe = false; entered.resolve(); await release.promise; }
  return { kind: 'git', ok: true, path: candidate, version: '2.51.0', detail: candidate };
 } } });
 t.after(async () => { release.resolve(); await f.i.close(); });
 const initial = await f.i.preview(zip(plugin({ 'release/setup.mjs': 'export {}' }, {
  ...manifest, runtimes: [{ kind: 'git', version: '>=2.50' }], setup: { script: 'setup.mjs', description: 'Prepare runtime' }
 })));
 holdProbe = true;
 const slowRefresh = f.i.previewStatus(initial.token);
 await entered.promise;
 selected = '/fixture/second/git';
 const latest = await f.i.previewStatus(initial.token);
 release.resolve();
 const delayed = await slowRefresh;
 assert.equal(delayed.environmentRevision, latest.environmentRevision);
 assert.notEqual(latest.environmentRevision, initial.environmentRevision);
 assert.throws(() => f.i.confirm(initial.token, initial.environmentRevision), error => error.status === 409);
 const job = await finish(f.i, f.i.confirm(latest.token, latest.environmentRevision).id);
 assert.equal(job.state, 'succeeded', job.error);
 assert.deepEqual(paths, [selected]);
});
test('a preview invalidated while probing releases its staging directory and slot', async t => {
 const entered = Promise.withResolvers(), release = Promise.withResolvers();
 const f = fixture(undefined,{ runtimes: { probeGit: async () => {
  entered.resolve();
  await release.promise;
  return { kind: 'git', ok: true, path: '/fixture/git', version: '2.51.0', detail: 'Git ready' };
 } } });
 t.after(async () => { release.resolve(); await f.i.close(); });
 const requestId = 'stale-window-preview-0001';
 const pending = f.i.preview(zip(plugin({}, { ...manifest, runtimes: [{kind: 'git', version: '>=2.50'}] })), requestId);
 const stale = assert.rejects(pending, /Installed plugin changed/);
 await entered.promise;
 const other = await f.i.preview(zip(plugin()));
 const installed = await finish(f.i, f.i.confirm(other.token, other.environmentRevision).id);
 assert.equal(installed.state, 'succeeded', installed.error);
 release.resolve();
 await stale;
 assert.equal((await f.i.listPreviews(requestId)).length, 0);
 assert.deepEqual(fs.readdirSync(path.join(f.e.dir, 'plugin-install/staging')), []);
 const reopened = await f.i.preview(zip(plugin()), requestId);
 assert.equal(reopened.previousVersion, '1.0.0');
});
test('committing an install removes other previews for its target and retires in-flight refreshes', async t => {
 const entered = Promise.withResolvers(), release = Promise.withResolvers();
 let holdRefresh = false;
 const f = fixture(undefined, { runtimes: { probeGit: async () => {
  if (holdRefresh) { entered.resolve(); await release.promise; }
  return { kind: 'git', ok: true, path: '/fixture/git', version: '2.51.0', detail: 'Git ready' };
 } } });
 t.after(async () => { release.resolve(); await f.i.close(); });
 const requestId = 'already-shown-preview-0001';
 const obsolete = await f.i.preview(zip(plugin({}, { ...manifest, runtimes: [{ kind: 'git', version: '>=2.50' }] })), requestId);
 const approved = await f.i.preview(zip(plugin()));
 const unrelatedId = 'independent-plugin';
 const independent = await f.i.preview(zip(plugin({ 'release/package.json': JSON.stringify({ name: unrelatedId, version: '1.0.0' }) }, { ...manifest, id: unrelatedId })));
 holdRefresh = true;
 const refreshing = f.i.previewStatus(obsolete.token).then(() => null, error => error);
 await entered.promise;
 const installed = await finish(f.i, f.i.confirm(approved.token, approved.environmentRevision).id);
 assert.equal(installed.state, 'succeeded', installed.error);
 assert.equal((await f.i.listPreviews(requestId)).length, 0);
 assert.deepEqual(fs.readdirSync(path.join(f.e.dir, 'plugin-install/staging')), [independent.token]);
 release.resolve();
 assert.equal((await refreshing)?.status, 404);
 assert.equal(f.i.status(approved.token).state, 'succeeded');
 assert.equal((await f.i.previewStatus(independent.token)).canInstall, true);
});
test('finished jobs remain queryable without taking preview slots after windows close', async t => {
 let fail = false;
 const f = fixture(async () => { if (fail) throw Error('fixture validation failed'); });
 t.after(() => f.i.close());
 const completed = [];
 for (const expected of ['succeeded', 'failed', 'succeeded']) {
  fail = expected === 'failed';
  const p = await f.i.preview(zip(plugin()));
  const job = await finish(f.i, f.i.confirm(p.token, p.environmentRevision).id);
  assert.equal(job.state, expected);
  completed.push(job);
 }
 const reopened = await f.i.preview(zip(plugin()));
 assert(reopened.canInstall);
 for (const job of completed) assert.equal(f.i.status(job.id).state, job.state);
});
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
 const os=await f.i.preview(zip(plugin({'release/package.json':JSON.stringify({name:'sample-plugin',version:'1.0.0',os:['win32']})})));assert.equal(os.canInstall,false);f.i.discard(os.token);
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
 for(let n=0;n<100&&!release;n++)await new Promise(resolve=>setImmediate(resolve));release();
 assert.equal((await finish(f.i,p.token)).state,'succeeded');assert.throws(()=>f.i.confirm(other.token),/expired/);
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
 const commands=[],runtimes={probeNpm:async()=>({kind:'npm',ok:true,path:'/fixture/npm-cli.js',version:'12.0.2',detail:'npm 12.0.2'})};
 const f=fixture(async(script,args,_cwd,_home,_data,_signal,env)=>commands.push([script,args,env]),{runtimes});
 const deps={'release/package.json':JSON.stringify({name:'sample-plugin',version:'1.0.0',dependencies:{sample:'1.0.0'}})};
 await assert.rejects(f.i.preview(zip(plugin(deps))),/package-lock/);
 const preview=await f.i.preview(zip(plugin({...deps,'release/package-lock.json':'{}'})));
 assert(preview.canInstall,JSON.stringify(preview.checks));assert.equal((await finish(f.i,f.i.confirm(preview.token).id)).state,'succeeded');
 assert.equal(commands[0][0],'/fixture/npm-cli.js');assert.deepEqual(Array.from(commands[0][1]),['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund']);
 assert.equal(commands[0][2].ASHUB_NPM_CLI,'/fixture/npm-cli.js');
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
 let calls=0;const f=fixture(async()=>{calls++;});const p=await f.i.preview(zip(plugin()),'preview-request-0001');
 for(let n=0;n<5;n++)assert.equal((await f.i.previewStatus(p.token)).token,p.token);
 assert.equal(calls,0);assert(!fs.existsSync(p.target));
 const duplicate=await f.i.preview(zip(plugin()),'preview-request-0001');assert.equal(duplicate.token,p.token);
 const second=await f.i.preview(zip(plugin()),'preview-request-0002'),third=await f.i.preview(zip(plugin()),'preview-request-0003');
 assert.deepEqual(Array.from(await f.i.listPreviews('preview-request-0003'),item=>item.token),[third.token]);assert.equal((await f.i.listPreviews('')).length,0);
 await assert.rejects(f.i.preview(zip(plugin())),/Close an existing/);
 f.i.discard(second.token);f.i.discard(third.token);
 f.i.confirm(p.token);assert.equal((await f.i.listPreviews('preview-request-0001')).length,0);await assert.rejects(f.i.previewStatus(p.token),e=>e.status===409);
 assert.equal((await finish(f.i,p.token)).state,'succeeded');assert.equal(calls,1);
 const pending=await f.i.preview(zip(plugin()));f.e.clock(pending.expiresAt+1);
 await assert.rejects(f.i.previewStatus(pending.token),e=>e.status===404);await f.i.close();
});


test('duplicate uploads and recovery requests share an in-flight preview',{timeout:3000},async t=>{
 let probes=0,release;const gate=new Promise(resolve=>{release=resolve;}),runtimes={probeNpm:async()=>{probes++;await gate;return{kind:'npm',ok:true,path:'/fixture/npm-cli.js',detail:'npm ready'};}};
 const f=fixture(async()=>{},{runtimes}),deps={'release/package.json':JSON.stringify({name:'sample-plugin',version:'1.0.0',dependencies:{sample:'1.0.0'}}),'release/package-lock.json':'{}'};
 t.after(async()=>{release();await f.i.close();});
 const requestId='shared-preview-request-0001',bytes=zip(plugin(deps));
 const first=f.i.preview(bytes,requestId),second=f.i.preview(bytes,requestId);
 const recovering=f.i.listPreviews(requestId);
 const unrelated=await f.i.listPreviews('unrelated-preview-request-001');
 release();
 const [a,b,recovered]=await Promise.all([first,second,recovering]);
 assert.equal(a.token,b.token);assert.equal(probes,1);
 assert.equal(unrelated.length,0);assert.equal(recovered.length,1);assert.equal(recovered[0].token,a.token);
});

test('npm dependency install ignores inherited script allowlists without changing setup or registry settings', async()=>{
 const {EventEmitter}=require('node:events');
 const inherited={npm_config_allow_scripts:'*',NPM_CONFIG_ALLOW_SCRIPTS:'another-package',npm_config_registry:'https://registry.example.invalid',npm_config_proxy:'http://127.0.0.1:1234',KEEP_PLUGIN_SETTING:'keep'};
 const invocations=[];
 const e=env({globals:{setTimeout,clearTimeout,process:{...process,env:inherited}},modules:{'node:child_process':{execFile(file,args,options,callback){
  invocations.push({file,args,options});const child=new EventEmitter();child.kill=()=>true;
  setImmediate(()=>{callback(null,'','');child.emit('close',0);});return child;
 }}}});
 const {runPluginSetup}=e.load('src/plugin-installer.ts');
 await runPluginSetup('/npm/bin/npm-cli.js',['ci','--ignore-scripts'],e.dir,e.dir,e.dir,new AbortController().signal);
 const child=invocations[0].options.env;
 assert.equal(child.npm_config_allow_scripts,undefined);assert.equal(child.NPM_CONFIG_ALLOW_SCRIPTS,undefined);
 assert.equal(child.npm_config_registry,inherited.npm_config_registry);assert.equal(child.npm_config_proxy,inherited.npm_config_proxy);
 assert.equal(child.KEEP_PLUGIN_SETTING,'keep');assert.equal(child.ELECTRON_RUN_AS_NODE,'1');
 assert.equal(inherited.npm_config_allow_scripts,'*');assert.equal(inherited.NPM_CONFIG_ALLOW_SCRIPTS,'another-package');
 assert.deepEqual(Array.from(invocations[0].args).slice(1),['ci','--ignore-scripts']);
 await runPluginSetup('/plugin/setup.mjs',[],e.dir,e.dir,e.dir,new AbortController().signal);
 assert.equal(invocations[1].options.env.npm_config_allow_scripts,'*','explicit setup retains its environment');
});

test('runtime preview can be refreshed after installing the missing tool',async()=>{
 let available=false,calls=0;const runtimes={probeNpm:async()=>({kind:'npm',ok:available,path:available?'/fixture/npm-cli.js':undefined,detail:available?'npm ready':'npm not found'})};
 const f=fixture(async()=>{calls++;},{runtimes}),deps={'release/package.json':JSON.stringify({name:'sample-plugin',version:'1.0.0',dependencies:{sample:'1.0.0'}}),'release/package-lock.json':'{}'};
 const preview=await f.i.preview(zip(plugin(deps)));assert(!preview.canInstall);assert.throws(()=>f.i.confirm(preview.token),/prerequisites/);
 available=true;const refreshed=await f.i.previewStatus(preview.token);assert(refreshed.canInstall,JSON.stringify(refreshed.checks));
 assert.equal((await finish(f.i,f.i.confirm(preview.token).id)).state,'succeeded');assert(calls>0);await f.i.close();
});

test('runtime loss after preview blocks all side effects and repeated confirm stays idempotent',async()=>{
 let available=true,calls=0;const runtimes={probeNpm:async()=>({kind:'npm',ok:available,path:available?'/fixture/npm-cli.js':undefined,detail:available?'npm ready':'npm removed'})};
 const f=fixture(async()=>{calls++;},{runtimes}),deps={'release/package.json':JSON.stringify({name:'sample-plugin',version:'1.0.0',dependencies:{sample:'1.0.0'}}),'release/package-lock.json':'{}'};
 const preview=await f.i.preview(zip(plugin(deps)));assert(preview.canInstall);available=false;
 const job=f.i.confirm(preview.token);assert.equal(f.i.confirm(preview.token).id,job.id);const result=await finish(f.i,job.id);
 assert.equal(result.state,'failed');assert.match(result.error,/prerequisites/);assert.equal(calls,0);assert(!fs.existsSync(preview.target));await f.i.close();
});

test('declared macOS and Python requirements gate setup and inject the selected runtime',async()=>{
 const invocations=[],runtimes={
  probeMacOS:async minimum=>({kind:'macos',ok:true,version:'14.4.0',detail:`macOS 14.4.0 / >=${minimum}`}),
  probePython:async range=>({kind:'python',ok:true,path:'/opt/homebrew/bin/python3',version:'3.12.8',detail:`Python 3.12.8 / ${range}`}),
 };
 const f=fixture(async(...args)=>invocations.push(args),{runtimes});
 const requirements={...manifest,platforms:['darwin'],system:{minMacOS:'14.0.0',arch:[process.arch]},runtimes:[{kind:'python',version:'>=3.12.0'}],setup:{script:'setup.mjs',description:'Prepare Python'}};
 const preview=await f.i.preview(zip(plugin({'release/setup.mjs':'// setup'},requirements)));
 assert(preview.canInstall,JSON.stringify(preview.checks));assert(preview.checks.some(c=>c.label==='system'&&c.ok));assert(preview.checks.some(c=>c.label==='runtime'&&c.ok));
 assert.equal((await finish(f.i,f.i.confirm(preview.token).id)).state,'succeeded');
 const setup=invocations.find(args=>String(args[0]).endsWith('setup.mjs'));assert(setup);assert.equal(setup[6].ASHUB_RUNTIME_PYTHON,'/opt/homebrew/bin/python3');await f.i.close();
});

test('final runtime probes cannot reopen busy, fingerprint or cancellation commit windows',async()=>{
 for(const mode of ['busy','fingerprint','cancel']){
  let active=false,probes=0,entered=false,release;const gate=new Promise(resolve=>{release=resolve;});
  const runtimes={probePython:async()=>{probes++;if(probes===3){entered=true;await gate;}return{kind:'python',ok:true,path:'/fixture/python3',detail:'Python ready'};}};
  const f=fixture(async()=>{},{runtimes,inUse:()=>active}),target=path.join(f.e.dir,'extensions/sample-plugin');fs.mkdirSync(target,{recursive:true});
  fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'sample-plugin',version:'0.9.0'}));fs.writeFileSync(path.join(target,'index.mjs'),'old');
  const requirements={...manifest,runtimes:[{kind:'python',version:'>=3.12.0'}],setup:{script:'setup.mjs',description:'Prepare Python'}};
  const preview=await f.i.preview(zip(plugin({'release/setup.mjs':'// setup'},requirements))),job=f.i.confirm(preview.token);
  for(let n=0;n<100&&!entered;n++)await new Promise(resolve=>setImmediate(resolve));assert(entered,`final probe not reached: ${mode}`);
  if(mode==='cancel'){
   const closing=f.i.close();release();await closing;assert.equal(fs.readFileSync(path.join(target,'index.mjs'),'utf8'),'old');continue;
  }
  if(mode==='busy')active=true;else fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name:'sample-plugin',version:'0.9.1'}));
  release();const result=await finish(f.i,job.id);assert.equal(result.state,'failed',mode);assert.match(result.error,/final runtime checks/);
  assert.equal(fs.readFileSync(path.join(target,'index.mjs'),'utf8'),'old');await f.i.close();
 }
});

test('missing declared Python prevents setup before any package or runtime side effect',async()=>{
 let calls=0;const runtimes={
  probeMacOS:async()=>({kind:'macos',ok:true,detail:'macOS 14.4.0'}),
  probePython:async()=>({kind:'python',ok:false,detail:'Python >=3.12.0 was not found'}),
 };
 const f=fixture(async()=>{calls++;},{runtimes});
 const requirements={...manifest,system:{minMacOS:'14.0.0'},runtimes:[{kind:'python',version:'>=3.12.0'}],setup:{script:'setup.mjs',description:'Prepare Python'}};
 const preview=await f.i.preview(zip(plugin({'release/setup.mjs':'// setup'},requirements)));
 assert(preview.checks.some(c=>c.label==='host'&&c.ok),JSON.stringify(preview.checks));
 assert(!preview.canInstall);assert.match(preview.checks.find(c=>c.label==='runtime').detail,/not found/);assert.throws(()=>f.i.confirm(preview.token),/prerequisites/);
 assert.equal(calls,0);assert(!fs.existsSync(preview.target));await f.i.close();
});

test('uninstall retires stale upgrade previews and frees slots',async t=>{
 const f=fixture();t.after(()=>f.i.close());
 const dir=path.join(f.e.dir,'extensions/sample-plugin');fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name:'sample-plugin',version:'1.0.0',type:'module'}));
 fs.writeFileSync(path.join(dir,'index.mjs'),'export default()=>{}');
 const id=f.e.load('src/plugins.ts').pluginCatalog(f.file).find(x=>x.packageRoot===dir).id;
 const previews=[];for(let n=0;n<3;n++)previews.push(await f.i.preview(zip(plugin()),`window-request-${n}-fixture`));
 f.i.uninstall(id);
 await assert.rejects(f.i.previewStatus(previews[0].token),e=>e.status===404);
 assert.equal((await f.i.listPreviews('window-request-0-fixture')).length,0);
 const next=await f.i.preview(zip(plugin()),'new-window-request-fixture');assert(next.canInstall);
});
test('close aborts and drains initial and refreshed environment probes',async t=>{
 for(const phase of ['initial','refresh'])await t.test(phase,async()=>{
  let entered,release,count=0,aborted=false,settled=false;
  const started=new Promise(r=>{entered=r}), blocked=new Promise(r=>{release=r});
  const fake={kind:'git',ok:true,path:'/fixture/git',version:'2.50.0',detail:'fake'};
  const f=fixture(undefined,{runtimes:{probeGit:(_range,signal)=>{
   if(phase==='refresh' && ++count===1)return Promise.resolve(fake);
   entered();return new Promise((resolve,reject)=>{
    blocked.then(()=>resolve(fake));
    signal?.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});
   });
  }}});
  try{
   const archive=zip(plugin({}, {...manifest,runtimes:[{kind:'git',version:'>=2.40'}]}));
   const first=phase==='refresh'?await f.i.preview(archive):null;
   const pending=(first?f.i.previewStatus(first.token):f.i.preview(archive)).then(()=>null,e=>e).finally(()=>{settled=true;});
   await started;
   const close=f.i.close();const completed=await Promise.race([close.then(()=>true),new Promise(r=>setTimeout(()=>r(false),1000))]);
   assert.equal(completed,true,'close must not wait for a stuck probe');
   assert.equal(settled,true,'close must drain tracked preview checks');
   assert.equal(aborted,true,'runtime receives an abort signal');
   assert.equal((await pending)?.name,'AbortError');
  }finally{release();await f.i.close();}
 });
});
