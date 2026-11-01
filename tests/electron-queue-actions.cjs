// Real Chromium DOM, synthetic messages, no live account or model requests.
const {app,BrowserWindow}=require('electron');
const {fixture}=require('./file-preview-fixture.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'queue-actions-ui-')));app.on('window-all-closed',()=>{});
const timer=setTimeout(()=>app.exit(1),45000);
app.whenReady().then(async()=>{let f,w;try{
 f=await fixture();w=new BrowserWindow({show:false,width:1100,height:760});await w.loadURL(f.url);
 await w.webContents.insertCSS('body {overflow:auto!important;padding:64px 12%!important;} .live-wrap{position:static!important;display:block!important;width:100%!important;height:auto!important;} #original{display:none}');
 const result=await w.webContents.executeJavaScript(`(async()=>{
  await Promise.all(['live','stream','composer','chrome','workspace'].map(name=>new Promise(resolve=>{const link=document.createElement('link');link.rel='stylesheet';link.href='/css/'+name+'.css';link.onload=resolve;document.head.append(link);} )));
  const {attachQueueEdit,updateQueuedBox}=await import('/js/queued-messages.js');
  const {lang}=await import('/js/i18n.js');lang.value='zh';
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  const stream=document.createElement('div');stream.className='live-wrap';document.body.append(stream);
  const intro=document.createElement('article');intro.textContent='项目资料已整理完成，接下来会根据你的补充继续处理。';stream.append(intro);
  const add=(id,query,delivery)=>{const sep=document.createElement('div');sep.className='turn-sep';stream.append(sep);const box=document.createElement('div');box.className='agent-box pending';box._queryText=query;box.dataset.queued=query;box.innerHTML='<span class="msg-time">2026/10/31 21:42</span><div class="q-text"></div>';
   box.querySelector('.q-text').textContent=query;attachQueueEdit(box,'test',id,delivery);stream.append(box);return box;};
  const first=add('first','先总结项目目标，再列出下一步计划','queue'),second=add('second','请优先核对数据来源','queue'),third=add('third','最终结果请整理成一份文档','steer');
  const rectangles=[first,second,third].map(b=>b.getBoundingClientRect());
  assert(rectangles[2].bottom-rectangles[0].top<240,'three rows should form a compact group');
  assert(rectangles[1].top-rectangles[0].bottom<=1,'queued messages must have no blank gaps');
  assert(first.querySelectorAll('.queue-action').length===3,'three actions');
  const a=first.querySelector('[data-action="edit"]').getBoundingClientRect(),q=first.querySelector('.q-text').getBoundingClientRect();
  assert(a.left>=q.right && a.top<q.bottom,'actions beside the message');
  globalThis.queueFixture={first,second,third,stream};
  let calls=[],answer;globalThis.fetch=async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return await new Promise(resolve=>answer=resolve);};
  first.querySelector('[data-action="edit"]').click();const input=first.querySelector('textarea');input.value='编辑后的内容';
  assert(first.querySelector('[data-action="promote"]').disabled,'save before promoting edited content');
  first.querySelector('form').requestSubmit();assert(input.readOnly,'saving cannot discard further typing');assert(calls.length===1&&calls[0].body.action==='edit','save edits directly');
  assert([...stream.querySelectorAll('.pending')].indexOf(first)===0,'retain position while saving');
  updateQueuedBox(first,{id:'first',query:'编辑后的内容',delivery:'queue',revision:1});
  assert(first.querySelector('textarea')===input && input.value==='编辑后的内容','SSE must preserve the active editor');
  answer({ok:true,json:async()=>({id:'first',query:'编辑后的内容',delivery:'queue',revision:1})});await new Promise(r=>setTimeout(r,0));
  assert(!first.querySelector('form') && first._queryText==='编辑后的内容','save closes editor');
  assert(first.dataset.queueId==='first' && first.dataset.revision==='1','stable identity and revision');
  second.querySelector('[data-action="promote"]').click();assert(calls.at(-1).body.action==='promote','promote operation');
  answer({ok:true,json:async()=>({id:'second',query:'请优先核对数据来源',delivery:'steer',revision:1})});await new Promise(r=>setTimeout(r,0));
  assert(second.querySelector('[data-action="promote"]').disabled,'already promoted cannot enqueue twice');
  third.querySelector('[data-action="withdraw"]').click();assert(calls.at(-1).url.endsWith('/withdraw'),'withdraw operation');
  answer({ok:true,json:async()=>({id:'third',query:'最终结果请整理成一份文档'})});await new Promise(r=>setTimeout(r,0));
  assert(!third.isConnected && stream.querySelectorAll('.turn-sep').length===2,'withdraw removes only its row and separator');
  // Lost responses can be retried with the same operation ID.
  first.querySelector('[data-action="edit"]').click();first.querySelector('textarea').value='再次修改';first.querySelector('form').requestSubmit();
  const requestId=calls.at(-1).body.requestId;answer({ok:false,status:503});await new Promise(r=>setTimeout(r,0));
  first.querySelector('form').requestSubmit();assert(calls.at(-1).body.requestId===requestId,'retry uses original request id');
  answer({ok:false,status:409});await new Promise(r=>setTimeout(r,0));assert(first.querySelector('textarea').value==='再次修改','conflict preserves typed text');
  first.querySelector('button[type="button"]');first.querySelector('.queue-editor button[type="button"]').click();first.querySelector('.queue-error')?.remove();
  // Load the actual desktop shortcut handler: Escape in this editor must not cancel the turn.
  await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/host-shortcuts.js';script.onload=resolve;script.onerror=reject;document.head.append(script);});
  for(const target of ['textarea','.queue-editor button[type="submit"]']) {
   first.querySelector('[data-action="edit"]').click();
   const field=first.querySelector(target);field.focus();field.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
   assert(!first.querySelector('.queue-editor'),'Escape closes the editor from text and buttons');
   assert(!shortcutEffects.length,'Escape in queue editor must not cancel the active turn');
  }
  first.querySelector('[data-action="edit"]').click();
  const ime=first.querySelector('textarea');
  const imeEscape=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,isComposing:true});
  ime.dispatchEvent(imeEscape);assert(first.querySelector('.queue-editor')&&!imeEscape.defaultPrevented,'IME Escape remains native without closing edit');
  first.querySelector('form').requestSubmit();ime.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert(first.querySelector('.queue-editor')&&!shortcutEffects.length,'Escape during save must not cancel editing or the task');
  answer({ok:false,status:503});await new Promise(r=>setTimeout(r,0));first.querySelector('.queue-editor button[type="button"]').click();first.querySelector('.queue-error')?.remove();
  add('fourth','最终结果请整理成一份文档','queue');
  return {height:rectangles[2].bottom-rectangles[0].top};
 })()`);
 assert(result.height<240);
 for(const theme of ['light','dark']){await w.webContents.executeJavaScript(`document.documentElement.dataset.theme='${theme}'`);await fs.promises.writeFile('/tmp/ashub-queue-desktop-'+theme+'.png',(await w.webContents.capturePage()).toPNG());}
 console.log('PASS desktop queue: compact layout, in-place edit, identity, retry, conflict, promotion and withdrawal');
 // The application repository deliberately excludes the separately deployed
 // website. Desktop CI still executes every assertion above; remote acceptance
 // explicitly requires its fixture so a missing deployment input cannot pass.
 const remotePage=path.join(__dirname,'../remote/public/index.html');
 if(!fs.existsSync(remotePage)){
  assert(!process.argv.includes('--require-remote'),'Remote queue acceptance requires remote/public/index.html');
  console.log('SKIP remote queue: website sources are absent from this core-only checkout');
  return;
 }
 await w.loadFile(remotePage);
 for(const width of [320,390,1040]){
  w.setContentSize(width,820);
  const r=await w.webContents.executeJavaScript(`(async()=>{
   const assert=(ok,message)=>{if(!ok)throw Error(message);};
   $('auth').hidden=true;$('workspace').hidden=false;user='fixture';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];streamReady=true;capabilities={queue:true,queueActions:true,steering:true};activity=true;
   queuedMessages=[{id:'a',query:'先总结项目目标，再列出下一步计划',delivery:'queue'},{id:'b',query:'请优先核对数据来源',delivery:'queue'},{id:'c',query:'最终结果请整理成一份文档',delivery:'steer'}];
   for(const state of queueChanges.values()){state.editor=null;state.error='';}
   controls();menu(false);renderQueue();
   let calls=[];globalThis.fetch=async(url,opts)=>{const {op,args}=JSON.parse(opts.body);calls.push({op,args});const result=op==='queue'?queuedMessages:op==='queue-withdraw'?{id:args.id}:{...queuedMessages.find(m=>m.id===args.id),query:args.query??queuedMessages.find(m=>m.id===args.id).query,delivery:args.action==='promote'?'steer':'queue',revision:args.revision+1};return {ok:true,json:async()=>result};};
   editQueue(queuedMessages[0]);const editor=$('queued-messages').querySelector('textarea');editor.value='新的计划';editor.setSelectionRange(2,2);
   renderQueue();controls();renderQueue();
   assert(document.activeElement===editor&&editor.selectionStart===2,'status updates must preserve focus and caret');
   editor.closest('form').querySelector('button[type="submit"]').click();await new Promise(r=>setTimeout(r,0));
   assert(queuedMessages[0].query==='新的计划'&&queuedMessages[0].id==='a','edit retains position');
   // Cached queue editors can survive logout/login to the same account.
   editQueue(queuedMessages[0]);const cancelling=$('queued-messages').querySelector('.queue-editor');
   cancelling.querySelector('textarea').value='must not be saved';
   const mutationCount=()=>calls.filter(call=>call.op==='queue-update').length;
   const beforeCancel=mutationCount(),savedQueue=queuedMessages;authGeneration++;
   session='bbbbbb';queuedMessages=[];renderQueue();session='aaaaaa';queuedMessages=savedQueue;renderQueue();
   assert($('queued-messages').querySelector('.queue-editor')===cancelling,'returning to the account preserves its editor');
   cancelling.querySelector('button:not([type="submit"])').click();await new Promise(r=>setTimeout(r,0));
   assert(mutationCount()===beforeCancel&&!$('queued-messages').querySelector('.queue-editor'),'cancel after authentication refresh must close without submitting');
   editQueue(queuedMessages[0]);const reauthenticated=$('queued-messages').querySelector('.queue-editor');
   reauthenticated.querySelector('textarea').value='重新登录后的修改';authGeneration++;
   reauthenticated.querySelector('button[type="submit"]').click();await new Promise(r=>setTimeout(r,0));
   assert(queuedMessages[0].query==='重新登录后的修改'&&mutationCount()===beforeCancel+1,'cached editor save submits once after authentication refresh');
   await changeQueue(queuedMessages[1],'promote');assert(queuedMessages[1].delivery==='steer','promotion updates delivery');
   $('query').value='尚未发送的草稿';await changeQueue(queuedMessages[2],'withdraw');
   assert($('query').value==='尚未发送的草稿'&&queuedMessages.length===2,'withdraw must not restore to composer');
   const rows=[...$('queued-messages').querySelectorAll('.queued-message')];
   assert(rows.length===2,'rendered queue refreshed');
   for(const button of $('queued-messages').querySelectorAll('.queue-action')){const r=button.getBoundingClientRect();assert(r.width>=32&&r.left>=0&&r.right<=innerWidth,'visible touch target');}
   assert(document.documentElement.scrollWidth<=innerWidth,'no horizontal overflow');
   storage.set(key('withdrawals'),JSON.stringify([{id:'legacy',query:'旧草稿',requestId:'legacy-withdraw-request'}]));renderQueue();
   assert($('queued-messages').querySelector('.queue-recovery button'),'legacy uncertain withdrawal must stay recoverable');
   storage.remove(key('withdrawals'));renderQueue();
   // An earlier message starting must not move (and blur) a later row being edited.
   editQueue(queuedMessages[1]);const laterEditor=$('queued-messages').querySelector('textarea');
   laterEditor.value='仍在输入';laterEditor.setSelectionRange(2,2);
   queuedMessages=queuedMessages.slice(1);renderQueue();
   assert(document.activeElement===laterEditor&&laterEditor.selectionStart===2,'earlier dequeue must preserve later editor focus and caret');
   queueState(queuedMessages[0].id).editor=null;renderQueue();
   // Editing drafts must outlive cache churn caused by other conversations.
   queuedMessages=[{id:'retained-draft-'+innerWidth,query:'原始消息',delivery:'queue'}];renderQueue();
   editQueue(queuedMessages[0]);const retainedEditor=$('queued-messages').querySelector('.queue-editor');
   retainedEditor.querySelector('textarea').value='尚未保存的修改';const retainedQueue=queuedMessages,retainedKey=key('queue-actions')+':'+queuedMessages[0].id;
   session='bbbbbb';
   for(let n=0;n<132;n++){queuedMessages=[{id:'churn-'+innerWidth+'-'+n,query:'其他对话的排队消息',delivery:'queue'}];renderQueue();}
   session='aaaaaa';queuedMessages=retainedQueue;renderQueue();
   assert($('queued-messages').querySelector('.queue-editor')===retainedEditor&&retainedEditor.querySelector('textarea').value==='尚未保存的修改','queue cache eviction must preserve unsaved editors across conversations');
   retainedEditor.querySelector('button[type="button"]').click();
   queueState('after-editor-'+innerWidth);
   assert(!queueChanges.has(retainedKey)&&queueChanges.size<=129,'closed editors become evictable and ordinary cache remains bounded');
   // A confirmed dequeue must release pinned editors, without treating an
   // empty loading view or failed queue read as authoritative removal.
   queuedMessages=[{id:'consumed-editor-'+innerWidth,query:'即将开始处理',delivery:'queue'}];renderQueue();
   editQueue(queuedMessages[0]);const consumedKey=key('queue-actions')+':'+queuedMessages[0].id;
   queuedMessages=[];renderQueue();
   assert(queueChanges.has(consumedKey),'empty transitional rendering must preserve a cached draft');
   const workingFetch=globalThis.fetch;
   globalThis.fetch=async()=>({ok:false,status:503,json:async()=>({error:'offline'})});
   scheduleQueue();await new Promise(r=>setTimeout(r,120));
   assert(queueChanges.has(consumedKey),'failed queue reads must preserve a cached draft');
   globalThis.fetch=workingFetch;
   queueChanges.get(consumedKey).busy=true;scheduleQueue();await new Promise(r=>setTimeout(r,120));
   assert(queueChanges.has(consumedKey),'queue snapshots must not release an in-flight operation');
   queueChanges.get(consumedKey).busy=false;
   let finishOldRead;globalThis.fetch=()=>new Promise(resolve=>{finishOldRead=resolve;});scheduleQueue();
   for(let n=0;n<50&&!finishOldRead;n++)await new Promise(r=>setTimeout(r,20));
   assert(finishOldRead,'delayed snapshot request started');generation++;
   finishOldRead({ok:true,json:async()=>[]});await new Promise(r=>setTimeout(r,0));
   assert(queueChanges.has(consumedKey),'obsolete snapshots must not discard cached drafts');
   session='bbbbbb';queuedMessages=[{id:'other-editor-'+innerWidth,query:'另一个对话的草稿',delivery:'queue'}];renderQueue();
   editQueue(queuedMessages[0]);const otherKey=key('queue-actions')+':'+queuedMessages[0].id;
   session='aaaaaa';queuedMessages=[];renderQueue();globalThis.fetch=workingFetch;
   scheduleQueue();
   for(let n=0;n<50&&queueChanges.has(consumedKey);n++)await new Promise(r=>setTimeout(r,20));
   assert(!queueChanges.has(consumedKey),'authoritative dequeue must release an inaccessible editor');
   assert(queueChanges.get(otherKey)?.editor,'cleanup must preserve other conversations drafts');
   return true;
  })()`);assert(r);
  await fs.promises.writeFile('/tmp/ashub-queue-mobile-'+width+'.png',(await w.webContents.capturePage()).toPNG());
 }
 console.log('PASS remote queue: 320/390/1040px, editor focus, edit, promotion, pure withdrawal and draft preservation');
}finally{w?.destroy();f?.server.close();clearTimeout(timer);}}).then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
