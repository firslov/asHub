// Optional integration with official editor distributions, not shipped as app dependencies.
// ASHUB_EDITOR_FIXTURES=/tmp/editor-fixtures/node_modules electron tests/electron-browser-editors.cjs
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const electron=require('electron');const {app,BrowserWindow}=electron;
const {createBrowserPages}=require('../electron/browser-pages.cjs');
const vendor=process.env.ASHUB_EDITOR_FIXTURES;
if(!vendor)throw Error('Set ASHUB_EDITOR_FIXTURES to a node_modules directory containing codemirror@5, ace-builds and monaco-editor.');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-real-editors-'));app.setPath('userData',path.join(temp,'profile'));
const deadline=setTimeout(()=>app.exit(1),60000);
const origin='https://editors.example',id='actual-editors';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const init={
 codemirror:`<link rel="stylesheet" href="/vendor/codemirror/lib/codemirror.css"><script src="/vendor/codemirror/lib/codemirror.js"></script><textarea id="source"></textarea><script>window.editor=CodeMirror.fromTextArea(document.querySelector('#source'),{lineNumbers:true});window.ready=true;</script>`,
 ace:`<script src="/vendor/ace-builds/src-min-noconflict/ace.js"></script><div id="source" style="height:400px"></div><script>window.editor=ace.edit('source');window.ready=true;</script>`,
 monaco:`<script src="/vendor/monaco-editor/min/vs/loader.js"></script><div id="source" style="height:400px"></div><script>require.config({paths:{vs:'/vendor/monaco-editor/min/vs'}});require(['vs/editor/editor.main'],()=>{window.editor=monaco.editor.create(document.querySelector('#source'),{value:'initial',language:'plaintext',automaticLayout:true});window.ready=true;});</script>`,
};
app.whenReady().then(async()=>{
 let win,service;const abort=new AbortController();
 try{
  const session=electron.session.fromPartition('persist:ashub-browser-'+createHash('sha256').update(id+'\0'+origin).digest('hex'));
  session.protocol.handle('https',request=>{
   const url=new URL(request.url);
   if(url.pathname.startsWith('/vendor/')){
    const file=path.resolve(vendor,url.pathname.slice(8));
    if(!file.startsWith(path.resolve(vendor)+path.sep)||!fs.existsSync(file))return new Response('',{status:404});
    return new Response(fs.readFileSync(file),{headers:{'Content-Type':file.endsWith('.css')?'text/css':'text/javascript'}});
   }
   return new Response('<!doctype html><meta charset="utf-8">'+init[url.pathname.slice(1)],{headers:{'Content-Type':'text/html'}});
  });
  service=createBrowserPages({electron,resolvePublic:async()=>true});service.enable('test',abort.signal);
  let approvalAction=async()=>{};
  const pages=service.bind(id,'test',async()=>{await approvalAction();return true;},temp);
  win=new BrowserWindow({width:1000,height:800,show:true});await win.loadURL('about:blank');
  for(const kind of Object.keys(init)){
   await pages.run({op:'open',url:origin+'/'+kind});service.mount(win,id,{x:0,y:0,width:950,height:740});
   const guest=win.contentView.children[0].webContents;
   for(let i=0;i<150 && !await guest.executeJavaScript('window.ready === true');i++)await sleep(50);
   assert(await guest.executeJavaScript('window.ready === true'),kind+' loaded');
   await guest.executeJavaScript('editor.focus()');
   const snap=await pages.run({op:'observe'});
   const target=snap.items.find(row=>row.role==='textbox' && row.ref);
   assert(target,kind+': '+JSON.stringify(snap));
   const text='// actual '+kind+' 🧭\n'+'value = 42;\n'.repeat(600);
   const result=await pages.run({op:'write',ref:target.ref,value:text,editor:true});
   assert.equal(result.status,'verified',kind+': '+JSON.stringify(result));
   assert.equal(await guest.executeJavaScript('editor.getValue()'),text);
   const swap={codemirror:'editor.swapDoc(new CodeMirror.Doc(editor.getValue()))',ace:'editor.setSession(ace.createEditSession(editor.getValue()))',monaco:"editor.setModel(monaco.editor.createModel(editor.getValue(),'plaintext'))"};
   const renewed=await pages.run({op:'observe'});
   const fresh=renewed.items.find(row=>row.role==='textbox' && row.ref);
   approvalAction=()=>guest.executeJavaScript(swap[kind]+'; void 0');
   await assert.rejects(pages.run({op:'write',ref:fresh.ref,value:'must not write to replacement model',editor:true}),/changed|unavailable/i,kind+' model switch must invalidate approval');
   assert.equal(await guest.executeJavaScript('editor.getValue()'),text);
   approvalAction=async()=>{};
   console.log('PASS official '+kind+' '+require(path.join(vendor,{codemirror:'codemirror',ace:'ace-builds',monaco:'monaco-editor'}[kind],'package.json')).version+' long source write and readback');
  }
 }finally{abort.abort();service?.close();win?.destroy();clearTimeout(deadline);fs.rmSync(temp,{recursive:true,force:true});}
}).then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
