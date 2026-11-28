// Production archive drawer + native Electron renderer + an isolated local Hub.
const { app, BrowserWindow } = require('electron');
const { env, Bridge, path, root, fs } = require('./harness.cjs');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const fixture = env({ globals: {setTimeout, clearTimeout, setInterval, clearInterval} });
fixture.clock(Date.now());
app.setPath('userData', path.join(fixture.dir, 'archive-profile'));
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('Archive drawer test timed out'); app.exit(1); }, 40000);

app.whenReady().then(async () => {
  let bridgeCount = 0;
  const hub = fixture.hub().startHub({host:'127.0.0.1', port:0, webRoot:path.join(root, 'web'), makeBridge:opts=>{
    bridgeCount++;
    const bridge = new Bridge(opts);
    bridge.submit = async query => {
      bridge.emit('event', { name:'agent:response-chunk', payload:{blocks:[{type:'text',text:'**已归档的回复**'}]} });
      return Bridge.prototype.submit.call(bridge, query);
    };
    return bridge;
  }});
  let win, secondWin;
  try {
    await once(hub.server, 'listening');
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    async function api(route, body) {
      const response = await fetch(base + route, {method:body ? 'POST' : 'GET', headers:{'Content-Type':'application/json','X-Ashub-Local':'1'}, body:body && JSON.stringify(body)});
      const text = await response.text();
      assert(response.ok, `${route}: HTTP ${response.status} ${text}`);
      return JSON.parse(text);
    }
    const cwd = path.join(fixture.dir, '归档夹具'); fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(cwd, 'fixture-dir'));
    fs.writeFileSync(path.join(cwd, 'fixture-dir', 'notes.txt'), 'fixture');
    const ids = [];
    for (const name of ['归档检查', '另一条历史']) {
      const {instanceId} = await api('/sessions', {cwd}); ids.push(instanceId);
      await api(`/${instanceId}/title`, {title:name});
      await api(`/${instanceId}/submit`, {query:`给 ${name} 的归档问题`});
      const idle = async () => !(await api('/sessions')).find(item=>item.instanceId===instanceId)?.processing;
      for (let i=0;i<100 && !(await idle());i++) await new Promise(r=>setTimeout(r,20));
      assert(await idle());
      await api('/api/sessions/archive', {id:instanceId});
    }
    const [first, second] = ids;
    const {instanceId:active} = await api('/sessions', {cwd});
    const historyRoute = id => `/api/sessions/archived/${id}/history`;
    assert.equal((await fetch(base + historyRoute(active))).status,404);
    assert.equal((await fetch(base + historyRoute('ffffffffffffffff'))).status,404);
    assert.notEqual((await fetch(base + historyRoute(first), {method:'POST'})).status,200);
    // Read a legacy tree without replay and verify that even a torn tail is
    // not repaired by the preview. Deleted conversations remain invisible.
    const sessionsDir = path.join(fixture.dir,'hub-sessions');
    const tree = path.join(sessionsDir,`${second}.jsonl`);
    const replay = path.join(sessionsDir,`${second}.replay.jsonl`);
    fs.renameSync(replay,replay+'.fixture-backup');
    const savedTree = fs.readFileSync(tree);
    const torn = Buffer.concat([savedTree,Buffer.from('{"torn"')]);
    fs.writeFileSync(tree,torn);
    try {
      assert.deepEqual((await api(historyRoute(second))).messages,[{role:'user',text:'给 另一条历史 的归档问题'}]);
      assert.deepEqual(fs.readFileSync(tree),torn,'history preview must not repair or update history');
      const marker = path.join(sessionsDir,`${second}.deleted`);
      fs.writeFileSync(marker,'');
      try { assert.equal((await fetch(base + historyRoute(second))).status,404); }
      finally { fs.unlinkSync(marker); }
    } finally {
      fs.writeFileSync(tree,savedTree);
      fs.renameSync(replay+'.fixture-backup',replay);
    }
    win = new BrowserWindow({show:false, width:1180, height:820, webPreferences:{contextIsolation:true, nodeIntegration:false, backgroundThrottling:false}});
    await win.loadURL(base);
    const js = str => win.webContents.executeJavaScript(str);
    const wait = async (expr, evaluate = js) => {
      for(let i=0;i<150;i++) { if(await evaluate(expr)) return; await new Promise(r=>setTimeout(r,25)); }
      throw Error('Timed out: ' + expr);
    };
    const click = sel => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const open = () => click('#archive-toggle');
    const isOpen = `!document.querySelector('#archive-panel').hidden`;
    const row = id => `#archive-list [data-session-id="${id}"]`;
    const visible = `Array.from(document.querySelectorAll('#archive-list li:not([hidden])'),el=>el.dataset.sessionId)`;
    const find = text => js(`(()=>{const f=document.querySelector('#archive-filter');f.value=${JSON.stringify(text)};f.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const escape = () => js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))`);

    // An old saved view must not strand the list on a removed destination.
    await js(`localStorage.setItem('ash.sidebar-view','archive');localStorage.setItem('ash.lang','zh');`);
    await win.loadURL(`${base}/${active}/`);
    await wait(`import('/js/sidebar.js').then(m=>m.sidebarView.peek()==='sessions')`);
    await wait(`import('/js/session-manager.js').then(m=>m.activeSessionId.peek()===${JSON.stringify(active)})`);
    assert.deepEqual(await js(`[...document.querySelectorAll('#sidebar-view-menu [data-view]')].map(x=>x.dataset.view).sort()`), ['projects','sessions','terminals']);
    assert.equal(await js(`document.querySelector('#archive-toggle').getAttribute('aria-expanded')`),'false');
    await open();
    await wait(`${isOpen} && ${visible}.length===2`);
    assert.deepEqual(await js(`[document.querySelector('#archive-toggle').getAttribute('aria-expanded'),document.querySelector('.app').classList.contains('archive-open')]`),['true',true]);
    await find('归档检查'); assert.deepEqual(await js(visible),[first]);
    await find('归档夹具'); assert.deepEqual((await js(visible)).sort(),ids.slice().sort());
    await find('not present'); await wait(`!document.querySelector('#archive-status').hidden`);
    await find('归档检查');
    await js(`document.querySelector('#archive-filter').focus();document.activeElement.dispatchEvent(new Event('compositionstart'))`);
    await escape(); assert.equal(await js(isOpen),true);
    await js(`document.activeElement.dispatchEvent(new Event('compositionend'))`);
    await escape(); assert.equal(await js(isOpen),false);
    assert.equal(await js('document.activeElement.id'),'archive-toggle');

    // Clicking must show the persisted conversation, not just change the URL.
    await open(); await wait(isOpen);
    const before = win.webContents.getURL();
    const oldRoute = await fetch(base + '/' + first);
    assert.equal(oldRoute.status,404); assert.equal(await oldRoute.text(),'no session');
    await click(row(first)+' .archive-history');
    await wait(`document.querySelector('#archive-messages strong')?.textContent === '已归档的回复'`);
    assert.match(await js(`document.querySelector('#archive-messages').textContent`), /给 归档检查 的归档问题/);
    assert.equal(win.webContents.getURL(),before);
    assert.equal(bridgeCount,3,'preview must not start a bridge');
    assert((await api('/api/sessions/archived')).some(item=>item.id===first));
    assert(!(await api('/sessions')).some(item=>item.instanceId===first));
    await click('#archive-back');
    assert.deepEqual(await js(visible),[first]);
    assert.equal(await js(`document.activeElement.closest('li')?.dataset.sessionId`),first);
    await find(''); await wait(`${visible}.length===2`);
    // The preview remains escapable on a real HTTP error and Refresh can retry.
    await js(`(()=>{const real=window.fetch;window.originalArchiveFetch=real;window.fetch=(url,opts)=>url===${JSON.stringify(historyRoute(second))}?Promise.resolve(new Response(null,{status:503})):real(url,opts);})()`);
    await click(row(second)+' .archive-history');
    await wait(`document.querySelector('#archive-preview-status').textContent.includes('未能读取')`);
    await escape();
    assert.equal(await js(`document.querySelector('#archive-preview').hidden`),true);
    assert.equal(await js(`document.activeElement.closest('li')?.dataset.sessionId`),second);
    await click(row(second)+' .archive-history');
    await wait(`document.querySelector('#archive-preview-status').textContent.includes('未能读取')`);
    await js('window.fetch=window.originalArchiveFetch; true');
    await click('#archive-refresh');
    await wait(`document.querySelector('#archive-messages').textContent.includes('给 另一条历史 的归档问题')`);
    await click('#archive-back');
    assert.equal(await js(`import('/js/session-manager.js').then(m=>m.activeSessionId.peek())`),active);

    // A history body may still be parsing after the user goes Back, switches
    // to Files, and returns to a different archive. Even a transport that
    // delivers the cancelled body must not update the new preview.
    await js(`(()=>{const real=window.fetch;window.originalArchiveFetch=real;
      window.fetch=async (url,opts)=>{
        if(url!==${JSON.stringify(historyRoute(first))}) return real(url,opts);
        const response=await real(url,opts);
        const data=await response.json();
        return {ok:response.ok,json:()=>new Promise(resolve=>{window.staleHistory={signal:opts.signal,release:()=>resolve(data)}})};
      };})()`);
    await click(row(first)+' .archive-history'); await wait('!!window.staleHistory');
    await click('#archive-back'); await click('#files-toggle');
    await wait(`!document.querySelector('#files-panel').hidden && !(${isOpen})`);
    await open(); await wait(`${isOpen} && ${visible}.length===2`);
    await click(row(second)+' .archive-history');
    await wait(`document.querySelector('#archive-messages').textContent.includes('给 另一条历史 的归档问题')`);
    assert.equal(await js('staleHistory.signal.aborted'),true);
    await js('staleHistory.release(); new Promise(resolve=>setTimeout(resolve,0))');
    const previewText = await js(`document.querySelector('#archive-messages').textContent`);
    assert.match(previewText,/给 另一条历史 的归档问题/);
    assert.doesNotMatch(previewText,/给 归档检查 的归档问题/);
    assert.equal(await js(`document.activeElement.id`),'archive-back');
    await js('window.fetch=window.originalArchiveFetch; true');
    await click('#archive-back');
    console.log('PASS cancelled history body cannot change the new preview after Back, Files, and Archive');

    const dir = '#files-body [data-path="fixture-dir"]';
    await click('#files-toggle');
    await wait(`!document.querySelector('#files-panel').hidden && !(${isOpen}) && document.querySelector(${JSON.stringify(dir)})`);
    // Failed reads remain actionable while Files owns the screen, but an
    // abandoned expansion must not announce an error in the next drawer.
    await js(`(()=>{const real=window.fetch;window.originalFilesFetch=real;window.subdirReads=[];
      window.fetch=(url,opts)=>String(url).includes('/files?subdir=fixture-dir')
        ? new Promise(resolve=>subdirReads.push({ signal:opts?.signal, fail:()=>resolve(new Response(null,{status:503})) }))
        : real(url,opts);})()`);
    const toastCount = `document.querySelectorAll('.toast-error').length`;
    const previousErrors = await js(toastCount);
    await click(dir);
    await wait('subdirReads.length===1');
    await js('subdirReads[0].fail()');
    await wait(`${toastCount} === ${previousErrors + 1}`);
    await click(dir);
    await wait('subdirReads.length===2');
    await open(); await wait(`${isOpen} && document.querySelector('#files-panel').hidden`);
    await js('subdirReads[1].fail(); new Promise(resolve=>setTimeout(resolve,0))');
    assert.equal(await js(toastCount), previousErrors + 1, 'a closed Files drawer announced a stale subdirectory error');
    assert.equal(await js('subdirReads[1].signal?.aborted'), true);
    await js('window.fetch=window.originalFilesFetch; true');
    await click('#files-toggle'); await wait(`document.querySelector(${JSON.stringify(dir)})`);
    await click(dir); await wait(`document.querySelector('#files-body [data-path="fixture-dir/notes.txt"]')`);
    await js(`document.querySelector('#files-close').focus()`); await click('#files-close');
    assert.equal(await js('document.activeElement.id'),'files-toggle');
    console.log('PASS Files drawer cancels abandoned directory reads, keeps active failures actionable, and restores close-button focus');
    await open(); await wait(isOpen);

    win.setContentSize(390,780); await wait('innerWidth===390');
    const bounds = await js(`(()=>{ const p=document.querySelector('#archive-panel');const b=p.getBoundingClientRect();return {left:b.left,right:b.right,width:innerWidth,extra:p.scrollWidth-p.clientWidth}; })()`);
    assert(bounds.left>=0 && bounds.right<=bounds.width+1 && bounds.extra<=1, JSON.stringify(bounds));
    await click(row(first)+' .archive-history');
    await wait(`document.querySelector('#archive-messages strong')?.textContent === '已归档的回复'`);
    assert.equal(await js(`(()=>{const p=document.querySelector('#archive-preview');const b=document.querySelector('#archive-back').getBoundingClientRect();return p.clientWidth>0 && p.scrollWidth<=p.clientWidth+1 && b.left>=0 && b.right<=innerWidth;})()`),true);
    await click('#archive-back');
    const restore = JSON.stringify(row(first)+' .archive-restore');
    // Stall the UI's POST before sending it to the real Hub. Reopening the
    // drawer must not resubmit it or lose focus if the user returns to the row.
    await js(`(()=>{const real=window.fetch.bind(window);window.restorePosts=0;
      window.fetch=(url,options)=>{if(url!=='/api/sessions/unarchive')return real(url,options);
        window.restorePosts++;return new Promise(resolve=>{window.releaseArchiveRestore=()=>resolve(real(url,options));});};
      const b=document.querySelector(${restore});b.focus();b.click();b.click();})()`);
    await click('#archive-close'); await open(); await wait(`${isOpen} && ${visible}.length===2`);
    await js(`(()=>{const b=document.querySelector(${restore});b.focus();b.click();})()`);
    assert.equal(await js('restorePosts'),1);
    await js('releaseArchiveRestore()');
    await wait(`${visible}.length===1 && ${visible}[0]===${JSON.stringify(second)}`);
    await wait(`document.querySelector('#sessions li[data-session-id="${first}"]')!==null`);
    assert.equal(win.webContents.getURL(),before,'restoring must not navigate');
    assert.equal(await js(`document.activeElement.closest('li')?.dataset.sessionId`),second);
    assert.deepEqual((await api('/api/sessions/archived')).map(x=>x.id),[second]);
    assert((await api('/sessions')).some(x=>x.instanceId===first));
    console.log('PASS archive drawer, legacy view fallback, Chinese filters, IME/Escape, history, pane exclusivity, 390px and actual restore/focus');

    // A second renderer can restore an item while this window's keyboard
    // focus is still on its history button. Follow the real host invalidation.
    secondWin = new BrowserWindow({show:false, width:1180, height:820, webPreferences:{contextIsolation:true, nodeIntegration:false, backgroundThrottling:false}});
    await secondWin.loadURL(`${base}/${active}/`);
    const jsSecond = code => secondWin.webContents.executeJavaScript(code);
    await jsSecond(`document.querySelector('#archive-toggle').click()`);
    await wait(`${isOpen} && ${visible}.length===1`, jsSecond);
    assert.deepEqual(await jsSecond(visible),[second]);
    await find('另一条历史');
    await js(`document.querySelector(${JSON.stringify(row(second)+' .archive-history')}).focus()`);
    assert.equal(await js(`document.activeElement.closest('li')?.dataset.sessionId`),second);
    await jsSecond(`document.querySelector(${JSON.stringify(row(second)+' .archive-restore')}).click()`);
    await wait(`${visible}.length===0 && ${isOpen}`);
    assert.equal(await js(`document.activeElement.id`),'archive-filter','remote restore removed the focused row without giving the keyboard user a place to continue');
    assert.equal(await js(`document.querySelector('#archive-filter').value`),'另一条历史');
    assert.equal(win.webContents.getURL(),before);
    console.log('PASS across two Electron windows: remote restore keeps the current drawer, filter, and keyboard focus');
  } finally { secondWin?.destroy(); win?.destroy(); await hub.shutdown(); }
}).then(()=>{clearTimeout(watchdog);app.exit(0);},err=>{clearTimeout(watchdog);console.error(err);app.exit(1);});
