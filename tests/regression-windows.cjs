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

test('Windows terminal releases ConPTY on natural exit and emits closure once',async()=>{
 let exit, killed=0, closed=0;
 const proc={onData(){},onExit(fn){exit=fn;},kill(){killed++;exit({exitCode:0});},write(){},resize(){}};
 const e=env({globals:{process:{...process,platform:'win32',env:{COMSPEC:'cmd.exe'}}},modules:{'node-pty':{spawn:()=>proc}}});
 const terminal=new(e.load('src/bridges/terminal.ts').TerminalBridge)({cwd:e.dir});
 terminal.onClose(()=>closed++);await terminal.ready();exit({exitCode:0});terminal.close();
 assert.equal(killed,1);assert.equal(closed,1);assert.equal(terminal.proc,null);
});
test('closing Windows terminal ignores its later exit callback',async()=>{
 let exit, killed=0, closed=0;
 const proc={onData(){},onExit(fn){exit=fn;},kill(){killed++;},write(){},resize(){}};
 const e=env({globals:{process:{...process,platform:'win32',env:{COMSPEC:'cmd.exe'}}},modules:{'node-pty':{spawn:()=>proc}}});
 const terminal=new(e.load('src/bridges/terminal.ts').TerminalBridge)({cwd:e.dir});
 terminal.onClose(()=>closed++);await terminal.ready();terminal.close();exit({exitCode:0});terminal.close();
 assert.equal(killed,1);assert.equal(closed,1);assert.equal(terminal.proc,null);
});

test('configured relative Windows extension path resolves independently from npm names',()=>{
 const win=require('node:path').win32,fs=require('node:fs');
 const spec='团队 工具\\审阅 #1.mjs', expected=win.resolve('C:\\工作',spec);
 const atPath='@team\\工具.mjs', drive='C:扩展.mjs', unc='\\\\server\\share\\工具 #1.mjs';
 const settings='C:\\配置\\settings.json';
 const fakeFS={...fs,existsSync:()=>false,
   readFileSync(file){if(file===settings)return JSON.stringify({extensions:[spec,'@scope/example',atPath,drive,unc,'@scope/example/entry']});throw Object.assign(Error('not found'),{code:'ENOENT'});},
   readdirSync:()=>[],statSync(){return {isFile:()=>true,isDirectory:()=>false}}};
 const e=env({globals:{process:{...process,platform:'win32'}},modules:{'node:path':{...win,resolve:(...parts)=>win.resolve('C:\\工作',...parts)},'node:fs':fakeFS}});
 const [local,npm,at,driveLocal,network,subpath]=e.load('src/plugins.ts').pluginCatalog(settings);
 assert.equal(local.sessionSpecifier,expected);
 assert.equal(at.sessionSpecifier,win.resolve('C:\\工作',atPath));
 assert.equal(driveLocal.sessionSpecifier,win.resolve('C:\\工作',drive));
 assert.equal(network.sessionSpecifier,unc);
 assert.equal(npm.sessionSpecifier,'@scope/example');
 assert.equal(subpath.sessionSpecifier,'@scope/example/entry');
});

test('ACP on Windows uses an argv-aware launcher for shims and paths containing spaces',async()=>{
 const command='C:\\Program Files\\测试\\agent.cmd', args=['--label','A & B',''];
 let invocation;const sentinel=Error('fixture stopped before spawn');
 const e=env({globals:{process:{...process,platform:'win32'}},modules:{
  'node:module':{createRequire:()=>id=>{assert.equal(id,'cross-spawn');return (...values)=>{invocation=values;throw sentinel;};}},
  'node:child_process':{spawn(){throw Error('raw shell launch');}}
 }});
 const {AcpBridge}=e.load('src/bridges/acp.ts');
 await assert.rejects(new AcpBridge({cwd:e.dir,extra:{command,args}}).ready(),err=>err===sentinel);
 assert.equal(invocation[0],command);assert.deepEqual(invocation[1],args);
 assert(!invocation[2].shell);assert.equal(invocation[2].cwd,e.dir);
});

test('ACP resolves a command using its configured child PATH',async()=>{
 const fs=require('node:fs'),path=require('node:path');
 const sentinel=Error('fixture stopped before spawn');
 let launched;
 const e=env({globals:{process:{...process,platform:'linux',env:{}}},modules:{
  'node:child_process':{spawn(file,_args,options){launched={file,env:options.env};throw sentinel;}}
 }});
 const name='ashub-acp-path-fixture';
 const outer=path.join(e.dir,'outer'),child=path.join(e.dir,'child');
 for(const dir of [outer,child]){
  fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,name),'fixture',{mode:0o755});
 }
 e.context.process.env.PATH=outer;
 const {AcpBridge}=e.load('src/bridges/acp.ts');
 await assert.rejects(new AcpBridge({cwd:e.dir,extra:{command:name,env:{PATH:child}}}).ready(),err=>err===sentinel);
 assert.equal(launched.file,name);
 assert.equal(launched.env.PATH.split(path.delimiter)[0],child);
 assert(!launched.env.PATH.split(path.delimiter).includes(outer));
});
