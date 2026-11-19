const {webkit,chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'public');let enabled=true,paused=false,changes=0;const results=new Map();
const overview=()=>({toggle:{label:'长期记忆',checked:!paused,action:paused?'authorize':'pause'},actions:[...(!paused?[{id:'pause',label:'关闭长期记忆',values:{}}]:[])],note:paused?'记忆已暂停 · 数据保留':'记忆已开启 · 只整理这段专属对话',rows:[]});
const server=http.createServer((req,res)=>{const u=new URL(req.url,'http://local');
 if(u.pathname.includes('/api/')){res.setHeader('Content-Type','application/json');if(u.pathname.endsWith('/me'))return res.end(JSON.stringify({username:'fixture'}));if(u.pathname.endsWith('/devices'))return res.end(JSON.stringify([{id:'desktop',name:'我的电脑',online:true}]));
 if(u.pathname.endsWith('/rpc')){let raw='';req.on('data',d=>raw+=d);return req.on('end',()=>{const {op,args={}}=JSON.parse(raw);let value={};
 if(op==='sessions')value=[{instanceId:'abcdef',title:'个人助手',projectId:null},{instanceId:'bbbbbb',title:'普通对话',projectId:null}];
 if(op==='capabilities')value={pluginResources:true};if(op==='plugin-entries')value=enabled?[{pluginId:'0123456789abcdef01234567',key:'assistant',label:'个人助手',description:'从日常交流中，慢慢了解你',resource:'assistant',sessionId:'abcdef'}]:[];
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
  await page.waitForTimeout(300); // Capture settled theme colors, not transition frames.
  fs.mkdirSync('/tmp/assistant-build',{recursive:true});await page.screenshot({path:`/tmp/assistant-build/entry-${theme}-${width}.png`});
 }

 assert.equal(await page.getByRole('switch',{name:'长期记忆'}).getAttribute('aria-checked'),'true');
 assert.equal(await page.locator('#modal').evaluate(e=>e.open),false);
 await page.getByRole('switch',{name:'长期记忆'}).tap();
 await page.waitForFunction(()=>document.querySelector('.resource-inline-toggle')?.getAttribute('aria-checked')==='false');assert.equal(changes,1);
 assert(await page.getByRole('switch',{name:'长期记忆'}).isDisabled(),'mobile cannot bypass desktop authorization');
 assert.equal(await page.locator('#modal').evaluate(e=>e.open),false);
 await page.locator('.plugin-entry-open').tap();await page.waitForFunction(()=>session==='abcdef');
 assert.equal(await page.locator('#chat-project').textContent(),'从日常交流中，慢慢了解你');
 await page.reload();await page.waitForFunction(()=>session==='abcdef');assert.equal(await page.locator('#chat-title').textContent(),'个人助手');
 enabled=false;await page.evaluate(()=>refreshSessions());assert(await page.locator('#plugin-entries').isHidden());
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
 assert.deepEqual(errors,[]);console.log('PASS remote assistant: iPhone PWA entry, navigation, scoped resources, cancel/confirm, disable and 320/390 light/dark layout');
 }finally{await browser.close();server.close();}})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
