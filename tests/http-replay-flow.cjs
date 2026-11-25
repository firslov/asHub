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
    void h.openSseMulti(req,res,sessions,s.id+':all','',req.url.startsWith('/mobile')).catch(error=>res.destroy(error));
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

test('desktop and mobile live streams and reconnect replay keep child cancellations distinct', async t => {
  const f=await fixture(t);
  const desktop=await f.connect('desktop'),mobile=await f.connect('mobile');
  await Promise.all([f.attached('desktop'),f.attached('mobile')]);
  const route=(name,payload)=>f.h.routeEvent(f.s,{name,payload});
  const task='Long task '.repeat(200);
  for(const subagentId of ['finished','limited','stopped']) route('subagent:started',{subagentId,task});
  route('subagent:done',{subagentId:'finished',task,degraded:null});
  route('subagent:done',{subagentId:'limited',task,degraded:'budget'});
  route('agent:cancelled',{});
  route('subagent:done',{subagentId:'stopped',task,cancelled:true,degraded:null});
  const childResults=events=>events.filter(event=>event.meta.name==='subagent:done').map(event=>event.payload);
  const check=async(client,preview)=>{
    await client.until(events=>childResults(events).length===3);
    const children=childResults(client.events);
    assert.deepEqual(children.map(({subagentId,cancelled,degraded})=>({subagentId,cancelled,degraded})),[
      {subagentId:'finished',cancelled:undefined,degraded:null},
      {subagentId:'limited',cancelled:undefined,degraded:'budget'},
      {subagentId:'stopped',cancelled:true,degraded:null},
    ]);
    assert(children.every(result=>result.detailsOmitted===preview));
    assert(children.every(result=>preview?result.task.length<task.length:result.task===task));
  };
  await Promise.all([check(desktop,undefined),check(mobile,undefined)]);
  desktop.close();mobile.close();
  const desktopReplay=await f.connect('desktop-reconnect'),mobileReplay=await f.connect('mobile-reconnect');
  await Promise.all([check(desktopReplay,undefined),check(mobileReplay,true)]);
});

test('branch replay retains child outcomes for the same history entry and tool call', async t => {
  const f=await fixture(t);
  const route=(name,payload)=>f.h.routeEvent(f.s,{name,payload});
  const outcomes=[{degraded:null},{degraded:'budget'},{cancelled:true,degraded:null},{cancelled:true,degraded:null}];
  const calls=outcomes.map((_,index)=>({id:`call-${index}`,function:{name:'review',arguments:'{"task":"review"}'}}));
  route('agent:query',{query:'review this branch',entryId:'user-entry'});
  for(const [index,outcome] of outcomes.entries()) {
    const toolCallId=calls[index].id,subagentId=`child-${index}`;
    route('agent:tool-started',{toolCallId,name:'review'});
    if(index===3) {
      route('agent:query',{query:'another turn while cancellation settles',entryId:'later-entry'});
      route('subagent:done',{toolCallId,...outcome});
    } else {
      route('subagent:started',{toolCallId,subagentId});
      route('subagent:done',{toolCallId,subagentId,...outcome});
    }
  }
  const messages=[{role:'user',content:'review this branch'},{role:'assistant',content:null,tool_calls:calls},
    ...calls.map(({id},index)=>({role:'tool',tool_call_id:id,content:index===0?'Error: a quoted log line':"Subagent 'review' launched. Results will appear in the next turn."}))];
  const readOutcomes=()=>Array.from(f.s.replay,line=>JSON.parse(line.split('\n').find(part=>part.startsWith('data: ')).slice(6)))
    .filter(event=>event.meta.name==='agent:tool-completed').map(({payload})=>({cancelled:payload.cancelled,degraded:payload.degraded,exitCode:payload.exitCode}));
  const expected=[{cancelled:undefined,degraded:null,exitCode:0},{cancelled:undefined,degraded:'budget',exitCode:0},
    {cancelled:true,degraded:null,exitCode:1},{cancelled:true,degraded:null,exitCode:1}];
  const ids=['user-entry','assistant-entry','tool-0','tool-1','tool-2','tool-3'];
  await f.h.rebuildReplay(f.s,messages,ids);
  assert.deepEqual(readOutcomes(),expected);
  await f.h.rebuildReplay(f.s,messages,ids);
  assert.deepEqual(readOutcomes(),expected);
  await f.h.rebuildReplay(f.s,messages,['other-user-entry',...ids.slice(1)]);
  assert.deepEqual(readOutcomes(),calls.map((_,index)=>({cancelled:undefined,degraded:undefined,exitCode:index===0?1:0})));
});

test('branch rebuild keeps late cancelled and partial children apart when model call IDs repeat across turns', async t => {
  const f=await fixture(t);
  const route=(name,payload)=>f.h.routeEvent(f.s,{name,payload});
  const toolCallId='reused-call';
  const launch=(entryId,subagentId)=>{
    route('agent:query',{query:entryId,entryId});
    route('agent:tool-started',{toolCallId,name:'review'});
    route('subagent:started',{toolCallId,subagentId});
    route('agent:tool-completed',{toolCallId,exitCode:0});
  };
  launch('first-entry','first-child');
  launch('second-entry','second-child');
  route('subagent:done',{toolCallId,subagentId:'second-child',degraded:'budget'});
  route('subagent:done',{toolCallId,subagentId:'first-child',cancelled:true,degraded:null});
  const entries=['first-entry','second-entry'];
  const messages=entries.flatMap(content=>[
    {role:'user',content},
    {role:'assistant',content:null,tool_calls:[{id:toolCallId,function:{name:'review',arguments:'{"task":"review"}'}}]},
    {role:'tool',tool_call_id:toolCallId,content:'Background child launched'},
  ]);
  const ids=entries.flatMap(entryId=>[entryId,entryId+'-assistant',entryId+'-tool']);
  const outcomes=()=>Array.from(f.s.replay,line=>JSON.parse(line.split('\n').find(part=>part.startsWith('data: ')).slice(6)))
    .filter(event=>event.meta.name==='agent:tool-completed').map(({payload})=>({cancelled:payload.cancelled,degraded:payload.degraded,exitCode:payload.exitCode}));
  const expected=[{cancelled:true,degraded:null,exitCode:1},{cancelled:undefined,degraded:'budget',exitCode:0}];
  await f.h.rebuildReplay(f.s,messages,ids);
  assert.deepEqual(outcomes(),expected);
  await f.h.rebuildReplay(f.s,messages,ids);
  assert.deepEqual(outcomes(),expected);
});

test('a branch rebuild retains an active child only with its retained launch and task', async t => {
  const f=await fixture(t);
  const route=(name,payload)=>f.h.routeEvent(f.s,{name,payload});
  const query='Run the review',task='Review these files',toolCallId='background-call',subagentId='running-child';
  route('agent:query',{query,entryId:'kept-entry'});
  route('agent:tool-started',{toolCallId,name:'research',rawInput:{task}});
  route('subagent:started',{toolCallId,subagentId,task,type:'research'});
  route('agent:tool-completed',{toolCallId,exitCode:0});
  route('agent:tool-started',{toolCallId:'edited-call',name:'research',rawInput:{task:'Discarded task'}});
  route('subagent:started',{toolCallId:'edited-call',subagentId:'discarded-child',task:'Discarded task',type:'research'});
  route('agent:tool-completed',{toolCallId:'edited-call',exitCode:0});
  const messages=[{role:'user',content:query},
    {role:'assistant',content:null,tool_calls:[
      {id:toolCallId,function:{name:'research',arguments:JSON.stringify({task})}},
      {id:'edited-call',function:{name:'research',arguments:JSON.stringify({task:'Edited task'})}},
    ]},
    {role:'tool',tool_call_id:toolCallId,content:'Background review launched'},
    {role:'tool',tool_call_id:'edited-call',content:'Other review launched'}];
  const ids=['kept-entry','assistant-entry','tool-entry','edited-entry'];
  const decode=()=>Array.from(f.s.replay,line=>JSON.parse(line.split('\n').find(part=>part.startsWith('data: ')).slice(6)));

  await f.h.rebuildReplay(f.s,messages,ids);
  const child=decode().filter(event=>event.meta.name==='subagent:started');
  assert.deepEqual(child.map(event=>event.payload),[{subagentId,toolCallId,task,type:'research'}]);
  const mobile=await f.connect('mobile-reconnect');await f.attached('mobile-reconnect');
  route('subagent:done',{subagentId,toolCallId,cancelled:true,degraded:null});
  await mobile.until(events=>events.some(event=>event.meta.name==='subagent:done'));
  const childIndex=mobile.events.findIndex(event=>event.meta.name==='subagent:started'&&event.payload?.subagentId===subagentId);
  const doneIndex=mobile.events.findIndex(event=>event.meta.name==='subagent:done'&&event.payload?.subagentId===subagentId);
  assert(childIndex>=0&&doneIndex>childIndex);
  assert.equal(mobile.events[doneIndex].payload.cancelled,true);
  await f.h.rebuildReplay(f.s,messages,ids);
  assert.equal(decode().find(event=>event.meta.name==='agent:tool-completed').payload.cancelled,true);
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
