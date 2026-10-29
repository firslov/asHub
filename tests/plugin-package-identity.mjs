import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {PluginInstaller} from '../dist/plugin-installer.js';
import {pluginCatalog} from '../dist/plugins.js';
const {zip}=createRequire(import.meta.url)('./plugin-zip-fixture.cjs');
async function fixture(t, mutate, {application=false, afterCheck=false, legacy=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-package-approval-')),file=path.join(dir,'settings.json'),target=path.join(dir,'extensions','identity-example');fs.mkdirSync(target,{recursive:true});
 const settings={unrelated:{keep:true},identity:{preserved:'user-value'}};fs.writeFileSync(file,JSON.stringify(settings));
 const ui={version:1,panels:[{id:'main',title:'Main',components:[]}]};
 const oldManifest=legacy?{schemaVersion:1,id:'identity-example'}:{schemaVersion:2,id:'identity-example',...(application?{entries:{application:'dist/app.mjs'}}:{ui})};
 const oldPkg={name:'identity-example',version:'1.0.0',type:'module'};
 fs.writeFileSync(path.join(target,'package.json'),JSON.stringify(oldPkg));fs.writeFileSync(path.join(target,'ashub-plugin.json'),JSON.stringify(oldManifest));
 if(legacy)fs.writeFileSync(path.join(target,'index.mjs'),'//old legacy implementation');
 if(application){fs.mkdirSync(path.join(target,'dist'));fs.writeFileSync(path.join(target,'dist/app.mjs'),'//old implementation');}
 const approved={name:'identity-example',version:'2.0.0',type:'module',engines:{node:'>=22.12.0'},dependencies:{}};
 const manifest={...oldManifest,configNamespaces:['identity'],defaults:{identity:{preserved:'must-not-clobber'}},setup:{script:'setup.mjs',description:'Generate implementation'}};
 let notices=0,syntaxChecks=0;
 const installer=new PluginInstaller(file,async(script,_args,cwd)=>{
  if(script==='--check'){syntaxChecks++;if(afterCheck)await mutate(cwd,script);return;}
  if(!afterCheck)await mutate(cwd,script);
 },process.platform,()=>false,()=>{notices++});
 t.after(async()=>{await installer.close();fs.rmSync(dir,{recursive:true,force:true})});
 const archive=zip({'package.json':JSON.stringify(approved),'ashub-plugin.json':JSON.stringify(manifest),'setup.mjs':'//offline fixture',...(application?{'dist/app.mjs':'//placeholder implementation'}:legacy?{'index.mjs':'//legacy placeholder'}:{})});
 const preview=await installer.preview(archive);assert(preview.canInstall);const job=installer.confirm(preview.token);
 for(let i=0;i<100&&installer.status(job.id).state==='running';i++)await new Promise(r=>setTimeout(r,5));
 return {file,target,settings,oldPkg,result:installer.status(job.id),notices,syntaxChecks};
}

test('setup cannot change approved package identity, entry resolution or requirements',async t=>{
 const mutations={
  name:pkg=>{pkg.name='changed-after-approval'},version:pkg=>{pkg.version='9.0.0'},
  main:pkg=>{pkg.main='unapproved.mjs'},type:pkg=>{pkg.type='commonjs'},
  node:pkg=>{pkg.engines.node='>=99'},dependencies:pkg=>{pkg.dependencies={unapproved:'1.0.0'}},
  exports:pkg=>{pkg.exports={'.':'./unapproved.mjs'}},
 };
 for(const [name,change] of Object.entries(mutations))await t.test(name,async t=>{
  const f=await fixture(t,cwd=>{const file=path.join(cwd,'package.json'),pkg=JSON.parse(fs.readFileSync(file));change(pkg);fs.writeFileSync(file,JSON.stringify(pkg))});
  assert.equal(f.result.state,'failed');assert.match(f.result.error,/package identity, entry or runtime requirements changed/);assert.equal(f.notices,0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.target,'package.json'))),f.oldPkg);assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),f.settings);
  const current=pluginCatalog(f.file)[0];assert.equal(current.version,'1.0.0');assert.equal(current.compatibilityError,undefined);
 });
});

test('approved package metadata is rechecked after awaited syntax validation',async t=>{
 const f=await fixture(t,cwd=>{const file=path.join(cwd,'package.json'),pkg=JSON.parse(fs.readFileSync(file));pkg.name='late-change';fs.writeFileSync(file,JSON.stringify(pkg))},{application:true,afterCheck:true});
 assert.equal(f.syntaxChecks,1);assert.equal(f.result.state,'failed');assert.match(f.result.error,/package identity/);assert.equal(f.notices,0);assert.equal(fs.readFileSync(path.join(f.target,'dist/app.mjs'),'utf8'),'//old implementation');assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),f.settings);
});

test('build outputs and descriptive package metadata may change without changing approval',async t=>{
 const f=await fixture(t,cwd=>{
  fs.writeFileSync(path.join(cwd,'dist/app.mjs'),'export default()=>{return {stop(){}}}; // built output');
  fs.writeFileSync(path.join(cwd,'generated.txt'),'generated artifact');
  const file=path.join(cwd,'package.json'),pkg=JSON.parse(fs.readFileSync(file));pkg.description='Generated build description';pkg.buildHash='fixture-hash';
  // Canonical comparison also permits harmless object-key reordering.
  fs.writeFileSync(file,JSON.stringify(Object.fromEntries(Object.entries(pkg).reverse())));
 },{application:true});
 assert.equal(f.result.state,'succeeded',f.result.error);assert.equal(f.notices,1);assert.equal(f.syntaxChecks,1);assert.match(fs.readFileSync(path.join(f.target,'dist/app.mjs'),'utf8'),/built output/);assert(fs.existsSync(path.join(f.target,'generated.txt')));assert.equal(pluginCatalog(f.file)[0].version,'2.0.0');assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),f.settings);
});


test('legacy canonical entry selection is also rechecked after syntax validation',async t=>{
 const f=await fixture(t,cwd=>{fs.writeFileSync(path.join(cwd,'index.js'),'//new higher-priority entry')},{legacy:true,afterCheck:true});
 assert.equal(f.syntaxChecks,1);assert.equal(f.result.state,'failed');assert.match(f.result.error,/entry changed/);assert.equal(f.notices,0);
 assert.equal(fs.readFileSync(path.join(f.target,'index.mjs'),'utf8'),'//old legacy implementation');assert(!fs.existsSync(path.join(f.target,'index.js')));assert.deepEqual(JSON.parse(fs.readFileSync(f.file)),f.settings);
});
