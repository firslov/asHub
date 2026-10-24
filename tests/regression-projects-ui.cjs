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
  const root=new Node(),body=new Node(); const calls=[];
  const project={id:'project',name:'Existing',sessionIds:['a','archived']};
  let fail=false;
  const document={body,activeElement:null,createElement:tag=>new Node(tag),getElementById:id=>id==='projects'?root:null,addEventListener(){}};
  const e=env({modules:{
    './store.js':{allSessions:{value:[{instanceId:'a',title:'Alpha',kind:'agent'},{instanceId:'b',title:'Beta',kind:'agent'}]}},
    './session-manager.js':{activeSessionId:{value:''},spaEnabled:()=>false},
    '../vendor/signals-core.js':{effect:fn=>fn()}, './i18n.js':{t:key=>key},
  }, globals:{document,window:new Node(),localStorage:{getItem:()=>null,setItem(){}},fetch:async(url,opts)=>{
    if (url === '/sessions') return {ok:true,json:async()=>[]};
    if (url === '/api/projects/workspaces') return {ok:true,json:async()=>({})};
    calls.push({url,body:opts?.body?JSON.parse(opts.body):null});
    if (options.fetch) return options.fetch(url, opts);
    return {ok:!fail,json:async()=>[project]};
  }}});
  const mod=e.load('web/js/projects.js','export const audit={edit,taskHistory};');
  return {mod,root,body,calls,project,fail:()=>fail=true};
}
test('project picker preserves hidden and archived selections and sends only membership deltas',async()=>{
 const s=setup();s.mod.showProjects(true);await tick();s.mod.audit.edit(s.project);
 const dialog=s.body.children.at(-1),form=dialog.children[0],inputs=form.querySelectorAll('input');
 const [name,search,a,b]=inputs;assert.equal(a.checked,true);assert.equal(b.checked,false);
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
 form.querySelectorAll('input')[0].value='Draft';
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
 form.querySelectorAll('input')[0].value='New';
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
