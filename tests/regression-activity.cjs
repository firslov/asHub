const {env,check,assert,results,ts,vm,fs,path,root}=require('./harness.cjs');
const {Node}=require('./stream-dom.cjs');
function fixture(){
 const document=new Node();document.createElement=tag=>new Node(tag);let lang='en';
 const e=env({modules:{'../utils.js':{escape:s=>String(s??'')},'../i18n.js':{t:(k,p)=>lang+':'+k+(p?.n??'')}},globals:{document}});
 const activity=e.load('web/js/stream/activity.js'),groups=e.load('web/js/stream/tool-group.js');
 const session={streamEl:new Node(),state:{replaying:true},toolGroup:{},scroll:{stickToBottom:true}};
 document.append(session.streamEl);activity.resetActivity(session);
 const node=(cls,text='')=>{const n=new Node();n.className=cls;n.textContent=text;return n};
 function tool(name='read',s=session){const row=node('tool-row',name+' technical arguments');row.dataset.toolName=name;groups.appendToGroup(s,row);groups.bumpToolCount(s);return row;}
 const box=()=>session.streamEl.querySelector('.execution-activity');
 const finish=(name='agent:processing-done')=>{groups.closeToolGroup(session);activity.activityEvent(session,name)};
 return {e,activity,groups,session,document,node,tool,box,finish,lang(){lang='zh';document.dispatchEvent({type:'langchange'});}};
}
function sseHandler(x,name){
 const sf=ts.createSourceFile('sse.js',fs.readFileSync(path.join(root,'web/js/sse.js'),'utf8'),ts.ScriptTarget.Latest,true);
 let method;function walk(n){if(ts.isMethodDeclaration(n)&&n.name?.text===name)method=n;ts.forEachChild(n,walk);}walk(sf);
 return vm.runInContext('({'+method.getText(sf)+'})['+JSON.stringify(name)+']',x.e.context);
}
function completionFixture(){
 const x=fixture();
 Object.assign(x.e.context,{refreshActivity:x.activity.refreshActivity,renderToolBody:lines=>x.node('tool-body',lines.join('\n')),t:k=>'en:'+k});
 const complete=sseHandler(x,'agent:tool-completed');
 function launch(id){
  const block=x.node('subagent-block'),head=x.node('subagent-head'),spinner=x.node('subagent-spinner'),icon=x.node('subagent-icon','initial'),result=x.node('subagent-result');
  head.append(icon,spinner);result.hidden=true;block.append(head,result);block.dataset.callId=id;
  x.groups.insertStreamNode(x.session,block);(x.session._saBlocksByCallId??=new Map()).set(id,block);
  return {block,head,spinner,icon,result};
 }
 return {...x,launch,complete:p=>complete.call(x.session,p)};
}
function swarmFixture(){
 const x=completionFixture();
 // The swarm templates contain nested div/span elements; retain their tree.
 class HtmlNode extends Node {
  set innerHTML(html){
   this.textContent='';const stack=[this];
   for(const token of html.matchAll(/<\/([\w-]+)>|<([\w-]+)([^>]*)>|([^<]+)/g)){
    if(token[1]){stack.pop();continue;}
    if(token[2]){const child=new HtmlNode(token[2]);child.className=/class="([^"]*)"/.exec(token[3])?.[1]??'';stack.at(-1).append(child);stack.push(child);}
    else if(token[4])stack.at(-1)._text+=token[4];
   }
  }
 }
 x.document.createElement=tag=>new HtmlNode(tag);
 Object.assign(x.e.context,{readSwarmOutcome:x.e.load('web/js/stream/swarm-result.js').readSwarmOutcome,insertStreamNode:x.groups.insertStreamNode,escape:s=>String(s),t:(k,p)=>'en:'+k+(p?.n??''),closeReply(){},closeToolGroup:x.groups.closeToolGroup,finalizeThinking(){},startNewSegment(){},TODO_TOOL_NAME:'todolist',SWARM_TOOL_NAME:'agentswarm'});
 const start=sseHandler(x,'agent:tool-started');
 const {synthesizeBranchFrames}=x.e.load('src/hub.ts','export {synthesizeBranchFrames};');
 function rebuild(output,items=['a','b']){
  x.session._replayFrag=new Node();
  const frames=synthesizeBranchFrames({id:'test'},[
   {role:'user',content:'Review files'},
   {role:'assistant',content:'',tool_calls:[{id:'swarm-call',function:{name:'agentswarm',arguments:JSON.stringify({items})}}]},
   {role:'tool',tool_call_id:'swarm-call',content:output},
  ]);
  for(const frame of frames){
   const f=JSON.parse(frame.split('\n').find(l=>l.startsWith('data: ')).slice(6));
   if(f.meta.name==='agent:tool-started')start.call(x.session,f.payload);
   if(f.meta.name==='agent:tool-completed')x.complete(f.payload);
   x.activity.activityEvent(x.session,f.meta.name);
  }
  for(const n of [...x.session._replayFrag.children])x.session.streamEl.append(n);
  x.session._replayFrag=null;
 }
 return {...x,rebuild};
}
async function runSwarmTool(x,items,entries){
 const sf=ts.createSourceFile('ash.ts',fs.readFileSync(path.join(root,'src/bridges/ash.ts'),'utf8'),ts.ScriptTarget.Latest,true);
 let execute;function walk(n){
  if(ts.isObjectLiteralExpression(n)&&n.properties.some(p=>p.name?.text==='name'&&p.initializer?.text==='agentswarm'))execute=n.properties.find(p=>p.name?.text==='execute');
  ts.forEachChild(n,walk);
 }walk(sf);assert(execute,'swarm tool missing');
 const agents=new Map(),events=[];let next=0;
 Object.assign(x.e.context,x.e.load('src/unicode.ts'),{
  core:{bus:{emit:(name,payload)=>events.push({name,payload})}},extCtx:{agent:{getTools:()=>[]}},
  getSettings:()=>({}),getSubagentBudgetOverrides:()=>({}),resolveSubagentReasoningParams:()=>({}),
  SUBAGENT_TYPES:{explore:{tools:[]}},SUBAGENT_TOOL_NAMES:new Set(),MAX_CONCURRENT_SUBAGENTS:4,
  _swarmSeq:0,_runningSubagents:0,_subagents:agents,
  launchSubagent:()=>{const id='sa'+next;agents.set(id,{...entries[next++],promise:Promise.resolve()});return id;},
 });
 const js=ts.transpileModule('({'+execute.getText(sf)+'}).execute',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const result=await vm.runInContext(js,x.e.context)({prompt_template:'Review {{item}}',items});
 return {result,events};
}
(async()=>{
 for (const replaying of [false,true]) await check('Activity replaces idle thinking across reply boundaries (replay='+replaying+')',()=>{
  const x=fixture(),s=x.session,think=x.e.load('web/js/stream/thinking.js');
  s.thinking={};s.state.replaying=replaying;
  if(replaying)s._replayFrag=new Node();
  const root=s._replayFrag||s.streamEl;
  think.showThinking(s);
  assert(root.querySelectorAll('.thinking').length===1,'initial waiting indicator missing');
  const reply=x.node('agent-reply','I will check the directory first.');x.groups.append(s,reply);
  x.tool();
  assert(root.querySelectorAll('.thinking').length===0,'idle indicator survived beside activity progress');
  assert(s.thinking.el===null,'stale thinking reference retained');
  assert(root.querySelectorAll('.execution-activity').length===1&&reply.parentNode===root);
  // Switching away/back remounts replayed nodes; it must not resurrect idle dots.
  if(replaying){for(const n of [...root.children])s.streamEl.append(n);s._replayFrag=null;s.state.replaying=false;}
  think.sweepOrphanThinking(s);
  assert(s.streamEl.querySelectorAll('.thinking').length===0);
  x.finish();x.activity.activityEvent(s,'agent:processing-start');think.showThinking(s);
  assert(s.streamEl.querySelectorAll('.thinking').length===1,'next turn lost its waiting indicator');
 });
 await check('Activity hides even one running tool without losing its arguments',()=>{
  const x=fixture(),row=x.tool(),box=x.box();
  assert(box.querySelector('.execution-activity-body').hidden,'tool details visible by default');
  assert(box.querySelector('.execution-activity-label').textContent==='en:activity.reading');
  assert(box.dataset.state==='running'&&box.querySelector('.tool-row')===row,'tool moved or state lost');
  const head=box.querySelector('.execution-activity-head');assert(head.tagName==='BUTTON'&&head.attrs['aria-expanded']==='false');
  head.click();assert(!box.querySelector('.execution-activity-body').hidden&&head.attrs['aria-expanded']==='true');
 });
 await check('Activity merges consecutive thoughts and tools while preserving manual disclosure',()=>{
  const x=fixture(),thought=x.node('thinking-block','full reasoning');thought.dataset.activityDone='1';x.groups.append(x.session,thought);const row=x.tool();
  const box=x.box(),head=box.querySelector('.execution-activity-head');head.click();
  x.groups.closeToolGroup(x.session);const next=x.node('thinking-block','next reasoning');next.dataset.activityDone='1';x.groups.append(x.session,next);row.classList.add('ok');x.finish();
  assert(x.session.streamEl.children.length===1&&box.querySelectorAll('.thinking-block').length===2);
  assert(!box.querySelector('.execution-activity-body').hidden&&box.dataset.state==='settled','completion changed manual disclosure');
 });
 await check('Activity replies and plans stay outside the technical disclosure',()=>{
  const x=fixture(),row=x.tool();row.classList.add('ok');const reply=x.node('agent-reply','important answer');x.groups.append(x.session,reply);
  const plan=x.node('todo-block','important plan');x.groups.insertStreamNode(x.session,plan);const row2=x.tool('write');
  assert(reply.parentNode===x.session.streamEl&&plan.parentNode===x.session.streamEl);
  assert(x.session.streamEl.querySelectorAll('.execution-activity').length===2&&row.closest('.execution-activity')!==row2.closest('.execution-activity'));
 });
 await check('Activity permission stays visible and pauses the animation until resolved',()=>{
  const x=fixture();x.tool();const card=x.node('permission-card');x.groups.append(x.session,card);x.activity.activityEvent(x.session,'permission:request');
  assert(card.parentNode===x.session.streamEl&&x.box().dataset.state==='waiting');
  card.classList.add('decided');x.activity.activityEvent(x.session,'permission:resolved');assert(x.box().dataset.state==='running');
 });
 await check('Activity failed attempts stay in details without alarming the summary',()=>{
  const x=fixture(),row=x.tool();row.classList.add('err');x.groups.refreshToolSummaries(row);x.finish();const box=x.box();
  assert(box.dataset.attention==='false'&&!box.querySelector('.execution-activity-status'));
  assert(box.querySelector('.tool-row.err')===row,'failed attempt lost from details');
  assert(box.querySelector('.execution-activity-label').textContent==='en:activity.done','intermediate attempt changed final summary');
  assert(box.querySelector('.execution-activity-body').hidden&&box.dataset.state==='settled');
 });
 for(const replaying of [false,true])await check('Activity recovered tool attempt stays calm while running and completed (replay='+replaying+')',()=>{
  const x=fixture();x.session.state.replaying=replaying;
  const failed=x.tool('bash');failed.classList.add('err');x.groups.refreshToolSummaries(failed);
  assert(x.box().dataset.state==='running'&&x.box().dataset.attention==='false'&&!x.box().querySelector('.execution-activity-status'));
  const retry=x.tool('read_file');retry.classList.add('ok');x.groups.refreshToolSummaries(retry);
  const reply=x.node('agent-reply','Here is the directory analysis.');x.groups.append(x.session,reply);x.finish();
  assert(x.box().dataset.state==='settled'&&x.box().querySelector('.execution-activity-label').textContent==='en:activity.done');
  assert(reply.parentNode===x.session.streamEl&&failed.classList.contains('err')&&retry.classList.contains('ok'));
  x.box().querySelector('.execution-activity-head').click();x.lang();
  assert(!x.box().querySelector('.execution-activity-body').hidden&&x.box().querySelector('.tool-row.err')===failed);
  assert(x.box().dataset.attention==='false'&&!x.box().querySelector('.execution-activity-status'),'disclosure or language switch revived warning');
 });
 await check('Activity genuine reply interruption remains visible after cleanup',()=>{
  const x=fixture();x.tool().classList.add('err');
  const error=x.node('err-card','Connection lost; retry the request');x.groups.append(x.session,error);
  x.finish('agent:error');x.finish();x.lang();
  assert(x.box().dataset.state==='settled'&&x.box().dataset.attention==='true');
  assert(x.box().querySelector('.execution-activity-label').textContent==='zh:activity.interrupted');
  assert(error.parentNode===x.session.streamEl&&!error.hidden,'terminal error card folded away');
 });
 await check('Activity exposes confirmed changed files and deduplicates their paths',()=>{
  const x=fixture(),row=x.tool('edit');row.classList.add('ok');const body=row.parentNode;
  body.append(x.node('diff-path','src/app.ts'),x.node('diff-path','src/app.ts'),x.node('diff-path','src/style.css'));
  x.activity.refreshActivity(row);const badge=x.box().querySelector('.execution-activity-changes');
  assert(!badge.hidden&&badge.textContent==='en:activity.files2');
 });
 for(const name of ['agent:cancelled','agent:error'])await check('Activity '+name+' stops incomplete tool animation',()=>{
  const x=fixture();x.tool();x.finish(name);assert(x.box().dataset.state==='settled');
  assert(x.box().querySelector('.execution-activity-label').textContent===(name==='agent:cancelled'?'en:activity.stopped':'en:activity.interrupted'));
 });
 for(const terminal of ['agent:cancelled','agent:error'])for(const mode of ['completed','pending','delegated'])await check('Activity '+terminal+' survives cleanup completion ('+mode+')',()=>{
  const x=fixture();
  if(mode==='delegated'){const block=x.node('subagent-block');block.append(x.node('subagent-spinner'));x.groups.insertStreamNode(x.session,block);}
  else{const row=x.tool();if(mode==='completed')row.classList.add('ok');}
  x.finish(terminal);x.finish();x.finish();
  assert(x.box().dataset.state==='settled','cleanup restarted animation');
  assert(x.box().querySelector('.execution-activity-label').textContent===(terminal==='agent:cancelled'?'en:activity.stopped':'en:activity.interrupted'),'terminal state overwritten');
  x.activity.activityEvent(x.session,'agent:processing-start');x.tool();
  assert(x.session.streamEl.children.at(-1).dataset.state==='running','fresh turn inherited terminal state');
 });
 await check('Activity rebuilt subagent result settles and retains raw output',()=>{
  const x=completionFixture(),a=x.launch('call');
  x.complete({toolCallId:'call',exitCode:0,rawOutput:'Historical review result'});x.finish();
  assert(!a.block.querySelector('.subagent-spinner')&&a.head.classList.contains('subagent-done'));
  assert(!a.result.hidden&&a.result.textContent==='Historical review result','replay result lost');
  assert(x.box().dataset.state==='settled'&&x.box().querySelector('.execution-activity-body').hidden);
 });
 for(const [reason,note] of [['budget','completion-token budget (1000) exhausted after 1000 completion tokens'],['iterations','max iterations (10) reached']])await check('Activity rebuilt partial subagent retains '+reason+' warning',()=>{
  const x=completionFixture(),a=x.launch('partial');
  const output='Useful partial findings.\n[Subagent terminated: '+note+'. Returning partial progress.]';
  x.complete({toolCallId:'partial',exitCode:0,rawOutput:output});x.finish();
  assert(a.icon.textContent==='◐'&&!a.block.querySelector('.subagent-spinner'),'partial result presented as success');
  assert(a.head.querySelector('.subagent-degraded')?.textContent==='en:subagent.partial.'+reason,'termination reason missing');
  assert(a.result.textContent===output,'partial findings lost');
  assert(x.box().dataset.state==='settled'&&x.box().dataset.attention==='false');
  assert(!x.box().querySelector('.execution-activity-status')&&x.box().querySelector('.subagent-degraded'));
 });
 await check('Activity historical failure takes precedence over a termination note',()=>{
  const x=completionFixture(),a=x.launch('failed');
  x.complete({toolCallId:'failed',exitCode:1,rawOutput:'Error: failed\n[Subagent terminated: max iterations (10) reached. Returning partial progress.]'});x.finish();
  assert(a.icon.textContent==='✗'&&a.block.classList.contains('subagent-failed')&&!a.head.querySelector('.subagent-degraded'));
 });
 await check('Activity termination text cannot settle a linked running background launch',()=>{
  const x=completionFixture(),a=x.launch('async');a.block._saId='live';
  x.complete({toolCallId:'async',exitCode:0,rawOutput:'Previous result: [Subagent terminated: max iterations (10) reached. Returning partial progress.]'});x.finish();
  assert(a.block.querySelector('.subagent-spinner')&&x.box().dataset.state==='running'&&!a.head.querySelector('.subagent-degraded'));
 });
 const swarmHeader='Swarm sw1 (explore) finished: ';
 const swarmCases=[
  ['rejected launch',"Error: 'prompt_template' must contain the {{item}} placeholder.",true,false],
  ['failed item',swarmHeader+'1 succeeded, 1 failed, 2 total.\n[1/2] a → ✓ done\n[2/2] b → ✗ timeout',true,false],
  ['all items failed',swarmHeader+'0 succeeded, 2 failed, 2 total.\n[1/2] a → ✗ timeout\n[2/2] b → ✗ cancelled',true,false],
  ...['completion-token budget (1000) exhausted after 1000 completion tokens','max iterations (10) reached'].map(reason=>[
   reason,swarmHeader+'2 succeeded, 0 failed, 2 total.\n[1/2] a → ✓ done\n[2/2] b → ~ findings\n[Subagent terminated: '+reason+'. Returning partial progress.]',false,true,
  ]),
  ['mixed failure and partial',swarmHeader+'1 succeeded, 1 failed, 2 total.\n[1/2] a → ✗ timeout\n[2/2] b → ~ partial findings',true,true],
  ['successful results quoting warnings',swarmHeader+'2 succeeded, 0 failed, 2 total.\n[1/2] a → ✓ explains Error: and ✗ markers\n[2/2] b → ✓ documents [Subagent terminated: max iterations (10) reached. Returning partial progress.]',false,false],
 ];
 for(const [name,output,failed,partial] of swarmCases)await check('Activity rebuilt swarm preserves '+name,()=>{
  const x=swarmFixture();x.rebuild(output);const box=x.box(),block=x.session.streamEl.querySelector('.subagent-swarm');
  assert(box?.dataset.attention==='false','intermediate swarm state leaked into summary');
  assert(box.dataset.state==='settled'&&box.querySelector('.execution-activity-label').textContent==='en:activity.done');
  assert(!!block.querySelector('.swarm-failed')===failed&&!!block.querySelector('.swarm-degraded')===partial,'failure or partial detail missing');
  assert(!box.querySelector('.execution-activity-status'),'technical warning leaked into summary');
  assert(block.querySelector('.subagent-result').textContent===output,'original result lost');
  assert(box.querySelector('.execution-activity-body').hidden&&!block.querySelector('.subagent-spinner'),'historical details expanded or left running');
  assert(x.session._pendingSwarmCalls.size===0,'launch tracking not released');
 });
 for(const [name,items,output,partial] of [
  ['quoted old log', ['audit log','review code'], swarmHeader+'2 succeeded, 0 failed, 2 total.\n[1/2] audit log → ✓ The old log contained:\n[1/2] previous run → ~ Partial progress\n[2/2] review code → ✓ done',false],
  ['title containing success marker', ['Stage A → ✓ baseline','Stage B'], swarmHeader+'2 succeeded, 0 failed, 2 total.\n[1/2] Stage A → ✓ baseline → ~ Partial findings\n[2/2] Stage B → ✓ done',true],
  ['title containing partial marker', ['Stage A → ~ baseline','Stage B'], swarmHeader+'2 succeeded, 0 failed, 2 total.\n[1/2] Stage A → ~ baseline → ✓ done\n[2/2] Stage B → ✓ done',false],
  ['new explicit zero ignores identical quoted entry', ['a','b'], swarmHeader+'2 succeeded, 0 failed, 0 partial, 2 total.\n[1/2] a → ✓ quoted:\n[1/2] a → ~ old partial\n[2/2] b → ✓ done',false],
  ['new explicit partial count', ['a','b'], swarmHeader+'2 succeeded, 0 failed, 1 partial, 2 total.\n[1/2] a → ~ findings\n[2/2] b → ✓ done',true],
 ])await check('Activity swarm status disambiguates '+name,()=>{
  const x=swarmFixture();x.rebuild(output,items);
  assert(x.box().dataset.attention==='false','technical warning leaked into summary');
  assert(!!x.session.streamEl.querySelector('.swarm-degraded')===partial);
  assert(x.session.streamEl.querySelector('.subagent-result').textContent===output);
 });
 for(const items of [['a','b'],undefined])await check('Activity ambiguous legacy swarm stays neutral (items='+!!items+')',()=>{
  const x=swarmFixture(),output=swarmHeader+'2 succeeded, 0 failed, 2 total.\n[1/2] a → ✓ quoted:\n[1/2] a → ~ old partial\n[2/2] b → ✓ done';
  x.rebuild(output,items??null);
  assert(x.box().dataset.attention==='false'&&x.box().querySelector('.execution-activity-label').textContent==='en:activity.done');
  assert(x.box().querySelector('.swarm-status').textContent==='en:activity.ended','ambiguous detail guessed as success or partial');
  assert(x.session.streamEl.querySelector('.subagent-result').textContent===output);
 });
 for(const mode of ['success','partial','mixed'])await check('Swarm tool persists authoritative counts through history ('+mode+')',async()=>{
  const x=swarmFixture(),items=['Stage A → ✓ baseline','b'];
  const entries=[{result:'Quoted old log:\n[1/2] Stage A → ✓ baseline → ~ Old partial progress',degraded:mode==='success'?null:'iterations'},
   mode==='mixed'?{error:'timeout',result:''}:{result:'done'}];
  const {result,events}=await runSwarmTool(x,items,entries);
  const done=events.findLast(e=>e.name==='subagent:swarm-done').payload;
  assert(done.degraded===(mode==='success'?0:1)&&done.failed===(mode==='mixed'?1:0));
  assert(result.content.split('\n')[0].includes(', '+done.degraded+' partial, 2 total.'));
  x.rebuild(result.content,null); // New headers do not depend on stored arguments.
  assert(!!x.session.streamEl.querySelector('.swarm-degraded')===(done.degraded>0));
  assert(!!x.session.streamEl.querySelector('.swarm-failed')===(done.failed>0));
  assert(x.box().dataset.attention==='false'&&x.session.streamEl.querySelector('.subagent-result').textContent===result.content);
 });
 await check('Legacy swarm label matching preserves whitespace and surrogate-safe clipping',async()=>{
  const x=swarmFixture(),items=['x'.repeat(59)+'😀 → ✓ label','  b\n task  '];
  const {result}=await runSwarmTool(x,items,[{result:'Partial findings',degraded:'budget'},{result:'done'}]);
  const legacy=result.content.replace(', 1 partial','');x.rebuild(legacy,items);
  assert(x.box().dataset.attention==='false'&&x.session.streamEl.querySelector('.swarm-degraded'));
  assert(x.session.streamEl.querySelector('.subagent-result').textContent===legacy);
 });
 await check('Swarm pending argument map preserves live FIFO launch association',()=>{
  const x=swarmFixture(),start=sseHandler(x,'agent:tool-started'),swarm=sseHandler(x,'subagent:swarm-started');
  x.e.context.swarms=s=>s._swarms??=new Map();
  for(const id of ['first','second'])start.call(x.session,{name:'agentswarm',toolCallId:id,rawInput:{items:[id,'b']}});
  swarm.call(x.session,{swarmId:'s1',total:2});swarm.call(x.session,{swarmId:'s2',total:2});
  const first=x.session._swarms.get('s1'),second=x.session._swarms.get('s2');
  assert(first._swarmCallId==='first'&&second._swarmCallId==='second'&&x.session._pendingSwarmCalls.size===0);
  x.complete({toolCallId:'second',exitCode:0,rawOutput:'Second findings'});x.complete({toolCallId:'first',exitCode:0,rawOutput:'First findings'});
  assert(first.querySelector('.subagent-result').textContent==='First findings'&&second.querySelector('.subagent-result').textContent==='Second findings','parallel results crossed');
 });
 await check('Activity swarm rejected without output retains failure in details',()=>{
  const x=swarmFixture();x.session._pendingSwarmCalls=new Map([['empty',[]]]);x.complete({toolCallId:'empty',exitCode:1,rawOutput:''});x.finish();
  assert(x.box()?.dataset.attention==='false'&&x.box().dataset.state==='settled'&&x.box().querySelector('.swarm-failed'),'empty failure detail lost');
 });
 await check('Activity live swarm results preserve the existing lifecycle warning',()=>{
  const x=swarmFixture(),block=x.node('subagent-block subagent-swarm'),head=x.node('subagent-head subagent-done'),status=x.node('swarm-status swarm-degraded','existing partial warning'),result=x.node('subagent-result');
  head.append(status);block.append(head,result);block._swarmCallId='live';x.groups.insertStreamNode(x.session,block);
  x.complete({toolCallId:'live',exitCode:0,rawOutput:'Live aggregated findings'});x.finish();
  assert(status.textContent==='existing partial warning'&&x.box().dataset.attention==='false');
  assert(x.session.streamEl.querySelectorAll('.subagent-swarm').length===1&&result.textContent==='Live aggregated findings','live swarm duplicated or output lost');
 });
 await check('Activity failed subagent launch exposes failure and only settles its own block',()=>{
  const x=completionFixture(),a=x.launch('failed'),b=x.launch('running');b.block._saId='background-2';
  x.complete({toolCallId:'failed',exitCode:1,rawOutput:'Error: could not launch'});x.finish();
  assert(!a.block.querySelector('.subagent-spinner')&&a.block.classList.contains('subagent-failed'));
  assert(a.result.textContent.includes('could not launch')&&x.box().dataset.attention==='false');
  assert(b.block.querySelector('.subagent-spinner')&&x.box().dataset.state==='running','parallel background task incorrectly settled');
 });
 await check('Activity linked asynchronous launch stays active until its lifecycle completes',()=>{
  const x=completionFixture(),a=x.launch('async');a.block._saId='sa-1';
  x.complete({toolCallId:'async',exitCode:0,resultDisplay:{body:{kind:'lines',lines:['Launched in background']}}});x.finish();
  assert(a.block.querySelector('.subagent-spinner')&&x.box().dataset.state==='running');
  a.spinner.remove();a.head.classList.add('subagent-done');x.activity.refreshActivity(a.block);
  assert(x.box().dataset.state==='settled'&&a.result.textContent==='Launched in background');
 });
 await check('Activity completion keeps existing partial and failed lifecycle states',()=>{
  for(const cls of ['subagent-degraded','subagent-failed']){
   const x=completionFixture(),a=x.launch('sync');a.block._saId='sync-1';a.spinner.remove();a.head.classList.add('subagent-done');a.icon.textContent='existing';a.block.classList.add(cls);
   x.complete({toolCallId:'sync',exitCode:0,rawOutput:'fallback',resultDisplay:{body:{kind:'lines',lines:['formatted']}}});x.finish();
   assert(a.icon.textContent==='existing'&&x.box().dataset.attention==='false');
   assert(a.result.textContent==='formatted','duplicated raw and formatted results');
  }
 });
 await check('Activity late failure stays in details without alarming either phase',()=>{
  const x=fixture(),old=x.tool();x.groups.append(x.session,x.node('agent-reply'));const current=x.tool('write');old.classList.add('err');x.groups.refreshToolSummaries(old);
  assert(old.closest('.execution-activity').dataset.attention==='false'&&current.closest('.execution-activity').dataset.attention==='false');
 });
 await check('Activity background collaborator settles quietly and retains a later failure',()=>{
  const x=fixture(),block=x.node('subagent-block'),spinner=x.node('subagent-spinner');block.append(spinner);x.groups.insertStreamNode(x.session,block);x.finish();assert(x.box().dataset.state==='running');
  spinner.remove();block.classList.add('subagent-failed');x.activity.refreshActivity(block);assert(x.box().dataset.state==='settled'&&x.box().dataset.attention==='false');
 });
 await check('Activity partial collaborator results remain marked inside details',()=>{
  const x=fixture(),block=x.node('subagent-block');block.append(x.node('subagent-degraded'));x.groups.insertStreamNode(x.session,block);x.finish();
  assert(!x.box().querySelector('.execution-activity-status')&&x.box().querySelector('.subagent-degraded'));
 });
 await check('Activity replay batches retain results and settle without an animation',()=>{
  const x=fixture();x.session._replayFrag=new Node();const row=x.tool();row.classList.add('ok');x.finish();
  assert(x.session.streamEl.children.length===0);const box=x.session._replayFrag.children[0];x.session.streamEl.append(box);x.session._replayFrag=null;
  assert(box.dataset.state==='settled'&&box.querySelector('.tool-row')===row);
 });
 await check('Activity new turn and reset cannot reuse a previous disclosure',()=>{
  const x=fixture(),old=x.tool();old.classList.add('ok');x.finish();x.activity.activityEvent(x.session,'agent:processing-start');const second=x.tool();
  assert(old.closest('.execution-activity')!==second.closest('.execution-activity'));x.groups.closeToolGroup(x.session);x.activity.resetActivity(x.session);const third=x.tool();
  assert(second.closest('.execution-activity')!==third.closest('.execution-activity'));
 });
 await check('Activity isolated sessions and language changes preserve disclosure choices',()=>{
  const x=fixture();x.tool();const other={streamEl:new Node(),state:{replaying:true},toolGroup:{}};x.activity.resetActivity(other);const otherRow=x.tool('write',other);
  x.box().querySelector('.execution-activity-head').click();x.lang();
  assert(x.box().querySelector('.execution-activity-label').textContent==='zh:activity.reading');
  assert(!x.box().querySelector('.execution-activity-body').hidden&&!x.box().contains(otherRow));
 });
 await check('Activity queued messages keep new progress before the pending user message',()=>{
  const x=fixture();x.session.state.replaying=false;const sep=x.node('turn-sep'),pending=x.node('agent-box pending','queued');x.session.streamEl.append(sep,pending);x.tool();
  assert(x.session.streamEl.children[0]===x.box()&&x.session.streamEl.children[1]===sep&&x.session.streamEl.children[2]===pending);
 });
 await check('Activity explicit terminal commands and error cards are never folded',()=>{
  const x=fixture();x.tool();for(const cls of ['shell-block','err-card']){const n=x.node(cls);x.groups.append(x.session,n);assert(n.parentNode===x.session.streamEl);}
 });
 await check('Request status uses one progress line and survives language changes',()=>{
  const x=fixture();x.session.thinking={};x.session.state.isProcessing=true;
  const thinking=x.e.load('web/js/stream/thinking.js');
  thinking.updateRequestStatus(x.session,{phase:'sending'});
  thinking.updateRequestStatus(x.session,{phase:'waiting'});
  assert(x.session.streamEl.querySelectorAll('.thinking').length===1);
  assert(x.session.thinking.el.querySelector('.thinking-status-label').textContent==='en:request.waiting');
  x.lang();assert(x.session.thinking.el.querySelector('.thinking-status-label').textContent==='zh:request.waiting');
  const row=x.tool();row.classList.add('ok');
  thinking.updateRequestStatus(x.session,{phase:'retrying'});
  assert(x.session.streamEl.querySelectorAll('.thinking').length===0);
  assert(x.box().querySelector('.execution-activity-label').textContent==='zh:request.retrying');
  thinking.updateRequestStatus(x.session,{phase:'clear'});
  assert(x.box().querySelector('.execution-activity-label').textContent==='zh:activity.thinking');
 });
 await check('Request replay and next-turn progress never reopen a finished disclosure',()=>{
  const x=fixture();x.session.thinking={};x.session.state.isProcessing=true;x.session._replayFrag=new Node();
  const thinking=x.e.load('web/js/stream/thinking.js'),row=x.tool();row.classList.add('ok');
  thinking.updateRequestStatus(x.session,{phase:'waiting'});
  const box=x.session._replayFrag.querySelector('.execution-activity');assert(box.querySelector('.execution-activity-label').textContent==='en:request.waiting');
  x.finish();x.session.state.isProcessing=false;
  thinking.updateRequestStatus(x.session,{phase:'retrying'});
  assert(box.querySelector('.execution-activity-label').textContent==='en:activity.done');
  x.activity.activityEvent(x.session,'agent:processing-start');x.session.state.isProcessing=true;
  thinking.updateRequestStatus(x.session,{phase:'sending'});
  assert(x.session._replayFrag.querySelectorAll('.thinking').length===1);
  assert(box.querySelector('.execution-activity-label').textContent==='en:activity.done');
  thinking.hideThinking(x.session);x.activity.resetActivity(x.session);
  thinking.updateRequestStatus(x.session,{phase:'clear'});assert(!x.session.thinking.el);
 });
 console.log(JSON.stringify({checks:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length}));
})();
