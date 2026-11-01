const http=require('node:http'), fs=require('node:fs'), path=require('node:path');
const root=path.resolve(__dirname,'..');
function pdfFixture(width=300,height=180,pages=1) {
 const content='BT /F1 20 Tf 30 100 Td (asHub PDF preview) Tj ET';
 const bodies=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
 const kids=['3 0 R'];for(let i=1;i<pages;i++){kids.push(`${bodies.length+1} 0 R`);bodies.push(bodies[2]);}
 bodies[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
 let out='%PDF-1.4\n', offsets=[0]; for(let i=0;i<bodies.length;i++){offsets.push(Buffer.byteLength(out));out+=`${i+1} 0 obj\n${bodies[i]}\nendobj\n`;}
 const xref=Buffer.byteLength(out);out+=`xref\n0 ${bodies.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${bodies.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(out);
}
function wideBitmap() {
 const width=2000,height=16,stride=width*3;
 const data=Buffer.alloc(54+stride*height,220);
 data.fill(0,0,54);data.write('BM');data.writeUInt32LE(data.length,2);data.writeUInt32LE(54,10);data.writeUInt32LE(40,14);
 data.writeInt32LE(width,18);data.writeInt32LE(height,22);data.writeUInt16LE(1,26);data.writeUInt16LE(24,28);return data;
}
async function fixture() {
 const hits=[];
 const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/') {
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self'; img-src 'self' blob:; connect-src 'self'");
   res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${u.searchParams.has('remote') ? '/remote-style.css' : '/css/styles.css'}"><link rel="stylesheet" href="/css/file-preview.css"><script src="/vendor/marked.min.js"></script><script src="/vendor/dompurify.min.js"></script><script src="/js/file-preview.js"></script><script src="/js/file-preview-renderers.js"></script><button id="original">Conversation</button></html>`);return;
  }
  if(u.pathname==='/remote-style.css') {res.setHeader('Content-Type','text/css');res.end(fs.readFileSync(path.join(root,fs.existsSync(path.join(root,'remote/public/style.css'))?'remote/public/style.css':'web/css/styles.css')));return;}
  if(u.pathname==='/host-shortcuts.js') {
   const client=fs.readFileSync(path.join(root,'web/js/client.js'),'utf8');
   res.setHeader('Content-Type','text/javascript');
   res.end(`globalThis.shortcutEffects=[];const cancelTurn=()=>shortcutEffects.push('cancel');const closeTab=()=>shortcutEffects.push('close');const activeSessionId={value:'aaaaaa'};`+client.slice(client.indexOf('document.addEventListener("keydown"')));return;
  }
  if(u.pathname==='/artifact') {
   const name=u.searchParams.get('path');hits.push([req.method,name]);
   let bytes=Buffer.from(name==='report.md'?'# 工作成果\n\n**预览成功**\n\n<script>window.PWNED=true</script>\n\n[unsafe](javascript:alert(1))\n\n![network](https://example.invalid/track)\n\n[local](../../private.txt)\n\n[source](https://example.invalid/docs)':name==='evil.svg'?'<svg onload="window.PWNED=true"></svg>':name==='empty.txt'?'':'alpha\n中文文本\nalpha\n');
   if(name==='preview.pdf')bytes=pdfFixture();
   if(name==='multipage.pdf')bytes=pdfFixture(612,1600,2);
   if(name==='emoji.txt')bytes=Buffer.from('😀 first 😀 second');
   if(name==='letter.pdf')bytes=pdfFixture(612,792);
   if(name==='plot.png')bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=','base64');
   if(name==='wide.bmp')bytes=wideBitmap();
   if(name==='unicode.txt')bytes=Buffer.from('İ ALPHA [value]');
   if(name==='bad.png')bytes=Buffer.from('not an image');
   const send=()=>{
    if(name==='missing.txt'){res.writeHead(404);res.end();return;}
    if(u.searchParams.has('version') && u.searchParams.get('version')!=='v1'){res.writeHead(409);res.end();return;}
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="file"','Content-Length':name==='large.txt'?9000000:bytes.length,'X-Artifact-Version':'v1'});
    res.end(req.method==='HEAD'?undefined:bytes);
   };
   if(name==='slow.txt')setTimeout(send,150);else send();return;
  }
  const file=path.resolve(root,'web','.'+u.pathname);
  if(!file.startsWith(path.join(root,'web')+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  const mime={'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm'}[path.extname(file)]||'application/octet-stream';
  res.setHeader('Content-Type',mime);fs.createReadStream(file).pipe(res);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return {server,hits,url:`http://127.0.0.1:${server.address().port}`};
}
async function scenarios() {
 const assert=(ok,msg)=>{if(!ok)throw Error(msg);};
 const api=globalThis.AsHubFilePreview;
 const open=name=>api.open({url:'/artifact?path='+encodeURIComponent(name),name,lang:'zh',pdfBase:'/vendor/pdfjs/',nativeAction:async action=>{globalThis.lastNativeAction=action;}});
 const dialog=()=>document.querySelector('.artifact-preview');
 const text=()=>dialog().innerText;
 const press=label=>{const b=[...dialog().querySelectorAll('button')].find(b=>b.textContent===label);assert(b,'missing action '+label);b.click();};
 await open('report.md');assert(dialog().querySelector('h1').textContent==='工作成果','Markdown rendered');
 assert(!globalThis.PWNED && !dialog().querySelector('script,article img'),'Markdown inert');
 assert(getComputedStyle(dialog().querySelector('article p')).fontSize==='15px','reading typography independent of surrounding dialog styles');
 assert(!dialog().querySelector('a[href^="javascript:"]'),'No script links');
 press('默认应用打开');await Promise.resolve();assert(globalThis.lastNativeAction==='open','native open action');
 press('在文件夹中显示');await Promise.resolve();assert(globalThis.lastNativeAction==='reveal','native reveal action');
 assert(dialog().getBoundingClientRect().right<=innerWidth+1,'preview fits viewport');
 await open('notes.txt');const search=dialog().querySelector('input');search.value='中文';search.dispatchEvent(new Event('input'));assert(dialog().querySelector('mark').textContent==='中文','text search');
 await open('empty.txt');assert(dialog().querySelector('pre').textContent==='','empty text');
 await open('evil.svg');assert(dialog().querySelector('pre').textContent.startsWith('<svg'),'SVG displayed as text');assert(!globalThis.PWNED,'SVG inert');
 await open('plot.png');assert(dialog().querySelector('img').naturalWidth===1,'image decoded');press('放大');assert(dialog().querySelector('img').style.maxWidth==='none','image zoom');
 await open('preview.pdf');const canvas=dialog().querySelector('canvas');assert(canvas && canvas.width>0,'PDF canvas rendered');
 const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
 assert(dialog().querySelector('.artifact-preview-status').hidden,'PDF render must not report an error');
 assert(pixels.some((v,i)=>i%4===0 && v<180 && pixels[i+3]===255),'PDF opaque text pixels present');
 press('放大'); press('缩小');
 for(let i=0;i<100 && dialog().querySelector('button:disabled');i++) await new Promise(resolve=>setTimeout(resolve,10));
 assert(dialog().querySelector('.artifact-preview-status').hidden,'fast PDF zoom should not show cancellation as an error');
 await open('report.docx');assert(text().includes('暂不支持'),'Office fallback');assert(text().includes('默认应用打开'),'Office opens original');
 await open('large.txt');assert(text().includes('文件较大'),'bounded preview');
 await open('missing.txt');assert(text().includes('文件无法读取'),'missing handled');
 await open('bad.png');assert(!dialog().querySelector('img'),'invalid image is not inserted');
 const stale=open('slow.txt');await open('notes.txt');await stale;assert(dialog().querySelector('strong').textContent==='notes.txt','stale preview cannot replace current');
 const pending=open('slow.txt');api.close();await pending;assert(!dialog(),'close cancels pending read');
 const unregister=api.register('test',{accept:n=>n==='custom.zz',limit:1024,render:c=>c.body.append(c.element('p','','Custom renderer'))});
 await open('custom.zz');assert(text().includes('Custom renderer'),'extension renderer');unregister();
 await open('custom.zz');assert(text().includes('暂不支持'),'unregister renderer');
 api.close();return 'PASS preview rendering, PDF pixels, inert markup, original-file actions, bounds, cancellation, registry';
}
async function reviewScenarios() {
 const errors=[];const check=(ok,message)=>{if(!ok)errors.push(message);};
 const api=AsHubFilePreview;
 const open=name=>api.open({url:'/artifact?path='+name,name,lang:'zh',pdfBase:'/vendor/pdfjs/'});
 const d=()=>document.querySelector('.artifact-preview');
 const press=label=>[...d().querySelectorAll('button')].find(b=>b.textContent===label).click();
 if(!globalThis.shortcutEffects)await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/host-shortcuts.js';script.onload=resolve;script.onerror=reject;document.head.append(script);});
 await open('notes.txt');shortcutEffects.length=0;
 d().querySelector('button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
 check(!shortcutEffects.includes('cancel'),'Escape in preview must not cancel a running conversation');api.close();
 await open('notes.txt');shortcutEffects.length=0;
 d().querySelector('button').dispatchEvent(new KeyboardEvent('keydown',{key:'w',ctrlKey:true,bubbles:true,cancelable:true}));
 check(!shortcutEffects.includes('close'),'Preview shortcuts must not close the conversation');
 const search=d().querySelector('input');search.value='中文';search.dispatchEvent(new Event('input'));check(!!d().querySelector('mark'),'Search must find Chinese text');
 search.value='';search.dispatchEvent(new Event('input'));check(!d().querySelector('mark'),'Clearing search must remove stale highlight');
 await open('unicode.txt');const unicode=d().querySelector('input');unicode.value='alpha';unicode.dispatchEvent(new Event('input'));
 check(d().querySelector('mark')?.textContent==='ALPHA','Case-insensitive search must preserve original Unicode offsets');
 unicode.value='[value]';unicode.dispatchEvent(new Event('input'));check(d().querySelector('mark')?.textContent==='[value]','Search metacharacters must be literal');
 await open('wide.bmp');const img=d().querySelector('img');const fit=img.getBoundingClientRect().width;
 press('缩小');const smaller=img.getBoundingClientRect().width;
 check(smaller<fit,'Zoom out from fit must shrink a large image');
 press('放大');const restored=img.getBoundingClientRect().width;check(Math.abs(restored-fit)<2,'Inverse zoom steps must return to fitted size');
 press('适应窗口');check(Math.abs(img.getBoundingClientRect().width-fit)<2,'Fit must restore viewport-sized image');
 await open('letter.pdf');const body=d().querySelector('.artifact-preview-body');
 check(body.scrollWidth<=body.clientWidth+1,'Fitted PDF must not overflow the available reading width');
 await open('emoji.txt');const emoji=d().querySelector('input');emoji.value='😀';emoji.dispatchEvent(new Event('input'));
 const first=d().querySelector('pre').firstChild.textContent.length;
 emoji.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 check(d().querySelector('pre').firstChild.textContent.length>first,'Find next must advance beyond a supplementary Unicode character');
 emoji.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
 check(d().querySelector('pre').firstChild.textContent.length===first,'Emoji search must wrap to the first result');
 await open('multipage.pdf');const pagedBody=d().querySelector('.artifact-preview-body');pagedBody.scrollTop=pagedBody.scrollHeight;
 check(pagedBody.scrollTop>0,'Multi-page fixture must be vertically scrollable');
 press('下一页');
 for(let i=0;i<200 && d().querySelector('button:disabled');i++)await new Promise(resolve=>setTimeout(resolve,10));
 check(pagedBody.scrollTop===0,'PDF page navigation must start at the top of the new page');
 pagedBody.scrollTop=120;press('放大');
 for(let i=0;i<200 && d().querySelector('button:disabled');i++)await new Promise(resolve=>setTimeout(resolve,10));
 check(pagedBody.scrollTop>0,'Zoom on the same PDF page must preserve reading position');
 press('上一页');
 for(let i=0;i<200 && d().querySelector('button:disabled');i++)await new Promise(resolve=>setTimeout(resolve,10));
 check(pagedBody.scrollTop===0,'Previous PDF page must also open at the beginning');
 const external=[];
 const linkOptions={url:'/artifact?path=report.md',name:'report.md',lang:'zh'};
 await api.open({...linkOptions,openExternal:async url=>{external.push(url);}});
 // Cancel defaults in the test only, after the preview's handler has run.
 // This observes routing without opening any actual external page.
 let routed=false;
 d().addEventListener('click',e=>{if(e.target.closest('a')){routed=e.defaultPrevented;e.preventDefault();}});
 d().querySelector('a[href="https://example.invalid/docs"]').click();await Promise.resolve();
 check(routed && external[0]==='https://example.invalid/docs','Preview links must use the desktop external-browser adapter and prevent child windows');
 let middleRouted=false;
 d().addEventListener('auxclick',e=>{middleRouted=e.defaultPrevented;e.preventDefault();});
 const source=d().querySelector('a[href="https://example.invalid/docs"]');
 source.dispatchEvent(new MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}));await Promise.resolve();
 check(middleRouted && external.length===2,'Middle-click must route through the desktop adapter');
 source.dispatchEvent(new MouseEvent('auxclick',{button:2,bubbles:true,cancelable:true}));await Promise.resolve();
 check(!middleRouted && external.length===2,'Right-click must retain the context menu without opening a link');
 let downloaded=false;
 d().addEventListener('click',e=>{if(e.target.matches('a[download]')){downloaded=true;e.preventDefault();}},true);
 press('下载副本');await Promise.resolve();
 check(downloaded && external.length===2,'Downloads must not be routed to the external-browser adapter');
 await api.open({...linkOptions,openExternal:async()=>{throw Error('Browser unavailable');}});
 d().addEventListener('click',e=>{if(e.target.closest('a'))e.preventDefault();});
 d().querySelector('a[href="https://example.invalid/docs"]').click();
 await new Promise(resolve=>setTimeout(resolve,0));
 check(d().querySelector('.artifact-preview-status').textContent==='Browser unavailable','External-browser failures must be reported without losing the preview');
 await api.open(linkOptions);
 let browserDefault=false;
 d().addEventListener('click',e=>{if(e.target.closest('a')){browserDefault=!e.defaultPrevented;e.preventDefault();}});
 d().querySelector('a[href="https://example.invalid/docs"]').click();
 check(browserDefault,'Web previews must retain browser link navigation without a desktop adapter');
 let middleDefault=false;
 d().addEventListener('auxclick',e=>{middleDefault=!e.defaultPrevented;e.preventDefault();});
 d().querySelector('a[href="https://example.invalid/docs"]').dispatchEvent(new MouseEvent('auxclick',{button:1,bubbles:true,cancelable:true}));
 check(middleDefault,'Web previews must retain browser middle-click navigation');

 let sharedURL;
 await api.open({url:'/artifact?path=notes.txt',name:'notes.txt',lang:'zh',share:url=>{sharedURL=url;}});
 press('存储或分享');await Promise.resolve();
 check(sharedURL && new URL(sharedURL).searchParams.get('version')==='v1','Sharing must carry the exact preview file version');
 api.close();shortcutEffects.length=0;document.getElementById('original').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 check(shortcutEffects.includes('cancel'),'Conversation shortcuts must still work outside preview');shortcutEffects.length=0;return errors;
}
module.exports={fixture,scenarios,reviewScenarios};
