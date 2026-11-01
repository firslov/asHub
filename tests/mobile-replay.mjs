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

test('mobile preview counts tasks rather than mid-task follow-ups',()=>{
 const frames=[];const starts=[];
 for(let turn=0;turn<14;turn++){
  starts.push(frames.length);
  frames.push(frame('agent:query',{query:`task ${turn}`}),frame('agent:processing-start',{}),
   frame('agent:todo',{todos:[{title:`plan ${turn}`,status:'in_progress'}]}),
   frame('subagent:started',{subagentId:`child-${turn}`,task:'Review'}));
  for(let i=0;i<15;i++)frames.push(frame('agent:query',{query:`detail ${i}`,steering:true}),frame('agent:response-segment',{text:'continued'}));
  if(turn<13)frames.push(frame('agent:processing-done',{}));
 }
 assert.equal(mobileReplayStart(frames),starts[2],'the last 12 tasks must include their initial plans and lifecycle');
 assert.equal(mobileReplayStart(frames,1),starts[13],'an active task must not begin at a follow-up');
 const active=frames.slice(starts[13]);assert.equal(mobileReplayStart(active),0);
});

test('diagnostic previews preserve the same result semantics as complete events', async () => {
  const { default: cases } = await import('./fixtures/conversation-events.cjs');
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const context = {};
  runInNewContext(readFileSync(new URL('../web/js/conversation-presentation.js', import.meta.url), 'utf8'), context);
  const { diagnosticState } = context.AsHubConversationPresentation;
  for (const c of cases) for (const name of ['agent:tool-completed', 'subagent:done']) {
    const payload = { toolCallId: 'tool-1', subagentId: 'child-1', swarmId: 'swarm-1',
      task: 'Review evidence', rawOutput: 'Large diagnostics '.repeat(400), ...c.payload };
    const original = frame(name, payload), projected = JSON.parse(mobileReplayFrame(original).split('data: ')[1]).payload;
    assert.equal(diagnosticState(projected), c.outcome, name + ': ' + c.name);
    assert.equal(diagnosticState(payload), c.outcome);
    assert.equal(projected.subagentId, payload.subagentId);
    assert.equal(projected.toolCallId, payload.toolCallId);
    assert.equal(projected.swarmId, payload.swarmId);
    assert.equal(projected.degraded, payload.degraded);
    assert.equal(projected.detailsOmitted, true);
    assert.equal(original, frame(name, payload), 'preview does not mutate persisted history');
    assert(mobileReplayFrame(original).length < 1900);
  }
  const payload = { error: '🟡'.repeat(5000), result: 'details'.repeat(1000) };
  const projected = JSON.parse(mobileReplayFrame(frame('subagent:done', payload)).split('data: ')[1]).payload;
  assert.equal(diagnosticState(projected), 'failed');
  assert.equal(projected.error.isWellFormed(), true);
  assert(projected.error.length <= 240, 'error details must remain bounded');
});
