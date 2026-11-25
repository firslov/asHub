const test=require('node:test'),assert=require('node:assert/strict'),{once}=require('node:events');
const {createHash}=require('node:crypto');
const {env,Bridge,fs,path,root}=require('./harness.cjs');

function installPublisher(dir,id,name,status,settingsTarget,hostApi){
 const plugin=path.join(dir,'extensions',id);
 fs.mkdirSync(plugin,{recursive:true});
 fs.writeFileSync(path.join(plugin,'package.json'),JSON.stringify({name:id,version:'1.0.0',type:'module'}));
 const ui=settingsTarget ? {version:1,panels:[{id:'remote',title:name,components:[{type:'resource',id:'settings'}]}]} : undefined;
 fs.writeFileSync(path.join(plugin,'ashub-plugin.json'),JSON.stringify({schemaVersion:2,id,name,entries:{application:'app.mjs'},requires:{hostApi,capabilities:['shared-conversations','plugin-secrets']},ui}));
 fs.writeFileSync(path.join(plugin,'app.mjs'),`export function activate(ctx){
  ctx.services.sharedConversations.registerStatus(()=>(${JSON.stringify(status)}),${JSON.stringify(settingsTarget==='explicit'?'settings':undefined)});
  ${settingsTarget?`let revealed=0;
    ctx.services.interactions.register('settings',{view:()=>({rows:[],actions:[],note:String(revealed)}),prepare(){throw Error('No actions');},onReveal(){revealed++;}});`:''}
 }`);
}

async function startFixture(t,e,{legacy,vault,fault,readLegacy=()=>legacy?JSON.stringify(legacy):null}){
 e.context.process.env.ASHUB_TOKEN='migration-fixture-token';
 let sockets=0;
 const transport=e.load('src/remote/transport.ts').remoteTransport;
 t.mock.method(transport,'socket',()=>{sockets++;return{close(){}};});
 const rename=fs.renameSync;
 if(fault)t.mock.method(fs,'renameSync',(from,to)=>{if(fault(from,to))throw Error('fixture migration write failure');return rename(from,to);});
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new Bridge(o),
  remoteSecretStore:{read:readLegacy,write(){}},pluginSecretStore:{read:k=>vault.get(k)||null,write:(k,v)=>vault.set(k,v)}});
 t.after(()=>hub.shutdown());
 await once(hub.server,'listening');
 const base='http://127.0.0.1:'+hub.server.address().port;
 const headers={Authorization:'Bearer migration-fixture-token','X-Ashub-Local':'1'};
 const get=async route=>(await fetch(base+route,{headers})).json();
 const setEnabled=async (feature,enabled)=>fetch(base+'/api/extensions/'+feature+'/enabled',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({enabled})});
 const features=async names=>{
  for(let i=0;i<100;i++){
   const {features}=await get('/api/extensions');
   if(names.every(name=>features.some(entry=>entry.name===name&&entry.state==='active')))return features;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Expected plugins did not activate: '+names.join(', '));
 };
 return {get,features,setEnabled,shutdown:hub.shutdown,remoteStatus:hub.remoteStatus,settingsTarget:hub.remoteSettingsTarget,sockets:()=>sockets};
}

const online={available:true,enabled:true,status:'online',deviceName:'Independent'};
const disabled={available:true,enabled:false,status:'disabled'};

function historicalFixture(options={}){
 const e=env({globals:{fetch,WebSocket,setTimeout,clearTimeout,setInterval,clearInterval,Response,ReadableStream}});
 const settings=path.join(e.dir,'settings.json'),sessionsDir=path.join(e.dir,'hub-sessions');
 const legacy={deviceId:'historical-device',deviceToken:'legacy-fixture',username:'old-owner',deviceName:'Old publisher',roots:[fs.realpathSync(e.dir)]};
 const install=(compatible=false)=>installPublisher(e.dir,'ashub-multi-machine','Historical publisher',online,undefined,compatible?undefined:'^999.0.0');
 install(options.compatible);
 const target=e.load('src/plugins.ts').pluginCatalog(settings).find(entry=>entry.manifest?.id==='ashub-multi-machine');
 const key=createHash('sha256').update(target.id+'\0device').digest('hex');
 const staged={...legacy,grantId:'historical-grant',legacyMigrationPending:true,...options.staged};
 const vault=new Map([[key,JSON.stringify(staged)]]);
 const grants={'historical-grant':{pluginId:target.id,roots:legacy.roots},...options.grants};
 const marker={version:1,pluginId:target.id,...options.marker};
 const files={marker:path.join(sessionsDir,'device-interconnect-migrated.json'),grants:path.join(sessionsDir,'sharing-grants.json'),
  legacy:path.join(sessionsDir,'remote','remote-requests.json'),target:path.join(sessionsDir,'plugin-data',target.id,'remote-requests.json')};
 const save=(name,value)=>{const file=files[name];fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
 const read=name=>JSON.parse(fs.readFileSync(files[name],'utf8'));
 const id=legacy.deviceId+':', done={digest:'same-digest',state:'done',result:{ok:true}}, pending={digest:done.digest,state:'pending'};
 save('marker',marker);save('grants',grants);
 save('legacy',{[id+'before']:pending});
 save('target',{[id+'before']:done,[id+'plugin-only']:done,'other-device:private':done});
 const assertAuth=()=>{assert.deepEqual([...vault],[[key,JSON.stringify(staged)]]);assert.deepEqual(read('grants'),grants);};
 return {e,target,legacy,vault,settings,install,files,marker,save,read,id,done,pending,assertAuth};
}

for(const stopDuringFallback of [false,true])test(`completed migration transfers receipts both ways${stopDuringFallback?' and preserves a local stop':''}`,async t=>{
 const h=historicalFixture();
 const fallback=await startFixture(t,h.e,h);
 const features=await fallback.features(['移动访问']);
 assert.equal(fallback.sockets(),1);
 assert(!features.some(entry=>entry.pluginId===h.target.id));
 assert.equal((await fallback.get('/api/mobile')).deviceName,h.legacy.deviceName);
 assert.deepEqual(h.read('marker'),{...h.marker,legacyFallback:true});
 assert.deepEqual(h.read('legacy'),{[h.id+'before']:h.done,[h.id+'plugin-only']:h.done});
 h.assertAuth();
 if(stopDuringFallback)assert.equal((await fallback.setEnabled('mobile-access',false)).status,200);
 await fallback.shutdown();
 // Stand in for a receipt durably written by the fallback during the last run.
 const fallbackReceipts={...h.read('legacy'),[h.id+'fallback-only']:h.done};
 h.save('legacy',fallbackReceipts);
 h.install(true);
 const repaired=await startFixture(t,h.e,h);
 assert.equal(repaired.sockets(),0,'the old connector must stay off after handoff');
 if(stopDuringFallback){
  const target=h.e.load('src/plugins.ts').pluginCatalog(h.settings).find(entry=>entry.id===h.target.id);
  assert.equal(target.enabled,false,'compatibility must not re-enable remote access stopped during fallback');
 }else assert(!(await repaired.features(['Historical publisher'])).some(entry=>entry.id==='mobile-access'));
 assert.deepEqual(h.read('target'),{...fallbackReceipts,'other-device:private':h.done});
 assert.deepEqual(h.read('marker'),h.marker);
 h.assertAuth();
});

test('a compatible completed migration with no fallback takes the original path',async t=>{
 const h=historicalFixture({compatible:true});
 const fixture=await startFixture(t,h.e,{...h,readLegacy:()=>{throw Error('must not read legacy credentials');}});
 assert(!(await fixture.features(['Historical publisher'])).some(entry=>entry.id==='mobile-access'));
 assert.equal(fixture.sockets(),0);
 assert.deepEqual(h.read('legacy'),{[h.id+'before']:h.pending});
 assert.deepEqual(h.read('marker'),h.marker);
 h.assertAuth();
});

for(const kind of ['different token','revoked grant','different marker','duplicate publisher','disabled target','identity changed at launch'])test(`completed migration does not reopen the old publisher: ${kind}`,async t=>{
 const h=historicalFixture({staged:kind==='different token'?{deviceToken:'different-fixture'}:undefined,
  grants:kind==='revoked grant'?{'historical-grant':{pluginId:'unrelated-plugin',roots:['/tmp']}}:undefined,
  marker:kind==='different marker'?{pluginId:'unrelated-plugin'}:undefined});
 if(kind==='duplicate publisher'){
  const packages=path.join(h.e.dir,'extensions');
  fs.cpSync(path.join(packages,'ashub-multi-machine'),path.join(packages,'second-publisher'),{recursive:true});
 }
 if(kind==='disabled target')fs.writeFileSync(h.settings,JSON.stringify({'ashub.plugins.disabled':[h.target.id]}));
 let reads=0;
 const guarded=kind==='identity changed at launch';
 const fixture=await startFixture(t,h.e,{...h,...(guarded&&{readLegacy:()=>JSON.stringify(++reads===1?h.legacy:{...h.legacy,deviceToken:'rotated-fixture'})})});
 if(guarded){
  await fixture.features(['移动访问']);
  assert.equal((await fixture.get('/api/mobile')).status,'error');
 }else assert(!(await fixture.get('/api/extensions')).features.some(entry=>entry.id==='mobile-access'));
 assert.equal(fixture.sockets(),0);
 assert.deepEqual(h.read('marker'),guarded?{...h.marker,legacyFallback:true}:h.marker);
 h.assertAuth();
});

test('empty historical journals are durably initialized before fallback can publish',async t=>{
 const h=historicalFixture();
 fs.unlinkSync(h.files.legacy);fs.unlinkSync(h.files.target);
 const fixture=await startFixture(t,h.e,h);
 await fixture.features(['移动访问']);
 assert.equal(fixture.sockets(),1);
 assert.deepEqual(h.read('legacy'),{});
 assert.deepEqual(h.read('marker'),{...h.marker,legacyFallback:true});
 h.assertAuth();
});

for(const kind of ['conflicting digest at takeover','journal write fails at takeover','marker write fails at takeover','journal write fails at handoff','journal missing at handoff','identity no longer matches at handoff'])test(`completed migration pauses both publishers: ${kind}`,async t=>{
 const handoff=kind.endsWith('at handoff');
 const h=historicalFixture({compatible:handoff,marker:handoff?{legacyFallback:true}:undefined,
  staged:kind.startsWith('identity')?{deviceToken:'other-fixture'}:undefined});
 if(handoff)h.save('legacy',{...h.read('legacy'),[h.id+'fallback-only']:h.done});
 if(kind.startsWith('conflicting'))h.save('legacy',{[h.id+'before']:{...h.pending,digest:'different-digest'}});
 const missing=kind==='journal missing at handoff';
 if(missing)fs.unlinkSync(h.files.legacy);
 const originalLegacy=missing?undefined:h.read('legacy'),originalTarget=h.read('target');
 const markerFault=kind==='marker write fails at takeover';
 const faultFile=markerFault?h.files.marker:kind.startsWith('journal write')?h.files[handoff?'target':'legacy']:undefined;
 const fixture=await startFixture(t,h.e,{...h,fault:faultFile?(_from,to)=>to===faultFile:undefined});
 const {features}=await fixture.get('/api/extensions');
 assert(!features.some(entry=>entry.id==='mobile-access'||entry.pluginId===h.target.id));
 assert.equal(fixture.sockets(),0);
 if(missing) assert(!fs.existsSync(h.files.legacy));
 else assert.deepEqual(h.read('legacy'),markerFault?{[h.id+'before']:h.done,[h.id+'plugin-only']:h.done}:originalLegacy);
 assert.deepEqual(h.read('target'),originalTarget);
 assert.deepEqual(h.read('marker'),h.marker);
 h.assertAuth();
});

for(const existing of ['none','staged','same device','independent'])test(`incompatible interconnect keeps the old connection (${existing})`,async t=>{
 const e=env({globals:{fetch,WebSocket,setTimeout,clearTimeout,setInterval,clearInterval,Response,ReadableStream}});
 const settings=path.join(e.dir,'settings.json'),sessionsDir=path.join(e.dir,'hub-sessions');
 const legacy={deviceId:'old-device',deviceToken:'old-fixture',username:'old-owner',deviceName:'Legacy',roots:[fs.realpathSync(e.dir)]};
 installPublisher(e.dir,'ashub-multi-machine','Incompatible interconnect',online,undefined,'^999.0.0');
 const {pluginCatalog}=e.load('src/plugins.ts');
 const target=pluginCatalog(settings).find(entry=>entry.manifest?.id==='ashub-multi-machine');
 assert.match(target.compatibilityError,/Host API \^999\.0\.0 required/);
 const key=createHash('sha256').update(target.id+'\0device').digest('hex');
 const credential=JSON.stringify({...legacy,deviceId:existing==='same device'?legacy.deviceId:'previous-device',grantId:'existing-grant',legacyMigrationPending:existing==='staged'});
 const initial=existing==='none'?[]:[[key,credential]];
 const vault=new Map(initial);
 const journal=path.join(sessionsDir,'remote','remote-requests.json');
 fs.mkdirSync(path.dirname(journal),{recursive:true});
 fs.writeFileSync(journal,JSON.stringify({'old-device:request':{digest:'fixture',state:'done'}}));
 const fixture=await startFixture(t,e,{legacy,vault});
 assert.equal(fs.existsSync(path.join(sessionsDir,'device-interconnect-migrated.json')),false);
 assert.deepEqual([...vault],initial);
 assert.equal(fs.existsSync(path.join(sessionsDir,'sharing-grants.json')),false);
 assert.equal(fs.existsSync(path.join(sessionsDir,'plugin-data',target.id,'remote-requests.json')),false);
 const features=await fixture.features(['移动访问']);
 const candidate=features.find(entry=>entry.pluginId===target.id);
 if(existing==='staged'||existing==='same device') assert.equal(candidate,undefined,'suppress a potential second publisher even after an in-process upgrade');
 else assert.equal(candidate?.state,'error','leave the unshared target visible for updates');
 assert.equal(fixture.sockets(),1);
 assert.equal(fixture.remoteStatus().deviceName,legacy.deviceName);
 assert.equal((await fixture.get('/api/mobile')).status,'connecting');
});

test('a session-only interconnect is not an application migration target',t=>{
 const e=env(),settingsFile=path.join(e.dir,'settings.json'),sessionsDir=path.join(e.dir,'hub-sessions');
 installPublisher(e.dir,'ashub-multi-machine','Session-only interconnect',disabled);
 const manifestFile=path.join(e.dir,'extensions','ashub-multi-machine','ashub-plugin.json');
 const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 fs.writeFileSync(manifestFile,JSON.stringify({...manifest,entries:{session:'app.mjs'}}));
 const target=e.load('src/plugins.ts').pluginCatalog(settingsFile).find(entry=>entry.manifest?.id==='ashub-multi-machine');
 assert.equal(target.compatibilityError,undefined);
 assert.equal(target.applicationSpecifier,undefined);
 const legacy={deviceId:'old-device',deviceToken:'old-fixture',username:'old-owner',roots:[e.dir]};
 const write=t.mock.fn(),bind=t.mock.fn(),importGrant=t.mock.fn();
 const {migrateDeviceInterconnect,DeviceMigrationConflict}=e.load('src/remote/migration.ts');
 assert.throws(()=>migrateDeviceInterconnect({settingsFile,sessionsDir,legacy:{read:()=>JSON.stringify(legacy)},
  secrets:{read:()=>null,write},sharing:{bind,importGrant}}),error=>!(error instanceof DeviceMigrationConflict)&&/application entry/.test(error.message));
 assert.equal(write.mock.callCount()+bind.mock.callCount()+importGrant.mock.callCount(),0);
 assert.equal(fs.existsSync(sessionsDir),false);
});

for(const legacyEnabled of [false,true])test('independent pairing survives marker failure with legacy '+(legacyEnabled?'reconnecting':'disabled'),async t=>{
 const e=env({globals:{fetch,WebSocket,setTimeout,clearTimeout,setInterval,clearInterval,Response,ReadableStream}});
 const roots=[fs.realpathSync(e.dir)],legacy={deviceId:'old-device',deviceToken:'old-fixture',username:'old-owner',deviceName:'Legacy',enabled:legacyEnabled,roots};
 installPublisher(e.dir,'ashub-multi-machine','Independently paired interconnect',online);
 const target=e.load('src/plugins.ts').pluginCatalog(path.join(e.dir,'settings.json')).find(entry=>entry.manifest?.id==='ashub-multi-machine');
 const key=createHash('sha256').update(target.id+'\0device').digest('hex');
 const credential=JSON.stringify({deviceId:'paired-device',deviceToken:'paired-fixture',username:'other-owner',roots,enabled:true,grantId:'existing-grant'});
 const vault=new Map([[key,credential]]);
 const grantsFile=path.join(e.dir,'hub-sessions','sharing-grants.json');
 const grants={ 'existing-grant':{pluginId:target.id,roots} };
 fs.mkdirSync(path.dirname(grantsFile),{recursive:true});
 fs.writeFileSync(grantsFile,JSON.stringify(grants));
 const fixture=await startFixture(t,e,{legacy,vault,fault:(_from,to)=>to.endsWith('device-interconnect-migrated.json')});
 await fixture.features(['移动访问','Independently paired interconnect']);
 assert.equal(vault.get(key),credential);
 assert.deepEqual(JSON.parse(fs.readFileSync(grantsFile,'utf8')),grants);
 assert.equal(fixture.sockets(),Number(legacyEnabled));
 assert.equal(fixture.remoteStatus().deviceName,online.deviceName);
 assert.equal(fixture.remoteStatus().status,'online');
 const shim=await fixture.get('/api/mobile');
 assert.equal(shim.deviceName,legacy.deviceName);
 assert.equal(shim.enabled,legacyEnabled);
 assert.equal(shim.status,legacyEnabled?'connecting':'disabled');
});

test('fallback leaves an unstaged plugin available when receipt installation fails',async t=>{
 const e=env({globals:{fetch,WebSocket,setTimeout,clearTimeout,setInterval,clearInterval,Response,ReadableStream}});
 const legacy={deviceId:'old-device',deviceToken:'old-fixture',username:'old-owner',deviceName:'Legacy',roots:[fs.realpathSync(e.dir)]};
 const vault=new Map();
 installPublisher(e.dir,'ashub-multi-machine','Unconfigured interconnect',disabled);
 const legacyDir=path.join(e.dir,'hub-sessions','remote');
 fs.mkdirSync(legacyDir,{recursive:true});
 fs.writeFileSync(path.join(legacyDir,'remote-requests.json'),JSON.stringify({'old-device:request':{digest:'fixture',state:'done'}}));
 const fixture=await startFixture(t,e,{legacy,vault,fault:from=>from.endsWith('remote-requests.json.migrate')});
 await fixture.features(['移动访问','Unconfigured interconnect']);
 assert.equal(vault.size,0);
 assert.equal(fixture.sockets(),1);
 assert.equal(fixture.remoteStatus().deviceName,legacy.deviceName);
 assert.equal(fixture.remoteStatus().status,'connecting');
});

test('a staged legacy identity stays with the fallback when its first credential read fails',async t=>{
 const e=env({globals:{fetch,WebSocket,setTimeout,clearTimeout,setInterval,clearInterval,Response,ReadableStream}});
 const legacy={deviceId:'old-device',deviceToken:'old-fixture',username:'old-owner',deviceName:'Legacy',roots:[fs.realpathSync(e.dir)]};
 installPublisher(e.dir,'ashub-multi-machine','Staged interconnect',online);
 const target=e.load('src/plugins.ts').pluginCatalog(path.join(e.dir,'settings.json')).find(entry=>entry.manifest?.id==='ashub-multi-machine');
 const key=createHash('sha256').update(target.id+'\0device').digest('hex');
 const vault=new Map([[key,JSON.stringify({...legacy,grantId:'staged-grant',legacyMigrationPending:true})]]);
 let reads=0;
 const fixture=await startFixture(t,e,{vault,readLegacy:()=>{
  if(++reads===1)throw Error('legacy credential temporarily unavailable');
  return JSON.stringify(legacy);
 }});
 const features=await fixture.features(['移动访问']);
 assert.equal(reads,2);
 assert(!features.some(entry=>entry.pluginId===target.id));
 assert.equal(fixture.sockets(),1);
 assert.equal(fixture.remoteStatus().deviceName,legacy.deviceName);
});

test('desktop status prefers an online publisher without migration fallback',async t=>{
 const e=env({globals:{fetch,WebSocket,setTimeout,clearTimeout,setInterval,clearInterval,Response,ReadableStream}});
 installPublisher(e.dir,'disabled-sharing','Disabled sharing',disabled);
 installPublisher(e.dir,'online-sharing','Online sharing',online);
 const fixture=await startFixture(t,e,{vault:new Map()});
 const features=await fixture.features(['Disabled sharing','Online sharing']);
 assert(!features.some(entry=>entry.id==='mobile-access'));
 assert.equal(fixture.sockets(),0);
 assert.equal(fixture.remoteStatus().status,'online');
 assert.equal((await fixture.get('/api/mobile')).deviceName,online.deviceName);
});

for (const settingsTarget of ['explicit','previous']) test(`desktop opens the selected publisher settings with onReveal (${settingsTarget})`,async t=>{
 const e=env({globals:{fetch,WebSocket,setTimeout,clearTimeout,setInterval,clearInterval,Response,ReadableStream}});
 installPublisher(e.dir,'disabled-sharing','Disabled sharing',disabled,'explicit');
 installPublisher(e.dir,'online-sharing','Online sharing',online,settingsTarget);
 const fixture=await startFixture(t,e,{vault:new Map()});
 const features=await fixture.features(['Disabled sharing','Online sharing']);
 const plugin=features.find(feature=>feature.name==='Online sharing').pluginId;
 const resource='/api/plugin-resources/'+plugin+'/settings';
 assert.equal((await fixture.get(resource)).view.note,'0');
 const target=fixture.settingsTarget();
 assert.equal(target.plugin,plugin);
 assert.equal(target.resource,'settings');
 assert.equal((await fixture.get(resource)).view.note,'1','desktop reveal must reset the resource before rendering');
});

test('a migration failure opens the old connection controls and allows it to be stopped',async t=>{
 const e=env({globals:{fetch,WebSocket,setTimeout,clearTimeout,setInterval,clearInterval,Response,ReadableStream}});
 const legacy={deviceId:'old-device',deviceToken:'old-fixture',username:'old-owner',deviceName:'Legacy',roots:[fs.realpathSync(e.dir)]};
 installPublisher(e.dir,'other-sharing','Another publisher',{...online,status:'connecting'},'explicit');
 const fixture=await startFixture(t,e,{legacy,vault:new Map(),fault:(_from,to)=>to.endsWith('device-interconnect-migrated.json')});
 const features=await fixture.features(['移动访问','Another publisher']);
 const target=fixture.settingsTarget();
 assert.equal(target.feature,'mobile-access','a tied publisher must not replace the legacy controls');
 assert.match(features.find(feature=>feature.id===target.feature).description,/重启 asHub 重试迁移/);
 assert.equal((await fixture.get('/api/mobile')).enabled,true);
 const disabledResponse=await fixture.setEnabled(target.feature,false);
 assert.equal(disabledResponse.status,200);
 assert.equal((await fixture.get('/api/mobile')).enabled,false);
 assert.equal(fixture.settingsTarget().plugin,features.find(feature=>feature.name==='Another publisher').pluginId);
});

test('partial migration keeps the legacy identity and leaves unrelated sharing plugins active',async t=>{
 const e=env({globals:{fetch,WebSocket,setTimeout,clearTimeout,setInterval,clearInterval,Response,ReadableStream}});
 e.context.process.env.ASHUB_TOKEN='migration-fixture-token';
 const saved=JSON.stringify({deviceId:'same-device',deviceToken:'same-token',username:'fixture',deviceName:'Workstation',roots:[fs.realpathSync(e.dir)]}),vault=new Map();
 const settings=path.join(e.dir,'settings.json'),other=path.join(e.dir,'extensions','independent-sharing');
 fs.mkdirSync(other,{recursive:true});
 fs.writeFileSync(path.join(other,'package.json'),JSON.stringify({name:'independent-sharing',version:'1.0.0',type:'module'}));
 fs.writeFileSync(path.join(other,'ashub-plugin.json'),JSON.stringify({schemaVersion:2,id:'independent-sharing',name:'Independent sharing',entries:{application:'app.mjs'},requires:{capabilities:['shared-conversations']}}));
 fs.writeFileSync(path.join(other,'app.mjs'),`export function activate(ctx){if(!ctx.services.sharedConversations)throw Error('missing bound sharing service');}`);
 const {pluginCatalog}=e.load('src/plugins.ts');
 const target=pluginCatalog(settings).find(entry=>entry.manifest?.id==='ashub-multi-machine');
 let sockets=0;const transport=e.load('src/remote/transport.ts').remoteTransport;
 t.mock.method(transport,'socket',()=>{sockets++;return{close(){}};});
 const rename=fs.renameSync;t.mock.method(fs,'renameSync',(from,to)=>{if(to.endsWith('device-interconnect-migrated.json'))throw Error('marker unavailable');return rename(from,to);});
 const hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new Bridge(o),remoteSecretStore:{read:()=>saved,write(){}},pluginSecretStore:{read:k=>vault.get(k)||null,write:(k,v)=>vault.set(k,v)}});
 t.after(()=>hub.shutdown());await once(hub.server,'listening');const base='http://127.0.0.1:'+hub.server.address().port,headers={Authorization:'Bearer migration-fixture-token','X-Ashub-Local':'1','Content-Type':'application/json'};
 let features;for(let i=0;i<100;i++){features=(await(await fetch(base+'/api/extensions',{headers})).json()).features;if(features.some(f=>f.id==='mobile-access'&&f.state==='active')&&features.some(f=>f.name==='Independent sharing'&&f.state==='active'))break;await new Promise(r=>setTimeout(r,10));}
 assert(features.some(f=>f.id==='mobile-access'&&f.state==='active'));
 assert(features.some(f=>f.name==='Independent sharing'&&f.state==='active'),JSON.stringify(features));
 assert(!features.some(f=>f.pluginId===target.id));
 assert.equal(sockets,1);assert.equal(vault.size,1,'credentials copied before the marker failure');
 const staged=JSON.parse([...vault.values()][0]);
 assert.equal(staged.deviceId,'same-device');assert.equal(staged.deviceToken,'same-token');
 const grants=JSON.parse(fs.readFileSync(path.join(e.dir,'hub-sessions','sharing-grants.json'),'utf8'));
 assert.deepEqual(grants[staged.grantId],{pluginId:target.id,roots:[fs.realpathSync(e.dir)]});
 const status=await(await fetch(base+'/api/mobile',{headers})).json();assert.equal(status.enabled,true);assert.equal(status.deviceName,'Workstation');
 assert.equal((await fetch(base+'/sessions',{headers,method:'POST',body:JSON.stringify({cwd:e.dir})})).status,200);
});
