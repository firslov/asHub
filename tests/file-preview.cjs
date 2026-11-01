const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {performFileAction} = require('../electron/files.cjs');
const root=path.resolve(__dirname,'..');
function host(options={}) {
 const calls=[];
 return {calls, api:{trusted:()=>true,resolve:async(s,p)=>{calls.push(['resolve',s,p]);return '/workspace/'+p;},shell:{openPath:async p=>{calls.push(['open',p]);return '';},showItemInFolder:p=>calls.push(['reveal',p])},...options}};
}
test('native actions open the validated original and reveal without downloading',async()=>{
 const h=host();
 await performFileAction(h.api,{}, {session:'aaaaaa',path:'审阅稿.docx',action:'open'});
 assert.deepEqual(h.calls,[['resolve','aaaaaa','审阅稿.docx'],['open','/workspace/审阅稿.docx']]);
 await performFileAction(h.api,{}, {session:'aaaaaa',path:'script.sh',action:'reveal'});
 assert.equal(h.calls.at(-1)[0],'reveal');
});
test('untrusted senders, malformed requests and executable associations cannot launch files',async()=>{
 const h=host({trusted:()=>false});
 await assert.rejects(performFileAction(h.api,{}, {session:'aaaaaa',path:'a.pdf',action:'open'}));assert.equal(h.calls.length,0);
 for(const request of [null,{}, {session:'bad',path:'a',action:'open'},{session:'aaaaaa',path:{},action:'open'},{session:'aaaaaa',path:'a',action:'run'}]) await assert.rejects(performFileAction(host().api,{},request));
 for(const name of ['run.exe','run.cmd','run.sh','run.command','run.desktop','run.app','open.url','open.lnk','page.html','file.pdf.exe']) {
   const h=host();await assert.rejects(performFileAction(h.api,{}, {session:'aaaaaa',path:name,action:'open'}));assert.equal(h.calls.length,1,name);
 }
});
test('permission changes and native launch failures are surfaced',async()=>{
 let checks=0; const h=host({trusted:()=>++checks===1});
 await assert.rejects(performFileAction(h.api,{}, {session:'aaaaaa',path:'a.pdf',action:'open'}));assert.equal(h.calls.length,1);
 const failed=host({resolve:async()=>{throw Error('outside directory');}});
 await assert.rejects(performFileAction(failed.api,{}, {session:'aaaaaa',path:'../a.pdf',action:'reveal'}));
 const native=host({shell:{openPath:async()=> 'No associated application'}});
 await assert.rejects(performFileAction(native.api,{}, {session:'aaaaaa',path:'a.docx',action:'open'}),/No associated/);
});
test('remote and desktop ship identical preview hosts and renderers',()=>{
 for(const [file,dir] of [['file-preview.js','js'],['file-preview-renderers.js','js'],['file-preview.css','css']]) {
  const remote=path.join(root,'remote/public',file);
  if(fs.existsSync(remote)) assert.equal(fs.readFileSync(remote,'utf8'),fs.readFileSync(path.join(root,'web',dir,file),'utf8'));
 }
});
