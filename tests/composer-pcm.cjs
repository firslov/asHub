const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
function processor(rate,limit){let Capture;const messages=[];const context={sampleRate:rate,AudioWorkletProcessor:class{constructor(){this.port={postMessage:m=>messages.push(m)};}},registerProcessor:(_,c)=>Capture=c};vm.runInNewContext(fs.readFileSync(path.join(root,'web/js/composer-pcm-worklet.js'),'utf8'),context);const capture=new Capture({processorOptions:{maxSamples:limit}});return{capture,messages};}
test('PCM worklet downmixes/resamples 44.1/48 kHz and produces bounded 16 kHz WAV',async()=>{
 const {wavBlob}=await import('../web/js/composer-pcm.js');
 for(const rate of [44100,48000]){
  const {capture,messages}=processor(rate,48000);capture.port.onmessage({data:'start'});
  for(let i=0;i<rate*3;i+=128){const block=new Float32Array(Math.min(128,rate*3-i)).fill(.5);capture.process([[block,block]]);}
  capture.port.onmessage({data:'stop'});const chunks=messages.filter(m=>m.type==='data').map(m=>m.buffer),samples=chunks.reduce((n,b)=>n+b.byteLength/2,0);
  assert.equal(samples,48000);assert.equal(messages.filter(m=>m.type==='limit').length,1);assert.equal(messages.at(-1).type,'stop');
  const wav=await wavBlob(chunks,samples).arrayBuffer(),v=new DataView(wav);assert.equal(wav.byteLength,96044);assert.equal(v.getUint32(24,true),16000);assert.equal(v.getUint16(22,true),1);assert.equal(v.getUint32(40,true),96000);assert.equal(v.getInt16(44,true),16384);
 }
 assert.equal(wavBlob([],0).size,0,'never disguise missing audio with a nonempty WAV header');
});
test('PCM worklet ignores pre-start/post-stop samples and respects a small size limit',()=>{
 const {capture,messages}=processor(48000,1600),block=new Float32Array(128).fill(-1);
 capture.process([[block]]);assert.equal(messages.length,0);capture.port.onmessage({data:'start'});
 for(let i=0;i<100;i++)capture.process([[block]]);capture.port.onmessage({data:'stop'});const count=messages.length;
 capture.process([[block]]);assert.equal(messages.length,count);const chunks=messages.filter(m=>m.type==='data');assert.equal(chunks.reduce((n,m)=>n+m.buffer.byteLength,0),3200);assert.equal(new Int16Array(chunks[0].buffer)[0],-32768);
});
test('audio readiness follows running state, ignores late resume, and aborts immediately',async()=>{
 const {waitForAudioRunning}=await import('../web/js/composer-pcm.js');
 class Context extends EventTarget{state='suspended';calls=0;resume(){this.calls++;return new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});}set(state){this.state=state;this.dispatchEvent(new Event('statechange'));}}
 const running=new Context();running.state='running';await waitForAudioRunning(running,new AbortController().signal);assert.equal(running.calls,0,'do not resume an already running engine');
 const c=new Context(),controller=new AbortController(),ready=waitForAudioRunning(c,controller.signal);c.set('interrupted');c.set('running');await ready;c.reject(Error('late resume error'));await new Promise(r=>setImmediate(r));
 const cancelled=new Context(),stop=new AbortController(),pending=waitForAudioRunning(cancelled,stop.signal);stop.abort();await assert.rejects(pending,{name:'AbortError'});cancelled.set('running');cancelled.resolve();
 const closed=new Context(),closing=waitForAudioRunning(closed,new AbortController().signal);closed.set('closed');await assert.rejects(closing,/录音已关闭/);closed.resolve();
});
