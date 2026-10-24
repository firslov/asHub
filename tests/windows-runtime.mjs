// Run on Windows both with Node and the unpacked app's Electron runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
assert.equal(process.platform,'win32','This check requires a real Windows host');
const appRoot=path.resolve(process.argv[2] || '.');
const requireApp=createRequire(path.join(appRoot,'package.json'));
const load=rel=>import(pathToFileURL(path.join(appRoot,rel)).href);
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'asHub 空格 Windows-'));
const watchdog=setTimeout(()=>{console.error('Windows runtime timed out');process.exit(1);},45000).unref();
try {
 const key=Object.keys(process.env).find(k=>k.toLowerCase()==='path');
 // Reproduce a standard Git installer PATH, excluding CI's extra Bash paths.
 const gitRoot=path.join(process.env.ProgramFiles,'Git');
 process.env[key]=[path.join(process.env.SystemRoot,'System32'),path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0'),path.join(gitRoot,'cmd'),path.dirname(process.execPath)].join(';');
 await load('dist/windows-bootstrap.js');
 const {executeCommand,findBash}=await import(pathToFileURL(requireApp.resolve('agent-sh/executor')).href);
 assert.match(findBash(),/Git[\\/]bin[\\/]bash\.exe$/i);
 const {session,done}=executeCommand({command:"printf 'WINDOWS_BASH_OK' > '结果 文件.txt'; cat '结果 文件.txt'",cwd:dir});
 await done;assert.equal(session.exitCode,0,session.output);
 assert.equal(await fs.readFile(path.join(dir,'结果 文件.txt'),'utf8'),'WINDOWS_BASH_OK');
 console.log('PASS Git Bash discovery and command execution in a Unicode directory');
 const {rgPath}=await import(pathToFileURL(requireApp.resolve('@vscode/ripgrep')).href);
 assert.match(execFileSync(rgPath,['WINDOWS_BASH_OK',dir],{encoding:'utf8'}),/WINDOWS_BASH_OK/);
 console.log('PASS packaged native ripgrep');
 const {openArtifact}=await load('dist/artifacts.js');
 const artifact=await openArtifact(dir,'结果 文件.txt');assert.equal(await artifact.file.readFile('utf8'),'WINDOWS_BASH_OK');await artifact.file.close();
 await assert.rejects(openArtifact(dir,'..\\outside.txt'),e=>e.status===403);
 const external=await fs.mkdtemp(path.join(os.tmpdir(),'ashub-outside-'));
 try {await fs.symlink(external,path.join(dir,'junction'),'junction');await fs.writeFile(path.join(external,'secret.txt'),'outside');await assert.rejects(openArtifact(dir,'junction\\secret.txt'),e=>e.status===403);}
 finally {await fs.rm(path.join(dir,'junction'),{recursive:true,force:true});await fs.rm(external,{recursive:true,force:true});}
 console.log('PASS Unicode artifact downloads, parent paths and NTFS junction containment');
 const {TerminalBridge}=await load('dist/bridges/terminal.js');
 const terminal=new TerminalBridge({cwd:dir});
 let output='';const closed=new Promise(resolve=>terminal.onClose(resolve));
 terminal.onEvent(e=>{if(e.name==='shell:pty-data')output+=e.payload.raw;});
 try {
  await terminal.ready();
  const until=Date.now()+10000;while(!output && Date.now()<until)await new Promise(r=>setTimeout(r,50));
  assert(output,'ConPTY must render a prompt');terminal.resizePty(110,32);
  terminal.writePty("powershell.exe -NoProfile -Command \"Write-Output ('ASHUB_CONPTY_' + 'OK')\"\r");
  const deadline=Date.now()+10000;while(!output.includes('ASHUB_CONPTY_OK')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
  assert(output.includes('ASHUB_CONPTY_OK'),output);
  terminal.writePty('exit\r');await closed;
 } finally {terminal.close();}
 console.log('PASS native ConPTY startup, output, resize and exit');
} finally {await fs.rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:200});}
