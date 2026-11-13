const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../web'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'device-interconnect-ui-'));
app.setPath('userData',profile);app.on('window-all-closed',()=>{});const timer=setTimeout(()=>app.exit(1),60000);
app.whenReady().then(async()=>{
 let win,server;
 try{
  const {connectionResource}=await import('../examples/extensions/multi-machine/app.mjs');
  const account={cookie:'',user:'',error:'',records:new Map()},sharing={status:()=>({enabled:true,status:'online',deviceName:'我的 Mac',username:'fixture',roots:['/Users/fixture/Shared'],gateway:'https://ashub.aihao.world/mobile/'}),disable(){}};
  const resource=connectionResource(account,sharing);
  server=http.createServer(async(req,res)=>{
   if(req.url.startsWith('/api/plugin-resources/')){let raw='';for await(const c of req)raw+=c;let value=resource.view();if(raw){const b=JSON.parse(raw),p=await resource.prepare(b.action,b.values);value=await p.execute();}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({view:value}));return;}
   if(req.url.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end('{}');return;}
   const file=path.join(root,req.url==='/'?'index.html':new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}
   let bytes=fs.readFileSync(file);if(file.endsWith('.html'))bytes=bytes.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(bytes);
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadURL('http://127.0.0.1:'+server.address().port);const run=code=>win.webContents.executeJavaScript('(async()=>{'+code+'})()');const wait=async code=>{for(let n=0;n<150;n++){if(await run('return '+code))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out '+code);};
  await run(`document.querySelector('.page-loader')?.remove();await import('/js/prefs.js');const {mountDeclarativeUI}=await import('/js/extensions/declarative-ui.js');window.dispose=mountDeclarativeUI({id:'device-fixture',pluginId:'fixture',name:'设备互联',capabilities:['shared-conversations'],ui:{version:1,panels:[{id:'connections',title:'设备互联',icon:'devices',components:[{type:'resource',id:'connections'}]}]}},{menuHost:document.querySelector('.toolbar'),panelHost:document.body});document.querySelector('.extension-menu').click();`);
  await wait(`document.querySelector('.extension-panel').textContent.includes('允许访问 · 在线')`);
  for(const width of [1180,390,320])for(const theme of ['light','dark']){
   win.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width,height:850},viewPosition:{x:0,y:0},viewSize:{width,height:850},deviceScaleFactor:1,scale:1});
   await wait(`innerWidth===${width}`);await run(`document.documentElement.dataset.theme='${theme}';const trigger=document.querySelector('.extension-menu');if(trigger.classList.contains('active'))trigger.click();trigger.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));`);
   await new Promise(r=>setTimeout(r,250));
   const check=await run(`const p=document.querySelector('.extension-panel'),r=p.getBoundingClientRect();return {width:innerWidth,left:r.left,right:r.right,scroll:p.scrollWidth,client:p.clientWidth};`);
   assert(check.left>=-1&&check.right<=width+1,JSON.stringify(check));assert(check.scroll<=check.client+1,JSON.stringify(check));
   if(width===390){fs.writeFileSync(path.join(os.tmpdir(),'ashub-device-interconnect-'+theme+'.png'),(await win.webContents.capturePage({x:0,y:0,width,height:800})).toPNG());}
  }
  assert(await run(`const b=Array.from(document.querySelectorAll('.extension-panel button')).find(b=>b.textContent==='设置共享目录');b.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(r));const r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));`),'sharing control is clickable at narrow width');
  await run(`Array.from(document.querySelectorAll('.extension-panel button')).find(b=>b.textContent==='设置共享目录').click();`);await wait(`!!document.querySelector('.extension-panel textarea')`);
  assert(await run(`const p=document.querySelector('.extension-panel');return p.scrollWidth<=p.clientWidth+1 && p.querySelectorAll('form').length===1 && p.textContent.includes('确认共享范围');`));
  await run(`Array.from(document.querySelectorAll('.extension-panel button')).find(b=>b.textContent==='取消设置').click();`);await wait(`!document.querySelector('.extension-panel textarea')`);
  assert(await run(`return document.querySelectorAll('.extension-menu').length===1 && !document.getElementById('mobile-access-toggle')`));
  console.log('PASS device interconnect single panel, distinct icon, account/local sharing controls, inline setup/cancel, light/dark and 1180/390/320px layouts');
 }finally{win?.destroy();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());fs.rmSync(profile,{recursive:true,force:true});clearTimeout(timer);}
}).then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
