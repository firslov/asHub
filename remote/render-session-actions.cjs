const {webkit,chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),path=require('node:path');const {pathToFileURL}=require('node:url');
(async()=>{
 const browser=await(process.env.NAV_ENGINE==='chromium'?chromium:webkit).launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   Object.defineProperty(navigator,'standalone',{value:true});globalThis.fixtureOps=[];globalThis.fixtureEnabled=null;globalThis.failNetwork=false;globalThis.loseDeleteReply=true;globalThis.fixtureReceipts=new Map();
   globalThis.EventSource=class{addEventListener(){}close(){}};
   globalThis.fetch=async(url,init)=>{
    if(!init?.body)return {ok:false,status:401,json:async()=>({error:'fixture'})};
    const {op,args}=JSON.parse(init.body);fixtureOps.push({op,args});let data={};
    if(op==='set-session-network'){if(failNetwork)throw Error('模拟保存失败');fixtureEnabled=args.enabled;}
    if(op==='session-network'||op==='set-session-network')data={session:args.session,enabled:fixtureEnabled,effective:fixtureEnabled??true,globalEnabled:true};
    if(op==='session-delete'){if(!fixtureReceipts.has(args.requestId))fixtureReceipts.set(args.requestId,{state:'done',result:{ok:true}});if(loseDeleteReply){loseDeleteReply=false;throw Error('模拟响应丢失')}data=fixtureReceipts.get(args.requestId);}
    if(op==='request-status')data=fixtureReceipts.get(args.requestId)||{state:'missing'};
    if(op==='sessions'||op==='project-groups')data=[];
    return {ok:true,json:async()=>data};
   };
  });
  await page.goto(pathToFileURL(path.join(__dirname,'public/index.html')).href);
  await page.evaluate(()=>{$('auth').hidden=true;$('workspace').hidden=false;user='fixture';device='desktop';session='abcdef';devices=[{id:device,online:true}];sessions=[{instanceId:session,title:'研究项目 · 一个较长的对话名称'}];capabilities={sessionNetwork:true,sessionDelete:true};renderSessions();controls();menu(false)});
  for(const width of [320,390])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:844});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
   await page.locator('#session-actions').tap();await page.waitForFunction(()=>document.querySelector('.session-network-choice[aria-pressed=true]'));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&$('modal').scrollWidth<=$('modal').clientWidth),'narrow dialog must not overflow');
   await page.waitForTimeout(200);await page.screenshot({path:`/tmp/ashub-session-settings-${theme}-${width}.png`});
   await page.locator('#modal-close').tap();
  }
  await page.locator('#session-actions').tap();await page.getByRole('button',{name:'关闭',exact:true}).last().tap();
  await page.waitForFunction(()=>fixtureEnabled===false);assert.equal(await page.getByRole('button',{name:'关闭',exact:true}).last().getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>failNetwork=true);await page.getByRole('button',{name:'开启',exact:true}).tap();await page.waitForSelector('.picker-error:has-text("模拟保存失败")');
  assert.equal(await page.getByRole('button',{name:'关闭',exact:true}).last().getAttribute('aria-pressed'),'true','failed save retains confirmed state');
  await page.evaluate(()=>failNetwork=false);await page.getByRole('button',{name:'跟随全局',exact:true}).tap();await page.waitForFunction(()=>fixtureEnabled===null);
  await page.getByRole('button',{name:'删除对话',exact:true}).tap();assert.equal(await page.evaluate(()=>fixtureOps.filter(o=>o.op==='session-delete').length),0);
  await page.getByRole('button',{name:'取消',exact:true}).tap();assert.equal(await page.evaluate(()=>session),'abcdef');
  await page.locator('#session-actions').tap();await page.getByRole('button',{name:'删除对话',exact:true}).tap();await page.getByRole('button',{name:'确认删除',exact:true}).tap();await page.waitForSelector('.picker-error:has-text("模拟响应丢失")');
  await page.getByRole('button',{name:'重试确认',exact:true}).tap();await page.waitForFunction(()=>session==='');
  const requests=await page.evaluate(()=>fixtureOps.filter(o=>o.op==='session-delete'));
  assert.equal(requests.length,2);assert.equal(requests[0].args.requestId,requests[1].args.requestId);assert.equal(await page.evaluate(()=>fixtureReceipts.size),1);
  assert(await page.locator('#session-actions').isHidden());
  await page.evaluate(()=>{session='abcdef';capabilities={};controls()});assert(await page.locator('#session-actions').isHidden(),'old desktop does not expose unsupported controls');
  assert.deepEqual(errors,[]);console.log('PASS session actions: 320/390px light/dark, VPN/inheritance/failure, delete confirmation/cancel/retry, no duplicate effect and legacy gating');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
