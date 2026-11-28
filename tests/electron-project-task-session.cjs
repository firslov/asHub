// Real renderer and loopback Hub; mocked Antigravity bridge, no login or CLI.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { env, Bridge, root, path } = require('./harness.cjs');
const fixture = env({ globals: { setTimeout, clearTimeout, setInterval, clearInterval } });
fixture.clock(Date.now());
app.setPath('userData', path.join(fixture.dir, 'project-task-profile'));
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('Project task UI watchdog'); app.exit(1); }, 35000);

app.whenReady().then(async () => {
  const coordinators = new Map(), direct = [];
  let taskRuns = 0, cancellations = 0, win;
  const hub = fixture.hub().startHub({
    host:'127.0.0.1', port:0, webRoot:path.join(root, 'web'),
    projectSessionBackends:[{id:'google-antigravity',label:'Fixture Antigravity',kind:'antigravity',taskProfile:'inline-review',authorization:'project'}],
    makeBridge:opts=>{coordinators.set(opts.sessionId,opts.conversationAccess);return Object.assign(new Bridge(opts),{backendId:'ash'});},
    makeAntigravityBridge:opts=>{
      const bridge=Object.assign(new Bridge(opts),{backendId:'acp',readOnlyContext:true});
      bridge.submit=async query=>{direct.push([opts.sessionId,query]);return Bridge.prototype.submit.call(bridge,query);};
      bridge.submitTask=async turn=>{
        taskRuns++;
        assert.equal(turn.read().message,'Fixture project assignment');
        bridge.emit('event',{name:'agent:response-chunk',payload:{blocks:[{type:'text',text:'Fixture task history'}]}});
        await new Promise(resolve=>turn.signal.addEventListener('abort',()=>{cancellations++;resolve();},{once:true}));
        return {stopReason:'cancelled'};
      };
      return bridge;
    },
  });
  try {
    await once(hub.server,'listening');
    const base=`http://127.0.0.1:${hub.server.address().port}`;
    async function api(route,body) {
      const res=await fetch(base+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body&&JSON.stringify(body)});
      const raw=await res.text();assert(res.ok,`${route}: ${res.status} ${raw}`);return JSON.parse(raw);
    }
    const {instanceId:owner}=await api('/sessions',{cwd:fixture.dir});
    const {instanceId:standalone}=await api('/sessions',{cwd:fixture.dir,kind:'antigravity'});
    const [project]=await api('/api/projects',{action:'create',name:'Fixture project',cwd:fixture.dir,add:[owner]});
    win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,callback)=>callback({cancel:new URL(request.url).origin!==base}));
    win.webContents.on('console-message',event=>{if(event.level==='error')console.error('renderer:',event.message);});
    const js=async script=>{try{return await win.webContents.executeJavaScript(script);}catch(error){console.error('Failed renderer script:',script);throw error;}};
    async function wait(script) {
      for(let i=0;i<180;i++){if(await js(script))return;await new Promise(resolve=>setTimeout(resolve,25));}
      throw Error('UI timeout: '+script);
    }
    const active=id=>`window.__ash?.activeSessionId.peek()===${JSON.stringify(id)} && window.__ash?.sessions.get(${JSON.stringify(id)})?.state.replaying===false`;
    const turn=code=>js(`(() => {const q=document.getElementById('query');${code}})()`);
    const modelChip=()=>js(`(()=>{const chip=document.querySelector('session-view:not([hidden]) .usage-model-balance');return {label:chip.textContent,disabled:chip.disabled,hidden:chip.hidden}})()`);
    const antigravityChip={label:'Google Antigravity',disabled:true,hidden:false};
    await win.loadURL(`${base}/${owner}/`);
    await wait(active(owner));
    await js(`window.projectCreationRenderer=true; import('/js/sidebar.js').then(m=>{m.sidebarView.value='projects'})`);
    await wait(`document.querySelector('.project-heading .project-more')`);
    await js(`document.querySelector('.project-heading .project-more').click(); document.querySelector('.project-group .project-manage').click(); document.querySelector('dialog .project-add-conversation').click()`);
    await wait(`document.querySelector('dialog .project-model-toggle')`);
    await js(`document.querySelector('dialog .project-model-toggle').click()`);
    const backendOption=`[...document.querySelectorAll('dialog .project-model-option')].find(b=>b.textContent==='Fixture Antigravity')`;
    await wait(backendOption);
    await js(`${backendOption}.click(); document.querySelector('dialog .primary').click()`);
    await wait(`!document.querySelector('dialog') && window.__ash.activeSessionId.peek()!==${JSON.stringify(owner)}`);
    const list=await api('/sessions');
    const worker=list.find(s=>s.projectWorker)?.instanceId;
    assert(worker,'project create action must create a worker');
    assert.equal(list.find(s=>s.instanceId===worker)?.kind,'antigravity');
    await wait(active(worker));
    assert.equal(await js('window.projectCreationRenderer'),true,'creation must exercise same-renderer navigation');
    assert.deepEqual(await modelChip(),antigravityChip,'the new worker should show its fixed backend without reloading');
    await js(`(()=>{const real=window.fetch;window.workerWrites=[];window.fetch=(url,opts)=>{if(opts?.method==='POST'&&['submit','command','pty-input','cancel'].some(action=>String(url)==='/${worker}/'+action))workerWrites.push(String(url));return real(url,opts);}})()`);
    const first=await js(`(()=>{const v=document.querySelector('session-view:not([hidden])'),q=document.getElementById('query'),b=document.getElementById('send-btn');return {title:v.querySelector('.welcome-title').textContent,description:v.querySelector('.welcome-description').textContent,key:v.querySelector('.welcome-description').getAttribute('data-i18n'),inputDisabled:q.disabled,sendHidden:b.hidden,promptHidden:v.querySelector('.stream-empty-prompt').hidden}})()`);
    await turn(`q.value='Fixture blocked direct text';q.dispatchEvent(new Event('input',{bubbles:true}));q.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));document.querySelector('#form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));document.querySelector('session-view:not([hidden]) .hint-chip').click();`);
    await js('new Promise(resolve=>setTimeout(resolve,60))');
    console.log('Idle UI / attempt evidence', JSON.stringify({first,writes:await js('workerWrites'),workerFlag:list.find(s=>s.instanceId===worker)?.projectWorker??null}));
    assert.equal(list.find(s=>s.instanceId===worker)?.projectWorker,true);
    assert.notEqual(list.find(s=>s.instanceId===standalone)?.projectWorker,true);
    assert.equal(first.key,'project.worker.description');
    assert.deepEqual({inputDisabled:first.inputDisabled,sendHidden:first.sendHidden,promptHidden:first.promptHidden},{inputDisabled:true,sendHidden:true,promptHidden:true});
    assert.deepEqual(await js('workerWrites'),[]);
    assert.equal(await js(`['#send-btn','session-view:not([hidden]) .stream-empty-prompt','#composer-help .composer-keyboard'].every(selector=>getComputedStyle(document.querySelector(selector)).display==='none')`),true,'Direct-send controls must actually be hidden by layout');
    await js(`import('/js/i18n.js').then(({setLang})=>setLang('zh'))`);
    assert.equal(await js(`document.querySelector('session-view:not([hidden]) .welcome-title').textContent`),'项目任务会话');
    assert.match(await js(`document.getElementById('query').placeholder`),/等待项目任务派发/);
    await js(`import('/js/i18n.js').then(({setLang})=>setLang('en'))`);
    // The synthetic test above assigned to the disabled textarea via JS;
    // clear that synthetic value before testing actual tab draft behavior.
    await turn(`q.value='';q.dispatchEvent(new Event('input',{bubbles:true}));`);

    await js(`window.__ash.openTab(${JSON.stringify(standalone)})`);
    await wait(active(standalone));
    await turn(`q.value='Independent draft to keep';q.dispatchEvent(new Event('input',{bubbles:true}));`);
    assert.equal(await js(`document.querySelector('session-view:not([hidden]) .welcome-description').getAttribute('data-i18n')`),'antigravity.session.hint');
    assert.equal(await js(`document.getElementById('query').disabled || document.getElementById('send-btn').hidden || document.getElementById('send-btn').disabled`),false);
    await js(`import('/js/sidebar.js').then(m=>{m.sidebarView.value='projects'})`);
    const projectToggle=`document.querySelector('[data-project-id="${project.id}"]')`;
    await wait(`${projectToggle}?.querySelector('.project-count')?.textContent==='2'`);
    await js(`if(${projectToggle}.getAttribute('aria-expanded')==='false') ${projectToggle}.click()`);
    const workerLink=`document.querySelector('.project-chat[href="/${worker}/"]')`;
    try {await wait(workerLink);} catch(error) {
      console.error('Project navigation state',await js(`(async()=>({expanded:${projectToggle}?.getAttribute('aria-expanded'),projects:(await import('/js/projects.js')).sidebarProjects.peek(),sessions:(await import('/js/store.js')).allSessions.peek().map(s=>[s.instanceId,s.kind,s.projectWorker]),visible:document.querySelector('#projects')?.innerText,links:[...document.querySelectorAll('.project-chat')].map(a=>a.getAttribute('href'))}))()`));
      throw error;
    }
    await js(`${workerLink}.click()`);
    await wait(active(worker));
    assert.deepEqual(await modelChip(),antigravityChip,'switching back should keep the Antigravity label');
    assert.equal(await js('document.getElementById("query").value'),'');
    await assert.rejects(coordinators.get(owner).send(worker,'Fixture project assignment'), /not authorized/);
    hub.antigravityReviewPolicy(project.id,true);
    await coordinators.get(owner).send(worker,'Fixture project assignment');
    await wait(`document.getElementById('send-btn').classList.contains('busy') && !document.getElementById('send-btn').hidden && !document.getElementById('send-btn').disabled`);
    await wait(`document.querySelector('session-view:not([hidden]) .session-stream').textContent.includes('Fixture task history')`);
    assert.equal(await js(`document.getElementById('query').disabled`),true);
    await js(`document.getElementById('send-btn').click()`);
    await wait(`!document.getElementById('send-btn').classList.contains('busy') && document.getElementById('send-btn').hidden`);
    assert.equal(taskRuns,1);assert.equal(cancellations,1);
    assert.deepEqual(await js('workerWrites'),[`/${worker}/cancel`]);
    await js(`window.__ash.switchTo(${JSON.stringify(standalone)})`);
    await wait(active(standalone));
    assert.equal(await js('document.getElementById("query").value'),'Independent draft to keep');
    await win.loadURL(`${base}/${worker}/`);
    await wait(active(worker));
    assert.deepEqual(await modelChip(),antigravityChip,'reloading an existing worker should keep the Antigravity label');
    await wait(`document.querySelector('session-view:not([hidden]) .session-stream').textContent.includes('Fixture task history')`);
    assert.equal(await js(`document.getElementById('query').disabled`),true);

    // Drafts belong to the original view, and remain editable and sendable.
    // Repeat the round trip after reload, since in-memory drafts do not persist across reload.
    await js(`window.__ash.switchTo(${JSON.stringify(standalone)})`);
    await wait(active(standalone));
    await turn(`q.value='Independent final draft';q.dispatchEvent(new Event('input',{bubbles:true}));`);
    await js(`window.__ash.switchTo(${JSON.stringify(worker)});window.__ash.switchTo(${JSON.stringify(standalone)})`);
    await wait(active(standalone));
    assert.equal(await js('document.getElementById("query").value'),'Independent final draft');
    await js(`document.getElementById('send-btn').click()`);
    await wait(`document.querySelector('session-view:not([hidden]) .session-stream').textContent.includes('Independent final draft')`);
    for(let i=0;i<100&&!direct.length;i++) await new Promise(resolve=>setTimeout(resolve,20));
    assert.deepEqual(direct,[[standalone,'Independent final draft']]);
    console.log('PASS task-only welcome and submit gating, real task cancellation and replay, independent Antigravity draft and send');
  } finally {win?.destroy();await hub.shutdown();}
}).then(()=>{clearTimeout(watchdog);app.exit(0);},err=>{clearTimeout(watchdog);console.error(err);app.exit(1);});
