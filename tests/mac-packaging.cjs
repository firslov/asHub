const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { getFileMatchers } = require('app-builder-lib/out/fileMatcher.js');
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
for (const format of ['array', 'package map']) macTest(`preparation restores the non-host package from npm's ${format} JSON`,t=>{
  const f=fixture(t);f.install('arm64');let packs=0,extracts=0;
  prepare(f.root,(command,args,options)=>{
    if(command==='tar'){extracts++;f.install('x64',path.join(options.cwd || args.at(-1),'package'));return '';}
    packs++;assert(args.includes('@vscode/ripgrep-darwin-x64@1.18.0'));assert(args.includes('--ignore-scripts'));
    fs.writeFileSync(path.join(options.cwd,'fixture.tgz'),f.bytes);
    const result = { filename: 'fixture.tgz' };
    return JSON.stringify(format === 'array' ? [result] : { '@vscode/ripgrep-darwin-x64': result });
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
test('bundled plugin files are selected only on their supported platforms', () => {
  const root = path.join(__dirname, '..');
  const config = require('js-yaml').load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'));
  const pluginPath = path.join(root, 'examples/extensions');
  const fileStat = fs.statSync(__filename);
  const common = [
    'scheduled-tasks/app.mjs', 'scheduled-tasks/schedule.mjs', 'scheduled-tasks/ashub-plugin.json', 'scheduled-tasks/package.json',
    'voice-input/app.mjs', 'voice-input/ashub-plugin.json', 'voice-input/package.json',
    'personal-assistant/package.json',
    ...require('../examples/extensions/personal-assistant/package.json').files.map(file => `personal-assistant/${file}`),
  ];
  const macOnly = [
    'desktop-control/index.js', 'desktop-control/ashub-plugin.json', 'desktop-control/package.json',
    'desktop-control/dist/index.js', 'desktop-control/native/capture', 'desktop-control/scripts/ashub-setup.mjs',
    'desktop-control/LICENSE', 'desktop-control/docs/arc-cua-license.txt',
  ];
  for (const platform of ['mac', 'win', 'linux']) {
    const matchers = ['files', 'extraResources', 'extraFiles'].flatMap(name => getFileMatchers(config, name, path.join(root, 'release'), {
      defaultSrc: root, globalOutDir: path.join(root, 'release'), customBuildOptions: config[platform], macroExpander: value => value,
    }) || []);
    const matches = absolute => matchers.some(matcher => {
      const relative = path.relative(matcher.from, absolute);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
        && matcher.createFilter()(absolute, fileStat);
    });
    const included = file => matches(path.join(pluginPath, file));
    for (const file of common) assert(included(file), `${platform} must bundle ${file}`);
    for (const file of macOnly) assert.equal(included(file), platform === 'mac', `${platform}: ${file}`);
    assert(matches(path.join(root, 'dist/builtin-plugins/sample/assets/sample.txt')));
    assert(!matches(path.join(root, 'src/builtin-plugins/sample/kernel-patches/patch.json')));
    assert(!matches(path.join(root, 'node_modules/.ashub-integration-kernel.json')));
  }
});

macTest('the builder compiles the desktop capture helper once for both macOS architectures', async t => {
  const f = fixture(t);
  f.install('arm64');
  f.install('x64');
  // beforePack now verifies all required hunks, not just the Codex login patch.
  const kernel = path.resolve(__dirname, '../node_modules/agent-sh');
  const patchDir = path.resolve(__dirname, '../scripts/patches');
  for (const name of fs.readdirSync(patchDir).filter(name => name.endsWith('.json'))) {
    for (const { path: relative } of require(path.join(patchDir, name)).files) {
      const file = path.join(f.root, 'node_modules/agent-sh', relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(kernel, relative), file);
    }
  }
  const plugin = path.join(f.root, 'examples/extensions/desktop-control');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'scripts/build-capture.mjs'), "import { appendFileSync } from 'node:fs'; appendFileSync('builds', 'x');");
  const build = require('../scripts/before-pack.cjs');
  const packager = { projectDir: f.root, info: { appDir: f.root } };
  for (const electronPlatformName of ['win32', 'linux']) await build({ electronPlatformName, packager });
  assert(!fs.existsSync(path.join(plugin, 'builds')));
  await Promise.all([1, 3].map(arch => build({ electronPlatformName: 'darwin', arch, packager })));
  assert.equal(fs.readFileSync(path.join(plugin, 'builds'), 'utf8'), 'x');
});
