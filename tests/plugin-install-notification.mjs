import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PluginInstaller } from '../dist/plugin-installer.js';
const {zip}=createRequire(import.meta.url)('./plugin-zip-fixture.cjs');
async function fixture(t,observer,{runner=async()=>{},setup=false,timeout=50}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-install-notify-')),file=path.join(dir,'settings.json');fs.writeFileSync(file,'{}');
 const installer=new PluginInstaller(file,runner,process.platform,()=>false,observer,timeout);t.after(async()=>{await installer.close();fs.rmSync(dir,{recursive:true,force:true})});
 const manifest={schemaVersion:2,id:'notify-example',configNamespaces:['notify'],defaults:{notify:{keep:true}},...(setup?{setup:{script:'setup.mjs',description:'Fixture'}}:{}),ui:{version:1,panels:[{id:'main',title:'Main',components:[]}]}};
 const preview=await installer.preview(zip({'package.json':JSON.stringify({name:manifest.id,version:'1.0.0',type:'module'}),'ashub-plugin.json':JSON.stringify(manifest),...(setup?{'setup.mjs':'//fixture'}:{})}));
 const job=installer.confirm(preview.token);
 return {dir,file,installer,preview,job};
}
async function done(f){for(let i=0;i<100;i++){const value=f.installer.status(f.job.id);if(value.state!=='running')return value;await new Promise(r=>setTimeout(r,5))}throw Error('timed out')}
test('notification runs once after committed package/settings and before success becomes observable',async t=>{
 let calls=0,notice;const f=await fixture(t,async event=>{calls++;notice=event;assert(Object.isFrozen(event));assert(fs.existsSync(path.join(event.target,'package.json')));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(event.target)),'settings.json'))).notify,{keep:true});});
 const result=await done(f);assert.equal(result.state,'succeeded');assert.equal(calls,1);assert.equal(notice.packageId,'notify-example');assert.equal(notice.jobId,f.job.id);f.installer.confirm(f.preview.token);f.installer.status(f.job.id);assert.equal(calls,1);
});
test('observer failures preserve successful installation and report additive notificationError',async t=>{
 const f=await fixture(t,()=>{throw Error('observer failed')});const result=await done(f);assert.equal(result.state,'succeeded');assert.match(result.notificationError,/observer failed/);assert(fs.existsSync(f.preview.target));assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).notify,{keep:true});
});
test('observer timeout is bounded and never turns the committed package into a failed job',async t=>{
 const f=await fixture(t,()=>new Promise(()=>{}),{timeout:20});const result=await done(f);assert.equal(result.state,'succeeded');assert.match(result.notificationError,/timed out/);assert(fs.existsSync(f.preview.target));
});
test('failed package preparation never invokes the successful-install observer',async t=>{
 let calls=0;const f=await fixture(t,()=>{calls++},{setup:true,runner:async()=>{throw Error('setup failed')}});const result=await done(f);assert.equal(result.state,'failed');assert.equal(calls,0);assert(!fs.existsSync(f.preview.target));assert.equal(JSON.parse(fs.readFileSync(f.file)).notify,undefined);
});
