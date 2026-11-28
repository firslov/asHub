// Isolated project creation UI; all API calls use local fixture data.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const root = path.resolve(__dirname, '../web');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-project-create-ui-'));
app.setPath('userData', tmp);
const watchdog = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
 let server, win;
 const sessions = [{ instanceId:'fixture',title:'资料整理',kind:'agent',cwd:'/workspace/research',model:'gpt-6-astra',thinkingLevel:'high' }];
 const projects = [{ id:'project',name:'论文审阅',cwd:'/workspace/research',sessionIds:['fixture'] }];
 let policy={proxyEnabled:true,sessions:{}};
 const submissions = []; let deletes=0, failDelete=true; let pinned=[];
 let archived = [{id:'a9ab01',title:'历史草稿',cwd:'/archive/papers'}, {id:'a9ab02',title:'项目旧记录',cwd:'/archive/projects'}];
 let holdArchive = false, releaseArchive, rejectRestore = true, restoreCalls = 0;
 try {
  server=http.createServer(async(req,res)=>{
   const json = value => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
   if(req.url==='/fixture/' && req.method==='DELETE'){deletes++;if(failDelete){res.statusCode=500;return json({error:'delete failed'});}await new Promise(r=>setTimeout(r,60));sessions.splice(0,1);return json({ok:true});}
   if(req.url==='/api/sessions/pinned')return json({pinned});
   if(req.url==='/api/models')return json({providers:[{name:'codex',models:[{id:'gpt-6-astra',thinkingLevels:['low','high','max']},{id:'plain',thinkingLevels:[]}]}]});
   if(req.url==='/fixture/title') {let raw='';for await(const c of req)raw+=c;sessions[0].title=JSON.parse(raw).title;return json({ok:true,title:sessions[0].title});}
   if(req.url==='/api/settings/network'){if(req.method==='PUT'){let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);if(b.enabled===null)delete policy.sessions[b.session];else policy.sessions[b.session]=b.enabled;}return json(policy);}
   if(req.url==='/api/projects' && req.method==='POST'){
    let raw='';for await(const c of req)raw+=c;
    const change=JSON.parse(raw);
    if(change.action==='pin'){
     assert.equal(change.id,'project');assert.equal(change.sessionId,'external');
     projects[0].pinnedSessionIds=change.pinned?['external']:[];
    }
    return json(projects);
   }
   if(req.url==='/api/projects')return json(projects);
   if(req.url==='/sessions')return json(sessions);
   if(req.url==='/api/projects/workspaces')return json({});
   if(req.url==='/api/projects/session'){
    let raw='';for await(const c of req)raw+=c;submissions.push(JSON.parse(raw));
    res.statusCode=400;return json({error:'Fixture: creation rejected for UI test'});
   }
   const f=path.join(root, new URL(req.url,'http://localhost').pathname==='/'?'index.html':new URL(req.url,'http://localhost').pathname);
   if(!f.startsWith(root+path.sep)||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404);res.end();return;}
   let content=fs.readFileSync(f);
   if(f.endsWith('/sidebar.js'))content=content.toString()+'\nexport { renderSessions as auditRenderSessions };';
   if(f.endsWith('.html'))content=content.toString().replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
   res.setHeader('Content-Type',f.endsWith('.js')?'text/javascript':f.endsWith('.css')?'text/css':'text/html');res.end(content);
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  const js=async s=>{try{return await win.webContents.executeJavaScript(s)}catch(e){console.error('Failed script:',s);throw e;}};
  win.webContents.on('console-message',event=>{if(event.level==='error')console.log('renderer:',event.message);});
  const wait=async (s,attempts=100)=>{for(let i=0;i<attempts;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout: '+s);};
  // The isolated window stays hidden, but exercise foreground polling as in
  // the desktop app while the user is viewing a project.
  await js(`Object.defineProperty(document,'hidden',{get:()=>false});document.getElementById('page-loader').remove();localStorage.setItem('ash.lang','zh');(async()=>{const s=await import('/js/store.js');s.setSessions(${JSON.stringify(sessions)});const p=await import('/js/projects.js');p.showProjects(true);})()`);
  await wait(`!!document.querySelector('.project-toggle')`);
  assert.equal(await js(`document.querySelector('.project-toggle').getAttribute('aria-expanded')`),'false');
  await js(`document.querySelector('.project-toggle').click()`);
  await wait(`!!document.querySelector('.project-group-actions button')`);
  const openGroupMenu = `document.querySelector('.project-heading .project-more').click();`;
  const openChatMenu = `document.querySelector('.project-chat-row .project-more').click();`;
  await js(openGroupMenu);
  await wait(`document.querySelector('.project-group-actions:popover-open .project-new-chat')?.textContent==='新建对话'`);
  assert.equal(await js(`document.activeElement.classList.contains('project-new-chat')`),true);
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);
  assert.equal(await js(`document.querySelector('#projects .project-directory').textContent`),'research');
  assert.equal(await js(`document.querySelector('#projects .project-directory').title`),'/workspace/research');
  assert.equal(await js(`document.querySelector('.project-chat-location').textContent.includes('/workspace')`),false);
  assert.equal(await js(`document.querySelector('.project-chat-location').textContent.includes('high')`),true);
  await js(`${openChatMenu}document.querySelector('.project-chat-action').click();document.querySelector('dialog input').value='研究计划';document.querySelector('dialog .primary').click()`);
  await wait(`!document.querySelector('dialog')`);assert.equal(sessions[0].title,'研究计划');
  await wait(`!document.querySelector('.project-chat-proxy').disabled`);
  await js(`${openChatMenu}document.querySelector('.project-chat-proxy').click()`);
  await wait(`document.querySelector('.project-chat-proxy').getAttribute('aria-pressed')==='false'`);assert.equal(policy.sessions.fixture,false);
  sessions.push({instanceId:'external',title:'补充资料',kind:'agent',cwd:'/workspace/references/外部文献',model:'gpt-6-astra',projectExternal:true});projects[0].sessionIds.push('external');
  // Simulate creation through a plugin/another client. No local store update,
  // tab switch or management dialog should be needed to see the new member.
  await wait(`!!document.querySelector('.project-chat-directory:not([hidden])')`,350);
  assert.equal(await js(`document.querySelector('.project-chat-directory:not([hidden])').textContent`),'其他目录 · 外部文献');
  assert.equal(await js(`document.querySelector('.project-chat-directory:not([hidden])').title`),'/workspace/references/外部文献');
  await fs.promises.writeFile('/tmp/ashub-project-directory.png',(await win.webContents.capturePage()).toPNG());
  const initialOrder=await js(`Array.from(document.querySelectorAll('.project-chat'),a=>a.pathname)`);
  assert.deepEqual(initialOrder,['/fixture/','/external/']);
  const externalPin=`document.querySelector('.project-chat[href="/external/"]').closest('.project-chat-row').querySelector('.project-chat-pin')`;
  await js(externalPin+`.closest('.project-chat-row').querySelector('.project-more').click();`+externalPin+'.click()');
  await wait(`document.querySelector('.project-chat').pathname==='/external/' && ${externalPin}.getAttribute('aria-pressed')==='true'`);
  await js(externalPin+`.closest('.project-chat-row').querySelector('.project-more').click();`+externalPin+'.click()');
  await wait(`document.querySelector('.project-chat').pathname==='/fixture/' && ${externalPin}.getAttribute('aria-pressed')==='false'`);
  sessions.pop();projects[0].sessionIds.pop();
  await wait(`!document.querySelector('.project-chat-directory:not([hidden])') && !!document.querySelector('.project-group-actions button')`,350);
  await js(`${openGroupMenu}document.querySelector('.project-group-actions:popover-open .project-new-chat').click()`);
  await wait(`!!document.querySelector('dialog input[name=title]')`);
  assert.equal(await js(`document.querySelector('dialog .project-directory').textContent`),'/workspace/research');
  assert.equal(await js(`document.querySelector('dialog input[name=cwd]')===null`),true);
  assert.equal(await js(`document.querySelector('dialog input[type=checkbox]').checked`),false);
  await js(`document.querySelector('dialog .primary').click()`);
  await wait(`document.querySelector('dialog .project-error').textContent.includes('Fixture')`);
  assert.deepEqual(submissions[0],{projectId:'project',cwd:'/workspace/research',isolated:false});
  await js(`document.querySelector('dialog input[type=checkbox]').click();document.querySelector('dialog .primary').click()`);
  await wait(`!document.querySelector('dialog .primary').disabled`);
  assert.equal(submissions[1].isolated,true);
  await js(`document.querySelector('dialog input[name=title]').value='文献复核';document.querySelector('.project-model-toggle').click()`);
  await wait(`document.querySelectorAll('.project-model-option').length===3`);
  await js(`document.querySelectorAll('.project-model-option')[1].click()`);
  assert.deepEqual(await js(`Array.from(document.querySelectorAll('.project-choices')[0].children,b=>b.textContent)`),['默认','low','high','max']);
  await js(`document.querySelectorAll('.project-choices')[0].lastChild.click();document.querySelectorAll('.project-choices')[1].lastChild.click();document.querySelector('dialog .primary').click()`);
  await wait(`!document.querySelector('dialog .primary').disabled`);
  assert.deepEqual(submissions[2],{projectId:'project',cwd:'/workspace/research',isolated:true,title:'文献复核',model:'gpt-6-astra',provider:'codex',thinking:'max',proxyEnabled:false});
  await js(`document.querySelector('.project-model-toggle').click();document.querySelectorAll('.project-model-option')[2].click()`);
  assert.deepEqual(await js(`Array.from(document.querySelectorAll('.project-choices')[0].children,b=>b.textContent)`),['默认']);
  for(const width of [1180,390]){
   win.setContentSize(width,850);await new Promise(r=>setTimeout(r,80));
   const bounds=await js(`(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return {left:r.left,right:r.right,screen:innerWidth,overflow:d.scrollWidth-d.clientWidth};})()`);
   assert(bounds.left>=0&&bounds.right<=bounds.screen&&bounds.overflow<=1,JSON.stringify(bounds));
   await fs.promises.writeFile(`/tmp/ashub-project-create-${width}.png`,(await win.webContents.capturePage()).toPNG());
  }
  await js(`document.querySelector('dialog').close()`);
  await wait(`!document.querySelector('dialog')`);
  await js(`(async()=>{(await import('/js/projects.js')).createProject();document.querySelector('dialog input').value='新项目'})()`);
  assert.equal(await js(`document.querySelector('dialog input[name=cwd]').required`),true);
  assert.equal(await js(`document.querySelector('dialog form').checkValidity()`),false);
  await js(`document.querySelector('dialog input[name=cwd]').value='/workspace/new-project'`);
  assert.equal(await js(`document.querySelector('dialog form').checkValidity()`),true);
  for(const width of [1180,390]) {
    win.setContentSize(width,850);await new Promise(r=>setTimeout(r,80));
    const bounds=await js(`(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return {left:r.left,right:r.right,screen:innerWidth,overflow:d.scrollWidth-d.clientWidth};})()`);
    assert(bounds.left>=0&&bounds.right<=bounds.screen&&bounds.overflow<=1,JSON.stringify(bounds));
    await fs.promises.writeFile('/tmp/ashub-project-root-'+width+'.png',(await win.webContents.capturePage()).toPNG());
  }
  await js(`document.querySelector('dialog').close()`);await wait(`!document.querySelector('dialog')`);
  await js(`${openGroupMenu}document.querySelector('.project-group .project-manage').click();document.querySelector('dialog .project-delete').click()`);
  assert.equal(await js(`document.querySelector('.project-delete-options').hidden`),false);
  assert.equal(await js(`document.querySelector('.project-delete-options input').checked`),true);
  for (const width of [1180,390]) {
    win.setContentSize(width,850);await new Promise(r=>setTimeout(r,80));
    const bounds=await js(`(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return {left:r.left,right:r.right,screen:innerWidth,overflow:d.scrollWidth-d.clientWidth};})()`);
    assert(bounds.left>=0&&bounds.right<=bounds.screen&&bounds.overflow<=1,JSON.stringify(bounds));
    await fs.promises.writeFile('/tmp/ashub-project-delete-'+width+'.png',(await win.webContents.capturePage()).toPNG());
  }
  await js(`document.querySelector('dialog').close()`);
  await wait(`!document.querySelector('dialog')`);
  await js(`${openChatMenu}document.querySelector('.project-chat-delete').click()`);
  assert.equal(deletes,0,'opening confirmation deleted the conversation');
  assert.equal(await js(`document.querySelector('dialog input[value=keep]').checked`),true);
  for(const width of [1180,390]) {
    win.setContentSize(width,850);await new Promise(r=>setTimeout(r,80));
    const bounds=await js(`(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return {left:r.left,right:r.right,screen:innerWidth,overflow:d.scrollWidth-d.clientWidth};})()`);
    assert(bounds.left>=0&&bounds.right<=bounds.screen&&bounds.overflow<=1,JSON.stringify(bounds));
    await fs.promises.writeFile('/tmp/ashub-project-remove-'+width+'.png',(await win.webContents.capturePage()).toPNG());
  }

  await js(`document.querySelector('dialog').close()`);
  await wait(`!document.querySelector('dialog')`);
  assert.equal(deletes,0,'cancel deleted the conversation');
  await js(`${openChatMenu}document.querySelector('.project-chat-delete').click();document.querySelector('dialog input[value=delete]').click();document.querySelector('dialog .project-chat-confirm').click()`);
  await wait(`document.querySelector('dialog .project-error').textContent.includes('delete failed')`);
  assert.equal(await js(`!!document.querySelector('.project-chat')`),true,'failed delete hid the conversation');
  failDelete=false;
  await js(`(async()=>{const m=await import('/js/session-manager.js');m.openTabs.value=['fixture'];m.activeSessionId.value='fixture';document.querySelector('dialog .project-chat-confirm').click();document.querySelector('dialog .project-chat-confirm').click();})()`);
  await wait(`!document.querySelector('dialog') && !document.querySelector('.project-chat')`);
  assert.equal(deletes,2,'duplicate delete while pending');
  assert.deepEqual(await js(`(async()=>{const m=await import('/js/session-manager.js');return [m.activeSessionId.value,m.openTabs.value]})()`),['',[]]);
  // Exercise the real sidebar reconciliation, including rows already in the DOM.
  const now=Date.now();
  sessions.push({instanceId:'aaaaaa',title:'Older',kind:'agent',cwd:'/workspace',lastModified:now-2000}, {instanceId:'bbbbbb',title:'Recent',kind:'agent',cwd:'/workspace',lastModified:now-1000});
  win.setContentSize(1180,850);
  await js(`import('/js/sidebar.js').then(()=>true)`);
  const order=`Array.from(document.querySelectorAll('#sessions li[data-session-id]'),n=>n.dataset.sessionId).join(',')`;
  await wait(`${order}==='bbbbbb,aaaaaa'`);
  const refresh=async expected=>{await js(`document.dispatchEvent(new CustomEvent('ash:sessions-changed'))`);await wait(`${order}===${JSON.stringify(expected)}`);};
  sessions.push({instanceId:'cccccc',title:'New',kind:'agent',cwd:'/workspace',startedAt:now});
  await refresh('cccccc,bbbbbb,aaaaaa');
  sessions[0].lastModified=now+1000;
  await refresh('aaaaaa,cccccc,bbbbbb');
  pinned=['bbbbbb'];sessions[1].title='Pinned';
  await refresh('bbbbbb,aaaaaa,cccccc');
  await js(`document.querySelector('#sessions [data-session-id="bbbbbb"] .session-edit').click()`);
  assert.equal(await js(`document.querySelector('#sessions .session-title-edit').value`),'Pinned','reused row opened a stale title');
  await js(`document.querySelector('#sessions .session-title-edit').dispatchEvent(new Event('blur'))`);
  await js(`document.querySelector('#sessions [data-session-id="bbbbbb"] .session-close').click()`);
  assert((await js(`document.querySelector('#sessions [data-session-id="bbbbbb"] .session-close').title`)).includes('Pinned'),'delete confirmation uses a stale title');
  await js(`document.querySelector('#sessions [data-session-id="bbbbbb"] .session-archive-btn').click()`);
  assert((await js(`document.querySelector('#sessions [data-session-id="bbbbbb"] .session-archive-btn').title`)).includes('Pinned'),'archive confirmation uses a stale title');
  sessions[1].title='Live title';
  await js(`import('/js/sidebar.js').then(m=>m.updateSessionTitle('bbbbbb','Live title'))`);
  await js(`document.querySelector('#sessions [data-session-id="bbbbbb"] .session-edit').click()`);
  assert.equal(await js(`document.querySelector('#sessions .session-title-edit').value`),'Live title','live title was stale before the list fetch');
  await js(`document.querySelector('#sessions .session-title-edit').dispatchEvent(new Event('blur'))`);
  sessions[0].lastModified=now-3*86400000;
  await refresh('bbbbbb,cccccc,aaaaaa');
  // A refresh during an inline rename must not blur, commit, or lose the input.
  await js(`document.querySelector('#sessions [data-session-id="aaaaaa"] .session-edit').click()`);
  sessions[0].lastModified=now+2000;
  await js(`document.dispatchEvent(new CustomEvent('ash:sessions-changed'))`);
  await new Promise(r=>setTimeout(r,100));
  assert.equal(await js(`!!document.querySelector('#sessions .session-title-edit')`),true);
  assert.equal(await js(order),'bbbbbb,cccccc,aaaaaa');
  await js(`document.querySelector('#sessions .session-title-edit').dispatchEvent(new Event('blur'))`);
  await wait(`${order}==='bbbbbb,aaaaaa,cccccc'`);
  await js(`document.querySelector('#sessions [data-session-id="aaaaaa"] .session-edit').click()`);
  pinned=['cccccc'];
  await js(`import('/js/sidebar.js').then(m=>m.auditRenderSessions(false,{refreshPinned:true}))`);
  assert.equal(await js(order),'bbbbbb,aaaaaa,cccccc','pin refresh moved a live editor');
  await js(`document.querySelector('#sessions .session-title-edit').dispatchEvent(new Event('blur'))`);
  await wait(`${order}==='cccccc,aaaaaa,bbbbbb'`);
  pinned=['bbbbbb'];
  await js(`import('/js/sidebar.js').then(m=>m.auditRenderSessions(false,{refreshPinned:true}))`);
  await js(`document.querySelector('#sessions [data-session-id="aaaaaa"] .session-edit').click()`);
  sessions.splice(0,1);
  await refresh('bbbbbb,cccccc');
  assert.equal(await js(`!!document.querySelector('#sessions .session-title-edit')`),false,'removed rename row stranded reconciliation');
  // Project membership changes must invalidate both sidebar and store caches.
  sessions[0].projectId='project'; await refresh('cccccc');
  assert(await js(`import('/js/store.js').then(m=>m.allSessions.value.some(s=>s.instanceId==='bbbbbb'&&s.projectId==='project'))`));
  sessions.push({instanceId:'dddddd',title:'Created in project',kind:'agent',cwd:'/workspace',startedAt:now,projectId:'project'});
  await js(`import('/js/sidebar.js').then(m=>m.auditRenderSessions())`);
  assert.equal(await js(order),'cccccc');
  sessions[0].projectId=null; await refresh('bbbbbb,cccccc');
  // A row moved into a project while being renamed must not remain stuck here.
  await js(`document.querySelector('#sessions [data-session-id="cccccc"] .session-edit').click()`);
  sessions[1].projectId='project'; await refresh('bbbbbb');
  assert.equal(await js(`!!document.querySelector('#sessions .session-title-edit')`),false);
  console.log('PASS project creation, confirmed deletion/failure/retry/tab cleanup, sidebar creation/activity/buckets/pinning/rename order');

  const countBefore = sessions.length;
  for (let p = 0; p < 40; p++) {
    const id = `scale-${p}`, cwd = `/fixture/group-${p}`, sessionIds = [];
    for (let s = 0; s < (!p ? 120 : 8); s++) {
      const instanceId = (0x40000 + p*120 + s).toString(16);
      sessionIds.push(instanceId);
      const title = p===0 && s===0 ? '调度中枢' : p===29 && s===1 ? '发布检查' : `用于检查窄栏标题显示的长对话 ${s}`;
      sessions.push({instanceId,projectId:id,title,cwd,kind:'agent'});
    }
    projects.push({id,cwd,name:p===0 ? '发布准备' : `项目 ${p}`,sessionIds,...(p===0 || p===29 ? {pinnedSessionIds:[sessionIds[0]]} : {})});
  }
  sessions.push({instanceId:'abc999',title:'发布检查',cwd:'/standalone',kind:'agent'});
  assert.equal(sessions.length-countBefore,433);
  const target = projects.find(p=>p.id==='scale-29').sessionIds[1];
  await js(`(async()=>{await import('/js/prefs.js');localStorage.setItem('ash.sidebar-width','260');document.querySelector('.app').style.setProperty('--sidebar-w','260px');(await import('/js/sidebar.js')).sidebarView.value='projects'})()`);
  await wait(`document.querySelectorAll('.project-toggle').length===41`);
  const result = await js(`(()=>{const list=document.querySelector('#projects');const headings=[...list.querySelectorAll('.project-toggle')];return {first:headings.filter(el=>el.getBoundingClientRect().bottom<=list.getBoundingClientRect().bottom).length,expanded:headings.filter(el=>el.getAttribute('aria-expanded')==='true').length};})()`);
  assert(result.first>=10,JSON.stringify(result));assert.equal(result.expanded,1,'only the previously expanded fixture project should be open');
  await js(`window.projectList=document.querySelector('#projects');projectList.scrollTop=projectList.scrollHeight;window.previousTop=projectList.scrollTop;document.querySelector('#sidebar-search-toggle').click()`);
  await wait(`document.activeElement?.id==='sidebar-find-input'`);
  const findKey = key => js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,cancelable:true,key:${JSON.stringify(key)}}))`);
  await findKey('Escape');
  assert.equal(await js(`document.querySelector('#sidebar-find').hidden && projectList.scrollTop===previousTop && document.activeElement.id==='sidebar-search-toggle'`),true);
  const search = () => js(`(()=>{document.querySelector('#sidebar-search-toggle').click();const field=document.querySelector('#sidebar-find-input');field.value='发布检查';field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await search();
  await wait(`document.querySelectorAll('#sidebar-find [role=option]').length===2`);
  const options=await js(`Array.from(document.querySelectorAll('#sidebar-find [role=option]'), el=>el.textContent)`);
  assert(options.some(s=>s.includes('项目 29')) && options.some(s=>s.includes('未归入项目')));
  if (!options[0].includes('项目 29')) await findKey('ArrowDown');
  await findKey('Enter');
  await wait(`location.pathname==='/'+${JSON.stringify(target)}+'/' && document.activeElement.classList.contains('project-chat')`);
  assert(await js(`document.activeElement.getAttribute('aria-current')==='page'`));
  assert(await js(`document.querySelector('[data-project-id="scale-29"]').getAttribute('aria-expanded')==='true'`));
  assert(await js(`(() => {
    const toggle = document.querySelector('[data-project-id="scale-29"]');
    return toggle.getAttribute('aria-current') === 'true' &&
      getComputedStyle(toggle).backgroundColor === 'rgba(0, 0, 0, 0)' &&
      getComputedStyle(document.querySelector('.project-chat.current')).backgroundColor !== 'rgba(0, 0, 0, 0)';
  })()`), 'expanded project is a location cue, not a second selected row');
  await js(`window.focusedBefore=document.activeElement;window.topBefore=focusedBefore.getBoundingClientRect().top;`);
  sessions.find(s=>s.projectId==='scale-10').waitingApproval=true;
  await js(`document.dispatchEvent(new CustomEvent('ash:sessions-changed'))`);
  await wait(`document.querySelector('[data-project-id="scale-10"] .project-summary:not([hidden])')!==null`);
  assert(await js(`document.activeElement===focusedBefore && Math.abs(focusedBefore.getBoundingClientRect().top-topBefore)<=2`));
  await js(`document.querySelector('.app').style.setProperty('--sidebar-w','200px');document.activeElement.closest('.project-chat-row').querySelector('.project-more').focus()`);
  const titleWidth=await js(`document.querySelector('[data-project-group="scale-29"] .project-other-list .project-chat:not(.current) .project-chat-name').getBoundingClientRect().width`);
  assert(titleWidth>100,`long title has only ${titleWidth}px at 200px sidebar width`);
  await js(`document.activeElement.click()`);
  assert(await js(`!!document.activeElement.closest('.project-menu:popover-open')`));
  await findKey('Escape');
  assert(await js(`!document.querySelector('.project-menu:popover-open') && document.activeElement.classList.contains('project-more')`));
  win.setContentSize(390,850);
  await wait(`innerWidth<=700`);
  await search();
  await wait(`document.activeElement?.id==='sidebar-find-input'`);
  await findKey('Escape');
  assert(await js(`document.querySelector('#sidebar-find').hidden && !document.querySelector('.app').classList.contains('sidebar-collapsed')`));
  await search();
  await wait(`document.querySelectorAll('#sidebar-find [role=option]').length===2`);
  await js(`Array.from(document.querySelectorAll('#sidebar-find [role=option]')).find(o=>o.textContent.includes('未归入项目')).click()`);
  await wait(`location.pathname==='/abc999/' && document.querySelector('.app').classList.contains('sidebar-collapsed')`);
  await js(`document.querySelector('#sidebar-toggle').click()`);
  await search();
  await wait(`document.querySelectorAll('#sidebar-find [role=option]').length===2`);
  await js(`Array.from(document.querySelectorAll('#sidebar-find [role=option]')).find(o=>o.textContent.includes('项目 29')).click()`);
  await wait(`location.pathname==='/'+${JSON.stringify(target)}+'/' && document.querySelector('.app').classList.contains('sidebar-collapsed')`);
  await js(`document.querySelector('#sidebar-toggle').click()`);
  assert(await js(`document.querySelector('[data-project-id="scale-29"]').getAttribute('aria-expanded')==='true' && document.querySelector('.project-chat.current')?.pathname===location.pathname`));
  console.log('PASS 40-project / 432-conversation directory, same-name navigation, Escape and scroll restoration, live focus, 200px and narrow layouts', JSON.stringify(result));

  win.setContentSize(1180,850);
  await wait(`innerWidth>700`);
  assert(await js(`document.querySelector('[data-project-group="scale-29"] .project-other-toggle').getAttribute('aria-expanded')==='true'`), 'search must expand a folded match');
  assert(await js(`!localStorage.getItem('ash.project-others-expanded')`), 'search must not change the saved disclosure');
  const large = projects.find(p=>p.id==='scale-0'), [coordinator, approver, done] = large.sessionIds;
  Object.assign(sessions.find(s=>s.instanceId===coordinator),{isProcessing:true,queuedCount:3});
  Object.assign(sessions.find(s=>s.instanceId===approver),{waitingApproval:true,isProcessing:true});
  Object.assign(sessions.find(s=>s.instanceId===done),{hasUnread:true});
  await js(`document.dispatchEvent(new CustomEvent('ash:sessions-changed'));document.querySelector('[data-project-id="scale-0"]').click()`);
  const group = `document.querySelector('[data-project-group="scale-0"]')`;
  const disclosure = `${group}.querySelector('.project-other-toggle')`;
  const metrics = `${group}.querySelector('.project-other-status')`;
  const visibleRows = `Array.from(${group}.querySelectorAll('.project-chat')).filter(n=>n.getClientRects().length).length`;
  await wait(`${metrics}?.textContent.includes('1 项执行中')`);
  assert.equal(await js(`${disclosure}.getAttribute('aria-expanded')`),'false');
  assert.equal(await js(`${metrics}.hidden`),false);
  assert.equal(await js(`${group}.querySelector('.project-other-count').textContent`),'119');
  assert.equal(await js(visibleRows),1);
  assert.deepEqual(await js(`Array.from(${metrics}.querySelectorAll('.project-other-metric:not([hidden])'), n=>n.textContent)`),['1 项待处理','1 项执行中','1 个对话有排队','1 项新结果']);
  assert(await js(`(() => {const button=${disclosure}, bounds=button.getBoundingClientRect();return bounds.width>120 && [...button.querySelectorAll('span:not([hidden])')].every(n=>n.getBoundingClientRect().right<=bounds.right+1);})()`), 'status must fit at the 200px sidebar width');
  await js(`${disclosure}.scrollIntoView({block:'center'});${disclosure}.focus()`);
  const debug = win.webContents.debugger;
  debug.attach('1.3');
  try {
    const press = async (key, code, n) => {
      await debug.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:n,text:key==='Enter'?'\r':key});
      await debug.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:n});
    };
    await press('Enter','Enter',13);
    assert.equal(await js(visibleRows),120);
    assert.equal(await js(`${metrics}.hidden`),true,'expanded list does not repeat the visual status summary');
    assert.equal(await js(`localStorage.getItem('ash.project-others-expanded')`),'["scale-0"]');
    await press(' ','Space',32);
    assert.equal(await js(visibleRows),1);
    assert(await js(`document.activeElement===${disclosure}`));
  } finally { debug.detach(); }
  if (process.env.ASHUB_PROJECT_PREVIEW) {
    const clip = await js(`(async () => {
      ${disclosure}.blur(); ${group}.scrollIntoView({block:'center'});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const {left,top,right,bottom}=${group}.getBoundingClientRect();
      return {x:Math.floor(left-8),y:Math.floor(top-8),width:Math.ceil(right-left+16),height:Math.ceil(bottom-top+16)};
    })()`);
    fs.writeFileSync(process.env.ASHUB_PROJECT_PREVIEW,(await win.webContents.capturePage(clip)).toPNG());
  }
  if (process.env.ASHUB_PROJECT_SIDEBAR_PREVIEW_DIR) {
    await js(`(async () => {
      const { switchTo } = await import('/js/session-manager.js');
      await switchTo(${JSON.stringify(coordinator)});
      document.activeElement?.blur();
    })()`);
    await wait(`${group}.querySelector('.project-chat.current')`);
  }
  for (const theme of ['light', 'dark']) {
    const fits = await js(`(() => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      document.querySelector('.app').style.setProperty('--sidebar-w','145px');
      const list = document.querySelector('#projects'), group = ${group};
      const header = group.querySelector('.project-toggle'), title = group.querySelector('.project-name');
      const controls = group.querySelector('.project-heading .project-more');
      const row = group.querySelector('.project-chat');
      const style = getComputedStyle(group.querySelector('.project-details'));
      return list.scrollWidth <= list.clientWidth + 1 && title.clientWidth >= 46 &&
        header.getBoundingClientRect().right < controls.getBoundingClientRect().left &&
        row.querySelector('.project-chat-name').clientWidth >= 48 && style.borderInlineStartWidth === '1px';
    })()`);
    assert(fits, `project title, row and fixed controls must fit at 145px in ${theme}`);
    if (process.env.ASHUB_PROJECT_SIDEBAR_PREVIEW_DIR) {
      const bounds = await js(`(async () => {
        document.querySelector('.app').style.setProperty('--sidebar-w','256px');
        document.querySelector('#projects').scrollTop = 0;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.allSettled(document.querySelector('.sidebar').getAnimations({subtree:true})
          .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished));
        const {left, top, right, bottom} = document.querySelector('.sidebar').getBoundingClientRect();
        return {x: Math.ceil(left), y: Math.ceil(top), width: Math.floor(right-left), height: Math.min(520, Math.floor(bottom-top))};
      })()`);
      fs.writeFileSync(path.join(process.env.ASHUB_PROJECT_SIDEBAR_PREVIEW_DIR, `project-sidebar-${theme}.png`), (await win.webContents.capturePage(bounds)).toPNG());
    }
  }
  console.log('PASS pinned project folds 119 conversations, keyboard disclosure, selected hierarchy, and constrained light/dark layouts');
 }finally{win?.destroy();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());clearTimeout(watchdog);fs.rmSync(tmp,{recursive:true,force:true});}
}).then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
