import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {PluginInstaller} from '../dist/plugin-installer.js';
const {zip,plugin}=createRequire(import.meta.url)('./plugin-zip-fixture.cjs');
function fixture(t,runner=async()=>{}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-installer-close-')),file=path.join(dir,'settings.json');fs.writeFileSync(file,'{}');
 const installer=new PluginInstaller(file,runner);t.after(async()=>{await installer.close();fs.rmSync(dir,{recursive:true,force:true})});return {dir,file,installer};
}
const payload=()=>zip(plugin(Object.fromEntries(Array.from({length:100},(_,i)=>['release/assets/'+i+'.txt','fixture']))));
const remaining=f=>fs.readdirSync(path.join(f.dir,'plugin-install/staging'));
test('close waits for a preview extraction to reject and remove its staging writes',async t=>{
 const f=fixture(t);let settled=false;
 const pending=f.installer.preview(payload()).then(()=>{settled=true;return 'resolved'},error=>{settled=true;return error.name});
 const closing=f.installer.close();assert.equal(f.installer.close(),closing);await closing;
 assert.equal(settled,true);assert.equal(await pending,'AbortError');assert.deepEqual(remaining(f),[]);
 await assert.rejects(f.installer.preview(payload()),error=>error.name==='AbortError');assert.deepEqual(remaining(f),[]);assert.equal(fs.readFileSync(f.file,'utf8'),'{}');
});
test('close cleans completed plans and all simultaneous preview extractions',async t=>{
 const f=fixture(t),ready=await f.installer.preview(payload());
 const pending=[f.installer.preview(payload()),f.installer.preview(payload())].map(task=>task.then(()=>false,error=>error.name));
 await f.installer.close();assert.deepEqual(await Promise.all(pending),['AbortError','AbortError']);assert.deepEqual(remaining(f),[]);
 assert.throws(()=>f.installer.previewStatus(ready.token),error=>error.status===404);assert.equal(fs.readFileSync(f.file,'utf8'),'{}');
});
test('close waits for active setup cancellation and concurrent preview cleanup',async t=>{
 let entered;const ready=new Promise(resolve=>{entered=resolve});
 const f=fixture(t,async(_script,_args,_cwd,_home,_data,signal)=>{
  entered();await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});
 });
 const manifest={schemaVersion:1,id:'sample-plugin',setup:{script:'setup.mjs',description:'Offline fixture'}};
 const approved=await f.installer.preview(zip(plugin({'release/setup.mjs':'//offline'},manifest))),job=f.installer.confirm(approved.token);await ready;
 const pending=f.installer.preview(payload()).then(()=>false,error=>error.name);
 await f.installer.close();assert.equal(await pending,'AbortError');assert.deepEqual(remaining(f),[]);assert(!fs.existsSync(approved.target));assert.equal(fs.readFileSync(f.file,'utf8'),'{}');
});
