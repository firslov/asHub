const test = require('node:test');
const assert = require('node:assert/strict');
const { env } = require('./harness.cjs');
const { El } = require('./ui-harness.cjs');
function setup() {
  const nodes = Object.fromEntries(['toggle', 'panel', 'input', 'close'].map(k => [k, new El()]));
  const changes = []; let focus;
  for (const [name, node] of Object.entries(nodes)) node.focus = () => { focus = name; };
  nodes.panel.contains = node => [nodes.input, nodes.close].includes(node);
  const { initSidebarSearch } = env().load('web/js/sidebar-search.js');
  const control = initSidebarSearch({ ...nodes, onChange: value => changes.push(value) });
  return { ...nodes, control, changes, focus: () => focus };
}
test('sidebar search opens on demand, and closing restores the unfiltered list', () => {
  const r = setup(); assert.equal(r.panel.hidden, true);
  r.toggle.dispatchEvent({type:'click'});
  assert.equal(r.panel.hidden, false); assert.equal(r.focus(), 'input');
  r.input.value = 'paper'; r.input.dispatchEvent({type:'input'});
  assert.deepEqual(r.changes, ['paper']); assert.equal(r.toggle.dataset.active, 'true');
  r.close.dispatchEvent({type:'click'});
  assert.deepEqual(r.changes, ['paper', '']); assert.equal(r.input.value, '');
  assert.equal(r.panel.hidden, true); assert.equal(r.focus(), 'toggle');
});
test('switching through unsupported views preserves and exposes the active query on return', () => {
  const r = setup(); r.input.value='folder'; r.input.dispatchEvent({type:'input'});
  r.control.setAvailable(false);
  assert.equal(r.toggle.hidden, true); assert.equal(r.panel.hidden, true);
  r.control.setAvailable(true);
  assert.equal(r.input.value, 'folder'); assert.equal(r.panel.hidden, false);
  assert.equal(r.toggle.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(r.changes, ['folder']);
});
test('Escape only dismisses search, respects IME, and clears filters', () => {
  const r=setup(); r.toggle.dispatchEvent({type:'click'});
  r.input.value='review'; r.input.dispatchEvent({type:'input'});
  let prevented=false,stopped=false;
  const event={type:'keydown',key:'Escape',isComposing:true,preventDefault(){prevented=true},stopPropagation(){stopped=true}};
  r.input.dispatchEvent(event); assert.equal(r.panel.hidden,false); assert.equal(prevented,false);
  r.input.dispatchEvent({...event,isComposing:false});
  assert.equal(prevented,true); assert.equal(stopped,true); assert.equal(r.panel.hidden,true);
  assert.equal(r.changes.at(-1),'');
});
test('focus leaving an empty search cannot move sidebar actions before pointer release', () => {
  const r=setup();r.toggle.dispatchEvent({type:'click'});
  r.panel.dispatchEvent({type:'focusout',relatedTarget:r.close});assert.equal(r.panel.hidden,false);
  r.input.value='paper';r.input.dispatchEvent({type:'input'});
  r.panel.dispatchEvent({type:'focusout',relatedTarget:null});assert.equal(r.panel.hidden,false);
  r.input.value='';r.input.dispatchEvent({type:'input'});
  r.panel.dispatchEvent({type:'focusout',relatedTarget:new El()});assert.equal(r.panel.hidden,false);
  r.close.dispatchEvent({type:'click'});assert.equal(r.panel.hidden,true);
});

test('Escape on the clear button also closes search without reaching conversation shortcuts', () => {
  const r=setup();r.toggle.dispatchEvent({type:'click'});let stopped=false;
  r.close.dispatchEvent({type:'keydown',key:'Escape',preventDefault(){},stopPropagation(){stopped=true}});
  assert.equal(stopped,true);assert.equal(r.panel.hidden,true);assert.equal(r.focus(),'toggle');
});
