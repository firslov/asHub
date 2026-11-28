// Production Electron renderer with a loopback Hub and synthetic context reads.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { env, Bridge, path, root } = require('./harness.cjs');
const fixture = env({ globals: { setTimeout, clearTimeout, setInterval, clearInterval } });
fixture.clock(Date.now());
app.setPath('userData', path.join(fixture.dir, 'context-profile'));
app.on('window-all-closed', () => {});
const watchdog = setTimeout(() => { console.error('Context UI watchdog'); app.exit(1); }, 30000);

app.whenReady().then(async () => {
  const hub = fixture.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: opts => new Bridge(opts) });
  let win;
  try {
    await once(hub.server, 'listening');
    const base = `http://127.0.0.1:${hub.server.address().port}`;
    async function create() {
      const res = await fetch(base + '/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ashub-Local': '1' }, body: JSON.stringify({ cwd: fixture.dir }),
      });
      assert.equal(res.status, 200);
      return (await res.json()).instanceId;
    }
    const a = await create(), b = await create();
    win = new BrowserWindow({ show: false, width: 1180, height: 800, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadURL(`${base}/${a}/`);
    const js = code => win.webContents.executeJavaScript(code);
    const wait = async code => {
      for (let i = 0; i < 160; i++) {
        if (await js(code)) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error('Context UI timeout: ' + code);
    };
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const switchTo = id => js(`import('/js/session-manager.js').then(m=>{m.switchTo(${JSON.stringify(id)})})`);
    const activeRoles = `Array.from(document.querySelectorAll('#ctx-filters .active'),node=>node.dataset.role)`;
    const visibleRoles = `Array.from(document.querySelectorAll('#ctx-body .ctx-msg:not([hidden])'),node=>node.dataset.role)`;
    await wait(`window.__ash?.activeSessionId.peek()===${JSON.stringify(a)}`);
    await js(`(()=>{const real=window.fetch;window.contextReads=[];window.contextWrites=[];window.contextRemoved=new Set();window.holdNextContext=false;
      window.fetch=(url,opts)=>{
        const drop=/^\\/([a-f0-9]+)\\/context\\/drop$/.exec(String(url));
        if(drop && opts?.method==='POST') return new Promise(resolve=>{
          contextWrites.push({id:drop[1],body:JSON.parse(opts.body),finish:status=>{
            if(status===200) contextRemoved.add(drop[1]);
            resolve(new Response(status===200?'{}':'fixture context write failed',{status}));
          }});
        });
        const match=/^\\/([a-f0-9]+)\\/context$/.exec(String(url));
        if(!match) return real(url,opts);
        const messages=[{role:'user',content:match[1]+' question'}];
        if(!contextRemoved.has(match[1])) messages.push({role:'assistant',content:match[1]+' reply'});
        const data={messages,revision:'ctx-'+match[1],activeTokens:20,contextWindow:1000};
        if(!window.holdNextContext) return Promise.resolve(Response.json(data));
        window.holdNextContext=false;
        return Promise.resolve({ok:true,json:()=>new Promise(resolve=>contextReads.push({ signal:opts.signal, release:()=>resolve(data) }))});
      };})()`);
    await click('#ctx-toggle');
    await wait(`${visibleRoles}.length===2`);
    await click('#ctx-filters [data-role="assistant"]');
    assert.deepEqual(await js(visibleRoles), ['assistant']);
    await switchTo(b);
    await wait(`document.querySelector('#ctx-body').textContent.includes(${JSON.stringify(b + ' reply')})`);
    assert.deepEqual(await js(visibleRoles), ['user','assistant']);
    const bControls = await js(activeRoles);
    await click('#ctx-filters [data-role="user"]');
    await switchTo(a);
    await wait(`document.querySelector('#ctx-body').textContent.includes(${JSON.stringify(a + ' reply')})`);
    const aControls = await js(activeRoles);
    assert.deepEqual(await js(visibleRoles), ['assistant']);

    await js(`window.holdNextContext=true`);
    await click('#ctx-refresh'); await wait('contextReads.length===1');
    await js(`document.getElementById('ctx-close').focus()`);
    await click('#ctx-close');
    const closeFocus = await js('document.activeElement.id');
    const cancelled = await js('contextReads[0].signal.aborted');
    await click('#files-toggle');
    await wait(`!document.querySelector('#files-panel').hidden && document.querySelector('#ctx-panel').hidden`);
    await js('contextReads[0].release(); new Promise(resolve=>setTimeout(resolve,0))');
    const hiddenCommit = await js(`document.querySelector('#ctx-body').textContent.includes(${JSON.stringify(a + ' reply')})`);
    await switchTo(b); await click('#ctx-toggle');
    await wait(`document.querySelector('#ctx-body').textContent.includes(${JSON.stringify(b + ' question')})`);
    assert.deepEqual(await js(visibleRoles), ['user']);
    assert.deepEqual({bControls,aControls,closeFocus,cancelled,hiddenCommit}, {
      bControls:['all'],aControls:['assistant'],closeFocus:'ctx-toggle',cancelled:true,hiddenCommit:false,
    });
    console.log('PASS Context role choices follow each tab, close restores focus and aborts an outstanding body, and Files plus reopen show the right conversation');

    // A delayed failure belongs to A, even after B takes over the same drawer.
    const focusDropTwice = `(()=>{const button=document.getElementById('ctx-drop');button.focus();button.click();button.click()})()`;
    const checkRole = role => click(`#ctx-body [data-role="${role}"] input`);
    const toastErrors = `document.querySelectorAll('.toast-error').length`;
    const dropStatus = `document.getElementById('ctx-drop-status')?.textContent ?? ''`;
    await switchTo(a);
    await wait(`document.querySelector('#ctx-body').textContent.includes(${JSON.stringify(a + ' reply')})`);
    await checkRole('assistant');
    const originalToastErrors = await js(toastErrors);
    await js(focusDropTwice);
    const submitted = await js(`contextWrites.map(({id,body})=>({id,body}))`);
    const pending = await js(`({busy:document.getElementById('ctx-drop').getAttribute('aria-busy'), focus:document.activeElement.id})`);
    await switchTo(b);
    await click('#files-toggle');
    await wait(`!document.querySelector('#files-panel').hidden && document.querySelector('#ctx-panel').hidden`);
    await click('#ctx-toggle');
    await wait(`document.querySelector('#ctx-body').textContent.includes(${JSON.stringify(b + ' question')})`);
    await checkRole('user');
    await js(`document.getElementById('ctx-refresh').focus();contextWrites.forEach(write=>write.finish(503));new Promise(resolve=>setTimeout(resolve,0))`);
    const unrelatedToasts = (await js(toastErrors)) - originalToastErrors;
    assert.equal(await js(dropStatus), '');
    assert.equal(await js(`document.querySelector('#ctx-body [data-role="user"] input').checked`), true);
    assert.equal(await js(`document.activeElement.id`), 'ctx-refresh');

    await switchTo(a);
    await wait(`document.querySelector('#ctx-body').textContent.includes(${JSON.stringify(a + ' reply')})`);
    const originError = await js(dropStatus);
    await checkRole('assistant');
    await click('#ctx-drop');
    const retry = await js(`(({id,body})=>({id,body}))(contextWrites.at(-1))`);
    await js('contextWrites.at(-1).finish(200)');
    await wait(`document.querySelector('#ctx-body').textContent.includes(${JSON.stringify(a + ' question')}) && !document.querySelector('#ctx-body [data-role="assistant"]')`);
    const expectedWrite = { id:a, body:{indices:[1],revision:`ctx-${a}`} };
    assert.deepEqual({submitted,pending,unrelatedToasts,originError:originError.includes('fixture context write failed'),retry}, {
      submitted:[expectedWrite],pending:{busy:'true',focus:'ctx-drop'},unrelatedToasts:0,originError:true,retry:expectedWrite,
    });
    assert.equal(await js(dropStatus), '');
    console.log('PASS duplicate context drop is blocked; delayed failure, focus and retry stay with the correct conversation');
  } finally { win?.destroy(); await hub.shutdown(); }
}).then(()=>{clearTimeout(watchdog);app.exit(0);},error=>{clearTimeout(watchdog);console.error(error);app.exit(1);});
