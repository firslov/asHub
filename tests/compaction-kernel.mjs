import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
async function until(fn){for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error('Fixture timed out')}

test('real bridge uses current provider, persists checkpoint, restores and cancels summary requests', {timeout:45000}, async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ashub-compact-kernel-'));
  process.env.AGENT_SH_HOME=dir;process.env.HISTFILE=path.join(dir,'history');
  for(const k of Object.keys(process.env))if(/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(k))delete process.env[k];
  const requests=[],events=[];let handle;
  const server=http.createServer(async(req,res)=>{try{let body='';for await(const p of req)body+=p;const data=JSON.parse(body);requests.push(data);await handle(data,res)}catch(e){res.destroy(e)}});
  const respond=(res,text)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:text},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n')};
  let bridge;const originalFetch=globalThis.fetch;
  try{
    server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
    globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(u.origin!==origin)throw Error('Only local fixture traffic allowed');return originalFetch(input,init)};
    await fs.writeFile(path.join(dir,'settings.json'),JSON.stringify({startupBanner:false,disabledBuiltins:['rolling-history','codex-provider'],defaultProvider:'fixture',autoCompact:false,providers:{fixture:{apiKey:'fake',baseURL:origin+'/v1',defaultModel:'fixture-model',models:['fixture-model'],contextWindow:60000}}}));
    const {AshBridge}=await import('../dist/bridges/ash.js');
    const {SessionStore}=await import('../dist/history/session-store.js');
    const {createCapture}=await import('../dist/history/capture.js');
    const {createCompactionStrategy}=await import('../dist/history/compaction-strategy.js');
    const {createHistoryReader}=await import('../dist/history/history-reader.js');
    const file=path.join(dir,'tree.jsonl'),store=new SessionStore(file,{create:{sessionId:'fixture',cwd:dir}});
    const initial=Array.from({length:10},(_,i)=>[{role:'user',content:i===0?'背景。'.repeat(100)+'完成验证前不要停止，不能发布':'补充 '+i},{role:'assistant',content:'tool evidence '.repeat(2000)}]).flat();
    let capture;let projections=0;
    const strategy=createCompactionStrategy(()=>store,()=>capture,undefined,async()=>projections++);
    bridge=new AshBridge({sessionId:'fixture',cwd:dir,provider:'fixture',model:'fixture-model',initialMessages:initial,compactionStrategy:strategy,historyAccess:createHistoryReader(()=>store)});
    bridge.onEvent(e=>events.push(e));await bridge.ready();capture=createCapture(bridge,()=>store);await capture.flush();
    handle=async(data,res)=>{
      if(!data.tools){const input=JSON.parse(data.messages[1].content),id=input.records.at(-1).id;
        respond(res,JSON.stringify({state:{goal:[],open:[{text:'验证尚未完成',sourceIds:[id]}],next:[],blockers:[]},history:[]}));
      }else respond(res,'Main response');
    };
    const compacted=await bridge.compact({kind:'two-tier-pin',target:8000});
    assert(compacted && compacted.after<compacted.before);assert.equal(requests.length,1);
    assert.equal(requests[0].model,'fixture-model');assert(!requests[0].tools);assert.equal(requests[0].stream,true);
    assert.equal(store.getEntry(store.getActiveLeaf()).checkpoint.mode,'semantic');assert.equal(projections,1);
    const snap=await bridge.snapshot();assert(snap.messages[0].content.includes('完成验证前不要停止，不能发布'));
    assert.deepEqual(new SessionStore(file).buildMessages(),snap.messages);
    assert(!events.some(e=>e.name==='agent:response-chunk'),'summary must not render as the assistant answer');
    await bridge.submit('继续');assert(requests.at(-1).tools.some(t=>t.function.name==='conversation_history'));
    assert(requests.at(-1).messages.some(m=>String(m.content).includes('验证尚未完成')));
    // New source history gives a second eligible compaction, then cancel it.
    const large=(await bridge.snapshot()).messages.concat(initial);
    await bridge.compact({kind:'replace',messages:large});await capture.flush();
    const gate=deferred();let closed=false;
    const {getSettings}=await import('agent-sh/settings');getSettings().autoCompact=true;
    handle=async(_data,res)=>{res.on('close',()=>closed=true);await gate.promise;if(!res.destroyed)respond(res,'{}')};
    const before=requests.length,pending=bridge.submit('再次继续');await until(()=>requests.length>before);
    const leaf=store.getActiveLeaf();
    bridge.cancel();assert.equal((await pending).stopReason,'cancelled');await until(()=>closed);gate.resolve();assert.equal(store.getActiveLeaf(),leaf);
    assert.equal(requests.length,before+1,'cancelled auto-compaction must not start the main model request');
  }finally{
    bridge?.close();globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});
  }
});
