// Render the actual app with isolated demonstration data. No model calls or user settings.
// PLAYWRIGHT_MODULE=/path/to/playwright node scripts/capture-showcase.cjs
const path = require('node:path'), fs = require('node:fs');
const {once} = require('node:events');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
process.env.ASHUB_TEST_ROOT = path.resolve(__dirname, '..');
const {env, Bridge, root} = require('../tests/harness.cjs');
const e = env({globals:{setTimeout,clearTimeout,setInterval,clearInterval}});
e.clock(Date.now());
e.settings.getSettings=()=>({providers:{demo:{apiKey:'isolated-demo',models:['DeepSeek V3.2']}},defaultProvider:'demo'});
e.auth.listAllProviders=()=>[{id:'demo',name:'Demo',configured:true}];
fs.writeFileSync(path.join(e.dir,'settings.json'),JSON.stringify(e.settings.getSettings()));
const demoRoot='/tmp/ashub-showcase';
fs.mkdirSync(demoRoot); // Refuse to overwrite an existing directory.
process.on('exit',()=>fs.rmSync(demoRoot,{recursive:true,force:true}));
const cwd=path.join(demoRoot,'atlas');
fs.mkdirSync(path.join(cwd,'src','auth'),{recursive:true});
fs.mkdirSync(path.join(cwd,'tests'),{recursive:true});
fs.writeFileSync(path.join(cwd,'src','auth','session.ts'),'export function restoreSession(session) {\n  if (session.expired) return null;\n  return session;\n}\n');
fs.writeFileSync(path.join(cwd,'README.md'),'# Atlas\n\nA small workspace for a focused product.\n');
fs.writeFileSync(path.join(cwd,'package.json'),'{"name":"atlas","scripts":{"test":"vitest run"}}\n');
fs.writeFileSync(path.join(cwd,'tests','session.test.ts'),'// Session restoration and expiry checks\n');
class DemoBridge extends Bridge {
 constructor(o){super(o);this.backendId='ash';this.supportsCwdChange=true;this.cwd=o.cwd;}
 async ready(){this.emit('event',{name:'agent:info',payload:{name:'ash',model:'DeepSeek V3.2',provider:'demo',contextWindow:128000,modalities:['text','image']}});}
 getModes(){return {models:[{model:'DeepSeek V3.2',provider:'demo',modalities:['text','image']}],active:null};}
 getProviderCatalog(){return {providers:[{name:'demo',models:[{id:'DeepSeek V3.2'}]}]};}
 getSubagentTypes(){return [{type:'review',description:'Review code and edge cases',maxIterations:20,budgetTokens:16000}];}
 getSubagentModels(){return {};}
}
(async()=>{
 const app=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new DemoBridge(o)});
 await once(app.server,'listening');
 const url='http://127.0.0.1:'+app.server.address().port;
 const ids=[];
 for(const title of ['梳理 Atlas 项目架构','修复登录与会话恢复','设计产品发布计划','整理 API 接口文档','探索新的交互方案']){
  const data=await (await fetch(url+'/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cwd})})).json();
  ids.push(data.instanceId);
  await fetch(url+'/'+data.instanceId+'/title',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title})});
 }
 const browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1.5});
 await page.addInitScript(()=>{localStorage.setItem('ash-theme','light');localStorage.setItem('ash-lang','zh');});
 await page.goto(url+'/'+ids[0]+'/');
 await page.waitForFunction(async()=>(await import('/js/session-manager.js')).activeSession.peek()?.streamEl);
 await page.waitForTimeout(800);
 await page.evaluate(async(ids)=>{
  const mgr=await import('/js/session-manager.js');
  window.demoSession=mgr.activeSession.peek();
  const store=await import('/js/store.js');store.openTabs.value=ids.slice(0,3);
  const i18n=await import('/js/i18n.js');i18n.setLang('zh');
 },ids);
 await page.waitForFunction(()=>window.demoSession?.streamEl);
 await page.evaluate(async()=>{
  const s=window.demoSession; s.streamEl.replaceChildren(); s.scroll.stickToBottom=false;
  const reply=await import('/js/stream/reply.js'),think=await import('/js/stream/thinking.js'),groups=await import('/js/stream/tool-group.js'),render=await import('/js/stream/renderers.js'),todo=await import('/js/stream/todo-block.js');
  Object.assign(window,{reply,think,groups,render,todo});
  const query=document.createElement('div');query.className='agent-box';const text=document.createElement('div');text.className='agent-query';text.textContent='帮我梳理 Atlas 的项目结构，给出下一步开发建议';query.append(text);s.streamEl.append(query);
  think.appendThinkingChunk(s,'先阅读项目入口、目录结构和测试，再梳理模块边界与数据流。');think.finalizeThinking(s);
  for(const file of ['src/app.ts','src/auth/session.ts','tests/session.test.ts']){const row=render.buildToolRow({name:'read_file',kind:'read',rawInput:{path:file}});row.classList.add('ok');groups.appendToGroup(s,row);groups.bumpToolCount(s);}
  groups.closeToolGroup(s);
  reply.appendReplyChunk(s,'## 从全局，看清下一步\n\nAtlas 的结构清晰，可以沿着 **界面 → 服务 → 数据** 三层继续推进。\n\n| 模块 | 职责 | 关注点 |\n| --- | --- | --- |\n| `src/app.ts` | 应用入口与路由 | 页面切换与状态恢复 |\n| `src/auth/` | 登录与会话 | 过期校验、异常重试 |\n| `tests/` | 行为验证 | 覆盖关键用户路径 |\n\n### 建议的推进顺序\n\n1. **稳定登录体验** — 补齐会话过期与网络恢复的边界处理\n2. **完善核心流程** — 连接工作区、文件与任务的交互\n3. **整理发布检查** — 验证安装、升级和历史会话恢复\n\n可以先从会话恢复开始，改动范围小，也便于独立验证。');reply.closeReply(s);
  s.state.lastUsage={prompt_tokens:12400,total_tokens:13200,prompt_cache_hit_tokens:11408,prompt_cache_miss_tokens:992};s.state.contextWindow=128000;render.renderUsage(s);s.usageStripEl.hidden=false;document.getElementById('query').blur();s.streamEl.scrollTop=0;s.pillEl.hidden=true;
 });
 await page.waitForTimeout(600);
 const out=path.join(root,'website/assets');
 await page.screenshot({path:path.join(out,'showcase-workspace.png')});
 // Same real interface, showing an expanded execution group and its diff.
 await page.evaluate(async id=>{const m=await import('/js/session-manager.js');m.openTab(id);},ids[1]);
 await page.waitForTimeout(600);
 await page.evaluate(async()=>{window.demoSession=(await import('/js/session-manager.js')).activeSession.peek();});
 await page.evaluate(()=>{
  const s=window.demoSession;s.streamEl.replaceChildren();s.reply={text:''};s.thinking={};s.toolGroup={};s._todoBlock=null;
  document.documentElement.dataset.theme='dark';document.getElementById('hljs-dark').disabled=false;document.getElementById('hljs-light').disabled=true;
  const query=document.createElement('div');query.className='agent-box';query.innerHTML='<div class="agent-query">修复过期会话的恢复逻辑，并补齐相关测试</div>';s.streamEl.append(query);
  todo.createTodoBlock(s);todo.updateTodoBlock(s,[{title:'检查会话恢复与异常处理路径',status:'done'},{title:'修复过期状态，保留用户输入',status:'done'},{title:'运行测试并复核边界场景',status:'in_progress'}]);
  const row=render.buildToolRow({kind:'write',name:'edit_file',rawInput:{path:'src/auth/session.ts'}});row.classList.add('ok');groups.appendToGroup(s,row);groups.bumpToolCount(s);
  groups.appendToGroup(s,render.renderDiffBlock({added:4,removed:1,hunks:[{lines:[{type:'context',oldNo:12,newNo:12,text:'export function restoreSession(session) {'},{type:'removed',oldNo:13,text:'  return session.token;'},{type:'added',newNo:13,text:'  if (session.expiresAt <= Date.now()) {'},{type:'added',newNo:14,text:'    return { status: "expired", draft: session.draft };'},{type:'added',newNo:15,text:'  }'},{type:'added',newNo:16,text:'  return { status: "ready", token: session.token };'},{type:'context',oldNo:14,newNo:17,text:'}'}]}]},'src/auth/session.ts'));
  const cmd=render.buildToolRow({kind:'execute',name:'bash',rawInput:{command:'npm run test -- session'}});cmd.classList.add('ok');groups.appendToGroup(s,cmd);groups.bumpToolCount(s);
  groups.appendToGroup(s,render.renderToolBody(['✓ restores a valid session','✓ rejects an expired session','✓ preserves the unsent draft','Tests  3 passed · 1 file']));
  groups.closeToolGroup(s);
  const head=s.streamEl.querySelector('.tool-group-head');if(head.getAttribute('aria-expanded')==='false')head.click();s.streamEl.scrollTop=0;s.pillEl.hidden=true;document.getElementById('query').blur();
 });
 await page.waitForTimeout(500);await page.screenshot({path:path.join(out,'showcase-workflow.png')});
 await page.evaluate(()=>{document.documentElement.dataset.theme='academic';document.getElementById('hljs-dark').disabled=true;document.getElementById('hljs-light').disabled=false;});
 await page.evaluate(()=>{const s=window.demoSession;const h=s.streamEl.querySelector('.tool-group-head');if(h.getAttribute('aria-expanded')==='true')h.click();todo.updateTodoBlock(s,[{title:'检查会话恢复与异常处理路径',status:'done'},{title:'修复过期状态，保留用户输入',status:'done'},{title:'运行测试并复核边界场景',status:'done'}]);reply.appendReplyChunk(s,'\n\n### 改动已经整理完毕\n\n- **修复**：恢复会话前校验过期时间\n- **保留**：登录跳转前保存未发送的草稿\n- **验证**：正常恢复、过期处理与草稿保留\n\n```ts\nif (session.expiresAt <= Date.now()) {\n  return { status: "expired", draft: session.draft };\n}\n```');reply.closeReply(s);s.streamEl.scrollTop=0;s.pillEl.hidden=true;});
 const filesButton=page.locator('#files-toggle');
 if(await filesButton.count()) await filesButton.click();
 await page.waitForTimeout(600);await page.screenshot({path:path.join(out,'showcase-files.png')});
 console.log('Captured three showcase screenshots in '+out);
 }finally{await browser.close();await app.shutdown();}
})().catch(e=>{console.error(e);process.exit(1)});
