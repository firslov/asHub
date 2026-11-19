const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../web'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'device-interconnect-ui-'));
app.setPath('userData',profile);app.on('window-all-closed',()=>{});const timer=setTimeout(()=>app.exit(1),60000);
app.whenReady().then(async()=>{
 let win,server;
 try{
  const {connectionResource}=await import('../examples/extensions/multi-machine/app.mjs');
  let configured=0,updated=0,disabled=0,revision={};
  const local={enabled:true,status:'online',deviceName:'我的 Mac',username:'publisher',roots:['/Users/fixture/Shared'],gateway:'https://ashub.aihao.world/mobile/'};
  const account={cookie:'',user:'',error:'',records:new Map(),login:async()=>{account.cookie='cookie';account.user='controller';},logout:async()=>{account.cookie='';account.user='';},refresh:async()=>{}};
  const sharing={status:()=>local,directoryChange:roots=>({roots,added:roots.filter(p=>!local.roots.includes(p)),removed:local.roots.filter(p=>!roots.includes(p))}),revision:()=>revision,updateRoots:async(roots,expected)=>{assert.equal(expected,revision);local.roots=roots;revision={};updated++;},configure:async()=>{configured++;},disable(){local.enabled=false;disabled++;}};
  let pending,finishOpen,openCount=0;
  const device='A'.repeat(43);
  account.openDevice=async()=>{openCount++;await new Promise(r=>finishOpen=r);};
  const feature={id:'device-fixture',pluginId:'fixture',name:'设备互联',scope:'application',enabled:true,state:'active',capabilities:['shared-conversations'],ui:{version:1,panels:[{id:'devices-panel',title:'设备互联',icon:'devices',components:[{type:'resource',id:'connections'}]}]}};
  const resource=connectionResource(account,sharing);
  server=http.createServer(async(req,res)=>{
   if(req.url==='/api/extensions'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:1,features:[feature]}));return;}
   if(req.url.startsWith('/api/plugin-resources/')){let raw='';for await(const c of req)raw+=c;let value={view:resource.view()};if(raw){const b=JSON.parse(raw);if(b.confirm){value={view:await pending.execute(pending.sharingAuthorization?.roots)};}else{const p=await resource.prepare(b.action,b.values);if(p.preview){pending=p;value={confirmation:{id:'fixture-confirm',preview:p.preview}};}else value={view:await p.execute()};}}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return;}
   if(req.url.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end('{}');return;}
   const file=path.join(root,req.url==='/'?'index.html':new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404).end();return;}
   let bytes=fs.readFileSync(file);if(file.endsWith('.html'))bytes=bytes.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(bytes);
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadURL('http://127.0.0.1:'+server.address().port);const run=code=>win.webContents.executeJavaScript('(async()=>{'+code+'})()');const wait=async code=>{for(let n=0;n<150;n++){if(await run('return '+code))return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out '+code);};
  await run(`localStorage.setItem('ash.lang','zh');window.electronAPI={pickDirectory:async()=>({cwd:'/Users/fixture/New'}),onRevealPluginResource:cb=>window.revealResource=cb};document.querySelector('.page-loader')?.remove();await import('/js/prefs.js');const {initializeFeatureUI}=await import('/js/extensions/feature-ui.js');initializeFeatureUI();await (await import('/js/extensions/feature-state.js')).featuresReady();document.querySelector('.extension-menu').click();`);
  await wait(`document.querySelector('.extension-panel').textContent.includes('共享账号：publisher · 在线')`);
  for(const width of [1180,390,320])for(const theme of ['light','dark']){
   win.webContents.enableDeviceEmulation({screenPosition:'desktop',screenSize:{width,height:850},viewPosition:{x:0,y:0},viewSize:{width,height:850},deviceScaleFactor:1,scale:1});
   await wait(`innerWidth===${width}`);await run(`document.documentElement.dataset.theme='${theme}';const trigger=document.querySelector('.extension-menu');if(trigger.classList.contains('active'))trigger.click();trigger.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));`);
   await new Promise(r=>setTimeout(r,250));
   const check=await run(`const p=document.querySelector('.extension-panel'),r=p.getBoundingClientRect();return {width:innerWidth,left:r.left,right:r.right,scroll:p.scrollWidth,client:p.clientWidth};`);
   assert(check.left>=-1&&check.right<=width+1,JSON.stringify(check));assert(check.scroll<=check.client+1,JSON.stringify(check));
   if(width===390){fs.writeFileSync(path.join(os.tmpdir(),'ashub-device-interconnect-'+theme+'.png'),(await win.webContents.capturePage({x:0,y:0,width,height:800})).toPNG());}
  }
  const click=async text=>{await run(`const b=Array.from(document.querySelectorAll('.extension-panel button')).find(b=>b.textContent===${JSON.stringify(text)});if(!b)throw Error('Missing button '+${JSON.stringify(text)});b.scrollIntoView({block:'center'});await new Promise(r=>requestAnimationFrame(r));const r=b.getBoundingClientRect();if(!b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Button obscured '+b.textContent);b.click();`);};
  assert.deepEqual(await run(`return Array.from(document.querySelectorAll('.extension-resource-section-title')).map(n=>n.textContent);`),['访问其他电脑','允许其他设备访问本机']);
  assert(await run(`return !Array.from(document.querySelectorAll('.extension-panel details button')).some(b=>b.textContent==='关闭本机访问');`));
  assert(await run(`return !Array.from(document.querySelectorAll('.extension-panel button')).some(b=>b.textContent==='复制手机入口') && document.querySelector('.extension-panel').textContent.includes('https://ashub.aihao.world/mobile/');`));
  await click('设置共享目录');await wait(`!!document.querySelector('.extension-directory-list')`);
  assert(await run(`return !document.querySelector('.extension-panel input[type=password]') && document.querySelector('.extension-directory-list').textContent.includes('/Users/fixture/Shared');`));
  fs.writeFileSync(path.join(os.tmpdir(),'ashub-device-interconnect-directories.png'),(await win.webContents.capturePage()).toPNG());
  await click('添加目录');await wait(`document.querySelector('.extension-directory-list').textContent.includes('/Users/fixture/New')`);
  await click('移除');await click('核对目录变更');await wait(`!!document.querySelector('.extension-resource-review')`);
  assert(await run(`const text=document.querySelector('.extension-resource-review').textContent;return text.includes('新增目录/Users/fixture/New') && text.includes('移除目录/Users/fixture/Shared') && text.includes('不会删除本地对话');`));
  assert.equal(updated,0);await click('取消');await wait(`!!document.querySelector('.extension-directory-list')`);
  assert(await run(`return document.querySelector('.extension-directory-list').textContent.includes('/Users/fixture/New');`));
  await click('核对目录变更');await wait(`!!document.querySelector('.extension-resource-review')`);await click('确认');await wait(`!!document.querySelector('.extension-resource-section-title')`);
  assert.equal(updated,1);assert.equal(configured,0);assert.deepEqual(local.roots,['/Users/fixture/New']);
  // A late native picker must not apply to a new page, nor block normal controls.
  await click('设置共享目录');await wait(`!!document.querySelector('.extension-directory-list')`);
  await run(`localStorage.setItem('ash.lang','zh');window.electronAPI.pickDirectory=()=>new Promise(r=>window.finishPick=r);`);
  // The renderer captures the picker for this field, so remount the editor.
  await click('返回');await wait(`!!document.querySelector('.extension-resource-section-title')`);await click('设置共享目录');await wait(`!!document.querySelector('.extension-directory-list')`);
  await click('添加目录');await wait(`!!window.finishPick`);await click('返回');await wait(`!!document.querySelector('.extension-resource-section-title')`);await run(`window.finishPick({cwd:'/late'});await new Promise(r=>setTimeout(r,20));`);
  assert.deepEqual(local.roots,['/Users/fixture/New']);assert.equal(updated,1);
  await click('登录连接账号');await wait(`!!document.querySelector('.extension-panel input[type=password]')`);
  await run(`const fields=document.querySelectorAll('.extension-panel input');fields[0].value='controller';fields[1].value='password';`);
  await click('登录连接账号');await wait(`!!document.querySelector('.extension-resource-review')`);await click('确认');await wait(`document.querySelector('.extension-panel').textContent.includes('退出连接账号')`);
  assert.equal(configured,0);assert.equal(local.enabled,true);
  await click('退出连接账号');await wait(`document.querySelector('.extension-panel').textContent.includes('未登录连接账号')`);assert.equal(local.enabled,true);
  account.cookie='controller';await click('关闭本机访问');await wait(`!!document.querySelector('.extension-resource-review')`);assert.equal(disabled,0);await click('取消');assert.equal(disabled,0);
  await click('关闭本机访问');await wait(`!!document.querySelector('.extension-resource-review')`);await click('确认');await wait(`document.querySelector('.extension-panel').textContent.includes('已关闭')`);assert.equal(disabled,1);assert.equal(account.cookie,'controller');
  await click('允许访问本机');await wait(`!!document.querySelector('.extension-panel input[type=password]')`);assert.equal(configured,0);
  assert(await run(`const p=document.querySelector('.extension-panel');return p.scrollWidth<=p.clientWidth+1;`));
  await click('返回');await wait(`!!document.querySelector('.extension-resource-section-title')`);
  assert(await run(`return document.querySelectorAll('.extension-menu').length===1 && !document.getElementById('mobile-access-toggle');`));
  // Opening feedback names the exact device while the action is pending; duplicate clicks are inert.
  account.cookie='controller';account.records.set(device,{device:{name:'Office Mac',online:true}});account.discovery='ready';
  resource.onReveal();await run(`await window.revealResource({plugin:'fixture',resource:'connections'});`);await wait(`document.querySelector('.extension-panel').textContent.includes('Office Mac')`);
  await click('打开工作区');await wait(`document.querySelector('.extension-panel .plugins-message').textContent.includes('正在连接「Office Mac」')`);
  await run(`Array.from(document.querySelectorAll('.extension-panel button')).find(b=>b.textContent==='打开工作区').click();`);assert.equal(openCount,1);finishOpen();await wait(`!document.querySelector('.extension-resource[aria-busy=true]')`);
  // Reveal from a revoked window must leave an existing subpage, not merely focus it.
  await(await resource.prepare('connect-account',{})).execute();await run(`await window.revealResource({plugin:'fixture',resource:'connections'});`);await wait(`!!document.querySelector('.extension-panel input[type=password]')`);
  account.records.clear();account.cookie='';account.discovery='expired';resource.onReveal();
  await run(`await window.revealResource({plugin:'fixture',resource:'connections'});`);await wait(`document.querySelector('.extension-panel').textContent.includes('登录已过期') && !document.querySelector('.extension-panel input[type=password]')`);
  local.enabled=true;local.status='online';await(await resource.prepare('edit-sharing',{})).execute();
  await run(`await window.revealResource({plugin:'fixture',resource:'connections'});`);await wait(`!!document.querySelector('.extension-directory-list')`);
  resource.onReveal();await run(`await window.revealResource({plugin:'fixture',resource:'connections'});`);
  await wait(`document.querySelector('.extension-panel').textContent.includes('登录已过期') && !document.querySelector('.extension-directory-list')`);
  // Generic directory fields obey existing form visibility and validation rules.
  await run(`const {mountResource,validateResourceView}=await import('/js/extensions/resource-view.js');
    for(const bad of [{rows:[{title:'Bad',actions:[],inlineActions:'yes'}],actions:[]},{rows:[],actions:[{id:'copy',label:'Copy',values:{},copyText:{}}]}]){let rejected=false;try{validateResourceView(bad);}catch{rejected=true;}if(!rejected)throw Error('Malformed view accepted');}
    const host=document.createElement('div');document.body.append(host);host.id='directory-fixture';
    window.genericDispose=mountResource(host,{pluginId:'fixture'},'conditional',{request:async body=>body?{view:{actions:[],rows:[],note:'saved'}}:{view:{actions:[],rows:[],form:{action:'save',submit:'Save',values:{},fields:[{id:'mode',label:'Mode',type:'select',value:'off',options:[{value:'off',label:'Off'},{value:'on',label:'On'}]},{id:'roots',label:'Roots',type:'directories',value:'/initial',when:{field:'mode',values:['on']}}]}}}});`);
  await wait(`!!document.querySelector('#directory-fixture .extension-directory-list')`);
  assert(await run(`const d=document.querySelector('#directory-fixture .extension-directory-list').parentElement;return d.hidden && getComputedStyle(d).display==='none' && Array.from(d.querySelectorAll('button,textarea')).every(e=>e.disabled);`));
  await run(`const s=document.querySelector('#directory-fixture select');s.value='on';s.dispatchEvent(new Event('change',{bubbles:true}));`);
  assert(await run(`const d=document.querySelector('#directory-fixture .extension-directory-list').parentElement;return !d.hidden && Array.from(d.querySelectorAll('button,textarea')).every(e=>!e.disabled);`));
  await run(`document.querySelector('#directory-fixture .plugin-config-label > button').click();`);await wait(`!!window.finishPick`);
  await run(`const s=document.querySelector('#directory-fixture select');s.value='off';s.dispatchEvent(new Event('change',{bubbles:true}));window.finishPick({cwd:'/hidden-late'});await new Promise(r=>setTimeout(r,20));`);
  assert(await run(`const d=document.querySelector('#directory-fixture .extension-directory-list').parentElement;return d.querySelector('textarea').value==='/initial' && Array.from(d.querySelectorAll('button,textarea')).every(e=>e.disabled);`));
  await run(`genericDispose();document.querySelector('#directory-fixture').remove();`);
  console.log('PASS interconnect sections, phone address without copy button, directory picker/add/remove/review/cancel/save/late picker, account/publisher isolation, binding form, light/dark and 1180/390/320px layouts');
 }finally{win?.destroy();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());fs.rmSync(profile,{recursive:true,force:true});clearTimeout(timer);}
}).then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
