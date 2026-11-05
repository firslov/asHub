// Exercise the real updater module, translations and full stylesheet cascade.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),web=path.join(root,'web');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-updater-ui-'));
app.setPath('userData',profile);
let win,server;
const watchdog=setTimeout(()=>finish(1),60000);
function finish(code){clearTimeout(watchdog);win?.destroy();server?.close();fs.rmSync(profile,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
 const html=fs.readFileSync(path.join(web,'index.html'),'utf8');
 const styles=[...html.matchAll(/<link\b[^>]*href="(\/css\/[^\"]+\.css)"[^>]*>/g)].map(m=>m[0]).join('');
 const fixture=`<!doctype html><meta charset="utf-8">${styles}<style>*{animation:none!important;transition:none!important}</style><script>
 window.events={};window.calls=[];
 window.electronAPI={getUpdateMode:()=>new Promise(resolve=>window.resolveMode=resolve),
 onUpdateAvailable:fn=>events.available=fn,onUpdateDownloadProgress:fn=>events.progress=fn,
 onUpdateDownloaded:fn=>events.downloaded=fn,onUpdateError:fn=>events.error=fn,
 startUpdateDownload:async()=>{calls.push('download');return {ok:true}},
 openUpdateDownload:async()=>{calls.push('open');return {ok:true}},quitAndInstall:async()=>{calls.push('restart');return {ok:true}}};
 </script><script type="module">import {setLang} from '/js/i18n.js';import '/js/updater.js';window.setLang=setLang;window.ready=true;</script>`;
 server=http.createServer((req,res)=>{
  if(req.url==='/fixture'){res.setHeader('Content-Type','text/html');res.end(fixture);return;}
  const p=path.join(web,new URL(req.url,'http://local').pathname);
  if(!p.startsWith(web+path.sep)||!fs.existsSync(p)||!fs.statSync(p).isFile()){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(p));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 const run=code=>win.webContents.executeJavaScript(code);
 await win.loadURL(`http://127.0.0.1:${server.address().port}/fixture`);
 assert(await run('window.ready'),'real updater initialized');
 win.webContents.debugger.attach('1.3');
 let checked=0;
 for(const width of [320,390,1280]){
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});
  await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  for(const theme of ['light','dark'])for(const lang of ['zh','en']){
   await win.loadURL(`http://127.0.0.1:${server.address().port}/fixture`);
   assert(await run('window.ready'));
   for(const state of ['available','downloading','downloaded','manual','error']){
   const result=await run(`(async()=>{
    document.documentElement.dataset.theme=${JSON.stringify(theme)};setLang(${JSON.stringify(lang)});
    events.error('reset');events.available('0.21.2');
    if(${state==='downloading'}){events.progress({percent:25,transferred:1048576,total:4194304,bytesPerSecond:1024});events.progress({percent:50,transferred:2097152,total:4194304,bytesPerSecond:2048});}
    if(${state==='downloaded'||state==='manual'})events.downloaded('0.21.2');
    if(${state==='manual'}){resolveMode({manual:true});await Promise.resolve();await Promise.resolve();}
    if(${state==='error'})events.error('Download failed: '+ 'x'.repeat(500));
    await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const card=document.querySelector('.update-card'),body=card.querySelector('.update-card-body'),actions=card.querySelector('.update-actions');
    const c=card.getBoundingClientRect(),b=body.getBoundingClientRect(),a=actions.getBoundingClientRect();
    return {width:innerWidth,body:b.width,card:{left:c.left,right:c.right,top:c.top,bottom:c.bottom},bodyBottom:b.bottom,actionsTop:a.top,
     hasButtons:!!actions.children.length,overflow:card.scrollWidth>card.clientWidth+1,progress:card.querySelector('.update-pct')?.textContent,
     label:card.querySelector('.update-btn.primary')?.textContent};
   })()`);
   const label=JSON.stringify({width,theme,lang,state,result});
   assert(result.body>=200,label+' readable text column');
   assert(result.card.left>=0&&result.card.right<=width+1&&result.card.top>=0&&result.card.bottom<=721,label+' contained card');
   assert(!result.overflow,label+' no horizontal overflow');
   if(result.hasButtons)assert(result.actionsTop>=result.bodyBottom,label+' actions below copy');
   if(state==='downloading')assert.equal(result.progress,'50%');
   if(state==='manual')assert.equal(result.label,lang==='zh'?'打开下载文件':'Show Downloaded File');
   if(state==='downloaded')assert.equal(result.label,lang==='zh'?'重启并安装':'Restart & Install');
   checked++;
   }
  }
 }
 await run("setLang('zh');events.downloaded('0.21.2');document.documentElement.dataset.theme='dark'");
 await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width:390,height:720,deviceScaleFactor:1,mobile:false});
 await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 fs.writeFileSync(path.join(os.tmpdir(),'ashub-updater-dark.png'),(await win.webContents.capturePage()).toPNG());
 await run("document.documentElement.dataset.theme='light';new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
 fs.writeFileSync(path.join(os.tmpdir(),'ashub-updater-light.png'),(await win.webContents.capturePage()).toPNG());
 await run("document.querySelector('.update-btn.primary').click()");
 assert.deepEqual(await run('calls'),['open'],'manual action uses the existing download handler');
 console.log(`PASS updater: ${checked} viewport/theme/language/state cases, progress updates and manual download action`);
}).then(()=>finish(0),e=>{console.error(e);finish(1)});
