import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopService } from '../dist/service.js';
import { DesktopRuntime } from '../dist/runtime.js';
import { StdioDriver } from '../dist/mcp.js';
import { activateDesktopControl, isDesktopControlTool } from '../dist/plugin.js';
import { writeDesktopSettings, readDesktopSettings, settingsRevision } from '../dist/settings.js';
const tick = () => new Promise(r => setImmediate(r));
const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const imageReply = screenshot => ({ ...reply({screenshot}), content:[{type:'image',data:'iVBORw0KGgo=',mimeType:'image/png'}] });
function fixture(t, options = {}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-desktop-'));const file=path.join(dir,'settings.json');
 fs.writeFileSync(file,JSON.stringify({'desktop-control':{enabled:true,allowedApps:['com.test.App','com.test.Other']}}));
 let sequence=0;const calls=[];
 const app={pid:10,name:'Test app',bundle_id:'com.test.App'};
 const window={window_id:100,title:'Window',on_screen:true,bounds:{x:0,y:0,width:500,height:300}};
 const driver={async call(name,args={},signal){
  calls.push({name,args,signal});
  if(signal?.aborted)throw Error('aborted');
  if(options.call){const r=await options.call(name,args,signal);if(r!==undefined)return r;}
  if(name==='status')return reply({permissions:{accessibility:true,screen_recording:true},background_input:true});
  if(name==='apps')return reply({apps:[app,{pid:20,name:'Other',bundle_id:'com.test.Other'},{pid:30,name:'Private',bundle_id:'com.private.App'}]});
  if(name==='windows')return reply({windows:[window]});
  if(name==='observe')return reply({snapshot:'s'+ ++sequence,window_id:100,elements:[{id:'button1',name:'Test',actions:['CLICK']}]});
  if(['act','click_at','drag','scroll_at','press'].includes(name))return reply({status:'done',fresh:{snapshot:'s'+ ++sequence,window_id:100,elements:[]}});
  if(name==='release')return reply({released:[args.pid]});
  if(name==='screenshot')return imageReply({width:2*(window.bounds?.width??500),height:2*(window.bounds?.height??300),scale:2,window_id:100});
  throw Error('unexpected '+name);
 },async close(){calls.push({name:'close'});}};
 const service=new DesktopService(file,{platform:'darwin',factory:()=>driver,...options});
 t.after(async()=>{await service.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {service,file,calls,app,window};
}
test('settings validate scope, preserve unrelated settings, and reject conflicting writes',t=>{
 const {file}=fixture(t);const old=readDesktopSettings(file);
 const original=JSON.parse(fs.readFileSync(file));original.untouched={value:42};fs.writeFileSync(file,JSON.stringify(original));
 assert.throws(()=>writeDesktopSettings(file,{enabled:true,allowedApps:['*']},settingsRevision(old)));
 assert.throws(()=>writeDesktopSettings(file,{enabled:true,allowedApps:[]},'stale'),/changed/);
 writeDesktopSettings(file,{enabled:false,allowedApps:['com.test.App']},settingsRevision(old));assert.equal(readDesktopSettings(file).enabled,false);
 assert.deepEqual(JSON.parse(fs.readFileSync(file)).untouched,{value:42});
});
test('driver and tools remain lazy; allowlist filters apps and prevents unauthorized windows',async t=>{
 const {service,calls}=fixture(t);await service.status();assert.equal(calls.length,0);
 assert.equal((await service.apps()).apps.length,2);
 await assert.rejects(service.windows('com.private.App'),/not allowed/);
 assert.equal(calls.filter(c=>c.name==='windows').length,0);
});
test('whole tasks queue across conversations; release happens before next observation',async t=>{
 const {service,calls}=fixture(t);const a=Symbol(),b=Symbol();
 await service.acquire(a,'com.test.App',100);let started=false;
 const waiting=service.acquire(b,'com.test.Other',100).then(x=>{started=true;return x;});await tick();assert.equal(started,false);
 await service.finish(a);await waiting;
 const release=calls.findIndex(c=>c.name==='release');const observations=calls.map((c,i)=>c.name==='observe'?i:-1).filter(i=>i>=0);
 assert(observations[1]>release);await service.finish(b);
});
test('cancelled queued task never operates; closing another conversation leaves current task intact',async t=>{
 const {service,calls}=fixture(t);const a=Symbol(),b=Symbol(),c=new AbortController();
 const state=await service.acquire(a,'com.test.App',100);
 const queued=service.acquire(b,'com.test.Other',100,c.signal);const rejected=assert.rejects(queued,/cancelled/);c.abort();await rejected;await service.finish(b);
 await service.call(a,'act',{snapshot:state.snapshot,element:'button1',action:'CLICK'});
 assert.equal(calls.filter(c=>c.name==='observe').length,1);
});
test('snapshots are task scoped, foreign target IDs are rejected, and release expires ownership',async t=>{
 const {service,calls}=fixture(t);const a=Symbol(),b=Symbol();const state=await service.acquire(a,'com.test.App',100);
 await assert.rejects(service.call(b,'act',{snapshot:state.snapshot}),/No active/);
 await assert.rejects(service.call(a,'act',{snapshot:'other'}),/snapshot/);
 await assert.rejects(service.call(a,'act',{snapshot:state.snapshot,pid:99}),/fixed/);
 await service.finish(a);await assert.rejects(service.call(a,'observe',{}),/No active/);assert.equal(calls.filter(c=>c.name==='act').length,0);
});
test('permission scope changes cancel active and queued tasks immediately',async t=>{
 const {service,file,calls}=fixture(t);const a=Symbol(),b=Symbol();await service.acquire(a,'com.test.App',100);
 const queued=service.acquire(b,'com.test.Other',100);const rejected=assert.rejects(queued,/cancelled/);
 await service.save({enabled:false,allowedApps:[]},settingsRevision(readDesktopSettings(file)));await rejected;
 assert(calls.some(c=>c.name==='release'));assert.equal((await service.status()).busy,false);
 await assert.rejects(service.apps(),/Enable/);
});
test('app PID reuse is rejected before operating the replacement application',async t=>{
 const {service,app,calls}=fixture(t);const a=Symbol();const s=await service.acquire(a,'com.test.App',100);app.bundle_id='com.private.App';
 await assert.rejects(service.call(a,'act',{snapshot:s.snapshot,action:'CLICK',element:'button1'}),/changed/);
 assert.equal(calls.filter(c=>c.name==='act').length,0);
});
test('screenshots remain images, coordinate input scales pixels and requires a fresh capture',async t=>{
 const {service,calls}=fixture(t);const a=Symbol();const s=await service.acquire(a,'com.test.App',100);
 await assert.rejects(service.call(a,'click_at',{snapshot:s.snapshot,x:200,y:100}),/screenshot/);
 const shot=await service.call(a,'screenshot',{snapshot:s.snapshot});assert.equal(shot.content[0].type,'image');
 await assert.rejects(service.call(a,'click_at',{snapshot:s.snapshot,x:1001,y:100}),/outside/);
 await service.call(a,'click_at',{snapshot:s.snapshot,x:200,y:100});
 const input=calls.find(c=>c.name==='click_at');assert.equal(input.args.x,100);assert.equal(input.args.y,50);assert.equal(input.args.window_id,100);
 await assert.rejects(service.call(a,'click_at',{snapshot:s.snapshot,x:200,y:100}),/screenshot/);
});
test('a resize invalidates screenshot coordinates and a new capture permits same-size window moves',async t=>{
 const {service,calls,window}=fixture(t);
 const owner=Symbol();const {snapshot}=await service.acquire(owner,'com.test.App',100);
 await service.call(owner,'screenshot',{snapshot});
 window.bounds.width=250;
 await assert.rejects(service.call(owner,'click_at',{snapshot,x:700,y:100}),/Window size changed/);
 assert(!calls.some(c=>c.name==='click_at'));
 await assert.rejects(service.call(owner,'click_at',{snapshot,x:200,y:100}),/Take a screenshot/);

 await service.call(owner,'screenshot',{snapshot});
 const {structuredContent}=await service.call(owner,'observe',{});
 assert.deepEqual(structuredContent.lastScreenshot,{snapshot,scale:2,width:500,height:600});
 window.bounds.x=400;
 window.bounds.y=120;
 await service.call(owner,'click_at',{snapshot,x:200,y:100});
 const {args}=calls.find(c=>c.name==='click_at');
 assert.deepEqual([args.x,args.y,args.window_id],[100,50,100]);
});
test('a height change prevents drag and coordinate scroll on the old image',async t=>{
 const {service,calls,window}=fixture(t);
 const owner=Symbol();const {snapshot}=await service.acquire(owner,'com.test.App',100);
 await service.call(owner,'screenshot',{snapshot});
 window.bounds.height=250;
 await assert.rejects(service.call(owner,'drag',{snapshot,points:[[10,20],[20,40]]}),/Window size changed/);
 await service.call(owner,'screenshot',{snapshot});
 window.bounds.height=200;
 await assert.rejects(service.call(owner,'scroll_at',{snapshot,x:20,y:40,dx:0,dy:20}),/Window size changed/);
 assert(!calls.some(c=>c.name==='drag'||c.name==='scroll_at'));
});
test('unavailable window size preserves read-only screenshots and blocks coordinate input',async t=>{
 const {service,calls,window}=fixture(t);
 const owner=Symbol();const {snapshot}=await service.acquire(owner,'com.test.App',100);
 const bounds=window.bounds;
 delete window.bounds;
 assert.equal((await service.call(owner,'screenshot',{snapshot})).content[0].type,'image');
 window.bounds=bounds;
 await assert.rejects(service.call(owner,'click_at',{snapshot,x:20,y:20}),/could not be verified/);

 await service.call(owner,'screenshot',{snapshot});
 delete window.bounds;
 await assert.rejects(service.call(owner,'click_at',{snapshot,x:20,y:20}),/could not be verified/);
 assert(!calls.some(c=>c.name==='click_at'));
});
for(const backend of ['legacy','modern']){
 test(`${backend} capture remains readable if the visible window resizes before capture returns`,async t=>{
  let firstCapture=true;
  function capture(){
   const {width,height}=window.bounds;
   const image=imageReply({width:width*2,height:height*2,scale:2,window_id:100});
   if(firstCapture){firstCapture=false;window.bounds.width=250;}
   return image;
  }
  const options=backend==='modern'?{capture}:{call:name=>name==='screenshot'?capture():undefined};
  const {service,calls,window}=fixture(t,options);
  const owner=Symbol();const {snapshot}=await service.acquire(owner,'com.test.App',100);
  const screenshot=await service.call(owner,'screenshot',{snapshot});
  assert.equal(screenshot.content[0].type,'image');
  assert.equal(screenshot.structuredContent.screenshot.width,1000);
  await assert.rejects(service.call(owner,'click_at',{snapshot,x:700,y:100}),/screenshot/);
  assert(!calls.some(c=>c.name==='click_at'));

  const fresh=await service.call(owner,'screenshot',{snapshot});
  assert.equal(fresh.structuredContent.screenshot.width,500);
  await service.call(owner,'click_at',{snapshot,x:200,y:100});
  assert.equal(calls.filter(c=>c.name==='click_at').length,1);
 });
}
test('legacy capture of a hidden window permits input using the parked window geometry',async t=>{
 const {service,calls,window}=fixture(t,{call(name){
  if(name==='screenshot'){
   window.on_screen=true;
   window.bounds={x:1280,y:0,width:500,height:300};
  }
 }});
 window.on_screen=false;
 window.bounds={x:0,y:0,width:400,height:250};
 const owner=Symbol();const {snapshot}=await service.acquire(owner,'com.test.App',100);
 const screenshot=await service.call(owner,'screenshot',{snapshot});
 assert.equal(screenshot.structuredContent.screenshot.width,1000);
 await service.call(owner,'click_at',{snapshot,x:900,y:100});
 const {args}=calls.find(c=>c.name==='click_at');
 assert.deepEqual([args.x,args.y,args.window_id],[450,50,100]);
});
test('a stalled task expires and hands control to the next conversation',async t=>{
 const {service}=fixture(t,{taskMs:35});const a=Symbol(),b=Symbol();await service.acquire(a,'com.test.App',100);
 const timer=setTimeout(()=>{},200);
 try{await service.acquire(b,'com.test.Other',100);await assert.rejects(service.call(a,'observe',{}),/No active/);}finally{clearTimeout(timer);}
});
test('cancellation releases an in-flight operation and prevents queued input after stop',async t=>{
 let entered;const started=new Promise(r=>entered=r);
 const {service,calls}=fixture(t,{call:(name,_args,signal)=>name==='act'?new Promise((_resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});}):undefined});
 const a=Symbol();const s=await service.acquire(a,'com.test.App',100);
 const work=service.call(a,'act',{snapshot:s.snapshot,action:'CLICK',element:'button1'});const rejected=assert.rejects(work,/cancelled/);
 await started;await service.stop();await rejected;assert(calls.some(c=>c.name==='release'));
});
function pluginContext(service,approved=true,image=true,hostApprove){
 const tools=new Map(),events=new Map(),disposers=[];let approvals=0;
 const registerTool=t=>tools.set(t.name,t);
 const ctx={agent:{registerTool,registerInstruction(){}},bus:{on:(e,f)=>events.set(e,f),emitPipeAsync:async (_event,payload)=>{approvals++;return typeof approved==='function'?approved(payload):{decision:{outcome:approved?'approved':'denied'}};}},onDispose:f=>disposers.push(f),call:name=>name==='agent:get-model'?{model:'test',provider:'fixture'}:[{id:'test',provider:'fixture',modalities:image?['text','image']:['text']}]};
 if(hostApprove)ctx.services={desktopControl:{registerTool,approve:async request=>{approvals++;return hostApprove(request);}}};
 activateDesktopControl(ctx,service);return {tools,events,disposers,approvals:()=>approvals};
}

test('desktop consent persists across conversations and service restart, but not across apps or revocation',async t=>{
 const {service,file,calls}=fixture(t);
 const app='com.test.App', other='com.test.Other';
 const start=(ctx,bundleId=app)=>ctx.tools.get('desktop_start').execute({bundleId,windowId:100,goal:'Test task'});
 const finish=ctx=>ctx.tools.get('desktop_finish').execute({});
 const once=pluginContext(service,false,true,()=>true);
 assert.equal((await start(once)).isError,false);await finish(once);
 assert.equal(service.desktopApproval(app).approved,false);
 const grant=pluginContext(service,false,true,request=>{
  assert.equal(request.application,app);assert.match(request.description,/Window 100/);
  request.remember();return true;
 });
 assert.equal((await start(grant)).isError,false);await service.syncSettings();
 assert.equal((await service.status()).busy,true);await finish(grant);
 const next=pluginContext(service,false,true,()=>false);
 assert.equal((await start(next)).isError,false);await finish(next);
 assert.equal(next.approvals(),0);
 assert.equal((await start(next,other)).isError,true);assert.equal(next.approvals(),1);
 const restarted=new DesktopService(file);t.after(()=>restarted.close());
 assert.equal(restarted.desktopApproval(app).approved,true);
 assert.equal(restarted.desktopApproval(other).approved,false);
 assert.equal((await start(next)).isError,false);
 const old=readDesktopSettings(file);
 await service.save({...old,approvedApps:[]},settingsRevision(old));
 assert.equal((await service.status()).busy,false);
 const observations=calls.filter(c=>c.name==='observe').length;
 assert.equal((await start(next)).isError,true);
 assert.equal(calls.filter(c=>c.name==='observe').length,observations);
 assert.equal(restarted.desktopApproval(app).approved,false);
});

test('concurrent permanent approvals for two allowed apps both persist',t=>{
 const {service,file}=fixture(t);
 const first=service.desktopApproval('com.test.App');
 const second=service.desktopApproval('com.test.Other');
 first.remember();second.remember();
 assert.deepEqual(readDesktopSettings(file).approvedApps,['com.test.App','com.test.Other']);
});

test('a desktop authorization from an outdated configuration cannot persist',async t=>{
 const {service,file}=fixture(t);
 const approval=service.desktopApproval('com.test.App');
 const old=readDesktopSettings(file);
 await service.save({...old,allowedApps:['com.test.Other']},settingsRevision(old));
 assert.throws(approval.remember,/changed/);
 assert.throws(()=>service.desktopApproval('com.test.App'),/no longer allowed/);
});
test('plugin requires approval before reading window contents and preserves screenshots',async t=>{
 const {service,calls}=fixture(t);const denied=pluginContext(service,false);
 assert.equal((await denied.tools.get('desktop_start').execute({bundleId:'com.test.App',windowId:100,goal:'Test'})).isError,true);
 assert.equal(calls.filter(c=>c.name==='observe').length,0);
 const p=pluginContext(service);const start=await p.tools.get('desktop_start').execute({bundleId:'com.test.App',windowId:100,goal:'Test'});
 assert.equal(start.isError,false);const s=JSON.parse(start.content).snapshot;
 const image=await p.tools.get('desktop_screenshot').execute({snapshot:s});assert.equal(image.content[0].type,'image');
 p.events.get('agent:processing-done')();await tick();assert.equal((await service.status()).busy,false);
});
test('desktop approval identifies the selected window before reading it',async t=>{
 const approvals=[];
 const {service,calls}=fixture(t,{call:name=>name==='windows'?reply({windows:[
  {window_id:100,title:'First sample'},
  {window_id:200,title:'<Second sample>\n\t\u202e selected '+'x'.repeat(220)},
  {window_id:300,title:'\r\t'},
 ]}):undefined});
 const p=pluginContext(service,payload=>{
  approvals.push(payload);
  return {decision:{outcome:'denied'}};
 });
 for(const windowId of [200,300]){
  const result=await p.tools.get('desktop_start').execute({bundleId:'com.test.App',windowId,goal:'Read the selected window'});
  assert.equal(result.isError,true);
  assert.match(result.content,/not approved/);
 }
 assert.deepEqual(approvals.map(payload=>payload.metadata.windowId),[200,300]);
 assert.equal(approvals[0].description.split('\n')[0],'Window 200 · '+('<Second sample> selected '+'x'.repeat(220)).slice(0,160));
 assert.equal(approvals[0].description.split('\n')[1],'Read the selected window');
 assert.equal(approvals[1].description.split('\n')[0],'Window 300 · Untitled window');
 assert(!calls.some(c=>c.name==='observe'||c.name==='screenshot'));
});
test('desktop pointer can retake a stale screenshot without reopening approval',async t=>{
 const {service,calls,window}=fixture(t);
 const p=pluginContext(service);
 const start=await p.tools.get('desktop_start').execute({bundleId:'com.test.App',windowId:100,goal:'Test'});
 assert.equal(start.isError,false);
 const {snapshot}=JSON.parse(start.content);
 const screenshot=p.tools.get('desktop_screenshot');
 const pointer=p.tools.get('desktop_pointer');
 assert.equal((await screenshot.execute({snapshot})).isError,false);
 window.bounds.width=250;
 const stale=await pointer.execute({snapshot,operation:'click_at',x:700,y:100});
 assert.equal(stale.isError,true);
 assert.match(stale.content,/fresh screenshot/);
 assert(!calls.some(c=>c.name==='click_at'));
 assert.equal((await screenshot.execute({snapshot})).isError,false);
 assert.equal((await pointer.execute({snapshot,operation:'click_at',x:200,y:100})).isError,false);
 assert.equal(p.approvals(),1);
});
test('text-only models preserve the active task while declining screenshots',async t=>{
 const {service,calls}=fixture(t);const p=pluginContext(service,true,false);
 const start=await p.tools.get('desktop_start').execute({bundleId:'com.test.App',windowId:100,goal:'Test'});
 assert.equal(start.isError,false);
 const r=await p.tools.get('desktop_screenshot').execute({snapshot:JSON.parse(start.content).snapshot});assert.equal(r.isError,true);
 assert.match(r.content,/image input/);
 const observation=await p.tools.get('desktop_observe').execute({});
 assert.equal(observation.isError,false);
 assert.equal(JSON.parse(observation.content).window_id,100);
 assert.equal(p.approvals(),1);
 assert.equal(calls.filter(c=>c.name==='screenshot').length,0);
 assert.equal(calls.filter(c=>c.name==='release').length,0);
});
test('screenshot execution failures still release the active task',async t=>{
 const {service,calls}=fixture(t,{call:name=>name==='screenshot'
  ?{...reply({message:'Screenshot execution failed'}),isError:true}
  :undefined});
 const p=pluginContext(service);
 const start=await p.tools.get('desktop_start').execute({bundleId:'com.test.App',windowId:100,goal:'Test'});
 assert.equal(start.isError,false);
 const result=await p.tools.get('desktop_screenshot').execute({snapshot:JSON.parse(start.content).snapshot});
 assert.equal(result.isError,true);
 assert.match(result.content,/Screenshot execution failed/);
 assert.equal((await service.status()).busy,false);
 assert.equal(calls.filter(c=>c.name==='release').length,1);
});
test('MCP stdio negotiates, cancels promptly and shuts down on EOF',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-mcp-fixture-'));const script=path.join(dir,'server.cjs'),log=path.join(dir,'calls');
 fs.writeFileSync(script,`const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(process.argv[2],m.method+'\\n');if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{capabilities:{tools:{}}}}));else if(m.method==='tools/call'&&m.params.name!=='wait')console.log(JSON.stringify({id:m.id,result:{content:[{type:'text',text:'{}'}],structuredContent:{ok:true}}}));});`);
 const driver=new StdioDriver(process.execPath,[script,log],1000);t.after(async()=>{await driver.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.equal((await driver.call('status')).structuredContent.ok,true);
 const signal=new AbortController();const waiting=driver.call('wait',{},signal.signal);const rejection=assert.rejects(waiting,/cancelled/);
 await tick();signal.abort();await rejection;await driver.close();assert.match(fs.readFileSync(log,'utf8'),/notifications\/cancelled/);
});
test('missing driver executable fails promptly and remains closeable',async()=>{
 const driver=new StdioDriver('/nonexistent/ashub-desktop-component',[],200);
 await assert.rejects(driver.call('status'),/Could not start|closed|exited/);await driver.close();
});
test('dead driver is discarded so the next request can start a fresh one',async t=>{
 let count=0;const {service}=fixture(t,{factory:()=>({call:async()=>{if(++count===1)throw Error('driver died');return reply({apps:[]});},close:async()=>{}})});
 await assert.rejects(service.apps(),/driver died/);assert.deepEqual(await service.apps(),{apps:[]});
});
test('shutdown cancels queued and active tasks without starting another app',async t=>{
 const {service,calls}=fixture(t);const a=Symbol(),b=Symbol();await service.acquire(a,'com.test.App',100);
 const waiting=service.acquire(b,'com.test.Other',100);const rejected=assert.rejects(waiting,/cancelled/);
 await service.close();await rejected;assert.equal(calls.filter(c=>c.name==='observe').length,1);assert.equal(calls.at(-1).name,'close');
});

test('closing during component installation terminates the installer and removes staging files',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-desktop-install-'));
 const fake=path.join(dir,'python'),marker=path.join(dir,'started');
 fs.writeFileSync(fake,`#!${process.execPath}
const fs=require('node:fs');if(process.argv.includes('venv')){fs.mkdirSync(process.argv.at(-1));fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);}
`,{mode:0o700});
 const previous=process.env.ASHUB_RUNTIME_PYTHON;process.env.ASHUB_RUNTIME_PYTHON=fake;
 const runtime=new DesktopRuntime(path.join(dir,'settings.json'),'darwin');
 t.after(async()=>{await runtime.close();if(previous===undefined)delete process.env.ASHUB_RUNTIME_PYTHON;else process.env.ASHUB_RUNTIME_PYTHON=previous;fs.rmSync(dir,{recursive:true,force:true});});
 runtime.install();
 for(let i=0;i<500&&!fs.existsSync(marker);i++)await new Promise(r=>setTimeout(r,10));
 assert(fs.existsSync(marker),'installation should have started');const pid=Number(fs.readFileSync(marker));
 await runtime.close();assert.equal(runtime.state.installing,false);assert.equal(runtime.state.installed,false);assert.equal(runtime.state.installError,'');
 assert.throws(()=>process.kill(pid,0));assert.deepEqual(fs.readdirSync(path.join(dir,'desktop-control','runtimes')),[]);
 assert.throws(()=>runtime.install(),/closed/);
});

test('unsupported platforms never start or install a desktop driver',async t=>{
 const {service,calls}=fixture(t,{platform:'win32'});
 assert.equal((await service.status(true)).supported,false);
 assert.throws(()=>service.runtime.install(),/macOS only/);
 await assert.rejects(service.apps(),/macOS only/);
 assert.equal(calls.length,0);
});

for(const outcome of ['success','prepare-failure','commit-failure']) test(`incomplete runtime recovery: ${outcome}`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-runtime-repair-')),fake=path.join(dir,'python');
 fs.writeFileSync(fake,`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('pip')&&${JSON.stringify(outcome)}==='prepare-failure')process.exit(1);
if(process.argv.includes('venv')){const bin=path.join(process.argv.at(-1),'bin');fs.mkdirSync(bin,{recursive:true});const exe=path.join(bin,'python3');fs.copyFileSync(__filename,exe);fs.chmodSync(exe,0o700);}
`,{mode:0o700});
 const previous=process.env.ASHUB_RUNTIME_PYTHON;process.env.ASHUB_RUNTIME_PYTHON=fake;
 const runtime=new DesktopRuntime(path.join(dir,'settings.json'),'darwin');
 t.after(async()=>{await runtime.close();if(previous===undefined)delete process.env.ASHUB_RUNTIME_PYTHON;else process.env.ASHUB_RUNTIME_PYTHON=previous;fs.rmSync(dir,{recursive:true,force:true});});
 const target=path.dirname(path.dirname(runtime.python));fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'incomplete'),'leftover');
 if(outcome==='commit-failure'){
  const rename=fs.renameSync;
  t.mock.method(fs,'renameSync',(source,destination)=>{if(destination===target&&String(source).includes('.install-'))throw Error('Simulated final rename failure');return rename(source,destination);});
 }
 assert.equal(runtime.installed,false);runtime.install();await runtime.waitForInstall();
 if(outcome==='success'){
  assert.equal(runtime.error,'');assert.equal(runtime.installed,true);assert(!fs.existsSync(path.join(target,'incomplete')));
  const installed=fs.readFileSync(runtime.python);runtime.install();await runtime.waitForInstall();assert.deepEqual(fs.readFileSync(runtime.python),installed);
 }else{
  assert.match(runtime.error,/installation failed|Simulated final rename failure/);assert.equal(runtime.installed,false);
  assert.equal(fs.readFileSync(path.join(target,'incomplete'),'utf8'),'leftover');
 }
 assert.deepEqual(fs.readdirSync(path.dirname(target)),[path.basename(target)]);
});

test('stop invalidates a permission request before its late approval can acquire control',async t=>{
 const {service,calls}=fixture(t);let approve,permissionSignal;const p=pluginContext(service,payload=>{permissionSignal=payload.signal;return new Promise(r=>approve=r);});
 const start=p.tools.get('desktop_start').execute({bundleId:'com.test.App',windowId:100,goal:'Test'});
 while(!approve)await tick();
 await service.stop();assert.equal(permissionSignal.aborted,true);approve({decision:{outcome:'approved'}});
 assert.equal((await start).isError,true);
 assert.equal(calls.filter(c=>c.name==='observe').length,0);
 const next=pluginContext(service);assert.equal((await next.tools.get('desktop_start').execute({bundleId:'com.test.App',windowId:100,goal:'New explicit task'})).isError,false);
});
test('cancelling desktop_start settles without waiting for the permission dialog',async t=>{
 const {service,calls}=fixture(t);let approve;const p=pluginContext(service,()=>new Promise(r=>approve=r));
 const start=p.tools.get('desktop_start').execute({bundleId:'com.test.App',windowId:100,goal:'Test cancellation'});
 while(!approve)await tick();
 await service.stop();
 let timer;const timeout=new Promise(resolve=>timer=setTimeout(()=>resolve('still waiting'),200));
 try{const result=await Promise.race([start,timeout]);assert.notEqual(result,'still waiting');assert.equal(result.isError,true);}
 finally{clearTimeout(timer);approve({decision:{outcome:'approved'}});await start;}
 assert.equal(calls.filter(c=>c.name==='observe').length,0);
});
test('cancelling during MCP initialization does not wait for the initialization deadline',async t=>{
 const driver=new StdioDriver(process.execPath,['-e',"process.stdin.resume();process.stdin.on('end',()=>process.exit());"],1000);
 t.after(()=>driver.close());const controller=new AbortController();
 const result=driver.call('status',{},controller.signal).then(()=> 'resolved',e=>e.name);
 controller.abort();let timer;
 const state=await Promise.race([result,new Promise(r=>timer=setTimeout(()=>r('still waiting'),100))]);clearTimeout(timer);
 assert.equal(state,'AbortError');
});
test('a closing action never exposes a different window returned by driver settle',async t=>{
 const {service,calls}=fixture(t,{call:name=>name==='act'?reply({status:'done',fresh:{snapshot:'other-window',window_id:200,elements:[{name:'PRIVATE WINDOW CONTENT'}]}}):undefined});
 const p=pluginContext(service);const start=await p.tools.get('desktop_start').execute({bundleId:'com.test.App',windowId:100,goal:'Close this window'});
 const result=await p.tools.get('desktop_act').execute({snapshot:JSON.parse(start.content).snapshot,action:'CLICK',element:'button1'});
 assert.equal(result.isError,true);assert.doesNotMatch(result.content,/PRIVATE WINDOW CONTENT/);
 assert.match(result.content,/window.*changed|window.*closed/i);assert(calls.some(c=>c.name==='release'));
});

test('stop interrupts a pending inspection so it cannot block release',async t=>{
 let statusCalls=0,entered;const started=new Promise(r=>entered=r);
 const {service,calls}=fixture(t,{call:(name,_args,signal)=>name==='status'&&++statusCalls===2?new Promise((_r,reject)=>{entered();signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});}):undefined});
 await service.acquire(Symbol(),'com.test.App',100);
 const inspection=service.status(true);await started;await service.stop();
 const state=await inspection;assert.equal((await service.status()).busy,false);assert.equal(state.driverError,undefined);
 assert(calls.some(c=>c.name==='release'));
});

test('a driver failure during inspection invalidates the active task and its cached screenshot',async t=>{
 let generation=0;const inputs=[];
 const {service}=fixture(t,{factory:()=>{
  const current=++generation;let checks=0;
  return {async call(name,args){
   if(name==='status'){if(current===1&&++checks>1)throw Error('driver crashed during inspection');return reply({permissions:{accessibility:true},background_input:true});}
   if(name==='apps')return reply({apps:[{pid:10,bundle_id:'com.test.App'}]});
   if(name==='windows')return reply({windows:[{window_id:100}]});
   if(name==='observe')return reply({snapshot:'s1',window_id:100,elements:[]});
   if(name==='screenshot')return {...reply({screenshot:{width:1000,height:600,scale:2,window_id:100}}),content:[{type:'image',data:'image',mimeType:'image/png'}]};
   if(name==='click_at'){inputs.push(args);return reply({status:'done'});}
   if(name==='release')return reply({});
   throw Error(name);
  },async close(){}};
 }});
 const owner=Symbol();await service.acquire(owner,'com.test.App',100);await service.call(owner,'screenshot',{snapshot:'s1'});
 const next=service.acquire(Symbol(),'com.test.App',100);
 assert.match((await service.status(true)).driverError,/driver crashed/);
 // A replacement driver starts snapshot numbering at s1 again. An old screenshot
 // must not become a valid basis for input simply because that ID is reused.
 await assert.rejects(service.call(owner,'observe',{}),/No active/);
 await assert.rejects(service.call(owner,'click_at',{snapshot:'s1',x:20,y:20}),/No active/);
 assert.equal(inputs.length,0);
 await next;assert.equal(generation,2);
});
test('non-object MCP output rejects the request instead of crashing the host',async t=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const moduleURL=new URL('../dist/mcp.js',import.meta.url).href;
 const driverSource="process.stdin.once('data',()=>console.log('null'));process.stdin.on('end',()=>process.exit());";
 const caller=`import assert from 'node:assert/strict';import {StdioDriver} from ${JSON.stringify(moduleURL)};const d=new StdioDriver(process.execPath,['-e',${JSON.stringify(driverSource)}],1000);try{await assert.rejects(d.call('status'),/Invalid desktop driver response/);}finally{await d.close();}`;
 await promisify(execFile)(process.execPath,['--input-type=module','-e',caller],{timeout:4000});
});

for (const mode of ['api', 'deferred']) test(`kernel ${mode} executes a desktop batch in order without caching observations`, async t => {
 const { ashEngine, createAgentHost } = await import('agent-sh/runtime');
 const {service,calls,file}=fixture(t);const {tools}=pluginContext(service);
 const batch=[['desktop_start',{bundleId:'com.test.App',windowId:100,goal:'Inspect window'}],['desktop_observe',{}],['desktop_observe',{}],['desktop_finish',{}]];
 const modelCalls=batch.map(([name,args],index)=>({
  index,id:`call_${index}`,type:'function',
  function:{name:mode==='deferred'?'use_extension':name,arguments:JSON.stringify(mode==='deferred'?{name,args}:args)},
 }));
 let rounds=0;
 // Use the public turn path and real tool protocol with an in-memory model
 // stream and the desktop fixtures above. Leave scheduling at its default.
 const host=await createAgentHost({cwd:path.dirname(file),settings:{toolMode:mode},extensions:[ashEngine({
  tools:[...tools.values()],
  client:{model:'desktop-fixture',async *stream({tools:offered}){
   if(++rounds===1){
    const names=offered.map(t=>t.function.name);
    assert.deepEqual(names,mode==='deferred'?['use_extension']:[...tools.keys()]);
    yield {choices:[{delta:{tool_calls:modelCalls},finish_reason:'tool_calls'}]};
   }else{
    yield {choices:[{delta:{content:'Done.'},finish_reason:'stop'}]};
   }
  }},
 })]});
 t.after(()=>host.dispose());
 const results=[];
 const turn=await host.run('Inspect and release the fixture window.',{maxIterations:2,rawErrors:true,onMessage(message){
  if(message.role==='tool')results.push(message);
 }});
 assert.equal(turn.status,'completed',turn.error);
 assert.equal(turn.text,'Done.');
 assert.equal(rounds,2);
 assert.deepEqual(results.map(r=>r.toolName),batch.map(([name])=>name));
 assert(results.every(r=>!r.isError),JSON.stringify(results));
 assert.deepEqual(results.slice(0,3).map(r=>JSON.parse(r.content).snapshot),['s1','s2','s3']);
 assert.deepEqual(calls.filter(c=>['observe','release'].includes(c.name)).map(c=>c.name),['observe','observe','observe','release']);
 assert.equal((await service.status()).busy,false);
});

for (const [action,fields] of [['WAIT',{}],['PRESS_KEY',{key:'ESCAPE'}],['HOTKEY',{hotkey:'MOD+S'}],['SCROLL',{direction:'DOWN'}]]) {
 test(`window-level ${action} works with an empty accessibility snapshot`,async t=>{
  const {service,calls}=fixture(t,{call:name=>name==='observe'?reply({snapshot:'empty-window',window_id:100,elements:[]}):undefined});
  const {tools}=pluginContext(service);
  const start=await tools.get('desktop_start').execute({bundleId:'com.test.App',windowId:100,goal:'Operate selected window'});
  assert.equal(start.isError,false);
  const act=tools.get('desktop_act');
  const result=await act.execute({snapshot:JSON.parse(start.content).snapshot,action,...fields});
  assert.equal(result.isError,false,result.content);
  assert(!act.input_schema.required.includes('element'),'schema must allow window-level actions');
  const sent=calls.find(c=>c.name==='act');assert(sent);
  assert.equal(sent.args.element,undefined);assert.equal(sent.args.action,action);
  for(const [key,value] of Object.entries(fields))assert.equal(sent.args[key],value);
  assert.equal((await service.status()).busy,true);
 });
}
for (const action of ['CLICK','DOUBLE_CLICK','RIGHT_CLICK','SET_VALUE','TYPE_TEXT']) {
 test(`targeted ${action} still rejects a missing element before contacting driver`,async t=>{
  const {service,calls}=fixture(t);const {tools}=pluginContext(service);
  const start=await tools.get('desktop_start').execute({bundleId:'com.test.App',windowId:100,goal:'Operate a control'});
  const result=await tools.get('desktop_act').execute({snapshot:JSON.parse(start.content).snapshot,action,value:'Test'});
  assert.equal(result.isError,true);assert.equal(calls.filter(c=>c.name==='act').length,0);
 });
}

test('modern capture stays task-scoped and its scale is used for coordinate input',async t=>{
 const captures=[];const {service,calls}=fixture(t,{capture:async(pid,id,signal)=>{
  assert(!signal.aborted);captures.push([pid,id]);return {...reply({screenshot:{pid,window_id:id,width:800,height:600,scale:2,backend:'ScreenCaptureKit'}}),content:[{type:'image',mimeType:'image/png',data:'iVBORw0KGgo='}]};
 }});
 const owner=Symbol(),state=await service.acquire(owner,'com.test.App',100);
 await assert.rejects(service.call(owner,'screenshot',{snapshot:'foreign'}),/snapshot/);assert.equal(captures.length,0);
 const shot=await service.call(owner,'screenshot',{snapshot:state.snapshot});assert.equal(shot.structuredContent.screenshot.backend,'ScreenCaptureKit');assert.deepEqual(captures,[[10,100]]);assert(!calls.some(c=>c.name==='screenshot'));
 await service.call(owner,'click_at',{snapshot:state.snapshot,x:200,y:100});const action=calls.find(c=>c.name==='click_at');assert.equal(action.args.x,100);assert.equal(action.args.y,50);
});
test('a failed modern capture invalidates the previous coordinate frame and does not fall back',async t=>{
 let count=0;const {service,calls}=fixture(t,{capture:async(pid,id)=>{
  if(count++)throw Error('Window capture [empty_capture]: black image');
  return reply({screenshot:{pid,window_id:id,width:800,height:600,scale:1}});
 }});const owner=Symbol(),state=await service.acquire(owner,'com.test.App',100);
 await service.call(owner,'screenshot',{snapshot:state.snapshot});await assert.rejects(service.call(owner,'screenshot',{snapshot:state.snapshot}),/empty_capture/);
 await assert.rejects(service.call(owner,'click_at',{snapshot:state.snapshot,x:20,y:20}),/screenshot/);assert(!calls.some(c=>c.name==='screenshot'||c.name==='click_at'));
});
test('cancelling a modern capture discards its late result and releases the task',async t=>{
 let ready,done,captureSignal;const entered=new Promise(r=>ready=r);const {service,calls}=fixture(t,{capture:async(_p,_w,signal)=>{captureSignal=signal;ready();return new Promise(r=>done=r);}});
 const owner=Symbol(),state=await service.acquire(owner,'com.test.App',100),pending=service.call(owner,'screenshot',{snapshot:state.snapshot});const rejected=assert.rejects(pending);
 await entered;const stopping=service.stop();assert(captureSignal.aborted);done(reply({screenshot:{window_id:100,width:1,height:1,scale:1}}));await rejected;await stopping;
 assert.equal((await service.status()).busy,false);assert(!calls.some(c=>c.name==='click_at'));
});

test('modern screenshot backend is opt-in and invalid configuration is rejected',t=>{
 const {file}=fixture(t);assert.equal(readDesktopSettings(file).captureBackend,undefined);
 const old=readDesktopSettings(file);writeDesktopSettings(file,{...old,captureBackend:'screencapturekit'},settingsRevision(old));assert.equal(readDesktopSettings(file).captureBackend,'screencapturekit');
 assert.throws(()=>writeDesktopSettings(file,{...old,captureBackend:'screen'},settingsRevision(readDesktopSettings(file))),/Invalid/);
});
