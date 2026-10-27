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
 const projects = [{ id:'project',name:'论文审阅',sessionIds:['fixture'] }];
 let policy={proxyEnabled:true,sessions:{}};
 const submissions = []; let deletes=0, failDelete=true; let pinned=[];
 try {
  server=http.createServer(async(req,res)=>{
   const json = value => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
   if(req.url==='/fixture/' && req.method==='DELETE'){deletes++;if(failDelete){res.statusCode=500;return json({error:'delete failed'});}await new Promise(r=>setTimeout(r,60));sessions.splice(0,1);return json({ok:true});}
   if(req.url==='/api/sessions/pinned')return json({pinned});
   if(req.url==='/api/models')return json({providers:[{name:'codex',models:[{id:'gpt-6-astra',thinkingLevels:['low','high','max']},{id:'plain',thinkingLevels:[]}]}]});
   if(req.url==='/fixture/title') {let raw='';for await(const c of req)raw+=c;sessions[0].title=JSON.parse(raw).title;return json({ok:true,title:sessions[0].title});}
   if(req.url==='/api/settings/network'){if(req.method==='PUT'){let raw='';for await(const c of req)raw+=c;const b=JSON.parse(raw);if(b.enabled===null)delete policy.sessions[b.session];else policy.sessions[b.session]=b.enabled;}return json(policy);}
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
  win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false}});
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  const js=async s=>{try{return await win.webContents.executeJavaScript(s)}catch(e){console.error('Failed script:',s);throw e;}};
  win.webContents.on('console-message',event=>{if(event.level==='error')console.log('renderer:',event.message);});
  const wait=async s=>{for(let i=0;i<100;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI timeout: '+s);};
  await js(`document.getElementById('page-loader').remove();localStorage.setItem('ash.lang','zh');(async()=>{const s=await import('/js/store.js');s.setSessions(${JSON.stringify(sessions)});const p=await import('/js/projects.js');p.showProjects(true);})()`);
  await wait(`!!document.querySelector('.project-group-actions button')`);
  assert.equal(await js(`document.querySelector('.project-group-actions button').textContent`),'新建对话');
  assert.equal(await js(`document.querySelector('.project-directory').textContent`),'/workspace/research');
  assert.equal(await js(`document.querySelector('.project-chat-location').textContent.includes('/workspace')`),false);
  assert.equal(await js(`document.querySelector('.project-chat-location').textContent.includes('high')`),true);
  await js(`document.querySelector('.project-chat-action').click();document.querySelector('dialog input').value='研究计划';document.querySelector('dialog .primary').click()`);
  await wait(`!document.querySelector('dialog')`);assert.equal(sessions[0].title,'研究计划');
  await wait(`!document.querySelector('.project-chat-proxy').disabled`);
  await js(`document.querySelector('.project-chat-proxy').click()`);
  await wait(`document.querySelector('.project-chat-proxy').getAttribute('aria-pressed')==='false'`);assert.equal(policy.sessions.fixture,false);
  sessions.push({instanceId:'external',title:'补充资料',kind:'agent',cwd:'/workspace/references/外部文献',model:'gpt-6-astra',projectExternal:true});projects[0].sessionIds.push('external');
  await js(`(async()=>{const store=await import('/js/store.js');store.setSessions(${JSON.stringify(sessions)});const p=await import('/js/projects.js');p.showProjects(false);p.showProjects(true);})()`);
  await wait(`!!document.querySelector('.project-chat-directory')`);
  assert.equal(await js(`document.querySelector('.project-chat-directory').textContent`),'其他目录 · 外部文献');
  assert.equal(await js(`document.querySelector('.project-chat-directory').title`),'/workspace/references/外部文献');
  await fs.promises.writeFile('/tmp/ashub-project-directory.png',(await win.webContents.capturePage()).toPNG());
  sessions.pop();projects[0].sessionIds.pop();
  await js(`(async()=>{const store=await import('/js/store.js');store.setSessions(${JSON.stringify(sessions)});const p=await import('/js/projects.js');p.showProjects(false);p.showProjects(true);})()`);
  await wait(`!document.querySelector('.project-chat-directory') && !!document.querySelector('.project-group-actions button')`);
  await js(`document.querySelector('.project-group-actions button').click()`);
  assert.equal(await js(`document.querySelector('dialog input[type=text]:not([name=title])').value`),'/workspace/research');
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
  await js(`document.querySelector('.project-group .project-manage').click();document.querySelector('dialog .project-delete').click()`);
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
  await js(`document.querySelector('.project-chat-delete').click()`);
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
  await js(`document.querySelector('.project-chat-delete').click();document.querySelector('dialog input[value=delete]').click();document.querySelector('dialog .project-chat-confirm').click()`);
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
 }finally{win?.destroy();server?.closeAllConnections();await new Promise(r=>server?server.close(r):r());clearTimeout(watchdog);fs.rmSync(tmp,{recursive:true,force:true});}
}).then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
