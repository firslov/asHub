import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../dist/history/session-store.js';
import { createCapture } from '../dist/history/capture.js';
import { createCompactionStrategy, safeCutPoints } from '../dist/history/compaction-strategy.js';
import { estimateContextTokens, emptyMemory, parseMemory, renderMemory, summaryInput, textPage } from '../dist/history/context-memory.js';
import { createHistoryReader, historyTool } from '../dist/history/history-reader.js';
import { generateSummary } from '../dist/history/summary-client.js';
import { estimateMessagesTokens } from 'agent-sh/utils/token-estimate.js';

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; };
const history = (count = 10) => Array.from({length:count}, (_,i) => [
  {role:'user',content:i === 0 ? '请实现功能。'+ '背景说明。'.repeat(35)+'验证完成前不要停止；禁止部署服务器 🟡' : `补充要求 ${i}`},
  {role:'assistant',content:`阶段 ${i} 输出\n`+'details '.repeat(1800)},
]).flat();
async function fixture(t, messages = history()) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'ashub-compact-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const file = path.join(dir,'tree.jsonl');
  const store = new SessionStore(file,{create:{sessionId:'fixture',cwd:dir}});
  const bridge = {messages, async snapshot(){return {messages:this.messages}}};
  const capture = createCapture(bridge,()=>store); await capture.flush();
  const warnings = [], projections = [];
  let tail = Promise.resolve();
  const lock = fn => { const pending=tail.then(fn);tail=pending.catch(()=>{});return pending; };
  const strategy = createCompactionStrategy(()=>store,()=>capture,m=>warnings.push(m),async(m,ids)=>projections.push({m,ids}),lock);
  const helpers = {getMessages:()=>bridge.messages,replaceMessages:m=>bridge.messages=m,
    estimatePromptTokens:()=>estimateContextTokens(bridge.messages)+800,contextWindow:()=>60000,contextKey:()=> 'fixture-model'};
  let fallthrough=0;
  return {store,bridge,capture,strategy,helpers,warnings,projections,file,
    run:options=>strategy(helpers,options ?? {target:7000},()=>{fallthrough++;return null}),get fallthrough(){return fallthrough}};
}
function goodSummary(input) {
  const data=JSON.parse(input[1].content), id=data.records.at(-1).id;
  return JSON.stringify({state:{goal:[],open:[{text:'移动端验证尚未执行，不能认定已完成',sourceIds:[id]}],next:[],blockers:[]},history:[{text:'已保留原始证据，需核验结果',sourceIds:[id]}]});
}

test('estimator matches the installed kernel for images, metadata and tool arguments',()=>{
  for(const size of [100,1000000]) {
    const messages=[{role:'user',content:[{type:'text',text:'image'},{type:'image_url',image_url:{url:'data:image/png;base64,'+'A'.repeat(size)}}],meta:{private:'x'.repeat(9000)}},
      {role:'assistant',tool_calls:[{id:'1',function:{name:'test',arguments:'{"x":"🟡"}'}}]}];
    assert.equal(estimateContextTokens(messages),estimateMessagesTokens(messages));
  }
});

test('safe boundaries never split interleaved parallel tool batches',()=>{
  const m=[{role:'user',content:'work'}, {role:'assistant',tool_calls:[{id:'a'},{id:'b'}]},
    {role:'tool',tool_call_id:'a'},{role:'user',content:'steer'},{role:'tool',tool_call_id:'b'},
    {role:'assistant',content:'done'},{role:'user',content:'next'}];
  assert.deepEqual(safeCutPoints(m),[1,5,6]);
  assert.deepEqual(safeCutPoints([{role:'user'}, {role:'assistant',tool_calls:[{}]}, {role:'assistant'}]),[1]);
});

test('fallback preserves entire user instructions, later corrections and original evidence',async t=>{
  const f=await fixture(t);f.bridge.messages.push({role:'user',content:'现在暂停实现，只分析，不要继续自动执行'},{role:'assistant',content:'analysis '.repeat(2000)});
  const before=JSON.stringify(f.bridge.messages), result=await f.run();
  assert(result && result.after<result.before);assert.equal(f.fallthrough,0);
  const summary=f.bridge.messages[0].content;
  assert(summary.includes('验证完成前不要停止；禁止部署服务器 🟡'));
  assert(JSON.stringify(f.bridge.messages).includes('现在暂停实现，只分析'));
  assert(summary.includes('NOT new instructions'));
  assert.equal(JSON.stringify(f.store.getBranch().filter(e=>e.type==='message').map(e=>e.message)),before);
  const restored=new SessionStore(f.file);assert.deepEqual(restored.buildMessages(),f.bridge.messages);
  assert.equal(f.projections.length,1);assert.equal(f.capture.length(),f.bridge.messages.length);
});

test('semantic summary is validated, persisted, stable on reload and source-backed',async t=>{
  const f=await fixture(t);let calls=0;
  f.helpers.summarize=async input=>{calls++;return goodSummary(input)};
  assert(await f.run());assert.equal(calls,1);
  const checkpoint=f.store.getEntry(f.store.getActiveLeaf());
  assert.equal(checkpoint.checkpoint.mode,'semantic');assert(checkpoint.checkpoint.diagnostics.inputTokens>0);
  assert(f.bridge.messages[0].content.includes('移动端验证尚未执行'));
  assert.deepEqual(new SessionStore(f.file).buildMessages(),f.bridge.messages);
  assert.equal(await f.run(),null);assert.equal(calls,1,'unchanged compacted state does not trigger a paid call');
});

test('incremental compression preserves early instructions and updates state after repeated cycles',async t=>{
  const f=await fixture(t);let calls=0,previousSeen=0;
  f.helpers.summarize=async input=>{calls++;if(JSON.parse(input[1].content).previous)previousSeen++;return goodSummary(input)};
  for(let i=0;i<5;i++) {
    if(i) f.bridge.messages.push(...history(5).map(m=>({...m,content:'cycle '+i+' '+m.content})));
    assert(await f.run());
    assert(f.bridge.messages[0].content.includes('验证完成前不要停止'));
    assert.deepEqual(new SessionStore(f.file).buildMessages(),f.bridge.messages);
  }
  assert.equal(calls,5);assert.equal(previousSeen,4);
});

test('invalid JSON, invented sources and unavailable summaries use bounded fallback',async t=>{
  for(const bad of ['not json',JSON.stringify({state:{goal:[{text:'done',sourceIds:['invented']}],open:[],next:[],blockers:[]},history:[]}),null]) {
    const f=await fixture(t);f.helpers.summarize=async()=>{if(bad===null)throw Error('offline');return bad};
    assert(await f.run());assert.equal(f.store.getEntry(f.store.getActiveLeaf()).checkpoint.mode,'fallback');
    assert(f.bridge.messages[0].content.includes('验证完成前不要停止'));
  }
});

test('oversized semantic result falls back instead of losing compression savings',async t=>{
  const f=await fixture(t);f.helpers.summarize=async input=>{
    const id=JSON.parse(input[1].content).records[0].id;
    return JSON.stringify({state:{goal:[],open:[],next:[],blockers:[]},history:Array.from({length:8},()=>({text:'x'.repeat(900),sourceIds:[id]}))});
  };
  const result=await f.run();assert(result && result.after<result.before);
});

test('pending summary is discarded on cancellation without changing history',async t=>{
  const f=await fixture(t), gate=deferred(), entered=deferred(), controller=new AbortController();
  f.helpers.signal=controller.signal;f.helpers.summarize=async input=>{entered.resolve();await gate.promise;return goodSummary(input)};
  const leaf=f.store.getActiveLeaf(), original=JSON.stringify(f.bridge.messages), running=f.run();await entered.promise;
  controller.abort();gate.resolve();assert.equal(await running,null);
  assert.equal(f.store.getActiveLeaf(),leaf);assert.equal(JSON.stringify(f.bridge.messages),original);assert.equal(f.projections.length,0);
});

test('snapshot change, provider switch and rewind ABA invalidate pending checkpoint',async t=>{
  for(const mutation of ['append','provider','rewind']) {
    const f=await fixture(t),gate=deferred(),entered=deferred();
    f.helpers.summarize=async input=>{entered.resolve();await gate.promise;return goodSummary(input)};
    const leaf=f.store.getActiveLeaf(), running=f.run();await entered.promise;
    if(mutation==='append')f.bridge.messages.push({role:'user',content:'changed requirement'});
    if(mutation==='provider')f.helpers.contextKey=()=> 'different';
    if(mutation==='rewind'){f.store.setActiveLeaf(f.store.getRootId());f.store.setActiveLeaf(leaf)}
    gate.resolve();assert.equal(await running,null);assert.equal(f.store.getActiveLeaf(),leaf);assert.equal(f.projections.length,0);
  }
});

test('concurrent compactions produce one checkpoint',async t=>{
  const f=await fixture(t),gate=deferred(),entered=deferred();
  f.helpers.summarize=async input=>{entered.resolve();await gate.promise;return goodSummary(input)};
  const first=f.run();await entered.promise;assert.equal(await f.run(),null);gate.resolve();assert(await first);
  assert.equal(f.store.getBranch().filter(e=>e.type==='compaction').length,1);
});

test('disk failure leaves live messages, leaf and capture unchanged; no kernel fallback',async t=>{
  const f=await fixture(t);const before=JSON.stringify(f.bridge.messages),leaf=f.store.getActiveLeaf(),n=f.capture.length();
  f.store.appendCompaction=async()=>{throw Error('ENOSPC')};assert.equal(await f.run(),null);
  assert.equal(JSON.stringify(f.bridge.messages),before);assert.equal(f.store.getActiveLeaf(),leaf);assert.equal(f.capture.length(),n);assert.equal(f.fallthrough,0);
});

test('uncompactable protected user text does not trigger repeated summary calls',async t=>{
  const f=await fixture(t,Array.from({length:5},()=>[{role:'user',content:'rule '.repeat(10000)},{role:'assistant',content:'ok'}]).flat());
  let calls=0;f.helpers.summarize=async()=>{calls++;throw Error('should not run')};
  assert.equal(await f.run(),null);assert.equal(await f.run(),null);assert.equal(calls,0);assert.equal(f.fallthrough,0);
});

test('rewind removes future memory and history reader cannot cross branch boundaries',async t=>{
  const f=await fixture(t);const oldLeaf=f.store.getActiveLeaf(),source=f.store.getBranch().find(e=>e.type==='message').id;
  await f.run();const compactLeaf=f.store.getActiveLeaf();
  const reader=createHistoryReader(()=>f.store);assert(reader({id:source}).text.includes('验证完成前不要停止'));
  f.store.setActiveLeaf(oldLeaf);assert(!f.store.buildMessages()[0].content.startsWith('[Compacted conversation'));
  f.store.setActiveLeaf(f.store.getRootId());await f.store.appendMessages([{role:'user',content:'new branch'}]);
  assert.throws(()=>reader({id:source}),/active branch/);
  await assert.rejects(f.store.appendCompaction(source),/active branch/);
  f.store.setActiveLeaf(compactLeaf);assert(f.store.buildMessages()[0].content.includes('验证完成前不要停止'));
});

test('history search and pagination return bounded original text and tool arguments',async t=>{
  const f=await fixture(t);const ids=await f.store.appendMessages([{role:'assistant',content:'hello 🟡 world',tool_calls:[{id:'c',function:{name:'bash',arguments:'{"command":"echo source"}'}}]}]);
  const reader=createHistoryReader(()=>f.store),tool=historyTool(reader);
  assert.equal(reader({query:'验证完成',limit:1}).entries.length,1);
  assert.equal(reader({query:'echo source',limit:1}).entries[0].id,ids[0]);
  const one=reader({id:ids[0],limit:7}),two=reader({id:ids[0],offset:one.nextOffset,limit:12000});
  assert((one.text+two.text).includes('hello 🟡 world'));assert(two.text.includes('echo source'));
  assert.throws(()=>reader({offset:-1}));assert.throws(()=>reader({limit:100}));
  assert.equal((await tool.execute({id:ids[0]},undefined,{})).isError,false);
});

test('summary input is bounded and only references supplied records',()=>{
  const entries=Array.from({length:30},(_,i)=>({type:'message',id:String(i),message:{role:'assistant',content:'x'.repeat(9000)}}));
  const input=summaryInput(entries,undefined,2500);assert(input.inputTokens<=2500);assert(input.omittedRecords>0);
  assert.equal(parseMemory(JSON.stringify({state:{goal:[],open:[],next:[],blockers:[]},history:[{text:'claim',sourceIds:['missing']}]}),input.allowedIds),null);
});

test('fallback and excerpts never create lone surrogates',()=>{
  const text='x'.repeat(239)+'🟡'+'y'.repeat(600)+'🟡';
  assert(textPage(text,0,240).text.isWellFormed());
  const input=summaryInput([{id:'x',message:{role:'tool',content:text.repeat(8)}}],undefined,5000);
  assert(input.messages.every(m=>m.content.isWellFormed()));
});

test('summary transport uses current client without tools, enforces completion and forwards cancellation',async()=>{
  const parent=new AbortController();let options;
  const client={async stream(opts){options=opts;return (async function*(){yield {choices:[{delta:{content:'{}'},finish_reason:'stop'}]}})()}};
  assert.equal(await generateSummary(client,[{role:'user',content:'data'}],parent.signal,{model:'current',params:{reasoning_effort:'low'},headers:{'session-id':'summary'}}),'{}');
  assert.equal(options.model,'current');assert.equal(options.tools,undefined);assert.equal(options.max_tokens,8192);assert.equal(options.headers['session-id'],'summary');
  const hanging={stream:opts=>{options=opts;return new Promise(()=>{})}};
  await assert.rejects(generateSummary(hanging,[],parent.signal,{timeoutMs:15}),/deadline/);assert(options.signal.aborted);
  const cancel=new AbortController(),request=generateSummary(hanging,[],cancel.signal);cancel.abort();await assert.rejects(request);assert(options.signal.aborted);
  await assert.rejects(generateSummary({async stream(){return (async function*(){yield {choices:[{delta:{content:'partial'}}]}})()}},[],parent.signal),/Incomplete/);
});

test('fallback refresh retains earlier unfinished work as unverified state',async t=>{
  const f=await fixture(t);f.helpers.summarize=async input=>goodSummary(input);assert(await f.run());
  f.bridge.messages.push(...history(6));f.helpers.summarize=async()=>{throw Error('offline')};
  assert(await f.run());const summary=f.bridge.messages[0].content;
  assert(summary.includes('移动端验证尚未执行'));assert(summary.includes('Fallback notes'));
  assert.deepEqual(new SessionStore(f.file).buildMessages(),f.bridge.messages);
});

test('checkpoint provenance survives context drop without resurrecting removed recent messages',async t=>{
  const f=await fixture(t);await f.run();
  const source=f.store.getHistoryEntries()[0].id, checkpoint=f.bridge.messages[0];
  const droppedRecent=f.capture.getEntryIdAt(f.bridge.messages.length-1);
  // Mirror the host context-drop operation: retain the checkpoint, remove the tail,
  // and rewrite the chosen messages below the session root with new entry IDs.
  const kept=[checkpoint,{role:'user',content:'new scoped task'},{role:'assistant',content:'new result '.repeat(3000)}];
  const ids=await f.store.appendMessages(kept,f.store.getRootId());f.bridge.messages=kept;f.capture.resetTo(ids);
  const reader=createHistoryReader(()=>f.store);
  assert(reader({id:source}).text.includes('验证完成前不要停止'));
  assert.throws(()=>reader({id:droppedRecent}),/active branch/);
  f.bridge.messages.push(...history(5));assert(await f.run());
  assert(f.bridge.messages[0].content.includes('验证完成前不要停止'));
  assert.equal((f.bridge.messages[0].content.match(/Historical user inputs below/g)||[]).length,1,'do not nest synthetic summaries as user instructions');
  assert.deepEqual(new SessionStore(f.file).buildMessages(),f.bridge.messages);
  assert(createHistoryReader(()=>new SessionStore(f.file))({id:source}).text.includes('验证完成前不要停止'));
});

test('history image recall is explicit, bounded, branch-scoped and tool-compatible',async t=>{
  const f=await fixture(t);const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=';
  const [id]=await f.store.appendMessages([{role:'user',content:[{type:'text',text:'看图'},{type:'image_url',image_url:{url:'data:image/png;base64,'+data}}]}]);
  const read=createHistoryReader(()=>f.store),tool=historyTool(read);
  assert.equal(read({id}).images,1);assert(!JSON.stringify(read({id})).includes(data));
  const result=await tool.execute({id,imageIndex:0},undefined,{});
  assert.deepEqual(result.content,[{type:'image',data,mimeType:'image/png'}]);assert.equal(result.isError,false);
  assert.equal((await tool.execute({id,imageIndex:1},undefined,{})).isError,true);
  assert.throws(()=>read({imageIndex:0}));
});

test('one-character pages do not loop or lose emoji',()=>{
  const text='🟡a🟡';let offset=0,joined='',iterations=0;
  while(offset!==null){const page=textPage(text,offset,1);joined+=page.text;offset=page.nextOffset;assert(++iterations<8)}
  assert.equal(joined,text);
});

test('corrupted semantic notes retain exact user inputs on recovery',async t=>{
  const f=await fixture(t);await f.run();
  const rows=(await fs.readFile(f.file,'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  for(const row of rows)if(row.type==='compaction')row.checkpoint.memory={bad:true};
  await fs.writeFile(f.file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  assert(new SessionStore(f.file).buildMessages()[0].content.includes('验证完成前不要停止'));
});

test('large Base64 payloads do not change the compaction boundary',async t=>{
  const boundaries=[];
  for(const size of [1000,1000000]) {
    const messages=history();messages[8]={role:'user',content:[{type:'text',text:'分析图片'},{type:'image_url',image_url:{url:'data:image/png;base64,'+'A'.repeat(size)}}]};
    const f=await fixture(t,messages);assert(await f.run());
    const c=f.store.getEntry(f.store.getActiveLeaf());boundaries.push(f.store.getHistoryEntries().findIndex(e=>e.id===c.firstKeptId));
  }
  assert.equal(boundaries[0],boundaries[1]);
});

test('live input arriving during checkpoint I/O is retained and journal leaf rolls back',async t=>{
  const f=await fixture(t), original=f.store.appendCompaction.bind(f.store), gate=deferred(),entered=deferred(),leaf=f.store.getActiveLeaf();
  f.store.appendCompaction=async(...args)=>{const id=await original(...args);entered.resolve();await gate.promise;return id};
  const pending=f.run();await entered.promise;
  f.bridge.messages.push({role:'user',content:'new input during disk I/O'});gate.resolve();
  assert.equal(await pending,null);assert.equal(f.store.getActiveLeaf(),leaf);
  assert.equal(f.bridge.messages.at(-1).content,'new input during disk I/O');
  await f.capture.flush();assert.equal(new SessionStore(f.file).buildMessages().at(-1).content,'new input during disk I/O');
});

test('replacement failure restores original context and branch without leaking checkpoint',async t=>{
  const f=await fixture(t),before=JSON.stringify(f.bridge.messages),leaf=f.store.getActiveLeaf();let attempts=0;
  f.helpers.replaceMessages=m=>{f.bridge.messages=m;if(++attempts===1)throw Error('extension veto')};
  assert.equal(await f.run(),null);assert.equal(attempts,2);
  assert.equal(JSON.stringify(f.bridge.messages),before);assert.equal(f.store.getActiveLeaf(),leaf);
  assert.equal(JSON.stringify(new SessionStore(f.file).buildMessages()),before);
});

test('unrecoverable replacement closes the bridge and surfaces error',async t=>{
  const f=await fixture(t);let closed=false;
  f.helpers.replaceMessages=()=>{throw Error('persistent replacement failure')};f.helpers.failClosed=()=>closed=true;
  await assert.rejects(f.run(),/replacement failure/);assert(closed);
});

test('same-length persistence mismatch is not silently compacted',async t=>{
  const f=await fixture(t);f.bridge.messages[2]={role:'user',content:'unpersisted mutation'};
  let calls=0;f.helpers.summarize=async()=>{calls++;return '{}'};
  assert.equal(await f.run(),null);assert.equal(calls,0);assert.equal(f.fallthrough,0);
});

test('diagnostics are metadata-only and failure cannot change compaction result',async t=>{
  const {logCompaction}=await import('../dist/history/compaction-diagnostics.js');
  const f=await fixture(t),logs=[];f.helpers.diagnostic=event=>{logs.push(event);throw Error('diagnostic sink unavailable')};
  assert(await f.run());assert.equal(logs[0].outcome,'applied');
  const dir=path.dirname(f.file);logCompaction(dir,'fixture',{...logs[0],prompt:'SECRET',sourceLeaf:'SECRET/FILE',reason:'SECRET ERROR',elapsedMs:Infinity});
  const raw=await fs.readFile(path.join(dir,'compaction.jsonl'),'utf8');assert(!raw.includes('SECRET'));assert(!raw.includes('Infinity'));
  assert.equal(JSON.parse(raw).outcome,'applied');
});

test('retained checkpoint notes survive context deletion and the next failed refresh', async t => {
  const f = await fixture(t);
  f.helpers.summarize = async input => goodSummary(input);
  assert(await f.run());
  const original = f.store.getEntry(f.store.getActiveLeaf()).checkpoint.memory;
  const originalSource = original.state.open[0].sourceIds[0];
  const dropped = f.capture.getEntryIdAt(f.bridge.messages.length - 1);
  // Context deletion rewrites the retained summary under the root. Repeating
  // this must retain its provenance even though no compaction entry is on branch.
  for (let i = 0; i < 2; i++) {
    const kept = [f.bridge.messages[0], {role:'user', content:'continue retained task'}];
    const ids = await f.store.appendMessages(kept, f.store.getRootId());
    f.bridge.messages = kept; f.capture.resetTo(ids);
  }
  assert(!f.store.getBranch().some(e => e.type === 'compaction'));
  assert(createHistoryReader(() => new SessionStore(f.file))({id:originalSource}));
  assert.throws(() => createHistoryReader(() => f.store)({id:dropped}), /active branch/);
  f.bridge.messages.push(...history(6));
  let input;
  f.helpers.summarize = async messages => { input = JSON.parse(messages[1].content); throw Error('offline'); };
  assert(await f.run());
  assert.deepEqual(input.previous, original, 'carry retained notes into the incremental summary');
  assert(!input.records.some(e => e.id === originalSource), 'do not re-summarize the old checkpoint sources');
  const checkpoint = f.store.getEntry(f.store.getActiveLeaf()).checkpoint;
  assert.equal(checkpoint.mode, 'fallback');
  assert.deepEqual(checkpoint.memory.state, original.state);
  assert.deepEqual(new SessionStore(f.file).buildMessages(), f.bridge.messages);
});

test('invalid or legacy checkpoints do not exclude unsummarized earlier evidence', async t => {
  for (const kind of ['invalid', 'legacy']) {
    const f = await fixture(t);
    f.helpers.summarize = async input => goodSummary(input);
    assert(await f.run());
    const source = f.store.getHistoryEntries().find(e => e.message.role === 'assistant').id;
    const entry = f.store.getEntry(f.store.getActiveLeaf());
    if (kind === 'invalid') entry.checkpoint.memory = {bad:true};
    else delete entry.checkpoint;
    const restored = f.store.buildBranchWithIds();
    f.bridge.messages = restored.messages; f.capture.resetTo(restored.entryIds);
    f.bridge.messages.push(...history(5));
    let input;
    f.helpers.summarize = async messages => { input = JSON.parse(messages[1].content); return goodSummary(messages); };
    assert(await f.run());
    assert.equal(input.previous, undefined);
    assert(input.records.some(e => e.id === source), `${kind}: earlier evidence must be reconsidered when no valid notes survive`);
  }
});

test('removing the retained summary also removes its working state and source access', async t => {
  const f = await fixture(t);
  f.helpers.summarize = async input => goodSummary(input);
  assert(await f.run());
  const source = f.store.getEntry(f.store.getActiveLeaf()).checkpoint.memory.state.open[0].sourceIds[0];
  const fresh = history(6).map(m => ({...m, content:'unrelated new task '+m.content}));
  const ids = await f.store.appendMessages(fresh, f.store.getRootId());
  f.bridge.messages = fresh; f.capture.resetTo(ids);
  let input;
  f.helpers.summarize = async messages => { input = JSON.parse(messages[1].content); throw Error('offline'); };
  assert(await f.run());
  assert.equal(input.previous, undefined);
  assert(!f.bridge.messages[0].content.includes('移动端验证尚未执行'));
  assert.throws(() => createHistoryReader(() => new SessionStore(f.file))({id:source}), /active branch/);
});

test('checkpoint notes rejected on restore cannot re-enter the next summary', async t => {
  for (const corruption of ['mode', 'source']) {
    const f = await fixture(t);
    f.helpers.summarize = async input => goodSummary(input);
    assert(await f.run());
    const checkpoint = f.store.getEntry(f.store.getActiveLeaf());
    const originalSource = f.store.getHistoryEntries().find(e => e.message.role === 'assistant').id;
    const retainedSource = f.capture.getEntryIdAt(f.bridge.messages.length - 1);
    // Simulate a persisted checkpoint that has valid JSON but fails the
    // restore validator: unknown mode or a reference outside its evicted prefix.
    const rows = (await fs.readFile(f.file, 'utf8')).trim().split('\n').map(JSON.parse);
    const row = rows.find(e => e.id === checkpoint.id);
    if (corruption === 'mode') row.checkpoint.mode = 'unsupported';
    else row.checkpoint.memory.state.open[0].sourceIds = [retainedSource];
    await fs.writeFile(f.file, rows.map(e => JSON.stringify(e)).join('\n') + '\n');
    const store = new SessionStore(f.file);
    const restored = store.buildBranchWithIds();
    assert(!restored.messages[0].content.includes('移动端验证尚未执行'));
    f.bridge.messages = restored.messages;
    const capture = createCapture(f.bridge, () => store);
    capture.resetTo(restored.entryIds);
    f.bridge.messages.push(...history(5));
    let input;
    f.helpers.summarize = async messages => { input = JSON.parse(messages[1].content); throw Error('offline'); };
    const strategy = createCompactionStrategy(() => store, () => capture);
    assert(await strategy(f.helpers, {target:7000}, () => { throw Error('unexpected kernel fallback'); }));
    assert.equal(input.previous, undefined, `${corruption}: rejected notes must not return as prior state`);
    assert(input.records.some(e => e.id === originalSource), `${corruption}: reconsider original evidence`);
    assert(!f.bridge.messages[0].content.includes('移动端验证尚未执行'));
    assert.deepEqual(new SessionStore(f.file).buildMessages(), f.bridge.messages);
  }
});
