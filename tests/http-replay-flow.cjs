const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { env, Bridge } = require('./harness.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, onResponse = () => {}) {
  const e = env();
  const h = e.load('src/hub.ts', 'export const replayAudit = {createSession,openSseMulti,routeEvent,sseFrame,rebuildReplay,shutdownHub};').replayAudit;
  const sessions = new Map(), s = await h.createSession(sessions, {makeBridge:o=>new Bridge(o)}, e.dir);
  const responses = new Map(), clients = [];
  s.replay = Array.from({length:1200}, (_, index) => h.sseFrame({source:s.id,name:'agent:tool-completed',ts:1},
    {toolCallId:'history-'+index,success:true,marker:index,text:'history '+index+' '+'x'.repeat(300)}));
  const server = http.createServer((req,res) => {
    responses.set(req.url,res);onResponse(req,res);
    void h.openSseMulti(req,res,sessions,s.id+':all','').catch(error=>res.destroy(error));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const client of clients)client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await h.shutdownHub(undefined,sessions);});
  const connect = name => new Promise((resolve,reject) => {
    const request = http.get(`http://127.0.0.1:${server.address().port}/${name}`, response => {
      const events=[];let tail='',failure;const waits=new Set();
      const notify=()=>{for(const check of [...waits])check();};
      response.setEncoding('utf8');
      response.on('data', chunk=>{tail+=chunk;let end;while((end=tail.indexOf('\n\n'))>=0){const raw=tail.slice(0,end);tail=tail.slice(end+2);const data=raw.split('\n').find(line=>line.startsWith('data: '));if(data)events.push(JSON.parse(data.slice(6)));}notify();});
      response.on('error',error=>{failure=error;notify();});
      const client={events,close(){request.destroy();response.destroy();},until(predicate){
        if(predicate(events))return Promise.resolve();
        return new Promise((done,fail)=>{const timeout=setTimeout(()=>finish(Error('SSE predicate timed out')),5000);
          const finish=error=>{clearTimeout(timeout);waits.delete(check);error?fail(error):done();};
          const check=()=>{if(failure)finish(failure);else if(predicate(events))finish();};waits.add(check);check();});
      }};
      clients.push(client);resolve(client);
    });request.on('error',reject);
  });
  const attached = async name => {for(let n=0;n<100;n++){if(s.sseClients.has(responses.get('/'+name)))return;await tick();}throw Error('SSE subscription did not attach');};
  return {h,s,sessions,responses,connect,attached};
}

test('real HTTP replay retains each historical frame and admits concurrent live events once', async t => {
  const f=await fixture(t),client=await f.connect('stream');await f.attached('stream');
  f.h.routeEvent(f.s,{name:'agent:tool-completed',payload:{toolCallId:'live-call',success:true,marker:'LIVE'}});
  await client.until(events=>events.some(event=>event.payload?.marker==='LIVE'));
  const history=client.events.filter(event=>typeof event.payload?.marker==='number').map(event=>event.payload.marker);
  assert.deepEqual(history,Array.from({length:1200},(_,i)=>i));
  assert.equal(client.events.filter(event=>event.payload?.marker==='LIVE').length,1);
  assert(client.events.findIndex(event=>event.meta.name==='hub:replay-done')<client.events.findIndex(event=>event.payload?.marker==='LIVE'));
});

test('branch replacement during queued history follows its original snapshot without mixing branches', async t => {
  let release;
  const f=await fixture(t,(req,res)=>{
    const write=res.write.bind(res);let blocked=true;
    res.write=(...args)=>{const ok=write(...args);return blocked?false:ok;};
    release=()=>{blocked=false;res.emit('drain');};
  });
  const client=await f.connect('branch');await f.attached('branch');
  await f.h.rebuildReplay(f.s,[{role:'user',content:'new branch query'},{role:'assistant',content:'new branch answer'}]);
  release();
  await client.until(events=>events.filter(event=>event.meta.name==='hub:replay-done').length===2);
  const branch=client.events.findIndex(event=>event.meta.name==='hub:branch-switched');
  assert(branch>0);assert.equal(client.events.filter(event=>typeof event.payload?.marker==='number').length,1200);
  assert(client.events.slice(branch).every(event=>typeof event.payload?.marker!=='number'));
  assert(client.events.slice(branch).some(event=>event.payload?.query==='new branch query'));
  assert(client.events.slice(branch).some(event=>event.payload?.text==='new branch answer'));
});

test('a stalled HTTP consumer does not block a healthy client or lose its own queued live tail', async t => {
  let release;
  const f=await fixture(t,(req,res)=>{
    if(req.url!=='/slow')return;
    const write=res.write.bind(res);let blocked=true;
    res.write=(...args)=>{const ok=write(...args);return blocked?false:ok;};
    release=()=>{blocked=false;res.emit('drain');};
  });
  const slow=await f.connect('slow');await f.attached('slow');
  const fast=await f.connect('fast');await fast.until(events=>events.some(event=>event.meta.name==='hub:replay-done'));
  assert.equal(slow.events.length,0);
  f.h.routeEvent(f.s,{name:'agent:tool-completed',payload:{toolCallId:'shared-live',success:true,marker:'SHARED'}});
  await fast.until(events=>events.some(event=>event.payload?.marker==='SHARED'));
  assert.equal(slow.events.length,0);
  release();await slow.until(events=>events.some(event=>event.payload?.marker==='SHARED'));
  for(const client of [fast,slow]) {
    assert.equal(client.events.filter(event=>typeof event.payload?.marker==='number').length,1200);
    assert.equal(client.events.filter(event=>event.payload?.marker==='SHARED').length,1);
  }
});
