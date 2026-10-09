const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {EventEmitter}=require('node:events');const {createUsageReporter}=require('../electron/usage.cjs');
function setup(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-usage-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let time=Date.parse('2026-10-08T04:00:00Z'),active=true,status=204,calls=[];
 const transport={request(url,opts,cb){const req=new EventEmitter();req.destroy=error=>{if(error)req.emit('error',error);req.emit('close')};req.end=body=>{calls.push({url,opts,body:JSON.parse(body)});queueMicrotask(()=>{if(status===0){req.destroy(new Error('offline'));return}const res=new EventEmitter();res.statusCode=status;res.resume=()=>{};cb(res)})};return req}};
 const opts={userData:dir,version:'0.20.2',isActive:()=>active,now:()=>time,transport,...options};const reporter=createUsageReporter(opts);t.after(()=>reporter.stop());
 return {reporter,opts,dir,calls,setActive:v=>active=v,setStatus:v=>status=v,advance:ms=>time+=ms,setTime:v=>time=Date.parse(v),tick:async()=>{reporter.tick();await new Promise(setImmediate)}};
}
test('Activity is optional, foreground-only, throttled hourly and independent of updates',async t=>{
 const f=setup(t);f.setActive(false);await f.tick();assert.equal(f.calls.length,0);f.setActive(true);await f.tick();await f.tick();assert.equal(f.calls.length,1);f.advance(3600000);await f.tick();assert.equal(f.calls.length,2);assert.deepEqual(Object.keys(f.calls[0].body).sort(),['arch','clientId','platform','version']);
 f.reporter.setEnabled(false);f.advance(3600000);await f.tick();assert.equal(f.calls.length,2);const next=createUsageReporter(f.opts);assert.equal(next.enabled,false);next.stop();
});
test('Shanghai midnight permits new-day report even inside hourly window',async t=>{
 const f=setup(t);f.setTime('2026-10-07T15:59:00Z');await f.tick();f.advance(120000);await f.tick();assert.equal(f.calls.length,2);
});
test('Installation ID persists; unwritable storage never creates counted transient IDs',t=>{
 const f=setup(t);const first=f.reporter.getInstallId();assert.equal(createUsageReporter(f.opts).getInstallId(),first);
 const denied={...fs,readFileSync(){throw Object.assign(new Error(),{code:'ENOENT'})},writeFileSync(){throw new Error('read only')}};const g=setup(t,{fileSystem:denied});assert.equal(g.reporter.getInstallId(),'');assert.equal(g.reporter.getInstallId(),'');
});
test('Network failure backs off silently; stop prevents further reports',async t=>{
 const f=setup(t);f.setStatus(0);await f.tick();await f.tick();assert.equal(f.calls.length,1);f.advance(15*60000);f.setStatus(204);await f.tick();assert.equal(f.calls.length,2);f.reporter.stop();f.advance(3600000);await f.tick();assert.equal(f.calls.length,2);
});
test('Failed preference write preserves state and environment opt-out wins',t=>{
 const f=setup(t,{disabled:true});assert.equal(f.reporter.enabled,false);assert.equal(f.reporter.setEnabled(true).ok,false);
 const g=setup(t,{fileSystem:{...fs,writeFileSync(){throw Error('permission denied')}}});assert.equal(g.reporter.enabled,true);assert.equal(g.reporter.setEnabled(false).ok,false);assert.equal(g.reporter.enabled,true);
});
test('Corrupt preferences fail closed',t=>{const f=setup(t);fs.writeFileSync(path.join(f.dir,'usage-preferences.json'),'broken');const next=createUsageReporter(f.opts);assert.equal(next.enabled,false);next.stop()});
test('Updater recovers mirror after cooldown but does not switch an active download',()=>{
 const vm=require('node:vm');const source=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');const part=source.slice(source.indexOf('let mirrorFailed = false;'),source.indexOf('let mainWindow = null;'));
 let time=1000000,checks=0,feeds=[];const ctx={Date:{now:()=>time},autoUpdater:{setFeedURL:v=>feeds.push(v),checkForUpdates:()=>{checks++;return Promise.resolve()}},MIRROR_URL:'https://mirror.test',GITHUB_OWNER:'owner',GITHUB_REPO:'repo',isDev:false,hasDownloadedUpdate:()=>false,console:{log(){},error(){}}};vm.createContext(ctx);vm.runInContext(part,ctx);
 ctx.fallbackToGitHub();assert.equal(feeds.at(-1).provider,'github');ctx.checkForUpdatesWithRecovery();assert.equal(feeds.length,1);time+=15*60000;vm.runInContext('updateDownloadInProgress=true',ctx);ctx.checkForUpdatesWithRecovery();assert.equal(feeds.length,1);vm.runInContext('updateDownloadInProgress=false',ctx);ctx.checkForUpdatesWithRecovery();assert.equal(feeds.at(-1).provider,'generic');assert.equal(ctx.autoUpdater.requestHeaders['X-Ashub-Stats'],'off');assert.equal(checks,4);
});
