const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');
const {readSource,stageUpload,downloadGrant}=require('../electron/browser-files.cjs');
function context(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'browser-file-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('local source snapshot is bounded and cannot follow a link outside workspace',t=>{
 const root=context(t);fs.writeFileSync(path.join(root,'code'),'hello');
 assert.equal(readSource(root,'code',true).text,'hello');
 const stage=stageUpload(readSource(root,'code'));t.after(stage.dispose);
 fs.writeFileSync(path.join(root,'code'),'changed');assert.equal(fs.readFileSync(stage.file,'utf8'),'hello');
 fs.symlinkSync(os.tmpdir(),path.join(root,'out'));assert.throws(()=>readSource(root,'out'),/inside/);
 assert.throws(()=>readSource(root,'../'),/inside/);
 fs.writeFileSync(path.join(root,'large'),'x'.repeat(262145));assert.throws(()=>readSource(root,'large',true),/at most/);
 fs.writeFileSync(path.join(root,'null'),'a\0b');assert.throws(()=>readSource(root,'null',true),/UTF-8/);
 assert.throws(()=>readSource(undefined,'code'),/working directory/);
});
function item(url='blob:https://files.example/uuid',size=4){return Object.assign(new EventEmitter(),{
 getURL:()=>url,getFilename:()=> '../../CON.csv',getTotalBytes:()=>size,getReceivedBytes:()=>size,
 setSavePath(file){this.file=file;},cancel(){this.cancelled=true;this.emit('done',{},'cancelled');}
});}
function grant(root,extra={}){const page={contents:{},origin:'https://files.example'},controller=new AbortController();return {page,controller,g:downloadGrant({page,cwd:root,signal:controller.signal,confirmReceived:async()=>true,...extra})};}
function event(){return {preventDefault(){this.blocked=true;}};}
test('download grants bind webContents, consume one file, and use safe unique output paths',async t=>{
 const root=context(t),{page,g}=grant(root),bad=event(),a=item();
 g.accept(bad,a,{});assert(bad.blocked);
 const good=event();g.accept(good,a,page.contents);assert(!good.blocked);assert.equal(path.basename(a.file),'result-CON.csv');
 const second=event();g.accept(second,item(),page.contents);assert(second.blocked);
 fs.writeFileSync(a.file,'data');a.emit('done',{},'completed');
 const result=await g.promise;assert.equal(result.status,'completed');assert.equal(result.bytes,4);assert.equal(page.download,null);
 g.cancel();assert(fs.existsSync(result.path),'cleanup does not delete completed artifact');
});
test('downloads reject cross-origin files and oversized files without a save path',async t=>{
 const root=context(t);
 for(const a of [item('https://other.example/data'),item('blob:https://files.example/a',67108865)]){
  const {page,g}=grant(root),e=event();g.accept(e,a,page.contents);assert(e.blocked);assert.equal(a.file,undefined);
  assert.equal((await g.promise).status,'unverified');
 }
});
test('cancel and transfer interruption remove partial files and release grant',async t=>{
 const root=context(t);
 for(const cancel of [true,false]){
  const {page,g,controller}=grant(root),a=item();g.accept(event(),a,page.contents);fs.writeFileSync(a.file,'part');
  if(cancel)controller.abort();else a.emit('updated',{},'interrupted');
  assert.equal((await g.promise).status,'unverified');assert.equal(page.download,null);assert(!fs.existsSync(a.file));assert(a.cancelled);
 }
});
test('unknown-length transfer exceeding cap is cancelled; idle grant times out',async t=>{
 const root=context(t),{page,g}=grant(root),a=item();a.getTotalBytes=()=>0;g.accept(event(),a,page.contents);
 a.getReceivedBytes=()=>67108865;a.emit('updated',{},'progressing');assert.equal((await g.promise).status,'unverified');
 const idle=grant(root,{timeoutMs:5});assert.match((await idle.g.promise).message,/timed out/);
});

test('multibyte download filenames stay within filesystem byte limits',async t=>{
 const root=context(t),{page,g}=grant(root),a=item();a.getFilename=()=> '收益🧭'.repeat(100)+'.csv';
 g.accept(event(),a,page.contents);assert(Buffer.byteLength(path.basename(a.file))<=187);
 fs.writeFileSync(a.file,'data');a.emit('done',{},'completed');assert.equal((await g.promise).status,'completed');
});

test('file-enabled browser plugin rejects hosts with only the original page capability',async()=>{
 const {parsePluginManifest,pluginCompatibility}=await import('../dist/extensions/manifest.js');
 const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/extensions/browser-automation/ashub-plugin.json'),'utf8'));
 const manifest=parsePluginManifest(raw,raw.id);
 assert.equal(pluginCompatibility(manifest,{capabilities:['session-extensions','browser-pages']}).compatible,false);
 assert.equal(pluginCompatibility(manifest,{capabilities:['session-extensions','browser-pages','browser-files']}).compatible,true);
});

test('POSIX FIFO sources are rejected without blocking the host', {skip:process.platform==='win32'}, t=>{
 const {spawnSync}=require('node:child_process');const root=context(t);
 const fifo=path.join(root,'source.pipe');assert.equal(spawnSync('mkfifo',[fifo]).status,0);
 const child=spawnSync(process.execPath,['-e',`try { require(${JSON.stringify(require.resolve('../electron/browser-files.cjs'))}).readSource(${JSON.stringify(root)}, 'source.pipe');process.exit(2); } catch(e) { console.log(e.message); }`],{timeout:3000,encoding:'utf8'});
 assert.equal(child.error,undefined,'readSource blocked on a FIFO: '+child.error);
 assert.equal(child.status,0);assert.match(child.stdout,/regular file/);
});

test('POSIX source swapped to FIFO between lstat and open still cannot block', {skip:process.platform==='win32'}, t=>{
 const {spawnSync}=require('node:child_process');const root=context(t),file=path.join(root,'source');fs.writeFileSync(file,'data');
 const script=`const fs=require('node:fs');const open=fs.openSync;fs.openSync=(name,...args)=>{if(name===${JSON.stringify(fs.realpathSync(file))}) {fs.unlinkSync(name);require('node:child_process').spawnSync('mkfifo',[name]);}return open(name,...args);};try{require(${JSON.stringify(require.resolve('../electron/browser-files.cjs'))}).readSource(${JSON.stringify(root)},'source');process.exit(2);}catch(e){console.log(e.message);}`;
 const child=spawnSync(process.execPath,['-e',script],{timeout:3000,encoding:'utf8'});
 assert.equal(child.error,undefined,'race blocked source open: '+child.error);assert.equal(child.status,0);assert.match(child.stdout,/regular file/);
});

test('uncertain download quarantines its page and rejects late events until a fresh page',async t=>{
 const root=context(t),{page,g,controller}=grant(root);controller.abort();
 const result=await g.promise;assert.equal(result.reopenRequired,true);assert.equal(page.downloadNeedsReset,true);
 assert.throws(()=>downloadGrant({page,cwd:root,signal:new AbortController().signal}),/Reopen/);
 const late=event(),a=item();g.accept(late,a,page.contents);assert(late.blocked);assert.equal(a.file,undefined);
 const fresh=grant(root);fresh.g.discard();await fresh.g.promise;assert.notEqual(fresh.page.downloadNeedsReset,true);
 const next=downloadGrant({page:fresh.page,cwd:root,signal:new AbortController().signal});next.discard();await next.promise;
});
test('a definite pre-click rejection does not quarantine the page',async t=>{
 const root=context(t),{page,g}=grant(root);g.discard();
 assert.equal((await g.promise).reopenRequired,false);assert.notEqual(page.downloadNeedsReset,true);
 const next=downloadGrant({page,cwd:root,signal:new AbortController().signal});next.discard();await next.promise;
});

test('completed download also requires a fresh page before another grant',async t=>{
 const root=context(t),{page,g}=grant(root),first=item();g.accept(event(),first,page.contents);
 fs.writeFileSync(first.file,'data');first.emit('done',{},'completed');
 const done=await g.promise;assert.equal(done.status,'completed');assert.equal(done.reopenRequired,true);
 assert.throws(()=>downloadGrant({page,cwd:root,signal:new AbortController().signal}),/Reopen/);
 const late=event(),extra=item();g.accept(late,extra,page.contents);assert(late.blocked);assert.equal(extra.file,undefined);
 g.cancel();assert.equal(fs.readFileSync(done.path,'utf8'),'data','completed artifact must remain intact');
});

test('actual file needs explicit consent before it appears in the workspace',async t=>{
 const root=context(t);
 for(const decision of [false,'automatic']){
  let seen;const {page,g}=grant(root,{confirmReceived:async metadata=>{seen=metadata;assert.deepEqual(fs.readdirSync(root),[]);return decision;}}),a=item();
  g.accept(event(),a,page.contents);fs.writeFileSync(a.file,'unexpected');a.emit('done',{},'completed');
  assert.equal((await g.promise).status,'unverified');assert.equal(seen.preview,'unexpected');assert.equal(seen.triggerVerified,false);
  assert.deepEqual(fs.readdirSync(root),[]);assert(!fs.existsSync(a.file));
 }
});
test('approval publishes exactly the reviewed bytes and marks trigger attribution unverified',async t=>{
 const root=context(t);let a;
 const {page,g}=grant(root,{confirmReceived:async metadata=>{assert.equal(metadata.preview,'approved');fs.writeFileSync(a.file,'replaced');return true;}});
 a=item();g.accept(event(),a,page.contents);fs.writeFileSync(a.file,'approved');a.emit('done',{},'completed');
 const result=await g.promise;assert.equal(result.status,'completed');assert.equal(result.triggerVerified,false);assert.equal(result.attribution,'user-confirmed-file');
 assert.equal(fs.readFileSync(result.path,'utf8'),'approved');assert(!fs.existsSync(a.file));
});
test('cancel during actual-file consent rejects late approval and removes the staged file',async t=>{
 const root=context(t);let answer;
 const {page,g,controller}=grant(root,{confirmReceived:()=>new Promise(resolve=>{answer=resolve;})}),a=item();
 g.accept(event(),a,page.contents);fs.writeFileSync(a.file,'pending');a.emit('done',{},'completed');
 assert(answer);controller.abort();assert.equal((await g.promise).status,'unverified');answer(true);
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fs.readdirSync(root),[]);assert(!fs.existsSync(a.file));
});

test('changing the destination directory during file approval does not redirect publication',async t=>{
 const container=context(t),root=path.join(container,'work');fs.mkdirSync(root);
 const {page,g}=grant(root,{confirmReceived:async()=>{fs.renameSync(root,path.join(container,'old'));fs.mkdirSync(root);return true;}}),a=item();
 g.accept(event(),a,page.contents);fs.writeFileSync(a.file,'data');a.emit('done',{},'completed');
 const result=await g.promise;assert.equal(result.status,'unverified');assert.match(result.message,/directory changed/);assert.deepEqual(fs.readdirSync(root),[]);
});

test('symlink rebinding of cwd during actual-file confirmation cannot redirect saving',async t=>{
 const container=context(t),root=path.join(container,'project'),other=path.join(container,'other');fs.mkdirSync(root);fs.mkdirSync(other);
 const {page,g}=grant(root,{confirmReceived:async()=>{fs.renameSync(root,path.join(container,'original'));fs.symlinkSync(other,root,process.platform==='win32'?'junction':'dir');return true;}}),a=item();
 g.accept(event(),a,page.contents);fs.writeFileSync(a.file,'approved');a.emit('done',{},'completed');
 const result=await g.promise;assert.equal(result.status,'unverified');assert.match(result.message,/directory changed/);assert.deepEqual(fs.readdirSync(other),[]);assert(!fs.existsSync(a.file));
});

test('a staged download replaced by a symlink never reads or chmods the target',async t=>{
 const root=context(t),outside=path.join(root,'private.txt');fs.writeFileSync(outside,'unrelated private data',{mode:0o644});
 const originalMode=fs.statSync(outside).mode;
 let prompted=false;const {page,g}=grant(root,{confirmReceived:async()=>{prompted=true;return true;}}),a=item();
 g.accept(event(),a,page.contents);fs.symlinkSync(outside,a.file);
 a.emit('done',{},'completed');const result=await g.promise;
 assert.equal(result.status,'unverified');assert.equal(prompted,false);
 assert.equal(fs.statSync(outside).mode,originalMode);assert.equal(fs.readFileSync(outside,'utf8'),'unrelated private data');
 assert.deepEqual(fs.readdirSync(root),['private.txt']);assert(!fs.existsSync(path.dirname(a.file)));
});

test('staged receipt replaced by FIFO during open cannot block the host', {skip:process.platform==='win32'}, t=>{
 const {spawnSync}=require('node:child_process'),root=context(t);
 const script=`const fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
 const page={contents:{},origin:'https://files.example'},controller=new AbortController();
 const g=require(${JSON.stringify(require.resolve('../electron/browser-files.cjs'))}).downloadGrant({page,cwd:${JSON.stringify(root)},signal:controller.signal,timeoutMs:500,confirmReceived:async()=>true});
 const a=Object.assign(new EventEmitter(),{getURL:()=> 'https://files.example/data',getFilename:()=> 'file',getTotalBytes:()=>4,setSavePath(f){this.file=f;},cancel(){}});
 g.accept({preventDefault(){}},a,page.contents);fs.writeFileSync(a.file,'data');
 const open=fs.openSync;fs.openSync=(name,...args)=>{if(name===a.file){fs.unlinkSync(name);require('node:child_process').spawnSync('mkfifo',[name]);}return open(name,...args);};
 a.emit('done',{},'completed');g.promise.then(result=>{if(result.status!=='unverified')process.exit(2);console.log(result.message);});`;
 const child=spawnSync(process.execPath,['-e',script],{timeout:3000,encoding:'utf8'});
 assert.equal(child.error,undefined,'staged receipt blocked host: '+child.error);assert.equal(child.status,0);assert.match(child.stdout,/regular file|changed/);
});

test('actual-file confirmation timeout aborts consent and late approval cannot publish',async t=>{
 const root=context(t);let answer,approvalSignal;
 const {page,g}=grant(root,{timeoutMs:10,confirmReceived:(_metadata,signal)=>{approvalSignal=signal;return new Promise(resolve=>{answer=resolve;});}}),a=item();
 g.accept(event(),a,page.contents);fs.writeFileSync(a.file,'data');a.emit('done',{},'completed');
 assert.equal((await g.promise).status,'unverified');assert(approvalSignal.aborted);assert(!fs.existsSync(a.file));
 answer(true);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fs.readdirSync(root),[]);
});

test('failed cleanup waits for both paths and reports only files still needing removal',async t=>{
 for(const failure of ['staging','published','both']) {
  const root=context(t),{page,g}=grant(root),a=item();g.accept(event(),a,page.contents);fs.writeFileSync(a.file,'data');
  const stage=path.dirname(a.file),rm=fs.promises.rm;let stageCalls=0,published;
  t.after(()=>fs.rmSync(stage,{recursive:true,force:true}));
  fs.promises.rm=async(dir,...args)=>{
   if(dir===stage){stageCalls++;if(stageCalls===1 || failure!=='published')throw Object.assign(Error('staging locked'),{code:'EBUSY'});}
   else if(dir){published=path.join(dir,path.basename(a.file));if(failure!=='staging')throw Object.assign(Error('published locked'),{code:'EBUSY'});}
   return rm(dir,...args);
  };
  try {
   a.emit('done',{},'completed');const result=await g.promise;assert.equal(result.status,'unverified');
   const expected=failure==='staging'?[a.file]:failure==='published'?[published]:[a.file,published];
   assert.deepEqual(result.partialPaths,expected);assert.equal(result.partialPath,expected[0]);
   for(const file of expected)assert(fs.existsSync(file),'reported path must still exist: '+file);
   if(failure==='staging')assert.deepEqual(fs.readdirSync(root),[],'other cleanup must finish before result');
   if(failure==='published')assert(!fs.existsSync(stage));
  } finally {fs.promises.rm=rm;}
 }
});
