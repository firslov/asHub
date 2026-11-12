const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),{once}=require('node:events');
const {env,Bridge,root,path,fs}=require('./harness.cjs');
const e=env(),bridges=[];process.env.AGENT_SH_HOME=e.dir;app.setPath('userData',path.join(e.dir,'browser'));
app.on('window-all-closed',()=>{});
let win,hub;const timer=setTimeout(()=>{console.error('Compaction UI timeout');app.exit(1);},30000);
app.whenReady().then(async()=>{try{
 hub=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{const b=new Bridge(o);bridges.push(b);return b;}});
 if(!hub.server.listening)await once(hub.server,'listening');const base='http://127.0.0.1:'+hub.server.address().port;
 const {instanceId}=await (await fetch(base+'/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cwd:e.dir,kind:'agent'})})).json();
 win=new BrowserWindow({show:true,width:1280,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await win.loadURL(base);const js=code=>win.webContents.executeJavaScript(code);
 const wait=async code=>{for(let i=0;i<160;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timed out: '+code);};
 await js(`(async()=>{(await import('/js/i18n.js')).setLang('zh');(await import('/js/session-manager.js')).openTab(${JSON.stringify(instanceId)})})()`);
 await wait(`(async()=>{const s=(await import('/js/session-manager.js')).activeSession.value;return s?.id===${JSON.stringify(instanceId)}&&!s.state.replaying})()`);
 const send=(name,payload)=>bridges[0].emit('event',{name,payload});
 send('agent:query',{query:'继续刚才的讨论'});
 send('hub:compaction-marker',{evictedCount:21,checkpointId:'fixture',beforeTokens:34168,afterTokens:19570,mode:'semantic',elapsedMs:40168,summary:'PRIVATE RAW HISTORY <img src=x onerror=alert(1)>'});
 await wait('document.querySelectorAll(".compaction-marker").length===1');
 await js('document.querySelector(".compaction-marker").open=true;document.querySelector(".cm-summary").focus()');
 send('ui:info',{message:'(compacted: ~34,168 → ~19,570 tokens)'});
 await wait('document.querySelector(".cm-metrics")?.textContent.includes("19.6k")');
 assert.equal(await js('document.querySelectorAll(".compaction-marker").length'),1);
 assert(await js('document.querySelector(".compaction-marker").open'));
 assert(!await js('document.querySelector(".compaction-marker").textContent.includes("PRIVATE RAW")'));
 send('ui:info',{message:'(nothing to compact)'});await wait('[...document.querySelectorAll(".ui-info")].some(n=>n.textContent.includes("nothing to compact"))');
 send('ui:info',{message:'(compacted: ~50,000 → ~10,000 tokens)'});await wait('document.querySelectorAll(".compaction-marker").length===2');
 await wait('getComputedStyle(document.getElementById("page-loader")).visibility==="hidden"&&Number(getComputedStyle(document.querySelector(".terminal-wrap")).opacity)>.99');
 for(const theme of ['light','dark'])for(const width of [1280,390,320]){
  win.setContentSize(width,800);await wait('innerWidth==='+width);
  await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.querySelector('.app').classList.toggle('sidebar-collapsed',${width<600})`);
  await js('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
  await wait('document.querySelector(".compaction-marker").clientWidth>='+Math.min(width-150,400));
  const bounds=await js('[...document.querySelectorAll(".compaction-marker")].map(n=>({scroll:n.scrollWidth,client:n.clientWidth,display:getComputedStyle(n).display}))');
  assert(bounds.every(n=>n.client>0&&n.scroll<=n.client+1),JSON.stringify({theme,width,bounds}));
  if(process.env.ASHUB_UI_SCREENSHOTS){fs.mkdirSync(process.env.ASHUB_UI_SCREENSHOTS,{recursive:true});await new Promise(r=>setTimeout(r,250));fs.writeFileSync(path.join(process.env.ASHUB_UI_SCREENSHOTS,`compaction-${theme}-${width}.png`),(await win.webContents.capturePage()).toPNG());}
 }
 await win.loadURL(base);await js(`(async()=>{(await import('/js/session-manager.js')).openTab(${JSON.stringify(instanceId)})})()`);
 await wait('document.querySelectorAll(".compaction-marker").length>=1');
 assert.equal(await js('document.querySelector(".cm-metrics").textContent'),'21 条记录 · ~34.2k → ~19.6k');
 console.log('PASS compaction UI: real HTTP/SSE, receipt merge, unrelated info, replay, details and 320/390/1280 themes');
 win.destroy();await hub.shutdown();clearTimeout(timer);app.exit(0);
}catch(error){console.error(error);win?.destroy();try{await hub?.shutdown();}catch{}clearTimeout(timer);app.exit(1);}});
