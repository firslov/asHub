// Isolated integration: a pending Antigravity replacement must survive creation.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { env, Bridge, fs, path, root } = require('./harness.cjs');
const fixture = env();
app.setPath('userData', path.join(fixture.dir, 'browser'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => app.exit(1), 30000);
app.whenReady().then(async () => {
  let hub, win;
  try {
    hub = fixture.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),
      makeBridge: opts => Object.assign(new Bridge(opts),{backendId:'ash'}),
      makeAntigravityBridge: opts => Object.assign(new Bridge(opts),{backendId:'acp',readOnlyContext:true})});
    await once(hub.server,'listening');
    const base='http://127.0.0.1:'+hub.server.address().port;
    const api=async (url,body)=>{const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});assert(r.ok,`${url}: ${r.status}`);return r.json();};
    const preload=path.join(fixture.dir,'preload.cjs');
    fs.writeFileSync(preload,"require('electron').contextBridge.exposeInMainWorld('electronAPI',{pickDirectory:async()=>({cancelled:true}),onUpdateAvailable(){},onUpdateDownloadProgress(){},onUpdateDownloaded(){},onUpdateError(){}})");
    win=new BrowserWindow({show:false,width:1180,height:850,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
    win.webContents.on('console-message', event=>{if(event.level==='error')console.error('renderer',event.message)});
    const js=code=>win.webContents.executeJavaScript(code);
    const wait=async code=>{for(let n=0;n<200;n++){if(await js(code))return;await new Promise(r=>setTimeout(r,20));}console.log('state',await js('[...window.__ash.sessions.values()].map(s=>({id:s.id,history:s.hasHistory,replay:s.state.replaying}))'));throw Error('Timed out: '+code);};
    const all=()=>api('/sessions');
    const select=view=>js(`document.querySelector('#sidebar-view-select').click();document.querySelector('.sidebar-view-option[data-view="${view}"]').click();`);
    const at=id=>`window.__ash?.activeSessionId.peek() === '${id}' && location.pathname === '/${id}/'`;
    const assertDraft=async text=>assert.equal(await js("document.getElementById('query').value"),text);
    const cases = [
      { view: 'sessions', first: 'create' },
      { view: 'sessions', first: 'acp' },
      { view: 'terminals', first: 'create', inBackground: true },
      { view: 'terminals', first: 'acp', inBackground: true },
      { view: 'sessions', first: 'create', userReturns: true },
      { view: 'sessions', first: 'acp', userReturns: true },
    ];
    for (const { view, first, inBackground, userReturns } of cases) {
      const a=await api('/sessions',{cwd:fixture.dir});
      const b=await api('/sessions',{cwd:fixture.dir});
      const width=inBackground?390:1180;
      win.setContentSize(width,850);
      await win.loadURL(base+'/'+a.instanceId+'/');
      await wait(`innerWidth === ${width}`);
      await wait(`window.__ash?.sessions.get('${a.instanceId}')?.hasHistory === false && window.__ash.sessions.get('${a.instanceId}')?.state?.replaying === false`);
      await js(`localStorage.setItem('ash.default-cwd',${JSON.stringify(fixture.dir)});(async()=>{(await import('/js/sse.js')).setModelCache({providers:[{name:'fixture',models:[{id:'fixture'}]}]});})()`);
      await js("document.getElementById('query').value='待保留的 ACP 草稿';document.querySelector('session-view:not([hidden]) .usage-model-balance').click()");
      await wait("!!document.querySelector('.model-dropdown:not([hidden]) .model-antigravity:not([hidden])')");
      const known = new Set((await all()).map(s=>s.instanceId));
      await js(`(() => {
        const native = window.fetch;
        const held = window.heldResponses = {};
        held.restore = () => { window.fetch = native; };
        window.fetch = async (url, opts) => {
          const result = await native(url, opts);
          const phase = String(url).endsWith('/backend')
            ? 'acp' : url === '/sessions' && opts?.method === 'POST' ? 'create' : '';
          if (phase) {
            const { instanceId } = await result.clone().json();
            await new Promise(resolve => { held[phase] = { instanceId, release: resolve }; });
          }
          return result;
        };
        document.querySelector('.model-dropdown:not([hidden]) .model-antigravity').click();
      })()`);
      await wait("typeof window.heldResponses?.acp?.release === 'function'");
      const before=await all();assert(!before.some(s=>s.instanceId===a.instanceId));
      const selectedReplacement=before.find(s=>s.kind==='antigravity'&&!known.has(s.instanceId))?.instanceId;
      assert(selectedReplacement);
      if(inBackground) await js(`window.__ash.openTab('${b.instanceId}');document.getElementById('query').value='另一标签草稿'`);
      if(inBackground){
        await js("if(document.querySelector('.app').classList.contains('sidebar-collapsed'))document.getElementById('sidebar-toggle').click()");
      }
      await select(view);
      await js("window.pageIdentity={};const button=document.querySelector('#sidebar-create');button.click();button.click()");
      await wait("typeof window.heldResponses?.create?.release === 'function'");
      const created=await js('window.heldResponses.create.instanceId');
      assert.deepEqual((await all()).filter(s=>!before.some(previous=>previous.instanceId===s.instanceId))
        .map(s=>[s.instanceId,s.kind]),[[created,view==='terminals'?'terminal':'agent']]);

      const releaseAcp=async()=>{
        await js('window.heldResponses.acp.release()');
        await wait(`!window.__ash.sessions.has('${a.instanceId}')`);
      };
      if(first==='acp') await releaseAcp();
      const original=inBackground?b.instanceId:first==='acp'?selectedReplacement:a.instanceId;
      assert(await js(at(original)));
      if(userReturns) {
        await js(`window.__ash.openTab('${b.instanceId}')`);
        await wait(at(b.instanceId));
        await js(`window.__ash.switchTo('${original}')`);
        await wait(at(original));
      }
      await js('window.heldResponses.create.release()');
      await wait("!document.querySelector('#sidebar-create').disabled");
      await wait(at(userReturns?original:created));
      assert(await js('!!window.pageIdentity'),'new conversation must retain the original renderer');
      if(inBackground){
        await wait("document.querySelector('.app').classList.contains('sidebar-collapsed')");
        await wait("getComputedStyle(document.getElementById('page-loader')).visibility === 'hidden'");
        await wait("(()=>{const view=document.querySelector('terminal-view:not([hidden])');if(!view)return false;const r=view.getBoundingClientRect(),node=document.elementFromPoint(Math.min(innerWidth-1,r.left+r.width/2),Math.min(innerHeight-1,r.top+r.height/2));return r.width>0&&!!node&&view.contains(node)})()");
        const hit=await js(`(()=>{const sidebar=document.getElementById('sidebar'),view=document.querySelector('terminal-view:not([hidden])'),r=view.getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)),node=document.elementFromPoint(x,y);return {x,y,inside:!!node&&view.contains(node),sidebar:!!node&&sidebar.contains(node),pointer:getComputedStyle(sidebar).pointerEvents,target:node?.outerHTML.slice(0,300),rect:r.toJSON()};})()`);
        assert(hit.inside&&!hit.sidebar&&hit.pointer==='none',JSON.stringify(hit));
      }
      if(first==='create') await releaseAcp();
      await js('window.heldResponses.restore()');
      if(userReturns) {
        assert(await js(at(selectedReplacement)),'a deliberate tab round trip supersedes the pending creation');
      } else {
        assert(await js(at(created)));
        await js('history.back()');
        if(inBackground){
          await wait(at(b.instanceId));
          await assertDraft('另一标签草稿');
          await js('history.back()');
        }
        await wait(at(selectedReplacement));
      }
      await assertDraft('待保留的 ACP 草稿');
      if(!userReturns){
        await js('history.forward()');
        if(inBackground){
          await wait(at(b.instanceId));
          await js('history.forward()');
        }
        await wait(at(created));
      }
    }
    console.log('PASS pending ACP: both response orders preserve foreground chat, background terminal, drafts, history and user tab switches');
  } finally { if(win&&!win.isDestroyed())win.destroy();await hub?.shutdown();fs.rmSync(fixture.dir,{recursive:true,force:true}); }
}).then(()=>{clearTimeout(deadline);app.exit(0)},error=>{clearTimeout(deadline);console.error(error);app.exit(1)});
