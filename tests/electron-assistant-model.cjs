const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-model-ui-'));
app.setPath('userData',path.join(dir,'profile'));app.on('window-all-closed',()=>{});
const timer=setTimeout(()=>app.exit(1),45000);
app.whenReady().then(async()=>{
 let server,win;
 try {
  const {AssistantPanel}=await import(pathToFileURL(path.join(root,'examples/extensions/personal-assistant/app.mjs')).href);
  let revision=0,model=null,follow=false,changes=0,pending,supported=false;
  const api={supportsModelSelection:()=>supported,status:()=>({modelRevision:revision,backgroundModel:model,followModel:follow}),models:()=>[{provider:'one',model:'shared'},{provider:'two',model:'shared'},{provider:'p'.repeat(200),model:'m'.repeat(200)},{provider:'p'.repeat(199)+'q',model:'m'.repeat(200)}]};
  const store={profile:()=>({enabled:true,revision:1})};
  const learning={config:()=>({enabled:true,grantId:'fixture-grant'}),access:()=>true,health:()=>({}),modelPolicyChanged:()=>changes++};
  const assistant={dedicated:true,store,learning,services:{background:api},conversationId:()=>'session-a'};
  const panel=new AssistantPanel(assistant);
  server=http.createServer(async(req,res)=>{
   try {
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/fixture-enable'){supported=true;return res.end('ok');}
    if(url.pathname==='/fixture-disable'){supported=false;return res.end('ok');}
    if(url.pathname==='/resource') {
     res.setHeader('Content-Type','application/json');
     if(req.method==='GET')return res.end(JSON.stringify({view:panel.overview()}));
     let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
     if(input.confirm){pending.validate();model=pending.backgroundModelChange.model;follow=model===null;revision++;const view=pending.execute('fixture-grant');return res.end(JSON.stringify({view}));}
     const plan=await panel.prepare(input.action,input.values);
     if(plan.backgroundModelChange){pending=plan;return res.end(JSON.stringify({confirmation:{id:'confirm',preview:plan.preview}}));}
     return res.end(JSON.stringify({view:await plan.execute()}));
    }
    if(url.pathname==='/') {res.setHeader('Content-Type','text/html');return res.end('<!doctype html><html lang="zh"><body><div id="root"></div></body></html>');}
    const file=path.join(root,'web',url.pathname);if(!file.startsWith(path.join(root,'web')+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(file));
   }catch(e){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const js=code=>win.webContents.executeJavaScript(code),wait=async expression=>{for(let i=0;i<180;i++){if(await js(expression))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out: '+expression+'; '+await js('document.body.innerText'))};
  await js(`(async()=>{const {mountResource}=await import('/js/extensions/resource-view.js');window.disposeFixture=mountResource(document.querySelector('#root'),{pluginId:'fixture'},'assistant',{request:async(body)=>{const r=await fetch('/resource',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const v=await r.json();if(!r.ok)throw Error(v.error);return v}})})()`);
  const click=async text=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent===${JSON.stringify(text)});if(!b)throw Error('missing button');b.click()})()`);
  await wait("document.body.textContent.includes('等待首次整理')");assert(!await js("document.body.textContent.includes('整理模型')"));
  await js("fetch('/fixture-enable')");await js("disposeFixture();document.querySelector('#root').replaceChildren()");
  await js(`(async()=>{const {mountResource}=await import('/js/extensions/resource-view.js');window.disposeFixture=mountResource(document.querySelector('#root'),{pluginId:'fixture'},'assistant',{request:async(body)=>{const r=await fetch('/resource',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const v=await r.json();if(!r.ok)throw Error(v.error);return v}})})()`);
  await wait("document.body.textContent.includes('整理模型')");
  await click('整理模型');await wait("!!document.querySelector('select')");
  assert.equal(await js("document.querySelector('select').selectedOptions[0].textContent"),'原授权固定模型（保留）');
  assert.equal(await js("document.querySelector('.extension-resource-guidance').open"),false);
  const options=await js("[...document.querySelector('select').options].map(o=>o.textContent)");assert(options.includes('shared · one'));assert(options.includes('shared · two'));assert(options.includes('跟随对话模型'));assert.equal(new Set(options).size,options.length);assert(options.every(s=>s.length<=200));assert(await js("[...document.querySelector('select').options].every(o=>o.value.length<=200)"));
  await js("(()=>{const e=document.querySelector('select');e.value=[...e.options].find(o=>o.textContent==='shared · two').value})()");await click('继续');
  await wait("!!document.querySelector('.extension-resource-confirm')");assert.match(await js('document.body.textContent'),/授权.*原文/);assert.equal(changes,0);
  await js("document.querySelector('.extension-resource-confirm button').click()");assert.equal(changes,0);assert.equal(revision,0);
  await click('继续');await wait("!!document.querySelector('.extension-resource-confirm')");
  await js("document.querySelector('.extension-resource-confirm button:last-child').click()");
  await wait("document.body.textContent.includes('整理模型') && !document.querySelector('.extension-resource-confirm')");
  assert.deepEqual(model,{provider:'two',model:'shared'});assert.equal(changes,1);
  await click('整理模型');await wait("!!document.querySelector('select')");
  assert.equal(await js("document.querySelector('select').selectedOptions[0].textContent"),'shared · two');
  await click('返回');await wait("!document.querySelector('select')");
  await js("fetch('/fixture-disable')");await click('整理模型');await wait("!!document.querySelector('select')");
  assert.match(await js('document.body.textContent'),/当前不支持指定模型/);
  await js("(()=>{const e=document.querySelector('select');e.value='follow'})()");await click('继续');await wait("!!document.querySelector('.extension-resource-confirm')");
  await js("document.querySelector('.extension-resource-confirm button:last-child').click()");
  await wait("document.body.textContent.includes('等待首次整理') && !document.querySelector('.extension-resource-confirm')");
  assert.equal(model,null);assert.equal(changes,2);console.log('PASS Electron: unsupported entry hidden, existing policy recovery, exact model choice, disclosure, cancel and confirmation');
 }catch(error){console.error(error);process.exitCode=1;}
 finally{clearTimeout(timer);if(win&&!win.isDestroyed())win.destroy();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}fs.rmSync(dir,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
