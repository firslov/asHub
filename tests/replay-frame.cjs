const test=require('node:test'),assert=require('node:assert/strict');
const {replayEventName}=require('../dist/history/replay-frame.js');
test('metadata extraction handles quoted braces, nested metadata and legacy field order',()=>{
 for(const meta of [{name:'agent:query'}, {id:'a"}\\x',source:'}'} ,{name:'agent:tool-completed',nested:[{value:'escaped " brace }'}]}, {name:'x',id:'a'.repeat(5000)}]) {
  const payload={text:'large'.repeat(100000),meta:{name:'forged'}};
  for(const data of [{meta,payload},{payload,meta}]) for(const prefix of ['', 'id: 7\n']) {
   assert.equal(replayEventName(prefix+'data: '+JSON.stringify(data)+'\n\n'),meta.name||'');
  }
 }
});
test('unrelated payload names and malformed frames cannot invent an event name',()=>{
 for(const frame of ['',': connected\n\n','id: 1\ndata: invalid\n\n','data: {"payload":{"name":"agent:error"}}\n\n','data: {"meta":{"name":"agent:query"},"payload":\n\n'])assert.equal(replayEventName(frame),'');
});
