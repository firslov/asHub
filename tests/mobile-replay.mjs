import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileReplayFrame, mobileReplayStart } from '../dist/remote/replay.js';
const frame = (name, payload) => `id: 5\ndata: ${JSON.stringify({meta:{name,source:'aaaa'},payload})}\n\n`;
test('mobile replay starts at complete turns and preserves answers and approvals', () => {
  const frames=[];
  for(let i=0;i<100;i++) frames.push(frame('agent:query',{query:`question ${i}`}),frame('agent:tool-completed',{toolCallId:'a',output:'🟡'.repeat(20000)}),frame('agent:response-segment',{text:`answer ${i}`}),frame('agent:processing-done',{}));
  const original=frames.join(''); const start=mobileReplayStart(frames);
  assert.equal(start, 88*4);
  const selected=frames.slice(start).map(mobileReplayFrame);
  assert(selected[0].includes('question 88'));assert(selected.at(-2).includes('answer 99'));
  assert(selected[1].includes('detailsOmitted')); assert.equal(JSON.parse(selected[1].split('data: ')[1]).payload.text.isWellFormed(),true);
  assert(original.length/selected.join('').length>100);
  console.log(`Mobile fixture: ${Buffer.byteLength(original)} -> ${Buffer.byteLength(selected.join(''))} bytes (${100} -> ${12} turns)`);
  for(const name of ['agent:error','ui:error','permission:request','agent:response-segment','agent:query','agent:todo']){
    const raw=frame(name,{text:'full content'.repeat(2000)});assert.equal(mobileReplayFrame(raw),raw);
  }
  assert.equal(frames.join(''),original,'stored replay must remain unchanged');
});
test('short histories and command queries do not cut away the active turn', () => {
  assert.equal(mobileReplayStart([]),0);
  const frames=[frame('agent:query',{query:'start'})];
  for(let i=0;i<30;i++)frames.push(frame('agent:query',{query:'/model',command:true}));
  assert.equal(mobileReplayStart(frames),0);
});


test('large collaborator records preserve identifiers used to pair start and completion',()=>{
  for(const name of ['subagent:started','subagent:done']) {
    const raw=frame(name,{subagentId:'reviewer-1',task:'Review',result:'🟡'.repeat(4000)});
    const preview=mobileReplayFrame(raw),data=JSON.parse(preview.split('data: ')[1]);
    assert.equal(data.payload.subagentId,'reviewer-1');assert.equal(data.payload.detailsOmitted,true);
    assert.equal(data.payload.text.isWellFormed(),true);assert(preview.length<1800);
    assert(raw.includes('🟡'.repeat(4000)),'stored source remains untouched');
  }
});
