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
 const origin=`http://127.0.0.1:${server.address().port}`;
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(`${origin}/mobile/`);
 bytes=Buffer.from(await page.evaluate(()=>{const c=document.createElement('canvas');c.width=4000;c.height=600;c.getContext('2d').fillRect(0,0,4000,600);return c.toDataURL().split(',')[1]}),'base64');
 await page.evaluate(()=>{for(const e of document.body.children)e.style.display='none';globalThis.testRoot=document.createElement('article');testRoot.className='message reply';testRoot.style.cssText='margin:16px;max-width:100%';document.body.append(testRoot);device='d'.repeat(43);devices=[{id:device,name:'Fixture',online:true}];deviceListReady=true;session='abcdef';capabilities={artifacts:true,imageResources:true};});
 const formula=String.raw`\[
新目标仓位=原三均线目标仓位\times\min\left(1,\frac{3\%}{ATR_{14}/复权收盘价}\right)
\]`;
 const summaryTable=[
  '| 修复 | 结果 |',
  '| --- | --- |',
  '| [OpenRouter 模型目录](#openrouter) | 切换密钥后，旧密钥发出的首次目录请求即使晚到，也不会覆盖新目录。独立复测覆盖密钥撤销、双会话、关闭和请求失败后的恢复。 |',
  '| [COS 发布与续传](#cos) | 禁止用重建产物覆盖同版本安装包，避免上传中断后旧清单指向校验失败的文件。遇到冲突时停止。 |',
 ].join('\n');
 const columns=['OpenRouter','Conversation','Configuration','Synchronization','Compatibility','Verification'];
 const wideTable=`| ${columns.join(' | ')} |\n| ${columns.map(()=>'---').join(' | ')} |\n| ${columns.map(()=>'通过').join(' | ')} |`;
 for(const width of [320,390]){
  await page.setViewportSize({width,height:844});
  await page.evaluate(md=>renderMarkdown(testRoot,md),summaryTable);
  const summary=await page.evaluate(()=>{
   const table=testRoot.querySelector('table'),label=table.tBodies[0].rows[0].cells[0],link=label.querySelector('a');
   const word=document.createRange();word.setEnd(link.firstChild,'OpenRouter'.length);word.setStart(link.firstChild,0);
   return{labelWidth:label.getBoundingClientRect().width,wordFragments:word.getClientRects().length,
    overflow:table.scrollWidth-table.clientWidth,document:document.documentElement.scrollWidth,viewport:innerWidth};
  });
  assert(summary.labelWidth>=80&&summary.wordFragments===1&&summary.overflow<=1&&summary.document<=summary.viewport,JSON.stringify({width,summary}));
  await page.evaluate(md=>renderMarkdown(testRoot,md),wideTable);
  const wide=await page.evaluate(()=>{
   const table=testRoot.querySelector('table');table.scrollLeft=table.scrollWidth;
   return{scroll:table.scrollLeft,document:document.documentElement.scrollWidth,viewport:innerWidth};
  });
  assert(wide.scroll>0&&wide.document<=wide.viewport,JSON.stringify({width,wide}));
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
 // A long autolink must not collapse a neighboring lazy thumbnail to its short caption's width.
 for (const width of [320,390]) {
  await page.setViewportSize({width,height:844});
  const url='https://example.invalid/status?job='+'X'.repeat(240);
  const mixed=`| 状态 | 链接 | 预览 | Synchronization | Compatibility | Verification |\n|---|---|---|---|---|---|\n| 完成 | <${url}> | ![图](reports/mixed-${width}.png) | 通过 | 完成 | 最后一列 |`;
  await page.evaluate(md=>{
   testRoot.innerHTML='';renderMarkdown(testRoot,md);
   const table=testRoot.querySelector('table'),thumb=table.querySelector('.artifact-image');
   table.scrollLeft=thumb.getBoundingClientRect().left-table.getBoundingClientRect().left;
  },mixed);
  await page.waitForFunction(()=>testRoot.querySelector('table img')?.naturalWidth===4000,undefined,{timeout:3000});
  const mixedLayout=await page.evaluate(()=>{
   const table=testRoot.querySelector('table'),i=table.querySelector('img');
   const thumbnail=i.getBoundingClientRect().width;
   table.scrollLeft=table.scrollWidth;
   const right=table.tBodies[0].rows[0].cells[5].getBoundingClientRect().right;
   return{thumbnail,client:table.clientWidth,scroll:table.scrollLeft,right,tableRight:table.getBoundingClientRect().right,
    document:document.documentElement.scrollWidth,viewport:innerWidth,href:table.querySelector('a').href};
  });
  assert.equal(mixedLayout.href,url);
  assert(mixedLayout.thumbnail>=100&&mixedLayout.thumbnail<=mixedLayout.client&&mixedLayout.scroll>0&&
   mixedLayout.right<=mixedLayout.tableRight+1&&mixedLayout.document<=mixedLayout.viewport,JSON.stringify({width,mixedLayout}));
  const appended='\n| 待验证 | 后续 | 暂无 | 通过 | 完成 | 新行 |\n\n'+wideTable;
  const imageRequests=requests.length;
  await page.evaluate(({mixed,appended})=>{
   globalThis.mixedImage=testRoot.querySelector('img');
   reply={el:testRoot,text:mixed};
   frame({meta:{name:'agent:response-chunk'},payload:{blocks:[{type:'text',text:appended}]}});
  },{mixed,appended});
  await page.waitForFunction(()=>testRoot.querySelector('table tbody').rows.length===2);
  const streamed=await page.evaluate(()=>{
   const tables=testRoot.querySelectorAll('table');
   return{scroll:tables[0].scrollLeft,unrelated:tables[1].scrollLeft,reused:tables[0].querySelector('img')===mixedImage,
    document:document.documentElement.scrollWidth,viewport:innerWidth};
  });
  assert(Math.abs(streamed.scroll-mixedLayout.scroll)<=1&&streamed.unrelated===0&&streamed.reused&&
   streamed.document<=streamed.viewport,JSON.stringify({width,mixedLayout,streamed}));
  assert.equal(requests.length,imageRequests,'the existing thumbnail is not fetched again');
  const finished=await page.evaluate(()=>{
   finishReply();liveSegment=false;
   return testRoot.querySelector('table').scrollLeft;
  });
  assert(Math.abs(finished-mixedLayout.scroll)<=1,'the final reply redraw also keeps the position');
 }
 // Reused DOM containers must not transfer the position to another owner, epoch, or unrelated text.
 const resetTables=await page.evaluate(md=>{
  const scroll=()=>{const table=testRoot.querySelector('table');table.scrollLeft=table.scrollWidth;return table.scrollLeft};
  const left=()=>testRoot.querySelector('table').scrollLeft;
  renderMarkdown(testRoot,md);
  const original=scroll();
  renderMarkdown(testRoot,md,'fedcba');const owner=left();
  scroll();generation++;renderMarkdown(testRoot,md,'fedcba');const epoch=left();
  const changed=md.replace('通过','失败');
  scroll();renderMarkdown(testRoot,changed,'fedcba');const replacement=left();
  scroll();const fresh=testRoot.cloneNode(false);testRoot.after(fresh);
  renderMarkdown(fresh,changed,'fedcba');const newMessage=fresh.querySelector('table').scrollLeft;fresh.remove();
  return{original,owner,epoch,replacement,newMessage};
 },wideTable);
 const {original,...cleared}=resetTables;
 assert(original>0);
 assert.deepEqual(cleared,{owner:0,epoch:0,replacement:0,newMessage:0});
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
 assert.deepEqual(errors,[]);console.log('PASS WebKit: formulas, history, partial stream, code/currency, image ownership, 320/390px mixed wide tables and horizontal scroll retention, stream reuse, version-pinned preview, blocked sources, invalid bytes, stale requests and plugin images');
}finally{await browser.close();server.closeAllConnections();server.close()}})().catch(e=>{console.error(e);server.closeAllConnections();server.close();process.exitCode=1});
