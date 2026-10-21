const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, El } = require('./ui-harness.cjs');
const tick = () => new Promise(setImmediate);
const ok = data => ({ok:true,json:async()=>data});
const online = {available:true,enabled:true,status:'online',username:'alice',deviceName:'Laptop',roots:['/project'],gateway:'https://example.test/mobile/'};
function setup() {
  const u=ui(), panel=new El(), fields=new Map(); let registration;
  const form=panel.querySelector('#mobile-form');
  form.elements={namedItem(name){if(!fields.has(name))fields.set(name,new El());return fields.get(name)}};
  u.doc.createElement=tag=>tag==='section'?panel:new El();
  u.modules['./panel-manager.js']={registerPanel(name,definition){registration=definition;}};
  u.e.context.FormData=class {constructor(){assert.equal(panel.querySelector('#mobile-fields').disabled,false,'fields disabled before payload capture');return [...fields].filter(([k,v])=>k!=='create'||v.checked).map(([k,v])=>[k,k==='create'?'on':v.value]);}};
  u.e.context.fetch=async()=>ok(online);
  u.e.load('web/js/mobile-access.js');
  return {...u,panel,form,field:name=>form.elements.namedItem(name),el:id=>panel.querySelector('#'+id),open:()=>registration.open(),close:()=>registration.close()};
}
test('mobile panel loads saved authorization and polling preserves edited fields',async()=>{
 const u=setup();u.open();await tick();assert.equal(u.field('roots').value,'/project');assert.equal(u.el('mobile-connect').textContent,'更新授权');
 u.field('roots').value='/edited';for(const t of u.e.timers.values())t.fn();await tick();assert.equal(u.field('roots').value,'/edited');
 u.field('password').value='secret';u.close();assert.equal(u.field('password').value,'');assert.equal(u.e.timers.size,0);assert(u.panel.hidden);
});
test('closed and reopened panel ignores late initial reads',async()=>{
 const u=setup(),reads=[];u.e.context.fetch=()=>new Promise(resolve=>reads.push(resolve));u.open();u.close();u.open();
 reads[1](ok({...online,username:'current'}));await tick();u.field('roots').value='/new-draft';reads[0](ok({...online,username:'stale'}));await tick();
 assert.equal(u.field('username').value,'current');assert.equal(u.field('roots').value,'/new-draft');
});
test('failed initial load locks actions and retry recovers',async()=>{
 const u=setup();u.e.context.fetch=async()=>{throw Error('offline')};u.open();await tick();assert(u.el('mobile-connect').disabled);assert(u.el('mobile-disable').disabled);assert.equal(u.el('mobile-retry').hidden,false);
 u.e.context.fetch=async()=>ok(online);await u.el('mobile-retry').onclick();await tick();assert.equal(u.el('mobile-connect').disabled,false);assert(u.el('mobile-retry').hidden);
});
test('binding captures the complete form before locking and blocks concurrent disconnect',async()=>{
 const u=setup();u.open();await tick();u.field('password').value='test password';u.field('roots').value=' /project\n /second ';u.field('create').checked=true;
 const calls=[];let resolve;u.e.context.fetch=(url,opts)=>{calls.push({url,opts});return url.endsWith('/connect')?new Promise(r=>resolve=r):Promise.resolve(ok(online));};
 const pending=u.form.onsubmit({preventDefault(){}});assert(u.el('mobile-fields').disabled);await u.el('mobile-disable').onclick();assert.equal(calls.length,1);
 assert.deepEqual(JSON.parse(calls[0].opts.body),{username:'alice',deviceName:'Laptop',roots:['/project','/second'],password:'test password',create:true});
 assert.equal(calls[0].opts.headers['X-Ashub-Local'],'1');resolve(ok({recovery:'test-recovery'}));await pending;
 assert.equal(u.field('password').value,'');assert.equal(u.el('mobile-recovery').hidden,false);assert.equal(u.el('mobile-fields').disabled,false);
});
test('a directory picker completing after close cannot alter a reopened draft',async()=>{
 const u=setup();let resolve;u.e.context.window.electronAPI={pickDirectory:()=>new Promise(r=>resolve=r)};u.open();await tick();const pick=u.el('mobile-pick').onclick();
 u.close();u.open();await tick();u.field('roots').value='/draft';resolve({cwd:'/late'});await pick;assert.equal(u.field('roots').value,'/draft');
});
test('binding errors remain visible until explicit retry instead of polling them away',async()=>{
 const u=setup();u.open();await tick();u.e.context.fetch=async()=>({ok:false,json:async()=>({error:'密码不正确'})});await u.form.onsubmit({preventDefault(){}});
 for(const t of u.e.timers.values())t.fn();await tick();assert.equal(u.el('mobile-status').textContent,'密码不正确');assert.equal(u.el('mobile-retry').hidden,false);assert.equal(u.el('mobile-connect').disabled,false);
});

function recoveryCards(u) { return u.el('mobile-recovery').children.filter(el=>el.className==='mobile-recovery-card'); }
function recoveryText(u) { const text=el=>[el.textContent||'',...el.children.map(text)].join(' ');return text(u.el('mobile-recovery')); }
async function binding(u,result) {
 u.e.context.fetch=url=>Promise.resolve(ok(url.endsWith('/connect')?result:online));
 await u.form.onsubmit({preventDefault(){}});
}
for (const reopenEarly of [false,true]) test(`registration recovery survives panel close (${reopenEarly?'reopen before':'reopen after'} response)`,async()=>{
 const u=setup();u.open();await tick();u.field('password').value='test password';u.field('create').checked=true;
 let resolve;u.e.context.fetch=url=>url.endsWith('/connect')?new Promise(r=>resolve=r):Promise.resolve(ok(online));
 const pending=u.form.onsubmit({preventDefault(){}});u.close();
 if(reopenEarly){u.open();await tick();}
 resolve(ok({username:'alice',recovery:'alice-only-code'}));await pending;
 if(!reopenEarly){assert(u.el('mobile-recovery').hidden);assert(!recoveryText(u).includes('alice-only-code'));u.open();await tick();}
 assert.equal(u.field('password').value,'');assert.equal(u.el('mobile-recovery').hidden,false);
 assert(recoveryText(u).includes('alice-only-code'));assert(recoveryText(u).includes('alice'));
});
test('unacknowledged recovery survives repeated menu switches; confirmation clears it',async()=>{
 const u=setup();u.open();await tick();await binding(u,{username:'alice',recovery:'keep-until-saved'});
 for(let i=0;i<3;i++){u.close();assert(!recoveryText(u).includes('keep-until-saved'));u.open();await tick();assert(recoveryText(u).includes('keep-until-saved'));}
 const confirm=recoveryCards(u)[0].children.find(el=>el.textContent==='我已保存');assert(confirm);confirm.onclick();
 assert(u.el('mobile-recovery').hidden);assert(!recoveryText(u).includes('keep-until-saved'));
 u.close();u.open();await tick();assert(u.el('mobile-recovery').hidden);assert(!recoveryText(u).includes('keep-until-saved'));
});
test('ordinary rebind and status read failure preserve pending recovery',async()=>{
 const u=setup();u.open();await tick();await binding(u,{username:'alice',recovery:'keep-through-rebind'});
 await binding(u,{username:'alice'});assert(recoveryText(u).includes('keep-through-rebind'));
 u.close();u.e.context.fetch=async()=>{throw Error('offline')};u.open();await tick();assert(recoveryText(u).includes('keep-through-rebind'));assert.equal(u.el('mobile-recovery').hidden,false);
});
test('registering another account retains each code until its own acknowledgement',async()=>{
 const u=setup();u.open();await tick();await binding(u,{username:'alice',recovery:'alice-code'});await binding(u,{username:'bravo',recovery:'bravo-code'});
 assert.equal(recoveryCards(u).length,2);const first=recoveryCards(u)[0];assert(recoveryText(u).includes('alice-code'));assert(recoveryText(u).includes('bravo-code'));
 first.children.find(el=>el.textContent==='我已保存').onclick();assert(!recoveryText(u).includes('alice-code'));assert(recoveryText(u).includes('bravo-code'));
 u.close();u.open();await tick();assert.equal(recoveryCards(u).length,1);assert(recoveryText(u).includes('bravo-code'));
});
