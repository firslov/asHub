// Actual mobile page, synthetic diagnostics only; no account or model access.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-remote-detail-'));
app.setPath('userData',profile);let win;
const timeout=setTimeout(()=>finish(2),30000);
app.whenReady().then(async()=>{
 win=new BrowserWindow({width:390,height:844,show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
 await win.loadFile(path.join(__dirname,'public/index.html'));
 const run=code=>win.webContents.executeJavaScript(code);
 for(const width of [320,390,1040])for(const theme of ['light','dark']){
  win.setContentSize(width,844);
  await run(`(()=>{
   document.documentElement.dataset.theme='${theme}';$('auth').hidden=true;$('workspace').hidden=false;
   user='demo';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];streamReady=true;
   resetMessages();controls();menu(false);$('notice').hidden=true;$('chat-title').textContent='调度中枢';$('connection').textContent='已同步 · 在电脑上执行';
   let tick=0;const send=(name,payload={})=>frame({meta:{name,ts:Date.UTC(2026,10,1,3,27,++tick)},payload});
   send('agent:processing-start');
   send('agent:tool-batch',{groups:[{kind:'read',tools:[{name:'ls'},{name:'read_file'}]}]});
   send('agent:thinking-chunk',{text:'**核对执行状态** 确认项目成员的最新进展'});
   send('agent:tool-started',{toolCallId:'list',name:'ls',rawInput:{path:'/工作区/论文审阅'},displayDetail:'论文审阅'});
   send('agent:tool-output-chunk',{toolCallId:'list',chunk:'progress.md\\nreview.md'});
   send('agent:tool-completed',{toolCallId:'list',exitCode:0,rawOutput:'progress.md\\nreview.md'});
   send('agent:tool-started',{toolCallId:'read',name:'read_file',rawInput:{path:'/工作区/论文审阅/progress.md'},displayDetail:'progress.md'});
   send('agent:tool-output-chunk',{toolCallId:'read',chunk:'三个成员已完成本轮核对\\n'});
   send('agent:tool-output-chunk',{toolCallId:'read',chunk:'证据与审阅意见均已归档'});
   send('agent:tool-completed',{toolCallId:'read',exitCode:0,rawOutput:'三个成员已完成本轮核对\\n证据与审阅意见均已归档',extra:'<img src=x onerror=alert(1)>'});
   send('agent:thinking-chunk',{text:'**检查协作结果** 汇总待确认的事项'});
   send('agent:tool-started',{toolCallId:'wait',name:'conversation_wait',rawInput:{targets:['方法核对','材料审阅']}});
   send('agent:tool-completed',{toolCallId:'wait',exitCode:0,rawOutput:'所有成员已返回结果'});
   send('agent:tool-batch-complete',{results:[{name:'ls',isError:false},{name:'read_file',isError:false},{name:'conversation_wait',isError:false}]});
   send('agent:processing-done');
   const phase=[...phases][0];phase.box.open=true;phase.box.ontoggle();
   $('usage').textContent='55.9k tokens · 缓存 99.2% · 上下文 21%';
   followingBottom=false;$('messages').scrollTop=0;
  })()`);
  await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const initial=await run(`(()=>{
   const phase=[...phases][0],rows=[...phase.body.children];
   return {tools:rows.filter(n=>n.classList.contains('tool-step')).length,rows:rows.length,
    nativeMarkers:rows.some(n=>getComputedStyle(n.querySelector('summary')).listStyleType!=='none'),
    touch:rows.every(n=>n.querySelector('summary').getBoundingClientRect().height>=44),
    overflow:document.documentElement.scrollWidth>innerWidth};
  })()`);
  assert.deepEqual(initial,{tools:3,rows:6,nativeMarkers:false,touch:true,overflow:false});
  const statusContrast=await run(`(()=>{
   const status=document.querySelector('.step-status'),css=getComputedStyle(status);
   const rgb=color=>color.match(/[0-9.]+/g).slice(0,3).map(Number);
   const background=rgb(getComputedStyle(document.body).backgroundColor),alpha=Number(css.opacity);
   const foreground=rgb(css.color).map((v,i)=>v*alpha+background[i]*(1-alpha));
   const luminance=colors=>colors.reduce((sum,v,i)=>{v/=255;return sum+(v<=.04045?v/12.92:((v+.055)/1.055)**2.4)*[.2126,.7152,.0722][i]},0);
   const a=luminance(foreground),b=luminance(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  })()`);
  assert(statusContrast>=4.5,`${theme}/${width}: status text contrast ${statusContrast.toFixed(2)} < 4.5`);
  const directory=process.env.ASHUB_REMOTE_DETAIL_SCREENSHOTS;
  if(directory&&width===390){fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,`${theme}.png`),(await win.webContents.capturePage()).toPNG());}
  const opened=await run(`(()=>{
   const call=[...phases][0].callRows.get('tool:read');call.row.querySelector('summary').click();call.row.ontoggle();
   call.source.querySelector('summary').click();call.source.ontoggle();
   return {input:call.inputText.textContent,output:call.output.textContent,duplicate:!call.resultSection.hidden,
    raw:call.sourceText.textContent,unsafe:!!call.body.querySelector('img,script'),overflow:document.documentElement.scrollWidth>innerWidth};
  })()`);
  assert(opened.input.includes('progress.md'));assert(opened.output.includes('证据与审阅意见均已归档'));
  assert(!opened.duplicate && !opened.unsafe && !opened.overflow);assert(opened.raw.includes('<img src=x onerror=alert(1)>'));
  await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  if(directory&&width===390)fs.writeFileSync(path.join(directory,`${theme}-expanded.png`),(await win.webContents.capturePage()).toPNG());
  console.log(`PASS ${theme}/${width}: grouped calls, touch targets, literal payloads, full output, no overflow`);
 }
}).then(()=>finish(0),e=>{console.error(e);finish(1)});
function finish(code){clearTimeout(timeout);if(win&&!win.isDestroyed())win.destroy();fs.rmSync(profile,{recursive:true,force:true});app.exit(code);}
