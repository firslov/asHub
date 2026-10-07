process.env.ASHUB_TEST_ROOT ||= require('path').resolve(__dirname,'..');
const {env,Bridge,assert,path,root}=require('./harness.cjs');const {once}=require('events');
const watchdog=setTimeout(()=>{console.error('HTTP round8 timed out');process.exit(1)},15000);
(async()=>{
 const real=require('fs');let failTitle=false,app;
 const e=env({globals:{setTimeout,clearTimeout,setInterval,clearInterval},modules:{'node:fs':{...real,promises:{...real.promises,writeFile:async(file,...args)=>{if(failTitle&&String(file).endsWith('.meta.json.tmp'))throw Error('ENOSPC title');return real.promises.writeFile(file,...args)}}}}});
 app=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new Bridge(o)});await once(app.server,'listening');const url=`http://127.0.0.1:${app.server.address().port}`;
 const post=(route,body)=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try {
  const created=await post('/sessions',{cwd:e.dir});assert(created.ok,'create failed');const {instanceId:id}=await created.json();assert((await post(`/${id}/title`,{title:'original'})).ok,'initial title failed');
  failTitle=true;const failed=await post(`/${id}/title`,{title:'unsaved'});assert(failed.status===500,'failed save was acknowledged');const list=await fetch(url+'/sessions').then(r=>r.json());assert(list.find(s=>s.instanceId===id).title==='original','uncommitted title visible');failTitle=false;assert((await post(`/${id}/title`,{title:'retry'})).ok,'rename retry failed');
  for(let i=0;i<2;i++){assert((await post(`/${id}/submit`,{query:'same'})).ok,'submit failed');await new Promise(r=>setImmediate(r));await fetch(url+`/${id}/context`).then(r=>r.json())}
  const abort=new AbortController();const response=await fetch(url+`/events?subs=${id}:all`,{signal:abort.signal});const reader=response.body.getReader();let raw='';try{while(!raw.includes('hub:replay-done')){const {value,done}=await reader.read();assert(!done,'SSE ended');raw+=Buffer.from(value).toString('utf8')}}finally{abort.abort();await reader.cancel().catch(()=>{})}
  const events=raw.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));const queries=events.filter(f=>f.meta.name==='agent:query').map(f=>f.payload),tags=events.filter(f=>f.meta.name==='agent:query-tagged').map(f=>f.payload);
  assert(queries.length===2&&queries[0].queryId!==queries[1].queryId&&queries.every(q=>tags.some(t=>t.queryId===q.queryId&&t.entryId===q.entryId)),'SSE query correlation missing');
  console.log('PASS real HTTP title rollback/retry and SSE duplicate-query identity');
 } finally {failTitle=false;await app.shutdown();app.server.closeAllConnections?.();clearTimeout(watchdog)}
})().then(()=>process.exit(0),err=>{console.error(err);process.exit(1)});
