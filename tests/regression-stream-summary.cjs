const {env,check,assert,results,fs,path,root,ts,vm}=require('./harness.cjs');
const {Node}=require('./stream-dom.cjs');
function setup(extra={}){
 const document=new Node(),raf=[],cancelled=new Set();document.createElement=t=>new Node(t);let language='en',nextFrameId=0;
 const e=env({modules:{'../utils.js':{escape:s=>String(s??'')},'../i18n.js':{t:(key,p)=>language+':'+key+(p?.n??'')},...extra.modules},globals:{document,requestAnimationFrame:cb=>{const id=++nextFrameId;raf.push(()=>{if(!cancelled.has(id))cb();});return id;},cancelAnimationFrame:id=>cancelled.add(id),...extra.globals}});
 const groups=e.load('web/js/stream/tool-group.js'),compact=e.load('web/js/stream/compact.js');
 const session={streamEl:new Node(),state:{replaying:true},toolGroup:{}};document.append(session.streamEl);
 function addGroup(s=session){for(let i=0;i<2;i++){const row=new Node();row.className='tool-row';row.dataset.toolName='bash';groups.appendToGroup(s,row);groups.bumpToolCount(s);}return s.toolGroup.current;}
 function addThought(){const n=new Node();n.className='thinking-block';session.streamEl.append(n);}
 return {e,groups,compact,session,addGroup,addThought,document,raf,lang:()=>{language='zh';document.dispatchEvent({type:'langchange'});}};
}
function thinkingView(){
 const x=setup({modules:{'./sse.js':{},'./session-manager.js':{resyncSession(){},unsubscribeSession(){},unregisterSession(){}},'./state.js':{STATE_DEFAULTS:{replaying:false}},'./i18n.js':{t:x=>x,lang:{value:'en'},scanI18n(){}}},globals:{HTMLElement:Node,customElements:{define(){}}}});
 x.document.getElementById=()=>({content:{cloneNode(){const shell=new Node(),stream=new Node();stream.className='session-stream';shell.append(stream);return shell;}}});
 const {SessionView}=x.e.load('web/js/session-view.js','export {SessionView};');
 const view=new SessionView();view.id='test';view.initStreamShell();view.enterReplayMode=()=>{view.state.replaying=true;};x.document.append(view);
 return {...x,view,think:x.e.load('web/js/stream/thinking.js'),flush:()=>{const pending=x.raf.splice(0);pending.forEach(f=>f());}};
}
function handler(ctx,name){
 const sf=ts.createSourceFile('sse.js',fs.readFileSync(path.join(root,'web/js/sse.js'),'utf8'),ts.ScriptTarget.Latest,true);let method;
 function walk(n){if(ts.isMethodDeclaration(n)&&n.name?.text===name)method=n;ts.forEachChild(n,walk);}walk(sf);
 return vm.runInContext('({'+method.getText(sf)+'})['+JSON.stringify(name)+']',ctx);
}
(async()=>{
 await check('Stream nested phase remains naturally sized after repeated disclosure changes',()=>{
  const x=setup();for(let i=0;i<2;i++){x.addThought();x.addGroup();x.groups.closeToolGroup(x.session);}x.compact.compactReasoning(x.session.streamEl);
  const phase=x.session.streamEl.querySelector('.reasoning-phase'),head=phase.querySelector('.reasoning-phase-head'),body=phase.querySelector('.reasoning-phase-body');
  head.click();head.click();head.click();x.raf.forEach(f=>f());body.scrollHeight=1200;
  assert(!body.hidden&&head.attrs['aria-expanded']==='true');assert(!body.style.maxHeight||body.style.maxHeight==='none','phase pinned to stale content height');
  head.click();assert(body.hidden&&head.attrs['aria-expanded']==='false');
 });
 await check('Stream tool group stays naturally sized when a hidden parent cancels expansion',()=>{
  const x=setup(),group=x.addGroup(),body=group.querySelector('.tool-group-body'),head=group.querySelector('.tool-group-head');
  x.groups.closeToolGroup(x.session);head.click();x.session.streamEl.hidden=true;
  // A hidden ancestor cancels the transition: no transitionend is delivered.
  body.dispatchEvent({type:'transitioncancel',propertyName:'max-height',target:body});
  x.session.streamEl.hidden=false;body.scrollHeight=900;
  assert(!group.classList.contains('collapsed')&&!body.inert&&head.attrs['aria-expanded']==='true');
  assert(!body.style.maxHeight||body.style.maxHeight==='none','expanded output is pinned to the old height');
 });
 await check('Stream rapid tool group toggles preserve collapsed access and ignore stale transitions',()=>{
  const x=setup(),group=x.addGroup(),body=group.querySelector('.tool-group-body'),head=group.querySelector('.tool-group-head');
  x.groups.closeToolGroup(x.session);for(let i=0;i<8;i++)head.click();
  body.dispatchEvent({type:'transitionend',propertyName:'max-height',target:body});
  assert(group.classList.contains('collapsed')&&body.inert&&head.attrs['aria-expanded']==='false');
  head.click();body.scrollHeight=1600;
  assert(!group.classList.contains('collapsed')&&!body.inert&&head.attrs['aria-expanded']==='true');
  assert(!body.style.maxHeight||body.style.maxHeight==='none','reopened group has a fixed height');
 });
 for(const connected of [true,false])await check('Stream todo resumes at natural height with no layout (connected='+connected+')',()=>{
  const x=setup(),todo=x.e.load('web/js/stream/todo-block.js'),block=new Node();block.className='todo-block';block._stickyWatch={};
  const head=new Node('button');head.className='todo-head';const body=new Node();body.className='todo-body';body.isConnected=connected;const list=new Node();list.className='todo-list';body.append(list);block.append(head,body);x.session.streamEl.append(block);x.session._todoBlock=block;
  todo.settleTodoBlock(x.session);x.session.streamEl.hidden=true;body.scrollHeight=0;
  todo.updateTodoBlock(x.session,[{title:'new task',status:'in_progress'}]);x.session.streamEl.hidden=false;body.scrollHeight=400;
  assert(!block.classList.contains('collapsed')&&head.attrs['aria-expanded']==='true');
  assert(!body.style.maxHeight||body.style.maxHeight==='none','new task list is pinned to zero height');
 });
 await check('Stream todo respects manual collapse and completed-list settling',()=>{
  const x=setup(),todo=x.e.load('web/js/stream/todo-block.js'),block=new Node();block.className='todo-block';block._stickyWatch={};
  const head=new Node('button');head.className='todo-head';const body=new Node();body.className='todo-body';const list=new Node();list.className='todo-list';body.append(list);block.append(head,body);x.session.streamEl.append(block);x.session._todoBlock=block;
  todo.settleTodoBlock(x.session);block.dataset.userToggled='1';todo.updateTodoBlock(x.session,[{title:'new task',status:'in_progress'}]);assert(block.classList.contains('collapsed')&&head.attrs['aria-expanded']==='false','manual collapse overridden');
  delete block.dataset.userToggled;todo.updateTodoBlock(x.session,[{title:'new task',status:'in_progress'}]);assert(!block.classList.contains('collapsed'));
  todo.updateTodoBlock(x.session,[{title:'new task',status:'done'}]);assert(block.classList.contains('collapsed')&&block.classList.contains('settled')&&head.attrs['aria-expanded']==='false');
 });
 await check('Stream thinking remains naturally sized after cancelled expansion and resize',()=>{
  const x=setup(),{setThinkingCollapsed:toggle}=x.e.load('web/js/stream/thinking.js','export const audit={setThinkingCollapsed};').audit;
  const block=new Node(),head=new Node('button'),body=new Node();block.className='thinking-block';head.className='thinking-block-head';body.className='thinking-block-body';block.append(head,body);x.session.streamEl.append(block);
  toggle(block,true);toggle(block,false);x.session.streamEl.hidden=true;body.dispatchEvent({type:'transitioncancel',propertyName:'max-height',target:body});x.session.streamEl.hidden=false;body.scrollHeight=500;
  assert(!block.classList.contains('collapsed')&&!body.inert&&head.attrs['aria-expanded']==='true');assert(!body.style.maxHeight||body.style.maxHeight==='none','resized thought is clipped by its old height');
  for(let i=0;i<7;i++)toggle(block,!block.classList.contains('collapsed'));assert(body.inert&&head.attrs['aria-expanded']==='false');toggle(block,false);assert(!body.inert&&head.attrs['aria-expanded']==='true');
 });
 for(const reset of ['resetForBranchSwitch','resync'])await check('Stream '+reset+' discards pending thinking before replay',()=>{
  const x=thinkingView();x.think.appendThinkingChunk(x.view,'stale');x.view[reset]();x.view.state.replaying=true;
  x.think.finalizeThinking(x.view);x.think.appendThinkingChunk(x.view,'replayed');x.think.finalizeThinking(x.view);x.flush();
  const blocks=x.view.streamEl.querySelectorAll('.thinking-block-inner');assert(blocks.length===1&&blocks[0].textContent==='replayed','old buffered thought leaked into replay');assert(x.view._thinkingRaf===null);
 });
 for(const reset of ['reconnect','resetForBranchSwitch','resync'])await check('Stream '+reset+' rebuilds active async children and clears stale swarm links',()=>{
  const x=thinkingView(),s=x.view,activity=x.e.load('web/js/stream/activity.js');
  const node=cls=>{const n=new Node();n.className=cls;return n;};
  Object.assign(x.e.context,{
   saMaps:v=>{v._saBlocksByCallId??=new Map();v._saBlocksBySaId??=new Map();},
   createSubagentBlock:()=>{const b=node('subagent-block'),head=node('subagent-head');head.append(node('subagent-icon'),node('subagent-spinner'));b.append(head,node('subagent-result'));return b;},
   insertStreamNode:x.groups.insertStreamNode,refreshActivity:activity.refreshActivity,t:k=>k,
  });
  const started=handler(x.e.context,'subagent:started'),done=handler(x.e.context,'subagent:done');
  started.call(s,{subagentId:'async',type:'explore',task:'Inspect files'});
  const old=s._saBlocksBySaId.get('async');
  s._saBlocksByCallId.set('old-call',old);s._swarms=new Map([['swarm',node('subagent-block')]]);s._pendingSwarmCalls=new Map([['old-swarm-call',['a','b']]]);
  if(reset==='reconnect')handler(x.e.context,'hub:replay-starting').call(s);else s[reset]();
  assert(s._saBlocksBySaId.size===0&&s._saBlocksByCallId.size===0&&s._swarms.size===0&&s._pendingSwarmCalls.size===0,'detached execution links survived reset');
  // Replayed swarm children must attach to the new parent, not the detached one.
  const swarm=node('subagent-block'),body=node('subagent-body');swarm.append(body);s._swarms.set('swarm',swarm);x.groups.insertStreamNode(s,swarm);
  started.call(s,{subagentId:'async',type:'explore'});started.call(s,{subagentId:'child',swarmId:'swarm',type:'explore'});
  const current=s._saBlocksBySaId.get('async'),child=s._saBlocksBySaId.get('child');
  assert(current!==old&&s.streamEl.contains(current)&&body.contains(child),'replayed children missing or routed to old DOM');
  started.call(s,{subagentId:'async',type:'explore'});
  assert(s.streamEl.querySelectorAll('.subagent-block').length===3,'duplicate start created an extra child');
  done.call(s,{subagentId:'async'});done.call(s,{subagentId:'child',error:'New failure'});
  assert(current.querySelector('.subagent-icon').textContent==='✓'&&!current.querySelector('.subagent-spinner'),'completion missed replayed child');
  assert(child.querySelector('.subagent-result').textContent.includes('New failure')&&child.classList.contains('subagent-failed'),'failure routed to detached child');
  assert(old.querySelector('.subagent-spinner')&&s._saBlocksBySaId.size===0,'completion changed old DOM or retained terminal links');
 });
 await check('Stream closing a view cancels its pending thinking render',()=>{
  const x=thinkingView();x.think.appendThinkingChunk(x.view,'stale');x.view.disconnectedCallback();x.flush();
  assert(!x.view.streamEl.querySelector('.thinking-block')&&x.view._thinkingRaf===null,'closed view rendered stale thinking');
 });
 await check('Stream ordinary thinking batches and finalization preserve all chunks',()=>{
  const x=thinkingView();x.think.appendThinkingChunk(x.view,'first ');x.think.appendThinkingChunk(x.view,'second');x.flush();assert(x.view.streamEl.querySelector('.thinking-block-inner').textContent==='first second');
  x.think.appendThinkingChunk(x.view,' third');x.think.finalizeThinking(x.view);x.flush();assert(x.view.streamEl.querySelector('.thinking-block-inner').textContent==='first second third'&&x.view.thinking.block===null);
 });
 await check('Stream repeated resets still allow fresh live thinking to render',()=>{
  const x=thinkingView();for(let i=0;i<3;i++){x.think.appendThinkingChunk(x.view,'stale');x.view.resetForBranchSwitch();x.flush();}
  x.think.appendThinkingChunk(x.view,'fresh');x.flush();assert(x.view.streamEl.querySelector('.thinking-block-inner').textContent==='fresh');
 });
 await check('Stream resetting one view leaves another pending thought intact',()=>{
  const x=thinkingView(),other={streamEl:new Node(),state:{replaying:false},thinking:{},toolGroup:{},scroll:{stickToBottom:false}};
  x.think.appendThinkingChunk(x.view,'discard');x.think.appendThinkingChunk(other,'keep');x.view.resetForBranchSwitch();x.flush();
  assert(!x.view.streamEl.querySelector('.thinking-block')&&other.streamEl.querySelector('.thinking-block-inner').textContent==='keep');
 });
 await check('Stream late tool completion refreshes its closed group, not the current group',()=>{
  const x=setup(),old=x.addGroup();x.groups.closeToolGroup(x.session);const current=x.addGroup(),row=old.querySelector('.tool-row');row.classList.add('err');x.groups.refreshToolSummaries(row);
  assert(old.querySelector('.activity-error')?.textContent.includes('1'));assert(!current.querySelector('.activity-error'));assert(old.classList.contains('collapsed')&&old.querySelector('.tool-group-body').inert,'refresh opened the group');
 });
 await check('Stream completion handler refreshes summaries before any final reply arrives',()=>{
  const x=setup(),group=x.addGroup(),row=group.querySelector('.tool-row');group.querySelector('.tool-group-head').click();
  x.session.streamEl.querySelector=()=>row;
  Object.assign(x.e.context,{saIdFromToolId:()=>'',refreshActivity(){},refreshToolSummaries:x.groups.refreshToolSummaries,absorbAsToolBody:()=>true,maybeScroll:()=>{},CSS:{escape:x=>x}});
  handler(x.e.context,'agent:tool-completed').call(x.session,{toolCallId:'late-tool',exitCode:1,resultDisplay:{summary:'failed'}});
  assert(row.classList.contains('err')&&group.querySelector('.activity-error')?.textContent.includes('1'),'failure remains hidden until later reply');assert(group.classList.contains('collapsed'));
 });
 await check('Stream compacted phase counts late failures once and preserves language refresh',()=>{
  const x=setup();for(let i=0;i<2;i++){x.addThought();x.addGroup();x.groups.closeToolGroup(x.session);}x.compact.compactReasoning(x.session.streamEl);
  const phase=x.session.streamEl.querySelector('.reasoning-phase'),rows=phase.querySelectorAll('.tool-row');
  rows[0].classList.add('err');x.groups.refreshToolSummaries(rows[0]);x.groups.refreshToolSummaries(rows[0]);rows[2].classList.add('err');x.groups.refreshToolSummaries(rows[2]);x.lang();
  const status=phase.querySelector('.reasoning-phase-head').querySelectorAll('.activity-error');assert(status.length===1&&status[0].textContent.includes('2')&&status[0].textContent.includes('zh:error'));assert(phase.dataset.failedTools==='2'&&phase.querySelector('.reasoning-phase-body').hidden);
 });
 await check('Stream success and standalone tool completion do not invent failures',()=>{
  const x=setup(),group=x.addGroup(),row=group.querySelector('.tool-row');row.classList.add('ok');x.groups.refreshToolSummaries(row);assert(!group.querySelector('.activity-error'));
  const standalone=new Node();standalone.className='tool-row err';x.groups.refreshToolSummaries(standalone);
 });
 console.log(JSON.stringify({checks:results.length,passed:results.filter(x=>x.passed).length,failed:results.filter(x=>!x.passed).length}));
})();
