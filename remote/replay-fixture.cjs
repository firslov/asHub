// Generate the actual persisted Hub sequence when another client joins mid-reply.
const { env, Bridge, assert, path, root, fs } = require('../tests/harness.cjs');
const { once } = require('node:events');
(async () => {
  let proceed, started;
  const began = new Promise(r => { started = r; }), gate = new Promise(r => { proceed = r; });
  const e = env();
  class TestBridge extends Bridge {
    async submit() {
      this.emit('event', {name:'agent:response-chunk',payload:{blocks:[{type:'text',text:'First part. '}]}});
      started(); await gate;
      this.emit('event', {name:'agent:response-chunk',payload:{blocks:[{type:'text',text:'Final part.'}]}});
      this.emit('event', {name:'agent:response-done',payload:{response:'First part. Final part.'}});
      return {stopReason:'done'};
    }
  }
  const hub = e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new TestBridge(o)});
  await once(hub.server,'listening'); const base = `http://127.0.0.1:${hub.server.address().port}`;
  let reader;
  async function readTo(marker) {
    let text='';
    while (!text.includes(marker)) { const next=await reader.read(); if(next.done) break; text+=Buffer.from(next.value).toString(); }
    assert(text.includes(marker), 'missing '+marker); return text;
  }
  try {
    const sid = (await (await fetch(base+'/sessions',{method:'POST',body:JSON.stringify({cwd:e.dir})})).json()).instanceId;
    await fetch(base+`/${sid}/submit`,{method:'POST',body:JSON.stringify({query:'question'})}); await began;
    reader=(await fetch(base+`/events?subs=${sid}:all`,{signal:AbortSignal.timeout(10000)})).body.getReader();
    await readTo('hub:replay-done'); proceed(); await readTo('agent:processing-done'); await reader.cancel();
    reader=(await fetch(base+`/events?subs=${sid}:all`,{signal:AbortSignal.timeout(10000)})).body.getReader();
    const text=await readTo('hub:replay-done');
    const frames=text.split('\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)));
    const parts=frames.filter(d=>['agent:response-segment','agent:response-done'].includes(d.meta.name));
    assert(parts.length===3 && parts[0].payload.text==='First part. ' && parts[2].payload.text==='Final part.','unexpected Hub replay order');
    console.log('REPLAY '+JSON.stringify(frames));
  } finally { proceed(); await reader?.cancel(); await hub.shutdown(); fs.rmSync(e.dir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
