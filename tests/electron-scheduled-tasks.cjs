const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { zip } = require('./plugin-zip-fixture.cjs');
const { env, Bridge, fs, path, root } = require('./harness.cjs');
const modules = {}, e = env({ modules, globals: { setTimeout, clearTimeout, setInterval, clearInterval, Date } });
process.env.AGENT_SH_HOME = e.dir;
app.setPath('userData', path.join(e.dir, 'browser'));
app.on('window-all-closed', () => { });
let hub, win;
const timeout = setTimeout(() => { console.error('Scheduled UI timeout'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
    try {
        modules['./extensions/installed.js'] = await import(pathToFileURL(path.join(root, 'dist/extensions/installed.js')).href);
        hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: options => new Bridge(options) });
        await once(hub.server, 'listening');
        const base = 'http://127.0.0.1:' + hub.server.address().port;
        const files=Object.fromEntries(['package.json','ashub-plugin.json','app.mjs','schedule.mjs','README.md'].map(name=>[name,fs.readFileSync(path.join(root,'examples/extensions/scheduled-tasks',name),'utf8')]));
        const call=async(route,init)=>{const response=await fetch(base+route,init);const text=await response.text();assert.equal(response.status,200,text);return JSON.parse(text);};
        const preview=await call('/api/plugins/install?action=preview',{method:'POST',headers:{'Content-Type':'application/zip'},body:zip(files)});assert.equal(preview.canInstall,true,JSON.stringify(preview));
        const job=await call('/api/plugins/install?action=confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:preview.token})});let outcome;
        for(let i=0;i<100;i++){outcome=await call('/api/plugins/install?id='+job.id);if(outcome.state!=='running')break;await new Promise(r=>setTimeout(r,20));}assert.equal(outcome.state,'succeeded',JSON.stringify(outcome));
        const created = await fetch(base + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: e.dir, kind: 'agent' }) });
        const id = (await created.json()).instanceId;
        win = new BrowserWindow({ show: false, width: 1180, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        win.webContents.on('console-message', event => { if (event.level === 'error')
            console.log('renderer:', event.message); });
        await win.loadURL(base);
        const js = code => win.webContents.executeJavaScript(code), wait = async (code) => { for (let i = 0; i < 150; i++) {
            if (await js(code))
                return;
            await new Promise(r => setTimeout(r, 25));
        } throw Error('Timed out: ' + code); };
        // Native macOS window resizing is asynchronous. Measure only after the
        // renderer has received the requested viewport and painted it.
        win.show();
        const resize = async (width, height) => {
            win.setContentSize(width, height);
            await wait(`innerWidth === ${width} && innerHeight === ${height}`);
            await js(`document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
        };
        await resize(1180, 900);
        await js(`(async()=>{localStorage.setItem('ash.lang','zh');(await import('/js/i18n.js')).setLang('zh')})()`);
        await wait(`!!document.querySelector('.extension-menu')`);
        assert.equal(await js(`(()=>{const items=[...document.querySelector('#toolbar').children],entry=document.querySelector('.extension-menu');return items.indexOf(entry)<items.indexOf(document.querySelector('#config-toggle'))&&items.indexOf(entry)<items.indexOf(document.querySelector('.toolbar-sep'))})()`),true,'plugin entry belongs to the main tool group');
        await js(`document.querySelector('.extension-menu').click()`);
        await wait(`document.querySelector('.extension-resource-actions')?.textContent.includes('新建任务')`);
        await js(`Array.from(document.querySelectorAll('.extension-resource button')).find(b=>b.textContent==='新建任务').click()`);
        await wait(`!!document.querySelector('.extension-resource-form')`);
        assert.equal(await js(`document.querySelector('.extension-resource-host > .plugins-message').textContent`), '');
        // A discarded invalid interval must not block a different recurrence rule.
        await js(`(()=>{const form=document.querySelector('.extension-resource-form'),cadence=form.querySelectorAll('select')[1];cadence.value='interval';cadence.dispatchEvent(new Event('change',{bubbles:true}));form.querySelector('input[type=number]').value='1.5';})()`);
        assert.equal(await js(`document.querySelector('.extension-resource-form').checkValidity()`), false);
        await js(`(()=>{const cadence=document.querySelectorAll('.extension-resource-form select')[1];cadence.value='daily';cadence.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        assert.equal(await js(`document.querySelector('.extension-resource-form').checkValidity()`), true, 'hidden interval must not invalidate a daily task');
        await js(`document.querySelector('.extension-resource-form').requestSubmit()`);
        await wait(`document.querySelector('.extension-resource-host > .plugins-message').textContent.includes('名称')`);
        assert.equal(await js(`document.querySelector('.extension-resource-form input[type=number]').disabled`),true,'failed requests must keep hidden controls disabled');
        // Exercise actual host-created form controls, including conditional date/time fields.
        await js(`(()=>{const form=document.querySelector('.extension-resource-form'),fields=form.querySelectorAll('input,select,textarea');fields[0].value='每日进展回顾';fields[1].value=${JSON.stringify(id)};fields[2].value='整理今日项目进展 列出需要处理的问题';form.requestSubmit();})()`);
        await wait(`!!document.querySelector('.extension-resource-review')`);
        assert.match(await js(`document.querySelector('.extension-resource-review').textContent`), /整理今日项目进展/);
        // Cancelling approval preserves the entered draft and never creates a task.
        await js(`Array.from(document.querySelectorAll('.extension-resource button')).find(b=>b.textContent==='取消').click()`);
        assert.equal(await js(`document.querySelector('.extension-resource-form input').value`), '每日进展回顾');
        await js(`document.querySelector('.extension-resource-form').requestSubmit()`);
        await wait(`!!document.querySelector('.extension-resource-review')`);
        await js(`Array.from(document.querySelectorAll('.extension-resource button')).find(b=>b.textContent==='确认').click()`);
        await wait(`document.querySelector('.extension-resource-row h3')?.textContent==='每日进展回顾'`);
        assert.equal(await js(`document.querySelectorAll('.extension-resource-row').length`), 1);
        const shots = process.env.ASHUB_UI_SCREENSHOTS;
        if (shots)
            fs.mkdirSync(shots, { recursive: true });
        await js(`document.querySelector('.extension-resource-menu').open=true`);
        for (const theme of ['light', 'dark']) {
            await js(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
            await new Promise(r => setTimeout(r, 120));
            if (shots)
                fs.writeFileSync(path.join(shots, 'scheduled-tasks-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
        }
        await js(`document.querySelector('.app').classList.add('sidebar-collapsed')`);
        for (const width of [390,320]) {
            await resize(width,850);
            assert.equal(await js(`(()=>{const panel=document.querySelector('.extension-panel'),buttons=[...panel.querySelectorAll('.extension-resource-menu-actions button')],rects=buttons.map(b=>b.getBoundingClientRect());return buttons.length===5&&panel.scrollWidth<=panel.clientWidth+1&&Math.abs(rects[0].width-rects[1].width)<1&&Math.abs(rects[0].top-rects[1].top)<1&&rects[2].top>rects[0].top})()`),true,'task actions form a contained two-column grid at '+width);
            if(shots)fs.writeFileSync(path.join(shots,'scheduled-tasks-actions-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
        }
        await resize(1180,900);
        await js(`const menu=document.querySelector('.extension-resource-menu');menu.open=true;Array.from(menu.querySelectorAll('button')).find(b=>b.textContent==='编辑').click()`);
        await wait(`!!document.querySelector('.extension-resource-form')`);
        await js(`document.querySelector('.app').classList.add('sidebar-collapsed');const style=document.createElement('style');style.textContent='.extension-body{overflow-y:scroll}.extension-body::-webkit-scrollbar{width:16px}';document.head.append(style);`);
        for (const width of [390, 320]) {
            await resize(width, 850);
            assert.equal(await js(`(()=>{const p=document.querySelector('.extension-panel');return p.scrollWidth<=p.clientWidth+1&&p.getBoundingClientRect().left>=-1})()`), true, 'no horizontal overflow at ' + width + ' ' + JSON.stringify(await js(`(()=>{const p=document.querySelector('.extension-panel');return {viewport:innerWidth,panel:p.getBoundingClientRect().toJSON(),width:p.clientWidth,scroll:p.scrollWidth,overflow:[...p.querySelectorAll('*')].filter(e=>e.scrollWidth>e.clientWidth+1||e.getBoundingClientRect().right>p.getBoundingClientRect().right+1).map(e=>({tag:e.tagName,cls:e.className,type:e.type,sw:e.scrollWidth,cw:e.clientWidth,rect:e.getBoundingClientRect().toJSON()}))}})()`)));
        }
        await js(`(()=>{const s=document.querySelectorAll('.extension-resource-form select')[1];s.value='once';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        assert.equal(await js(`document.querySelector('.extension-resource-form input[type=time]').closest('label').hidden`), true);
        assert.equal(await js(`document.querySelector('.extension-resource-form input[type=datetime-local]').closest('label').hidden`), false);
        await js(`document.querySelector('.extension-resource-advanced').open=true`);
        assert.equal(await js(`(()=>{const body=document.querySelector('.extension-body');return body.scrollWidth<=body.clientWidth+1&&[...document.querySelectorAll('.extension-resource-form input,.extension-resource-form select,.extension-resource-form textarea')].filter(el=>el.getClientRects().length).every(el=>el.getBoundingClientRect().right<=body.getBoundingClientRect().right-1)})()`),true,'expanded date/time fields stay within the narrow scrollable form');
        if (shots)
            fs.writeFileSync(path.join(shots, 'scheduled-tasks-mobile.png'), (await win.webContents.capturePage()).toPNG());
        // A no-op action may return an unchanged view; its reused buttons must recover.
        await js(`(async()=>{
            const {mountResource}=await import('/js/extensions/resource-view.js');
            const host=document.createElement('div');host.id='resource-noop';document.body.append(host);
            const original=window.fetch,view={rows:[],actions:[{id:'refresh',label:'Refresh',values:{}}]};
            window.fetch=(url,options)=>url==='/api/plugin-resources/ui-fixture/noop'?Promise.resolve(new Response(JSON.stringify({view}),{status:200})):original(url,options);
            window.disposeNoop=()=>{dispose();host.remove();window.fetch=original;};
            const dispose=mountResource(host,{pluginId:'ui-fixture'},'noop');
        })()`);
        await wait(`!!document.querySelector('#resource-noop button')`);
        await js(`document.querySelector('#resource-noop button').click()`);
        await wait(`!document.querySelector('#resource-noop .extension-resource').hasAttribute('aria-busy')`);
        assert.equal(await js(`document.querySelector('#resource-noop button').disabled`),false,'unchanged result must restore controls');
        await js(`window.disposeNoop()`);
        // The plugin emits every live conversation plus one placeholder option.
        const {Scheduler}=await import(pathToFileURL(path.join(root,'examples/extensions/scheduled-tasks/app.mjs')).href);
        const largeEditor=new Scheduler({host:{snapshot:()=>({sessions:Array.from({length:300},(_,i)=>({instanceId:'chat-'+i,title:'Conversation '+i,kind:'agent'}))})}},
            {file:path.join(e.dir,'large-editor.json')}).editor();
        await js(`(async()=>{
            const {mountResource,validateResourceView}=await import('/js/extensions/resource-view.js');
            const view=${JSON.stringify(largeEditor)};
            validateResourceView(view);
            const host=document.createElement('div');host.id='resource-large';document.body.append(host);
            const original=window.fetch;
            window.fetch=(url,options)=>url==='/api/plugin-resources/ui-fixture/large'?Promise.resolve(new Response(JSON.stringify({view}),{status:200})):original(url,options);
            const dispose=mountResource(host,{pluginId:'ui-fixture'},'large');
            window.disposeLarge=()=>{dispose();host.remove();window.fetch=original;};
            let rejected=false;try{validateResourceView({...view,note:'x'.repeat(262145)})}catch{rejected=true}
            if(!rejected)throw Error('Resource payload limit must remain enforced');
        })()`);
        await wait(`document.querySelector('#resource-large select')?.options.length===301`);
        assert.equal(await js(`(()=>{const select=document.querySelector('#resource-large select');select.value='chat-299';return select.value})()`),'chat-299');
        await js(`window.disposeLarge()`);
        // A delayed poll failure must not overwrite feedback for a newer action.
        for (const superseded of [false,true]) {
            await js(`(async()=>{
                const {mountResource}=await import('/js/extensions/resource-view.js');
                const host=document.createElement('div');host.id='resource-poll';document.body.append(host);
                const originalFetch=window.fetch,originalInterval=window.setInterval,hidden=Object.getOwnPropertyDescriptor(document,'hidden');
                Object.defineProperty(document,'hidden',{configurable:true,value:false});
                let count=0;window.pollFixture={};
                const view={rows:[],actions:[{id:'open',label:'Open',values:{}}]};
                window.fetch=(url,options)=>{
                    if(url!=='/api/plugin-resources/ui-fixture/poll')return originalFetch(url,options);
                    if(options?.method==='POST')return Promise.resolve(new Response(JSON.stringify({view:{...view,refresh:false,note:'Current action succeeded'}})));
                    if(++count===1)return Promise.resolve(new Response(JSON.stringify({view})));
                    return new Promise((resolve,reject)=>{window.pollFixture.reject=reject;});
                };
                window.setInterval=callback=>{window.pollFixture.tick=callback;return originalInterval(()=>{},60000);};
                const dispose=mountResource(host,{pluginId:'ui-fixture'},'poll');window.setInterval=originalInterval;
                window.pollFixture.dispose=()=>{dispose();host.remove();window.fetch=originalFetch;if(hidden)Object.defineProperty(document,'hidden',hidden);else delete document.hidden;};
            })()`);
            await wait(`!!document.querySelector('#resource-poll button')`);
            await js(`window.pollFixture.tick()`);
            await wait(`!!window.pollFixture.reject`);
            if(superseded){
                await js(`document.querySelector('#resource-poll button').click()`);
                await wait(`document.querySelector('#resource-poll .extension-resource-note')?.textContent==='Current action succeeded'`);
            }
            await js(`(async()=>{window.pollFixture.reject(new Error('late refresh failure'));await new Promise(r=>setTimeout(r,0));})()`);
            assert.equal(await js(`document.querySelector('#resource-poll .plugins-message').textContent`),superseded?'':'late refresh failure','only the current refresh may publish an error');
            await js(`window.pollFixture.dispose()`);
        }
        // Responses slower than the polling interval must not be superseded forever.
        await js(`(async()=>{
            const {mountResource}=await import('/js/extensions/resource-view.js');
            const host=document.createElement('div');host.id='resource-slow';document.body.append(host);
            const originalFetch=window.fetch,originalInterval=window.setInterval,hidden=Object.getOwnPropertyDescriptor(document,'hidden');
            Object.defineProperty(document,'hidden',{configurable:true,value:false});
            window.slowFixture={requests:[]};
            window.fetch=(url,options)=>url==='/api/plugin-resources/ui-fixture/slow'?new Promise((resolve,reject)=>window.slowFixture.requests.push({resolve,reject})):originalFetch(url,options);
            window.setInterval=callback=>{window.slowFixture.tick=callback;return originalInterval(()=>{},60000);};
            const dispose=mountResource(host,{pluginId:'ui-fixture'},'slow');window.setInterval=originalInterval;
            window.slowFixture.resolve=(index,note)=>window.slowFixture.requests[index].resolve(new Response(JSON.stringify({view:{rows:[],actions:[],note}})));
            window.slowFixture.dispose=()=>{dispose();host.remove();window.fetch=originalFetch;if(hidden)Object.defineProperty(document,'hidden',hidden);else delete document.hidden;};
        })()`);
        await js(`window.slowFixture.tick();window.slowFixture.tick()`);
        assert.equal(await js(`window.slowFixture.requests.length`),1,'slow initial load must not spawn overlapping polls');
        await js(`window.slowFixture.resolve(0,'Initial snapshot')`);
        await wait(`document.querySelector('#resource-slow .extension-resource-note')?.textContent==='Initial snapshot'`);
        await js(`window.slowFixture.tick();window.slowFixture.tick();window.slowFixture.tick()`);
        assert.equal(await js(`window.slowFixture.requests.length`),2,'only one background refresh may be pending');
        await js(`window.slowFixture.resolve(1,'Updated snapshot')`);
        await wait(`document.querySelector('#resource-slow .extension-resource-note')?.textContent==='Updated snapshot'`);
        await js(`window.slowFixture.tick()`);
        assert.equal(await js(`window.slowFixture.requests.length`),3,'polling must resume after completion');
        await js(`window.slowFixture.resolve(2,'Next snapshot')`);
        await wait(`document.querySelector('#resource-slow .extension-resource-note')?.textContent==='Next snapshot'`);
        await js(`window.slowFixture.tick()`);
        await js(`(async()=>{window.slowFixture.requests[3].reject(new Error('Current read failed'));await new Promise(r=>setTimeout(r,0));})()`);
        assert.equal(await js(`document.querySelector('#resource-slow .plugins-message').textContent`),'Current read failed');
        await js(`window.slowFixture.tick()`);
        assert.equal(await js(`window.slowFixture.requests.length`),5,'failed refresh must release the read guard');
        await js(`window.slowFixture.resolve(4,'Recovered snapshot')`);
        await wait(`document.querySelector('#resource-slow .extension-resource-note')?.textContent==='Recovered snapshot'`);
        assert.equal(await js(`document.querySelector('#resource-slow .plugins-message').textContent`),'');
        await js(`window.slowFixture.dispose()`);
        // A stalled transport must release the read guard within a bounded time.
        await js(`(async()=>{
            const {mountResource}=await import('/js/extensions/resource-view.js');
            const host=document.createElement('div');host.id='resource-timeout';document.body.append(host);
            const originalFetch=window.fetch,originalInterval=window.setInterval,originalTimeout=window.setTimeout,hidden=Object.getOwnPropertyDescriptor(document,'hidden');
            Object.defineProperty(document,'hidden',{configurable:true,value:false});
            window.timeoutFixture={requests:[],timers:[]};
            window.fetch=(url,options)=>url==='/api/plugin-resources/ui-fixture/timeout'?new Promise((resolve,reject)=>{
                const signal=options.signal;window.timeoutFixture.requests.push({resolve,signal});
                if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
            }):originalFetch(url,options);
            window.setInterval=callback=>{window.timeoutFixture.tick=callback;return originalInterval(()=>{},60000);};
            window.setTimeout=(callback,ms)=>{window.timeoutFixture.timers.push({callback,ms});return -window.timeoutFixture.timers.length;};
            const dispose=mountResource(host,{pluginId:'ui-fixture'},'timeout');window.setInterval=originalInterval;window.setTimeout=originalTimeout;
            window.timeoutFixture.expire=()=>{for(const timer of window.timeoutFixture.timers)if(timer.ms<=20000)timer.callback();};
            window.timeoutFixture.dispose=()=>{dispose();window.fetch=originalFetch;if(hidden)Object.defineProperty(document,'hidden',hidden);else delete document.hidden;};
        })()`);
        await js(`(async()=>{window.timeoutFixture.expire();await new Promise(r=>setTimeout(r,0));window.timeoutFixture.tick();})()`);
        assert.equal(await js(`window.timeoutFixture.requests.length`),2,'stalled read must time out and allow the next poll');
        assert.equal(await js(`window.timeoutFixture.requests[0].signal.aborted`),true);
        await js(`window.timeoutFixture.requests[1].resolve(new Response(JSON.stringify({view:{actions:[{id:'save',label:'Save',values:{}}],rows:[],note:'Recovered after timeout'}})))`);
        await wait(`document.querySelector('#resource-timeout .extension-resource-note')?.textContent==='Recovered after timeout'`);
        assert.equal(await js(`document.querySelector('#resource-timeout .plugins-message').textContent`),'');
        // The read deadline must not cancel or replay a pending mutation.
        await js(`(()=>{
            const originalTimeout=window.setTimeout;
            window.timeoutFixture.mutationTimers=[];
            window.setTimeout=(callback,ms)=>{window.timeoutFixture.mutationTimers.push({callback,ms});return -100;};
            try{document.querySelector('#resource-timeout button').click();}finally{window.setTimeout=originalTimeout;}
            for(const timer of window.timeoutFixture.mutationTimers)if(timer.ms<=20000)timer.callback();
            window.timeoutFixture.tick();
        })()`);
        assert.equal(await js(`window.timeoutFixture.mutationTimers.length`),0,'mutations must not inherit the read deadline');
        assert.equal(await js(`window.timeoutFixture.requests.length`),3,'pending mutation must block polling without retrying');
        assert.equal(await js(`window.timeoutFixture.requests[2].signal.aborted`),false);
        await js(`window.timeoutFixture.requests[2].resolve(new Response(JSON.stringify({view:{actions:[],rows:[],note:'Saved once'}})))`);
        await wait(`document.querySelector('#resource-timeout .extension-resource-note')?.textContent==='Saved once'`);
        await js(`window.timeoutFixture.tick();window.timeoutFixture.dispose()`);
        assert.equal(await js(`window.timeoutFixture.requests[3].signal.aborted`),true,'disposal aborts the current read');
        await js(`(async()=>{window.timeoutFixture.tick();await new Promise(r=>setTimeout(r,0));})()`);
        assert.equal(await js(`window.timeoutFixture.requests.length`),4,'disposed panels cannot restart polling');
        assert.equal(await js(`document.querySelector('#resource-timeout').children.length`),0);
        await js(`document.querySelector('#resource-timeout').remove()`);
        console.log('PASS scheduled tasks UI: full app entry, real form, review/cancel/confirm, saved task, light/dark, 320/390px, conditional dates, 300 conversations, payload limit, stale refresh errors and single-flight reads and timeout recovery');
    }
    catch (e) {
        console.error(e);
        if (win)
            console.log(await win.webContents.executeJavaScript("document.querySelector('.extension-panel')?.outerHTML"));
        process.exitCode = 1;
    }
    finally {
        win?.destroy();
        await hub?.shutdown();
        clearTimeout(timeout);
        app.exit(process.exitCode || 0);
    }
});
