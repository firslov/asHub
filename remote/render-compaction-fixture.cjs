const {env,Bridge,assert}=require('../tests/harness.cjs');
(async()=>{
 const e=env(),sessions=new Map();
 const hub=e.load('src/hub.ts','export const audit={createSession,synthesizeBranchFrames,shutdownHub};').audit;
 try{
  const session=await hub.createSession(sessions,{makeBridge:opts=>new Bridge(opts)},e.dir);
  session.bridge.messages=Array.from({length:6},(_,i)=>[
   {role:'user',content:i===0?'保留原始原则 '+ '历史原文 '.repeat(3000)+'<img src=x onerror=alert(1)>':`Question ${i}`},
   {role:'assistant',content:`Answer ${i}`},
  ]).flat();
  await session.capture.flush();const ids=session.store.buildBranchWithIds().entryIds;
  await session.store.appendCompaction(ids[8],10000,{version:1,sourceLeaf:session.store.getActiveLeaf(),mode:'semantic',
   memory:{state:{goal:[],open:[{text:'尚需验证',sourceIds:[ids[7]]}],next:[],blockers:[]},history:[]},
   diagnostics:{target:5000,estimatedAfter:4000,elapsedMs:1,inputTokens:1000,omittedRecords:0}});
  const view=session.store.buildBranchWithIds();
  const frames=hub.synthesizeBranchFrames(session,view.messages,view.entryIds).map(f=>JSON.parse(f.split('\n').find(l=>l.startsWith('data: ')).slice(6)));
  const marker=frames.find(f=>f.meta.name==='hub:compaction-marker');
  assert(marker?.payload.evictedCount===8,'new checkpoint must use the existing replay protocol');
  assert(marker.payload.summary.includes('尚需验证'),'working memory must survive replay');
  console.log('COMPACTION '+JSON.stringify({frames,summary:marker.payload.summary}));
 }finally{await hub.shutdownHub(undefined,sessions)}
})().catch(e=>{console.error(e);process.exitCode=1});
