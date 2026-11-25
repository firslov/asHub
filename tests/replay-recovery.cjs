const test = require('node:test');
const assert = require('node:assert/strict');
const {env,Bridge,fs,path}=require('./harness.cjs');
const {createHash}=require('node:crypto');
const frame=(id,name,payload)=>`id: ${id}\ndata: ${JSON.stringify({meta:{name,source:'abcdef',ts:1},payload})}\n\n`;
async function restore(t, {tail='', badHash=false, legacy=false, subagentFrames=''}={}) {
  const e=env(),h=e.hub(),sessions=new Map();
  const s=await h.createSession(sessions,{makeBridge:o=>new Bridge(o)},e.dir);
  t.after(()=>h.shutdownHub(undefined,sessions));
  s.bridge.messages=[{role:'user',content:'saved question'},{role:'assistant',content:'saved answer'}];
  await s.capture.flush();const leaf=s.store.getActiveLeaf(),id=s.id;
  await h.shutdownHub(undefined,sessions);
  const file=path.join(e.dir,'hub-sessions',id+'.replay.jsonl');
  const saved=frame(10,'agent:query',{query:'saved question',entryId:s.store.buildBranchWithIds().entryIds[0]})+frame(11,'agent:response-segment',{text:'saved answer'})+frame(12,'agent:processing-done',{})+subagentFrames;
  fs.writeFileSync(file,saved+tail);
  fs.writeFileSync(file.replace('.replay.jsonl','.replay-state.json'),JSON.stringify(legacy?{leaf}:{leaf,bytes:Buffer.byteLength(saved),sha256:badHash?'0'.repeat(64):createHash('sha256').update(saved).digest('hex')}));
  const restored=await h.createSession(sessions,{makeBridge:o=>new Bridge(o)},e.dir,{id,cwd:e.dir,title:'test',startedAt:1,replay:[],backendId:'ash'});
  await restored._ensureBridge();
  return {e,h,s:restored,file,saved};
}
test('restart ignores complete but uncommitted appended events',async t=>{
  const f=await restore(t,{tail:frame(13,'agent:response-segment',{text:'UNCOMMITTED'})});
  assert(!f.s.replay.join('').includes('UNCOMMITTED'));
  assert(f.s.replay.join('').includes('saved answer'));
  assert(!fs.readFileSync(f.file,'utf8').includes('UNCOMMITTED'));
});
test('restart ignores a torn tail and repairs a valid committed prefix',async t=>{
  const f=await restore(t,{tail:'id: 13\ndata: {"meta":'});
  assert(f.s.replay.join('').includes('saved answer'));assert.equal(fs.readFileSync(f.file,'utf8'),f.saved);
});
test('mismatched checkpoint preserves evidence and rebuilds the active branch',async t=>{
  const f=await restore(t,{badHash:true,tail:frame(99,'agent:response-segment',{text:'WRONG BRANCH'})});
  assert(!f.s.replay.join('').includes('WRONG BRANCH'));assert(f.s.replay.join('').includes('saved answer'));
  const names=fs.readdirSync(path.dirname(f.file));assert(names.some(n=>n.includes('.replay.jsonl.recovery-')));
  assert(names.some(n=>n.includes('.replay-state.json.recovery-')));
});
test('legacy leaf-only checkpoints continue to restore',async t=>{
  const f=await restore(t,{legacy:true});assert(f.s.replay.join('').includes('saved answer'));
});
test('a late subagent cancellation survives a complete host restart',async t=>{
  const e=env(),h=e.load('src/hub.ts','export const recoveryAudit={createSession,routeEvent,shutdownHub};').recoveryAudit;
  const sessions=new Map(),opts={makeBridge:o=>new Bridge(o)};
  const original=await h.createSession(sessions,opts,e.dir);
  t.after(()=>h.shutdownHub(undefined,sessions));
  original.bridge.messages=[{role:'user',content:'check these files'}];
  await original.capture.flush();
  const route=(name,payload)=>h.routeEvent(original,{name,payload});
  route('agent:query',{query:'check these files'});
  route('subagent:started',{subagentId:'review',task:'Review the files'});
  route('agent:cancelled',{});
  route('subagent:done',{subagentId:'review',cancelled:true,degraded:null});
  await h.shutdownHub(undefined,sessions);
  const restored=await h.createSession(sessions,opts,e.dir,{id:original.id,cwd:e.dir,title:'test',startedAt:1,replay:[],backendId:'ash'});
  await restored._ensureBridge();
  const events=Array.from(restored.replay,data=>JSON.parse(data.split('\n').find(line=>line.startsWith('data: ')).slice(6)));
  const cancelled=events.filter(event=>event.meta.name==='subagent:done');
  assert.deepEqual(cancelled.map(event=>event.payload),[{subagentId:'review',cancelled:true,degraded:null}]);
  const parentStop=events.findIndex(event=>event.meta.name==='agent:cancelled');
  assert(parentStop>=0&&parentStop<events.indexOf(cancelled[0]));
});
test('cold restore cancels interrupted children and expires only historical continuation handles',async t=>{
  const f=await restore(t,{subagentFrames:
    frame(13,'agent:tool-started',{toolCallId:'launch',name:'research',rawInput:{task:'Background review'}})+
    frame(14,'subagent:started',{toolCallId:'launch',subagentId:'active',task:'Background review'})+
    frame(15,'agent:tool-completed',{toolCallId:'launch',exitCode:0})+
    frame(16,'subagent:started',{subagentId:'previous',task:'Finished review'})+
    frame(17,'subagent:done',{subagentId:'previous',degraded:'budget',resumable:true})+
    frame(18,'agent:tool-started',{toolCallId:'queued',name:'subagent_resume',rawInput:{task:'Follow up'}})+
    frame(19,'agent:tool-started',{toolCallId:'generic',name:'read_file'})+
    frame(20,'agent:tool-started',{toolCallId:'rejected',name:'review'})+
    frame(21,'agent:tool-completed',{toolCallId:'rejected',exitCode:1})+
    frame(22,'subagent:swarm-started',{swarmId:'running-swarm',total:4})+
    frame(23,'subagent:swarm-progress',{swarmId:'running-swarm',done:1,failed:1})+
    frame(24,'subagent:swarm-started',{swarmId:'finished-swarm',total:1})+
    frame(25,'subagent:swarm-done',{swarmId:'finished-swarm',done:1,failed:0})});
  const events=Array.from(f.s.replay,data=>JSON.parse(data.split('\n').find(line=>line.startsWith('data: ')).slice(6)));
  assert.deepEqual(events.filter(event=>event.meta.name==='subagent:done').map(event=>event.payload),[
    {subagentId:'previous',degraded:'budget',resumable:false},
    {subagentId:'active',toolCallId:'launch',task:'Background review',cancelled:true,degraded:null},
    {toolCallId:'queued',task:'Follow up',cancelled:true,degraded:null},
  ]);
  assert.deepEqual(events.filter(event=>event.meta.name==='subagent:swarm-done').map(event=>event.payload),[
    {swarmId:'finished-swarm',done:1,failed:0},
    {swarmId:'running-swarm',done:1,failed:1,cancelled:true},
  ]);
  assert(events.every(event=>event.meta.name!=='agent:cancelled'),'the prior main turn already ended');
});
test('deletion waits for a coalesced replay write and never resurrects history',async t=>{
  let release,entered,block=false;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),real=require('node:fs');
  const e=env({modules:{'node:fs':{...real,promises:{...real.promises,writeFile:async(file,...args)=>{
    if(block&&String(file).endsWith('.replay.jsonl.tmp')){entered();await gate}return real.promises.writeFile(file,...args)
  }}}}});
  const h=e.load('src/hub.ts','export const review={createSession,persistReplayFile,closeSession,shutdownHub};').review,sessions=new Map();
  const s=await h.createSession(sessions,{makeBridge:o=>new Bridge(o)},e.dir);t.after(()=>h.shutdownHub(undefined,sessions));
  block=true;s.replay=[frame(1,'agent:query',{query:'one'})];const first=h.persistReplayFile(s.id,s.replay);await ready;
  s.replay.push(frame(2,'agent:response-segment',{text:'two'}));const second=h.persistReplayFile(s.id,s.replay);
  s.replay.push(frame(3,'agent:processing-done',{}));const third=h.persistReplayFile(s.id,s.replay);
  const {Res}=require('./harness.cjs'),response=new Res(),deleting=h.closeSession(response,sessions,s.id);
  await new Promise(r=>setImmediate(r));assert.equal(response.writableEnded,false);
  release();await Promise.all([first,second,third,deleting]);assert.equal(response.statusCode,200);
  const names=fs.readdirSync(path.join(e.dir,'hub-sessions')).filter(n=>n.startsWith(s.id)&&!n.endsWith('.deleted'));
  assert.deepEqual(names,[]);assert(!sessions.has(s.id));
});
