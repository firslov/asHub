const {app,BrowserWindow}=require('electron');
const {fixture,scenarios,reviewScenarios}=require('./file-preview-fixture.cjs');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'ashub-file-preview-')));
const timer=setTimeout(()=>app.exit(1),90000);
app.whenReady().then(async()=>{
 let server,win;
 try {
  const f=await fixture();server=f.server;
  win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  win.webContents.on('console-message',(_,level,msg)=>{if(level>=2)console.error(msg);});
  await win.loadURL(f.url);
  console.log(await win.webContents.executeJavaScript('('+scenarios.toString()+')()'));
  const reviewErrors = await win.webContents.executeJavaScript('('+reviewScenarios.toString()+')()');
  if(reviewErrors.length)throw Error(reviewErrors.join('\n'));
  win.setSize(390,844);
  await win.loadURL(f.url+'?remote=1');
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'");
  console.log(await win.webContents.executeJavaScript('('+scenarios.toString()+')()'));
  const mobileReview = await win.webContents.executeJavaScript('('+reviewScenarios.toString()+')()');
  if(mobileReview.length)throw Error(mobileReview.join('\n'));
  console.log('PASS preview keyboard isolation, Unicode search and fitted image zoom (desktop/mobile)');
  if(f.hits.some(([method,name])=>method==='GET' && name==='large.txt'))throw Error('large file was fetched');
  await win.webContents.executeJavaScript("AsHubFilePreview.open({url:'/artifact?path=report.md',name:'report.md',lang:'zh',pdfBase:'/vendor/pdfjs/'})");
  const image=await win.webContents.capturePage();fs.writeFileSync('/tmp/ashub-file-preview-mobile.png',image.toPNG());
  win.setSize(1200,850);
  await win.webContents.executeJavaScript("document.documentElement.dataset.theme='light';AsHubFilePreview.open({url:'/artifact?path=preview.pdf',name:'preview.pdf',lang:'en',pdfBase:'/vendor/pdfjs/'})");
  fs.writeFileSync('/tmp/ashub-file-preview-desktop.png',(await win.webContents.capturePage()).toPNG());
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'ESC'});
  await new Promise(resolve=>setTimeout(resolve,60));
  const escape = await win.webContents.executeJavaScript("({open:!!document.querySelector('.artifact-preview'),effects:shortcutEffects})");
  if(escape.open || escape.effects.length)throw Error('Native Escape must close only the preview: '+JSON.stringify(escape));
  console.log('PASS native Escape closes preview without interrupting the conversation');
  const popups=[];
  win.webContents.setWindowOpenHandler(({url})=>{popups.push(url);return {action:'deny'};});
  await win.webContents.executeJavaScript("globalThis.externalLinks=[];AsHubFilePreview.open({url:'/artifact?path=report.md',name:'report.md',openExternal:url=>externalLinks.push(url)})");
  const point=await win.webContents.executeJavaScript(`(()=>{const a=document.querySelector('a[href="https://example.invalid/docs"]');a.scrollIntoView();const r=a.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({type:'mouseDown',button:'middle',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'middle',clickCount:1,...point});
  await new Promise(resolve=>setTimeout(resolve,100));
  const externalLinks=await win.webContents.executeJavaScript('externalLinks');
  if(popups.length || externalLinks.length!==1 || externalLinks[0]!=='https://example.invalid/docs')throw Error('Middle-click must use the system browser without an Electron child window: '+JSON.stringify({popups,externalLinks}));
  console.log('PASS native middle-click uses external browser adapter without child windows');

  clearTimeout(timer);win.destroy();server.close();app.exit(0);
 } catch(e) {console.error(e);win?.destroy();server?.close();app.exit(1);}
});
