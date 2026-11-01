// Capture the current client using the isolated showcase server (no real accounts).
const {spawn}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{for(const lang of ['en','zh']){
  const server=spawn(process.execPath,['scripts/showcase-server.cjs'],{env:{...process.env,SHOWCASE_LANG:lang},stdio:['ignore','pipe','inherit']});
  try{
   const info=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(Error('Showcase startup timeout')),15000);server.on('exit',code=>{clearTimeout(timer);reject(Error('Showcase exited '+code));});server.stdout.on('data',chunk=>{output+=chunk;const line=output.split('\n').find(x=>x.startsWith('{'));if(line){clearTimeout(timer);resolve(JSON.parse(line));}});});
   const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
   await page.addInitScript(lang=>{localStorage.setItem('ash.lang',lang);localStorage.setItem('ash-theme','light');localStorage.setItem('ash.sidebar-view','projects');},lang);
   await page.goto(info.url);
   await page.waitForFunction(()=>document.querySelector('.agent-reply')?.textContent.includes('Atlas'));
   await page.evaluate(async ids=>{const mgr=await import('/js/session-manager.js');for(const id of ids.slice(0,3))mgr.openTab(id);mgr.openTab(ids[0]);await document.fonts.ready;},info.ids);
   await page.waitForTimeout(600);
   await page.locator('.agent-reply:visible').first().waitFor({state:'visible'});
   await page.evaluate(()=>{document.querySelector('.stream')?.scrollTo(0,0);document.activeElement?.blur();});
   await page.evaluate(async()=>{await Promise.all(document.querySelector('.live-wrap').getAnimations().map(a=>a.finished));});
   const out=path.resolve('website/assets');
   await page.screenshot({path:path.join(out,`showcase-workspace-0211-${lang}.jpg`),quality:90});
   if(lang==='zh'){
    await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
    await page.screenshot({path:path.join(out,'showcase-dark-0211.jpg'),quality:90});
    await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
    await page.locator('#files-toggle').click();await page.waitForTimeout(400);
    await page.screenshot({path:path.join(out,'showcase-files-0211.jpg'),quality:90});
   }
   await page.close();
  }finally{server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}
 }}finally{await browser.close();}
 console.log('Captured v0.21.1 showcase assets');
})().catch(error=>{console.error(error);process.exitCode=1;});
