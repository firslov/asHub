const test = require('node:test');
const assert = require('node:assert/strict');
const { env } = require('./harness.cjs');
const { El } = require('./ui-harness.cjs');

function setupUnified() {
  const input = new El(), results = Object.assign(new El(), {id:'find-results'});
  const selected = []; let dismissed = 0;
  const { findSidebarItems, initUnifiedSidebarSearch } = env({
    globals: { document: { createElement: () => Object.assign(new El(), {scrollIntoView(){}}) } },
    modules: {'./i18n.js': {lang:{value:'zh',peek:()=> 'zh'},t:key=>key}},
  }).load('web/js/sidebar-unified-search.js');
  const control = initUnifiedSidebarSearch({input, results, onSelect: hit=>selected.push(hit), onDismiss: ()=>dismissed++});
  const key = (key, isComposing=false) => {
    const event={type:'keydown',key,isComposing, stopped:false, prevented:false, stopPropagation(){this.stopped=true}, preventDefault(){this.prevented=true}};
    input.dispatchEvent(event); return event;
  };
  return { input, results, selected, dismissed:()=>dismissed, findSidebarItems, control, key };
}
const groups = [
  {id:'p1',name:'主项目',cwd:'/a/app',sessionIds:['a11111111','a22222222']},
  {id:'p2',name:'手机端',cwd:'C:\\workspace\\ios',sessionIds:['a33333333']},
];
const chats = [
  {instanceId:'a11111111',title:'发布检查',cwd:'/a/app'},
  {instanceId:'a22222222',title:'发布检查',cwd:'/a/app'},
  {instanceId:'a33333333',title:'发布检查',cwd:'C:\\workspace\\ios'},
  {instanceId:'a44444444',title:'发布检查',cwd:'/independent'},
  {instanceId:'t1',kind:'terminal',title:'发布检查'},
];

test('unified search finds Chinese titles, memberships, and independent conversations but not terminals',()=>{
  const {findSidebarItems}=setupUnified();
  const hits=findSidebarItems(groups,chats,' 发布检查 ');
  assert.equal(hits.projects.length,0); assert.equal(hits.sessions.length,4);
  assert.equal(new Set(hits.sessions.map(h=>h.detail)).size,4);
  assert(hits.sessions.some(h=>h.detail.includes('主项目') && h.projectId==='p1'));
  assert(hits.sessions.some(h=>h.detail.includes('sidebar.find.independent') && !h.projectId));
});
test('unified search ranks exact names and matches normalized Windows directories and project context',()=>{
  const {findSidebarItems}=setupUnified();
  const hits=findSidebarItems(groups.concat({id:'p3',name:'手机端备份',cwd:'/backup',sessionIds:[]}),chats,'手机端');
  assert.equal(hits.projects[0].id,'p2'); assert.equal(hits.sessions[0].id,'a33333333');
  assert.equal(findSidebarItems(groups,chats,'Ｃ:/WORKSPACE/IOS').projects[0].id,'p2');
});
test('an open search disambiguates a newly colliding directory and removes stale detail',()=>{
  const r=setupUnified();
  const one={instanceId:'aaaaaaa1',title:'周报',cwd:'/team-one/shared/notes'};
  const two={instanceId:'aaaaaaa2',title:'周报',cwd:'/team-two/shared/notes'};
  r.control.update([],[one]);r.control.open();r.control.setQuery('周报');
  const options=()=>r.results.children[1].children[0].children.slice(1);
  const detail=()=>options().map(row=>row.children[1].textContent);
  assert.deepEqual(detail(),['sidebar.find.independent']);
  r.control.update([],[one,two]);
  assert(detail()[0].includes(one.cwd)&&detail()[1].includes(two.cwd));
  r.control.update([],[one]);
  assert.deepEqual(detail(),['sidebar.find.independent']);
  r.key('Enter');assert.equal(r.selected[0].id,one.instanceId);
});
test('unified search prefers accepted project membership over an older session assignment',()=>{
  const {findSidebarItems}=setupUnified();
  const hits=findSidebarItems(groups,[{...chats[2],projectId:'p1'}],'发布');
  assert.equal(hits.sessions[0].projectId,'p2');
});
test('unified search Enter opens the selected ID after result ordering updates',()=>{
  const r=setupUnified(); r.control.update(groups,chats); r.control.open(); r.control.setQuery('发布');
  r.key('ArrowDown'); const firstId=r.input.getAttribute('aria-activedescendant');
  r.control.update(groups,chats.map((s,i)=>({...s,lastModified:1000*i})));
  assert.notEqual(r.input.getAttribute('aria-activedescendant'),firstId);
  r.key('Enter'); assert.equal(r.selected[0].id,'a22222222');
});
test('unified search consumes keyboard navigation while letting Chinese IME handle composition keys',()=>{
  const r=setupUnified(); r.control.update(groups,chats); r.control.open();
  r.input.dispatchEvent({type:'compositionstart'}); r.input.value='发布'; r.input.dispatchEvent({type:'input'});
  assert.equal(r.input.getAttribute('aria-expanded'),'false');
  assert.deepEqual([r.key('Enter',true).prevented,r.key('Escape',true).stopped,r.dismissed(),r.selected.length],[false,true,0,0]);
  r.input.dispatchEvent({type:'compositionend'}); assert.equal(r.input.getAttribute('aria-expanded'),'true');
  r.key('Escape'); assert.equal(r.dismissed(),1);
});
test('unified search clears accessibility selection and does not navigate while closed or with no matches',()=>{
  const r=setupUnified(); r.control.update(groups,chats); r.control.open(); r.control.setQuery('not present');
  assert.equal(r.input.getAttribute('aria-expanded'),'false'); r.key('Enter'); assert.equal(r.selected.length,0);
  r.control.setQuery('发布'); r.control.close(); assert.equal(r.input.getAttribute('aria-activedescendant'),null);
  assert.equal(r.key('Escape').stopped,false); assert.equal(r.dismissed(),0);
});
