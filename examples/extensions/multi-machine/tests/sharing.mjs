import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DeviceSharing} from '../sharing.mjs';
import {remoteTransport} from '../transport.mjs';
test('migrated publisher retains identity, disabled restart stays offline, late enrollment never reopens closed plugin',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'interconnect-publisher-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let saved=JSON.stringify({deviceId:'same-id',deviceToken:'same-token',username:'owner',roots:[dir],deviceName:'Existing',grantId:'previous'}),socketCount=0,closed=0,release,body;
 t.mock.method(remoteTransport,'socket',()=>{socketCount++;return{close(){}};});
 const activate=()=>{const controller=new AbortController();const ctx={signal:controller.signal,services:{dataDirectory:dir,backends:{secrets:{available:true,read:()=>saved,write:(_key,v)=>saved=v}},sharedConversations:{open:id=>({roots:[dir],close:()=>closed++,request:async()=>[]}),registerStatus(){},revoke(){}}}};return {sharing:new DeviceSharing(ctx),controller};};
 let first=activate();assert.equal(socketCount,1);assert.equal(first.sharing.status().deviceName,'Existing');
 const beforeRestart=saved;await first.sharing.close();first.controller.abort();first=activate();
 assert.equal(socketCount,2,'enabled sharing reconnects on a fresh application instance');assert.equal(saved,beforeRestart,'restart does not enroll or replace identity');
 first.sharing.disable();await first.sharing.close();first.controller.abort();assert.equal(JSON.parse(saved).deviceId,'same-id');assert.equal(JSON.parse(saved).deviceToken,'same-token');
 let second=activate();assert.equal(socketCount,2);assert.equal(second.sharing.status().enabled,false);
 t.mock.method(remoteTransport,'fetch',async(_url,options)=>{body=JSON.parse(options.body);return new Promise(r=>release=r);});
 const configuring=second.sharing.configure({username:'owner',password:'not-persisted',deviceName:'Renamed'},'new-grant');const rejected=assert.rejects(configuring,/取消/);
 assert.equal(body.deviceId,'same-id');assert.equal(body.deviceToken,'same-token');second.controller.abort();release(Response.json({protocol:1,deviceId:'same-id',deviceToken:'rotated',username:'owner'}));await rejected;await second.sharing.close();assert.equal(JSON.parse(saved).enabled,false);assert.equal(JSON.parse(saved).deviceToken,'same-token');assert.equal(socketCount,2);assert(closed>0);
});

test('directory grants change without enrollment; preserve identity, reject stale approvals and recover persisted scope',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'interconnect-roots-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const scopes={old:['/old'],next:['/new'],last:['/last']},revoked=[],closed=[];let failWrite=false,fetches=0;
 let saved=JSON.stringify({deviceId:'same-id',deviceToken:'same-token',username:'owner',roots:scopes.old,deviceName:'Existing',grantId:'old'});
 t.mock.method(remoteTransport,'socket',()=>({close(){}}));t.mock.method(remoteTransport,'fetch',()=>{fetches++;throw Error('unexpected enrollment');});
 const activate=()=>{const controller=new AbortController();return {controller,sharing:new DeviceSharing({signal:controller.signal,services:{dataDirectory:dir,backends:{secrets:{available:true,read:()=>saved,write:(_k,v)=>{if(failWrite)throw Error('disk');saved=v;}}},sharedConversations:{open:id=>{if(!scopes[id])throw Error('unauthorized');return{roots:scopes[id],close:()=>closed.push(id),request:async()=>[]};},registerStatus(){},revoke:id=>revoked.push(id)}}})};};
 const one=activate();t.after(()=>one.controller.abort());const rev=one.sharing.revision(),before=saved;
 failWrite=true;await assert.rejects(one.sharing.updateRoots('next',rev),/disk/);assert.equal(saved,before);assert.equal(one.sharing.revision(),rev);assert.deepEqual(revoked,[]);assert(closed.includes('next'));
 failWrite=false;await one.sharing.updateRoots('next',rev);let config=JSON.parse(saved);assert.equal(config.deviceId,'same-id');assert.equal(config.deviceToken,'same-token');assert.equal(config.username,'owner');assert.deepEqual(config.roots,['/new']);assert.deepEqual(revoked,['old']);assert.equal(fetches,0);
 await assert.rejects(one.sharing.updateRoots('last',rev),/状态已变化/);assert.equal(JSON.parse(saved).grantId,'next');
 await one.sharing.close();one.controller.abort();const two=activate();t.after(()=>two.controller.abort());assert.deepEqual(two.sharing.status().roots,['/new']);assert.equal(two.sharing.status().enabled,true);
 const pending=two.sharing.revision();two.sharing.disable();await assert.rejects(two.sharing.updateRoots('last',pending),/状态已变化/);assert.equal(JSON.parse(saved).enabled,false);assert.equal(fetches,0);await two.sharing.close();
});

test('directory review canonicalizes aliases and duplicate paths; parent scope is not described as losing child access',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'interconnect-review-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const parent=fs.realpathSync(dir),child=path.join(parent,'child'),alias=path.join(parent,'alias');fs.mkdirSync(child);fs.symlinkSync(child,alias);
 const sharing=Object.create(DeviceSharing.prototype);sharing.status=()=>({roots:[parent,alias]});
 assert.deepEqual(sharing.directoryChange([parent,child,alias]),{roots:[parent,child],added:[],removed:[]});
 assert.deepEqual(sharing.directoryChange([parent]),{roots:[parent],added:[],removed:[child]});
 assert.throws(()=>sharing.directoryChange(['relative']),/绝对路径/);assert.throws(()=>sharing.directoryChange([]),/请选择/);
 const {connectionResource}=await import('../app.mjs');sharing.status=()=>({enabled:true,status:'online',roots:[parent,child]});sharing.revision=()=>({});
 const plan=await connectionResource({cookie:'',records:new Map()},sharing).prepare('update-roots',{roots:parent});assert.match(plan.preview.fields[2].value,/不再被任何已授权目录/);assert.deepEqual(plan.sharingAuthorization.roots,[parent]);
});

test('switching publisher accounts clears a previous account recovery code; same-account revalidation retains it',async()=>{
 const sharing=Object.create(DeviceSharing.prototype);let user='first';sharing.recovery='first-recovery';sharing.service={revoke(){}};
 sharing.publisher={status:()=>({username:user}),configure:async values=>{user=values.username;return{};}};
 await sharing.configure({username:'first'},'grant');assert.equal(sharing.recovery,'first-recovery');
 await sharing.configure({username:'second'},'grant');assert.equal(sharing.recovery,'');
});
