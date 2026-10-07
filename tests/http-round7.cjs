process.env.ASHUB_TEST_ROOT ||= require('path').resolve(__dirname,'..');
const {env,Bridge,assert,path,root,fs}=require('./harness.cjs');const {once}=require('events');
const watchdog=setTimeout(()=>{console.error('HTTP audit timed out');process.exit(1)},15000);
(async()=>{
 let release,started,enabled=false,b;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r),real=require('fs');
 const e=env({globals:{setTimeout,clearTimeout,setInterval,clearInterval},modules:{'node:fs':{...real,promises:{...real.promises,writeFile:async(file,...a)=>{if(enabled&&String(file).endsWith('.meta.json.tmp')){started();await gate}return real.promises.writeFile(file,...a)}}}}});
 const app=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>(b=new Bridge(o))});await once(app.server,'listening');const url=`http://127.0.0.1:${app.server.address().port}`;
 enabled=true;const pending=fetch(url+'/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cwd:e.dir})});await ready;b.emit('closed');release();const r=await pending,body=await r.text();const listing=await fetch(url+'/sessions').then(r=>r.json());assert(r.status===500&&body.includes('backend closed during initialization')&&listing.length===0,'closed backend returned a usable session');console.log('PASS real HTTP rejects backend exit during creation and leaves no active session');await app.shutdown();app.server.closeAllConnections?.();clearTimeout(watchdog);
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
