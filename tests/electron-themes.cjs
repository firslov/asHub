// Real application HTML/CSS, synthetic content; no Hub, sessions or model calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const root = process.env.ASHUB_TEST_ROOT || path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-themes-'));
app.setPath('userData', profile);
let win, server;
const timeout = setTimeout(() => app.exit(2), 60000);
const source = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
const fixture = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  .replace('</head>', '<style>*{animation:none!important;transition:none!important}</style></head>');
async function seed() {
  document.documentElement.lang = 'zh';
  document.documentElement.style.setProperty('--ui-title-bar-height', '52px');
  document.documentElement.dataset.platform = 'linux';
  document.querySelector('#page-loader')?.remove();
  document.querySelector('.app').dataset.uiTabsEnabled = 'true';
  document.querySelector('.app').style.setProperty('--sidebar-w', '240px');
  document.querySelector('.session-head').hidden = true;
  document.querySelector('#conn').textContent = '';
  document.querySelector('#version-label').textContent = 'v0.21.0';
  const tabs = document.querySelector('#session-tabs'); tabs.hidden = false;
  tabs.innerHTML = '<button class="session-tab active" role="tab" aria-selected="true">设计与实现</button><button class="session-tab" role="tab" aria-selected="false">资料整理</button>';
  document.querySelector('.sidebar-view-label').textContent = '会话';
  document.querySelector('#new-session span').textContent = '新建对话';
  document.querySelector('#sessions').innerHTML = ['设计与实现', '资料整理', '验证与发布', '探索新的可能'].map((name,i) => `<li class="${i===0?'current':''}"><a href="#"><span class="session-title">${name}</span><span class="session-cwd">${i===0?'asHub · 产品设计':'asHub · 工作空间'}</span></a></li>`).join('');
  const wrap = document.querySelector('.terminal-wrap');
  // Entrance animation is disabled for deterministic captures; use its final state.
  wrap.style.opacity = '1';
  Object.assign(wrap.dataset, { uiConversationCenter: 'true', uiMessageGradient: 'false', uiReplyBorderShow: 'false', uiTurnSepShow: 'false', uiTurnTimeShow: 'false', uiUsageAlign: 'left' });
  const view = document.querySelector('#session-view-tpl').content.cloneNode(true);
  const terminal = wrap.querySelector('.terminal'); terminal.insertBefore(view, document.querySelector('#form'));
  const stream = terminal.querySelector('.session-stream');
  stream.innerHTML = `<div class="agent-box"><div class="turn-time">2026/11/01 14:32</div><div class="agent-text">为 asHub 设计一套更从容的工作界面<br>保留温度 让内容成为主角</div></div>
    <div class="execution-activity"><button class="execution-activity-head"><span class="execution-activity-dot"></span><span class="execution-activity-label">处理完成</span><span class="execution-activity-count">4 次调用</span><span class="execution-activity-toggle">处理详情 ›</span><time class="execution-activity-time">14:32:18</time></button></div>
    <div class="agent-reply"><h2>安静的界面，清晰的思路</h2><p>以暖白与炭灰构建阅读空间，用少量哑金标记<strong>真正值得关注的内容</strong>。每一种状态，都有恰到好处的表达。</p><h3>让协作自然发生</h3><ul><li><strong>项目协作</strong> · 不同职能的对话，在同一项目中有序推进</li><li><strong>移动访问</strong> · 离开电脑，也能跟进任务与查看成果</li><li><strong>专注阅读</strong> · 收起执行细节，保留结论和关键依据</li></ul><pre><code class="hljs language-typescript"><span class="hljs-keyword">const</span> workspace = {\n  theme: <span class="hljs-string">'ivory'</span>,\n  focus: <span class="hljs-string">'what matters'</span>\n};</code></pre><p>设计细节已整理到 <a href="#">工作空间设计说明.md</a>，可直接预览。</p></div>`;
  const usage = terminal.querySelector('.usage-strip'); usage.hidden = false;
  usage.innerHTML = '<span class="usage-chip">gpt-6.1-sol</span><span class="usage-chip">高强度思考</span><span class="usage-chip">缓存 96.8%</span><span class="usage-chip">12.4k tokens</span>';
  document.querySelector('#query').placeholder = '继续你的想法…';
  document.querySelector('#query').value = '让我们开始';
  document.querySelector('#query').dataset.uiInputFocusRing = 'false';
  document.querySelector('#send-btn').disabled = false;
  document.querySelector('#vision-indicator').hidden = false;
  document.querySelector('#form').dataset.uiInputGradient = 'false';
  document.querySelector('#composer-help [data-i18n="composer.shortcuts"]').textContent = '/ 指令 · @ 文件 · # 提示词';
  document.querySelector('.composer-keyboard').textContent = 'Enter 发送';
  // Drawer uses real primitives; synthetic field values avoid personal settings.
  const panel = document.querySelector('#ctx-panel');
  panel.innerHTML = '<div class="p-head"><div class="p-heading"><span class="p-title">工作空间</span><span class="p-meta">偏好与连接</span></div><button class="p-icon-btn" aria-label="关闭">×</button></div><div class="p-body"><div class="p-section">模型与思考</div><label class="p-label" for="theme-model">当前模型</label><select class="p-select" id="theme-model"><option>GPT-6.1 Sol</option><option>DeepSeek V4</option></select><div class="p-section">项目名称</div><input class="p-input" value="asHub 体验设计" aria-label="项目名称"><div class="p-section">操作</div><button class="p-btn-primary">保存设置</button><button class="p-btn" disabled>正在同步</button><p class="p-meta">更改将应用于当前工作空间</p></div>';
  await document.fonts.ready;
}
function inspectPalette() {
  const css = getComputedStyle(document.documentElement);
  const rgb = value => {
    const p = document.createElement('span'); p.style.color = value; document.body.append(p);
    const c = getComputedStyle(p).color.match(/[\d.]+/g).slice(0,3).map(Number); p.remove(); return c;
  };
  const luminance = c => c.map(v => { v/=255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4; }).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
  const contrast = (a,b) => { const x=luminance(a), y=luminance(b); return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
  const resolve = token => rgb(css.getPropertyValue(token).trim());
  const reports = [];
  for(const surface of ['--bg','--bg2','--bg3','--bg-elevated']) {
    for(const token of ['--text','--text-dim','--text-mid','--text-faint','--accent','--red','--green','--cyan','--purple','--amber','--aqua']) reports.push({token,surface,ratio:contrast(resolve(token),resolve(surface))});
  }
  for(const background of ['--accent','--accent-hover','--cyan','--red']) reports.push({token:'--on-accent',surface:background,ratio:contrast(resolve('--on-accent'),resolve(background))});
  return { reports, scheme:css.colorScheme, overflow:document.documentElement.scrollWidth>innerWidth,
    visible: document.querySelector('#send-btn').checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),
    send: getComputedStyle(document.querySelector('#send-btn')).color !== getComputedStyle(document.querySelector('#send-btn')).backgroundColor };
}
app.whenReady().then(async () => {
  server = http.createServer((req,res) => {
    if(req.url==='/fixture'){res.setHeader('Content-Type','text/html');res.end(fixture);return;}
    const base=path.join(root,'web'), file=path.resolve(base,'.'+new URL(req.url,'http://localhost').pathname);
    if(!file.startsWith(base+path.sep)){res.writeHead(404);res.end();return;}
    fs.readFile(file,(e,data)=>{if(e){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream');res.end(data);});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  win = new BrowserWindow({width:1440,height:960,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const run = js => win.webContents.executeJavaScript(js);
  win.webContents.debugger.attach('1.3');
  await win.loadURL(`http://127.0.0.1:${server.address().port}/fixture`);
  await run(`(${seed})()`);
  const debug=win.webContents.debugger;
  await debug.sendCommand('DOM.enable');await debug.sendCommand('CSS.enable');
  const {root:dom}=await debug.sendCommand('DOM.getDocument');
  const {nodeId:fieldNode}=await debug.sendCommand('DOM.querySelector',{nodeId:dom.nodeId,selector:'#ctx-panel .p-input'});
  for(const theme of ['light','dark']) {
    await run(`document.documentElement.dataset.theme='${theme}';document.documentElement.dataset.nativeTitlebar='mac'`);
    const result = await run(`(${inspectPalette})()`);
    assert.equal(result.scheme,theme); assert(result.send && result.visible,'send icon must stay visible');
    for(const r of result.reports) assert(r.ratio>=4.5,`${theme}: ${r.token} on ${r.surface} contrast ${r.ratio.toFixed(2)} < 4.5`);
    for(const width of [1440,900,390]) {
      win.setContentSize(width,960);
      await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      assert(!(await run(`(${inspectPalette})()`)).overflow,`${theme}/${width}: horizontal overflow`);
      // Exercise focus and drawer geometry at desktop and mobile widths.
      await debug.sendCommand('CSS.forcePseudoState',{nodeId:fieldNode,forcedPseudoClasses:['focus','focus-visible','hover']});
      const focus = await run(`(()=>{const p=document.querySelector('#ctx-panel');p.hidden=false;const field=p.querySelector('.p-input');field.focus();const c=getComputedStyle(field);return {border:c.borderColor,rect:p.getBoundingClientRect().toJSON(),visible:c.display!=='none',focused:document.activeElement===field,accent:getComputedStyle(p.querySelector('.p-btn-primary')).backgroundColor};})()`);
      assert.equal(focus.border,focus.accent, `${theme}/${width}: focus edge must use the solid accent`);
      assert(focus.focused && focus.visible && focus.rect.left>=0 && focus.rect.right<=width, `${theme}/${width}: drawer outside viewport`);
      await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      const out=process.env.ASHUB_THEME_SCREENSHOTS;
      if(out && width===1440){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,`${theme}-panel.png`),(await win.webContents.capturePage()).toPNG());}
      await debug.sendCommand('CSS.forcePseudoState',{nodeId:fieldNode,forcedPseudoClasses:[]});
      await run('document.querySelector("#ctx-panel").hidden=true;document.activeElement.blur();new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      if(width===1440) {
        if(out){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,`${theme}.png`),(await win.webContents.capturePage()).toPNG());}
      }
    }
    // Explicit user customization must still win over the new material.
    assert.equal(await run(`(()=>{const w=document.querySelector('.live-wrap');w.style.setProperty('--ui-message-bg-color','#123456');const c=getComputedStyle(w.querySelector('.agent-box')).backgroundColor;w.style.removeProperty('--ui-message-bg-color');return c})()`),'rgb(18, 52, 86)');
    win.setContentSize(1440,960);
    if(process.env.ASHUB_THEME_SCREENSHOTS){
      await run(`(()=>{const stream=document.querySelector('.session-stream');window.previewConversation=stream.innerHTML;const welcome=document.querySelector('#session-view-tpl').content.querySelector('.stream-empty').cloneNode(true);welcome.querySelector('.welcome-title').textContent='工作，从这里展开';welcome.querySelector('.welcome-description').textContent='一个想法，一个项目，一种新的可能';welcome.querySelector('.stream-empty-prompt').remove();stream.replaceChildren(welcome);})()`);
      await run('document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))');
      fs.writeFileSync(path.join(process.env.ASHUB_THEME_SCREENSHOTS,`${theme}-welcome.png`),(await win.webContents.capturePage()).toPNG());
      await run("document.querySelector('.session-stream').innerHTML=window.previewConversation");
    }
    for(const platform of ['mac', 'browser', 'win32']) {
      for(const width of [900,1440]) {
        win.setContentSize(width,960);
        const brand = await run(`(()=>{
          const html=document.documentElement;
          html.dataset.nativeTitlebar='${platform}'==='mac'?'mac':'';
          html.classList.toggle('os-win32','${platform}'==='win32');
          document.querySelector('#win-title-bar').hidden='${platform}'!=='win32';
          const word=document.querySelector('${platform}'==='win32'?'.win-title-bar-drag .brand-wordmark':'.title-brand .brand-wordmark');
          const rect=word.getBoundingClientRect(), text=word.querySelector('text').getBBox(), view=word.viewBox.baseVal;
          const tabs=document.querySelector('#session-tabs').getBoundingClientRect();
          return {text:{x:text.x,y:text.y,width:text.width,height:text.height},left:rect.left,right:rect.right,visible:word.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),textFits:text.x>=0&&text.x+text.width<=view.width&&text.y>=view.y&&text.y+text.height<=view.y+view.height,tabsLeft:tabs.left,duplicate:getComputedStyle(document.querySelector('.title-brand')).display!=='none',overflow:html.scrollWidth>innerWidth};
        })()`);
        assert(brand.visible && brand.textFits && !brand.overflow, `${theme}/${platform}/${width}: clipped lettering or overflow ${JSON.stringify(brand)}`);
        if(platform==='mac') assert(brand.left>=104 && brand.tabsLeft>brand.right+20, 'Mac controls and navigation need breathing room');
        if(platform==='browser') assert(brand.left<30, 'browser must not reserve native Mac controls');
        if(platform==='win32') assert(!brand.duplicate, 'Windows must show only one wordmark');
      }
    }
    await run("document.documentElement.classList.remove('os-win32');document.documentElement.dataset.nativeTitlebar='';document.querySelector('#win-title-bar').hidden=true");
    // Simulate a mismatched compositor backing surface under the Windows canvas.
    // Corner pixels must come from the surrounding chrome, even during stream repaint.
    win.setContentSize(1180,900);
    const probe=await run(`(async()=>{
      const doc=document.documentElement, main=document.querySelector('.main');
      doc.classList.add('os-win32');doc.dataset.platform='win32';
      document.querySelector('#ctx-panel').hidden=true;
      const shell=document.querySelector('.app');shell.style.backgroundColor='rgb(112,112,112)';
      const layer=document.querySelector('.terminal'); layer.style.transform='translateZ(0)';
      const reply=document.createElement('p');reply.textContent='Streaming reply';layer.querySelector('.session-stream').append(reply);
      await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const rect=main.getBoundingClientRect();
      const ref=document.createElement('div');ref.style.background='var(--bg2)';main.append(ref);
      const bg=getComputedStyle(ref).backgroundColor.match(/\\d+/g).map(Number);ref.remove();
      return {left:Math.ceil(rect.left),right:Math.floor(rect.right),top:Math.ceil(rect.top),bg};
    })()`);
    for(const x of [probe.left+2,probe.right-3]){
      const image=await win.webContents.capturePage({x,y:probe.top+2,width:1,height:1});
      const [b,g,r]=image.toBitmap();
      assert([r,g,b].every((v,i)=>Math.abs(v-probe.bg[i])<=3),theme+' Windows canvas corner: '+[r,g,b]+' expected '+probe.bg);
    }
    await run("document.querySelector('.app').style.removeProperty('background-color'); document.querySelector('.terminal').style.removeProperty('transform');document.documentElement.classList.remove('os-win32');document.documentElement.dataset.platform='linux'");
    console.log(`PASS ${theme}: 48 contrast pairs, 3 viewport sizes, focus, preferences, Mac/browser/Windows branding`);
  }
}).then(()=>finish(0),e=>{console.error(e);finish(1)});
function finish(code){clearTimeout(timeout);if(win&&!win.isDestroyed())win.destroy();server?.close();fs.rmSync(profile,{recursive:true,force:true});app.exit(code);}
