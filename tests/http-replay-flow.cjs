const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { env, Bridge, fs, path, root } = require('./harness.cjs');
const { createHash } = require('node:crypto');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, onResponse = () => {}) {
  const e = env();
  const h = e.load('src/hub.ts', 'export const replayAudit = {createSession,openSseMulti,routeEvent,sseFrame,rebuildReplay,shutdownHub,archiveSession,getSseWriter};').replayAudit;
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

test('archived HTTP history does not mistake missing committed replay for an empty archive', async t => {
  const e=env(), h=e.hub(), id='abcdef';
  const dir=path.join(e.dir,'hub-sessions');
  const replayPath=path.join(dir,`${id}.replay.jsonl`);
  const checkpointPath=path.join(dir,`${id}.replay-state.json`);
  const text='committed answer';
  const frame='data: '+JSON.stringify({meta:{name:'agent:response-segment'},payload:{text}})+'\n\n';
  const checkpoint=bytes=>JSON.stringify({leaf:null,bytes:Buffer.byteLength(bytes),sha256:createHash('sha256').update(bytes).digest('hex')});
  await h.saveArchivedSession(id,1);
  fs.writeFileSync(checkpointPath,checkpoint(frame));
  let bridgeStarts=0;
  const hub=h.startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:()=>{bridgeStarts++;return new Bridge();}});
  t.after(()=>hub.shutdown());
  await once(hub.server,'listening');
  const get=()=>fetch(`http://127.0.0.1:${hub.server.address().port}/api/sessions/archived/${id}/history`);
  const missing=await get();
  assert.equal(missing.status,500,'a checkpoint proving committed bytes is not an empty history');
  await missing.text();
  assert(!fs.existsSync(replayPath),'read-only view must not create or repair replay data');
  assert.equal(fs.readFileSync(checkpointPath,'utf8'),checkpoint(frame));
  const {SessionStore}=e.load('src/history/session-store.ts');
  const treePath=path.join(dir,`${id}.jsonl`);
  const tree=new SessionStore(treePath,{create:{sessionId:id,cwd:e.dir}});
  const saved=[{role:'user',content:'<query_context>Fixture working directory</query_context>\n\ntree question'},
    {role:'assistant',content:'tree answer'}];
  await tree.appendMessages(saved);
  const treeBytes=fs.readFileSync(treePath);
  assert.deepEqual(await (await get()).json(),{messages:[{role:'user',text:'tree question'},{role:'assistant',text:'tree answer'}]},
    'read-only tree fallback shows the original question without model context');
  assert(fs.readFileSync(treePath).equals(treeBytes));
  fs.writeFileSync(replayPath,frame);
  assert.deepEqual(await (await get()).json(),{ messages:[{role:'assistant',text}] },'reappearing committed data is retryable');
  fs.unlinkSync(replayPath);
  fs.unlinkSync(treePath);
  for (const empty of [checkpoint(''), JSON.stringify({leaf:null})]) {
    fs.writeFileSync(checkpointPath,empty);
    assert.deepEqual(await (await get()).json(),{messages:[]},'explicitly empty and legacy leaf-only checkpoints can still be empty');
  }
  assert.equal(bridgeStarts,0);
});

test('archive reopened after compaction still shows original turns omitted from live replay', async t => {
  const e=env();
  const h=e.load('src/hub.ts','export const archiveAudit={startHub,createSession,rebuildReplay,archiveSession};').archiveAudit;
  const {req,Res}=require('./harness.cjs');
  const sessions=new Map();
  const original=[{role:'user',content:'Earlier original question 🌱'},{role:'assistant',content:'Earlier original answer 🔎'},
    {role:'user',content:'Latest user question'},{role:'assistant',content:'Latest answer'}];
  const session=await h.createSession(sessions,{makeBridge:o=>new Bridge(o)},e.dir);
  session.bridge.messages=original;
  await session.capture.flush();
  await session.store.appendCompaction(session.store.getHistoryEntries()[2].id,1000);
  const view=session.store.buildBranchWithIds();
  session.bridge.messages=view.messages;
  session.capture.resetTo(view.entryIds);
  await h.rebuildReplay(session,view.messages,view.entryIds);
  assert(session.replay.some(frame=>frame.includes('hub:compaction-marker')),'fixture used live compaction projection');
  assert(!session.replay.some(frame=>frame.includes('"text":"Earlier original answer 🔎"')));
  const archived=new Res();
  await h.archiveSession(req({id:session.id}),archived,sessions);
  assert.equal(archived.statusCode,200);
  let bridgeStarts=0;
  const hub=h.startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:()=>{bridgeStarts++;return new Bridge();}});
  t.after(()=>hub.shutdown());
  await once(hub.server,'listening');
  const dir=path.join(e.dir,'hub-sessions');
  const files=['.jsonl','.replay.jsonl','.replay-state.json'].map(suffix=>path.join(dir,session.id+suffix));
  const before=files.map(file=>fs.readFileSync(file));
  const url=`http://127.0.0.1:${hub.server.address().port}/api/sessions/archived/${session.id}/history`;
  const responses=await Promise.all([fetch(url),fetch(url)]);
  for (const response of responses) {
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{messages:original.map(({role,content:text})=>({role,text}))});
  }
  for (const [i,file] of files.entries()) assert(fs.readFileSync(file).equals(before[i]),'reading must not rewrite archive data');
  assert.equal(bridgeStarts,0,'reading must not restore the archived kernel');
});

test('a restored compacted branch archives original turns without context-drop placeholder rows', async t => {
  const e=env();
  const h=e.load('src/hub.ts','export const branchArchive={startHub,createSession,forkEndpoint,getContext,dropContext,archiveSession};').branchArchive;
  const {req,Res}=require('./harness.cjs');
  const {emptyMemory}=e.load('src/history/context-memory.ts');
  const sessions=new Map();
  const s=await h.createSession(sessions,{makeBridge:o=>new Bridge(o)},e.dir);
  const row=(role,content)=>({role,content});
  const earlier=[row('user','Original earlier question 🌱'),row('assistant','Original earlier answer')];
  const dropped=[row('user','A question removed from the active branch'),row('assistant','A removed reply')];
  const kept=[row('user','Active latest question'),row('assistant','Active latest answer 🧰')];
  s.bridge.messages=[...earlier,...dropped,...kept];
  await s.capture.flush();
  const sourceLeaf=s.store.getActiveLeaf();
  const firstKeptId=s.store.getHistoryEntries()[2].id;
  const checkpoint=await s.store.appendCompaction(firstKeptId,2000,{version:1,sourceLeaf,mode:'fallback',memory:emptyMemory(),
    diagnostics:{target:1000,estimatedAfter:800,elapsedMs:0,inputTokens:0,omittedRecords:0}});
  const [alternate]=await s.store.appendMessages([row('user','Unselected branch')],s.store.getRootId());
  const fork=async id=>{
    const res=new Res();await h.forkEndpoint(req({entryId:id}),res,s);
    assert.equal(res.statusCode,200,res.body);assert.equal(res.json().leafId,id);
  };
  await fork(alternate);
  await fork(checkpoint);
  const context=new Res();await h.getContext(context,s);
  assert.equal(context.json().messages[0].meta.ashubCheckpoint,checkpoint);
  const droppedResponse=new Res();
  await h.dropContext(req({indices:[1,2],revision:context.json().revision}),droppedResponse,s);
  assert.equal(droppedResponse.statusCode,200,droppedResponse.body);
  assert(s.bridge.messages.some(m=>m.meta?.hubPlaceholder===true),'fixture preserves the internal context placeholder');
  const archived=new Res();await h.archiveSession(req({id:s.id}),archived,sessions);
  assert.equal(archived.statusCode,200,archived.body);

  let bridgeStarts=0;
  const hub=h.startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{bridgeStarts++;return new Bridge(o);}});
  t.after(()=>hub.shutdown());await once(hub.server,'listening');
  const base=`http://127.0.0.1:${hub.server.address().port}`;
  const getArchive=async()=>{
    const res=await fetch(`${base}/api/sessions/archived/${s.id}/history`);
    assert.equal(res.status,200);return res.json();
  };
  const expected={messages:[...earlier,...kept].map(({role,content:text})=>({role,text}))};
  assert.deepEqual(await getArchive(),expected);
  assert.equal(bridgeStarts,0);
  const post=async (endpoint,body)=>{
    const res=await fetch(`${base}${endpoint}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(res.status,200,await res.text());
  };
  await post('/api/sessions/unarchive',{id:s.id});
  const missing=await fetch(`${base}/api/sessions/archived/${s.id}/history`);
  assert.equal(missing.status,404);await missing.text();
  await post('/api/sessions/archive',{id:s.id});
  assert.deepEqual(await getArchive(),expected,'restore then rearchive keeps the same transcript');
});

test('cold tree recovery and branch switch replay keep model context out of chat text', {timeout:12000}, async t => {
  const e=env(),h=e.hub(),sessions=new Map();
  const opts={host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>new Bridge(o)};
  const s=await h.createSession(sessions,opts,e.dir);
  const wrap=text=>`<query_context>Fixture workspace context</query_context>\n\n${text}`;
  const firstText='First visible question 🌱\nsecond line';
  const otherText='Other branch question 🧰';
  const firstContent=wrap(firstText);
  const otherContent=[{type:'text',text:wrap(otherText)},{type:'image_url',image_url:{url:'data:image/png;base64,AA=='}}];
  s.bridge.messages=[{role:'user',content:firstContent},{role:'assistant',content:'First reply'}];
  await s.capture.flush();
  const firstLeaf=s.store.getActiveLeaf();
  const [otherLeaf]=await s.store.appendMessages([{role:'user',content:otherContent}],s.store.getRootId());
  s.store.setActiveLeaf(firstLeaf);
  assert.equal((await h.shutdownHub(undefined,sessions)).length,0);
  const dir=path.join(e.dir,'hub-sessions');
  fs.rmSync(path.join(dir,`${s.id}.replay.jsonl`),{force:true});
  const tree=path.join(dir,`${s.id}.jsonl`),original=fs.readFileSync(tree);

  const hub=h.startHub(opts);
  t.after(()=>hub.shutdown());await once(hub.server,'listening');
  const base=`http://127.0.0.1:${hub.server.address().port}`;
  const getContext=async()=>{
    const response=await fetch(`${base}/${s.id}/context`);
    assert.equal(response.status,200);return response.json();
  };
  const queries=async()=>{
    const abort=new AbortController();
    const response=await fetch(`${base}/events?subs=${s.id}:all`,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)])});
    const reader=response.body.getReader(),decoder=new TextDecoder();
    let pending='';const result=[];
    try {
      for (;;) {
        const {value,done}=await reader.read();assert(!done,'SSE ended before replay-done');
        pending+=decoder.decode(value,{stream:true});
        let index;
        while((index=pending.indexOf('\n\n'))>=0){
          const frame=pending.slice(0,index);pending=pending.slice(index+2);
          const line=frame.split('\n').find(line=>line.startsWith('data: '));if(!line)continue;
          const {meta,payload}=JSON.parse(line.slice(6));
          if(meta.name==='agent:query') {
            const {query,images,entryId}=payload;
            result.push({query,entryId,...(images?{images}:{})});
          }
          if(meta.name==='hub:replay-done') return result;
        }
      }
    } finally { abort.abort();await reader.cancel().catch(()=>{}); }
  };
  assert.equal((await getContext()).messages[0].content,firstContent);
  const cold=await queries();
  assert(fs.readFileSync(tree).equals(original),'read-only projection does not rewrite the original journal');
  const fork=await fetch(`${base}/${s.id}/fork`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({entryId:otherLeaf})});
  assert.equal(fork.status,200);assert.equal((await fork.json()).leafId,otherLeaf);
  assert.deepEqual((await getContext()).messages[0].content,otherContent);
  const switched=await queries();
  const journal=fs.readFileSync(tree,'utf8');
  assert.equal(journal,original.toString('utf8')+JSON.stringify({type:'leaf',leafId:otherLeaf})+'\n','fork persists only the leaf change');
  assert.deepEqual({cold,switched},{cold:[{query:firstText,entryId:s.store.getBranch(firstLeaf)[1].id}],
    switched:[{query:`${otherText} `,images:[{data:'AA==',mimeType:'image/png'}],entryId:otherLeaf}]}); // preserve existing multimodal text spacing
});

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

test('archiving while an SSE replay is backpressured releases the writer without late frames', {timeout:10000}, async t => {
  const f=await fixture(t,(_req,res)=>{
    const write=res.write.bind(res);
    res.write=(...args)=>{write(...args);return false;};
  });
  const client=await f.connect('archive-mid-replay');await f.attached('archive-mid-replay');
  const response=f.responses.get('/archive-mid-replay');
  const writer=f.h.getSseWriter(response);
  assert(writer.pendingFrames>0);
  const flushed=writer.flush(), finished=once(response,'finish');
  f.h.routeEvent(f.s,{name:'agent:tool-completed',payload:{toolCallId:'before-close',marker:'BEFORE'}});
  const {req,Res}=require('./harness.cjs');
  const archive=new Res();await f.h.archiveSession(req({id:f.s.id}),archive,f.sessions);
  assert.equal(archive.statusCode,200,archive.body);
  await finished;
  assert.equal(await flushed,false,'closing must settle the queued replay barrier');
  assert.equal(writer.pendingFrames,0);
  assert(!f.sessions.has(f.s.id));
  assert.equal(f.s.sseClients.size,0);
  f.h.routeEvent(f.s,{name:'agent:tool-completed',payload:{toolCallId:'after-close',marker:'AFTER'}});
  response.emit('drain');await tick();
  assert(!client.events.some(event=>event.payload?.marker==='AFTER'));
  const persisted=fs.readFileSync(path.join(f.s.cwd,'hub-sessions',`${f.s.id}.replay.jsonl`),'utf8');
  assert(persisted.includes('"marker":"BEFORE"'),'accepted live frame still reaches the archive');
  assert(!persisted.includes('"marker":"AFTER"'));
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
