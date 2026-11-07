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
  const resolved='({'+source.slice(end,source.indexOf('\n  "permission:request-cleanup"',end))+'})["permission:resolved"]';
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
  payload.items.unshift({ title:'Browser', fields:[{label:'URL',value:'https://example.com/'+ 'long-segment/'.repeat(35)}, {label:'权限 / Access',value:'读取此站点的页面内容，按对话保留登录状态'}] });
  payload.items.push(
   {title:'修改对话 / Update conversation',fields:[{label:'对话 / Conversation',value:'审校成员 (aabbcc)'},{label:'思考 / Thinking',value:'high → max'},{label:'VPN',value:'继承全局 / Inherit global → 关闭 / Off'}]},
   {title:'移出项目 / Remove from project',fields:[{label:'影响 / Effect',value:'保留历史和原目录，放回会话列表'}]},
   {title:'归档对话 / Archive conversation',fields:[{label:'影响 / Effect',value:'移出项目并归档，保留历史，可从归档恢复'}]},
   {title:'永久删除对话 / Permanently delete conversation',fields:[{label:'影响 / Effect',value:'永久删除对话历史和上传附件，无法撤销；不删除工作目录文件'}]},
  );
  await win.webContents.executeJavaScript(`(async()=>{
   const {presentApproval,formatApprovalTime,showApprovalResult}=await import('/web/js/approval-labels.js');
   const {appendApprovalPreview}=await import('/web/js/approval-preview.js');
   const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
   const t=s=>s,closeReply=()=>{},sessionLabel=()=>'',sendSystemNotification=()=>{},toast=message=>window.notices.push(message);
   const insertStreamNode=(s,node)=>s.streamEl.appendChild(node);
   window.notices=[];window.decisions=[];window.fetch=async(url,opts)=>{decisions.push(JSON.parse(opts.body));return{ok:true,json:async()=>({ok:true})};};
   const session={id:'source',state:{replaying:false},streamEl:document.querySelector('.stream')};
   (${handler}).call(session,${JSON.stringify(payload)});
   window.showRequest = input => (${handler}).call(session, input);
   window.resolveRequest = input => (${resolved}).call(session, input);

  })()`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.approve-all').length`),0);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.approval-items img').length`),0);
  for(const width of [1180,390,320]){
   win.setContentSize(width,850);await new Promise(r=>setTimeout(r,60));
   assert.equal(await win.webContents.executeJavaScript(`document.documentElement.scrollWidth>innerWidth`),false,`desktop overflow at ${width}`);
  }
  assert(await win.webContents.executeJavaScript(`(()=>{
    const root=document.querySelector('.approval-items'),actions=document.querySelector('.permission-actions'),label=root.querySelector('dt');
    return root.getBoundingClientRect().bottom <= actions.getBoundingClientRect().top+1
      && label.getBoundingClientRect().left-root.getBoundingClientRect().left>=12;
  })()`),'preview precedes buttons and has consistent inset');
  await win.webContents.executeJavaScript(`document.querySelector('.approve').click()`);
  const decision=await win.webContents.executeJavaScript('decisions');assert.equal(decision.length,1);assert.equal(decision[0].sessionWide,false);
  const timed = {...payload,requestId:'expired-host',scope:'once',expiresAt:Date.now()-1};
  const daily = {...payload,requestId:'daily-host',scope:'daily7',sourceName:'工具 $& {origin}',browser:{action:'click',origin:'https://example.com'},
    items:[{title:'Browser',fields:[{label:'URL',value:'https://example.com/a'},{label:'目标地址 / Destination',value:'https://example.com/submit'},{label:'重复授权 / Schedule',value:'Same button once per day for seven days; closing revokes.'}]}]};
  await win.webContents.executeJavaScript(`showRequest(${JSON.stringify(timed)}); showRequest(${JSON.stringify(daily)})`);
  assert(await win.webContents.executeJavaScript(`document.querySelector('[data-request-id="expired-host"]').classList.contains('timeout')`),'expired request was still actionable');
  // The host may approve before its deadline but deliver the result after the local clock expires.
  await win.webContents.executeJavaScript(`resolveRequest({requestId:'expired-host',outcome:'approved'})`);
  assert(await win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('[data-request-id="expired-host"]');
    return c.classList.contains('allowed') && !c.classList.contains('timeout') && !c.querySelector('[data-i18n="permission.timed_out"]');})()`),
    'authoritative approval clears the local timeout');
  const late = {...daily,requestId:'late-client-ack'};
  await win.webContents.executeJavaScript(`window.oldFetch=window.fetch;
    window.fetch=()=>new Promise(resolve=>window.releaseDecision=()=>resolve({ok:true,json:async()=>({outcome:'approved'})}));
    showRequest(${JSON.stringify(late)});
    document.querySelector('[data-request-id="late-client-ack"] .approve').click();
    resolveRequest({requestId:'late-client-ack',outcome:'denied'});
    releaseDecision();window.fetch=oldFetch;true;`);
  assert(await win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('[data-request-id="late-client-ack"]');
    return c.classList.contains('blocked') && !c.classList.contains('allowed') && c.querySelectorAll('.permission-status').length===1;})()`),
    'late HTTP acknowledgement cannot replace a newer resolved outcome');
  const competing = {...daily,requestId:'competing-windows'};
  const clickConflict = () => win.webContents.executeJavaScript(`document.querySelector('[data-request-id="competing-windows"] .approve').click()`);
  await win.webContents.executeJavaScript(`window.errorFetch=status=>async()=>({ok:false,status,text:async()=>'permission expired or already handled'});
    window.fetch=errorFetch(503);showRequest(${JSON.stringify(competing)});true;`);
  await clickConflict();
  assert(await win.webContents.executeJavaScript(`!document.querySelector('[data-request-id="competing-windows"] .approve').disabled && notices.length===1`),'transient failure permits retry');
  await win.webContents.executeJavaScript(`window.fetch=errorFetch(409);true;`);
  await clickConflict();
  assert(await win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('[data-request-id="competing-windows"]');
    return c.classList.contains('decided') && c.querySelector('.approve').disabled && !c.classList.contains('allowed') &&
      !c.classList.contains('blocked') && c.querySelector('[data-i18n="permission.handled"]') && notices.length===1;})()`),
    'a 409 closes the competing window card without claiming an outcome');
  await win.webContents.executeJavaScript(`resolveRequest({requestId:'competing-windows',outcome:'approved'});window.fetch=()=>new Promise(resolve=>window.releaseFailure=()=>resolve({ok:false,status:503,text:async()=>'unavailable'}));
    showRequest(${JSON.stringify({...daily,requestId:'stale-failure'})});
    document.querySelector('[data-request-id="stale-failure"] .approve').click();
    resolveRequest({requestId:'stale-failure',outcome:'denied'});releaseFailure();window.fetch=oldFetch;true;`);
  assert(await win.webContents.executeJavaScript(`notices.length===1 && document.querySelector('[data-request-id="stale-failure"]').classList.contains('blocked') &&
    document.querySelector('[data-request-id="competing-windows"] [data-i18n="permission.granted"]')!==null`),
    'a stale failed response cannot report another error after the host resolves the request');
  const card = '[data-request-id="daily-host"]';
  assert(await win.webContents.executeJavaScript(`document.querySelector('${card} .permission-label').textContent.includes('工具 $& {origin}')`),'display the bound plugin name literally');
  assert(await win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('${card}'); return c.querySelector('.approve span').textContent.includes('7') &&
    !c.querySelector('details').open && [...c.querySelectorAll('dd')].some(n=>n.textContent.includes('/submit') && n.getClientRects().length)})()`));
  await win.webContents.executeJavaScript(`const c=document.querySelector('${card}');c.querySelector('summary').click();c.querySelector('.deny').click();c.querySelector('.deny').click()`);
  assert.deepEqual(await win.webContents.executeJavaScript('decisions.slice(1)'),[{requestId:'daily-host',outcome:'denied',sessionId:'source',sessionWide:false}]);
  await win.webContents.executeJavaScript(`showRequest({requestId:'acp-wide',expiresAt:Date.now()+30000,
    requiresDesktop:true,acpExtendedOption:'Always for this tool'});showRequest({requestId:'acp-once',expiresAt:Date.now()+30000,
    requiresDesktop:false,acpExtendedOption:null});`);
  assert(await win.webContents.executeJavaScript(`(()=>{
    const wide=document.querySelector('[data-request-id="acp-wide"]'),once=document.querySelector('[data-request-id="acp-once"]');
    return !wide.querySelector('.approve') && wide.querySelector('.approve-all span').textContent==='Always for this tool' &&
      !!once.querySelector('.approve') && !once.querySelector('.approve-all');
  })()`),'desktop only offers the scopes supported by the ACP agent');
  await win.webContents.executeJavaScript(`document.querySelector('[data-request-id="acp-wide"] .approve-all').click()`);
  assert.equal(await win.webContents.executeJavaScript('decisions.length'),2,'the wider ACP action requires confirmation');
  await win.webContents.executeJavaScript(`document.querySelector('[data-request-id="acp-wide"] .approve-all').click()`);
  assert.equal(await win.webContents.executeJavaScript('decisions.at(-1).sessionWide'),true);
  await win.webContents.executeJavaScript(`resolveRequest({requestId:'acp-wide',outcome:'unconfirmed'})`);
  assert(await win.webContents.executeJavaScript(`(()=>{const card=document.querySelector('[data-request-id="acp-wide"]');
    return card.querySelector('[data-i18n="permission.unconfirmed"]') && !card.classList.contains('blocked') &&
      !card.classList.contains('allowed') && card.querySelector('.deny').disabled;})()`),'unknown delivery has an explicit, terminal status');
  if (fs.existsSync(path.join(root,'remote/public/index.html'))) {
  await win.loadURL(base+'/remote/');
  await win.webContents.executeJavaScript(`user='fixture';device='desktop';session='source';$('auth').hidden=true;$('workspace').hidden=false;frame({meta:{name:'permission:request'},payload:${JSON.stringify(payload)}})`);
  for(const width of [390,320]){
   win.setContentSize(width,850);await new Promise(r=>setTimeout(r,60));
   assert.equal(await win.webContents.executeJavaScript(`document.documentElement.scrollWidth>innerWidth`),false,`mobile overflow at ${width}`);
  }
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.approval-items section').length`),6);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.approval-items img').length`),0);
  }
  console.log('PASS available desktop/mobile approval cards: explicit-only decision, escaped preview, 320/390/1180px layout');
 }catch(e){console.error(e);process.exitCode=1;}finally{win?.destroy();if(server)await new Promise(r=>server.close(r));clearTimeout(watchdog);fs.rmSync(profile,{recursive:true,force:true});app.exit(process.exitCode||0);}
});
