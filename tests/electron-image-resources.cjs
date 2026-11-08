// Real Chromium: shared rendering plus actual desktop streaming and remote renderMarkdown.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const assert=require('node:assert/strict');const {once}=require('node:events');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-image-ui-'));
app.setPath('userData',profile);const timer=setTimeout(()=>app.exit(1),60000);
let server,win,bytes,hits=0,held=[],resourceRequests=[];
app.whenReady().then(async()=>{
 try{
 server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname.includes('/image-resources/') || u.pathname.endsWith('/image-resource') || u.pathname.endsWith('/nav_and_drawdown.png') || u.pathname.endsWith('/artifacts')){
   resourceRequests.push(u.pathname+u.search);hits++;res.setHeader('Content-Type','image/png');res.setHeader('Content-Disposition','attachment; filename="image.png"');res.setHeader('Content-Length',bytes.length);res.setHeader('Cache-Control','no-store');if(req.method==='HEAD')return res.end();
   if(u.searchParams.has('slow')){held.push(()=>res.end(bytes));return;}return res.end(bytes);
  }
  if(u.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/styles.css"><link rel="stylesheet" href="/css/image-resources.css"><link rel="stylesheet" href="/css/file-preview.css"><script src="/vendor/marked.min.js"></script><script src="/js/markdown-compat.js"></script><script src="/js/image-resources.js"></script><script src="/vendor/dompurify.min.js"></script><script src="/js/file-preview.js"></script><script src="/js/file-preview-renderers.js"></script><main id="test-root"></main></html>');}
  if(u.pathname.startsWith('/remote/api/')){res.writeHead(401,{'Content-Type':'application/json'});return res.end('{"error":"Test fixture"}');}
  const filename=u.pathname.startsWith('/remote/')?path.join(root,'remote/public',u.pathname.slice(8)||'index.html'):path.join(root,'web',u.pathname);
  if(!fs.existsSync(filename)||!fs.statSync(filename).isFile()){res.writeHead(404);return res.end();}
  const type={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'}[path.extname(filename)]||'application/octet-stream';res.setHeader('Content-Type',type);res.end(fs.readFileSync(filename));
 });server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 win=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 win.webContents.on('console-message',(_,level,message)=>{if(level>=2)console.error(message)});
 const js=code=>win.webContents.executeJavaScript(code).catch(e=>{console.error('Renderer expression:',code);throw e});await win.loadURL(base);
 await js("(async()=>{const html=await(await fetch('/index.html')).text();const doc=new DOMParser().parseFromString(html,'text/html');await Promise.all([...doc.querySelectorAll('link[rel=stylesheet]')].filter(l=>l.getAttribute('href').startsWith('/css/')).map(l=>new Promise(resolve=>{const link=document.createElement('link');link.rel='stylesheet';link.href=l.getAttribute('href');link.onload=link.onerror=resolve;document.head.append(link)})))})()");
 const data=await js(`(()=>{const c=document.createElement('canvas');c.width=1000;c.height=560;const x=c.getContext('2d');x.fillStyle='#eeeee7';x.fillRect(0,0,1000,560);x.fillStyle='#31362f';x.font='28px sans-serif';x.fillText('Project overview',58,72);x.strokeStyle='#c5c9be';x.lineWidth=1;for(let i=0;i<4;i++){x.beginPath();x.moveTo(60,150+i*90);x.lineTo(940,150+i*90);x.stroke()}x.strokeStyle='#70846c';x.lineWidth=5;x.beginPath();[[70,410],[230,360],[390,380],[550,240],[710,270],[930,140]].forEach(([a,b],i)=>i?x.lineTo(a,b):x.moveTo(a,b));x.stroke();return c.toDataURL('image/png').split(',')[1]})()`);bytes=Buffer.from(data,'base64');
 const ref='ashub-image:'+'a'.repeat(64)+'/1000x560',markdown=`进度与趋势\n\n![项目推进情况](${ref})\n\n关键节点已完成 验证结果持续更新`;
 await js(`(async()=>{globalThis.testRoot=document.getElementById('test-root');testRoot.style.cssText='max-width:760px;margin:30px auto;padding:24px;color:var(--text);font:16px/1.8 sans-serif';globalThis.replyModule=await import('/js/stream/reply.js');globalThis.sessionTest={id:'abcdef',isConnected:true,state:{replaying:false},scroll:{stickToBottom:false},reply:{current:testRoot,text:''}};replyModule.fillFinalReply(sessionTest,${JSON.stringify(markdown)});})()`);
 async function waitFor(code){for(let i=0;i<100;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,30));}console.error(await js('document.body.innerHTML'));throw Error('Timeout: '+code);}
 await waitFor("!!testRoot.querySelector('img')");assert.equal(hits,1);
 assert(await js("marked.parse('**执行：**5次').includes('<strong>执行：</strong>')"),'image renderer preserves CJK Markdown compatibility');
 await js("globalThis.firstImage=testRoot.querySelector('img');replyModule.appendReplyChunk(sessionTest,'\\n\\n继续更新');");await new Promise(r=>setTimeout(r,200));
 assert(await js("testRoot.querySelector('img')===firstImage"),'desktop stream must preserve decoded image');assert.equal(hits,1);
 // Same-paragraph growth and final correction must keep the decoded image.
 const oneImage=`![项目推进情况](${ref})`;
 await js(`replyModule.fillFinalReply(sessionTest,${JSON.stringify(oneImage)});`);
 await waitFor("!!testRoot.querySelector('img')");
 const stableHits=hits;
 await js("globalThis.stableImage=testRoot.querySelector('img');replyModule.appendReplyChunk(sessionTest,' 同段文字');");
 await waitFor("testRoot.textContent.includes('同段文字')");
 assert(await js("testRoot.querySelector('img')===stableImage"),'same-paragraph stream must preserve decoded image');
 assert.equal(hits,stableHits,'same-paragraph growth must not fetch again');
 await js(`replyModule.fillFinalReply(sessionTest,${JSON.stringify(oneImage+' 最终校正')});`);
 assert(await js("testRoot.querySelector('img')===stableImage"),'final correction must preserve decoded image');
 assert.equal(hits,stableHits);
 // Identical references in unchanged/changed blocks must not steal live nodes.
 await js(`replyModule.fillFinalReply(sessionTest,${JSON.stringify(oneImage+'\n\n'+oneImage+' tail')});`);
 await waitFor("testRoot.querySelectorAll('img').length===2");
 await js("globalThis.duplicateImages=[...testRoot.querySelectorAll('img')];replyModule.appendReplyChunk(sessionTest,' more');");
 await waitFor("testRoot.textContent.includes('tail more')");
 assert(await js("[...testRoot.querySelectorAll('img')].every((n,i)=>n===duplicateImages[i])"),'reuse must not move an unchanged duplicate image');
 const duplicateHits=hits;
 await js(`replyModule.fillFinalReply(sessionTest,${JSON.stringify(oneImage+'\n\n'+oneImage+' corrected')});`);
 assert(await js("[...testRoot.querySelectorAll('img')].every((n,i)=>n===duplicateImages[i])"));assert.equal(hits,duplicateHits);
 await js("testRoot.querySelector('.image-resource-surface').click()");await waitFor("!!document.querySelector('.artifact-preview-image')");await js("AsHubFilePreview.close()");await waitFor("!document.querySelector('dialog')");
 fs.writeFileSync('/tmp/ashub-images-desktop.png',(await win.webContents.capturePage()).toPNG());
 // The same image reference under another conversation must not reuse this scope's blob.
 const crossScopeHits=hits;
 await js(`globalThis.previousScopeImage=testRoot.querySelector('img');sessionTest.id='fedcba';replyModule.fillFinalReply(sessionTest,${JSON.stringify(oneImage+' another conversation')});`);
 await waitFor("!!testRoot.querySelector('img')");
 assert(await js("testRoot.querySelector('img')!==previousScopeImage"),'conversation scope must own its image state');
 assert.equal(hits,crossScopeHits+1,'another conversation must fetch its own resource');
 // Production reply containers, including constrained table/list layouts.
 const originalBytes=bytes;
 for(const size of [[1000,560],[4000,100],[100,4000]]){
  bytes=Buffer.from(await js(`(()=>{const c=document.createElement('canvas');c.width=${size[0]};c.height=${size[1]};c.getContext('2d').fillRect(0,0,c.width,c.height);return c.toDataURL('image/png').split(',')[1]})()`),'base64');
  const shapeRef='ashub-image:'+'b'.repeat(64)+'/'+size.join('x');
  for(const context of ['table','paragraph','list']){
   const md=context==='table'?`| Preview |\n| --- |\n| ![Figure](${shapeRef}) |`:context==='list'?`- ![Figure](${shapeRef})`:`![Figure](${shapeRef})`;
   await js(`testRoot.innerHTML='';testRoot.className='live-wrap';testRoot.style.cssText='width:280px;margin:20px;padding:0;';globalThis.fitReply=document.createElement('div');fitReply.className='agent-reply';var body=document.createElement('div');body.className='terminal-body session-stream';body.style.cssText='width:100%;min-width:0;padding:0;';body.append(fitReply);testRoot.append(body);sessionTest.reply.current=fitReply;replyModule.fillFinalReply(sessionTest,${JSON.stringify(md)});testRoot.scrollIntoView();`);
   await waitFor("!!fitReply.querySelector('img')");
   const geometry=await js(`(()=>{const r=testRoot.getBoundingClientRect(),s=fitReply.querySelector('.image-resource-surface').getBoundingClientRect(),i=fitReply.querySelector('img').getBoundingClientRect();return {root:r.width,surface:s.width,image:i.width,right:i.right-r.right,height:i.height,scroll:testRoot.scrollWidth}})()`);
   assert(geometry.right<=1 && geometry.surface<=geometry.root && geometry.image>0 && geometry.height>0, `bounded ${context} image ${size}: ${JSON.stringify(geometry)}`);
   const ratio=geometry.image/geometry.height;assert(Math.abs(ratio-size[0]/size[1])<=0.2,'thumbnail preserves image proportions');
  }
 }
 bytes=originalBytes;
 await js("sessionTest.reply.current=testRoot;testRoot.className='';testRoot.innerHTML='';");
 // Ordinary Markdown images bypass the optional display_images tool.
 // Reproduce the reported return curve (1870x1360) and its exact relative path.
 bytes=Buffer.from(await js(`(()=>{const c=document.createElement('canvas');c.width=1870;c.height=1360;c.getContext('2d').fillRect(0,0,c.width,c.height);return c.toDataURL('image/png').split(',')[1]})()`),'base64');
 const legacyPath='本地回测系统/experiments/market_ma5_v1/nav_and_drawdown.png';
 await js(`(async()=>{await import('/js/links.js');testRoot.innerHTML='';testRoot.className='live-wrap';testRoot.style.cssText='width:340px;margin:20px;padding:0';globalThis.legacyOwner=document.createElement('session-view');legacyOwner.setAttribute('session-id','fedcba');legacyOwner.style.cssText='width:100%;min-width:0';globalThis.legacyReply=document.createElement('div');legacyReply.className='agent-reply';var legacyBody=document.createElement('div');legacyBody.className='terminal-body session-stream';legacyBody.style.cssText='width:100%;min-width:0;padding:0';legacyBody.append(legacyReply);legacyOwner.append(legacyBody);testRoot.append(legacyOwner);sessionTest.reply.current=legacyReply;replyModule.fillFinalReply(sessionTest,${JSON.stringify(`![五均线组合净值与回撤](${legacyPath})`)});})()`);
 await waitFor("!!legacyReply.querySelector('img')?.naturalWidth");
 const legacyGeometry=await js(`(()=>{const r=testRoot.getBoundingClientRect(),i=legacyReply.querySelector('img').getBoundingClientRect();return{available:r.width,width:i.width,height:i.height,right:i.right-r.right}})()`);
 assert(legacyGeometry.width>0 && legacyGeometry.width<=legacyGeometry.available && legacyGeometry.right<=1,`ordinary Markdown image fits its reply: ${JSON.stringify(legacyGeometry)}`);
 assert(Math.abs(legacyGeometry.width/legacyGeometry.height-1870/1360)<0.02);
 assert.equal(await js("new URL(legacyReply.querySelector('img').src).pathname"),'/fedcba/artifacts','thumbnail URL must belong to its message session');
 await js("legacyReply.querySelector('img').click()");await waitFor("!!document.querySelector('dialog[open] .artifact-preview-image')");
 assert(resourceRequests.some(r=>r.startsWith('/fedcba/artifacts?') && new URL(r,'http://localhost').searchParams.get('path')===legacyPath),'legacy image uses its owning session, not the page URL');
 await js("AsHubFilePreview.close();legacyReply.querySelector('img').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));");await waitFor("!!document.querySelector('dialog[open] .artifact-preview-image')");
 await js("AsHubFilePreview.close();legacyOwner.remove();sessionTest.reply.current=testRoot;testRoot.className='';testRoot.innerHTML='';");bytes=originalBytes;
 // History replies are prepared in a detached fragment across replay frames.
 await js(`(async()=>{var shell=document.createElement('div');shell.hidden=true;var doc=new DOMParser().parseFromString(await(await fetch('/index.html')).text(),'text/html');shell.append(...[...doc.body.children].filter(n=>n.tagName!=='SCRIPT'));document.body.append(shell);await import('/js/session-view.js');globalThis.historyFragment=document.createDocumentFragment();globalThis.historyReply=document.createElement('div');historyReply.className='agent-reply';historyFragment.append(historyReply);sessionTest.reply.current=historyReply;sessionTest.state.replaying=true;replyModule.fillFinalReply(sessionTest,${JSON.stringify(markdown)});var transient=document.createElement('span');document.body.append(transient);transient.remove();})()`);
 await new Promise(r=>setTimeout(r,50));
 await js(`sessionTest.streamEl=testRoot;sessionTest._replayInsertToken=0;sessionTest._finishReplayInsert=()=>{};customElements.get('session-view').prototype._insertReplayFragmentChunked.call(sessionTest,historyFragment);testRoot.scrollIntoView();`);
 await waitFor("!!historyReply.querySelector('img')");
 assert(await js("historyReply.querySelector('img').naturalWidth>0"),'history image loads after replay fragment insertion');
 await js("sessionTest.reply.current=testRoot;testRoot.innerHTML='';");
 // Sanitization, same-origin enforcement, malformed refs, and no script execution.
 await js(`globalThis.guard=document.createElement('article');document.body.append(guard);guard.innerHTML=DOMPurify.sanitize(marked.parse('![bad](ashub-image:broken) ![x](javascript:alert(1))'));`);
 assert.equal(await js("guard.querySelectorAll('[data-image-ref],script,[onerror]').length"),0);
 await js(`globalThis.linked=document.createElement('article');document.body.append(linked);linked.innerHTML=DOMPurify.sanitize(marked.parse(${JSON.stringify(`[![linked](${ref})](https://example.invalid) `)}));globalThis.linkClicks=0;linked.querySelector('a').onclick=()=>linkClicks++;AsHubImageResources.hydrate(linked,{scope:'linked',current:()=>true,resolve:()=>'/abcdef/image-resources/${'a'.repeat(64)}',open(){}});linked.scrollIntoView();`);
 await waitFor("!!linked.querySelector('img')");await js("linked.querySelector('button').click()");assert.equal(await js('linkClicks'),0,'image preview click must not navigate its enclosing Markdown link');await js('linked.remove()');
 const before=hits;await js(`guard.innerHTML=DOMPurify.sanitize(marked.parse(${JSON.stringify(`![x](${ref})`)}));AsHubImageResources.hydrate(guard,{scope:'bad',current:()=>true,resolve:()=> 'https://example.invalid/p.png',open(){}});guard.scrollIntoView();`);
 await waitFor("guard.textContent.includes('重试')");assert.equal(hits,before);
 // Detached stale response must not replace the new conversation or keep a blob alive.
 await js(`guard.remove();globalThis.stale=document.createElement('article');document.body.append(stale);stale.innerHTML=DOMPurify.sanitize(marked.parse(${JSON.stringify(`![old](${ref})`)}));AsHubImageResources.hydrate(stale,{scope:'old',current:()=>true,resolve:()=>'/abcdef/image-resources/${'a'.repeat(64)}?slow=1',open(){}});stale.scrollIntoView();`);
 for(let i=0;i<100&&!held.length;i++)await new Promise(r=>setTimeout(r,20));assert(held.length);await js("stale.remove()");held.splice(0).forEach(done=>done());await new Promise(r=>setTimeout(r,100));assert.equal(await js("stale.querySelectorAll('img').length"),0);
 console.log('PASS desktop bounded landscape/panoramic/portrait images in replies, lists and tables; streaming, preview and scope isolation');
 if(fs.existsSync(path.join(root,'remote/public/app.js'))){
  await win.loadURL(base+'/remote/');win.setSize(390,844);
  await js(`for(const child of document.body.children)child.style.display='none';globalThis.testRoot=document.createElement('article');document.body.append(testRoot);testRoot.className='message reply';testRoot.style.cssText='margin:24px 16px;color:var(--text);font:16px/1.8 sans-serif';document.documentElement.dataset.theme='dark';device='${'d'.repeat(43)}';session='abcdef';capabilities={imageResources:true};renderMarkdown(testRoot,${JSON.stringify(markdown)});`);
  await waitFor("!!testRoot.querySelector('img')");const remoteHits=hits;
  await js(`globalThis.firstImage=testRoot.querySelector('img');renderMarkdown(testRoot,${JSON.stringify(markdown+'\n\n更多内容')});`);
  await new Promise(r=>setTimeout(r,100));assert(await js("testRoot.querySelector('img')===firstImage"));assert.equal(hits,remoteHits);
  for(const width of [320,390]){win.setSize(width,844);await new Promise(r=>setTimeout(r,50));assert(await js("document.documentElement.scrollWidth <= innerWidth"),'no mobile overflow');}
  // Project task output belongs to a member, not the selected coordinator.
  const memberHits=hits;
  await js(`testRoot.innerHTML='';renderMarkdown(testRoot,${JSON.stringify(markdown)},'fedcba');`);
  await waitFor("!!testRoot.querySelector('img')");assert.equal(hits,memberHits+1,'member output loads while the coordinator remains selected');
  await js("testRoot.querySelector('.image-resource-surface').click()");await waitFor("!!document.querySelector('.artifact-preview-image')");await js("AsHubFilePreview.close()");
  for(const size of [[4000,100],[100,4000]]){
   bytes=Buffer.from(await js(`(()=>{const c=document.createElement('canvas');c.width=${size[0]};c.height=${size[1]};c.getContext('2d').fillRect(0,0,c.width,c.height);return c.toDataURL('image/png').split(',')[1]})()`),'base64');
   const shapeRef='ashub-image:'+'c'.repeat(64)+'/'+size.join('x');
   for(const width of [320,390])for(const context of ['table','paragraph','list']){
    win.setSize(width,844);
    const md=context==='table'?`| Preview |\n| --- |\n| ![Figure](${shapeRef}) |`:context==='list'?`- ![Figure](${shapeRef})`:`![Figure](${shapeRef})`;
    await js(`testRoot.innerHTML='';renderMarkdown(testRoot,${JSON.stringify(md)});testRoot.scrollIntoView();`);await waitFor("!!testRoot.querySelector('img')");
    const g=await js(`(()=>{const r=testRoot.getBoundingClientRect(),i=testRoot.querySelector('img').getBoundingClientRect(),b=testRoot.querySelector('button').getBoundingClientRect();return{right:i.right-r.right,width:i.width,height:i.height,surface:b.width,available:r.width}})()`);
    assert(g.right<=1 && g.width>0 && g.height>0 && g.surface<=g.available,`mobile ${width} ${context} ${size}: ${JSON.stringify(g)}`);
    assert(Math.abs(g.width/g.height-size[0]/size[1])<=0.2,'mobile thumbnail preserves proportions');
   }
  }
  bytes=originalBytes;
  await js(`testRoot.innerHTML='';renderMarkdown(testRoot,${JSON.stringify(markdown)});`);await waitFor("!!testRoot.querySelector('img')");
  fs.writeFileSync('/tmp/ashub-images-mobile.png',(await win.webContents.capturePage()).toPNG());
  await js("testRoot.querySelector('.image-resource-surface').click()");await waitFor("!!document.querySelector('.artifact-preview-image')");
  assert(await js("!!document.querySelector('dialog[open]')"));console.log('PASS remote bounded panoramic/portrait images in replies, lists and tables at 320/390px; streaming reuse and inline preview');
 }
 }finally{win?.destroy();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));}
}).then(()=>finish(0),e=>{console.error(e);finish(1)});
function finish(code){clearTimeout(timer);app.exit(code)}
