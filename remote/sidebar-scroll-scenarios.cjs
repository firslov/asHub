const assert=require('node:assert/strict');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
module.exports=async function checkSidebar(run,resize){
 for(const [width,height] of [[390,844],[320,568],[568,320],[1024,768],[1200,800]]) {
  await resize(width,height);await wait(80);
  for(const home of [true,false]) {
   await run(`(()=>{
    $('auth').hidden=true;$('workspace').hidden=false;user='fixture';device='desktop';session=${home?"''":"'s0'"};deviceListReady=true;sessionListDevice=device;devices=[{id:device,online:true}];groups=[];viewFilter='all';
    sessions=Array.from({length:80},(_,i)=>({instanceId:'s'+i,title:'Conversation '+i,lastModified:1}));renderSessions();menu(!${home}&&innerWidth<=760);
    $('sidebar').scrollTop=0;$('sessions').scrollTop=0;
   })()`);await wait(220);
   const result=await run(`(()=>{
    const side=$('sidebar'),list=$('sessions'),touch=matchMedia('(max-width:760px), (pointer:coarse)').matches;
    const scroller=touch?side:list;scroller.scrollTop=800;const before=scroller.scrollTop;
    renderSessions();const after=scroller.scrollTop;
    scroller.scrollTop=scroller.scrollHeight;
    const last=list.lastElementChild.getBoundingClientRect(),bounds=side.getBoundingClientRect();
    const footer=$('account').getBoundingClientRect();
    const end=last.bottom<=bounds.bottom+1&&last.bottom>bounds.top;
    scroller.scrollTop=0;
    return {touch,before,after,end,footer:footer.bottom<=bounds.bottom+1,
     range:scroller.scrollHeight-scroller.clientHeight,top:scroller.scrollTop,
     nested:touch&&list.scrollHeight>list.clientHeight+1,
     overflow:document.documentElement.scrollWidth>innerWidth};
   })()`);
   assert(result.before>=799&&Math.abs(result.after-result.before)<=1,JSON.stringify({width,height,home,result}));
   assert(result.end&&!result.nested&&!result.overflow,JSON.stringify(result));
   assert.equal(result.top,0);if(result.touch)assert(result.footer,'account must be reachable at sidebar end');
  }
 }
 await resize(390,844);await wait(80);
 for(const home of [true,false]) {
  const result=await run(`(()=>{
   session=${home?"''":"'s0'"};sessionSearchExpanded=true;renderSessions();menu(!${home});
   document.documentElement.style.setProperty('--viewport-height','360px');
   const side=$('sidebar');side.scrollTop=side.scrollHeight;
   const bottom=$('account').getBoundingClientRect().bottom;
   return {height:side.clientHeight,bottom,range:side.scrollHeight-side.clientHeight};
  })()`);
  assert(result.height<=360&&result.bottom<=361&&result.range>0,JSON.stringify(result));
 }
 await run(`document.documentElement.style.removeProperty('--viewport-height');sessionSearchExpanded=false;$('sidebar').scrollTop=0;menu(false)`);
 console.log('PASS long sidebar: 80 conversations, home/drawer, narrow/wide touch, refresh, keyboard and footer reachability');
};
