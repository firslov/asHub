// Real WebKit rendering, using only synthetic files and an isolated local server.
const {webkit}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'public');let bytes,requests=[],pending=[],invalid=false;
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://local');
 if(u.pathname.endsWith('/artifact')||u.pathname.endsWith('/image-resource')){
  requests.push(u);const data=invalid?Buffer.from('<svg onload="alert(1)"></svg>'):bytes;
  res.setHeader('Content-Type',u.pathname.endsWith('/image-resource')?'image/png':'application/octet-stream');res.setHeader('Content-Length',data.length);res.setHeader('X-Artifact-Version','fixture-v1');res.setHeader('Content-Disposition','attachment; filename="curve.png"');
  if(req.method==='HEAD')return res.end();
  if(u.searchParams.get('path')?.includes('slow')){pending.push(()=>res.end(data));return;}
  return res.end(data);
 }
 if(u.pathname.includes('/api/')){res.writeHead(401,{'Content-Type':'application/json'});return res.end('{"error":"fixture"}')}
 const filename=path.join(root,u.pathname.slice('/mobile/'.length)||'index.html');
 if(!filename.startsWith(root+path.sep)||!fs.existsSync(filename)){res.writeHead(404);return res.end()}
 res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.woff2':'font/woff2'})[path.extname(filename)]||'application/octet-stream');res.end(fs.readFileSync(filename));
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await webkit.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/mobile/`);
 bytes=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=4000;c.height=600;c.getContext('2d').fillRect(0,0,4000,600);return c.toDataURL().split(',')[1]}),'base64');
 await page.evaluate(()=>{for(const e of document.body.children)e.style.display='none';globalThis.testRoot=document.createElement('article');testRoot.className='message reply';testRoot.style.cssText='margin:16px;max-width:100%';document.body.append(testRoot);device='d'.repeat(43);devices=[{id:device,name:'Fixture',online:true}];deviceListReady=true;session='abcdef';capabilities={artifacts:true,imageResources:true};});
 const formula=String.raw`\[
新目标仓位=原三均线目标仓位\times\min\left(1,\frac{3\%}{ATR_{14}/复权收盘价}\right)
\]`;
 for(const width of [320,390]){
  await page.setViewportSize({width,height:844});
  for(const mode of ['paragraph','table','list']){
   let image='![收益曲线](results/curve.png)';let md=mode==='table'?`| 图表 |\n|---|\n| ${image} |`:mode==='list'?`- ${image}`:image;
   await page.evaluate(md=>{testRoot.innerHTML='';renderMarkdown(testRoot,md)},formula+'\n\n'+md);
   await page.waitForSelector('.artifact-image img');assert.equal(await page.locator('.katex-display').count(),1);
   const geometry=await page.evaluate(()=>{const r=testRoot.getBoundingClientRect(),i=testRoot.querySelector('img').getBoundingClientRect();return{right:i.right-r.right,width:i.width,document:document.documentElement.scrollWidth,viewport:innerWidth}});
   assert(geometry.width>0&&geometry.right<=1&&geometry.document<=geometry.viewport,JSON.stringify({width,mode,geometry}));
  }
 }
 assert(requests.every(u=>u.searchParams.get('session')==='abcdef'),'image request belongs to message owner');
 const count=requests.length;await page.evaluate(()=>{globalThis.originalImage=testRoot.querySelector('img');globalThis.originalMD='![收益曲线](results/curve.png)';renderMarkdown(testRoot,originalMD+' more')});
 await page.waitForTimeout(80);assert.equal(requests.length,count);assert(await page.evaluate(()=>testRoot.querySelector('img')===originalImage),'stream reuses decoded image');
 await page.locator('.artifact-image button').click();await page.waitForSelector('dialog[open] .artifact-preview-image');assert(requests.some(u=>u.searchParams.get('version')==='fixture-v1'),'preview pins displayed file version');await page.evaluate(()=>AsHubFilePreview.close());
 // Member output uses that member's directory even when the coordinator is selected.
 await page.evaluate(()=>{testRoot.innerHTML='';renderMarkdown(testRoot,'![member](member.png)','fedcba')});await page.waitForSelector('.artifact-image img');assert.equal(requests.at(-1).searchParams.get('session'),'fedcba');
 const before=requests.length;await page.evaluate(()=>{testRoot.innerHTML='';renderMarkdown(testRoot,'![external](https://example.invalid/a.png) ![bad](javascript:alert%281%29)')});await page.waitForFunction(()=>testRoot.textContent.includes('重试'));assert.equal(requests.length,before,'no external or executable image request');
 invalid=true;await page.evaluate(()=>{testRoot.innerHTML='';renderMarkdown(testRoot,'![wrong type](bad.png)')});await page.waitForFunction(()=>testRoot.textContent.includes('重试'));assert.equal(await page.locator('.artifact-image img').count(),0,'reject SVG/HTML bytes');invalid=false;
 await page.evaluate(()=>{testRoot.innerHTML='';renderMarkdown(testRoot,'![late](slow.png)')});for(let i=0;i<100&&!pending.length;i++)await page.waitForTimeout(20);assert(pending.length);await page.evaluate(()=>{generation++;session='bbbbbb';testRoot.innerHTML=''});pending.splice(0).forEach(f=>f());await page.waitForTimeout(100);assert.equal(await page.locator('.artifact-image img').count(),0,'late result discarded');
 // Existing plugin images still use their snapshot endpoint.
 await page.evaluate(()=>renderMarkdown(testRoot,'![snapshot](ashub-image:'+'a'.repeat(64)+'/4000x600)'));await page.waitForSelector('.image-resource img');assert(requests.at(-1).pathname.endsWith('/image-resource'));
 // Both image kinds share a two-request budget, leaving room for preview downloads.
 await page.evaluate(()=>{globalThis.loadPeak=0;globalThis.loadActive=0;const original=fetch;globalThis.savedFetch=original;globalThis.fetch=async(...args)=>{loadPeak=Math.max(loadPeak,++loadActive);try{await new Promise(r=>setTimeout(r,40));return await original(...args)}finally{loadActive--}};testRoot.innerHTML='';renderMarkdown(testRoot,'![one](one.png) ![two](two.png) ![snap](ashub-image:'+'a'.repeat(64)+'/4000x600) ![snap2](ashub-image:'+'b'.repeat(64)+'/4000x600)')});
 await page.waitForFunction(()=>testRoot.querySelectorAll('img').length===4);assert((await page.evaluate(()=>loadPeak))<=2);await page.evaluate(()=>{fetch=savedFetch});
 // Code and monetary text retain literal delimiters; completed stream and replay render math.
 await page.evaluate(()=>{testRoot.innerHTML='';renderMarkdown(testRoot,'`$x$`\n\n```tex\n\\[x\\]\n```\n\n价格 $20 和 $30')});assert.equal(await page.locator('.katex').count(),0);assert(await page.locator('code').first().textContent()==='$x$');
 await page.evaluate(()=>{testRoot.innerHTML='';renderMarkdown(testRoot,'\\[\\frac{a}{b}')});assert.equal(await page.locator('.katex').count(),0);
 await page.evaluate(()=>renderMarkdown(testRoot,'\\[\\frac{a}{b}\\]'));assert.equal(await page.locator('.katex-display').count(),1);
 await page.evaluate(formula=>{document.querySelector('#messages').innerHTML='';frame({meta:{name:'agent:response-segment'},payload:{text:formula}})},formula);await page.waitForFunction(()=>document.querySelectorAll('#messages .katex-display').length===1);
 // Older replay records contain inline image bytes, even in image-only messages.
 await page.evaluate(data=>{
  const messages=document.querySelector('#messages');messages.replaceChildren();
  for(const mimeType of ['image/png','IMAGE/PNG'])frame({meta:{name:'agent:query'},payload:{images:[{mimeType,data}]}});
  frame({meta:{name:'agent:query'},payload:{query:'bad attachment',images:[{mimeType:'image/svg+xml',data},{mimeType:'image/png',data:'https://example.invalid/picture.png'}]}});
  frame({meta:{name:'hub:replay-done'},payload:{}});
  document.body.append(messages);messages.style.display='block';
 },bytes.toString('base64'));
 const attachments=page.locator('#messages .message.user button');
 assert.equal(await attachments.count(),2,'only the two supported historical images are offered');
 const beforeAttachments=requests.length;
 await attachments.first().click();await attachments.first().click();
 await page.waitForFunction(()=>[...document.querySelectorAll('#messages .message.user img')].filter(i=>i.complete&&i.naturalWidth===4000).length===2);
 assert.equal(requests.length,beforeAttachments,'inline attachments need no file request');
 assert.match(await page.locator('#connection').textContent(),/已同步/);
 assert.deepEqual(errors,[]);console.log('PASS WebKit: formulas, history, partial stream, code/currency, image ownership, 320/390px layouts, stream reuse, version-pinned preview, blocked sources, invalid bytes, stale requests and plugin images');
}finally{await browser.close();server.closeAllConnections();server.close()}})().catch(e=>{console.error(e);server.closeAllConnections();server.close();process.exitCode=1});
