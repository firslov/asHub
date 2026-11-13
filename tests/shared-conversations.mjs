import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {SharedConversations} from '../dist/extensions/shared-conversations.js';
import {migrateDeviceInterconnect} from '../dist/remote/migration.js';
import {pluginCatalog} from '../dist/plugins.js';
import {createHash} from 'node:crypto';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'device-sharing-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('legacy identity, exact grant and receipts migrate once, disabled state survives, no account credential is invented',t=>{
 for(const enabled of [true,false]){
  const dir=fixture(t),settingsFile=path.join(dir,'settings.json'),sessionsDir=path.join(dir,'hub-sessions');fs.writeFileSync(settingsFile,JSON.stringify({'ashub.features.disabled':enabled?[]:['mobile-access']}));
  fs.mkdirSync(path.join(sessionsDir,'remote'),{recursive:true});const receipts={'existing:request':{digest:'stable',state:'done',result:{ok:true}}};fs.writeFileSync(path.join(sessionsDir,'remote','remote-requests.json'),JSON.stringify(receipts));
  const original={deviceId:'existing',deviceToken:'encrypted-device-token',username:'original',deviceName:'Office',roots:[dir],enabled:true},vault=new Map();
  const sharing=new SharedConversations(path.join(dir,'grants.json')),opts={settingsFile,sessionsDir,sharing,legacy:{read:()=>JSON.stringify(original)},secrets:{read:k=>vault.get(k)||null,write:(k,v)=>vault.set(k,v)}};
  migrateDeviceInterconnect(opts);assert.equal(vault.size,1);const entry=pluginCatalog(settingsFile).find(p=>p.manifest?.id==='ashub-multi-machine'),key=createHash('sha256').update(entry.id+'\0device').digest('hex'),saved=JSON.parse(vault.get(key));
  assert.deepEqual({...saved,grantId:undefined,legacyMigrationPending:undefined},{...original,enabled,grantId:undefined,legacyMigrationPending:undefined});assert.equal(entry.enabled,enabled);
  assert.deepEqual(sharing.bind(entry.id,new AbortController().signal).scope(saved.grantId),original.roots);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sessionsDir,'plugin-data',entry.id,'remote-requests.json'))),receipts);
  vault.set(key,JSON.stringify({...saved,enabled:false}));migrateDeviceInterconnect(opts);assert.equal(JSON.parse(vault.get(key)).enabled,false,'restart cannot reset newer user choice');assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir,'grants.json')))).length,1);
 }
});
test('failed credential migration rolls back new grant and leaves original credentials and journal untouched',t=>{
 const dir=fixture(t),settingsFile=path.join(dir,'settings.json');fs.writeFileSync(settingsFile,'{}');const saved=JSON.stringify({deviceId:'old',deviceToken:'token',username:'u',roots:[dir]});const sharing=new SharedConversations(path.join(dir,'grants.json'));
 assert.throws(()=>migrateDeviceInterconnect({settingsFile,sessionsDir:dir,sharing,legacy:{read:()=>saved},secrets:{read:()=>null,write:()=>{throw Error('locked');}}}),/locked/);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'grants.json'))),{});assert(!fs.existsSync(path.join(dir,'device-interconnect-migrated.json')));assert.equal(pluginCatalog(settingsFile).find(p=>p.manifest?.id==='ashub-multi-machine').enabled,false);
});
test('host scopes local API, blocks administration and persistent approvals, filters SSE and revokes live channels',async t=>{
 const dir=fixture(t),outside=fixture(t),owner=new AbortController(),effects=[];let release;
 const server=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer host-private');let raw='';for await(const c of req)raw+=c;
  if(req.url==='/sessions')return res.end(JSON.stringify([{instanceId:'aaaa',kind:'agent',cwd:dir},{instanceId:'bbbb',kind:'agent',cwd:outside}]));
  if(req.url==='/api/settings/network')return res.end(JSON.stringify({proxyEnabled:true,sessions:{aaaa:false,bbbb:true}}));
  if(req.url.startsWith('/events?')){res.writeHead(200,{'Content-Type':'text/event-stream'});for(const [source,name]of [['aaaa','agent:response-chunk'],['aaaa','shell:output'],['bbbb','agent:response-chunk']])res.write('data: '+JSON.stringify({meta:{source,name},payload:{text:name}})+'\n\n');return res.end();}
  if(req.url==='/aaaa/thinking'){release=()=>res.end('{}');return;}
  effects.push([req.url,raw]);res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{owner.abort();server.closeAllConnections();server.close();});
 const grants=new SharedConversations(path.join(dir,'grants.json'),'host-private');grants.start(server.address().port);const plan=grants.prepare('plugin',{roots:[dir]}),id=grants.approve('plugin',plan),service=grants.bind('plugin',owner.signal),channel=service.open(id);
 assert.equal(grants.bind('other',owner.signal).scope(id),null);assert.throws(()=>grants.bind('other',owner.signal).open(id));
 assert.deepEqual((await channel.request('/sessions')).map(s=>s.instanceId),['aaaa']);
 for(const [url,body,method]of [['/api/config',{},'PUT'],['/bbbb/submit',{query:'no'},'POST'],['/aaaa/submit',{query:'/terminal'},'POST'],['/api/settings/network',{proxyEnabled:false},'PUT'],['/api/permission/decide',{sessionId:'aaaa',outcome:'approved',sessionWide:true,onceOnly:false},'POST']])await assert.rejects(channel.request(url,body,method));
 assert.equal(effects.length,0);assert.deepEqual(await channel.request('/api/settings/network'),{proxyEnabled:true,sessions:{aaaa:false}});
 const stream=await channel.events('aaaa',true,new AbortController().signal),text=await stream.text();assert(text.includes('agent:response-chunk'));assert(!text.includes('shell:output'));assert(!text.includes('bbbb'));
 const timeouts=[],timeout=AbortSignal.timeout;
 const timeoutMock=t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return timeout(ms);});
 await channel.request('/sessions');assert.equal(timeouts.pop(),20000,'ordinary local lookups retain the bounded timeout');
 timeouts.length=0;await channel.request('/aaaa/submit',{query:'hello'});assert.equal(timeouts.pop(),24*3600000,'only model execution may remain long-lived');timeoutMock.mock.restore();
 const pending=channel.request('/aaaa/thinking');const rejected=assert.rejects(pending);while(!release)await new Promise(r=>setTimeout(r,5));service.revoke(id);await rejected;release();await assert.rejects(channel.request('/sessions'));assert.equal(new SharedConversations(path.join(dir,'grants.json')).bind('plugin',owner.signal).scope(id),null);
});

test('shared SSE reads through partial and filtered chunks until replay completes', {timeout:5000}, async t => {
 const dir=fixture(t), owner=new AbortController();
 const frame=(source,name,text)=>'data: '+JSON.stringify({meta:{source,name},payload:{text}})+'\n\n';
 const query=frame('aaaa','agent:query','长'.repeat(60000)), done=frame('aaaa','hub:replay-done','');
 const server=http.createServer((req,res)=>{
  if(req.url==='/sessions')return res.end(JSON.stringify([{instanceId:'aaaa',kind:'agent',cwd:dir}]));
  assert.match(req.url,/^\/events\?/);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write(frame('bbbb','agent:query','other conversation')+frame('aaaa','shell:output','filtered')+query.slice(0,30000));
  setTimeout(()=>res.end(query.slice(30000)+done),50);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{owner.abort();server.closeAllConnections();server.close();});
 const grants=new SharedConversations(path.join(dir,'grants.json'));
 grants.start(server.address().port);
 const id=grants.approve('plugin',grants.prepare('plugin',{roots:[dir]}));
 const stream=await grants.bind('plugin',owner.signal).open(id).events('aaaa',true,AbortSignal.timeout(1800));
 assert.equal(await stream.text(),query+done);
});

test('interrupted migration merges compatibility publisher receipts before retrying, without resetting newer device settings',t=>{
 const dir=fixture(t),settingsFile=path.join(dir,'settings.json'),sessionsDir=path.join(dir,'hub-sessions');fs.writeFileSync(settingsFile,'{}');fs.mkdirSync(path.join(sessionsDir,'remote'),{recursive:true});
 const source=path.join(sessionsDir,'remote','remote-requests.json');fs.writeFileSync(source,JSON.stringify({'same:old':{digest:'first',state:'pending'}}));
 const saved=JSON.stringify({deviceId:'same',deviceToken:'keep',username:'owner',roots:[dir]}),vault=new Map(),sharing=new SharedConversations(path.join(dir,'grants.json'));
 const opts={settingsFile,sessionsDir,sharing,legacy:{read:()=>saved},secrets:{read:k=>vault.get(k)||null,write:(k,v)=>vault.set(k,v)}};
 const rename=fs.renameSync;const mocked=t.mock.method(fs,'renameSync',(from,to)=>{if(to.endsWith('device-interconnect-migrated.json'))throw Error('marker unavailable');return rename(from,to);});
 assert.throws(()=>migrateDeviceInterconnect(opts),/marker unavailable/);mocked.mock.restore();const [key]=vault.keys();const preserved=vault.get(key);
 fs.writeFileSync(source,JSON.stringify({'same:old':{digest:'first',state:'done',result:'completed'},'same:late':{digest:'second',state:'done',result:'applied during fallback'}}));
 migrateDeviceInterconnect(opts);assert.equal(vault.get(key),preserved);
 const entry=pluginCatalog(settingsFile).find(p=>p.manifest?.id==='ashub-multi-machine');const journal=JSON.parse(fs.readFileSync(path.join(sessionsDir,'plugin-data',entry.id,'remote-requests.json')));
 assert.equal(journal['same:old'].state,'done');assert.equal(journal['same:late'].result,'applied during fallback');assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(dir,'grants.json')))).length,1);
});

test('migration retry follows disable, scope reduction and account rebind made through the compatibility connection',t=>{
 for(const change of ['disable','scope','account']){
  const dir=fixture(t),settingsFile=path.join(dir,'settings.json'),sessionsDir=path.join(dir,'hub-sessions');fs.writeFileSync(settingsFile,'{}');const nested=path.join(dir,'limited');fs.mkdirSync(nested);
  let legacy={deviceId:'original',deviceToken:'original-token',username:'alice',deviceName:'Original',roots:[dir],enabled:true};const vault=new Map(),sharing=new SharedConversations(path.join(dir,'grants.json'));
  const opts={settingsFile,sessionsDir,sharing,legacy:{read:()=>JSON.stringify(legacy)},secrets:{read:k=>vault.get(k)||null,write:(k,v)=>vault.set(k,v)}};
  const rename=fs.renameSync, mock=t.mock.method(fs,'renameSync',(from,to)=>{if(to.endsWith('device-interconnect-migrated.json'))throw Error('interrupted');return rename(from,to);});
  assert.throws(()=>migrateDeviceInterconnect(opts),/interrupted/);mock.mock.restore();const [key]=vault.keys(),before=JSON.parse(vault.get(key));
  if(change==='disable')legacy={...legacy,enabled:false};
  if(change==='scope')legacy={...legacy,roots:[nested]};
  if(change==='account')legacy={...legacy,deviceId:'replacement',deviceToken:'new-token',username:'bob',deviceName:'Replacement'};
  migrateDeviceInterconnect(opts);const current=JSON.parse(vault.get(key));
  for(const field of ['deviceId','deviceToken','username','deviceName','enabled','roots'])assert.deepEqual(current[field],legacy[field],change+' '+field);
  const owner=pluginCatalog(settingsFile).find(p=>p.manifest?.id==='ashub-multi-machine').id,service=sharing.bind(owner,new AbortController().signal);
  assert.deepEqual(service.scope(current.grantId),legacy.roots);
  if(change==='scope')assert.equal(service.scope(before.grantId),null,'superseded scope cannot be reused');
 }
});

test('legacy migration does not re-enable an independently configured disabled interconnect plugin',t=>{
 const dir=fixture(t),settingsFile=path.join(dir,'settings.json'),sessionsDir=path.join(dir,'hub-sessions');fs.writeFileSync(settingsFile,'{}');
 const entry=pluginCatalog(settingsFile).find(p=>p.manifest?.id==='ashub-multi-machine'),key=createHash('sha256').update(entry.id+'\0device').digest('hex');
 const existing=JSON.stringify({deviceId:'independent',deviceToken:'independent-token',username:'bob',roots:[dir],enabled:true,grantId:'independent-grant'}),vault=new Map([[key,existing]]);
 migrateDeviceInterconnect({settingsFile,sessionsDir,sharing:new SharedConversations(path.join(dir,'grants.json')),legacy:{read:()=>JSON.stringify({deviceId:'legacy',deviceToken:'legacy-token',username:'alice',roots:[dir],enabled:true})},secrets:{read:k=>vault.get(k)||null,write:(k,v)=>vault.set(k,v)}});
 assert.equal(vault.get(key),existing);assert.equal(pluginCatalog(settingsFile).find(p=>p.id===entry.id).enabled,false);
});
