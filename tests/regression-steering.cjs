const test=require('node:test'),assert=require('node:assert/strict');
const {ui}=require('./ui-harness.cjs');
const {env}=require('./harness.cjs');
test('busy desktop sends steer by default, permits queue selection and keeps stop when empty',async()=>{
 const u=ui(),composer=u.composer(),input=u.doc.getElementById('query'),button=u.doc.getElementById('send-btn'),mode=u.doc.getElementById('delivery-mode');
 u.active.value.state.isProcessing=true;input.value='Follow up';input.dispatchEvent({type:'input'});
 assert.equal(button.classList.contains('busy'),false);assert.equal(mode.hidden,false);assert.equal(mode.textContent,'delivery.steer');
 await composer.doSubmit('Follow up');let sent=u.calls.filter(c=>c.url==='/aaaaaa/submit');assert.equal(JSON.parse(sent.at(-1).opts.body).delivery,'steer');
 mode.dispatchEvent({type:'click'});await composer.doSubmit('Later');sent=u.calls.filter(c=>c.url==='/aaaaaa/submit');assert.equal(JSON.parse(sent.at(-1).opts.body).delivery,'queue');
 input.value='';input.dispatchEvent({type:'input'});assert.equal(button.classList.contains('busy'),true);
 u.active.value.state.isProcessing=false;await composer.doSubmit('Idle');sent=u.calls.filter(c=>c.url==='/aaaaaa/submit');assert.equal(JSON.parse(sent.at(-1).opts.body).delivery,undefined);
});
test('steer falls back to queued input during model preparation without cancelling the reserved turn',async()=>{
 const e=env(),Ash=e.load('src/bridges/ash.ts').AshBridge;const turn={};const b={pendingTurn:turn,preparingTurn:turn,queryQueue:[],queuedIds:[],assertOpen(){}};
 const result=await Ash.prototype.submit.call(b,'follow-up','id','steer');assert.equal(result.stopReason,'queued');assert.equal(b.pendingTurn,turn);assert.equal(b.queryQueue[0],'follow-up');
});

test('waiting indicators and continued replies stay before queued input in live and replay streams',()=>{
 const {Node}=require('./stream-dom.cjs');
 const document=new Node();document.createElement=tag=>new Node(tag);
 const e=env({globals:{document},modules:{'../i18n.js':{t:k=>k},'../utils.js':{escape:s=>String(s)}}});
 const {append,appendAfterPending,insertStreamNode}=e.load('web/js/stream/tool-group.js');
 for(const replaying of [false,true]){
  const stream=new Node(),fragment=new Node();
  const session={state:{replaying},streamEl:stream,_replayFrag:fragment,toolGroup:{},scroll:{stickToBottom:false}};
  const target=replaying?fragment:stream;
  const node=(cls,text)=>{const n=new Node();n.className=cls;n.textContent=text;return n;};
  const sep=node('turn-sep','timestamp'),pending=node('agent-box pending','later');
  appendAfterPending(session,sep);appendAfterPending(session,pending);
  insertStreamNode(session,node('thinking','waiting'));
  append(session,node('agent-reply','continued'));
  assert.deepEqual(target.children.map(n=>n.textContent),['continued','waiting','timestamp','later']);
  assert.equal(pending.previousElementSibling,sep,'pending timestamp stays paired');
  assert.equal((replaying?stream:fragment).children.length,0,'replay must remain batched');
 }
});
