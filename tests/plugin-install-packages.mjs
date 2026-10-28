// Offline package acceptance. Reuses an already prepared runtime read-only;
// never starts desktop control, captures a screen or opens WeChat.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { PluginInstaller } from '../dist/plugin-installer.js';
import { pluginCatalog } from '../dist/plugins.js';
const [archives, runtimeSource] = process.argv.slice(2);
if (!archives || !runtimeSource) throw Error('Usage: node tests/plugin-install-packages.mjs <archive-directory> <prepared-desktop-runtime>');
assert(fs.existsSync(path.join(runtimeSource, '.complete')), 'An already installed runtime is required; this test must not download one');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-package-install-'));
const file = path.join(home, 'settings.json'), installer = new PluginInstaller(file);
const wait = async id => {
 for(let n=0;n<1500;n++){const j=installer.status(id);if(j.state!=='running')return j;await new Promise(r=>setTimeout(r,20));}throw Error('Installation timed out');
};
try {
 const revision=path.basename(runtimeSource),runtimes=path.join(home,'desktop-control/runtimes');fs.mkdirSync(runtimes,{recursive:true});fs.symlinkSync(runtimeSource,path.join(runtimes,revision),'dir');
 const read = name => fs.readFileSync(path.join(archives,name+'.zip'));
 const blocked=await installer.preview(read('ashub-wechat-0.2.3'));assert(!blocked.canInstall);installer.discard(blocked.token);
 fs.writeFileSync(file,JSON.stringify({test:'preserve'}));
 const projectVersion=JSON.parse(fs.readFileSync(new URL('../examples/extensions/project-management/package.json',import.meta.url))).version;
 for(const name of ['ashub-project-management-'+projectVersion,'ashub-desktop-control-0.3.3','ashub-wechat-0.2.3']) {
  const preview=await installer.preview(read(name));assert(preview.canInstall,JSON.stringify(preview.checks));
  const done=await wait(installer.confirm(preview.token).id);assert.equal(done.state,'succeeded',done.error);
  assert.equal(installer.confirm(preview.token).state,'succeeded');installer.discard(preview.token);
 }
 const settings=JSON.parse(fs.readFileSync(file));assert.equal(settings.test,'preserve');assert.deepEqual(settings['desktop-control'],{enabled:false,allowedApps:[]});assert.equal(settings.wechat.mode,'read-only');assert.equal(settings.wechat.enabled,false);
 const plugins=pluginCatalog(file);assert.equal(plugins.length,3);assert(plugins.some(p=>p.name==='微信'&&p.configNamespaces.includes('wechat')));
 for(const [id,marker] of [['ashub-desktop-control','.ashub-desktop-control'],['ashub-wechat','.ashub-wechat']])assert(fs.existsSync(path.join(home,'extensions',id,marker)));
 console.log('PASS three release ZIPs: prerequisite gating, actual setup scripts, prepared Python/OCR imports, safe defaults, plugin discovery and duplicate confirmation');
} finally {await installer.close();fs.rmSync(home,{recursive:true,force:true});}
