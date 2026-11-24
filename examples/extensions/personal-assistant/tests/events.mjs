import assert from 'node:assert/strict';
import test from 'node:test';
import { eventSpans, eventTerms, segmentEvents } from '../events.mjs';

const rows=(text,roles)=>text.map((text,i)=>({id:'m'+i,previousId:i?'m'+(i-1):null,
  role:roles?.[i]??(i%2===0?'user':'assistant'),text,at:i+1}));

test('the six-segment event cap retains a genuine leading question as read-only context',()=>{
  const input=rows(['报告分三段','了解。','报告还要简短','明白。','报告用我的姓名署名','您的签名保存为哪个名字？','陈岚']);
  const events=eventSpans(segmentEvents(input));
  assert(events.every(parts=>parts.length<=6));
  assert.deepEqual(events.at(-1).map(row=>[row.id,!!row.context]),[['m5',true],['m6',false]]);
});

test('event offsets trace one long multipart topic and never bridge a generated or missing record',()=>{
  const long='背景🚀'.repeat(680)+'。另外，采购单 PX-1842 的复核人是陈岚。';
  const input=rows([long,'您汇报需要署名吗？','[插件任务] 闯入','陈岚'],['user','assistant','generated','user']);
  input[0].offset=3000;
  const events=eventSpans(segmentEvents(input));
  assert.equal(events.length,3);
  const longSpans=events.flat().filter(row=>row.id==='m0');
  assert.equal(longSpans[0].start,3000);
  assert.equal(long.slice(longSpans[1].start-3000,longSpans[1].end-3000),'另外，采购单 PX-1842 的复核人是陈岚。');
  assert.deepEqual(events.at(-1).map(row=>row.id),['m3']);
  assert(eventTerms('采购单 PX-1842 的复核人是陈岚').has('px-1842'));
  assert(eventTerms('采购单 PX-1842 的复核人是陈岚').has('陈岚'));
  const separated=input.filter(row=>row.id!=='m2');
  assert.deepEqual(eventSpans(segmentEvents(separated)).at(-1).map(row=>row.id),['m3']);
});
