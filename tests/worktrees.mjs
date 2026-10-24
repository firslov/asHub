import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createIsolatedWorkspace,workspaceInfo} from '../dist/worktrees.js';

test('isolated worktrees keep the source dirty files intact and use a different branch/root',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ashub-worktree-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const repo=path.join(dir,'repo'),outputs=path.join(dir,'isolated');await fs.mkdir(repo);
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:os.devNull,GIT_CONFIG_NOSYSTEM:'1'}}).trim();
 git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
 await fs.mkdir(path.join(repo,'src'));await fs.writeFile(path.join(repo,'src','file.txt'),'committed');
 git('add','.');git('commit','-qm','Initial');
 const branch=git('branch','--show-current');await fs.writeFile(path.join(repo,'src','file.txt'),'uncommitted');
 await fs.writeFile(path.join(repo,'untracked.txt'),'local');
 const isolated=await createIsolatedWorkspace(path.join(repo,'src'),outputs);
 assert.equal(await fs.readFile(path.join(isolated.cwd,'file.txt'),'utf8'),'committed');
 assert.equal(await fs.readFile(path.join(repo,'src','file.txt'),'utf8'),'uncommitted');
 await assert.rejects(fs.stat(path.join(isolated.root,'untracked.txt')));
 assert.equal(git('branch','--show-current'),branch);assert.match(isolated.branch,/^ashub\//);
 const source=await workspaceInfo(repo),target=await workspaceInfo(isolated.cwd);
 assert.notEqual(source.root,target.root);assert.equal(target.branch,isolated.branch);
 const other=await createIsolatedWorkspace(repo,outputs);assert.notEqual(other.root,isolated.root);
 await assert.rejects(createIsolatedWorkspace(dir,outputs));
});

test('a committed symlink must not select a working directory outside the isolated checkout',async t=>{
 if(process.platform==='win32') return t.skip('POSIX symlink fixture');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ashub-worktree-link-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const repo=path.join(dir,'repo'),external=path.join(dir,'external');
 await fs.mkdir(repo);await fs.mkdir(external);
 const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:os.devNull,GIT_CONFIG_NOSYSTEM:'1'}}).trim();
 git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
 await fs.symlink(external,path.join(repo,'src'));git('add','.');git('commit','-qm','Directory link');
 // The source has an uncommitted replacement directory, but HEAD still has a link.
 await fs.unlink(path.join(repo,'src'));await fs.mkdir(path.join(repo,'src'));
 const isolated=await createIsolatedWorkspace(path.join(repo,'src'),path.join(dir,'worktrees'));
 assert.equal(await fs.realpath(isolated.cwd),await fs.realpath(isolated.root),'must fall back to the checkout root');
});
