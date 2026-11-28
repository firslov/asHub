// Real Chromium layout: `npm run test:layout` from remote/ after the desktop dependencies are installed.
// Synthetic frames only; no server, user sessions, credentials or model requests.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const branchOutput = execFileSync(process.execPath, [path.join(__dirname, 'render-branch-fixture.cjs')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000,
});
const branchFrames = JSON.parse(branchOutput.split('\n').find(line => line.startsWith('BRANCH ')).slice(7));
const previewOutput = execFileSync(process.execPath, [path.join(__dirname, 'render-preview-fixture.cjs')], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20000,
});
const previewFrames = JSON.parse(previewOutput.split('\n').find(line => line.startsWith('PREVIEW ')).slice(8));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-remote-layout-'));
app.setPath('userData', profile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const watchdog = setTimeout(() => finish(1), 30000);
let win;
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 390, height: 844, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'public/index.html'));
  const run = code => win.webContents.executeJavaScript(code);
  const position = () => run(`(() => {
    const m = $('messages');
    return { top: m.scrollTop, gap: m.scrollHeight - m.scrollTop - m.clientHeight,
      replies: m.querySelectorAll('.reply').length, ready: streamReady,
      pending: frameQueue.length, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`);
  for(const width of [320,390,1040]) for(const theme of ['light','dark']) {
   win.setContentSize(width,760);
   const result=await run(`(()=>{
    document.documentElement.dataset.theme='${theme}';$('auth').hidden=true;$('workspace').hidden=false;
    user='demo';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];
    resetMessages();controls();menu(false);
    for(const [i,name] of ['agent:processing-start','agent:thinking-chunk','agent:processing-done'].entries())
     frame({meta:{name,ts:Date.UTC(2026,9,30,8,12,32+i)},payload:{text:'核对项目成员返回结果'}});
    const time=$('messages').querySelector('summary time'),rect=time.getBoundingClientRect();
    return {iso:time.dateTime,visible:!time.hidden&&rect.width>0&&rect.height>0,inside:rect.left>=0&&rect.right<=innerWidth,
     overflow:document.documentElement.scrollWidth>innerWidth};
   })()`);
   assert.deepEqual(result,{iso:'2026-10-30T08:12:34.000Z',visible:true,inside:true,overflow:false});
   await wait(50);
   await fs.promises.writeFile(`/tmp/ashub-remote-time-${theme}-${width}.png`,(await win.webContents.capturePage()).toPNG());
  }
  for(const width of [320,390,1040]) {
    win.setContentSize(width,760);
    const layout=await run(`(()=>{
      user='demo';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];
      streamReady=true;capabilities={steering:true};activity=true;controls();menu(false);
      const selectors=['model','delivery-mode','stop','send'];
      const boxes=selectors.map(id=>{const r=$(id).getBoundingClientRect();return {id,left:r.left,right:r.right,width:r.width,height:r.height};});
      return {boxes,overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert(!layout.overflow,JSON.stringify(layout));
    for(const b of layout.boxes)assert(b.width>0&&b.left>=0&&b.right<=width+1,JSON.stringify(layout));
    for(let i=1;i<layout.boxes.length;i++)assert(layout.boxes[i-1].right<=layout.boxes[i].left+1,JSON.stringify(layout));
    await fs.promises.writeFile('/tmp/ashub-steering-mobile-'+width+'.png',(await win.webContents.capturePage()).toPNG());
  }
  await run('activity=false;controls()');
  console.log('PASS steering composer: model, follow-up mode, stop and send remain visible at 320/390/1040px');
  for (const width of [320, 390, 1040]) {
    win.setContentSize(width, 760);
    const layout = await run(`(async () => {
      resetMessages();
      const emit = (name, payload) => frame({meta:{name},payload});
      const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 40;
      emit('agent:query', {query:'好的'});
      emit('agent:query', {query:'LongUnbrokenText'.repeat(60)});
      emit('agent:query', {query:'',images:[{mimeType:'image/png',data:canvas.toDataURL().split(',')[1]}]});
      emit('agent:response-segment', {text:'回复仍然使用完整正文栏'});
      const m = $('messages'), users = [...m.querySelectorAll('.message.user')], imageMessage = users[2];
      await imageMessage.querySelector('button').onclick();
      const box = e => { const {left,right,width,height}=e.getBoundingClientRect(); return {left,right,width,height}; };
      const img = imageMessage.querySelector('img');
      return {users:users.map(box),reply:box(m.querySelector('.message.reply')),image:box(img),naturalWidth:img.naturalWidth,
        textAlign:getComputedStyle(users[1]).textAlign,overflow:m.scrollWidth>m.clientWidth+1};
    })()`);
    const context = JSON.stringify({width,layout});
    const [short, long, attachment] = layout.users, cap = layout.reply.width * .9;
    assert(layout.reply.width > 0 && !layout.overflow, context);
    assert(Math.abs(long.width - cap) <= 1 && short.width < long.width - 20, context);
    for (const user of layout.users) {
      assert(user.width <= cap + 1 && Math.abs(user.right - layout.reply.right) <= 1, context);
    }
    assert.match(layout.textAlign, /^(start|left)$/);
    assert(short.height < long.height, 'long text wraps naturally');
    assert.equal(layout.naturalWidth, 1800);
    assert(layout.image.width > 0 && layout.image.left >= attachment.left && layout.image.right <= attachment.right, context);
  }
  console.log('PASS remote user messages: right-aligned adaptive bubbles and bounded attachments at 320/390/1040px');
  win.setContentSize(390,844);
  // Opening the software keyboard can shrink the visual viewport without
  // changing CSS media-query height (notably on iOS).
  await run(`(() => {
    $('auth').hidden=true; $('workspace').hidden=false;
    user='demo'; device='desktop'; session=''; deviceListReady=true; sessionListDevice=device;
    devices=[{id:device,online:true}];
    sessions=[{instanceId:'aaaaaa',title:'Searchable conversation'}];
    sessionSearchExpanded=true; renderSessions();
    document.documentElement.style.setProperty('--viewport-height','360px');
    notice('连接暂时中断，请稍后重试');
  })()`);
  const compactHome = await run(`(() => {
    const list=$('sessions'), row=list.querySelector('button'), sidebar=$('sidebar');
    row.scrollIntoView({block:'nearest',behavior:'instant'});
    const rowBounds=row.getBoundingClientRect();
    return {listHeight:list.clientHeight,rowTop:rowBounds.top,rowBottom:rowBounds.bottom,
      viewport:sidebar.getBoundingClientRect().bottom,overflow:getComputedStyle(sidebar).overflowY};
  })()`);
  assert(compactHome.listHeight >= 44 && compactHome.rowTop >= -1 && compactHome.rowBottom <= compactHome.viewport + 1,
    `keyboard and notices must not collapse the session list: ${JSON.stringify(compactHome)}`);
  const compactFooter = await run(`(() => {
    $('account').scrollIntoView({block:'nearest',behavior:'instant'});
    return $('account').getBoundingClientRect().bottom <= $('sidebar').getBoundingClientRect().bottom + 1;
  })()`);
  assert(compactFooter, 'account actions must remain reachable with the keyboard open');
  await run(`document.documentElement.style.removeProperty('--viewport-height'); sessionSearchExpanded=false; notice(); renderSessions(); $('sidebar').scrollTop=0`);
  console.log('PASS keyboard viewport: search results and account actions remain reachable');
  for(const width of [320,390,1200]) {
    win.setContentSize(width,844);await wait(80);
    await run(`user='demo';device='desktop';session='';deviceListReady=true;sessionListDevice=device;devices=[{id:device,online:true}];groups=[{id:'p',name:'论文审阅',sessionIds:['aaaaaa','bbbbbb']}];viewFilter='project:p';sessions=[{instanceId:'aaaaaa',title:'方法复核',cwd:'/workspace/main',projectExternal:false},{instanceId:'bbbbbb',title:'补充资料',cwd:'/workspace/references/非常长的外部文献目录',projectExternal:true}];renderSessions()`);
    const layout=await run(`(()=>{const b=document.querySelector('.session-directory'),row=b.parentElement.getBoundingClientRect(),r=b.getBoundingClientRect();return {label:b.textContent,inside:r.left>=row.left&&r.right<=row.right&&r.bottom<=row.bottom,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
    assert(layout.inside&&!layout.overflow,JSON.stringify(layout));assert.match(layout.label,/其他目录/);
    await fs.promises.writeFile('/tmp/ashub-remote-directory-'+width+'.png',(await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('.session-directory').click()`);
    assert.equal(await run(`$('modal-body').textContent`),'/workspace/references/非常长的外部文献目录');
    assert.equal(await run('session'),'');await run(`$('modal').close()`);
  }
  await run(`groups=[];viewFilter='all'`);

  // Completed adjacent records share one touch target while all diagnostics
  // remain readable. Exercise native details toggles and both mobile palettes.
  for (const theme of ['light', 'dark']) {
    win.setContentSize(390, 844);
    await run(`(() => {
      document.documentElement.dataset.theme = '${theme}';
      session='aaaaaa'; resetMessages(); controls(); menu(false);
      frame({meta:{name:'agent:query'},payload:{query:'核对项目结果'}});
      frame({meta:{name:'agent:response-segment'},payload:{text:'检查已完成，详细记录可按需展开'}});
      frame({meta:{name:'agent:processing-done'},payload:{}});
      for (const text of ['已核对输入文件', '已检查输出内容', '已完成一致性验证']) {
        frame({meta:{name:'agent:processing-start'},payload:{}});
        frame({meta:{name:'agent:thinking-chunk'},payload:{text}});
        frame({meta:{name:'agent:processing-done'},payload:{}});
      }
    })()`);
    const collapsed = await run(`(() => {
      const g = document.querySelector('.record-group'), s = g.querySelector('summary');
      return {groups:document.querySelectorAll('.record-group').length,members:g._recordPhases.length,
        label:s.textContent,height:s.getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth};
    })()`);
    assert.equal(collapsed.groups, 1); assert.equal(collapsed.members, 3);
    assert.equal(collapsed.label, '处理记录'); assert(collapsed.height >= 44); assert(!collapsed.overflow);
    await fs.promises.writeFile('/tmp/ashub-remote-records-' + theme + '.png', (await win.webContents.capturePage()).toPNG());
    await run(`document.querySelector('.record-group > summary').click()`); await wait(80);
    await run(`document.querySelectorAll('.thinking-step').forEach(n=>{n.open=true;n.ontoggle()})`);
    const expanded = await run(`(() => {
      const g=document.querySelector('.record-group');
      return {open:g.open,texts:[...g.querySelectorAll('.thinking-text')].map(n=>n.textContent.trim()),
        visible:[...g.querySelectorAll('.thinking-text')].every(n=>n.getBoundingClientRect().height>0),
        hiddenSummaries:[...g.querySelectorAll('.record-group > .detail > summary')].every(n=>getComputedStyle(n).display==='none')};
    })()`);
    assert(expanded.open && expanded.visible && expanded.hiddenSummaries);
    assert.deepEqual(expanded.texts, ['已核对输入文件', '已检查输出内容', '已完成一致性验证']);
    await run(`frame({meta:{name:'agent:error'},payload:{message:'连接中断'}})`); await wait(50);
    assert.equal(await run(`document.querySelectorAll('.record-group').length`), 0);
  }
  await run(`resetMessages(); session=''; controls()`);
  console.log('PASS completed record groups: mobile touch targets, dark/light layout, lazy expansion and interruption recovery');

  // The real mobile shell must expose usable selection controls before any chat.
  for (const [width, height] of [[390, 844], [320, 568], [568, 320], [1200, 800]]) {
    win.setContentSize(width, height); await wait(80);
    for (const theme of ['light', 'dark']) {
      const home = await run(`(() => {
        $('auth').hidden = true; $('workspace').hidden = false;
        document.documentElement.dataset.theme = '${theme}';
        user = 'demo'; device = 'desktop'; session = ''; deviceListReady = true; sessionListDevice = device;
        devices = [{ id: device, name: '我的 MacBook Pro', online: true }];
        $('devices').replaceChildren(Object.assign(document.createElement('option'), {textContent: devices[0].name, value:device}));
        $('device-status').textContent = '● 电脑在线'; $('new-chat').disabled = false;
        sessions = [
          {instanceId:'aaaaaa',title:'产品设计 · 梳理下一版的重点',hasUnread:true},
          {instanceId:'bbbbbb',title:'论文审阅 · 核对方法与数据',isProcessing:true},
          {instanceId:'cccccc',title:'整理本周的工作记录',lastModified:Date.now()}
        ];
        renderSessions(); menu(false);
        const sidebar = $('sidebar').getBoundingClientRect();
        return { inert: $('sidebar').inert, left:sidebar.left, right:sidebar.right,
          chatVisible:getComputedStyle(document.querySelector('main')).display !== 'none',
          overflow:document.documentElement.scrollWidth > innerWidth,
          listHeight:$('sessions').getBoundingClientRect().height,
          closeVisible:getComputedStyle($('close-sidebar')).display !== 'none',
          accountVisible:$('account').getBoundingClientRect().height >= 44 };
      })()`);
      assert(!home.overflow, JSON.stringify(home)); assert.equal(home.inert, false);
      assert(home.listHeight >= 48); assert(home.accountVisible);
      if (width <= 760) {
        assert.equal(home.chatVisible, false); assert.equal(home.closeVisible, false);
        assert(home.left >= 0 && home.right <= width);
      } else assert.equal(home.chatVisible, true);
      if (width === 390) fs.writeFileSync(path.join(os.tmpdir(), 'ashub-mobile-home-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log(`PASS ${width}x${height} ${theme}: selection home is accessible without opening a drawer`);
    }
    const transition = await run(`(() => {
      session='aaaaaa'; controls(); menu(false);
      const chatVisible=getComputedStyle(document.querySelector('main')).display !== 'none';
      const drawerHidden=$('sidebar').inert;
      resetSession();
      return {chatVisible, drawerHidden, returned:!$('sidebar').inert && $('workspace').classList.contains('choosing-session')};
    })()`);
    assert(transition.chatVisible); assert.equal(transition.drawerHidden, width <= 760); assert(transition.returned);
  }
  const checklist = await run(`(() => {
    session='aaaaaa';resetMessages();controls();menu(false);
    frame({meta:{name:'agent:processing-start'}});
    frame({meta:{name:'agent:thinking-chunk'},payload:{text:'- [x] **已核对**\\n- [ ] 待检查'}});
    const phase=details;
    frame({meta:{name:'agent:processing-done'}});
    phase.box.open=true;phase.box.ontoggle();
    const disclosure=phase.body.querySelector('.thinking-step');
    disclosure.open=true;disclosure.ontoggle();
    const result={items:[...disclosure.querySelectorAll('li')].map(n=>n.textContent.trim()),
      interactive:!!disclosure.querySelector('input'),bold:disclosure.querySelector('strong')?.textContent};
    resetMessages();return result;
  })()`);
  assert.deepEqual(checklist.items,['☑ 已核对','☐ 待检查']);
  assert.equal(checklist.interactive,false);assert.equal(checklist.bold,'已核对');
  console.log('PASS thought checklists preserve completed/pending states without interactive inputs');

  for (const [width, height] of [[390, 844], [320, 568], [568, 320], [1200, 800]]) {
    win.setContentSize(width, height); await wait(200);
    await run(`(() => {
      $('auth').hidden = true; $('workspace').hidden = false;
      user = 'demo'; device = 'desktop'; session = 'aaaaaa'; devices = [{ id: device, online: true }];
      menu(false); resetMessages(); streamReady = false;
      window.emitFrame = (name, payload = {}) => frame({ meta: { name }, payload });
      for (let i = 0; i < 12; i++) {
        enqueueFrame({ meta: { name: 'agent:query' }, payload: { query: '核对研究方法 ' + i } });
        enqueueFrame({ meta: { name: 'agent:processing-start' } });
        for (let j = 0; j < 4; j++) {
          const toolCallId = i + '-' + j;
          enqueueFrame({ meta: { name: 'agent:tool-started' }, payload: { toolCallId, name: 'read_file' } });
          enqueueFrame({ meta: { name: 'agent:tool-output-chunk' }, payload: { toolCallId, chunk: 'Sample output' } });
          enqueueFrame({ meta: { name: 'agent:tool-completed' }, payload: { toolCallId, success: true } });
        }
        enqueueFrame({ meta: { name: 'agent:response-segment' }, payload: { text: ('这是第 ' + i + ' 轮核对结果，资料和分析已经完成。\\n\\n').repeat(20) } });
        enqueueFrame({ meta: { name: 'agent:processing-done' } });
      }
      enqueueFrame({ meta: { name: 'hub:replay-done' } });
    })()`);
    // Allow both the replay queue and any accidental smooth scroll to settle.
    await wait(1200);
    let state = await position();
    assert.equal(state.pending, 0); assert.equal(state.ready, true); assert.equal(state.replies, 12);
    assert(state.gap <= 2, `batched replay must reach the latest message at ${width}x${height}: ${JSON.stringify(state)}`);
    assert(!state.overflow);
    console.log(`PASS ${width}x${height}: batched history follows the latest message`);

    await run(`emitFrame('agent:query', { query: '继续核对' }); emitFrame('agent:processing-start')`);
    for (let i = 0; i < 5; i++) {
      await run(`emitFrame('agent:response-chunk', { blocks: [{ type: 'text', text: '新增分析结果，供继续核对。\\n\\n'.repeat(12) }] })`);
      await wait(140);
    }
    await wait(600);
    state = await position();
    assert(state.gap <= 2, `streaming must retain automatic following at ${width}x${height}: ${JSON.stringify(state)}`);
    console.log(`PASS ${width}x${height}: streamed replies remain at the bottom`);

    // Queue RPC settles after replay/stream rendering. Its composer panel
    // shrinks the message viewport and must retain the existing bottom anchor.
    await run(`(() => {
      clearTimeout(queueTimer); queueRevision++;
      capabilities.queue = true;
      window.originalQueueFetch = window.fetch;
      window.fetch = async (url, options) => {
        if (JSON.parse(options?.body || '{}').op === 'queue') {
          await new Promise(resolve => setTimeout(resolve, 100));
          return {ok:true,json:async()=>Array.from({length:3},(_,i)=>({id:'late-'+i,query:'来自项目成员的排队消息'}))};
        }
        return window.originalQueueFetch(url, options);
      };
      scheduleQueue();
    })()`);
    await wait(300);
    state = await position();
    assert.equal(await run(`$('queued-messages').children.length`), 3);
    assert(state.gap <= 2, `late queue must retain the latest message at ${width}x${height}: ${JSON.stringify(state)}`);
    await run(`emitFrame('agent:response-chunk', {blocks:[{type:'text',text:'异步队列加载后仍需跟随新的回复。'.repeat(20)}]})`);
    await wait(150);
    assert((await position()).gap <= 2, 'late queue must not disable following subsequent output');
    await run(`queuedMessages=[];renderQueue();window.fetch=window.originalQueueFetch;delete window.originalQueueFetch;capabilities.queue=false`);
    assert((await position()).gap <= 2, 'removing the queue must retain the bottom anchor');
    console.log(`PASS ${width}x${height}: delayed queue loading preserves bottom following`);

    // Emulate a reader scrolling back while the same reply continues.
    await run(`$('messages').dispatchEvent(new WheelEvent('wheel',{deltaY:-500,bubbles:true}));$('messages').scrollTo({ top: 100, behavior: 'instant' })`);
    const reading = await position();
    await run(`emitFrame('agent:response-chunk', { blocks: [{ type: 'text', text: '后续结果。\\n\\n'.repeat(20) }] }); emitFrame('agent:processing-done')`);
    await wait(300);
    state = await position();
    assert(Math.abs(state.top - reading.top) <= 2, `new output must not pull a reader away from history: ${JSON.stringify(state)}`);
    assert(state.gap > 140);
    console.log(`PASS ${width}x${height}: reading history is not interrupted`);

    // Queue changes must not pull someone away from earlier messages.
    await run(`capabilities.queue=true;queuedMessages=[{id:'reading',query:'稍后处理'}];renderQueue()`);
    assert(Math.abs((await position()).top-reading.top)<=2, 'queue appearance must preserve reading position');
    await run(`queuedMessages=Array.from({length:3},(_,i)=>({id:'reading-'+i,query:'稍后处理'}));renderQueue()`);
    assert(Math.abs((await position()).top-reading.top)<=2, 'queue growth must preserve reading position');
    await run(`capabilities.queue=false;renderQueue()`);
    assert(Math.abs((await position()).top-reading.top)<=2, 'hiding an unsupported queue must preserve reading position');
    await run(`capabilities.queue=true;renderQueue();scroll(true);capabilities.queue=false;renderQueue();queuedMessages=[]`);
    assert((await position()).gap<=2, 'hiding an unsupported queue must preserve the bottom anchor');

    const rebuilding = await run(`(() => {
      $('query').value = '保留这条草稿';
      streamReady = true; controls();
      for (const data of ${JSON.stringify(branchFrames)}) enqueueFrame(data);
      clearTimeout(frameTimer); drainFrames();
      return { pending: frameQueue.length, ready: streamReady, sendDisabled: $('send').disabled,
        stopHidden: $('stop').hidden, connection: $('connection').textContent };
    })()`);
    assert(rebuilding.pending > 0);
    assert.equal(rebuilding.ready, false); assert.equal(rebuilding.sendDisabled, true);
    assert.equal(rebuilding.stopHidden, true); assert.match(rebuilding.connection, /正在同步/);
    await wait(300);
    state = await position();
    assert.equal(state.pending, 0); assert.equal(state.ready, true); assert.equal(state.replies, 29);
    assert(!state.overflow);
    assert.equal(await run(`$('query').value`), '保留这条草稿');
    assert.equal(await run(`$('send').disabled`), false);
    console.log(`PASS ${width}x${height}: desktop rewind keeps controls locked until replay completes`);

    const preview = await run(`(() => {
      resetMessages(); streamReady = false;
      for (const data of ${JSON.stringify(previewFrames.preview)}) frame(data);
      const banner = $('messages').querySelector('.history-window');
      const button = banner?.querySelector('button');
      const bounds = button?.getBoundingClientRect();
      return { count: $('messages').querySelectorAll('.history-window').length,
        first: $('messages').firstElementChild === banner, left: bounds?.left, right: bounds?.right };
    })()`);
    assert.equal(preview.count, 1); assert.equal(preview.first, true);
    assert(preview.left >= 0 && preview.right <= width, 'full-history action must fit the viewport');
    const historyMode = await run(`(() => {
      window.EventSource = class {
        constructor(url) { this.url = url; this.handlers = new Map(); }
        addEventListener(name, fn) { this.handlers.set(name, fn); }
        close() {}
      };
      $('messages').querySelector('.history-window button').click();
      return source.url.searchParams.get('history');
    })()`);
    assert.equal(historyMode, 'all');
    const full = await run(`(() => {
      source.handlers.get('reset')();
      for (const data of ${JSON.stringify(previewFrames.full)}) frame(data);
      for (const phase of phases) {
        phase.box.open = true; phase.box.ontoggle();
        for (const row of phase.body.children) { row.open = true; row.ontoggle?.(); }
      }
      return { banners: $('messages').querySelectorAll('.history-window').length,
        complete: $('messages').textContent.includes('END_OF_FULL_RESULT'), ready: streamReady };
    })()`);
    assert.equal(full.banners, 0); assert.equal(full.complete, true); assert.equal(full.ready, true);
    console.log(`PASS ${width}x${height}: short rewound history retains a usable full-records action`);

    const queueBounds = await run(`(() => {
      clearTimeout(queueTimer); queueRevision++; capabilities.queue = true; streamReady = true;
      queuedMessages = [{id:'queue-one',query:'请继续检查项目的边界条件和跨平台兼容性'.repeat(12)}, {id:'queue-two',query:'相同内容也可以单独撤回'}];
      renderQueue();
      const panel=$('queued-messages'), bounds=panel.getBoundingClientRect();
      return { overflow:document.documentElement.scrollWidth > innerWidth,
        count:panel.children.length, height:bounds.height,
        buttons:[...panel.querySelectorAll('button')].map(b=>{const r=b.getBoundingClientRect();return {left:r.left,right:r.right};}) };
    })()`);
    assert.equal(queueBounds.overflow,false);assert.equal(queueBounds.count,2);assert(queueBounds.height>0 && queueBounds.height<=140);
    assert(queueBounds.buttons.every(b=>b.left>=0&&b.right<=width));
    await fs.promises.writeFile('/tmp/ashub-queue-mobile-'+width+'.png',(await win.webContents.capturePage()).toPNG());
    await run(`queuedMessages=[];renderQueue()`);
    console.log(`PASS ${width}x${height}: queued edit actions remain visible without horizontal overflow`);

    for (const theme of ['light', 'dark']) {
      const approval = await run(`(() => {
        document.documentElement.dataset.theme = '${theme}';
        resetMessages();
        const longName = 'review_' + 'a'.repeat(64) + '.json';
        const title = 'write_file: /project/' + longName;
        emitFrame('agent:query', { query: '保存审阅结果' });
        emitFrame('agent:processing-start');
        emitFrame('permission:request', { requestId: 'long-name', expiresAt: Date.now() + 60000,
          title, description: '保存文件 ' + longName, metadata: { filePath: '/project/' + longName } });
        const m = $('messages'), card = m.querySelector('.permission');
        card.querySelector('details').open = true;
        const bounds = m.getBoundingClientRect();
        return { width: m.clientWidth, scroll: m.scrollWidth, title: card.querySelector('strong').textContent,
          expectedTitle: title, left: bounds.left, right: bounds.right,
          buttons: [...card.querySelectorAll('button')].map(b => {
            const r = b.getBoundingClientRect(); return { left: r.left, right: r.right };
          }) };
      })()`);
      assert(approval.scroll <= approval.width + 1,
        `approval file names must wrap inside the conversation at ${width}x${height} (${theme}): ${JSON.stringify(approval)}`);
      assert.equal(approval.title, approval.expectedTitle, 'wrapping must preserve the full file name');
      assert.equal(approval.buttons.length, 2);
      assert(approval.buttons.every(b => b.left >= approval.left && b.right <= approval.right));
      await run(`emitFrame('permission:resolved', { requestId: 'long-name' }); emitFrame('agent:processing-done')`);
      assert.equal(await run(`$('messages').querySelectorAll('.permission').length`), 0);
      console.log(`PASS ${width}x${height} ${theme}: long approval file names wrap without hiding actions`);
    }
  }
}).then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  clearTimeout(watchdog);
  win?.destroy();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Chromium may briefly retain cache handles. */ }
  app.exit(code);
}
