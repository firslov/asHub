// Real DOM and stream placement, synthetic messages only.
const {app,BrowserWindow}=require('electron');
const {fixture}=require('./file-preview-fixture.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict'),ts=require('typescript');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'steering-ui-')));app.on('window-all-closed',()=>{});
const source=ts.createSourceFile('sse.js',fs.readFileSync(path.join(__dirname,'../web/js/sse.js'),'utf8'),ts.ScriptTarget.Latest,true);let query;
const visit=n=>{if(ts.isMethodDeclaration(n)&&n.name?.text==='agent:query')query=n.getText(source);ts.forEachChild(n,visit);};visit(source);
const timer=setTimeout(()=>app.exit(1),30000);
app.whenReady().then(async()=>{let f,w;try{
 f=await fixture();w=new BrowserWindow({show:false,width:1200,height:850});await w.loadURL(f.url);
 const result=await w.webContents.executeJavaScript(`(async()=>{
  const {append,appendAfterPending}=await import('/js/stream/tool-group.js');
  const {findQueued}=await import('/js/queued-messages.js');
  const {showThinking}=await import('/js/stream/thinking.js');
  const closeReply=()=>{},finalizeThinking=()=>{},finalizeLiveOutput=()=>{},resetCompletedTools=()=>{},startNewSegment=()=>{};
  const {renderTurnSep}=await import('/js/stream/renderers.js');
  const createUserBox=(text)=>{const box=document.createElement('div');box.className='agent-box';box._queryText=text;box.textContent=text;return box;};
  const handler=({${query}})['agent:query'];const errors=[];
  for(const replaying of [false,true])for(const waiting of [false,true])for(const acknowledged of [false,true]){
   const root=document.createElement('div');document.body.append(root);
   const s={state:{replaying,currentTurn:1},streamEl:root,_replayFrag:replaying?document.createDocumentFragment():null,toolGroup:{},thinking:{},scroll:{stickToBottom:false}};
   const add=(text,pending,id)=>{const sep=document.createElement('div');sep.className='turn-sep';sep.dataset.owner=text;appendAfterPending(s,sep);const box=document.createElement('div');box.className='agent-box'+(pending?' pending':'');box.dataset.queued=text;box.dataset.queueId=id;box._queryText=text;box.textContent=text;appendAfterPending(s,box);return box;};
   add('initial',false,'');add('later',true,'queue');if(acknowledged)add('correction',true,'steer');
   const before=document.createElement('article');before.textContent='before';append(s,before);
   handler.call(s,{query:'correction',queueId:'steer',steering:true});
   if(waiting)showThinking(s);
   const after=document.createElement('article');after.textContent='after';append(s,after);
   const target=s._replayFrag||root;
   const visible=()=>[...target.children].filter(n=>!n.classList.contains('turn-sep')&&!n.classList.contains('thinking')).map(n=>n.textContent);
   if(JSON.stringify(visible())!==JSON.stringify(['initial','before','correction','after','later']))errors.push('Active order '+replaying+'/'+waiting+': '+visible());
   if(waiting&&[...target.children].indexOf(s.thinking.el)>[...target.children].findIndex(n=>n.dataset.queueId==='queue'))errors.push('Waiting indicator after queued input '+replaying);
   const current=[...target.children].find(n=>n._queryText==='correction');
   if(!current.previousElementSibling?.classList.contains('turn-sep'))errors.push('Consumed message lost its separator '+replaying+'/'+waiting);
   const pending=[...target.children].find(n=>n.dataset.queueId==='queue');
   if(pending.previousElementSibling?.dataset.owner!=='later')errors.push('Pending separator changed');
   handler.call(s,{query:'later',queueId:'queue'});
   if(JSON.stringify(visible())!==JSON.stringify(['initial','before','correction','after','later']))errors.push('Final order '+replaying+'/'+waiting+': '+visible());
   if(target.querySelectorAll('.turn-sep').length!==target.querySelectorAll('.agent-box').length)errors.push('Orphaned separator');
   root.remove();
  }
  return errors;
 })()`);
 assert.deepEqual(result,[]);console.log('PASS desktop live/replay: steering overtakes queued work without moving answers above their user messages');
}finally{w?.destroy();f?.server.close();clearTimeout(timer);}}).then(()=>app.exit(0),e=>{console.error(e);app.exit(1);});
