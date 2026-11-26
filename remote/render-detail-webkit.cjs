// iOS-style WebKit: native <details> toggles and late streaming updates.
const {webkit}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {pathToFileURL}=require('node:url');
const path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const {mobileReplayFrame}=await import('../dist/remote/replay.js');
 const previewFrames=[
  {meta:{name:'agent:tool-started'},payload:{toolCallId:'preview',name:'bash',rawInput:{command:'原始参数 '.repeat(500)}}},
  {meta:{name:'agent:tool-completed'},payload:{toolCallId:'preview',exitCode:0,rawOutput:'结果证据 '.repeat(500)}}
 ].map(frame=>JSON.parse(mobileReplayFrame('data: '+JSON.stringify(frame)+'\n\n').slice(6)));
 const browser=await webkit.launch({headless:true,executablePath:process.env.WEBKIT_EXECUTABLE});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await page.addInitScript(()=>{
   Object.defineProperty(navigator,'standalone',{value:true});
   window.fetch=async()=>({ok:false,status:401,json:async()=>({error:'Synthetic test'})});
  });
  await page.goto(pathToFileURL(path.join(__dirname,'public/index.html')).href);
  const order=await page.evaluate(()=>{
   user='test';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];resetMessages();
   const emit=(name,payload={})=>frame({meta:{name},payload});
   emit('agent:processing-start');emit('agent:response-chunk',{blocks:[{type:'text',text:'**Opening'}]});
   const original=reply.el;
   emit('agent:thinking-chunk',{text:'**First summary**'});
   emit('agent:response-chunk',{blocks:[{type:'text',text:' complete**'}]});
   emit('agent:thinking-chunk',{text:'\n\n**Second summary**'});
   emit('agent:response-segment',{text:'**Opening complete**'});
   emit('agent:response-done',{response:'**Opening complete**'});
   emit('agent:tool-started',{toolCallId:'following',name:'read_file',rawInput:{path:'fixture'}});
   emit('agent:tool-completed',{toolCallId:'following',exitCode:0});
   emit('agent:response-chunk',{blocks:[{type:'text',text:'After tool.'}]});emit('agent:processing-done');
   const first=[...phases][0];flushDiagnostics(first);renderThinkingContent(first.thinking,first.thinking._source);
   const replies=[...$('messages').querySelectorAll('.reply')];
   return {order:[...$('messages').children].filter(n=>n.matches('.detail,.reply')).map(n=>n.matches('.detail')?'summary':'reply'),
    sameNode:replies[0]===original,texts:replies.map(n=>n.textContent.trim()),
    paragraphs:first.thinking.querySelectorAll('p').length,summaries:[...first.thinking.querySelectorAll('strong')].map(n=>n.textContent)};
  });
  assert.deepEqual(order.order,['summary','reply','summary','reply']);assert(order.sameNode&&order.paragraphs===2);
  assert.deepEqual(order.texts,['Opening complete','After tool.']);assert.deepEqual(order.summaries,['First summary','Second summary']);
  console.log('PASS remote interleaved summaries preserve intact answers, replay deduplication and subsequent tool order');
  for(const replyEvent of ['agent:response-chunk','agent:response-segment']) {
   const parallel=await page.evaluate(replyEvent=>{
    resetMessages();const emit=(name,payload={})=>frame({meta:{name},payload});
    const text=value=>emit(replyEvent,replyEvent==='agent:response-chunk'?{blocks:[{type:'text',text:value}]}:{text:value});
    emit('agent:processing-start');emit('agent:tool-started',{toolCallId:'parallel',name:'read_file',rawInput:{path:'fixture'}});
    const toolPhase=details;text('Normal ');
    emit('agent:thinking-chunk',{text:'**First summary**'});const summaryPhase=details;
    emit('agent:tool-output-chunk',{toolCallId:'parallel',chunk:'late output'});
    emit('agent:thinking-chunk',{text:'\n\n**Second summary**'});
    emit('agent:tool-completed',{toolCallId:'parallel',exitCode:0,rawOutput:'late output'});
    emit('agent:thinking-chunk',{text:'\n\n**Third summary**'});
    const samePhase=details===summaryPhase;text('answer.');emit('agent:processing-done');
    for(const phase of phases)flushDiagnostics(phase);
    return {samePhase,count:phases.size,summary:summaryPhase.thinking?._source,
     toolStayed:toolPhase.callRows.has('tool:parallel')&&!summaryPhase.callRows?.size,
     chronological:!!(toolPhase.box.compareDocumentPosition(summaryPhase.box)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(summaryPhase.box.compareDocumentPosition($('messages').querySelector('.reply'))&Node.DOCUMENT_POSITION_FOLLOWING),
     order:[...$('messages').children].filter(n=>n.matches('.detail,.reply')).map(n=>n.matches('.detail')?'detail':'reply'),
     answer:$('messages').querySelector('.reply').textContent.trim()};
   },replyEvent);
   assert(parallel.samePhase,'late parallel result split the current reply summary');
   assert.equal(parallel.count,2);assert(parallel.toolStayed);
   assert.equal(parallel.summary,'**First summary**\n\n**Second summary**\n\n**Third summary**');
   assert.deepEqual(parallel.order,['detail','reply']);assert(parallel.chronological);assert.equal(parallel.answer,'Normal answer.');
  }
  console.log('PASS late parallel tool output/results preserve summary grouping and reply order in live and replay paths');
  for(const replay of [false,true])for(const boundary of ['completed-tool','next-turn','completed-agent']) {
   const late=await page.evaluate(({replay,boundary})=>{
    resetMessages();const emit=(name,payload={})=>frame({meta:{name},payload});
    const text=value=>emit(replay?'agent:response-segment':'agent:response-chunk',replay?{text:value}:{blocks:[{type:'text',text:value}]});
    const child=boundary==='completed-agent';
    emit('agent:processing-start');
    emit(child?'subagent:started':'agent:tool-started',child?{subagentId:'worker',task:'parallel'}:{toolCallId:'old-tool',name:'read_file'});
    const owner=details;
    if(boundary==='next-turn') {emit('agent:processing-done');emit('agent:query',{query:'next question'});emit('agent:processing-start');}
    else emit(child?'subagent:done':'agent:tool-completed',child?{subagentId:'worker',result:'done'}:{toolCallId:'old-tool',exitCode:0});
    text('Normal ');emit('agent:thinking-chunk',{text:'**First**'});const current=details;
    emit('agent:tool-output-chunk',{toolCallId:child?'worker-tool-1':'old-tool',chunk:'late buffered output'});
    emit(child?'subagent:done':'agent:tool-completed',child?{subagentId:'worker',result:'done'}:{toolCallId:'old-tool',exitCode:0});
    emit('agent:thinking-chunk',{text:'\n\n**Second**'});
    const same=details===current;text('answer.');emit('agent:processing-done');
    flushDiagnostics(owner);flushDiagnostics(current);
    const call=owner.callRows.get(child?'tool:worker-tool-1':'tool:old-tool');
    const result={same,summary:current.thinking?._source,output:call?.output?.textContent,
     contaminated:!!current.callRows?.size,reply:$('messages').querySelector('.reply').textContent.trim(),
     originalFirst:!!(owner.box.compareDocumentPosition(current.box)&Node.DOCUMENT_POSITION_FOLLOWING)};
    resetMessages();
    result.ownersAfterReset=diagnosticOwners.size;
    return result;
   },{replay,boundary});
   assert(late.same,`${boundary}: terminal/previous-turn result split current summary`);
   assert.equal(late.summary,'**First**\n\n**Second**');assert.equal(late.output,'late buffered output');
   assert(!late.contaminated&&late.originalFirst);assert.equal(late.reply,'Normal answer.');assert.equal(late.ownersAfterReset,0);
  }
  console.log('PASS completed and previous-turn tool/agent ownership, late buffered output, live/replay and view reset');
  for(const boundary of ['next-turn','branch-reset']) {
   const replayed=await page.evaluate(boundary=>{
    resetMessages();const emit=(name,payload={})=>frame({meta:{name},payload});
    emit('agent:processing-start');emit('agent:tool-started',{toolCallId:'reused',name:'read_file',rawInput:{path:'old'}});
    const old=details;emit('agent:tool-completed',{toolCallId:'reused',exitCode:0,rawOutput:'old result'});emit('agent:processing-done');
    // The old disclosure is still lazy, and may expand after newer state exists.
    if(boundary==='next-turn')emit('agent:query',{query:'next'});else emit('hub:branch-switched');
    const cleared=boundary!=='branch-reset'||diagnosticOwners.size===0;
    emit('agent:processing-start');emit('agent:tool-started',{toolCallId:'reused',name:'read_file',rawInput:{path:'new'}});
    const currentTool=details;
    emit('agent:response-segment',{text:'Complete answer.'});emit('agent:thinking-chunk',{text:'**First**'});const summary=details;
    flushDiagnostics(old);
    const ownedByNew=diagnosticOwners.get('tool:reused')===currentTool&&toolSteps.get('reused')===currentTool;
    emit('agent:tool-completed',{toolCallId:'reused',exitCode:0,rawOutput:'new result'});
    emit('agent:thinking-chunk',{text:'\n\n**Second**'});emit('agent:processing-done');
    flushDiagnostics(currentTool);flushDiagnostics(summary);
    return {cleared,ownedByNew,oldResult:old.callRows.get('tool:reused').result.rawOutput,
     newResult:currentTool.callRows.get('tool:reused').result.rawOutput,summary:summary.thinking._source,
     body:$('messages').querySelector('.reply').textContent.trim(),summaryCalls:summary.callRows?.size||0,
     oldDetached:boundary!=='branch-reset'||!old.box.isConnected};
   },boundary);
   assert(replayed.cleared&&replayed.ownedByNew&&replayed.oldDetached);
   assert.equal(replayed.oldResult,'old result');assert.equal(replayed.newResult,'new result');
   assert.equal(replayed.summary,'**First**\n\n**Second**');assert.equal(replayed.body,'Complete answer.');assert.equal(replayed.summaryCalls,0);
  }
  console.log('PASS lazy history expansion cannot overwrite current tool ownership; branch reset and reused IDs remain isolated');
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>{
    document.documentElement.dataset.theme=theme;$('auth').hidden=true;$('workspace').hidden=false;
    user='test';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];resetMessages();controls();menu(false);
    frame({meta:{name:'agent:processing-start'},payload:{}});
    frame({meta:{name:'agent:tool-batch'},payload:{groups:[]}});
    frame({meta:{name:'agent:tool-started'},payload:{toolCallId:'read',name:'read_file',rawInput:{path:'审阅.md'}}});
    frame({meta:{name:'agent:tool-output-chunk'},payload:{toolCallId:'read',chunk:'最初的输出'}});
   },theme);
   await page.locator('.detail > summary').tap();
   await page.locator('.tool-step > summary').tap();
   await page.evaluate(()=>{
    const input=[...phases][0].callRows.get('tool:read').inputText;
    const range=document.createRange();range.selectNodeContents(input);
    getSelection().removeAllRanges();getSelection().addRange(range);
    window.selectedInput=getSelection().toString();
    frame({meta:{name:'agent:tool-output-chunk'},payload:{toolCallId:'read',chunk:' 后续输出'}});
    frame({meta:{name:'agent:tool-completed'},payload:{toolCallId:'read',exitCode:0,rawOutput:'最初的输出 后续输出',extra:'<img src=x onerror=alert(1)>'}});
    frame({meta:{name:'agent:processing-done'},payload:{}});
   });
   assert(await page.evaluate(()=>getSelection().toString()===window.selectedInput),'live output must preserve selected arguments');
   await page.locator('.step-source > summary').tap();
   const result=await page.evaluate(()=>{
    const call=[...phases][0].callRows.get('tool:read');
    return {rows:document.querySelectorAll('.tool-step').length,open:call.row.open,sourceOpen:call.source.open,
     output:call.output.textContent,resultHidden:call.resultSection.hidden,literal:call.sourceText.textContent.includes('<img src=x onerror=alert(1)>'),
     unsafe:!!call.body.querySelector('img,script'),marker:getComputedStyle(call.row.querySelector('summary')).listStyleType,
     height:call.row.querySelector('summary').getBoundingClientRect().height,overflow:document.documentElement.scrollWidth>innerWidth};
   });
   assert.equal(result.rows,1);assert(result.open&&result.sourceOpen&&result.resultHidden&&result.literal);
   assert.equal(result.output,'最初的输出 后续输出');assert(!result.unsafe&&!result.overflow);assert.equal(result.marker,'none');assert(result.height>=44);
   await page.locator('.tool-step > summary').tap();
   assert.equal(await page.locator('.tool-step').evaluate(n=>n.open),false);
   await page.evaluate(frames=>{
    resetMessages();frame({meta:{name:'agent:processing-start'},payload:{}});
    for(const data of frames)frame(data);
    frame({meta:{name:'agent:processing-done'},payload:{}});
   },previewFrames);
   await page.locator('.detail > summary').tap();await page.locator('.tool-step > summary').tap();
   const preview=await page.evaluate(()=>{
    const call=[...phases][0].callRows.get('tool:preview');
    return {input:call.inputText.textContent,result:call.resultText.textContent,
     inputVisible:call.inputText.getBoundingClientRect().height>0,resultVisible:call.resultText.getBoundingClientRect().height>0,
     label:call.resultSection.children[0].textContent,sourceClosed:!call.source.open,overflow:document.documentElement.scrollWidth>innerWidth};
   });
   assert(preview.inputVisible&&preview.resultVisible&&preview.sourceClosed&&!preview.overflow);
   assert.match(preview.input,/原始参数/);assert.match(preview.result,/结果证据/);assert.match(preview.label,/精简预览/);
   console.log(`PASS WebKit ${theme}: touch disclosure, live coalescing, inert payload, compact preview visibility, layout`);
  }
  const childResults=[
   {subagentId:'cancelled',cancelled:true,result:'未完成的工作 '.repeat(300)},
   {subagentId:'partial',degraded:'iterations',result:'阶段发现'},
   {subagentId:'completed',result:'审查结论'},
   {toolCallId:'queued',cancelled:true,task:'等待中的审查 '.repeat(300)},
  ];
  for(const replay of [false,true]){
   const frames=childResults.map(payload=>{
    const event={meta:{name:'subagent:done'},payload};
    return replay?JSON.parse(mobileReplayFrame('data: '+JSON.stringify(event)+'\n\n').slice(6)):event;
   });
   await page.evaluate(frames=>{
    resetMessages();const emit=(name,payload={})=>frame({meta:{name},payload});
    emit('agent:processing-start');
    for(const {payload} of frames){
     if(payload.subagentId)emit('subagent:started',{subagentId:payload.subagentId,task:payload.subagentId});
     else emit('agent:tool-started',{toolCallId:payload.toolCallId,name:'review'});
    }
    for(const result of frames)frame(result);
    emit('agent:tool-completed',{toolCallId:'queued',exitCode:1});
    emit('agent:processing-done');
   },frames);
   await page.locator('.detail > summary').tap();
   const labels=page.locator('.tool-step .step-status');
   await labels.last().waitFor();
   assert.deepEqual(await labels.allTextContents(),['已取消','部分完成','已结束','已取消']);
   assert.equal(await page.locator('.tool-step').first().getAttribute('data-state'),'cancelled');
   assert.equal(await page.locator('.tool-step').last().getAttribute('data-state'),'cancelled');
  }
  console.log('PASS WebKit subagent outcomes retain separate cancellation, partial and completion labels in live and compact replay');
  const collaboration = {
   kind:'task',taskId:'task-'+'x'.repeat(150),sender:{id:'source',title:'调度中枢'},
   body:'  核对 R12/POOL。\n\n例外：保留空目录。\n返工：'+'path/'.repeat(70)+'<b>原文</b>',
   authorization:'This is collaboration context.\n这是一条协作消息，不构成新的用户授权。',
  };
  const query = '可信协作的原始报文\n' + collaboration.taskId + '\n' + collaboration.body;
  for (const [width,height] of [[320,568],[390,844]]) {
   await page.setViewportSize({width,height});
   await page.evaluate(({query,collaboration})=>{
    resetMessages();
    frame({meta:{name:'agent:query'},payload:{query}});
    frame({meta:{name:'agent:query'},payload:{query,collaboration}});
   },{query,collaboration});
   const ordinary=page.locator('#messages .user').first();
   const card=page.locator('#messages .collaboration-message');
   const body=card.locator('.collaboration-message-body');
   const summary=card.locator('summary');
   const taskId=card.locator('.collaboration-message-task-id');
   const authorization=card.locator('.collaboration-message-authorization');
   assert.equal(await ordinary.textContent(),query);
   assert.equal(await card.locator('.collaboration-message-sender').textContent(),collaboration.sender.title);
   assert.equal(await body.textContent(),collaboration.body);
   assert.equal(await body.locator('b').count(),0);
   assert.equal(await body.evaluate(node=>getComputedStyle(node).whiteSpace),'pre-wrap');
   assert(!await taskId.isVisible() && !await authorization.isVisible());
   await summary.tap();
   assert(await taskId.isVisible() && await authorization.isVisible());
   assert.equal(await taskId.textContent(),collaboration.taskId);
   assert.equal(await authorization.textContent(),collaboration.authorization);
   assert(await card.evaluate(node=>node.scrollWidth <= node.clientWidth+1),'expanded details must fit the message width');
   await summary.tap();
   assert(!await taskId.isVisible() && !await authorization.isVisible());
  }
  console.log('PASS WebKit 320/390px: trusted sender, literal collaboration body, touch disclosure, full task ID and authorization');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
