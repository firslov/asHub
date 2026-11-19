// Optional cross-engine check: NODE_PATH=<Playwright installation> node remote/render-scroll-webkit.cjs
const {webkit}=require('playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
const check=require('./scroll-intent-scenarios.cjs');
(async()=>{
 const browser=await webkit.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.addInitScript(()=>{window.fetch=async()=>({ok:false,status:401,json:async()=>({error:'Synthetic test'})});});
  page.on('pageerror',e=>console.error('PAGE ERROR',e.message));
  await page.goto(pathToFileURL(path.join(__dirname,'public/index.html')).href);
  await check(code=>page.evaluate(code),(width,height)=>page.setViewportSize({width,height}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
