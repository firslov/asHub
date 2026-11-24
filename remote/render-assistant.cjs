const {webkit,chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'public');
let enabled=true,paused=false,changes=0,grouped=false,legacyAccount=false,multipleDevices=false,holdCatalog,assistantShared=true,invalidCatalog=false;
const results=new Map();
const statusText='额度用完 · 明天 08:00 后继续';
const overview=()=>({toggle:{label:'长期记忆',checked:!paused,action:paused?'authorize':'pause',...(!paused?{status:statusText}:{})},actions:[...(!paused?[{id:'pause',label:'关闭长期记忆',values:{}}]:[])],note:paused?'记忆已暂停 · 数据保留':'记忆已开启 · 只整理这段专属对话',rows:[]});
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://local');
 if(u.pathname.includes('/api/')){res.setHeader('Content-Type','application/json');if(u.pathname.endsWith('/me'))return res.end(JSON.stringify({username:'fixture'}));if(u.pathname.endsWith('/devices'))return res.end(JSON.stringify([{id:'desktop',name:'我的电脑',online:true},...(multipleDevices?[{id:'other',name:'旧电脑',online:true}]:[])]));
 if(u.pathname.endsWith('/rpc')){let raw='';req.on('data',d=>raw+=d);return req.on('end',()=>{const {op,args={}}=JSON.parse(raw);let value={};
 const oldDevice=u.pathname.includes('/other/');
 if(op==='sessions')value=[{instanceId:'abcdef',title:'个人助手',projectId:!oldDevice&&grouped?'project':null},{instanceId:'bbbbbb',title:'普通对话',projectId:!oldDevice&&grouped?'project':null}].filter(s=>oldDevice||assistantShared||s.instanceId!=='abcdef');
 if(op==='capabilities')value=legacyAccount||oldDevice?{}:{pluginResources:true,projects:true};
 if(op==='project-groups')value=grouped?[{id:'project',name:'测试项目',sessionIds:['abcdef','bbbbbb']}]:[];
 if(op==='plugin-entries'){
 value=invalidCatalog?{}:enabled?[{pluginId:'0123456789abcdef01234567',key:'assistant',label:'个人助手',description:'从日常交流中，慢慢了解你',resource:'assistant',sessionId:'abcdef'}]:[];
 if(holdCatalog&&!oldDevice){const hold=holdCatalog;holdCatalog=null;return hold(()=>res.end(JSON.stringify(value)));}
 }
 if(op==='plugin-resource'){
 assert.equal(args.session,'abcdef');assert.equal(args.pluginId,'0123456789abcdef01234567');
 if(args.receipt)value=results.get(args.receipt);
 else{
 if(args.body?.confirm){paused=true;changes++;value={view:overview()};}
 else if(args.body?.action==='pause'){paused=true;changes++;value={view:overview()};}

 else value={view:overview()};
 if(args.body){results.set(args.requestId,value);value={state:'done',result:{resourceReceipt:args.requestId}};}
 }}res.end(JSON.stringify(value));});}res.writeHead(404);return res.end('{}');}
 const file=path.join(root,u.pathname.slice('/mobile/'.length)||'index.html');if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await (process.env.ENGINE==='chromium'?chromium:webkit).launch({headless:true,executablePath:process.env.WEBKIT_EXECUTABLE});try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{Object.defineProperty(navigator,'standalone',{value:true});globalThis.EventSource=class{constructor(){setTimeout(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify({meta:{name:'hub:replay-done'},payload:{}})});},10)}addEventListener(){}close(){}};});
 await page.goto(`http://127.0.0.1:${server.address().port}/mobile/`);await page.waitForSelector('.resource-inline-toggle');
 assert.equal(await page.locator('#sessions [data-session-id="abcdef"]').count(),0,'entry is not duplicated in independent list');
 for(const theme of ['light','dark'])for(const width of [390,320]){
  await page.setViewportSize({width,height:844});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const style=await page.locator('.plugin-entry-open').evaluate(b=>{const original=b.textContent;b.textContent='个人助手 · 很长的专属对话名称'.repeat(6);const row=b.parentElement,manage=row.querySelector('.plugin-entry-control'),r=row.getBoundingClientRect(),m=manage.getBoundingClientRect(),s=getComputedStyle(b);const result={size:s.fontSize,weight:Number(s.fontWeight),fits:row.scrollWidth<=row.clientWidth+1,touch:b.offsetHeight>=44&&m.width>=44&&m.height>=44,visible:m.right<=r.right+1};b.textContent=original;return result;});
  assert(style.size==='14px'&&style.weight<=500&&style.fits&&style.touch&&style.visible,JSON.stringify({theme,width,...style}));
  const status=page.locator('.plugin-entry .resource-inline-status');
  assert.equal(await status.textContent(),statusText);
  assert(await status.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'retry time fits on the phone sidebar');
  await page.waitForTimeout(300); // Capture settled theme colors, not transition frames.
  fs.mkdirSync('/tmp/assistant-build',{recursive:true});await page.screenshot({path:`/tmp/assistant-build/entry-${theme}-${width}.png`});
 }

 assert.equal(await page.getByRole('switch',{name:'长期记忆'}).getAttribute('aria-checked'),'true');
 assert.equal(await page.locator('#modal').evaluate(e=>e.open),false);
 await page.getByRole('switch',{name:'长期记忆'}).tap();
 await page.waitForFunction(()=>document.querySelector('.resource-inline-toggle')?.getAttribute('aria-checked')==='false');assert.equal(changes,1);
 assert.equal(await page.locator('.plugin-entry .resource-inline-status').count(),0);
 assert(await page.getByRole('switch',{name:'长期记忆'}).isDisabled(),'mobile cannot bypass desktop authorization');
 assert.equal(await page.locator('#modal').evaluate(e=>e.open),false);
 await page.locator('.plugin-entry-open').tap();await page.waitForFunction(()=>session==='abcdef');
 assert.equal(await page.locator('#chat-project').textContent(),'从日常交流中，慢慢了解你');
 await page.reload();await page.waitForFunction(()=>session==='abcdef');assert.equal(await page.locator('#chat-title').textContent(),'个人助手');
 await page.waitForSelector('.plugin-entry-open',{state:'attached'});
 assert.equal(await page.locator('#sessions [data-session-id="abcdef"]').count(),0,'dedicated entry is not duplicated in recent conversations');
 grouped=true;await page.evaluate(()=>refreshSessions());
 await page.locator('#menu').tap();
 const project=page.locator('#sessions [data-group-id="project"]');
 await project.waitFor();
 assert.equal(await project.locator('[data-session-id="bbbbbb"]').count(),1,'ordinary project conversations remain accessible');
 assert.equal(await project.locator('[data-session-id="abcdef"]').count(),0,'dedicated entry is not duplicated under a project');
 await page.locator('.plugin-entry-open').tap();
 assert.equal(await page.locator('#chat-project').textContent(),'从日常交流中，慢慢了解你');
 await page.locator('#query').fill('个人助手草稿');
 multipleDevices=true;await page.evaluate(()=>refreshDevices());
 let catalogTimer;
 const catalogStarted=new Promise((resolve,reject)=>{
  holdCatalog=resolve;
  catalogTimer=setTimeout(()=>reject(Error('等待设备会话目录超时')),5000);
 });
 const pendingCatalog=page.evaluate(()=>refreshSessions());
 const finishCatalog=await catalogStarted.finally(()=>clearTimeout(catalogTimer));
 try{
  await page.locator('#menu').tap();
  await page.locator('#devices').selectOption('other');
  await page.waitForFunction(()=>device==='other'&&capabilitiesDevice==='other');
 }finally{finishCatalog();await pendingCatalog;}
 assert(await page.locator('#plugin-entries').isHidden(),'a stale catalog from the previous device cannot classify an ordinary namesake');
 await page.locator('#sessions [data-session-id="abcdef"]').waitFor();
 await page.locator('#devices').selectOption('desktop');
 await page.waitForFunction(()=>device==='desktop'&&session==='abcdef'&&document.getElementById('query').value==='个人助手草稿');
 await page.locator('.plugin-entry-open').waitFor({state:'attached'});
 assistantShared=false;await page.evaluate(()=>refreshSessions());
 assert(await page.locator('#plugin-entries').isHidden(),'a conversation removed from the shared catalog loses its dedicated entry');
 assistantShared=true;invalidCatalog=true;grouped=false;await page.evaluate(()=>refreshSessions());
 assert(await page.locator('#plugin-entries').isHidden(),'restored access with invalid metadata cannot revive a stale entry');
 await page.locator('#sessions [data-session-id="abcdef"]').waitFor();
 invalidCatalog=false;await page.evaluate(()=>refreshSessions());
 await page.locator('.plugin-entry-open').waitFor({state:'attached'});
 legacyAccount=true;grouped=false;await page.evaluate(()=>start('legacy-account'));
 assert(await page.locator('#plugin-entries').isHidden(),'a new account without plugin metadata never inherits a prior entry');
 await page.locator('#sessions [data-session-id="abcdef"]').waitFor();
 legacyAccount=false;await page.evaluate(()=>start('fixture'));
 await page.locator('.plugin-entry-open').waitFor({state:'attached'});
 enabled=false;await page.evaluate(()=>refreshSessions());assert(await page.locator('#plugin-entries').isHidden());
 // Exercise the shared modal renderer without granting memory from the phone.
 await page.evaluate(async()=>{
  const {mountResource}=await import('./plugin-resource-view.js');
  const host=document.createElement('div');document.body.append(host);
  const fields=[
   {label:'读取范围',value:'仅处理「个人助手」对话，包括已有聊天记录及后续消息。'},
   {label:'后台模型',value:'跟随此对话当前选择的模型与 VPN。'},
   {label:'使用额度',value:'每天最多 4 次后台处理，可随时撤销授权。'},
  ];
  const details=[
   {label:'观察范围',value:'仅限个人助手专属对话'},
   {label:'历史范围',value:'包含已有持久化历史'},
   {label:'单次请求上限',value:'输入最多 16000 字符，输出预算 4096 tokens。'},
  ];
  const view={actions:[{id:'enable',label:'Enable',values:{}}],rows:[],toggle:{label:'Fixture memory',checked:false,action:'enable'}};
  const dispose=mountResource(host,{pluginId:'fixture'},'start',{inlineToggle:true,request:async body=>body?.action?{confirmation:{id:'grant',preview:{title:'开启长期记忆',fields,details}}}:{view}});
  window.closeConsentFixture=()=>{dispose();host.remove();};
 });
 const testSwitch=page.getByRole('switch',{name:'Fixture memory'});
 const consent=page.locator('.resource-toggle-confirm');
 const consentButtons=()=>consent.evaluate(d=>{
  const frame=d.getBoundingClientRect();
  return [...d.querySelectorAll('button')].every(button=>{const r=button.getBoundingClientRect();
   return r.height>=44&&r.top>=frame.top&&r.bottom<=frame.bottom&&[r.top+8,r.bottom-8].every(y=>button.contains(document.elementFromPoint(r.x+r.width/2,y)));
  });
 });
 const shots=process.env.ASHUB_UI_SCREENSHOTS;if(shots)fs.mkdirSync(shots,{recursive:true});
 for(const theme of ['light','dark'])for(const width of [390,320]){
  await page.setViewportSize({width,height:720});
  await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
  await testSwitch.evaluate(b=>b.click());
  await consent.waitFor();
  assert(await consentButtons(),`closed details: ${theme}/${width}`);
  if(shots)await page.screenshot({path:path.join(shots,`assistant-consent-${theme}-${width}.png`)});
  await consent.locator('summary').tap();
  const scrolled=await consent.locator('.resource-toggle-review').evaluate(r=>{r.scrollTop=r.scrollHeight;return r.scrollTop>0;});
  assert(scrolled&&await consentButtons(),`expanded details: ${theme}/${width}`);
  if(shots)await page.screenshot({path:path.join(shots,`assistant-consent-details-${theme}-${width}.png`)});
  await consent.locator('.p-btn').tap();
  await consent.waitFor({state:'detached'});
  assert.equal(await testSwitch.getAttribute('aria-checked'),'false');
 }
 await page.evaluate(()=>{window.closeConsentFixture();});
 await page.evaluate(async()=>{
  const {mountResource}=await import('./plugin-resource-view.js');
  const host=document.createElement('div'),other=document.createElement('button');document.body.append(host,other);
  const view={actions:[{id:'enable',label:'Enable',values:{}}],rows:[],toggle:{label:'Memory',checked:false,action:'enable'}};
  let release,delayed=false;
  const dispose=mountResource(host,{pluginId:'fixture'},'start',{inlineToggle:true,request:async body=>!body?{view}:delayed?new Promise(r=>release=()=>r({view})):{confirmation:{id:'grant',preview:{title:'Permission',fields:[]}}}});
  const wait=()=>new Promise(r=>setTimeout(r,30));await wait();host.querySelector('button').focus();host.querySelector('button').click();await wait();
  document.querySelector('.resource-toggle-confirm .p-btn').click();await wait();
  if(document.activeElement!==host.querySelector('button'))throw Error('Cancel lost switch focus');
  delayed=true;host.querySelector('button').click();other.focus();release();await wait();
  if(document.activeElement!==other)throw Error('Late response stole focus');
  dispose();host.remove();other.remove();
 });
 await page.evaluate(require('../tests/assistant-health-scenario.cjs'),{moduleUrl:'./plugin-resource-view.js',remote:true});
 assert.deepEqual(errors,[]);console.log('PASS remote assistant: deduplicated entry, account/device isolation, stale catalog, draft restore, scoped resources, cancel/confirm, disable and 320/390 light/dark layout');
 }finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
