const {env,Bridge,Res,req,assert,path,root}=require('./harness.cjs');
const {once}=require('node:events');
const watchdog=setTimeout(()=>{console.error('HTTP lazy shutdown timeout');process.exit(1)},10000);
(async()=>{
 const e=env(),h=e.hub(),sessions=new Map();
 const seed=await h.createSession(sessions,{makeBridge:o=>new Bridge(o)},e.dir);
 await h.submit(req({query:'saved conversation'}),new Res(),seed);
 await new Promise(r=>setImmediate(r));await seed.contextLock;await h.shutdownHub(undefined,sessions);
 Object.assign(e.context,{setTimeout,clearTimeout,setInterval,clearInterval});
 let release,started,closed=0;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const app=h.startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{
   const b=new Bridge(o);b.ready=async()=>{started();await gate};b.snapshot=async()=>{await gate;return{messages:b.messages,activeTokens:0,contextWindow:0}};b.close=()=>closed++;return b;
 }});
 await once(app.server,'listening');
 const url=`http://127.0.0.1:${app.server.address().port}`;
 const request=fetch(url+`/${seed.id}/context`).then(async r=>({status:r.status,data:await r.json()}));
 await ready;await app.shutdown();
 const result=await request;assert(closed===1,'lazy backend was not closed before ready');
 assert(result.status===200&&result.data.readOnly&&result.data.messages.some(m=>m.content==='saved conversation'),'saved history unavailable during cancellation');
 release();await new Promise(r=>setImmediate(r));assert(closed===1,'late ready revived or reclosed backend');
 console.log('PASS real HTTP lazy initialization cancellation, shutdown and saved-history fallback');
 app.server.closeAllConnections?.();clearTimeout(watchdog);
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
