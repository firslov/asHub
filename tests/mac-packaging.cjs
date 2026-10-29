const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { prepare, verify, checkPackage, beforePack, afterPack } = require('../scripts/mac-ripgrep.cjs');
const macTest = process.platform === 'win32' ? test.skip : test;
const arches = { x64: 0x01000007, arm64: 0x0100000c };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-pack-test-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const write = (name, data) => {const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(data));};
  const optionalDependencies=Object.fromEntries(Object.keys(arches).map(a=>[`@vscode/ripgrep-darwin-${a}`,'1.18.0']));
  write('package.json',{optionalDependencies});
  write('node_modules/@vscode/ripgrep/package.json',{name:'@vscode/ripgrep',version:'1.18.0',main:'lib/index.js',optionalDependencies});
  fs.mkdirSync(path.join(root,'node_modules/@vscode/ripgrep/lib'));
  fs.writeFileSync(path.join(root,'node_modules/@vscode/ripgrep/lib/index.js'),'');
  const bytes=Buffer.from('locked fixture archive');
  write('package-lock.json',{packages:Object.fromEntries(Object.entries(optionalDependencies).map(([name,version])=>['node_modules/'+name,{version,integrity:'sha512-'+crypto.createHash('sha512').update(bytes).digest('base64')}]))});
  function install(arch,dest=path.join(root,'node_modules',`@vscode/ripgrep-darwin-${arch}`)) {
    fs.mkdirSync(path.join(dest,'bin'),{recursive:true});
    fs.writeFileSync(path.join(dest,'package.json'),JSON.stringify({name:`@vscode/ripgrep-darwin-${arch}`,version:'1.18.0'}));
    const header=Buffer.alloc(8);header.writeUInt32LE(0xfeedfacf);header.writeUInt32LE(arches[arch],4);
    fs.writeFileSync(path.join(dest,'bin/rg'),header,{mode:0o755});return dest;
  }
  return {root,install,bytes};
}
macTest('macOS package check rejects the reported missing Intel dependency',t=>{
  const f=fixture(t);f.install('arm64');
  assert(verify(f.root,'arm64'));assert.throws(()=>verify(f.root,'x64'),/Cannot find module/);
  f.install('x64');assert(verify(f.root,'x64'));
});
macTest('package check catches a wrong CPU binary and missing execute bits',t=>{
  const f=fixture(t),dest=f.install('x64');
  const binary=path.join(dest,'bin/rg'),bad=Buffer.alloc(8);bad.writeUInt32LE(0xfeedfacf);bad.writeUInt32LE(arches.arm64,4);fs.writeFileSync(binary,bad);
  assert.throws(()=>verify(f.root,'x64'),/architecture/);f.install('x64');fs.chmodSync(binary,0o644);
  assert.throws(()=>verify(f.root,'x64'),/executable/);assert.throws(()=>verify(f.root,'universal'),/Unsupported/);
});
macTest('preparation restores the non-host package, verifies integrity, and is repeatable offline',t=>{
  const f=fixture(t);f.install('arm64');let packs=0,extracts=0;
  prepare(f.root,(command,args,options)=>{
    if(command==='tar'){extracts++;f.install('x64',path.join(options.cwd || args.at(-1),'package'));return '';}
    packs++;assert(args.includes('@vscode/ripgrep-darwin-x64@1.18.0'));assert(args.includes('--ignore-scripts'));
    fs.writeFileSync(path.join(options.cwd,'fixture.tgz'),f.bytes);return JSON.stringify([{filename:'fixture.tgz'}]);
  });
  assert.equal(packs,1);assert.equal(extracts,1);verify(f.root,'x64');
  prepare(f.root,()=>{throw Error('must not download verified packages');});
});
macTest('corrupt downloaded package is rejected before extraction',t=>{
  const f=fixture(t);f.install('arm64');let calls=0;
  assert.throws(()=>prepare(f.root,(_cmd,_args,options)=>{calls++;fs.writeFileSync(path.join(options.cwd,'bad.tgz'),'bad');return JSON.stringify([{filename:'bad.tgz'}]);}),/Integrity mismatch/);
  assert.equal(calls,1);assert(!fs.existsSync(path.join(f.root,'node_modules/@vscode/ripgrep-darwin-x64')));
});
macTest('builder hooks use the real context shape and validate the packaged app',async t=>{
  const f=fixture(t);f.install('arm64');f.install('x64');
  await beforePack({electronPlatformName:'darwin',packager:{info:{appDir:f.root}}});
  const out=path.join(f.root,'out'),app=path.join(out,'asHub.app/Contents/Resources/app');
  fs.mkdirSync(path.dirname(app),{recursive:true});fs.mkdirSync(app);fs.copyFileSync(path.join(f.root,'package.json'),path.join(app,'package.json'));fs.cpSync(path.join(f.root,'node_modules'),path.join(app,'node_modules'),{recursive:true});
  const context={electronPlatformName:'darwin',arch:1,appOutDir:out,packager:{appInfo:{productFilename:'asHub'}}};
  await afterPack(context);fs.rmSync(path.join(app,'node_modules/@vscode/ripgrep-darwin-x64'),{recursive:true});
  await assert.rejects(afterPack(context),/outside packaged app|Cannot find module|ENOENT/);
  await beforePack({electronPlatformName:'win32'});await afterPack({electronPlatformName:'linux'});
});
test('every builder entry uses the hooks; declared platform versions match the lock',()=>{
  const root=path.join(__dirname,'..');const yaml=fs.readFileSync(path.join(root,'electron-builder.yml'),'utf8');
  assert.match(yaml,/^beforePack: scripts\/before-pack.cjs$/m);assert.match(yaml,/^afterPack: scripts\/after-pack.cjs$/m);
  const pkg=require('../package.json'),lock=require('../package-lock.json');
  for(const arch of Object.keys(arches)){const name=`@vscode/ripgrep-darwin-${arch}`;assert.equal(pkg.optionalDependencies[name],lock.packages[''].optionalDependencies[name]);assert.equal(pkg.optionalDependencies[name],lock.packages['node_modules/'+name].version);}
});
