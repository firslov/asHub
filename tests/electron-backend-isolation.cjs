// Three real renderer windows share one origin and the same conversation ID.
// All Hub data, backend registrations and browser storage are isolated fixtures.
const {app,BrowserWindow}=require('electron');
const {env,Bridge,root,path,fs}=require('./harness.cjs');
const {once}=require('node:events');
const assert=require('node:assert/strict');
const fixture=env({globals:{setTimeout,clearTimeout,setInterval,clearInterval}});
fixture.clock(Date.now());app.setPath('userData',path.join(fixture.dir,'profile'));
const guard=setTimeout(()=>{console.error('Multi-window isolation timed out');app.exit(1);},60000);
app.whenReady().then(async()=>{
 let hub;const windows=[],owner=new AbortController(),streams=new Map();let localCalls=0,releaseList,holdList=false;
 const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
 const wait=async(fn,label)=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timeout: '+label);};
 const frame=(name,payload={})=>({meta:{name},payload});
 try{
  class LocalBridge extends Bridge{async submit(query){localCalls++;this.emit('event',{name:'agent:response-chunk',payload:{blocks:[{type:'text',text:'Local response'}]}});return super.submit(query);}}
  hub=fixture.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:opts=>new LocalBridge(opts)});
  await once(hub.server,'listening');const base='http://127.0.0.1:'+hub.server.address().port;
  const api=async(route,body)=>{const r=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Ashub-Local':'1'},body:body?JSON.stringify(body):undefined});const v=await r.json();assert(r.ok,JSON.stringify(v));return v;};
  const local=await api('/sessions',{cwd:fixture.dir});await api('/'+local.instanceId+'/title',{title:'Local conversation'});
  const {BackendConnections}=await import('../dist/extensions/backends.js');
  const registry=new BackendConnections({signal:owner.signal});
  const bind=key=>registry.bind('fixture',owner.signal).register(key,{
   label:key,online:()=>true,
   request:async(op)=>{
    if(op==='sessions'){if(key==='A'&&holdList){holdList=false;const pending=deferred();releaseList=pending.resolve;return pending.promise;}return [{instanceId:local.instanceId,title:'Remote '+key}];}
    if(op==='capabilities')return {};
    throw Error('Unexpected operation '+op);
   },
   subscribe:async(_sid,emit,signal)=>{
    let stop;const done=new Promise(r=>stop=r);const item={emit,stop};streams.set(key,item);
    emit(frame('agent:query',{query:'Question '+key}));emit(frame('agent:response-segment',{text:'Reply '+key}));emit(frame('hub:replay-done'));
    signal.addEventListener('abort',stop,{once:true});await done;signal.removeEventListener('abort',stop);if(streams.get(key)===item)streams.delete(key);
   },
  });
  const a=bind('A'),b=bind('B');
  // Keep the real local Hub and UI; intercept only this fixture's backend routes.
  const handler=hub.server.listeners('request')[0];hub.server.removeAllListeners('request');
  hub.server.on('request',async(req,res)=>{if(await registry.handle(req,res,async r=>{let body='';for await(const c of r)body+=c;return body;}))return;handler(req,res);});
  const make=async route=>{const w=new BrowserWindow({show:true,width:1180,height:820,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});windows.push(w);await w.loadURL(base+route);return code=>w.webContents.executeJavaScript(code);};
  const jl=await make('/'+local.instanceId+'/');await wait(()=>jl("!!document.querySelector('session-view .session-stream')"),'local view');
  await api('/'+local.instanceId+'/submit',{query:'Local request'});await wait(()=>jl("document.querySelector('session-view').textContent.includes('Local response')"),'local response');
  await jl("document.querySelector('#query').value='Local unsent draft';document.querySelector('#query').dispatchEvent(new Event('input'))");
  let ja=await make('/backend.html?connection='+a.id);const jb=await make('/backend.html?connection='+b.id);
  for(const [js,label]of [[ja,'A'],[jb,'B']]){
   await wait(()=>js("!!document.querySelector('#sessions button')"),'device '+label);
   await js("document.querySelector('#sessions button').click()");await wait(()=>js("!document.querySelector('#send').disabled"),'ready '+label);
   await js(`document.querySelector('#query').value='Draft ${label}';document.querySelector('#query').dispatchEvent(new Event('input'))`);
  }
  // A real native window is destroyed and recreated, retaining only scoped
  // browser storage. Reopening restores its conversation/draft, not another tab.
  windows[1].destroy();ja=await make('/backend.html?connection='+a.id);
  await wait(()=>ja("!document.querySelector('#send').disabled"),'reopened A restores connection');
  assert.equal(await ja("document.querySelector('#query').value"),'Draft A');
  assert((await ja("document.querySelector('#messages').textContent")).includes('Reply A'));
  const snapshot=js=>js("JSON.stringify({list:document.querySelector('#sessions').textContent,messages:document.querySelector('#messages').textContent,draft:document.querySelector('#query').value,status:document.querySelector('#connection').textContent,disabled:document.querySelector('#send').disabled})");
  const localSnapshot=()=>jl("JSON.stringify({list:document.querySelector('#sessions').textContent,messages:document.querySelector('session-view .session-stream').textContent,draft:document.querySelector('#query').value})");
  const beforeLocal=await localSnapshot(),beforeB=await snapshot(jb);
  const old=streams.get('A');old.stop();await wait(()=>ja("document.querySelector('#connection').textContent.includes('正在恢复')"),'disconnect A');
  old.emit(frame('agent:response-segment',{text:'Late stream must not appear'}));
  await wait(()=>ja("!document.querySelector('#send').disabled"),'automatic recovery A');
  assert.equal(await ja("document.querySelector('#query').value"),'Draft A');
  assert(!(await snapshot(ja)).includes('Late stream'));assert.equal(await snapshot(jb),beforeB);assert.equal(await localSnapshot(),beforeLocal);
  holdList=true;await ja("document.querySelector('#refresh').click()");await wait(()=>!!releaseList,'held A list');
  const revoked=streams.get('A');a.dispose();const replacement=bind('C');
  releaseList([{instanceId:local.instanceId,title:'Late old account'}]);revoked.emit(frame('agent:response-segment',{text:'Late revoked message'}));
  await ja("document.querySelector('#refresh').click()");await wait(()=>ja("document.querySelector('#sessions').children.length===0"),'revoked A view');
  assert(!(await snapshot(ja)).includes('Late old account'));assert(!(await snapshot(ja)).includes('Late revoked message'));
  assert.equal(await snapshot(jb),beforeB);assert.equal(await localSnapshot(),beforeLocal);assert.equal(localCalls,1,'remote activity must not invoke local execution');
  const jc=await make('/backend.html?connection='+replacement.id);await wait(()=>jc("!!document.querySelector('#sessions button')"),'new account device');await jc("document.querySelector('#sessions button').click()");await wait(()=>jc("!document.querySelector('#send').disabled"),'new account ready');
  assert.equal(await jc("document.querySelector('#query').value"),'');assert.equal(await snapshot(jb),beforeB);assert.equal(await localSnapshot(),beforeLocal);
  console.log('PASS same-origin local + two devices with identical session IDs: drafts/messages/lists isolated, native close/reopen restores draft and history, automatic reconnect, revoked stream and late list ignored, replacement device cannot inherit old draft or execute locally');
 }finally{owner.abort();for(const w of windows)if(!w.isDestroyed())w.destroy();await hub?.shutdown();clearTimeout(guard);}
}).then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
