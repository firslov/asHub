const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const path=require('node:path'),fs=require('node:fs');
const {setup,delay}=require('./project-continuation-fixture.cjs');
app.on('window-all-closed',()=>{});
let f,win,db;const timeout=setTimeout(()=>{console.error('Continuation UI timeout');app.exit(1)},45000);
app.whenReady().then(async()=>{try{
 f=await setup();const owner=(await f.api('/sessions',{cwd:f.e.dir,kind:'agent'})).value.instanceId,member=(await f.api('/sessions',{cwd:f.e.dir,kind:'agent'})).value.instanceId;
 const project=(await f.api('/api/projects',{action:'create',name:'项目协作验证',cwd:f.e.dir,add:[owner,member]})).value[0].id;
 db=new DatabaseSync(path.join(f.e.dir,'hub-sessions','plugin-data',encodeURIComponent(f.feature.pluginId),'work.sqlite'));
 const plan={spec:{goal:'核查交付材料并完成复核'},goal:'核查交付材料并完成复核，不扩大原有工作范围',steps:[{id:'one',member,dependsOn:[],attempts:[{id:'uncertain'}]}]};
 db.prepare('INSERT INTO work VALUES(?,?,?,?)').run(project,owner,'evidence-review',JSON.stringify(plan));
 win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 win.webContents.on('console-message',e=>{if(e.level==='error')console.error(e.message)});
 const js=code=>win.webContents.executeJavaScript(code).catch(e=>{throw Error(code+' :: '+e.message)}),wait=async code=>{for(let i=0;i<150;i++){if(await js(code))return;await delay(30)}throw Error('Timed out: '+code)};
 await win.loadURL(f.base);win.show();
 await js(`(async()=>{localStorage.setItem('ash.lang','zh');(await import('/js/i18n.js')).setLang('zh')})()`);
 await wait(`!!document.querySelector('.extension-menu[aria-label="项目协作"]')`);
 await js(`document.querySelector('.extension-menu[aria-label="项目协作"]').click()`);
 await wait(`document.querySelector('.extension-resource-row')?.textContent.includes('evidence-review')`);
 assert.equal(await js(`document.querySelectorAll('.extension-resource-row button').length`),1);
 await js(`document.querySelector('.extension-resource-row button').click()`);
 await wait(`!!document.querySelector('.extension-resource-review')`);
 assert.match(await js(`document.querySelector('.extension-resource-review').textContent`),/核查交付材料/);
 for(const width of [1100,390,320]){
  await js(`document.querySelector('.app').classList.toggle('sidebar-collapsed',${width<600})`);
  win.setContentSize(width,800);await wait(`innerWidth===${width}`);
  await js(`document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))`);
  assert(await js(`(()=>{const p=document.querySelector('.extension-panel:not([hidden])');return p.scrollWidth<=p.clientWidth+1&&[...p.querySelectorAll('button')].filter(b=>b.offsetWidth).every(b=>b.getBoundingClientRect().right<=p.getBoundingClientRect().right+1)})()`),'confirmation fits '+width);
 }
 await js(`Array.from(document.querySelectorAll('.extension-resource button')).find(b=>b.textContent==='确认').click()`);
 await wait(`document.querySelector('.extension-resource-row')?.textContent.includes('等待你的决定')`);
 assert.equal(await js(`document.querySelectorAll('.extension-resource-row button').length`),1);
 assert.equal(f.instances[0].messages.length,0,'ambiguous dispatch does not start a model');
 await js(`document.querySelector('.app').classList.add('sidebar-collapsed')`);
 for(const theme of ['light','dark']){await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);await delay(250);assert(await js(`(()=>{const p=document.querySelector('.extension-panel:not([hidden])'),r=p.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+100)?.closest('.extension-panel')===p})()`),'panel must be visible, not behind sidebar');fs.writeFileSync('/tmp/ashub-project-continuation-'+theme+'.png',(await win.webContents.capturePage()).toPNG());}
 console.log('PASS project continuation UI: real installed plugin, one action per work, explicit confirmation, blocked-state feedback, 320/390px layout, light/dark');
}finally{clearTimeout(timeout);win?.destroy();db?.close();await f?.hub.shutdown();}}).then(()=>app.exit(0),e=>{console.error(e);app.exit(1)});
