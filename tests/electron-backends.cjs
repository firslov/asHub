const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-backends-ui-'));
app.setPath('userData',profile);const deadline=setTimeout(()=>app.exit(1),90000);
app.whenReady().then(async()=>{
 let server,windows=[];const controller=new AbortController(),streams=new Map(),streamEnds=new Map(),requests=[],opened=[],receipts=new Map();let sessionDelay=null,holdReceipt=false,releaseReceipt,heldReceiptId,submissionRevoked=false,deletedB=false,removed=false,online=true,queue=[{id:'queue-message-000001',query:'排队消息',revision:1}],queueDelay=null,modelDelay=null,submits=0;
 let releaseProjects, assistantShared=true, entriesUnavailable=false, entriesDelay=null;
 let projectGate=new Promise(resolve=>releaseProjects=resolve);
 const assistantEntries=[
   {pluginId:'assistant-plugin',key:'assistant',resource:'assistant',sessionId:'cdef',label:'个人助手'},
   {pluginId:'assistant-plugin',key:'duplicate',resource:'assistant',sessionId:'cdef',label:'重复助手'},
   {pluginId:'assistant-plugin',key:'unshared',resource:'assistant',sessionId:'defa',label:'未共享助手'},
 ];
 try{
  const {BackendConnections}=await import('../dist/extensions/backends.js');const registry=new BackendConnections({signal:controller.signal,open:id=>opened.push(id)});
  const frame=(name,payload={})=>({meta:{name},payload});
  const history=[frame('agent:info',{model:'deepseek-v4',provider:'deepseek'}),frame('agent:query',{query:'请查看结果'}),frame('agent:processing-start'),frame('agent:thinking',{text:'**分析结果**'}),frame('agent:tool-started',{toolCallId:'old',name:'read_file',input:{path:'report.md'}}),frame('agent:tool-completed',{toolCallId:'old',text:'done'}),frame('agent:response-chunk',{blocks:[{type:'text',text:'结果已就绪。公式：$x^2$'}]}),frame('agent:response-chunk',{blocks:[{type:'text',text:'\n\n![图片](chart.png)\n\n[报告](report.md)\n\n<img src="https://tracking.invalid/pixel" srcset="https://tracking.invalid/pixel2 2x">'}]}),frame('agent:response-segment',{text:'结果已就绪。公式：$x^2$\n\n![图片](chart.png)\n\n[报告](report.md)\n\n<img src="https://tracking.invalid/pixel" srcset="https://tracking.invalid/pixel2 2x">'}),frame('agent:processing-done'),frame('hub:replay-done')];
  const bind=key=>registry.bind('plugin',controller.signal).register(key,{label:key==='one'?'办公室 Mac':'工作站',online:()=>online,request:async(op,args)=>{
   requests.push({key,op,args});if(op==='sessions'){
    if(sessionDelay){const held=sessionDelay;sessionDelay=null;return held;}
    const rows=[{instanceId:'abcd',title:'项目主控'},{instanceId:'bcde',title:'技术审查'}].filter(s=>(!removed||s.instanceId!=='abcd')&&(!deletedB||s.instanceId!=='bcde'));
    if(key==='two'||assistantShared)rows.push({instanceId:'cdef',title:key==='one'?'工作助理重新命名':'个人助手',...(key==='one'?{projectId:'project'}:{})});
    return rows;
   }
   if(op==='capabilities')return {composerInputs:true,projects:true,queue:true,queueActions:true,steering:true,thinking:true,sessionNetwork:true,sessionDelete:true,pluginResources:key==='one'};
   if(op==='project-groups'){
    if(key==='one'&&projectGate)await projectGate;
    return [{id:'project',name:'设计项目',sessionIds:key==='one'?['abcd','bcde','cdef']:['abcd','bcde'],pinnedSessionIds:['abcd']}];
   }
   if(op==='queue'){if(queueDelay){const delay=queueDelay;queueDelay=null;return delay;}return queue;}
   if(op==='queue-withdraw'){queue=[];return {query:'排队消息'};}
   if(op==='queue-update'){assert(['edit','promote'].includes(args.action));queue=queue.map(m=>({...m,query:args.query??m.query,delivery:args.action==='promote'?'steer':'queue',revision:m.revision+1}));return queue[0];}
   if(op==='models'){if(modelDelay){const d=modelDelay;modelDelay=null;return d;}return {providers:[{name:'deepseek',models:[{id:'deepseek-v4'}]}]};}
   if(op==='model')return {model:args.model,provider:args.provider};
   if(op==='thinking')return {model:'deepseek-v4',provider:'deepseek',supported:true,level:'high',levels:['low','high']};
   if(op==='set-thinking')return {level:args.level};
   if(op==='submit'){if(submissionRevoked)throw Object.assign(Error('会话授权已失效'),{status:403});if(!receipts.has(args.requestId)){submits++;receipts.set(args.requestId,{state:args.query==='new receipt'?'pending':'done',result:{ok:true}});}if(submits===1&&!receipts.get(args.requestId).dropped){receipts.get(args.requestId).dropped=true;throw Object.assign(Error('response lost'),{status:504});}return receipts.get(args.requestId);}
   if(op==='composer-input'){
    if(args.action==='list')return [{id:'a'.repeat(32),revision:'v1',label:'语音输入',kind:'audio',maxBytes:4194304,maxDuration:60}];
    return {state:'done',text:'测试转写'};
   }
   if(op==='session-delete'){assert.equal(args.session,'bcde');deletedB=true;return {state:'done'};}
   if(op==='request-status'){if(holdReceipt){holdReceipt=false;heldReceiptId=args.requestId;return new Promise(r=>releaseReceipt=r);}return receipts.get(args.requestId)||{state:'missing'};}
   if(op==='session-network')return {enabled:null,effective:true};
   if(op==='plugin-entries'){
    if(entriesDelay){const held=entriesDelay;entriesDelay=null;return held;}
    if(entriesUnavailable)throw Object.assign(Error('plugin entries unavailable'),{status:503});
    return assistantEntries;
   }
   return {ok:true};
  },subscribe:async(sid,emit,signal)=>{const keyId=key+':'+sid;streams.set(keyId,emit);history.forEach(emit);await new Promise(r=>{streamEnds.set(keyId,r);signal.addEventListener('abort',r,{once:true});});if(streams.get(keyId)===emit){streams.delete(keyId);streamEnds.delete(keyId);}},resource:async args=>{const data=args.path?.endsWith('.png')?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1f8AAAAASUVORK5CYII=','base64'):Buffer.from('# 测试报告\n已生成。');return {data:args.method==='HEAD'?new Uint8Array():data,size:data.length,type:'application/octet-stream',version:'v1'};}});
  const a=bind('one'),b=bind('two');
  const {connectionResource}=await import('../examples/extensions/multi-machine/app.mjs');
  const device='A'.repeat(43),account={cookie:'fixture',records:new Map([[device,{device:{name:'办公室 Mac',online:true}}]]),refresh:async()=>{},openDevice:async id=>{assert.equal(id,device);await a.open();}};
  const entryResource=connectionResource(account);
  server=http.createServer(async(req,res)=>{
   if(req.url==='/fixture-remote-resource.js'){res.setHeader('Content-Type','application/javascript');res.end(fs.readFileSync(path.join(root,'remote/public/plugin-resource-view.js')));return;}
   if(req.url==='/fixture-connections'){
    let view;if(req.method==='POST'){let text='';for await(const c of req)text+=c;const body=JSON.parse(text);view=await(await entryResource.prepare(body.action,body.values)).execute();}else view=entryResource.view();
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({view}));return;
   }
   if(await registry.handle(req,res,async req=>{let text='';for await(const c of req)text+=c;return text;}))return;
   const file=path.join(root,'web',decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(!file.startsWith(path.join(root,'web')+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
   const type={'.js':'application/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf'}[path.extname(file)]||'application/octet-stream';res.setHeader('Content-Type',type);fs.createReadStream(file).pipe(res);
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
  const errors=[],external=[];async function make(id){const win=new BrowserWindow({show:true,width:1180,height:820,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});windows.push(win);win.webContents.on('console-message',(_e,level,msg)=>{if(level>=3)errors.push(msg);});win.webContents.session.webRequest.onBeforeRequest({urls:['https://tracking.invalid/*']},(d,cb)=>{external.push(d.url);cb({cancel:true})});await win.loadURL(url+'/backend.html?connection='+id);return win;}
  const win=await make(a.id),js=code=>win.webContents.executeJavaScript(code);
  const wait=async(condition,exec=js)=>{for(let i=0;i<150;i++){if(await exec(condition))return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out: '+condition);};
  const click=text=>js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b)throw Error('Button missing: '+${JSON.stringify(text)});b.click()})()`);
  const assistantRow='#sessions .bw-dedicated-session';
  await wait(`document.querySelector(${JSON.stringify(assistantRow)})?.textContent==='个人助手'`);
  assert.equal(await js("document.querySelector('#sessions h3')?.textContent"),'独立对话','slow project metadata does not gate the assistant');
  assert.equal(await js("document.querySelector('#sessions').firstElementChild.dataset.sessionId"),'cdef');
  assert.equal(await js("document.querySelectorAll('[data-session-id=cdef]').length"),1);
  assert.equal(await js("document.querySelector('[data-session-id=defa]')"),null);
  await click('个人助手');await wait("!document.querySelector('#send').disabled");
  assert.equal(await js("document.querySelector('#title').textContent"),'工作助理重新命名');
  assert.equal(await js("document.querySelector('[data-session-id=cdef]').getAttribute('aria-current')"),'page');
  await js("document.querySelector('#query').value='个人助手的草稿';document.querySelector('#query').dispatchEvent(new Event('input'))");
  projectGate=null;releaseProjects();await wait("document.querySelector('#sessions h3')?.textContent==='设计项目'");
  assert.equal(await js("document.querySelectorAll('[data-session-id=cdef]').length"),1,'the project must not duplicate the assistant');
  await js("document.querySelector('#search').value='重新命名';document.querySelector('#search').dispatchEvent(new Event('input'))");
  assert.deepEqual(await js("[...document.querySelectorAll('#sessions button')].map(button=>button.textContent)"),['个人助手']);
  await js("document.querySelector('#search').value='个人助手';document.querySelector('#search').dispatchEvent(new Event('input'))");
  assert.equal(await js("document.querySelectorAll('#sessions button').length"),1);
  await js("document.querySelector('#search').value='';document.querySelector('#search').dispatchEvent(new Event('input'))");

  // Catalog failure leaves a live assistant usable, while removal of the
  // shared chat invalidates the entry even if old metadata arrives later.
  await js("window.assistantButton=document.querySelector('.bw-dedicated-session');window.assistantButton.focus()");
  entriesUnavailable=true;
  const failedEntries=requests.filter(r=>r.op==='plugin-entries').length;
  await js("document.querySelector('#refresh').click()");
  for(let n=0;n<100&&requests.filter(r=>r.op==='plugin-entries').length===failedEntries;n++)await new Promise(r=>setTimeout(r,20));
  await js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  assert(await js("window.assistantButton===document.querySelector('.bw-dedicated-session')&&document.activeElement===window.assistantButton"),'unchanged refresh preserves the assistant button and its keyboard focus');
  assert.equal(await js("document.querySelector('[data-session-id=cdef]').getAttribute('aria-current')"),'page');
  assert.equal(await js("document.querySelector('#query').value"),'个人助手的草稿');
  let releaseEntries;
  entriesDelay=new Promise(resolve=>releaseEntries=resolve);
  await js("document.querySelector('#refresh').click()");
  for(let n=0;n<100&&entriesDelay;n++)await new Promise(r=>setTimeout(r,20));
  assert.equal(entriesDelay,null);
  assistantShared=false;await js("document.querySelector('#refresh').click()");
  await wait("!document.querySelector('[data-session-id=cdef]')&&document.querySelector('#title').textContent==='选择一个对话'");
  assert.equal(await js("document.querySelector('#send').disabled"),true);
  releaseEntries(assistantEntries);
  assistantShared=true;await js("document.querySelector('#refresh').click()");
  await wait("!document.querySelector('#send').disabled&&!!document.querySelector('[data-session-id=cdef]')");
  assert.equal(await js("document.querySelector('.bw-dedicated-session')"),null,'stale entries must not classify a newly shared catalog');
  assert.equal(await js("document.querySelector('#query').value"),'个人助手的草稿');
  entriesUnavailable=false;await js("document.querySelector('#refresh').click()");
  await wait("document.querySelector('.bw-dedicated-session')?.getAttribute('aria-current')==='page'");
  await click('项目主控');await wait("!document.querySelector('#send').disabled");await wait("!!document.querySelector('.katex')");await wait("document.querySelector('.bw-message.assistant img')?.naturalWidth===1");
  assert.equal(external.length,0,'remote HTML cannot make tracking image requests');assert.equal((await js("document.querySelector('.bw-message.assistant').textContent")).split('结果已就绪').length-1,1,'live chunks and replay segments are not duplicated');assert.equal(await js('typeof window.electronAPI'),'undefined');assert.equal(await js('typeof require'),'undefined');
  assert(await js("document.querySelector('.bw-message.assistant img').src.includes('/resource?')"));
  await js("document.querySelector('.bw-message.assistant a').click()");await wait("document.querySelector('.artifact-preview')?.textContent.includes('测试报告')");await js('AsHubFilePreview.close()');
  assert(await js("document.querySelector('.bw-phase').compareDocumentPosition(document.querySelector('.bw-message.assistant')) & Node.DOCUMENT_POSITION_FOLLOWING"));
  // Late tool results update the old row, without disturbing a newer summary/reply.
  const emit=streams.get('one:abcd');emit(frame('agent:processing-start'));emit(frame('agent:thinking',{text:'**新的思路**'}));emit(frame('agent:response-segment',{text:'新的回复'}));emit(frame('agent:tool-completed',{toolCallId:'old',text:'late result'}));emit(frame('agent:thinking',{text:'\n\n**后续思路**'}));emit(frame('agent:processing-done'));
  await wait("document.querySelector('#messages').textContent.includes('后续思路')");assert.equal(await js("document.querySelectorAll('.bw-message.assistant').length"),2);assert((await js("document.querySelectorAll('.bw-phase')[1].textContent")).includes('新的思路'));assert(!(await js("document.querySelectorAll('.bw-phase')[1].textContent")).includes('late result'));
  emit(frame('agent:processing-start'));emit(frame('agent:tool-started',{toolCallId:'shared-label',name:'read_file'}));
  emit({...frame('agent:error',{message:'fixture error'}),meta:{name:'agent:error',ts:Date.now()}});emit(frame('agent:processing-done'));
  await wait("!!document.querySelector('.bw-phase-time')");assert((await js("document.querySelectorAll('.bw-phase')[2].textContent")).includes('处理异常'));assert((await js("document.querySelectorAll('.bw-phase')[2].textContent")).includes('读取文件'));
  await wait("document.querySelector('#queue').textContent.includes('排队消息')");await click('编辑');await js("document.querySelector('#dialog textarea').value='修改后的排队消息'");await click('保存');await wait("document.querySelector('#queue').textContent.includes('修改后的排队消息')");await click('插队');await wait("document.querySelector('#queue').textContent.includes('等待接入')");let releaseQueue;queueDelay=new Promise(r=>releaseQueue=r);const beforeQueue=requests.filter(r=>r.op==='queue').length;streams.get('one:abcd')(frame('agent:queue-updated'));await wait('true');for(let n=0;n<100&&requests.filter(r=>r.op==='queue').length===beforeQueue;n++)await new Promise(r=>setTimeout(r,20));await click('撤回');await wait("!document.querySelector('#queue').textContent");releaseQueue([{id:'queue-message-000001',query:'stale queue',revision:1}]);await new Promise(r=>setTimeout(r,80));assert.equal(await js("document.querySelector('#queue').textContent"),'');assert(requests.some(r=>r.op==='queue-withdraw'));
  await js("document.querySelector('#query').value='电脑一草稿';document.querySelector('#query').dispatchEvent(new Event('input'))");
  const second=await make(b.id),js2=code=>second.webContents.executeJavaScript(code);await wait("document.querySelectorAll('#sessions button').length===3",js2);
  assert.equal(await js2("document.querySelector('.bw-dedicated-session')"),null);
  await wait("document.querySelector('[data-session-id=cdef]')?.previousElementSibling?.textContent==='独立对话'",js2);
  assert(!requests.some(r=>r.key==='two'&&r.op==='plugin-entries'),'older devices should not need the optional catalog');
  await js2("document.querySelector('[data-session-id=abcd]').click()");await wait("!document.querySelector('#send').disabled",js2);assert.equal(await js2("document.querySelector('#query').value"),'');
  await js2("document.querySelector('#query').value='电脑二草稿';document.querySelector('#query').dispatchEvent(new Event('input'))");await click('技术审查');await wait("!document.querySelector('#send').disabled");assert.equal(await js("document.querySelector('#query').value"),'');await click('项目主控');await wait("!document.querySelector('#send').disabled");assert.equal(await js("document.querySelector('#query').value"),'电脑一草稿');
  const selectImage=name=>js(`(()=>{const files=new DataTransfer();files.items.add(new File(['image'],${JSON.stringify(name)},{type:'image/png'}));const input=document.querySelector('#upload');input.files=files.files;input.dispatchEvent(new Event('change'));})()`);
  const holdImage=()=>js(`(()=>{const Native=window.FileReader;window.finishImage=null;window.FileReader=class extends Native{readAsDataURL(...args){window.finishImage=()=>{window.FileReader=Native;super.readAsDataURL(...args)};}};})()`);
  await holdImage();await selectImage('会话 A 迟到.png');
  await wait('!!window.finishImage');await click('技术审查');await wait("!document.querySelector('#send').disabled");
  await js("finishImage()");await new Promise(r=>setTimeout(r,100));
  assert.equal(await js("document.querySelector('#attachments').textContent"),'');
  await click('项目主控');await wait("!document.querySelector('#send').disabled");
  await wait("document.querySelector('#attachments').textContent.includes('会话 A 迟到.png')");
  await click('会话 A 迟到.png ×');
  // A failed catalog read started in A cannot disconnect a newer B stream.
  let rejectCatalog;sessionDelay=new Promise((_r,reject)=>rejectCatalog=reject);const countCatalog=requests.filter(r=>r.op==='sessions').length;await js("document.querySelector('#refresh').click()");
  for(let n=0;n<100&&requests.filter(r=>r.op==='sessions').length===countCatalog;n++)await new Promise(r=>setTimeout(r,20));
  await click('技术审查');await wait("!document.querySelector('#send').disabled");rejectCatalog(Object.assign(Error('old catalog failed'),{status:503}));await new Promise(r=>setTimeout(r,80));
  assert.equal(await js("document.querySelector('#send').disabled"),false,'old catalog error disconnected the new conversation');
  await click('项目主控');await wait("!document.querySelector('#send').disabled");
  // Late model catalog cannot populate another conversation's modal.
  let releaseModel;modelDelay=new Promise(r=>releaseModel=r);await js("document.querySelector('#model').click()");await wait("document.querySelector('#dialog').open");await click('技术审查');releaseModel({providers:[{name:'wrong',models:[{id:'wrong-model'}]}]});await new Promise(r=>setTimeout(r,100));assert.equal(await js("document.querySelector('#dialog').open"),false);assert(!(await js("document.body.textContent")).includes('wrong-model'));
  await click('项目主控');await wait("!document.querySelector('#send').disabled");
  await js("document.querySelector('#composer').requestSubmit()");
  await wait("document.querySelector('#notice').textContent.includes('response lost')");
  const receiptKey='ash.backend.'+a.id+'.abcd.pending',firstReceipt=await js(`localStorage.getItem(${JSON.stringify(receiptKey)})`);
  assert(firstReceipt);
  // The original attempt ran. Revoking the session can reject a retry before
  // the publisher reads the journal, so the rejection cannot settle the ID.
  submissionRevoked=true;
  await click('重试原请求');await wait("document.querySelector('#notice').textContent.includes('会话授权已失效')");
  assert.equal(await js(`localStorage.getItem(${JSON.stringify(receiptKey)})`),firstReceipt);
  assert.equal(await js("document.querySelector('#send').disabled"),true);
  await js("document.querySelector('#query').value='核对期间的新草稿';document.querySelector('#query').dispatchEvent(new Event('input'))");
  submissionRevoked=false;
  await click('重试原请求');await wait("document.querySelector('#receipt').hidden");
  assert.equal(submits,1,'all retries reuse the durable request id');
  assert.equal(await js("document.querySelector('#query').value"),'核对期间的新草稿');
  // A completed old status lookup must not erase the replacement receipt.
  holdReceipt=true;await js("document.querySelector('#query').value='old receipt';document.querySelector('#composer').requestSubmit()");
  for(let n=0;n<100&&!releaseReceipt;n++)await new Promise(r=>setTimeout(r,20));assert(releaseReceipt);
  await click('结束核对');await click('已核对，保留草稿');await js("document.querySelector('#query').value='new receipt';document.querySelector('#composer').requestSubmit()");
  const pendingKey='ash.backend.'+a.id+'.abcd.pending';await wait(`JSON.parse(localStorage.getItem(${JSON.stringify(pendingKey)})||'null')?.query==='new receipt'`);
  releaseReceipt({state:'done',result:{ok:true}});await new Promise(r=>setTimeout(r,80));
  assert.equal(await js(`JSON.parse(localStorage.getItem(${JSON.stringify(pendingKey)})||'null')?.query`),'new receipt','late receipt erased the next message');
  assert.equal(await js("document.querySelector('#query').value"),'new receipt');
  await js("(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['next-image'],'next.png',{type:'image/png'}));const input=document.querySelector('#upload');input.files=transfer.files;input.dispatchEvent(new Event('change'));})()");await wait("document.querySelector('#attachments').textContent.includes('next.png')");
  const nextReceipt=await js(`JSON.parse(localStorage.getItem(${JSON.stringify(pendingKey)}))`);receipts.set(nextReceipt.requestId,{state:'done'});await click('检查状态');await wait("document.querySelector('#receipt').hidden");assert((await js("document.querySelector('#attachments').textContent")).includes('next.png'),'receipt removed next draft attachment');await js("document.querySelector('#attachments button').click()");
  const active=streams.get('one:abcd');active(frame('agent:info',{thinkingLevel:'high'}));await new Promise(r=>setTimeout(r,30));assert.equal(await js("document.querySelector('#model').textContent"),'deepseek-v4');active(frame('permission:request',{requestId:'persistent',title:'站点授权',scope:'site',expiresAt:Date.now()+60000}));await wait("document.querySelector('.bw-permission')");assert.equal(await js("document.querySelector('.bw-permission').querySelectorAll('button').length"),1);assert.equal(await js("document.querySelector('.bw-permission button').textContent"),'拒绝');await click('拒绝');await wait("!document.querySelector('.bw-permission')");
  // Window reload restores the correct backend/session/draft; offline never reroutes submit.
  await js("document.querySelector('#query').value='恢复草稿';document.querySelector('#query').dispatchEvent(new Event('input'))");await win.reload();await wait("!document.querySelector('#send').disabled");assert.equal(await js("document.querySelector('#query').value"),'恢复草稿');
  // End an active SSE connection: automatic recovery must preserve drafts and reject old events.
  const beforeDisconnect=streams.get('one:abcd');streamEnds.get('one:abcd')();
  await wait("document.querySelector('#connection').textContent.includes('正在恢复')");
  beforeDisconnect(frame('agent:response-segment',{text:'stale disconnected stream'}));
  await wait("!document.querySelector('#send').disabled");
  assert.notEqual(streams.get('one:abcd'),beforeDisconnect);
  assert.equal(await js("document.querySelector('#query').value"),'恢复草稿');
  assert(!(await js("document.querySelector('#messages').textContent")).includes('stale disconnected stream'));
  online=false;await js("document.querySelector('#refresh').click()");await wait("document.querySelector('#query').disabled");assert.equal(await js("document.querySelector('#query').value"),'恢复草稿');online=true;await js("document.querySelector('#refresh').click()");await wait("!document.querySelector('#query').disabled");
  win.show();win.focus();await js("document.documentElement.dataset.theme='light';new Promise(r=>setTimeout(r,250))");fs.writeFileSync('/tmp/ashub-backend-light.png',(await win.webContents.capturePage()).toPNG());await js("document.documentElement.dataset.theme='dark';new Promise(r=>setTimeout(r,250))");fs.writeFileSync('/tmp/ashub-backend-dark.png',(await win.webContents.capturePage()).toPNG());
  await js(`(async()=>{const {mountResource}=await import('/js/extensions/resource-view.js');const host=document.createElement('div');host.id='password-fixture';document.body.append(host);let count=0;window.passwordDisposer=mountResource(host,{pluginId:'fixture'},'login',{request:async(body)=>{if(body){window.passwordSubmitted=body;return {view:{rows:[],actions:[],note:'submitted'}};}return {view:{rows:[],actions:[],form:{action:'login',submit:'登录',values:{},fields:[{id:'password',type:'password',label:'密码',value:'must-not-echo'}]}}};}});})()`);
  await wait("!!document.querySelector('#password-fixture input')");assert.equal(await js("document.querySelector('#password-fixture input').type"),'password');assert.equal(await js("document.querySelector('#password-fixture input').value"),'');await js("document.querySelector('#password-fixture input').value='typed-password';document.querySelector('#password-fixture form').requestSubmit()");await wait('!!window.passwordSubmitted');assert.equal(await js('window.passwordSubmitted.values.password'),'typed-password');await js("passwordDisposer();document.querySelector('#password-fixture').remove()");
  // The optional plugin contributes its device entry using the common resource renderer.
  const modules=['/js/extensions/resource-view.js'];if(fs.existsSync(path.join(root,'remote/public/plugin-resource-view.js')))modules.push('/fixture-remote-resource.js');
  for(const moduleURL of modules){
   const count=opened.length;
   await js(`(async()=>{const {mountResource}=await import(${JSON.stringify(moduleURL)});const host=document.createElement('div');host.id='connection-fixture';document.querySelector('#dialog-body').replaceChildren(host);document.querySelector('#dialog').showModal();window.connectionDisposer=mountResource(host,{pluginId:'fixture'},'connections',{request:async body=>(await fetch('/fixture-connections',{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined})).json()});})()`);
   await wait("!!document.querySelector('#connection-fixture .extension-resource-row > button')");
   assert.equal(await js("document.querySelector('#connection-fixture .extension-resource-row > button').closest('.extension-resource-row').querySelectorAll('details').length"),0);
   await js("document.querySelector('#connection-fixture .extension-resource-row > button').click()");
   for(let n=0;n<100&&opened.length===count;n++)await new Promise(r=>setTimeout(r,20));assert.equal(opened.at(-1),a.id);assert.equal(opened.length,count+1);
   await js("connectionDisposer();document.querySelector('#dialog').close()");
   await js(`(async()=>{const {mountResource}=await import(${JSON.stringify(moduleURL)});const host=document.createElement('div');host.id='filtered-fixture';document.body.append(host);window.filteredDisposer=mountResource(host,{pluginId:'fixture'},'filtered',{request:async()=>({view:{actions:[],rows:[{title:'Filtered',primaryAction:'open',actions:[]}]}})});})()`);
   await wait("!!document.querySelector('#filtered-fixture .extension-resource-row')");assert.equal(await js("document.querySelector('#filtered-fixture').querySelectorAll('button').length"),0,'filtered action cannot be recreated by presentation');
   await js("filteredDisposer();document.querySelector('#filtered-fixture').remove()");
  }
  win.setContentSize(760,620);await wait('innerWidth===760');assert(await js("document.documentElement.scrollWidth<=innerWidth"));
  assert(await js("document.querySelector('.bw-dedicated-session').getBoundingClientRect().width<=document.querySelector('#sessions').clientWidth"));
  await js(fs.readFileSync(path.join(root,'tests/fixtures/media-recorder.js'),'utf8'));
  const micReady="!document.querySelector('.composer-media').hidden&&!document.querySelector('.composer-media-button').disabled";
  const draftBeforeReplay=await js("document.querySelector('#query').value");
  await wait(micReady);await js("document.querySelector('.composer-media-button').click()");
  await wait("document.querySelector('.composer-media').dataset.state==='recording'");
  const replay=streams.get('one:abcd');
  replay(frame('backend:reset'));
  await wait("document.querySelector('#query').disabled");
  await selectImage('同步期间选中的图片.png');
  await wait("document.querySelector('#attachments').textContent.includes('同步期间选中的图片.png')");
  assert(await js(micReady),'an ongoing recording can finish during same-session replay');
  await js("document.querySelector('.composer-media-button').click()");
  await wait("document.querySelector('#query').value.includes('测试转写') && mediaFixture.tracks.every(t=>t.stopped)");
  assert(await js("document.querySelector('#query').disabled"),'transcription does not unlock message sends during replay');
  replay(frame('hub:replay-done'));
  await wait("!document.querySelector('#query').disabled");
  await click('同步期间选中的图片.png ×');
  await js(`document.querySelector('#query').value=${JSON.stringify(draftBeforeReplay)};document.querySelector('#query').dispatchEvent(new Event('input'))`);
  await wait(micReady);await js("document.querySelector('.composer-media-button').click()");
  await wait("document.querySelector('.composer-media').dataset.state==='recording'");
  await js(`new MutationObserver((_records,observer)=>{if(document.querySelector('#notice').textContent.includes('不再共享')){window.stoppedOnRevocation=mediaFixture.tracks.every(t=>t.stopped);observer.disconnect()}}).observe(document.querySelector('#notice'),{childList:true})`);
  let releaseRemoved;modelDelay=new Promise(r=>releaseRemoved=r);await js("document.querySelector('#model').click()");await wait("document.querySelector('#dialog').open");removed=true;await js("document.querySelector('#refresh').click()");await wait("document.querySelector('#query').disabled&&!document.querySelector('#dialog').open");releaseRemoved({providers:[{name:'removed',models:[{id:'removed-model'}]}]});await new Promise(r=>setTimeout(r,50));assert(!(await js("document.body.textContent")).includes('removed-model'));assert.equal(await js("document.querySelector('#query').value"),'');
  assert.equal(await js('window.stoppedOnRevocation'),true,'revocation releases the active microphone before displaying the notice');
  assert(await js("document.documentElement.scrollWidth<=innerWidth"));assert.equal(errors.length,0,errors.join('\n'));
  removed=false;await js("document.querySelector('#refresh').click()");await wait("!document.querySelector('#send').disabled");
  assert((await js("document.querySelector('#messages').children.length"))>0);
  a.dispose();
  await wait("document.querySelector('#query').disabled");
  await js("document.querySelector('#refresh').click()");await wait("document.querySelector('#notice').textContent.includes('Backend unavailable')");
  assert.equal(await js("document.querySelector('#sessions').children.length"),0,'revoked connection retained the old account conversation list');assert.equal(await js("document.querySelector('#messages').children.length"),0);
  assert.equal(await js2("document.querySelector('#query').value"),'电脑二草稿');assert.equal(await js2("document.querySelector('#send').disabled"),false);
  // Explicit reconnect of the same immutable backend restores only its own session and draft.
  const restored=bind('one');assert.equal(restored.id,a.id);await js("document.querySelector('#refresh').click()");
  await wait("!document.querySelector('#send').disabled");assert.equal(await js("document.querySelector('#query').value"),'恢复草稿');
  assert.equal(await js2("document.querySelector('#query').value"),'电脑二草稿');
  // Confirmed deletion clears the old composer before another conversation
  // opens, and a selected image finishing late cannot recreate that draft.
  await click('技术审查');await wait("!document.querySelector('#send').disabled");
  await js("document.querySelector('#query').value='被删除对话的草稿';document.querySelector('#query').dispatchEvent(new Event('input'))");
  await selectImage('已选图片.png');await wait("document.querySelector('#attachments').textContent.includes('已选图片.png')");
  await holdImage();await selectImage('删除后到达.png');await wait('!!window.finishImage');
  await js("document.querySelector('#settings').click()");await wait("document.querySelector('#dialog-body').textContent.includes('删除对话')");
  await click('删除对话');await click('确认删除');
  await wait("!document.querySelector('[data-session-id=bcde]')");
  assert.equal(await js("document.querySelector('#connection').textContent"),'选择一个对话');
  await js("finishImage()");await new Promise(r=>setTimeout(r,100));
  assert.equal(await js("document.querySelector('#query').value"),'');
  assert.equal(await js("document.querySelector('#attachments').textContent"),'');
  assert.equal(await js("document.querySelector('#receipt').hidden"),true);
  console.log('PASS dedicated assistant entry, stale metadata and old peers, isolated backend windows, files/images/math, late tool results, queue actions, immutable account routing, late model response, idempotent retry, held file selection, replay capture, revocation/deletion cleanup, one-time approvals, offline/reload recovery');
  controller.abort();for(const w of windows)w.destroy();server.closeAllConnections();server.close();clearTimeout(deadline);app.exit(0);
 }catch(e){console.error(e);if(windows[0]&&!windows[0].isDestroyed())console.error(await windows[0].webContents.executeJavaScript(`document.querySelector('.artifact-preview')?.outerHTML||document.body.innerText`));controller.abort();for(const w of windows)w.destroy();server?.closeAllConnections();server?.close();app.exit(1);}
});
