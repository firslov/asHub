// Real Chromium DOM, synthetic user actions, isolated fixture server.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const {once}=require('node:events');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-host-approval-ui-'));
app.setPath('userData',profile);let win,server;const watchdog=setTimeout(()=>app.exit(1),30000);
app.whenReady().then(async()=>{
 try {
  const source=fs.readFileSync(path.join(root,'web/js/sse.js'),'utf8');const start=source.indexOf('  "permission:request"(p) {'),end=source.indexOf('\n  "permission:resolved"',start);
  const handler='({'+source.slice(start,end)+'})["permission:request"]';
  server=http.createServer((req,res)=>{
   let p=new URL(req.url,'http://localhost').pathname;
   if(p==='/desktop'){res.setHeader('Content-Type','text/html');return res.end('<link rel="stylesheet" href="/web/css/live.css"><style>body{margin:20px;background:#f3eddf;color:#4d463e;font:14px system-ui}.stream{max-width:720px;margin:auto}</style><div class="stream"></div>');}
   if(p==='/remote/')p='/remote/public/index.html';else if(p.startsWith('/remote/'))p=p.replace('/remote/','/remote/public/');
   const file=path.join(root,p);if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end('{}');}
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');res.end(fs.readFileSync(file));
  });server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadURL(base+'/desktop');
  const payload={requestId:'test-explicit',explicit:true,kind:'operation',title:'确认操作 / Confirm operations',durationMs:300000,expiresAt:Date.now()+300000,items:[{title:'创建对话 / Create conversation',fields:[{label:'名称 / Name',value:'文献审校'},{label:'模型 / Model',value:'deepseek-v4-flash@deepseek'},{label:'路径 / Directory',value:'/workspace/research/非常长的项目路径/'.repeat(6)},{label:'说明 / Instructions',value:'<img src=x onerror=alert(1)>\n核查引用与证据来源'}]}]};
  payload.items.push(
   {title:'修改对话 / Update conversation',fields:[{label:'对话 / Conversation',value:'审校成员 (aabbcc)'},{label:'思考 / Thinking',value:'high → max'},{label:'VPN',value:'继承全局 / Inherit global → 关闭 / Off'}]},
   {title:'移出项目 / Remove from project',fields:[{label:'影响 / Effect',value:'保留历史和原目录，放回会话列表'}]},
   {title:'归档对话 / Archive conversation',fields:[{label:'影响 / Effect',value:'移出项目并归档，保留历史，可从归档恢复'}]},
   {title:'永久删除对话 / Permanently delete conversation',fields:[{label:'影响 / Effect',value:'永久删除对话历史和上传附件，无法撤销；不删除工作目录文件'}]},
  );
  await win.webContents.executeJavaScript(`(async()=>{
   const {appendApprovalPreview}=await import('/web/js/approval-preview.js');
   const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   const t=s=>s,closeReply=()=>{},sessionLabel=()=>'',sendSystemNotification=()=>{},toast=()=>{};
   const insertStreamNode=(s,node)=>s.streamEl.appendChild(node);
   window.decisions=[];window.fetch=async(url,opts)=>{decisions.push(JSON.parse(opts.body));return{ok:true};};
   const session={id:'source',state:{replaying:false},streamEl:document.querySelector('.stream')};
   (${handler}).call(session,${JSON.stringify(payload)});
  })()`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.approve-all').length`),0);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.approval-items img').length`),0);
  for(const width of [1180,390,320]){
   win.setContentSize(width,850);await new Promise(r=>setTimeout(r,60));
   assert.equal(await win.webContents.executeJavaScript(`document.documentElement.scrollWidth>innerWidth`),false,`desktop overflow at ${width}`);
  }
  await win.webContents.executeJavaScript(`document.querySelector('.approve').click()`);
  const decision=await win.webContents.executeJavaScript('decisions');assert.equal(decision.length,1);assert.equal(decision[0].sessionWide,false);
  if (fs.existsSync(path.join(root,'remote/public/index.html'))) {
  await win.loadURL(base+'/remote/');
  await win.webContents.executeJavaScript(`user='fixture';device='desktop';session='source';$('auth').hidden=true;$('workspace').hidden=false;frame({meta:{name:'permission:request'},payload:${JSON.stringify(payload)}})`);
  for(const width of [390,320]){
   win.setContentSize(width,850);await new Promise(r=>setTimeout(r,60));
   assert.equal(await win.webContents.executeJavaScript(`document.documentElement.scrollWidth>innerWidth`),false,`mobile overflow at ${width}`);
  }
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.approval-items section').length`),5);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.approval-items img').length`),0);
  }
  console.log('PASS available desktop/mobile approval cards: explicit-only decision, escaped preview, 320/390/1180px layout');
 }catch(e){console.error(e);process.exitCode=1;}finally{win?.destroy();if(server)await new Promise(r=>server.close(r));clearTimeout(watchdog);fs.rmSync(profile,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
