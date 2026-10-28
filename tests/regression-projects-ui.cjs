const test = require('node:test');
const assert = require('node:assert/strict');
const {env} = require('./harness.cjs');
const {El} = require('./ui-harness.cjs');
const tick=()=>new Promise(r=>setImmediate(r));
function setup(options = {}) {
  class Node extends El {
    constructor(tag='div'){super();this.tagName=tag.toUpperCase();this.textContent='';}
    get lastChild(){return this.children.at(-1);}
    querySelectorAll(selector){
      const tags=selector.split(',').map(s=>s.trim().toUpperCase());
      return this.children.flatMap(c=>[...(tags.includes(c.tagName)?[c]:[]),...c.querySelectorAll(selector)]);
    }
    showModal(){this.open=true;}
    close(){this.open=false;this.dispatchEvent({type:'close'});}
  }
  const root=new Node(),body=new Node(); const calls=[], events=[], closed=[], snapshots=[];
  const activeSessionId={value:options.active || ''};
  const allSessions={value:options.sessions || [{instanceId:'a',title:'Alpha',kind:'agent',cwd:'/workspace'},{instanceId:'b',title:'Beta',kind:'agent'}]},effects=[];
  const window=Object.assign(new Node(),{location:{}});
  const project={id:'project',name:'Existing',cwd:'/workspace',sessionIds:['a','archived']};
  let fail=false;
  const document={body,activeElement:null,createElement:tag=>new Node(tag),getElementById:id=>id==='projects'?root:null,addEventListener(){},dispatchEvent(e){events.push(e.type);}};
  const e=env({modules:{
    './network-settings.js':{networkPolicy:{value:null,peek:()=>null},loadNetworkPolicy:async()=>{},saveNetworkPolicy:async()=>{}},
    './toast.js':{toast(){}},
    './store.js':{setSessions:v=>{snapshots.push(v);if(options.liveSessions){allSessions.value=v;effects.forEach(fn=>fn());}},allSessions},
    './session-manager.js':{activeSessionId,spaEnabled:()=>options.spa || false,openTabs:{peek:()=>options.tabs || []},closeTab:async id=>{closed.push(id);if(activeSessionId.value===id)activeSessionId.value='';},sessions:new Map()},
    '../vendor/signals-core.js':{effect:fn=>{effects.push(fn);fn();}}, './i18n.js':{t:key=>key},
  }, globals:{document,window,localStorage:{getItem:()=>null,setItem(){}},fetch:async(url,opts)=>{
    if (url === '/sessions') return {ok:true,json:async()=>options.sessionList ? options.sessionList() : []};
    if (url === '/api/projects/workspaces') return {ok:true,json:async()=>({})};
    calls.push({url,body:opts?.body?JSON.parse(opts.body):null});
    if (options.fetch) return options.fetch(url, opts);
    return {ok:!fail,json:async()=>[project]};
  }}});
  const mod=e.load('web/js/projects.js','export const audit={edit,taskHistory,newProjectChat,deleteProjectChat,pollStatus};');
  return {mod,root,body,calls,events,closed,snapshots,project,window,activeSessionId,fail:()=>fail=true};
}
test('project picker preserves hidden and archived selections and sends only membership deltas',async()=>{
 const s=setup();s.mod.showProjects(true);await tick();s.mod.audit.edit(s.project);
 const dialog=s.body.children.at(-1),form=dialog.children[0],inputs=form.querySelectorAll('input');
 const [name,cwd,search,a,b]=inputs;assert.equal(a.checked,true);assert.equal(b.checked,false);
 search.value='Beta';search.dispatchEvent({type:'input'});assert.equal(a.parentNode.hidden,true);
 b.checked=true;b.dispatchEvent({type:'change'});name.value='Renamed';
 form.dispatchEvent({type:'submit',preventDefault(){}});await tick();
 assert.deepEqual(s.calls.at(-1).body,{action:'edit',id:'project',name:'Renamed',add:['b'],remove:[]});
 assert.equal(dialog.open,false);
});
test('failed save keeps the editor and selected values available for retry',async()=>{
 const s=setup();s.mod.audit.edit(s.project);s.fail();
 const dialog=s.body.children.at(-1),form=dialog.children[0],inputs=form.querySelectorAll('input');
 inputs[0].value='Draft';form.dispatchEvent({type:'submit',preventDefault(){}});await tick();
 assert.equal(dialog.open,true);assert.equal(inputs[0].value,'Draft');assert.equal(inputs[0].disabled,false);
 assert(form.children.some(n=>n.textContent==='projects.saveFailed'));
});
test('project modal contains keyboard shortcuts so Escape cannot cancel the active turn',()=>{
 const s=setup();s.mod.audit.edit(s.project);const dialog=s.body.children.at(-1);
 let stopped=false;dialog.dispatchEvent({type:'keydown',key:'Escape',stopPropagation(){stopped=true;}});
 assert.equal(stopped,true);
});

test('failed create during initial loading does not leave the project list permanently loading',async()=>{
 let finishRead;
 const s=setup({fetch:(_url,opts)=>opts?.method==='POST'
   ? Promise.resolve({ok:false})
   : new Promise(resolve=>finishRead=resolve)});
 s.mod.showProjects(true);
 // The new-project action is available while the list request is pending.
 s.mod.audit.edit(null);
 const dialog=s.body.children.at(-1),form=dialog.children[0];
 form.querySelectorAll('input')[0].value='Draft';form.querySelectorAll('input')[1].value='/workspace';
 form.dispatchEvent({type:'submit',preventDefault(){}});await tick();
 assert.equal(dialog.open,true);
 dialog.close();
 finishRead({ok:true,json:async()=>[s.project]});await tick();
 assert(!s.root.children.some(n=>n.textContent==='projects.loading'),'initial load was invalidated by the failed save');
 assert(s.root.children.some(n=>n.className==='project-group'),'existing projects did not recover');
});
test('successful create cannot be overwritten by an older pending list response',async()=>{
 let finishRead;
 const created={id:'new-project',name:'New',sessionIds:[]};
 const s=setup({fetch:(_url,opts)=>opts?.method==='POST'
   ? Promise.resolve({ok:true,json:async()=>[created]})
   : new Promise(resolve=>finishRead=resolve)});
 s.mod.showProjects(true);s.mod.audit.edit(null);
 const form=s.body.children.at(-1).children[0];
 form.querySelectorAll('input')[0].value='New';form.querySelectorAll('input')[1].value='/workspace';
 form.dispatchEvent({type:'submit',preventDefault(){}});await tick();
 const before=s.root.children;
 finishRead({ok:true,json:async()=>[]});await tick();
 assert.equal(s.root.children,before,'stale load re-rendered over the created project');
 assert(s.root.children.some(n=>n.className==='project-group'));
});

test('failed collaboration shows its error alongside every page of partial output',async()=>{
 const pages=[
   {state:'failed',text:'Partial answer\n',error:'Provider unavailable',nextOffset:15,hasMore:true},
   {state:'failed',text:'Last fragment',error:'Provider unavailable',nextOffset:28,hasMore:false},
 ];
 const s=setup({fetch:async url=>({ok:true,json:async()=>url.includes('&taskId=')
   ? pages.shift()
   : [{id:'task',sourceId:'a',recipientId:'b',message:'Review',state:'failed'}]})});
 s.mod.audit.taskHistory(s.project);await tick();
 const dialog=s.body.children.at(-1),card=dialog.querySelectorAll('details')[0];
 const result=card.querySelectorAll('pre')[0],error=card.querySelectorAll('p').find(n=>n.className==='project-error');
 const more=card.querySelectorAll('button')[0];
 more.dispatchEvent({type:'click'});await tick();
 assert.equal(result.textContent,'Partial answer\n');
 assert.equal(error.textContent,'Provider unavailable','partial output must not hide the failure reason');
 assert.equal(more.hidden,false);
 more.dispatchEvent({type:'click'});await tick();
 assert.equal(result.textContent,'Partial answer\nLast fragment','diagnostics must not contaminate paginated output');
 assert.equal(error.textContent,'Provider unavailable');assert.equal(more.hidden,true);
 assert(s.calls.at(-1).url.endsWith('&offset=15'));
});

test('failed collaboration without output keeps the diagnostic separate from the result',async()=>{
 const s=setup({fetch:async url=>({ok:true,json:async()=>url.includes('&taskId=')
   ? {state:'failed',text:'',error:'Provider unavailable',nextOffset:0,hasMore:false}
   : [{id:'task',sourceId:'a',recipientId:'b',message:'Review',state:'failed'}]})});
 s.mod.audit.taskHistory(s.project);await tick();
 const card=s.body.children.at(-1).querySelectorAll('details')[0];
 card.querySelectorAll('button')[0].dispatchEvent({type:'click'});await tick();
 assert.equal(card.querySelectorAll('pre')[0].textContent,'projects.noResult');
 assert.equal(card.querySelectorAll('p').find(n=>n.className==='project-error').textContent,'Provider unavailable');
});


test('project new conversation defaults to shared directory and joins its project in one request', async()=>{
 const s=setup({fetch:async(url)=>({ok:true,json:async()=>url==='/api/projects/session'?{instanceId:'new-chat'}:[]})});
 s.mod.audit.newProjectChat(s.project);
 const dialog=s.body.children.at(-1), content=dialog.children[0], inputs=content.querySelectorAll('input');
 assert(!inputs.some(n=>n.name==='cwd')); assert.equal(inputs[2].checked,false);
 content.lastChild.dispatchEvent({type:'click'}); await tick(); await tick();
 assert.deepEqual(s.calls.find(c=>c.url==='/api/projects/session').body,{projectId:'project',cwd:'/workspace',isolated:false});
 assert.equal(dialog.open,false);
});
test('empty project can create a first conversation and optionally request an isolated directory', async()=>{
 const s=setup();s.mod.audit.newProjectChat({id:'empty',cwd:'/repo',sessionIds:[]});
 const dialog=s.body.children.at(-1),content=dialog.children[0],inputs=content.querySelectorAll('input');
 assert.equal(content.lastChild.disabled,false);
 inputs[2].checked=true;inputs[2].dispatchEvent({type:'change'});assert.equal(content.lastChild.disabled,false);
 s.fail(); content.lastChild.dispatchEvent({type:'click'});await tick();
 assert.deepEqual(s.calls.at(-1).body,{projectId:'empty',cwd:'/repo',isolated:true});
 assert.equal(dialog.open,true);assert.equal(inputs[2].disabled,false);assert.equal(inputs[2].checked,true);
});
test('project creation blocks duplicate submits and Escape while request is pending',async()=>{
 let finish;
 const s=setup({fetch:(url)=>url==='/api/projects/session'?new Promise(resolve=>finish=resolve):Promise.resolve({ok:true,json:async()=>[]})});
 s.mod.audit.newProjectChat(s.project);const dialog=s.body.children.at(-1),content=dialog.children[0];
 content.lastChild.dispatchEvent({type:'click'});content.lastChild.dispatchEvent({type:'click'});
 assert.equal(s.calls.filter(c=>c.url==='/api/projects/session').length,1);
 let blocked=false;dialog.dispatchEvent({type:'cancel',preventDefault(){blocked=true;}});assert(blocked);
 finish({ok:false,json:async()=>({error:'fixture failure'})});await tick();assert.equal(content.lastChild.disabled,false);
});

test('partial project creation opens the retained conversation instead of creating a duplicate',async()=>{
 const s=setup({fetch:async()=>({ok:false,json:async()=>({error:'Project no longer exists',instanceId:'abc123',cwd:'/workspace'})})});
 s.mod.audit.newProjectChat(s.project);
 const dialog=s.body.children.at(-1),content=dialog.children[0],create=content.lastChild;
 create.dispatchEvent({type:'click'});await tick();
 assert.equal(create.textContent,'projects.openCreatedChat');
 assert.equal(content.querySelectorAll('input')[0].disabled,true);
 create.dispatchEvent({type:'click'});await tick();
 assert.equal(s.calls.filter(c=>c.url==='/api/projects/session').length,1);
 assert.equal(dialog.open,false);
});

for (const keep of [true,false]) test(`project deletion explicitly ${keep ? 'keeps' : 'deletes'} conversations`,async()=>{
 const s=setup();s.mod.audit.edit(s.project);
 const dialog=s.body.children.at(-1),form=dialog.children[0];
 const remove=form.querySelectorAll('button').find(n=>n.textContent==='projects.delete');
 remove.dispatchEvent({type:'click'});
 assert.equal(s.calls.length,0,'first click must only reveal confirmation');
 const options=form.children.find(n=>n.className==='project-delete-options');
 assert.equal(options.hidden,false);
 assert.equal(form.querySelectorAll('input')[0].readOnly,true);
 assert.equal(form.querySelectorAll('button').find(n=>n.textContent==='projects.save').hidden,true);
 form.dispatchEvent({type:'submit',preventDefault(){}});await tick();assert.equal(s.calls.length,0);
 const checkbox=options.querySelectorAll('input')[0]; assert.equal(checkbox.checked,true);
 checkbox.checked=keep;checkbox.dispatchEvent({type:'change'});
 assert.equal(options.children[1].textContent,keep?'projects.deleteHint':'projects.deleteAllHint');
 remove.dispatchEvent({type:'click'});await tick();
 assert.deepEqual(s.calls.at(-1).body,{action:'delete',id:'project',deleteConversations:!keep});
 assert.equal(dialog.open,false); assert(s.events.includes('ash:sessions-changed'));
});

test('project deletion closes only the conversations actually deleted by the server',async()=>{
 const s=setup({tabs:['a','b'],fetch:async()=>({ok:true,json:async()=>({projects:[],deletedSessionIds:['b']})})});
 s.mod.audit.edit(s.project);const form=s.body.children.at(-1).children[0];
 const remove=form.querySelectorAll('button').find(n=>n.textContent==='projects.delete');
 remove.dispatchEvent({type:'click'});
 form.children.find(n=>n.className==='project-delete-options').querySelectorAll('input')[0].checked=false;
 remove.dispatchEvent({type:'click'});await tick();
 assert.deepEqual(s.closed,['b'],'a conversation moved out since opening the dialog must retain its tab');
});

for (const spa of [false,true]) test(`deleting the active project conversation returns home with SPA ${spa}`,async()=>{
 const s=setup({active:'a',tabs:['a'],spa,fetch:async()=>({ok:true,json:async()=>({projects:[],deletedSessionIds:['a']})})});
 s.mod.audit.edit(s.project);const form=s.body.children.at(-1).children[0];
 const remove=form.querySelectorAll('button').find(n=>n.textContent==='projects.delete');
 remove.dispatchEvent({type:'click'});
 form.children.find(n=>n.className==='project-delete-options').querySelectorAll('input')[0].checked=false;
 remove.dispatchEvent({type:'click'});await tick();
 if(spa){assert.deepEqual(s.closed,['a']);assert.equal(s.activeSessionId.value,'');assert.equal(s.window.location.href,undefined);}
 else assert.equal(s.window.location.href,'/');
});

for (const mode of ['keep','archive','delete']) test(`removing one project conversation supports ${mode}`,async()=>{
 const operations=[];
 const s=setup({active:'a',tabs:['a'],spa:true,fetch:async(url,opts)=>{operations.push([url,opts?.method]);return {ok:true,json:async()=>url==='/api/projects'?[s.project]:{ok:true}};}});
 s.mod.audit.deleteProjectChat({instanceId:'a',title:'Alpha'},s.project);
 const dialog=s.body.children.at(-1),form=dialog.children[0],inputs=form.querySelectorAll('input');
 assert.equal(inputs[0].checked,true);assert.equal(operations.length,0);
 const option=inputs.find(n=>n.value===mode);option.checked=true;option.dispatchEvent({type:'change'});
 form.lastChild.dispatchEvent({type:'click'});form.lastChild.dispatchEvent({type:'click'});await tick();await tick();
 assert.equal(dialog.open,false);
 assert.equal(operations.filter(([u,m])=>u==='/a/'&&m==='DELETE').length,mode==='delete'?1:0);
 assert.equal(operations.filter(([u])=>u==='/api/sessions/archive').length,mode==='archive'?1:0);
 const membership=s.calls.find(c=>c.body?.action==='members');
 if(mode!=='delete')assert.deepEqual(membership.body,{action:'members',id:'project',remove:['a']});
 assert.deepEqual(s.closed,mode==='keep'?[]:['a']);
 assert.equal(s.activeSessionId.value,mode==='keep'?'a':'');
 assert(s.events.includes('ash:sessions-changed'));
});
test('archive removal retry does not archive twice or enable a destructive mode',async()=>{
 let failMembership=true,archives=0;
 const s=setup({fetch:async(url,opts)=>{
   if(url==='/api/sessions/archive')archives++;
   if(url==='/api/projects'&&opts?.method==='POST'&&failMembership)return {ok:false};
   return {ok:true,json:async()=>url==='/api/projects'?[s.project]:{ok:true}};
 }});
 s.mod.audit.deleteProjectChat({instanceId:'a'},s.project);
 const form=s.body.children.at(-1).children[0],radio=form.querySelectorAll('input').find(n=>n.value==='archive');radio.checked=true;radio.dispatchEvent({type:'change'});
 form.lastChild.dispatchEvent({type:'click'});await tick();
 assert.equal(archives,1);assert.equal(s.body.children.at(-1).open,true);
 assert(form.querySelectorAll('input').every(n=>n.disabled));
 failMembership=false;form.lastChild.dispatchEvent({type:'click'});await tick();
 assert.equal(archives,1);assert.equal(s.body.children.at(-1).open,false);
});
test('failed archive leaves membership intact and allows retry',async()=>{
 const s=setup({fetch:async()=>({ok:false,json:async()=>({error:'archive failed'})})});
 s.mod.audit.deleteProjectChat({instanceId:'a'},s.project);const form=s.body.children.at(-1).children[0];
 const option=form.querySelectorAll('input').find(n=>n.value==='archive');option.checked=true;option.dispatchEvent({type:'change'});
 form.lastChild.dispatchEvent({type:'click'});await tick();
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].url,'/api/sessions/archive');
 assert.equal(s.body.children.at(-1).open,true);assert.equal(option.disabled,false);assert.deepEqual(s.closed,[]);
});

test('project creation keeps the reference directory when an external chat was modified more recently',()=>{
 const s=setup({sessions:[{instanceId:'b',title:'External',cwd:'/external',kind:'agent'},{instanceId:'a',title:'Main',cwd:'/main',kind:'agent'}]});
 s.mod.audit.newProjectChat({id:'project',cwd:'/root',sessionIds:['a','b']});
 const fields=s.body.children.at(-1).querySelectorAll('input');
 assert(!fields.some(n=>n.name==='cwd'));
 assert(s.body.children.at(-1).querySelectorAll('p').some(n=>n.textContent==='/root'));
});

test('new project requires a root and sends it once with creation',async()=>{
 const s=setup();s.mod.audit.edit(null);const form=s.body.children.at(-1).children[0],inputs=form.querySelectorAll('input');
 inputs[0].value='New';form.dispatchEvent({type:'submit',preventDefault(){}});await tick();assert.equal(s.calls.length,0);
 inputs.find(n=>n.name==='cwd').value='/chosen';form.dispatchEvent({type:'submit',preventDefault(){}});await tick();
 assert.equal(s.calls[0].body.cwd,'/chosen');assert.equal(s.calls[0].body.action,'create');
});
test('legacy project opens root configuration instead of guessing from a member conversation',()=>{
 const s=setup();s.mod.audit.newProjectChat({id:'legacy',name:'Legacy',sessionIds:['a']});
 const form=s.body.children.at(-1).children[0];assert.equal(form.querySelectorAll('input').find(n=>n.name==='cwd').value,'');
 assert(form.querySelectorAll('p').some(n=>n.textContent==='projects.rootRequired'));assert.equal(s.calls.length,0);
});
test('root directory picker blocks save and ignores results after closing the project editor',async()=>{
 const s=setup();let resolve;s.window.electronAPI={pickDirectory:()=>new Promise(r=>resolve=r)};s.mod.audit.edit(null);
 const dialog=s.body.children.at(-1),form=dialog.children[0],inputs=form.querySelectorAll('input');inputs[0].value='Project';inputs[1].value='/before';
 form.querySelectorAll('button').find(b=>b.textContent==='projects.chooseDirectory').dispatchEvent({type:'click'});
 form.dispatchEvent({type:'submit',preventDefault(){}});await tick();assert.equal(s.calls.length,0);
 dialog.close();resolve({cwd:'/late'});await tick();assert.equal(inputs[1].value,'/before');
});


test('stale conversation dialog rejects a changed project root before creating a session',async()=>{
 let currentRoot='/workspace',created=0;
 const s=setup({fetch:async(url,opts)=>{
   if(url==='/api/projects/session') {
     const input=JSON.parse(opts.body);
     if(input.cwd!==undefined && input.cwd!==currentRoot)return {ok:false,json:async()=>({error:'Project directory changed'})};
     created++;return {ok:true,json:async()=>({instanceId:'new-chat'})};
   }
   return {ok:true,json:async()=>[]};
 }});
 s.mod.audit.newProjectChat(s.project);
 const dialog=s.body.children.at(-1),content=dialog.children[0];
 currentRoot='/changed-elsewhere';
 content.lastChild.dispatchEvent({type:'click'});await tick();await tick();
 assert.equal(created,0,'must not silently create in a different directory from the displayed root');
 assert.equal(dialog.open,true);
 assert(content.querySelectorAll('p').some(n=>n.textContent==='Project directory changed'));
});

test('stale project editor does not overwrite a concurrent root change when renaming',async()=>{
 let currentRoot='/workspace';
 const s=setup({fetch:async(_url,opts)=>{
   const input=JSON.parse(opts.body);
   if(input.cwd!==undefined)currentRoot=input.cwd;
   return {ok:true,json:async()=>[{...s.project,name:input.name,cwd:currentRoot}]};
 }});
 s.mod.audit.edit(s.project);
 const dialog=s.body.children.at(-1),form=dialog.children[0];
 currentRoot='/changed-elsewhere';form.querySelectorAll('input')[0].value='Renamed';
 form.dispatchEvent({type:'submit',preventDefault(){}});await tick();
 assert.equal(currentRoot,'/changed-elsewhere','renaming must preserve the latest project root');
 assert.equal(dialog.open,false);
});

test('project editor still sends an intentionally changed root',async()=>{
 const s=setup();s.mod.audit.edit(s.project);
 const form=s.body.children.at(-1).children[0];
 form.querySelectorAll('input')[1].value='/new-root';
 form.dispatchEvent({type:'submit',preventDefault(){}});await tick();
 assert.equal(s.calls.at(-1).body.cwd,'/new-root');
});

const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
test('background polling discovers plugin-created project members without reopening or editing the project',async()=>{
 let groups=[{id:'project',name:'Team',cwd:'/workspace',sessionIds:['a']}];
 let chats=[{instanceId:'a',title:'Coordinator',kind:'agent',cwd:'/workspace',projectId:'project'}];
 const s=setup({liveSessions:true,sessions:chats,sessionList:()=>chats,fetch:async()=>({ok:true,json:async()=>groups})});
 s.mod.showProjects(true);await tick();
 assert.deepEqual(descendants(s.root).filter(n=>n.className==='project-chat-name').map(n=>n.textContent),['Coordinator']);
 groups=[{...groups[0],sessionIds:['a','c']}];chats=[...chats,{instanceId:'c',title:'Researcher',kind:'agent',cwd:'/workspace',projectId:'project'}];
 await s.mod.audit.pollStatus();await tick();
 assert.deepEqual(descendants(s.root).filter(n=>n.className==='project-chat-name').map(n=>n.textContent),['Coordinator','Researcher']);
 // Projects created by another conversation/window must also appear, and moves
 // must remove the member from the old group rather than duplicating it.
 groups=[{...groups[0],sessionIds:['a']},{id:'new',name:'New team',cwd:'/other',sessionIds:['c']}];
 chats=chats.map(c=>c.instanceId==='c'?{...c,projectId:'new'}:c);
 await s.mod.audit.pollStatus();await tick();
 const rendered=s.root.children.filter(n=>n.className==='project-group');assert.equal(rendered.length,2);
 assert.deepEqual(descendants(rendered[0]).filter(n=>n.className==='project-chat-name').map(n=>n.textContent),['Coordinator']);
 assert.deepEqual(descendants(rendered[1]).filter(n=>n.className==='project-chat-name').map(n=>n.textContent),['Researcher']);
 assert.equal(s.body.children.length,0,'synchronization must not open a management dialog');
});

test('a stale background project response cannot overwrite a successful local edit',async()=>{
 const initial={id:'project',name:'Before',cwd:'/workspace',sessionIds:['a']};
 let hold=false,release;
 const s=setup({fetch:async(_url,opts)=>{
  if(opts?.method==='POST')return {ok:true,json:async()=>[{...initial,name:'After'}]};
  if(hold)return new Promise(resolve=>{release=resolve;});
  return {ok:true,json:async()=>[initial]};
 }});
 s.mod.showProjects(true);await tick();hold=true;await s.mod.audit.pollStatus();await tick();assert(release);
 s.mod.audit.edit(initial);const form=s.body.children.at(-1).children[0];
 form.querySelectorAll('input')[0].value='After';form.dispatchEvent({type:'submit',preventDefault(){}});await tick();
 release({ok:true,json:async()=>[initial]});await tick();
 assert.equal(descendants(s.root).find(n=>n.className==='project-name').textContent,'After');
});

test('slow or failed project refresh preserves the list and does not stall conversation polling',async()=>{
 const initial={id:'project',name:'Team',cwd:'/workspace',sessionIds:['a']};
 let mode='ready',release,reads=0;
 const s=setup({fetch:async()=>{
  reads++;
  if(mode==='slow')return new Promise(resolve=>{release=resolve;});
  if(mode==='fail')return {ok:false};
  return {ok:true,json:async()=>[initial]};
 }});
 s.mod.showProjects(true);await tick();mode='slow';const before=s.snapshots.length;
 await s.mod.audit.pollStatus();await s.mod.audit.pollStatus();assert.equal(s.snapshots.length,before+2);
 assert.equal(reads,2,'only one background project request may be in flight');
 assert.equal(descendants(s.root).find(n=>n.className==='project-name').textContent,'Team');
 release({ok:false});await tick();mode='fail';await s.mod.audit.pollStatus();await tick();
 assert.equal(descendants(s.root).find(n=>n.className==='project-name').textContent,'Team');
 mode='ready';await s.mod.audit.pollStatus();await tick();assert.equal(reads,4);
});
