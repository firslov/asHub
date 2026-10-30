const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-message-nav-'));
app.setPath('userData',profile);
let win;const wait=ms=>new Promise(r=>setTimeout(r,ms));
const reviewIssues=[];
const timer=setTimeout(()=>app.exit(2),45000);
app.whenReady().then(async()=>{
 win=new BrowserWindow({show:false,width:800,height:620,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 for(const client of ['desktop','remote']){
  if(client==='remote'&&!fs.existsSync(path.join(root,'remote/public/index.html')))continue;
  const base=client==='desktop'?'web':'remote/public';
  const html=fs.readFileSync(path.join(root,base,'index.html'),'utf8');
  const styles=[...html.matchAll(/<link\b[^>]*href="([^"]+\.css)"[^>]*>/g)].map(m=>`<link rel="stylesheet" href="${pathToFileURL(path.join(root,base,m[1].replace(/^\//,'')))}">`).join('');
  const script=client==='desktop'?'/js/conversation-scrollbar.js':'./conversation-scrollbar.js';
  assert(html.includes('src="'+script+'"'));
  const scriptUrl=pathToFileURL(path.join(root,base,script.replace(/^\//,'')));
  const id=client==='desktop'?'scrollbox':'messages';
  const user=client==='desktop'?'agent-box':'message user';
  const reply=client==='desktop'?'agent-reply':'message reply';
  const fixture=path.join(profile,client+'.html');
  fs.writeFileSync(fixture,`<!doctype html><html lang="zh"><meta charset="utf-8">${styles}<script src="${scriptUrl}" defer></script><style>
  body{display:block;padding:24px;overflow:hidden}#fixture{display:block;height:520px;width:100%;max-width:700px;margin:auto}
  #${id}{height:100%;overflow:auto;box-sizing:border-box}#${id}>article{min-height:140px;margin:0 0 20px;padding:16px}*{transition:none!important;animation:none!important}
  </style><div id="fixture" class="live-wrap"><div id="${id}" class="terminal-body session-stream">${Array.from({length:24},(_,i)=>`<article class="${i%2?reply:user}">第 ${i+1} 条消息 · 核对项目结果与后续安排</article>`).join('')}<div class="tool-group"><div class="agent-reply">嵌套内容</div></div><div class="agent-box pending">排队消息</div></div></div></html>`);
  await win.loadFile(fixture);const run=code=>win.webContents.executeJavaScript(code);await wait(100);
  for(const theme of ['light','dark'])for(const width of [390,800]){
   win.setContentSize(width,620);
   await run(`document.documentElement.dataset.theme='${theme}';document.getElementById('${id}').scrollTop=0`);await wait(100);
   const result=await run(`(()=>{const rail=document.querySelector('.conversation-nav');return {count:rail.children.length,current:[...rail.children].findIndex(n=>n.hasAttribute('aria-current')),visible:!rail.hidden,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
   assert.deepEqual(result,{count:24,current:0,visible:true,overflow:false});
   await run(`document.querySelectorAll('.conversation-nav-tick')[8].click()`);await wait(80);
   assert.equal(await run(`document.querySelector('.conversation-nav-tick[aria-current]').title`),'第 9 条消息');
   const aligned=await run(`(()=>{const el=document.getElementById('${id}');return el.children[8].getBoundingClientRect().top-el.getBoundingClientRect().top})()`);
   assert(Math.abs(aligned-16)<2);
   await fs.promises.writeFile(`/tmp/ashub-message-nav-${client}-${theme}-${width}.png`,(await win.webContents.capturePage()).toPNG());
   await run(`document.getElementById('${id}').scrollTop=1e8`);await wait(80);
   assert.equal(await run(`document.querySelector('.conversation-nav-tick[aria-current]').title`),'第 24 条消息');
   console.log('PASS one marker per message, click mapping, reading highlight and end position',client,theme,width);
  }
  await run(`(()=>{const b=document.querySelectorAll('.conversation-nav-tick')[4];b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));})()`);await wait(80);
  assert.equal(await run(`document.activeElement.title`),'第 6 条消息');
  assert.equal(await run(`document.querySelector('.conversation-nav-tick[aria-current]').title`),'第 6 条消息');
  const previous=await run(`document.getElementById('${id}').scrollTop`);
  await run(`(()=>{const m=document.createElement('article');m.className='${reply}';m.textContent='新增回复';document.getElementById('${id}').append(m);})()`);await wait(80);
  assert.equal(await run(`document.querySelectorAll('.conversation-nav-tick').length`),25);
  assert.equal(await run(`document.getElementById('${id}').scrollTop`),previous);
  if(await run(`document.activeElement.title`)!=='第 6 条消息')reviewIssues.push(client+': appending a reply loses keyboard focus');
  await run(`(()=>{const el=document.getElementById('${id}');for(let i=0;i<180;i++){const n=document.createElement('article');n.className='${reply}';n.textContent='长对话 '+i;el.append(n);}})()`);await wait(100);
  assert.equal(await run(`document.querySelectorAll('.conversation-nav-tick').length`),205);
  await run(`(()=>{const b=document.querySelector('.conversation-nav-tick[aria-current]');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));})()`);await wait(100);
  const end=await run(`(()=>{const rail=document.querySelector('.conversation-nav'),b=rail.lastElementChild,r=rail.getBoundingClientRect(),p=b.getBoundingClientRect();return {active:b.getAttribute('aria-current'),visible:p.top>=r.top&&p.bottom<=r.bottom,focused:document.activeElement===b};})()`);
  assert.deepEqual(end,{active:'true',visible:true,focused:true});
  await run(`document.querySelectorAll('.conversation-nav-tick')[100].click();document.activeElement.blur()`);await wait(80);
  await run(`document.getElementById('fixture').style.height='140px'`);await wait(100);
  const resized=await run(`(()=>{const rail=document.querySelector('.conversation-nav'),b=rail.querySelector('[aria-current]'),r=rail.getBoundingClientRect(),p=b.getBoundingClientRect();return p.top>=r.top&&p.bottom<=r.bottom;})()`);
  if(!resized)reviewIssues.push(client+': shrinking viewport hides current marker');
  await run(`document.getElementById('fixture').style.height='520px'`);await wait(80);
  const hoverPoint=await run(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return {x:Math.floor(r.right-14),y:Math.floor(r.top+108)};})()`);
  win.webContents.sendInputEvent({type:'mouseMove',...hoverPoint});await wait(50);
  assert(await run(`document.querySelector('.conversation-nav').matches(':hover')`));
  const beforeHoverResize=await run(`document.getElementById('${id}').scrollTop`);
  await run(`document.getElementById('fixture').style.height='140px'`);await wait(100);
  const hoverResize=await run(`(()=>{const rail=document.querySelector('.conversation-nav'),b=rail.querySelector('[aria-current]'),r=rail.getBoundingClientRect(),p=b.getBoundingClientRect();return {visible:p.top>=r.top&&p.bottom<=r.bottom,hover:rail.matches(':hover'),top:document.getElementById('${id}').scrollTop};})()`);
  assert(hoverResize.hover);assert.equal(hoverResize.top,beforeHoverResize);
  if(!hoverResize.visible)reviewIssues.push(client+': hovering prevents resize from revealing the active marker');
  // Ordinary hovered browsing still stays put when a new reply arrives.
  await run(`document.querySelector('.conversation-nav').scrollTop=0;window.hoverReply=document.createElement('article');hoverReply.className='${reply}';document.getElementById('${id}').append(hoverReply)`);await wait(80);
  assert.equal(await run(`document.querySelector('.conversation-nav').scrollTop`),0);
  await run(`hoverReply.remove()`);await wait(50);
  win.webContents.sendInputEvent({type:'mouseMove',x:1,y:1});await wait(50);
  console.log('PASS hovered browsing stays put and viewport changes preserve the conversation position',client);
  await run(`document.getElementById('fixture').style.height='520px';document.querySelectorAll('.conversation-nav-tick')[204].focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`);await wait(80);
  await run(`document.documentElement.lang='en'`);await wait(80);
  assert.equal(await run(`document.activeElement.title`),'Message 205');
  console.log('PASS long history retains every message, keyboard End reveals target, language updates',client);
  await run(`window.retainedMarker=document.activeElement;window.retainedMessage=document.getElementById('${id}').lastElementChild;
    document.getElementById('${id}').prepend(retainedMessage)`);await wait(80);
  const reordered=await run(`({focused:document.activeElement===retainedMarker,same:document.querySelector('.conversation-nav').firstElementChild===retainedMarker,label:retainedMarker.title,current:document.querySelectorAll('.conversation-nav [aria-current]').length})`);
  assert.deepEqual(reordered,{focused:true,same:true,label:'Message 1',current:1});
  await run(`retainedMarker.click()`);await wait(80);
  assert.equal(await run(`document.querySelector('.conversation-nav [aria-current]')===retainedMarker`),true);
  await run(`retainedMessage.remove()`);await wait(80);
  assert.equal(await run(`document.querySelectorAll('.conversation-nav [aria-current]').length`),1);
  assert.equal(await run(`document.querySelectorAll('.conversation-nav-tick').length`),204);
  console.log('PASS retained node identity, reordered targets and removal of the active message',client);

  await run(`document.getElementById('fixture').hidden=true`);await wait(80);
  assert(await run(`document.querySelector('.conversation-nav').hidden`));
  await run(`document.getElementById('fixture').hidden=false;document.getElementById('${id}').replaceChildren()`);await wait(80);
  assert.equal(await run(`document.querySelectorAll('.conversation-nav-tick').length`),0);
  assert(await run(`document.querySelector('.conversation-nav').hidden`));
  await run(`document.getElementById('fixture').remove()`);await wait(80);
  assert.equal(await run(`document.querySelectorAll('.conversation-nav').length`),0);
  console.log('PASS keyboard, streaming insertion without scroll theft, hidden tab, replay reset and cleanup',client);
  // At the wrapping boundary, a native gutter can itself create the overflow.
  await run(`(()=>{const fixture=document.createElement('div');fixture.className='live-wrap';fixture.id='boundary';
    fixture.innerHTML='<div id="${id}" class="session-stream"><article class="${user}">one</article><article class="${reply}"></article></div>';document.body.append(fixture);
    const style=document.createElement('style');style.textContent='#boundary{display:block;width:200px;height:60px}#boundary>#${id}{height:60px;width:200px;box-sizing:border-box;padding:0;overflow:auto;scrollbar-width:auto}#boundary>#${id}::-webkit-scrollbar{width:18px}#boundary>#${id}>article{padding:0;margin:0;min-height:0;font:20px/20px monospace;overflow-wrap:anywhere;white-space:normal}';document.head.append(style);
    document.querySelector('#boundary article:last-child').textContent='x'.repeat(32);
    window.boundaryChanges=0;window.boundaryWatch=new MutationObserver(rs=>{boundaryChanges+=rs.length});boundaryWatch.observe(document.querySelector('#boundary>#${id}'),{attributes:true,attributeFilter:['class']});
  })()`);await wait(550);
  const changes=await run(`boundaryChanges`);
  console.log('Boundary layout class changes',client,changes);
  if(changes>6)reviewIssues.push(client+': scrollbar visibility oscillates at wrapping boundary');
  await run(`boundaryWatch.disconnect();document.getElementById('boundary').remove()`);await wait(50);

 }
 assert.deepEqual(reviewIssues,[]);
}).then(()=>finish(0),e=>{console.error(e);finish(1)});
function finish(code){clearTimeout(timer);win?.destroy();try{fs.rmSync(profile,{recursive:true,force:true})}catch{}app.exit(code);}
