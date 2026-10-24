const {env}=require('./harness.cjs');
const test=require('node:test'), assert=require('node:assert/strict');
function setup(files, output='C:\\Program Files\\Git\\cmd\\git.exe\r\n') {
 const e=env({modules:{'node:fs':{existsSync:p=>files.includes(p)},'node:child_process':{spawnSync:()=>({status:output?0:1,stdout:output})}}});
 return e.load('src/windows-environment.ts').configureWindowsEnvironment;
}
const git=['C:\\Program Files\\Git\\bin\\bash.exe','C:\\Program Files\\Git\\cmd\\git.exe'];
test('default Git installation exposes Bash without duplicate Windows Path keys',()=>{
 const configure=setup(git), e={Path:'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd'};
 configure(e,'win32');assert.equal(e.Path,'C:\\Program Files\\Git\\bin;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd');
 configure(e,'win32');assert.equal(e.Path.split(';').length,3);assert.equal(e.PATH,undefined);
});
test('per-user installation is discovered when Git is absent from PATH',()=>{
 const root='C:\\Users\\Test User\\AppData\\Local';
 const configure=setup([root+'\\Programs\\Git\\bin\\bash.exe',root+'\\Programs\\Git\\cmd\\git.exe'],'');
 const e={PATH:'C:\\Windows',LOCALAPPDATA:root};configure(e,'win32');assert(e.PATH.startsWith(root+'\\Programs\\Git\\bin;'));
});
test('missing Git Bash and non-Windows environments keep their PATH intact',()=>{
 const e={PATH:'/usr/bin'};setup(git)(e,'darwin');assert.equal(e.PATH,'/usr/bin');
 setup([])(e,'win32');assert.equal(e.PATH,'/usr/bin');
});
