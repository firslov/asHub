const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { env } = require('./harness.cjs');
const { SseWriter } = env().load('src/transport/sse-writer.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
class Response extends EventEmitter {
  constructor() { super(); this.chunks = []; this.writableEnded = false; this.destroyed = false; this.writableLength = 0; this.backpressure = false; }
  write(chunk) { this.chunks.push(chunk); if (this.backpressure) { this.writableLength += Buffer.byteLength(chunk); return false; } return true; }
  drain() { this.backpressure = false; this.writableLength = 0; this.emit('drain'); }
  destroy() { this.destroyed = true; this.emit('close'); }
  end() { this.writableEnded = true; this.emit('finish'); }
}
test('false write is accepted once; FIFO resumes only after drain', async () => {
  const res = new Response(), writer = new SseWriter(res);
  res.backpressure = true;
  assert.equal(writer.write('one'), true); assert.equal(writer.write('two'), true);
  const flushed = writer.flush();
  assert.deepEqual(res.chunks, ['one']);
  await tick(); assert.deepEqual(res.chunks, ['one']);
  res.drain(); assert.equal(await flushed, true); assert.deepEqual(res.chunks, ['one', 'two']);
  writer.close();
});
test('lazy history reserves order before live writes and yields between bounded batches', async () => {
  const res = new Response(), writer = new SseWriter(res, {batchWrites: 2});
  let read = 0;
  const replay = writer.replay((function* () { for (let i=0;i<8;i++) {read++;yield 'history'+i;} })());
  assert.equal(read, 2, 'history eagerly expanded');
  writer.write('replay-done'); writer.write('live');
  assert.deepEqual(res.chunks, ['history0','history1']);
  const barrier = writer.flush();
  assert.equal(await replay, true); assert.equal(await barrier, true);
  assert.deepEqual(res.chunks, Array.from({length:8},(_,i)=>'history'+i).concat('replay-done','live'));
  writer.close();
});
test('a blocked socket does not advance its history iterator', async () => {
  const res = new Response(), writer = new SseWriter(res); res.backpressure = true;
  let read = 0;
  const replay = writer.replay((function*(){ read++;yield 'a';read++;yield 'b'; })());
  assert.equal(read,1); await tick(); assert.equal(read,1);
  res.drain(); assert.equal(await replay,true); assert.equal(read,2); writer.close();
});
test('queue byte overflow closes only the slow consumer and settles pending replay', async () => {
  const slow = new Response(), fast = new Response(); slow.backpressure = true;
  const a = new SseWriter(slow,{maxQueuedBytes:10}), b = new SseWriter(fast,{maxQueuedBytes:10});
  const replay = a.replay(['one','two']);
  assert.equal(a.write('12345678'),false);
  assert.equal(await replay,false); assert.equal(a.closed,true); assert.equal(slow.destroyed,true);
  assert.equal(a.pendingFrames,0); assert.equal(a.write('late'),false);
  assert.equal(b.write('ok'),true); assert.deepEqual(fast.chunks,['ok']); b.close();
});
test('queue frame and lazy-source counts are bounded independently', async () => {
  const res = new Response(), writer = new SseWriter(res,{maxQueuedFrames:2}); res.backpressure=true;
  writer.write('a'); writer.write('b'); writer.write('c'); assert.equal(writer.write('d'),false);
  assert.equal(writer.closed,true);
  const second = new Response(), batches = new SseWriter(second,{maxReplaySources:1}); second.backpressure=true;
  const first = batches.replay(['a','b']), rejected=batches.replay(['c']);
  assert.equal(await first,false);assert.equal(await rejected,false);assert.equal(batches.closed,true);
});
test('large lazy history records use bounded, Unicode-safe socket writes', async () => {
  const res = new Response(), writer = new SseWriter(res,{batchWrites:1});
  const frame = 'x'.repeat(16383)+'😀'+'中'.repeat(40000)+'\n\n';
  assert.equal(await writer.replay([frame]),true);
  assert.equal(Buffer.concat(res.chunks.map(text=>Buffer.from(text))).toString(),frame);
  assert(res.chunks.length>2); assert(res.chunks.every(text=>text.length<=16384));writer.close();
});
test('close, finish and error settle barriers and release iterator and drain listeners', async () => {
  for(const event of ['close','finish','error']) {
    const res=new Response(),writer=new SseWriter(res);res.backpressure=true;let returned=false;
    const replay=writer.replay((function*(){try{yield 'a';yield 'b';}finally{returned=true;}})());
    const flushed=writer.flush();res.emit(event,new Error('fixture'));
    assert.equal(await replay,false);assert.equal(await flushed,false);assert.equal(returned,true);
    assert.equal(res.listenerCount('drain'),0);assert.equal(res.listenerCount('finish'),0);
    assert.equal(writer.pendingFrames,0);res.emit('error',new Error('late socket error'));
  }
});
test('drain deadline closes an indefinitely stalled connection', async () => {
  const res=new Response(),writer=new SseWriter(res,{drainTimeoutMs:10});res.backpressure=true;
  const done=writer.replay(['a','b']);
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(await done,false);assert.equal(res.destroyed,true);
});
test('throwing replay source or transport closes cleanly without unhandled rejection', async () => {
  const res=new Response(),writer=new SseWriter(res);
  assert.equal(await writer.replay((function*(){yield 'a';throw new Error('fixture');})()),false);
  const bad=new Response(),second=new SseWriter(bad);bad.write=()=>{throw Error('socket');};
  assert.equal(second.write('x'),false);assert.equal(second.closed,true);
});

test('a single oversized live record streams safely on fast and slow sockets', async () => {
  const text='data: '+ '中'.repeat(30000)+'😀\n\n';
  for(const slow of [false,true]) {
    const res=new Response(),writer=new SseWriter(res,{maxQueuedBytes:32768,batchWrites:2});
    res.backpressure=slow;
    assert.equal(writer.write(text),true);
    if(slow) {assert(res.writableLength<=32768);assert.equal(res.chunks.length,1);res.drain();}
    assert.equal(await writer.flush(),true);
    assert.equal(Buffer.concat(res.chunks.map(chunk=>Buffer.from(chunk))).toString(),text);
    writer.close();
  }
});

test('normal multi-tab reconnects do not hit a smaller hidden history-source cap', async () => {
  const res=new Response(),writer=new SseWriter(res);res.backpressure=true;
  const batches=Array.from({length:50},(_,i)=>writer.replay(['session-'+i]));
  assert.equal(writer.closed,false);res.drain();
  assert((await Promise.all(batches)).every(Boolean));
  assert.equal(res.chunks.join('|'),Array.from({length:50},(_,i)=>'session-'+i).join('|'));writer.close();
});
