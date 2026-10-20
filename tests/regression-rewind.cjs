const {env,Res,req,Bridge,check,assert,results}=require('./harness.cjs');
const {EventEmitter}=require('node:events');
const {ui,El}=require('./ui-harness.cjs');
async function fixture(readOnly){
 const e=env(),h=e.load('src/hub.ts','export const audit={createSession,openSseMulti,rewindToTurn,shutdownHub};').audit,ss=new Map();
 const s=await h.createSession(ss,{makeBridge:o=>{const b=new Bridge(o);if(readOnly!==undefined)b.readOnlyContext=readOnly;return b;}},e.dir);
 s.bridge.messages=[{role:'user',content:'original query'},{role:'assistant',content:'reply'}];await s.capture.flush();
 const entryId=s.store.buildBranchWithIds().entryIds[0];
 if(readOnly==='unavailable'){s.bridge=null;s._ensureBridge=async()=>{throw Error('unavailable')};}
 const request=Object.assign(new EventEmitter(),{headers:{}}),res=new Res();
 await h.openSseMulti(request,res,ss,s.id+':all','');
 const frames=res.body.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
 const capabilities=frames.find(f=>f.meta.name==='hub:capabilities')?.payload;
 return {h,s,ss,entryId,capabilities,request};
}
function actions(){
 const u=ui(),texts=[],origin=u.active.peek();origin.resync=()=>{};
 u.modules['./composer.js']={setComposerTextForSession:(sid,text)=>texts.push({sid,text})};
 const m=u.e.load('web/js/actions.js','export const audit={rewindFromBox};').audit;
 const box=new El();box.dataset.entryId='entry';box._queryText='original query';
 return {...u,m,box,texts,origin};
}
(async()=>{
 for(const flag of [undefined,false,true,'unavailable'])await check('Rewind replay capabilities match bridge readOnly='+flag,async()=>{
  const x=await fixture(flag);
  try{
   assert(x.capabilities?.readOnlyContext===(flag===true||flag==='unavailable'),'writable bridge was advertised as read-only');
   if(flag!==true&&flag!=='unavailable'){const r=new Res();await x.h.rewindToTurn(req({entryId:x.entryId}),r,x.s);assert(r.statusCode===200&&r.json().stats&&x.s.bridge.messages.length===0,'stable entry rewind failed');}
  }finally{x.request.emit('close');await x.h.shutdownHub(undefined,x.ss);}
 });
 for(const [state,key] of [['isProcessing','rewind.busy'],['readOnlyContext','rewind.readonly']])await check('Rewind '+state+' gives feedback without changing history',async()=>{
  const u=actions();u.origin.state[state]=true;await u.m.rewindFromBox(u.box);
  assert(u.calls.length===0&&u.texts.length===0,'blocked action mutated session');
  assert(u.toasts.some(a=>a[0]===key),'blocked click was silent');
 });
 await check('Rewind restores the query to the originating composer',async()=>{
  const u=actions();u.e.context.fetch=async()=>({ok:true,json:async()=>({stats:{leafId:'root'}})});
  await u.m.rewindFromBox(u.box);assert(u.texts[0]?.text==='original query'&&u.texts[0]?.sid===u.origin.id);
 });
 console.log(JSON.stringify({checks:results.length,passed:results.filter(r=>r.passed).length}));
})();
