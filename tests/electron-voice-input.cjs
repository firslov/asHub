const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),{once}=require('node:events'),{pathToFileURL}=require('node:url');
const {zip}=require('./plugin-zip-fixture.cjs');
const {env,Bridge,fs,path,root}=require('./harness.cjs');
const modules={},e=env({modules,globals:{setTimeout,clearTimeout,setInterval,clearInterval,Date}});
process.env.AGENT_SH_HOME=e.dir;app.setPath('userData',path.join(e.dir,'browser'));app.on('window-all-closed',()=>{});
const deadline=setTimeout(()=>{console.error('Voice UI timeout');app.exit(1);},90000);
let hub,win;
app.whenReady().then(async()=>{
 const originalFetch=globalThis.fetch,vault=new Map();let conversions=0,submits=0;
 try{
  globalThis.fetch=async(url,opts)=>{if(String(url)==='https://fixture.test/audio/transcriptions'){conversions++;assert.equal(opts.headers.Authorization,'Bearer fixture-key');assert.equal(opts.body.get('file').type,'audio/mp4');return new Response(JSON.stringify({text:'这是测试转写'}));}return originalFetch(url,opts);};
  modules['./extensions/installed.js']=await import(pathToFileURL(path.join(root,'dist/extensions/installed.js')).href);
  hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),pluginSecretStore:{read:k=>vault.get(k)||null,write:(k,v)=>v===null?vault.delete(k):vault.set(k,v)},makeBridge:opts=>{const bridge=new Bridge(opts);bridge.submit=async()=>{submits++;return{stopReason:'done'};};setTimeout(()=>bridge.emit('event',{name:'agent:info',payload:{model:'tiny',provider:'mock',modalities:['image']}}),0);return bridge;}});
  await once(hub.server,'listening');const base='http://127.0.0.1:'+hub.server.address().port;
  const call=async(route,body,headers)=>{const r=await originalFetch(base+route,{method:body?'POST':'GET',headers:headers||{'Content-Type':'application/json'},body:body?headers?body:JSON.stringify(body):undefined});const raw=await r.text();assert.equal(r.status,200,raw);return JSON.parse(raw);};
  const pkgRoot=path.join(root,'examples/extensions/voice-input'),pkg=JSON.parse(fs.readFileSync(path.join(pkgRoot,'package.json'))),files=Object.fromEntries(['package.json',...pkg.files].map(n=>[n,fs.readFileSync(path.join(pkgRoot,n),'utf8')]));
  const preview=await call('/api/plugins/install?action=preview',zip(files),{'Content-Type':'application/zip'});assert(preview.canInstall,JSON.stringify(preview));
  const job=await call('/api/plugins/install?action=confirm',{token:preview.token});let result;
  for(let i=0;i<150;i++){result=await call('/api/plugins/install?id='+job.id);if(result.state!=='running')break;await new Promise(r=>setTimeout(r,20));}assert.equal(result.state,'succeeded',JSON.stringify(result));
  let feature;for(let i=0;i<100;i++){feature=(await call('/api/extensions')).features.find(f=>f.name==='语音输入');if(feature?.state==='active')break;await new Promise(r=>setTimeout(r,20));}assert.equal(feature?.state,'active',JSON.stringify(feature));
  const resource='/api/plugin-resources/'+feature.pluginId+'/settings';
  const prepared=await call(resource,{action:'save',values:{endpoint:'https://fixture.test/audio/transcriptions',model:'fixture',apiKey:'fixture-key'}});assert(prepared.confirmation);assert(!JSON.stringify(prepared).includes('fixture-key'));await call(resource,{confirm:prepared.confirmation.id});assert.equal(vault.size,1);
  const sid=(await call('/sessions',{cwd:e.dir,kind:'agent',title:'语音验收',model:'tiny',provider:'mock'})).instanceId;
  const denied=await originalFetch(base+resource+'?remoteSession='+sid);assert.equal(denied.status,409,'remote cannot read or edit ASR credentials');
  assert.equal((await originalFetch(base+'/'+sid+'/composer-inputs',{headers:{Origin:'https://evil.test'}})).status,403);
  win=new BrowserWindow({show:true,useContentSize:true,width:1200,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  await win.loadURL(base+'/'+sid+'/');
  const js=code=>win.webContents.executeJavaScript(code),wait=async code=>{for(let i=0;i<180;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+code);};
  await js(fs.readFileSync(path.join(root,'tests/fixtures/media-recorder.js'),'utf8'));
  await wait("!!document.querySelector('.composer-media:not([hidden])') && !document.querySelector('.composer-media-button').disabled");
  await js("query.value='已有草稿：';query.setSelectionRange(query.value.length,query.value.length);query.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.composer-media-button').click()");
  await wait("document.querySelector('.composer-media').dataset.state==='recording'");
  await js("document.querySelector('.composer-media-button').click()");await wait("query.value==='已有草稿：这是测试转写'");assert.equal(submits,0);assert.equal(conversions,1);
  assert(await js("getComputedStyle(document.querySelector('.composer-media-cancel')).display==='none'"));
  assert(await js('mediaFixture.tracks.every(t=>t.stopped)'));
  // Native/system interruption must release capture, not transcribe partial audio.
  await js("document.querySelector('.composer-media-button').click()");await wait("document.querySelector('.composer-media').dataset.state==='recording'");
  await js("mediaFixture.recorders.at(-1).stop()");await wait("document.querySelector('.composer-media').dataset.state==='idle'");
  assert.equal(conversions,1);assert.equal(submits,0);assert.equal(await js('query.value'),'已有草稿：这是测试转写');assert(await js('mediaFixture.tracks.every(t=>t.stopped)'));
  // Closing the optional plugin removes capability, never clears the existing draft.
  await call('/api/extensions/'+feature.id+'/enabled',{enabled:false});await js("(async()=>{await (await import('/js/extensions/feature-state.js')).refreshFeatures()})()");
  await wait("document.querySelector('.composer-media').hidden");assert.equal(await js('query.value'),'已有草稿：这是测试转写');
  await call('/api/extensions/'+feature.id+'/enabled',{enabled:true});await js("(async()=>{await (await import('/js/extensions/feature-state.js')).refreshFeatures()})()");await wait("!document.querySelector('.composer-media').hidden");
  // Real installed declarative panel, single page, no key echoed.
  await js("Array.from(document.querySelectorAll('.extension-menu')).find(b=>b.title.includes('语音输入')).click()");
  await wait("Array.from(document.querySelectorAll('.extension-resource-form')).some(f=>f.textContent.includes('API Key'))");
  assert(!await js("document.body.innerText.includes('fixture-key')"));
  await wait("Array.from(document.querySelectorAll('.extension-panel:not([hidden])')).some(f=>f.textContent.includes('API Key'))");
  await js("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  await new Promise(r=>setTimeout(r,250));
  const layout=await js("(()=>{const q=query.getBoundingClientRect(),b=document.querySelector('.composer-media-button').getBoundingClientRect(),p=document.querySelector('.extension-panel:not([hidden])').getBoundingClientRect();return {q:q.toJSON(),b:b.toJSON(),p:p.toJSON(),h:innerHeight,w:innerWidth}})()");
  assert(layout.b.bottom<=layout.h && layout.q.bottom<=layout.h && layout.b.width>0 && layout.p.right<=layout.w+1,JSON.stringify(layout));
  fs.writeFileSync('/tmp/ashub-voice-desktop.png',(await win.webContents.capturePage()).toPNG());
  // The native picker can return after the active conversation changes.
  // Keep the real button, file change and image decoder, delaying only the dialog result.
  const second=(await call('/sessions',{cwd:e.dir,kind:'agent',title:'另一会话',model:'tiny',provider:'mock'})).instanceId;
  await wait("!document.getElementById('vision-indicator').hidden");
  await js(`(() => {
    const click=HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click=function() {
      if (this.type==='file') window.pendingPicker=this;
      else click.call(this);
    };
    document.getElementById('vision-indicator').click();
    HTMLInputElement.prototype.click=click;
    if (!window.pendingPicker) throw Error('File picker did not open');
    window.__ash.switchTo(${JSON.stringify(second)});
  })()`);
  await wait("query.value===''");
  await js(`(async () => {
    query.value='另一会话的草稿';query.dispatchEvent(new Event('input',{bubbles:true}));
    const canvas=document.createElement('canvas');canvas.width=1;canvas.height=1;
    const png=await new Promise(resolve=>canvas.toBlob(resolve));
    const data=new DataTransfer();data.items.add(new File([png],'fixture.png',{type:'image/png'}));
    window.pendingPicker.files=data.files;
    window.pendingPicker.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await js(`window.__ash.switchTo(${JSON.stringify(sid)})`);
  await wait("!!document.querySelector('#image-previews img')");
  assert.equal(await js('query.value'),'已有草稿：这是测试转写');
  await js(`window.__ash.switchTo(${JSON.stringify(second)})`);
  assert.equal(await js('query.value'),'另一会话的草稿');
  assert.equal(await js("document.querySelector('#image-previews img')"),null,'the image belongs to the session that opened the picker');
  assert.equal(submits,0);
  assert(!errors.some(e=>/ReferenceError|TypeError/.test(e)),JSON.stringify(errors));
  console.log('PASS installed voice plugin: ZIP/capability gate, encrypted configuration, explicit confirmation, desktop draft-only conversion, image picker session ownership, enable/disable restore, forbidden remote config and cross-origin');
  win.destroy();await hub.shutdown();clearTimeout(deadline);app.exit(0);
 }catch(error){console.error(error);win?.destroy();try{await hub?.shutdown();}catch{}clearTimeout(deadline);app.exit(1);}finally{globalThis.fetch=originalFetch;}
});
