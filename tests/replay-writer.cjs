const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ReplayWriter, committedReplay } = require('../dist/history/replay-writer.js');
const frame = (id, text = 'test') => `id: ${id}\ndata: ${JSON.stringify({meta:{name:'agent:response-segment'},payload:{text}})}\n\n`;
async function fixture(t, decorate = io => io) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ashub-replay-writer-'));
  t.after(() => fs.rm(dir, {recursive:true,force:true}));
  const file = path.join(dir, 'session.replay.jsonl'), checkpoint = path.join(dir, 'session.replay-state.json');
  const writer = new ReplayWriter(file, checkpoint, decorate({...fs}));
  const read = async () => committedReplay(await fs.readFile(file), JSON.parse(await fs.readFile(checkpoint,'utf8')));
  return {file,checkpoint,writer,read};
}
test('normal growth writes only the delta and preserves Unicode and old SSE format', async t => {
  let appended = '', fullWrites = 0;
  const f = await fixture(t, io => ({...io, appendFile:async (...args)=>{appended+=args[1];return io.appendFile(...args)},writeFile:async (...args)=>{if(args[0].endsWith('.jsonl.tmp'))fullWrites++;return io.writeFile(...args)}}));
  const a=frame(1,'你好🙂'), b=frame(2,'🟡 completed');
  await f.writer.save([a],'leaf-a');await f.writer.save([a,b],'leaf-b');
  assert.equal(fullWrites,1);assert.equal(appended,b);assert.equal(await f.read(),a+b);
  assert.equal(await fs.readFile(f.file,'utf8'),a+b);
});
test('tag edits and branch replacement use an atomic snapshot rather than append', async t => {
  const f=await fixture(t),a=frame(1),b=frame(2),changed=frame(1,'entryId now assigned');
  await f.writer.save([a,b],'old');await f.writer.save([changed,b],'old');assert.equal(await f.read(),changed+b);
  await f.writer.save([frame(5,'new branch')],'new');assert.equal(await f.read(),frame(5,'new branch'));
});
test('a slow writer coalesces pending snapshots without losing the newest state or waiters', async t => {
  let resume, entered;const ready=new Promise(r=>entered=r), blocked=new Promise(r=>resume=r);let writes=0;
  const f=await fixture(t,io=>({...io,writeFile:async(...args)=>{if(args[0].endsWith('.jsonl.tmp')&&++writes===1){entered();await blocked}return io.writeFile(...args)}}));
  const a=frame(1),b=frame(2),c=frame(3),p1=f.writer.save([a],'a');await ready;
  const p2=f.writer.save([a,b],'b'),p3=f.writer.save([a,b,c],'c');resume();await Promise.all([p1,p2,p3]);
  assert.equal(writes,1);assert.equal(await f.read(),a+b+c);assert.equal(JSON.parse(await fs.readFile(f.checkpoint,'utf8')).leaf,'c');
});
test('checkpoint failure leaves only committed bytes readable and a retry repairs the file', async t => {
  let fail=false;const f=await fixture(t,io=>({...io,rename:async(...args)=>{if(fail&&args[1].endsWith('state.json'))throw Error('disk unavailable');return io.rename(...args)}}));
  const a=frame(1),b=frame(2);await f.writer.save([a],'a');fail=true;
  await assert.rejects(f.writer.save([a,b],'b'),/disk unavailable/);assert.equal(await f.read(),a);
  fail=false;await f.writer.save([a,b],'b');assert.equal(await f.read(),a+b);
});
test('partial append and trailing UTF-8 bytes are excluded by the commit boundary', async t => {
  let fail=false;const f=await fixture(t,io=>({...io,appendFile:async(file,text,...rest)=>{if(fail){await io.appendFile(file,Buffer.from(text).subarray(0,5));throw Error('partial write')}return io.appendFile(file,text,...rest)}}));
  const a=frame(1),b=frame(2,'🙂');await f.writer.save([a],'a');fail=true;
  await assert.rejects(f.writer.save([a,b],'b'));assert.equal(await f.read(),a);
  fail=false;await f.writer.save([a,b],'b');assert.equal(await f.read(),a+b);
});
test('replaced snapshot with old checkpoint is rejected, not silently replayed as old branch', async t => {
  let fail=false;const f=await fixture(t,io=>({...io,rename:async(...args)=>{if(fail&&args[1].endsWith('state.json'))throw Error('checkpoint failure');return io.rename(...args)}}));
  await f.writer.save([frame(1,'old')],'old');fail=true;await assert.rejects(f.writer.save([frame(9,'new')],'new'));
  await assert.rejects(f.read(),/checkpoint does not match/);
});
test('legacy checkpoint is readable and malformed commit boundaries are rejected',()=>{
  const data=Buffer.from(frame(1));assert.equal(committedReplay(data,{leaf:'legacy'}),data.toString());
  for(const saved of [{bytes:-1,sha256:'0'.repeat(64)},{bytes:1},{bytes:99999,sha256:'0'.repeat(64)},{bytes:1,sha256:'bad'}])assert.throws(()=>committedReplay(data,saved),SyntaxError);
});
test('external truncation forces a complete repair instead of appending to corrupt data',async t=>{
  const f=await fixture(t),a=frame(1),b=frame(2);await f.writer.save([a],'a');await fs.writeFile(f.file,'broken');
  await f.writer.save([a,b],'b');assert.equal(await f.read(),a+b);
});
test('long-history growth keeps data writes proportional to new records',async t=>{
  let dataBytes=0;const f=await fixture(t,io=>({...io,
    writeFile:async(file,text,...args)=>{if(file.endsWith('.jsonl.tmp'))dataBytes+=Buffer.byteLength(text);return io.writeFile(file,text,...args)},
    appendFile:async(file,text,...args)=>{dataBytes+=Buffer.byteLength(text);return io.appendFile(file,text,...args)}
  }));
  const frames=Array.from({length:2000},(_,i)=>frame(i,'history '.repeat(128)));
  await f.writer.save(frames,'initial');const initial=dataBytes;let expectedDelta=0,oldFullBytes=0;
  for(let i=0;i<20;i++){const next=frame(2000+i,'new result '.repeat(16));frames.push(next);expectedDelta+=Buffer.byteLength(next);oldFullBytes+=Buffer.byteLength(frames.join(''));await f.writer.save(frames,`leaf-${i}`)}
  assert.equal(dataBytes-initial,expectedDelta,'growth must not rewrite the historical payload');
  assert(oldFullBytes>expectedDelta*100);
  console.log(`Replay write fixture: ${oldFullBytes} full-rewrite bytes -> ${dataBytes-initial} incremental bytes over 20 flushes (initial snapshot excluded)`);
});
