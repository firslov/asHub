import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mobileReplayFrame } from '../dist/remote/replay.js';
class Element {
  constructor() {
    this.children = []; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.dataset = {}; this.className = '';
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); if (force ?? !names.has(name)) names.add(name); else names.delete(name); this.className = [...names].join(' '); }
    };
    this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0;
  }
  append(...items) { for (const item of items) { item.remove(); item.parentNode = this; item.isConnected = true; this.children.push(item); } }
  insertBefore(item, reference) {
    item.remove(); const index = this.children.indexOf(reference);
    if (index < 0) throw Error('Reference is not a child');
    item.parentNode = this; item.isConnected = true; this.children.splice(index, 0, item); return item;
  }
  appendChild(item) { this.append(item); return item; }
  replaceChildren(...items) { for (const item of [...this.children]) item.remove(); this.append(...items); }
  querySelector(selector) { return this.children.find(child => selector.startsWith('.') && child.classList.contains(selector.slice(1))) || null; }
  querySelectorAll(selector) { return selector === '.compaction-marker' ? this.children.filter(n=>n.classList.contains('compaction-marker')) : []; }
  setAttribute(k,v) { this[k] = String(v); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; this.isConnected = false; }
  close() { this.open = false; }
  showModal() { this.open = true; }
  reset() {}
  focus() { this.focused = true; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
}
// Session rows now live in collapsible project groups, rather than a flat list.
const sessionRows = r => {
  const rows = [];
  const visit = node => { for (const child of node.children) { if (child.classList.contains('session-button')) rows.push(child); else visit(child); } };
  visit(r.$('sessions')); return rows;
};
const ok = data => ({ ok: true, json: async () => data });
const failure = (status, error) => ({ ok: false, status, json: async () => ({ error }) });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const pageUrl = new URL('./public/index.html', import.meta.url);
const pageScripts = [...fs.readFileSync(pageUrl, 'utf8').matchAll(/<script\b[^>]*src=["']([^"']+)["']/g)]
  .map(([, src]) => ({ src, source: fs.readFileSync(new URL(src, pageUrl), 'utf8') }));
// Keep the DOM-independent vendor doubles, but load application dependencies
// from HTML in browser order so newly introduced scripts cannot be omitted.
const stubbedScripts = new Set(['./marked.min.js', './dompurify.min.js']);
function setup({pwa = false, legacySidebar = false, mobile = false} = {}) {
  const listeners = new Map();
  const elements = new Map(), timers = new Map(), intervals = new Map(), stored = new Map(); let next = 0;
  const $ = id => { if (legacySidebar && ['session-search-panel','session-search-toggle','session-search-close'].includes(id)) return null; if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let fetcher = async () => { throw Error('offline'); };
  const context = vm.createContext({ document: { getElementById: $, createElement: () => new Element(), querySelector: () => null, documentElement: { dataset: {} }, body: new Element(), addEventListener(name, fn, options) { listeners.set(name,{fn,options}); } }, location: { href: 'https://example.test/mobile/' }, URL, AbortSignal, AbortController, crypto, navigator: {}, window: { addEventListener(name, fn) { listeners.set('window:'+name,{fn}); } }, matchMedia: query => ({ matches: (pwa && query === '(display-mode: standalone)') || (mobile && query === '(max-width:760px)') }), localStorage: { getItem: k => stored.get(k) ?? null, setItem: (k,v) => stored.set(k,v), removeItem: k => stored.delete(k) }, setTimeout: f => { timers.set(++next, f); return next; }, clearTimeout: id => timers.delete(id), setInterval: f => { intervals.set(++next, f); return next; }, clearInterval: id => intervals.delete(id), fetch: (...args) => fetcher(...args), FormData: class { constructor() { return [['username','alice'], ['password','test password']]; } }, DOMPurify: { sanitize: s => s }, marked: { parse: s => s } });
  for (const { src, source } of pageScripts) {
    if (!stubbedScripts.has(src)) vm.runInContext(source, context, { filename: src });
  }
  const run = code => vm.runInContext(code, context);
  const send = (name, payload = {}) => { context.input = { meta: { name }, payload }; run('frame(input)'); };
  return { $, context, run, send, timers, intervals, stored, listeners, fetch: fn => { fetcher = fn; }, replies: () => $('messages').children.filter(e => e.className === 'message reply').map(e => e.innerHTML) };
}
test('page script order loads shared presentation rules before the app consumes them', () => {
  const r = setup();
  assert.equal(r.context.AsHubConversationPresentation.toolActivityKey({ name: 'read_file' }), 'activity.reading');
  for (const [total, expected] of [[3000, '3.0k tokens'], [0, '0.0k tokens'], [undefined, '1.5k tokens']]) {
    r.send('agent:usage', { prompt_tokens: 1000, completion_tokens: 500, total_tokens: total });
    assert.equal(r.$('usage').textContent, expected);
  }
});
test('live completion followed by stored segment renders exactly once', () => {
  const r = setup(); r.send('agent:query', { query: 'hello' });
  r.send('agent:response-chunk', { blocks: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: '🟡' }] });
  r.send('agent:response-done', { response: 'Hello 🟡' });
  r.send('agent:response-segment', { text: 'Hello 🟡' }); r.send('agent:processing-done');
  assert.deepEqual(r.replies(), ['Hello 🟡']);
});
test('replayed tool steps and final answer retain their order without duplication', () => {
  const r = setup(); r.send('agent:query', { query: 'review' });
  r.send('agent:response-segment', { text: 'I will inspect.' });
  r.send('agent:tool-started', { name: 'read_file' });
  r.send('agent:response-done', { response: 'Done.' });
  r.send('agent:response-segment', { text: 'Done.' }); r.send('agent:processing-done');
  assert.deepEqual(r.replies(), ['I will inspect.', 'Done.']);
  assert.equal(r.$('messages').children.filter(e => e.className === 'detail').length, 1);
});
test('branch reset discards old content and activity before fresh replay', () => {
  const r = setup(); r.send('agent:processing-start'); r.send('agent:response-chunk', { blocks: [{ type: 'text', text: 'Old' }] });
  r.send('hub:branch-switched'); r.send('agent:response-segment', { text: 'New' }); r.send('agent:processing-done');
  assert.deepEqual(r.replies(), ['New']); assert.equal(r.$('activity').hidden, true);
});

test('mid-turn replay flush plus full completion and tail stays one reply', () => {
  const r = setup(); r.send('agent:query', { query: 'hello' }); r.send('agent:processing-start');
  r.send('agent:response-segment', { text: 'First part. ' });
  r.send('agent:response-done', { response: 'First part. Final part.' });
  r.send('agent:response-segment', { text: 'Final part.' }); r.send('agent:processing-done');
  assert.deepEqual(r.replies(), ['First part. Final part.']);
});
test('replay switches to live chunks across flushes without duplication or dropped text', () => {
  const r = setup(); r.send('agent:response-segment', { text: 'First ' }); r.send('hub:replay-done');
  r.send('agent:response-chunk', { blocks: [{ type: 'text', text: 'second ' }] });
  r.send('agent:response-segment', { text: 'second ' });
  r.send('agent:response-chunk', { blocks: [{ type: 'text', text: '🟡' }] });
  r.send('agent:response-done', { response: 'First second 🟡' });
  r.send('agent:response-segment', { text: '🟡' }); r.send('agent:processing-done');
  assert.deepEqual(r.replies(), ['First second 🟡']);
});
for (const list of [[], [{id: 'offline', name: 'B computer', online: false}]]) {
  test(`account switch clears private UI with ${list.length ? 'offline' : 'no'} devices`, async () => {
    const r = setup();
    r.run("user='alice'; device='old'; session='abcdef'; devices=[{id:'old',online:true}]; sessions=[{title:'Private project'}]; images=[{name:'private.png'}]; sending=true; notice('private error'); modal('private title',[el('p','private content')]); renderAttachments()");
    r.$('sessions').append(new Element()); r.$('chat-project').textContent = 'Private project'; r.$('chat-project').hidden=false; r.$('chat-title').textContent = 'Private title'; r.$('query').value = 'private draft'; r.$('session-search').value = 'private project';
    r.send('agent:response-chunk', { blocks: [{type:'text',text:'Private reply'}] });
    r.run('signOut()'); r.fetch(async () => ok(list)); await r.run("start('bravo')");
    for (const id of ['sessions','attachments','modal-body']) assert.equal(r.$(id).children.length, 0, id);
    for (const id of ['chat-title','chat-project','notice','modal-title']) assert.equal(r.$(id).textContent, '', id);
    assert.equal(r.$('query').value, ''); assert.equal(r.$('session-search').value, ''); assert.equal(r.$('modal').open, false);
    assert.equal(r.run('sessions.length + images.length + permissions.size'), 0);
    assert.equal(r.run('sending'), false); assert.equal(r.timers.size, 0);
    assert.equal(r.stored.get('ashub-mobile:alice:old:abcdef:draft'), 'private draft');
  });
}
for (const handler of ['account','model','new-chat']) {
  test(`late ${handler} response cannot expose the old account dialog`, async () => {
    const r = setup(), pending = deferred(); r.run("user='alice';device='old';session='abcdef'"); r.fetch(() => pending.promise);
    const opening = r.$(handler).onclick(); r.run('signOut()'); r.fetch(async () => ok([])); await r.run("start('bravo')");
    pending.resolve(ok(handler === 'model' ? {providers:[]} : [{id:'old', name:'Private project'}])); await opening;
    assert.notEqual(r.$('modal').open, true); assert.equal(r.$('modal-body').children.length, 0);
  });
}
test('initial device refresh failure keeps a single recovery poll and shows workspace error', async () => {
  const r = setup(); r.fetch(async () => failure(503, 'temporarily unavailable')); await r.run("start('alice')");
  assert.equal(r.intervals.size, 1); assert.equal(r.$('notice').textContent, 'temporarily unavailable');
  r.fetch(async () => ok([{id:'desktop',name:'My computer',online:false}]));
  const tick = [...r.intervals.values()][0]; tick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.run('device'), 'desktop'); assert.equal(r.$('device-status').textContent, '○ 电脑离线');
  await r.run("start('bravo')"); assert.equal(r.intervals.size, 1);
  r.run('signOut()'); assert.equal(r.intervals.size, 0);
});
test('initial session RPC failure also recovers and expired login stops polling', async () => {
  const r = setup(); let fail = true;
  r.fetch(async url => String(url).endsWith('/devices') ? ok([{id:'desktop',name:'Computer',online:true}]) : fail ? failure(503,'desktop busy') : ok([{instanceId:'abcdef',title:'Recovered'}]));
  await r.run("start('alice')"); assert.equal(r.intervals.size, 1); assert.equal(r.$('notice').textContent,'desktop busy');
  fail = false; [...r.intervals.values()][0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(sessionRows(r)[0].children[0].textContent, 'Recovered');
  r.fetch(async () => failure(401,'expired')); [...r.intervals.values()][0](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.intervals.size, 0); assert.equal(r.$('workspace').hidden, true);
});
test('successful registration still displays recovery code when initial sync fails', async () => {
  const r = setup(); r.run("auth('register')");
  r.fetch(async url => String(url).endsWith('/register') ? ok({username:'alice',recovery:'save-this-code'}) : failure(503,'offline'));
  await r.$('login-form').onsubmit({ preventDefault(){}, target:r.$('login-form') });
  assert.equal(r.$('modal').open, true); assert.equal(r.$('modal-body').children[1].textContent, 'save-this-code'); assert.equal(r.intervals.size, 1);
});
test('late initial refresh cannot overwrite a different account or its polling', async () => {
  const r = setup(), pending = deferred(); r.fetch(() => pending.promise); const first = r.run("start('alice')");
  r.run('signOut()'); r.fetch(async () => ok([])); await r.run("start('bravo')");
  pending.resolve(failure(503,'Alice private error')); await first;
  assert.equal(r.run('user'), 'bravo'); assert.equal(r.$('notice').textContent, ''); assert.equal(r.intervals.size, 1);
});
test('successful send removes only submitted attachments and preserves later text and images', async () => {
  const r = setup(), pending = deferred(); let sent;
  r.fetch(async (url, options) => { const body = JSON.parse(options.body); if (body.op === 'submit') { sent = body.args; return pending.promise; } return ok({state:'done'}); });
  r.run("user='alice';device='computer';session='abcdef';streamReady=true;images=[{name:'sent.png',data:'AAAA',mimeType:'image/png'}]"); r.$('query').value = 'first draft';
  const sending = r.$('composer').onsubmit({preventDefault(){}});
  r.run("images.push({name:'next.png',data:'BBBB',mimeType:'image/png'})"); r.$('query').value = 'next draft';
  pending.resolve(ok({state:'pending'})); await sending;
  assert.equal(sent.images.length,1); assert.equal(sent.images[0].data,'AAAA');
  assert.equal(r.run('images.length'),1); assert.equal(r.run('images[0].name'),'next.png'); assert.equal(r.$('attachments').children[0].textContent,'next.png ×'); assert.equal(r.$('query').value,'next draft');
  assert.equal(r.run('sending'),false);
});
test('failed send with uncertain outcome retains attachments for inspection', async () => {
  const r = setup(); r.fetch(async (url, options) => JSON.parse(options.body).op === 'submit' ? failure(503,'offline') : ok({state:'unknown'}));
  r.run("user='alice';device='computer';session='abcdef';streamReady=true;images=[{name:'draft.png',data:'AAAA',mimeType:'image/png'}]"); r.$('query').value='keep draft';
  await r.$('composer').onsubmit({preventDefault(){}});
  assert.equal(r.run('images.length'),1); assert.equal(r.$('query').value,'keep draft'); assert.equal(r.run('sending'),false);
});

test('actual Hub replay after a mid-turn client connection renders one complete reply', () => {
  const output=execFileSync(process.execPath,[fileURLToPath(new URL('./replay-fixture.cjs',import.meta.url))],{encoding:'utf8',timeout:20000});
  const frames=JSON.parse(output.split('\n').find(s=>s.startsWith('REPLAY ')).slice(7));
  const r=setup(); for(const data of frames) r.send(data.meta.name,data.payload);
  assert.deepEqual(r.replies(),['First part. Final part.']);
});

for (const state of ['unknown', 'missing']) {
  test(`relay acceptance followed by ${state} retains image and text drafts`, async () => {
    const r = setup();
    r.run("user='alice';device='computer';session='abcdef';streamReady=true;images=[{name:'draft.png',data:'AAAA',mimeType:'image/png'}];renderAttachments()"); r.$('query').value = 'image question';
    r.fetch(async (url, options) => JSON.parse(options.body).op === 'submit' ? ok({state:'pending'}) : ok({state}));
    await r.$('composer').onsubmit({preventDefault(){}});
    assert.equal(r.run('images.length'),1); assert.equal(r.$('attachments').children[0].textContent,'draft.png ×');
    assert.equal(r.$('query').value,'image question'); assert.equal(r.run('sending'),false);
  });
}
test('lost submit response cleans only confirmed submitted images, keeping the next draft', async () => {
  const r=setup(), response=deferred();
  r.run("user='alice';device='computer';session='abcdef';streamReady=true;images=[{name:'sent.png',data:'AAAA',mimeType:'image/png'}]"); r.$('query').value='send image';
  r.fetch(async (url,options)=> { if(JSON.parse(options.body).op==='submit') { await response.promise; throw Error('response lost'); } return ok({state:'done'}); });
  const sending=r.$('composer').onsubmit({preventDefault(){}});
  r.run("images.push({name:'next.png',data:'BBBB',mimeType:'image/png'})"); r.$('query').value='next question'; response.resolve(); await sending;
  assert.equal(r.run('images.length'),1); assert.equal(r.run('images[0].name'),'next.png'); assert.equal(r.$('query').value,'next question'); assert.equal(r.run('sending'),false);
});
test('a separate pending-status poll reconciles attachments before the submit response arrives', async () => {
  const r=setup(), response=deferred();
  r.run("user='alice';device='computer';session='abcdef';streamReady=true;images=[{name:'sent.png',data:'AAAA',mimeType:'image/png'}]"); r.$('query').value='send image';
  r.fetch(async(url,options)=>JSON.parse(options.body).op==='submit'?response.promise:ok({state:'done'}));
  const sending=r.$('composer').onsubmit({preventDefault(){}});
  await r.run("checkPending(storage.get(key('pending')),generation,key('pending'))");
  assert.equal(r.run('images.length'),0); assert.equal(r.$('query').value,'');
  r.run("images.push({name:'next.png',data:'BBBB',mimeType:'image/png'})"); r.$('query').value='next question';
  response.resolve(ok({state:'pending'})); await sending;
  assert.equal(r.run('images[0].name'),'next.png'); assert.equal(r.$('query').value,'next question');
});
for(const removed of [false,true]) {
  test(`${removed?'removing the selected device':'switching to an offline device'} clears old interface state`,async()=>{
    const r=setup(),response=deferred();
    r.run("user='alice';device='online';session='abcdef';devices=[{id:'online',online:true}];sessions=[{instanceId:'abcdef',title:'Old'}];images=[{name:'old.png'}];renderAttachments();setActivity(true);modal('Old model',[el('p','Old details')]);streamReady=true;sending=true");
    r.$('sessions').append(new Element());r.$('chat-title').textContent='Old title';r.$('query').value='saved draft';r.$('model').textContent='Old model';
    r.send('agent:response-chunk',{blocks:[{type:'text',text:'Old reply'}]});
    r.fetch(()=>response.promise);
    let change;
    if(removed) change=r.run('refreshDevices()');
    else {r.$('devices').value='offline';change=r.$('devices').onchange();assert.equal(r.$('sessions').children.length,0);}
    response.resolve(ok([{id:'offline',name:'Offline',online:false}]));await change;
    assert.equal(r.run('device'),'offline');assert.equal(r.run('session'),'');assert.equal(r.run('sessions.length'),0);
    for(const id of ['sessions','attachments','modal-body'])assert.equal(r.$(id).children.length,0,id);
    assert.equal(r.$('chat-title').textContent,'');assert.equal(r.$('model').textContent,'模型');assert.equal(r.$('activity').hidden,true);assert.equal(r.timers.size,0);
    assert.equal(r.$('query').disabled,true);assert.equal(r.$('send').disabled,true);assert.equal(r.$('new-chat').disabled,true);assert.equal(r.$('modal').open,false);
    assert.equal(r.stored.get('ashub-mobile:alice:online:abcdef:draft'),'saved draft');
  });
}
for(const switchTo of ['conversation','account']) {
  test(`late create refresh cannot replace a newer ${switchTo} selection`,async()=>{
    const r=setup(),response=deferred();let refreshing=false;
    r.context.EventSource=class {addEventListener(){}close(){}};
    r.run("user='alice';device='computer';session='aaaaaa';devices=[{id:'computer',online:true}];sessions=[{instanceId:'aaaaaa',title:'Original'},{instanceId:'bbbbbb',title:'Chosen'}]");
    r.fetch(async(url,opts)=>{const b=JSON.parse(opts.body);if(b.op==='projects')return ok([{id:'stable-project',name:'Project'}]);if(b.op==='create')return ok({state:'pending'});if(b.op==='request-status')return ok({state:'done',result:{instanceId:'cccccc'}});if(b.op==='sessions'){refreshing=true;return response.promise;}throw Error('unexpected');});
    await r.$('new-chat').onclick();const creation=r.$('modal-body').children[0].onclick();
    await new Promise(resolve=>setImmediate(resolve));assert.equal(refreshing,true);
    if(switchTo==='conversation') await r.run("openSession('bbbbbb')");
    else {r.run('signOut()');r.fetch(async()=>ok([]));await r.run("start('bravo')");}
    response.resolve(ok([{instanceId:'cccccc',title:'New'}]));await creation;
    assert.equal(r.run('session'),switchTo==='conversation'?'bbbbbb':'');
    assert.equal(r.run('user'),switchTo==='conversation'?'alice':'bravo');
  });
}
for(const mode of ['login','register','recover']) {
  test(`${mode} handles its original request mode even if the view changes while waiting`,async()=>{
    const r=setup(),response=deferred();let calls=0;
    r.$('workspace').hidden=true;r.$('auth').hidden=false;r.run(`auth('${mode}')`);
    r.fetch(async url=>{if(String(url).endsWith('/'+mode)){calls++;return response.promise;}return ok([]);});
    const e={preventDefault(){},target:r.$('login-form')},submission=r.$('login-form').onsubmit(e);
    for(const id of ['auth-submit','auth-mode','recover-mode'])assert.equal(r.$(id).disabled,true,id);
    await r.$('login-form').onsubmit(e);assert.equal(calls,1);
    r.run(`auth('${mode==='recover'?'login':'recover'}')`);
    response.resolve(ok(mode==='recover'?{recovery:'new-code'}:{username:'alice',...(mode==='register'?{recovery:'new-code'}:{})}));await submission;
    assert.equal(r.run('user'),mode==='recover'?'':'alice');
    assert.equal(r.$('workspace').hidden,mode==='recover');
    if(mode!=='login')assert.equal(r.$('modal-body').children[1].textContent,'new-code');
    for(const id of ['auth-submit','auth-mode','recover-mode'])assert.equal(r.$(id).disabled,false,id);
  });
}
test('failed authentication restores all mode controls for retry',async()=>{
  const r=setup();r.fetch(async()=>failure(401,'invalid password'));
  await r.$('login-form').onsubmit({preventDefault(){},target:r.$('login-form')});
  for(const id of ['auth-submit','auth-mode','recover-mode'])assert.equal(r.$(id).disabled,false,id);
  assert.equal(r.run('authSubmitting'),false);assert.equal(r.$('auth-error').textContent,'invalid password');
});

for (const failing of [['setItem'], ['getItem','setItem','removeItem'], ['removeItem']]) {
  test(`send confirmation works when browser storage fails: ${failing.join(',')}`, async () => {
    const r=setup();let submissions=0;
    for(const method of failing) r.context.localStorage[method]=()=>{throw Error('storage unavailable');};
    r.run("user='alice';device='computer';session='abcdef';streamReady=true;devices=[{id:'computer',online:true}];images=[{name:'sent.png',data:'AAAA',mimeType:'image/png'}];renderAttachments()");r.$('query').value='send once';
    r.fetch(async(url,opts)=>{if(JSON.parse(opts.body).op==='submit'){submissions++;return ok({state:'pending'});}return ok({state:'done'});});
    await r.$('composer').onsubmit({preventDefault(){}});
    assert.equal(r.$('query').value,'');assert.equal(r.run('images.length'),0);assert.equal(r.run("storage.get(key('pending'))"),null);assert.equal(r.run('sending'),false);
    await r.$('composer').onsubmit({preventDefault(){}});assert.equal(submissions,1);
  });
}
test('storage failure preserves unknown drafts and newly added attachments',async()=>{
  const r=setup(),response=deferred();
  r.context.localStorage.setItem=()=>{throw Error('quota');};
  r.run("user='alice';device='computer';session='abcdef';streamReady=true;images=[{name:'first.png',data:'AAAA',mimeType:'image/png'}]");r.$('query').value='first';
  r.fetch(async(url,opts)=>JSON.parse(opts.body).op==='submit'?response.promise:ok({state:'unknown'}));
  const send=r.$('composer').onsubmit({preventDefault(){}});
  r.run("images.push({name:'next.png',data:'BBBB',mimeType:'image/png'})");r.$('query').value='next';response.resolve(ok({state:'pending'}));await send;
  assert.equal(r.run('images.length'),2);assert.equal(r.$('query').value,'next');assert.equal(r.run('sending'),false);
});
test('foreground missing status cannot unlock a submit still in flight',async()=>{
  const r=setup(),response=deferred();let status='missing',submissions=0;
  r.run("user='alice';device='computer';session='abcdef';streamReady=true;devices=[{id:'computer',online:true}]");r.$('query').value='once';
  r.fetch(async(url,opts)=>{if(JSON.parse(opts.body).op==='submit'){submissions++;return response.promise;}return ok({state:status});});
  const send=r.$('composer').onsubmit({preventDefault(){}});
  await r.run("checkPending(storage.get(key('pending')),generation,key('pending'))");
  assert.equal(r.run('sending'),true);assert.equal(r.$('send').disabled,true);
  await r.$('composer').onsubmit({preventDefault(){}});assert.equal(submissions,1);
  status='done';response.resolve(ok({state:'pending'}));await send;
  assert.equal(r.run('sending'),false);assert.equal(r.$('query').value,'');
});
test('a stale missing snapshot taken during upload cannot clear a settled pending request',async()=>{
  const r=setup(),submit=deferred(),snapshot=deferred();let polls=0;
  r.run("user='alice';device='computer';session='abcdef';streamReady=true");r.$('query').value='once';
  r.fetch(async(url,opts)=>JSON.parse(opts.body).op==='submit'?submit.promise:++polls===1?snapshot.promise:ok({state:polls===2?'pending':'done'}));
  const send=r.$('composer').onsubmit({preventDefault(){}});
  const poll=r.run("checkPending(storage.get(key('pending')),generation,key('pending'))");
  submit.resolve(ok({state:'pending'}));await send;snapshot.resolve(ok({state:'missing'}));await poll;
  assert.equal(r.run('sending'),true);assert.ok(r.run("storage.get(key('pending'))"));
  await r.run("checkPending(storage.get(key('pending')),generation,key('pending'))");assert.equal(r.run('sending'),false);assert.equal(r.$('query').value,'');
});
test('switching away and back preserves the in-flight guard even without persistent storage',async()=>{
  const r=setup(),response=deferred();let status='missing';
  r.context.EventSource=class{addEventListener(){}close(){}};r.context.localStorage.setItem=()=>{throw Error('quota');};
  r.run("user='alice';device='computer';session='abcdef';streamReady=true;devices=[{id:'computer',online:true}]");r.$('query').value='once';
  r.fetch(async(url,opts)=>JSON.parse(opts.body).op==='submit'?response.promise:ok({state:status}));
  const send=r.$('composer').onsubmit({preventDefault(){}});
  await r.run("openSession('bbbbbb')");await r.run("openSession('abcdef')");await new Promise(resolve=>setImmediate(resolve));
  assert.equal(r.run('sending'),true);assert.equal(r.$('query').value,'once');
  status='done';response.resolve(ok({state:'pending'}));await send;
  await r.run("checkPending(storage.get(key('pending')),generation,key('pending'))");assert.equal(r.run('sending'),false);assert.equal(r.$('query').value,'');
});
test('definitively rejected submit releases the guard and keeps the draft retryable',async()=>{
  const r=setup(),response=deferred();
  r.run("user='alice';device='computer';session='abcdef';streamReady=true");r.$('query').value='keep this';
  r.fetch(async(url,opts)=>JSON.parse(opts.body).op==='submit'?response.promise:ok({state:'missing'}));
  const send=r.$('composer').onsubmit({preventDefault(){}});
  await r.run("checkPending(storage.get(key('pending')),generation,key('pending'))");assert.equal(r.run('sending'),true);
  response.resolve(failure(403,'not authorized'));await send;
  assert.equal(r.run('sending'),false);assert.equal(r.$('query').value,'keep this');assert.equal(r.run('inFlightSends.size'),0);
});

test('device unlink confirmation targets its own row and waits for confirmation', async () => {
  const r = setup(), removed = [];
  const devices = [
    { id: 'first', name: '我的工作电脑', online: true },
    { id: 'second', name: 'Design-and-Development-Workstation-ABCDEFGHIJKLMNOPQRSTUVWXYZ', online: false },
    { id: 'third', name: '用于产品设计与软件开发的个人工作电脑', online: false }
  ];
  r.run("user='alice';device='first'");
  r.fetch(async () => ok(devices)); await r.$('account').onclick();
  const cards = r.$('modal-body').children.filter(e => e.className === 'device-card');
  assert.equal(cards.length, 3);
  for (let i = 0; i < cards.length; i++) {
    assert.equal(cards[i].children[0].children[0].textContent, devices[i].name);
    assert.equal(cards[i].children[0].children[1].textContent, devices[i].online ? '在线' : '离线');
  }
  await cards[1].children[1].onclick();
  assert.equal(r.$('modal-title').textContent, '移除设备授权');
  assert.ok(r.$('modal-body').children[0].textContent.includes(devices[1].name));
  assert.deepEqual(removed, []);
  r.fetch(async (url, options) => {
    if (options.method === 'DELETE') { removed.push(url.pathname); return ok({}); }
    return ok([]);
  });
  await r.$('modal-body').children[1].onclick();
  assert.deepEqual(removed, ['/mobile/api/devices/second']);
  assert.equal(r.$('modal').open, false);
});

test('a conversation removed from sharing clears its view and ignores delayed stream events', async () => {
  const r = setup();
  r.context.EventSource = class { addEventListener() {} close() { this.closed = true; } };
  r.run("user='alice';device='computer';session='abcdef';devices=[{id:'computer',online:true}];connectStream();streamReady=true;images=[{name:'draft.png'}];renderAttachments();modal('选择模型',[el('p','old model')])");
  const oldSource = r.run('source');
  r.$('query').value = 'keep my draft'; r.$('chat-title').textContent = 'Old conversation'; r.$('model').textContent = 'Old model';
  r.send('agent:processing-start');
  r.send('agent:response-chunk', { blocks: [{ type: 'text', text: 'Old reply' }] });
  r.send('permission:request', { requestId: 'approval', expiresAt: Date.now() + 60000 });
  r.fetch(async () => ok([{ instanceId: 'bbbbbb', title: 'Still shared' }]));
  await r.run('refreshSessions()');
  assert.equal(r.run('session'), ''); assert.equal(r.run('device'), 'computer');
  assert.equal(oldSource.closed, true); assert.equal(r.$('activity').hidden, true);
  assert.equal(r.$('chat-title').textContent, ''); assert.equal(r.$('model').textContent, '模型');
  assert.equal(r.$('query').value, ''); assert.equal(r.$('query').disabled, true); assert.equal(r.$('send').disabled, true);
  assert.equal(r.$('attachments').children.length, 0); assert.equal(r.$('modal').open, false);
  assert.equal(r.run('permissions.size'), 0); assert.equal(r.run('renderTimer'), null);
  assert.equal(r.stored.get('ashub-mobile:alice:computer:abcdef:draft'), 'keep my draft');
  assert.equal(sessionRows(r)[0].children[0].textContent, 'Still shared');
  oldSource.onmessage({ data: JSON.stringify({ meta: { name: 'agent:processing-start' } }) });
  assert.equal(r.$('activity').hidden, true);
});

for (const state of ['unknown', 'done']) {
  test(`late ${state} send confirmation cannot mutate a conversation removed from sharing`, async () => {
    const r = setup(), response = deferred();
    r.run("user='alice';device='computer';session='abcdef';storage.set(key('pending'),'pending-request');storage.set(key('pending')+':draft','old submission');sending=true");
    const pendingKey = r.run("key('pending')"); r.$('query').value = 'next draft';
    r.fetch(async (url, options) => JSON.parse(options.body).op === 'sessions' ? ok([]) : response.promise);
    const checking = r.run("checkPending('pending-request',generation,key('pending'))");
    await r.run('refreshSessions()');
    response.resolve(ok({ state })); await checking;
    assert.equal(r.$('query').value, ''); assert.equal(r.$('notice').textContent, ''); assert.equal(r.run('sending'), false);
    assert.equal(r.stored.get(pendingKey), 'pending-request', 'retain confirmation state for reopening the original conversation');
    assert.equal(r.stored.get('ashub-mobile:alice:computer:abcdef:draft'), 'next draft');
  });
}

test('refreshing a still-shared conversation preserves its stream and unsent content', async () => {
  const r = setup(); r.context.EventSource = class { addEventListener() {} close() { this.closed = true; } };
  r.run("user='alice';device='computer';session='abcdef';connectStream();streamReady=true;images=[{name:'draft.png'}];renderAttachments();setActivity(true)");
  const oldSource = r.run('source'), oldGeneration = r.run('generation'); r.$('query').value = 'draft';
  r.fetch(async () => ok([{ instanceId: 'abcdef', title: 'Still shared' }])); await r.run('refreshSessions()');
  assert.equal(r.run('source'), oldSource); assert.equal(r.run('generation'), oldGeneration);
  assert.equal(r.$('query').value, 'draft'); assert.equal(r.$('attachments').children.length, 1); assert.equal(r.$('activity').hidden, false);
});

for (const titles of [['Review', 'Review'], ['Review', 'Review follow-up'], ['', '']]) {
  test(`session selection uses identity for titles ${JSON.stringify(titles)}`, async () => {
    const r = setup(); r.context.EventSource = class { addEventListener() {} close() {} };
    r.run("user='alice';device='computer'");
    r.fetch(async () => ok(titles.map((title, i) => ({ instanceId: i ? 'bbbbbb' : 'aaaaaa', title }))));
    await r.run('refreshSessions()');
    await sessionRows(r)[0].onclick();
    assert.equal(r.run('session'), 'aaaaaa');
    assert.deepEqual(sessionRows(r).filter(b => b.dataset.navKey.startsWith('session:')).map(b => b.classList.contains('active')), [true, false]);
    await sessionRows(r).find(b => b.dataset.sessionId === 'bbbbbb').onclick();
    assert.equal(r.run('session'), 'bbbbbb');
    assert.deepEqual(sessionRows(r).filter(b => b.dataset.navKey.startsWith('session:')).map(b => b.classList.contains('active')), [false, true]);
  });
}

test('overlapping image selections never exceed the four-image send limit', async () => {
  const r = setup(), reads = [];
  r.context.FileReader = class { readAsDataURL() { reads.push(() => { this.result = 'data:image/png;base64,AAAA'; this.onload(); }); } };
  r.run("user='alice';device='computer';session='abcdef';streamReady=true;images=Array.from({length:3},(_,i)=>({name:`existing-${i}.png`,data:'AAAA',mimeType:'image/png'}))");
  const input = r.$('image-input');
  input.files = [{ name: 'fourth.png', size: 3, type: 'image/png' }];
  const first = input.onchange({ target: input });
  input.files = [{ name: 'fifth.png', size: 3, type: 'image/png' }];
  const second = input.onchange({ target: input });
  reads[0](); await first; reads[1](); await second;
  assert.equal(r.$('attachments').children.length, 4);
  assert.match(r.$('notice').textContent, /最多 4 张/);
  let sent;
  r.fetch(async (url, options) => { const b = JSON.parse(options.body); if (b.op === 'submit') { sent = b.args; return ok({state:'pending'}); } return ok({state:'done'}); });
  await r.$('composer').onsubmit({ preventDefault() {} });
  assert.equal(sent.images.length, 4); assert.equal(r.run('images.length'), 0);
});

test('image read completion cannot attach a previous conversation image after switching', async () => {
  const r = setup(); let finish;
  r.context.EventSource = class { addEventListener() {} close() {} };
  r.context.FileReader = class { readAsDataURL() { finish = () => { this.result = 'data:image/png;base64,AAAA'; this.onload(); }; } };
  r.run("user='alice';device='computer';session='abcdef'");
  const input = r.$('image-input'); input.files = [{ name: 'old.png', size: 3, type: 'image/png' }];
  const reading = input.onchange({ target: input }); await r.run("openSession('bbbbbb')"); finish(); await reading;
  assert.equal(r.run('images.length'), 0); assert.equal(r.$('attachments').children.length, 0);
});

test('mobile views filter project membership and prioritize approvals without losing the active chat', () => {
  const r = setup();
  r.run("sessions=[{instanceId:'aaaaaa',title:'Review',waitingApproval:true,isProcessing:true},{instanceId:'bbbbbb',title:'Writer',isProcessing:true},{instanceId:'cccccc',title:'Other',hasUnread:true}];groups=[{id:'p',name:'Project',sessionIds:['aaaaaa','bbbbbb']}];capabilities={tasks:true};viewFilter='project:p';session='aaaaaa';renderSessions()");
  assert.equal(r.$('sessions').children.length, 2); assert.equal(r.$('sessions').children[0].dataset.status, 'approval');
  assert.equal(r.$('project-tasks').hidden, false);
  r.run("viewFilter='attention';renderSessions()"); assert.equal(r.$('sessions').children.length, 1);
  r.$('session-search').value = 'Writer'; r.run("viewFilter='all';renderSessions()"); assert.equal(r.$('sessions').children[0].dataset.sessionId, 'bbbbbb');
  r.run("viewFilter='project:p';renderSessions()"); assert.equal(r.$('sessions').children[0].dataset.sessionId, 'bbbbbb'); assert.equal(r.run('session'), 'aaaaaa');
});
test('late project refresh never installs a different device catalog', async () => {
  const r = setup(), pending = deferred();
  r.run("user='alice';device='old';capabilitiesDevice='old';capabilities={projects:true}");
  r.fetch(async (_url, options) => JSON.parse(options.body).op === 'project-groups' ? pending.promise : ok([{instanceId:'aaaaaa',title:'Old'}]));
  const request = r.run('refreshSessions()'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  r.run("resetDevice('new')"); pending.resolve(ok([{id:'private',name:'Old project',sessionIds:['aaaaaa']}])); await request;
  assert.equal(r.run('groups.length'), 0); assert.equal(r.run('device'), 'new');
});
test('thinking chunks coalesce and recovered tool failures do not mark the reply as interrupted', () => {
  const r = setup(); r.send('agent:query', {query:'Inspect'}); r.send('agent:processing-start');
  r.send('agent:thinking-chunk', {text:'First '}); r.send('agent:thinking-chunk', {text:'thought'});
  r.run('details.box.open=true; details.box.ontoggle()');
  assert.equal(r.run('details.thinking.textContent'), 'First thought');
  r.send('agent:tool-started', {toolCallId:'tool1',name:'bash'}); r.send('agent:tool-completed', {toolCallId:'tool1',error:'retry'});
  r.send('agent:response-segment', {text:'Recovered'}); r.send('agent:processing-done');
  assert.equal(r.run('[...phases][0].summary.textContent'), '处理记录'); assert.deepEqual(r.replies(), ['Recovered']);
});
test('interruption survives cleanup and late tool results stay with their original work phase', () => {
  const r = setup(); r.send('agent:processing-start'); r.send('agent:tool-started', {toolCallId:'tool1',name:'read'});
  r.send('agent:response-segment', {text:'Partial'}); r.send('agent:tool-completed', {toolCallId:'tool1',output:'done'});
  assert.equal(r.run('phases.size'), 1);
  r.send('agent:error', {message:'disconnected'}); r.send('agent:processing-done');
  assert.equal(r.run('[...phases][0].summary.textContent'), '回复中断');
  r.send('hub:branch-switched'); assert.equal(r.run('phases.size'), 0); assert.equal(r.run('toolSteps.size'), 0);
});
test('Codex unknown cache is distinct from measured zero and resets with replay', () => {
  const r = setup(); r.send('agent:info', {model:'gpt-test',provider:'codex',contextWindow:100000});
  r.send('agent:usage', {prompt_tokens:5000,completion_tokens:1000,cache_reported:false});
  assert.match(r.$('usage').textContent, /缓存未提供/); assert.match(r.$('usage').textContent, /上下文 5%/); assert.doesNotMatch(r.$('usage').textContent, /缓存 0%/);
  r.send('agent:usage', {prompt_tokens:5000,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:5000,cache_reported:true}); assert.match(r.$('usage').textContent, /缓存 0%/);
  r.send('hub:branch-switched'); assert.equal(r.$('usage').textContent, '');
});
test('workspace links retain owner, Unicode paths and traversal for desktop validation', () => {
  const r = setup();
  for (const [url, owner, expected] of [
    ['report%20%23%20%E4%B8%AD.docx','aaaaaa',{session:'aaaaaa',path:'report # 中.docx'}],
    ['http://127.0.0.1:7878/bbbbbb/results/report.zip','aaaaaa',{session:'bbbbbb',path:'results/report.zip'}],
    ['http://localhost:7878/aaaaaa/artifacts?path=LICENSE','bbbbbb',{session:'aaaaaa',path:'LICENSE'}],
    ['../private/secret','aaaaaa',{session:'aaaaaa',path:'../private/secret'}]
  ]) { r.context.url=url;r.context.owner=owner; assert.deepEqual(JSON.parse(JSON.stringify(r.run('artifactTarget(url,owner)'))),expected); }
  assert.equal(r.run("artifactTarget('https://example.com/file.zip','aaaaaa')"), null);
  assert.equal(r.run("artifactTarget('javascript:alert(1)','aaaaaa')"), null);
});
test('task output from a dismissed or replaced dialog cannot overwrite the new modal', async () => {
  const r = setup(), pending = deferred(); r.run("user='alice';device='desktop'");r.fetch(()=>pending.promise);
  const request=r.run("showTasks({id:'p',name:'Old project'})");r.run("modal('Account',[el('p','Account details')])");
  pending.resolve(ok([]));await request;assert.equal(r.$('modal-title').textContent,'Account');
});


test('streamed tool output coalesces per tool and stays attached across reply chunks', () => {
  const r = setup(); r.send('agent:processing-start');
  r.send('agent:tool-started', {toolCallId:'one',name:'bash'});
  r.send('agent:tool-started', {toolCallId:'two',name:'bash'});
  r.send('agent:tool-output-chunk', {toolCallId:'one',chunk:'first '});
  r.send('agent:response-segment', {text:'Working'});
  r.send('agent:tool-output-chunk', {toolCallId:'two',chunk:'second'});
  r.send('agent:tool-output-chunk', {toolCallId:'one',chunk:'tail'});
  assert.equal(r.run('phases.size'), 1);
  r.run('[...phases][0].box.open = true; [...phases][0].box.ontoggle()');
  assert.equal(r.run("[...phases][0].outputs.get('one').textContent"), 'first tail');
  assert.equal(r.run("[...phases][0].outputs.get('two').textContent"), 'second');
});
test('clearing a desktop todo list removes the mobile progress surface', () => {
  const r = setup(); r.send('agent:todo', {todos:[{title:'Review',status:'in_progress'}]});
  const old = r.run('todo'); old.isConnected = true;
  r.send('agent:todo', {todos:[]}); assert.equal(old.isConnected, false); assert.equal(r.run('todo'), null);
});


test('model search recognizes the visible OpenAI Coding Plan provider label', async () => {
  const r = setup(); r.run("user='alice';device='desktop';session='aaaaaa'");
  r.fetch(async()=>ok({providers:[{name:'codex',models:[{id:'gpt-test'}]},{name:'deepseek',models:[{id:'deepseek-test'}]}]}));
  await r.$('model').onclick();
  const [search,list] = r.$('modal-body').children;
  search.value = 'OpenAI'; search.oninput();
  assert.deepEqual(list.children.map(e=>e.textContent), ['OpenAI Coding Plan','gpt-test']);
});

test('partial agent info preserves the current mobile model label', () => {
  const r = setup();
  r.send('agent:info', {model:'gpt-test',provider:'codex',contextWindow:100000});
  r.send('agent:info', {thinkingLevel:'high',thinkingSupported:true});
  assert.equal(r.$('model').textContent, 'gpt-test');
  assert.equal(r.$('model').title, 'codex · gpt-test · 思考 · high');
});
test('a running task remains refreshable at its current output boundary', async () => {
  const r = setup(); r.run("user='alice';device='desktop'");
  const offsets = [];
  r.fetch(async (_url, options) => {
    const {args} = JSON.parse(options.body); offsets.push(args.offset);
    return ok(args.offset === 0
      ? {text:'First 🟡',nextOffset:8,hasMore:false,terminal:false,state:'running'}
      : {text:' finished',nextOffset:17,hasMore:false,terminal:true,state:'completed'});
  });
  await r.run("showTask({id:'p',name:'Project'},{id:'t',message:'Review',recipientId:'bbbbbb'})");
  const article = r.$('modal-body').children.find(e => e.className.includes('task-output'));
  const more = r.$('modal-body').children.at(-1);
  assert.equal(more.hidden, false);
  assert.equal(more.textContent, '刷新进度');
  await more.onclick();
  assert.deepEqual(offsets, [0,8]); assert.equal(article.innerHTML, 'First 🟡 finished');
  assert.equal(more.hidden, true);
});
test('task pagination errors are visible in the dialog and retry the same offset', async () => {
  const r = setup(); r.run("user='alice';device='desktop'");
  let count = 0; const offsets = [];
  r.fetch(async (_url, options) => {
    const {args} = JSON.parse(options.body); offsets.push(args.offset); count++;
    if (count === 2) return failure(503,'电脑暂时离线');
    return ok(count === 1
      ? {text:'First',nextOffset:5,hasMore:true,terminal:true}
      : {text:' last',nextOffset:10,hasMore:false,terminal:true});
  });
  await r.run("showTask({id:'p',name:'Project'},{id:'t',message:'Review',recipientId:'bbbbbb'})");
  const error = r.$('modal-body').children.find(e => e.className === 'task-error');
  const article = r.$('modal-body').children.find(e => e.className.includes('task-output'));
  const more = r.$('modal-body').children.at(-1);
  await more.onclick(); assert.equal(error.textContent, '电脑暂时离线');
  assert.equal(article.innerHTML,'First'); assert.equal(more.disabled,false);
  await more.onclick(); assert.deepEqual(offsets,[0,5,5]);
  assert.equal(article.innerHTML,'First last'); assert.equal(error.textContent,'');
});
test('a late task page failure does not surface in another dialog', async () => {
  const r = setup(), pending = deferred(); r.run("user='alice';device='desktop'");
  let count = 0;
  r.fetch(async () => ++count === 1 ? ok({text:'First',nextOffset:5,hasMore:true,terminal:true}) : pending.promise);
  await r.run("showTask({id:'p',name:'Project'},{id:'t',message:'Review',recipientId:'bbbbbb'})");
  const request = r.$('modal-body').children.at(-1).onclick();
  r.run("modal('Account',[el('p','Current account')])");
  pending.resolve(failure(503,'Old task failed')); await request;
  assert.equal(r.$('notice').textContent,''); assert.equal(r.$('modal-title').textContent,'Account');
});

test('a temporary capability lookup failure recovers on the next session refresh', async () => {
  const r = setup(); r.run("user='alice';device='desktop'"); let attempts = 0;
  r.fetch(async (_url, options) => {
    const {op} = JSON.parse(options.body);
    if (op === 'sessions') return ok([{instanceId:'aaaaaa',title:'Shared'}]);
    if (op === 'capabilities') return ++attempts === 1 ? failure(503,'Temporary disconnect') : ok({projects:true,tasks:true,artifacts:true});
    if (op === 'project-groups') return ok([{id:'p',name:'Project',sessionIds:['aaaaaa']}]);
    throw Error('Unexpected operation');
  });
  await r.run('refreshSessions()');
  assert.equal(sessionRows(r)[0].dataset.sessionId,'aaaaaa');
  await r.run('refreshSessions()');
  assert.equal(attempts,2); assert.equal(r.run('capabilities.artifacts'),true);
  assert.equal(r.run('groups[0].name'),'Project');
});

for (const handler of ['model','new-chat','account']) {
  test(`late ${handler} loading cannot replace a newer dialog in the same conversation`, async () => {
    const r = setup(), pending = deferred(); r.run("user='alice';device='desktop';session='aaaaaa'");
    r.fetch(()=>pending.promise); const request=r.$(handler).onclick();
    r.run("modal('对话共享范围',[el('p','Current content')])");
    pending.resolve(ok(handler==='model'?{providers:[]}:[])); await request;
    assert.equal(r.$('modal-title').textContent,'对话共享范围');
    assert.equal(r.$('modal-body').children[0].textContent,'Current content');
  });
}

function thinkingFixture() {
  const r = setup();
  r.run("user='alice';device='desktop';session='aaaaaa';streamReady=true;devices=[{id:'desktop',online:true}];capabilities={thinking:true}");
  const state = {model:'deepseek-v4-flash',provider:'deepseek',level:'high',levels:['off','low','high','max'],supported:true};
  const catalog = {providers:[{name:'deepseek',models:[{id:state.model}]},{name:'codex',models:[{id:'gpt-5.4'}]}]};
  r.send('agent:info', {model:state.model,provider:state.provider,thinkingLevel:state.level,thinkingLevels:state.levels,thinkingSupported:true});
  const calls = []; let action = async ({op,args}) => op === 'models' ? catalog : op === 'set-thinking' ? {...state,level:args.level} : state;
  r.fetch(async (_url, options) => { const body = JSON.parse(options.body); calls.push(body); return ok(await action(body)); });
  const footer = () => r.$('modal-body').children.find(e => e.className === 'model-thinking');
  const levels = () => footer().children.find(e => e.className === 'thinking-options')?.children || [];
  const option = level => levels().find(e => e.dataset.level === level);
  return {...r,state,catalog,calls,footer,levels,option,action:fn=>{action=fn;},error:()=>r.$('modal-body').children.find(e=>e.className==='picker-error')};
}
test('mobile picker uses native levels and confirms saves before selecting them', async () => {
  const r = thinkingFixture(); await r.$('model').onclick();
  assert.deepEqual(r.levels().map(b=>b.dataset.level), ['default','off','low','high','max']);
  const pending = deferred(); r.action(()=>pending.promise);
  const saving = r.option('max').onclick();
  assert.equal(r.run('modelInfo.thinkingLevel'),'high'); assert.ok(r.levels().every(b=>b.disabled));
  pending.resolve({...r.state,level:'max'}); await saving;
  assert.equal(r.run('modelInfo.thinkingLevel'),'max'); assert.equal(r.option('max')['aria-pressed'],'true');
  assert.equal(r.$('modal').open,true);
  assert.deepEqual(r.calls.at(-1),{op:'set-thinking',args:{session:'aaaaaa',model:r.state.model,provider:'deepseek',level:'max'}});
});
test('mobile model switch stays open and replaces the effort ladder from the desktop', async () => {
  const r = thinkingFixture(); await r.$('model').onclick();
  const native = {model:'gpt-5.4',provider:'codex',level:'default',levels:['low','medium','high','xhigh'],supported:true};
  r.action(async ({op})=>op==='model'?{ok:true}:native);
  await r.$('modal-body').children[1].children.find(b=>b.dataset.model==='gpt-5.4').onclick();
  assert.equal(r.$('modal').open,true); assert.equal(r.run('modelInfo.provider'),'codex');
  assert.deepEqual(r.levels().map(b=>b.dataset.level),['default','low','medium','high','xhigh']);
  r.send('agent:info',{thinkingLevel:'xhigh'}); assert.equal(r.option('xhigh')['aria-pressed'],'true');
});
test('thinking GET cannot overwrite a newer desktop change, including switch away and back', async () => {
  const r = thinkingFixture(), pending = deferred();
  r.action(({op})=>op==='models'?r.catalog:pending.promise);
  const opening = r.$('model').onclick();
  while(!r.calls.some(c=>c.op==='thinking')) await Promise.resolve();
  r.send('agent:info',{model:'gpt-5.4',provider:'codex'});
  r.send('agent:info',{model:r.state.model,provider:r.state.provider,thinkingLevel:'max',thinkingLevels:r.state.levels,thinkingSupported:true});
  pending.resolve(r.state); await opening;
  assert.equal(r.run('modelInfo.thinkingLevel'),'max'); assert.equal(r.option('max')['aria-pressed'],'true');
});
test('late thinking save cannot replace newer SSE or another dialog', async () => {
  const r = thinkingFixture(); await r.$('model').onclick(); const pending = deferred(); r.action(()=>pending.promise);
  const saving = r.option('max').onclick();
  r.send('agent:info',{thinkingLevel:'low'}); pending.resolve({...r.state,level:'max'}); await saving;
  assert.equal(r.run('modelInfo.thinkingLevel'),'low');
  const next = deferred(); r.action(()=>next.promise); const second = r.option('high').onclick();
  r.run("modal('账号与设备',[el('p','Account')])"); next.resolve({...r.state,level:'high'}); await second;
  assert.equal(r.$('modal-title').textContent,'账号与设备'); assert.equal(r.run('modelInfo.thinkingLevel'),'low');
});
test('failed thinking save stays inline and retains the last confirmed selection', async () => {
  const r = thinkingFixture(); await r.$('model').onclick();
  r.action(()=>{throw Error('电脑暂时离线');}); await r.option('max').onclick();
  assert.match(r.error().textContent,/离线/); assert.equal(r.run('modelInfo.thinkingLevel'),'high');
  assert.equal(r.option('high')['aria-pressed'],'true'); assert.equal(r.option('max').disabled,false);
});
test('thinking read can retry and live capabilities recover an errored picker', async () => {
  const r = thinkingFixture(); r.action(({op})=>{if(op==='models')return r.catalog;throw Error('读取失败');});
  await r.$('model').onclick(); assert.match(r.error().textContent,/读取失败/);
  r.action(()=>r.state); await r.footer().children[1].onclick(); assert.equal(r.levels().length,5);
  r.send('agent:info',{model:'unknown',provider:'custom',thinkingSupported:false,thinkingLevels:[]});
  assert.equal(r.levels().length,0); assert.match(r.footer().children[1].textContent,/未提供/);
});
test('older connectors retain model selection without requesting unsupported thinking operations', async () => {
  const r = thinkingFixture(); r.run('capabilities={}'); await r.$('model').onclick();
  assert.deepEqual(r.calls.map(c=>c.op),['models']); assert.match(r.footer().children[1].textContent,/更新桌面端/);
  r.action(()=>({ok:true})); await r.$('modal-body').children[1].children.find(b=>b.dataset.provider==='codex').onclick();
  assert.equal(r.run('modelInfo.provider'),'codex'); assert.deepEqual(r.calls.map(c=>c.op),['models','model']);
});
test('activity and disconnect disable all model and thinking options; branch reset dismisses them', async () => {
  const r = thinkingFixture(); await r.$('model').onclick();
  r.send('agent:processing-start'); assert.ok(r.levels().every(b=>b.disabled));
  const count = r.calls.length; await r.option('max').onclick(); assert.equal(r.calls.length,count);
  r.send('agent:processing-done'); r.run('streamReady=false;controls()'); assert.ok(r.levels().every(b=>b.disabled));
  r.send('hub:branch-switched'); assert.equal(r.$('modal').open,false);
});
test('rapid model taps serialize writes and a newer live model wins over a late response', async () => {
  const r = thinkingFixture(); await r.$('model').onclick(); const pending=deferred();
  const latest={model:'new-model',provider:'custom',level:'default',levels:[],supported:false};
  r.action(({op})=>op==='model'?pending.promise:latest);
  const buttons=r.$('modal-body').children[1].children.filter(b=>b.dataset.model);
  const first=buttons[1].onclick(); await buttons[0].onclick();
  assert.equal(r.calls.filter(c=>c.op==='model').length,1);
  r.send('agent:info',{model:'new-model',provider:'custom',thinkingSupported:false,thinkingLevels:[]});
  pending.resolve({ok:true}); await first; assert.equal(r.run('modelInfo.model'),'new-model');
});

test('a live capability update clears failed thinking lookup without disturbing the search', async () => {
  const r=thinkingFixture();r.action(({op})=>{if(op==='models')return r.catalog;throw Error('temporary error');});
  await r.$('model').onclick();const search=r.$('modal-body').children[0];search.value='deepseek';search.oninput();
  assert.equal(r.levels().length,0);assert.match(r.error().textContent,/temporary/);
  r.send('agent:info',{thinkingLevel:'low',thinkingSupported:true,thinkingLevels:r.state.levels});
  assert.equal(r.option('low')['aria-pressed'],'true');assert.equal(r.error().textContent,'');assert.equal(search.value,'deepseek');
});
test('unrelated metadata cannot cancel a pending capability read', async () => {
  const r=thinkingFixture(),pending=deferred();r.action(({op})=>op==='models'?r.catalog:pending.promise);
  const opening=r.$('model').onclick();while(!r.calls.some(c=>c.op==='thinking'))await Promise.resolve();
  r.send('agent:info',{contextWindow:100000});pending.resolve({...r.state,level:'max'});await opening;
  assert.equal(r.option('max')['aria-pressed'],'true');assert.equal(r.run('modelInfo.contextWindow'),100000);
});

test('collapsed diagnostics build no tool DOM until opened and preserve every chunk', () => {
  const r = setup(); r.send('agent:processing-start');
  r.send('agent:tool-started', {toolCallId:'one',name:'read_file'});
  for(let i=0;i<1000;i++) r.send('agent:tool-output-chunk',{toolCallId:'one',chunk:'x'});
  r.send('agent:tool-completed',{toolCallId:'one',success:true});
  assert.equal(r.run('[...phases][0].body.children.length'),0);
  assert.equal(r.run('[...phases][0].pending.length'),1002);
  r.run('[...phases][0].box.open=true; [...phases][0].box.ontoggle()');
  assert.equal(r.run('[...phases][0].outputs.get("one").textContent.length'),1000);
  assert.equal(r.run('[...phases][0].pending.length'),0);
  r.run('[...phases][0].box.ontoggle()');
  assert.equal(r.run('[...phases][0].outputs.get("one").textContent.length'),1000,'reopening must not duplicate output');
});
test('batched replay yields between slices, enables input only after replay-done and cancels on disconnect', () => {
  const r=setup();
  r.run('for(let i=0;i<130;i++) enqueueFrame({meta:{name:"agent:query"},payload:{query:String(i)}}); enqueueFrame({meta:{name:"hub:replay-done"}})');
  assert.equal(r.$('messages').children.length,0);
  r.run('drainFrames()');assert.equal(r.$('messages').children.length,60);assert.equal(r.run('streamReady'),false);
  r.run('drainFrames()');assert.equal(r.$('messages').children.length,120);assert.equal(r.run('streamReady'),false);
  r.run('drainFrames()');assert.equal(r.$('messages').children.length,130);assert.equal(r.run('streamReady'),true);
  r.run('enqueueFrame({meta:{name:"agent:query"},payload:{query:"stale"}}); closeSource(); drainFrames()');
  assert.equal(r.$('messages').children.length,130);assert.equal(r.run('streamReady'),false);
});

test('one malformed queued frame cannot discard later replies or replay completion', () => {
  const r=setup();
  r.run('enqueueFrame(null); enqueueFrame({meta:{name:"agent:response-segment"},payload:{text:"still here"}}); enqueueFrame({meta:{name:"agent:processing-done"}}); enqueueFrame({meta:{name:"hub:replay-done"}}); drainFrames()');
  assert.deepEqual(r.replies(), ['still here']); assert.equal(r.run('streamReady'),true);
});

test('opening details before the queued toggle event keeps incoming thinking and tool chunks in order', () => {
  const r = setup(); r.send('agent:processing-start');
  r.send('agent:thinking-chunk', {text:'first '});
  r.send('agent:tool-started', {toolCallId:'one',name:'read_file'});
  r.send('agent:tool-output-chunk', {toolCallId:'one',chunk:'before '});
  // Native <details>.open changes before its asynchronous toggle event fires.
  r.run('details.box.open = true');
  r.send('agent:thinking-chunk', {text:'second'});
  r.send('agent:tool-output-chunk', {toolCallId:'one',chunk:'after'});
  r.run('details.box.ontoggle()');
  assert.deepEqual(Array.from(r.run('details.body.children.filter(n=>n.className==="step thinking-step").map(n=>n.children[1].textContent)')), ['first ', 'second']);
  assert.equal(r.run('details.outputs.get("one").textContent'), 'before after');
});

test('opening an earlier phase drains its chunks without changing the active phase or reviving finished tools', () => {
  const r = setup(); r.send('agent:processing-start');
  r.send('agent:tool-started', {toolCallId:'one',name:'read_file'});
  r.send('agent:tool-output-chunk', {toolCallId:'one',chunk:'before '});
  r.send('agent:response-segment', {text:'Continuing'});
  r.send('agent:thinking-chunk', {text:'current thought'});
  r.run('[...phases][0].box.open=true');
  r.send('agent:tool-output-chunk', {toolCallId:'one',chunk:'after'});
  r.send('agent:tool-completed', {toolCallId:'one',success:true});
  r.run('[...phases][0].box.ontoggle(); details.box.open=true; details.box.ontoggle()');
  assert.equal(r.run('phases.size'),2);
  assert.equal(r.run('details === [...phases][1]'),true);
  assert.equal(r.run('[...phases][0].outputs.get("one").textContent'),'before after');
  assert.equal(r.run('details.thinking.textContent'),'current thought');
  assert.equal(r.run('toolSteps.size'),0);
});

test('artifact downloads remain in a dismissible panel and never navigate the PWA', async () => {
  const r=setup();r.run("device='desktop';session='aaaaaa'");const calls=[];
  r.fetch(async (url, options) => { calls.push(options.method); return new Response(null,{headers:{'content-disposition':'attachment; filename="report.pdf"','content-length':'3'}}); });
  await r.run("showArtifactDownload(new URL('https://example.test/mobile/api/devices/desktop/artifact?session=aaaaaa&path=report.pdf'),'report.pdf','desktop')");
  assert.equal(r.$('modal').open,true);assert.equal(r.$('modal-title').textContent,'保存文件');
  const actions=r.$('modal-body').children[2],link=actions.children[0];
  assert.equal(link.target,'_blank');assert.match(link.rel,/noopener/);assert.equal(link.download,'report.pdf');
  assert.deepEqual(calls,['HEAD']);assert.equal(r.context.location.href,'https://example.test/mobile/');
  await r.$('modal-body').children[3].onclick();assert.equal(r.$('modal').open,false);
});
test('prepared artifacts use the system share sheet only on an explicit tap', async () => {
  const r=setup({pwa:true});r.run("device='desktop';session='aaaaaa'");r.context.File=File;
  const shared=[],revoked=[];r.context.navigator.canShare=()=>true;r.context.navigator.share=async data=>{shared.push(data);};
  r.context.URL=class extends URL {static createObjectURL(){return 'blob:prepared';}static revokeObjectURL(url){revoked.push(url);}};
  const calls=[];r.fetch(async (_url,options)=>{calls.push(options.method||'GET');return new Response(options.method==='HEAD'?null:'pdf',{headers:{'content-disposition':'attachment; filename="report.pdf"','content-length':'3'}});});
  await r.run("showArtifactDownload(new URL('https://example.test/file'),'report.pdf','desktop')");
  assert.deepEqual(calls,['HEAD','GET']);assert.equal(shared.length,0);
  const actions=r.$('modal-body').children[2];assert.equal(actions.children[1].href,'blob:prepared');
  await actions.children[0].onclick();assert.equal(shared.length,1);assert.equal(await shared[0].files[0].text(),'pdf');
  r.run("modal('Account',[])");assert.deepEqual(revoked,['blob:prepared']);
  await actions.children[0].onclick();assert.equal(shared.length,1,'a stale save button cannot share a dismissed file');
});
for(const change of ['close','replace','switch']) test(`a delayed artifact response cannot reopen the panel after ${change}`,async()=>{
  const r=setup();r.run("device='desktop';session='aaaaaa'");const pending=deferred();r.fetch(()=>pending.promise);
  const opening=r.run("showArtifactDownload(new URL('https://example.test/file'),'report.pdf','desktop')");
  if(change==='close')r.$('modal').close();
  else if(change==='replace')r.run("modal('Account',[])");
  else r.run("generation++;device='other';$('modal').close()");
  pending.resolve(new Response(null,{headers:{'content-disposition':'attachment;','content-length':'3'}}));await opening;
  assert.equal(r.$('modal-body').children[2]?.children.length||0,0);
  if(change==='replace')assert.equal(r.$('modal-title').textContent,'Account');else assert.equal(r.$('modal').open,false);
});
test('failed artifact checks leave the conversation and a close action available',async()=>{
  const r=setup();r.run("device='desktop'");r.fetch(async()=>new Response('offline',{status:503}));
  await r.run("showArtifactDownload(new URL('https://example.test/file'),'report.pdf','desktop')");
  assert.match(r.$('modal-body').children[1].textContent,/文件无法下载/);
  assert.equal(r.$('modal-body').children[2].children.length,0);
  await r.$('modal-body').children[3].onclick();assert.equal(r.$('modal').open,false);
});
test('PWA zoom prevention preserves scrolling and ordinary browser gestures',()=>{
  for(const pwa of [false,true]){
    const r=setup({pwa});assert.equal(r.context.document.documentElement.dataset.pwa,String(pwa));
    for(const type of ['gesturestart','gesturechange','touchmove']){
      let prevented=false;const listener=r.listeners.get(type);
      listener.fn({touches:[{},{}],preventDefault(){prevented=true;}});assert.equal(prevented,pwa);
      assert.equal(listener.options.passive,false);
    }
    let scrollingBlocked=false;r.listeners.get('touchmove').fn({touches:[{}],preventDefault(){scrollingBlocked=true;}});assert.equal(scrollingBlocked,false);
  }
});

test('request progress belongs to the message stream, never the composer', () => {
  const html=fs.readFileSync(new URL('./public/index.html',import.meta.url),'utf8');
  assert(!html.slice(html.indexOf('class="composer-wrap"')).includes('id="activity"'));
  const r=setup();r.send('agent:query',{query:'Inspect'});r.send('agent:processing-start');
  for(const [phase,label] of [['sending','正在发送上下文并等待响应'],['waiting','已连接，正在等待回复'],['retrying','正在重试连接'],['clear','正在梳理思路']]){
    r.send('agent:request-status',{phase});
    assert.equal(r.$('activity-text').textContent,label);
    assert.equal(r.$('activity').parentNode,r.$('messages'));
    assert.equal(r.$('messages').children.filter(n=>n===r.$('activity')).length,1);
  }
  r.send('agent:response-chunk',{blocks:[{type:'text',text:'Answer'}]});
  assert.equal(r.$('activity').hidden,true);
  r.send('agent:request-status',{phase:'waiting'});assert.equal(r.$('activity').hidden,false);
  r.send('agent:processing-done');r.send('agent:request-status',{phase:'waiting'});
  assert.equal(r.$('activity').hidden,true);assert.equal(r.$('activity').parentNode,null);
});
test('one disclosure carries thinking, tools and request status without duplicate progress', () => {
  const r=setup();r.send('agent:processing-start');r.send('agent:thinking-chunk',{text:'Inspect the source'});
  const phase=r.run('details');
  assert.equal(phase.summary.textContent,'正在梳理思路');assert.equal(r.$('activity').hidden,true);
  r.send('agent:tool-started',{toolCallId:'read',name:'read_file',kind:'read'});
  assert.equal(phase.summary.textContent,'正在查阅资料');
  r.send('agent:request-status',{phase:'waiting'});assert.equal(phase.summary.textContent,'正在查阅资料');
  r.send('agent:tool-completed',{toolCallId:'read',error:'retryable'});
  assert.equal(phase.summary.textContent,'已连接，正在等待回复');
  r.send('agent:request-status',{phase:'retrying'});assert.equal(phase.summary.textContent,'正在重试连接');
  r.send('agent:response-segment',{text:'Finished'});
  assert.equal(phase.summary.textContent,'处理记录');assert.equal(phase.box.dataset.state,'settled');
  assert.equal(r.$('activity').hidden,true);
  r.send('agent:thinking-chunk',{text:'Next step'});
  assert.equal(r.run('details.summary.textContent'),'正在梳理思路');assert.notEqual(r.run('details'),phase);
  assert.equal(phase.box.dataset.state,'settled');
});
test('late tool results settle their own sealed phase without changing the current request', () => {
  const r=setup();r.send('agent:processing-start');r.send('agent:tool-started',{toolCallId:'old',name:'bash'});
  const old=r.run('details');r.send('agent:response-segment',{text:'Continuing'});
  r.send('agent:thinking-chunk',{text:'new thought'});const current=r.run('details');
  r.send('agent:request-status',{phase:'retrying'});
  r.send('agent:tool-completed',{toolCallId:'old'});
  assert.equal(old.summary.textContent,'处理记录');assert.equal(current.summary.textContent,'正在重试连接');
  assert.equal(r.$('activity').hidden,true);
});
test('permission and background collaborators retain distinct activity through main completion', () => {
  const r=setup();r.send('agent:processing-start');r.send('subagent:started',{subagentId:'sa1',task:'Check'});
  const phase=r.run('details');assert.equal(phase.summary.textContent,'正在协作处理');
  r.send('permission:request',{requestId:'allow',expiresAt:Date.now()+60000});
  assert.equal(phase.summary.textContent,'等待你的确认');assert.equal(r.$('activity').hidden,true);
  r.send('permission:resolved',{requestId:'allow'});assert.equal(phase.summary.textContent,'正在协作处理');
  r.send('agent:processing-done');assert.equal(r.$('activity').hidden,true);assert.equal(phase.box.dataset.state,'running');
  r.send('subagent:done',{subagentId:'sa1'});assert.equal(phase.box.dataset.state,'settled');assert.equal(phase.summary.textContent,'处理记录');
});
test('reset, replay and disconnect clear transient progress without disturbing usage', () => {
  const r=setup();r.context.EventSource=class{addEventListener(){}close(){}};
  r.run("device='desktop';session='aaaaaa';devices=[{id:device,online:true}];connectStream()");
  r.send('agent:processing-start');r.send('agent:request-status',{phase:'waiting'});
  r.send('agent:usage',{prompt_tokens:100,prompt_cache_hit_tokens:50,prompt_cache_miss_tokens:50});
  const usage=r.$('usage').textContent;r.run('source.onerror()');assert.equal(r.$('activity').hidden,true);assert.equal(r.$('usage').textContent,usage);
  r.send('hub:branch-switched');r.send('agent:query',{query:'Replayed'});r.send('agent:processing-start');
  r.send('agent:thinking-chunk',{text:'current'});r.send('agent:request-status',{phase:'retrying'});r.send('hub:replay-done');
  assert.equal(r.run('details.summary.textContent'),'正在重试连接');assert.equal(r.$('activity').hidden,true);
  r.send('agent:cancelled');r.send('agent:processing-done');r.send('agent:request-status',{phase:'sending'});
  assert.equal(r.$('activity').hidden,true);assert.equal(r.run('[...phases][0].summary.textContent'),'已停止');
});

test('expired and cleaned-up approvals cannot leave a waiting indicator', () => {
  for(const cleanup of ['expire','cleanup']){
    const r=setup();r.send('agent:processing-start');r.send('agent:thinking-chunk',{text:'Inspect'});
    r.send('permission:request',{requestId:'approval',expiresAt:Date.now()+10000});
    assert.equal(r.run('details.summary.textContent'),'等待你的确认');
    if(cleanup==='expire')for(const fn of r.timers.values())fn();else r.send('permission:request-cleanup');
    assert.equal(r.run('permissions.size'),0);assert.equal(r.run('details.summary.textContent'),'正在梳理思路');
  }
});


test('sidebar search is disclosed on demand and clearing preserves the selected project filter', () => {
  const r=setup();
  r.run("sessions=[{instanceId:'a',title:'Paper review'},{instanceId:'b',title:'Report'},{instanceId:'c',title:'Unshared project'}];groups=[{id:'p',name:'Research',sessionIds:['a','b']}];viewFilter='project:p';renderSessions()");
  assert.equal(r.$('session-search-panel').hidden,true);
  r.$('session-search-toggle').onclick();assert.equal(r.$('session-search').focused,true);
  r.$('session-search').value='paper';r.$('session-search').oninput();
  assert.equal(r.$('sessions').children.length,1);assert.equal(r.$('sessions').children[0].dataset.sessionId,'a');
  assert.equal(r.$('session-search-toggle').dataset.active,'true');
  r.$('session-search-close').onclick();
  assert.equal(r.$('sessions').children.length,2);assert.equal(r.run('viewFilter'),'project:p');
  assert.equal(r.$('session-search-panel').hidden,true);assert.equal(r.$('session-search-toggle').focused,true);
});
test('remote search keeps active filters visible and Escape does not affect the running conversation', () => {
  const r=setup();r.send('agent:processing-start');
  r.$('session-search-toggle').onclick();r.$('session-search').value='paper';r.$('session-search').oninput();
  r.$('session-search-panel').onfocusout?.({relatedTarget:null});assert.equal(r.$('session-search-panel').hidden,false);
  let stopped=false,prevented=false;
  const event={key:'Escape',isComposing:true,stopPropagation(){stopped=true},preventDefault(){prevented=true}};
  r.$('session-search').onkeydown(event);assert.equal(r.$('session-search').value,'paper');
  r.$('session-search').onkeydown({...event,isComposing:false});
  assert.equal(stopped,true);assert.equal(prevented,true);assert.equal(r.$('session-search-panel').hidden,true);
  assert.equal(r.run('activity'),true);assert.equal(r.$('session-search').value,'');
});

test('Escape on search controls cannot leak into other page shortcuts', () => {
  const r=setup();r.$('session-search-toggle').onclick();let stopped=false;
  r.$('session-search-close').onkeydown({key:'Escape',preventDefault(){},stopPropagation(){stopped=true}});
  assert.equal(stopped,true);assert.equal(r.$('session-search-panel').hidden,true);
});

test('cached sidebar HTML still supports search during a shell update', () => {
  const r=setup({legacySidebar:true});
  r.run("sessions=[{instanceId:'a',title:'Paper'},{instanceId:'b',title:'Report'}];renderSessions()");
  r.$('session-search').value='Paper';r.$('session-search').oninput();
  assert.equal(r.$('sessions').children.length,1);assert.equal(r.$('sessions').children[0].dataset.sessionId,'a');
  r.run('signOut()');assert.equal(r.$('session-search').value,'');
});


test('resolved background approvals update the sealed disclosure during a live reply', () => {
  for(const outcome of ['resolved','cleanup','expired']) {
    const r=setup();r.send('agent:processing-start');
    r.send('subagent:started',{subagentId:'background',task:'Review'});const phase=r.run('details');
    r.send('permission:request',{requestId:'allow',expiresAt:Date.now()+60000});
    r.send('agent:response-segment',{text:'Review continues in the background'});
    assert.equal(phase.summary.textContent,'等待你的确认');
    if(outcome==='resolved')r.send('permission:resolved',{requestId:'allow'});
    else if(outcome==='cleanup')r.send('permission:request-cleanup');
    else for(const fn of [...r.timers.values()])fn();
    assert.equal(r.run('permissions.size'),0);
    assert.equal(phase.summary.textContent,'正在协作处理');
    assert.equal(r.$('activity').hidden,true);
  }
});
test('disconnect and replay refresh sealed and earlier-turn collaborator indicators', () => {
  for(const nextTurn of [false,true]) {
    const r=setup();r.send('agent:processing-start');
    r.send('subagent:started',{subagentId:'background',task:'Review'});const phase=r.run('details');
    r.send('agent:response-segment',{text:'Review continues'});
    if(nextTurn) {r.send('agent:processing-done');r.send('agent:query',{query:'Next turn'});r.send('agent:processing-start');}
    r.run('closeSource()');assert.equal(phase.box.dataset.paused,'true');
    r.send('hub:replay-done');assert.equal(phase.box.dataset.paused,'false');
    r.send('subagent:done',{subagentId:'background'});assert.equal(phase.box.dataset.state,'settled');
  }
});


for (const mode of ['live', 'batched replay', 'reconnect']) {
  test(`new task lists put subsequent activity below the plan (${mode})`, () => {
    const r=setup();
    if(mode==='reconnect') {
      r.send('agent:processing-start');r.send('agent:thinking-chunk',{text:'Old view'});
      r.send('agent:todo',{todos:[{title:'Old plan',status:'pending'}]});
      r.send('hub:branch-switched');
    }
    const events=[
      ['agent:query',{query:'Review the project'}],
      ['agent:processing-start',{}],
      ['agent:thinking-chunk',{text:'Plan the review'}],
      ['agent:tool-started',{toolCallId:'plan',name:'todolist'}],
      ['agent:todo',{todos:[{title:'Inspect files',status:'in_progress'},{title:'Summarize',status:'pending'}]}],
      ['agent:tool-completed',{toolCallId:'plan',success:true}],
      ['agent:request-status',{phase:'waiting'}],
    ];
    for(const [name,payload] of events) {
      if(mode==='live')r.send(name,payload);
      else {r.context.input={meta:{name},payload};r.run('enqueueFrame(input)');}
    }
    if(mode!=='live')r.run('drainFrames()');
    const plan=r.run('todo'), earlier=r.run('[...phases][0]');
    assert.equal(earlier.box.dataset.state,'settled');
    assert.equal(r.$('messages').children.at(-1),r.$('activity'),'waiting belongs after the new plan');
    assert.equal(r.$('messages').children.at(-2),plan);
    r.send('agent:tool-started',{toolCallId:'read',name:'read_file'});
    const current=r.run('details');
    assert.notEqual(current,earlier,'the plan separates earlier work from subsequent activity');
    assert.equal(r.$('messages').children.at(-1),current.box);
    assert.equal(r.$('messages').children.at(-2),plan);
    assert.equal(current.summary.textContent,'正在查阅资料');
    assert.equal(r.$('activity').hidden,true);
    const order=[...r.$('messages').children];
    r.send('agent:todo',{todos:[{title:'Inspect files',status:'done'},{title:'Summarize',status:'in_progress'}]});
    assert.equal(r.run('todo'),plan);assert.equal(r.run('details'),current);
    assert.deepEqual(r.$('messages').children,order,'updates keep the existing plan and activity in place');
    r.send('agent:tool-completed',{toolCallId:'read',success:true});
    r.send('agent:response-segment',{text:'Review complete'});r.send('agent:processing-done');r.send('hub:replay-done');
    assert.deepEqual(r.replies(),['Review complete']);
    assert.equal(current.box.dataset.state,'settled');assert.equal(r.$('activity').hidden,true);
    assert.equal(r.$('messages').children.filter(n=>n.className==='plan').length,1);
  });
}
test('task-list boundaries preserve late tool output and background collaborators in their original disclosure', () => {
  const r=setup();r.send('agent:processing-start');
  r.send('subagent:started',{subagentId:'reviewer',task:'Background review'});
  r.send('agent:tool-started',{toolCallId:'reviewer-tool-read',name:'read_file'});
  const earlier=r.run('details');
  r.send('agent:todo',{todos:[{title:'Check findings',status:'in_progress'}]});
  r.send('agent:thinking-chunk',{text:'Prepare findings'});const current=r.run('details');
  assert.notEqual(current,earlier);
  r.send('agent:request-status',{phase:'retrying'});
  r.send('agent:tool-output-chunk',{toolCallId:'reviewer-tool-read',chunk:'Original evidence'});
  r.send('agent:tool-completed',{toolCallId:'reviewer-tool-read',success:true});
  r.send('subagent:done',{subagentId:'reviewer'});
  earlier.box.open=true;earlier.box.ontoggle();
  assert.equal(earlier.outputs.get('reviewer-tool-read').textContent,'Original evidence');
  assert.equal(earlier.box.dataset.state,'settled');
  assert.equal(current.summary.textContent,'正在重试连接');
  r.send('agent:cancelled');r.send('agent:processing-done');
  assert.equal(current.summary.textContent,'已停止');assert.equal(r.$('activity').hidden,true);
});


for (const large of ['start','done','both']) test(`preview replay retains collaborator lifecycle with long ${large} records`, () => {
  const r=setup();
  const send=(name,payload)=>{
    const preview=mobileReplayFrame('data: '+JSON.stringify({meta:{name},payload})+'\n\n');
    const data=JSON.parse(preview.slice(6));r.send(data.meta.name,data.payload);
  };
  r.send('agent:processing-start');
  send('subagent:started',{subagentId:'reviewer',task:'Review',systemPrompt:large==='done'?'': 'instructions '.repeat(200)});
  const original=r.run('details');
  r.send('agent:response-segment',{text:'The background review continues'});r.send('agent:processing-done');
  assert.equal(original.summary.textContent,'正在协作处理','a started collaborator remains active after the main reply');
  send('agent:tool-started',{toolCallId:'reviewer-tool-read',name:'read_file',rawInput:{path:'paper.md'}});
  send('agent:tool-completed',{toolCallId:'reviewer-tool-read',success:true,rawOutput:'Evidence '.repeat(400)});
  send('subagent:done',{subagentId:'reviewer',task:'Review',result:large==='start'?'Complete':'Findings '.repeat(300)});
  r.send('hub:replay-done');
  assert.equal(original.summary.textContent,'处理记录');assert.equal(original.box.dataset.state,'settled');
  assert.equal(r.run('agentSteps.size'),0);assert.equal(r.run('phases.size'),1,'child events stay with their original disclosure');
});

for(const resolvedFirst of [false,true]) test(`approval acknowledgements survive replay replacing the card (resolvedFirst=${resolvedFirst})`,async()=>{
  const r=setup(),pending=deferred();r.fetch(()=>pending.promise);
  r.send('agent:processing-start');
  const request={requestId:'approval',expiresAt:Date.now()+60000};r.send('permission:request',request);
  const old=r.run("permissions.get('approval')");const decision=old.children[2].onclick();
  r.send('hub:branch-switched');r.send('agent:processing-start');r.send('agent:thinking-chunk',{text:'Continue'});r.send('permission:request',request);
  const current=r.run("permissions.get('approval')");
  if(resolvedFirst)r.send('permission:resolved',{requestId:'approval'});
  pending.resolve(ok({ok:true}));await decision;
  if(!resolvedFirst)r.send('permission:resolved',{requestId:'approval'});
  assert.equal(current.isConnected,false,'acknowledgement must not leave a replayed approval card stranded');
  assert.equal(r.run('permissions.size'),0);assert.equal(r.run('details.summary.textContent'),'正在梳理思路');
});
test('late approval acknowledgement cannot alter another conversation after switching',async()=>{
  const r=setup(),pending=deferred();r.fetch(()=>pending.promise);
  r.send('agent:processing-start');const request={requestId:'approval',expiresAt:Date.now()+60000};r.send('permission:request',request);
  const old=r.run("permissions.get('approval')"),decision=old.children[2].onclick();
  r.run("generation++;session='another';resetMessages()");r.send('agent:processing-start');r.send('permission:request',request);
  const current=r.run("permissions.get('approval')");pending.resolve(ok({ok:true}));await decision;
  assert.equal(r.run("permissions.get('approval')"),current);assert.equal(current.isConnected,true);
});

test('automatically completed plans reopen when the model adds new work',()=>{
  const r=setup();r.send('agent:processing-start');
  r.send('agent:todo',{todos:[{title:'Review',status:'done'}]});const plan=r.run('todo');assert.equal(plan.open,false);
  r.send('agent:todo',{todos:[{title:'Review',status:'done'},{title:'Verify',status:'in_progress'}]});
  assert.equal(r.run('todo'),plan);assert.equal(plan.open,true,'new active tasks must not remain hidden behind automatic collapse');
});
for(const open of [false,true]) test(`task progress preserves manual ${open?'expansion':'collapse'}`,()=>{
  const r=setup();r.send('agent:todo',{todos:[{title:'Review',status:open?'done':'in_progress'}]});const plan=r.run('todo');
  plan.children[0].onclick();plan.open=open; // Native summary click toggles open after the handler.
  for(const status of ['in_progress','done','pending']) {
    r.send('agent:todo',{todos:[{title:'Review',status}]});assert.equal(plan.open,open);
  }
});


for(const state of ['waiting','replying','completed','cancelled']) test(`child usage never creates progress or replaces main usage while ${state}`,()=>{
  const r=setup();r.send('agent:processing-start');
  r.send('agent:usage',{prompt_tokens:100,prompt_cache_hit_tokens:90,prompt_cache_miss_tokens:10});
  if(state==='waiting')r.send('agent:request-status',{phase:'retrying'});
  else {
    r.send('subagent:started',{subagentId:'background',task:'Review'});
    r.send('agent:response-segment',{text:'The review continues in the background'});
    if(state==='completed')r.send('agent:processing-done');
    if(state==='cancelled')r.send('agent:cancelled');
  }
  const nodes=[...r.$('messages').children],count=r.run('phases.size'),usage=r.$('usage').textContent;
  const labels=r.run('JSON.stringify([...phases].map(p=>p.summary.textContent))');
  for(let i=0;i<3;i++)r.send('subagent:usage',{type:'explore',prompt_tokens:1000,completion_tokens:200});
  assert.equal(r.run('phases.size'),count,'usage is telemetry, not a new processing phase');
  assert.deepEqual(r.$('messages').children,nodes);assert.equal(r.$('usage').textContent,usage);
  assert.equal(r.run('JSON.stringify([...phases].map(p=>p.summary.textContent))'),labels);
  if(state==='waiting')assert.equal(r.$('activity-text').textContent,'正在重试连接');
  if(state==='replying'){
    r.send('agent:response-segment',{text:' and here are the findings'});r.send('agent:processing-done');
    assert.deepEqual(r.replies(),['The review continues in the background and here are the findings']);
  }
});
for(const busy of [false,true]) test(`desktop UI errors remain visible without ending the reply (busy=${busy})`,()=>{
  const r=setup();if(busy){r.send('agent:processing-start');r.send('agent:tool-started',{toolCallId:'read',name:'read_file'});}
  const count=r.run('phases.size');
  const warning='History could not be saved. Keep this session open while storage is unavailable.';
  r.send('ui:error',{message:warning});r.send('hub:replay-done');
  assert.equal(r.$('notice').textContent,warning);assert.equal(r.$('notice').hidden,false);
  assert.equal(r.run('activity'),busy);assert.equal(r.run('turnOutcome'),'');assert.equal(r.run('phases.size'),count);
  assert.equal(r.$('messages').children.some(n=>n.className==='message interruption'),false);
  if(busy){r.send('agent:tool-completed',{toolCallId:'read'});r.send('agent:response-segment',{text:'Saved later'});r.send('agent:processing-done');assert.deepEqual(r.replies(),['Saved later']);}
  r.run('signOut()');assert.equal(r.$('notice').hidden,true);
});

let lifecycleFrames;
function actualLifecycle() {
  if (!lifecycleFrames) {
    const output=execFileSync(process.execPath,[fileURLToPath(new URL('./render-lifecycle-fixture.cjs',import.meta.url))],{encoding:'utf8',timeout:20000});
    lifecycleFrames=JSON.parse(output.split('\n').find(line=>line.startsWith('LIFECYCLE ')).slice(10));
  }
  return lifecycleFrames;
}
test('actual Hub desktop commands do not finish running work or detach its tool results',()=>{
  const r=setup();
  for(const f of actualLifecycle().live)r.send(f.meta.name,f.payload);
  const phase=r.run("agentSteps.get('background')");
  assert.equal(phase.done,false,'a slash command does not end the model turn');
  assert.equal(phase.summary.textContent,'等待你的确认');
  assert.equal(r.run("toolSteps.get('main-read')"),phase,'in-flight main tools retain their owner');
  for(const f of actualLifecycle().completion)r.send(f.meta.name,f.payload);
  assert.equal(r.$('messages').children.filter(e=>e.className==='detail').length,1,'late tool completion must not create a phantom phase');
  assert.deepEqual(r.replies(),['The background review continues.']);
});
test('actual Hub replay retains actionable background approvals after the main turn completes',()=>{
  const r=setup();
  for(const f of actualLifecycle().replay)r.send(f.meta.name,f.payload);
  const card=r.run("permissions.get('background-approval')"),phase=r.run("agentSteps.get('background')");
  assert(card?.isConnected,'a still-pending Hub approval must remain visible after replay');
  assert.equal(phase.summary.textContent,'等待你的确认');assert.equal(r.run('activity'),false);
  assert.equal(r.$('activity').hidden,true,'background approval must not restart main-turn thinking');
  for(const f of actualLifecycle().resolved)r.send(f.meta.name,f.payload);
  assert.equal(card.isConnected,false);assert.equal(phase.summary.textContent,'处理记录');
  assert.equal(r.run('permissions.size'),0);
});
function backgroundApproval() {
  const r=setup();r.run("user='demo';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];streamReady=true");
  r.send('agent:query',{query:'Review'});r.send('agent:processing-start');
  r.send('subagent:started',{subagentId:'background',task:'Save review notes'});
  r.send('permission:request',{requestId:'pending',expiresAt:Date.now()+60000,title:'Save review notes'});
  r.send('agent:response-segment',{text:'Background work continues'});r.send('agent:processing-done');
  return r;
}
test('a background approval stays usable after main completion without disabling new messages',async()=>{
  const r=backgroundApproval();const calls=[];
  r.fetch(async(_url,options)=>{calls.push(JSON.parse(options.body));return ok({ok:true});});
  const card=r.run("permissions.get('pending')");assert(card?.isConnected);
  assert.equal(r.$('send').disabled,false);assert.equal(r.$('model').disabled,false);
  assert.equal(r.run("agentSteps.get('background').summary.textContent"),'等待你的确认');
  await card.children[2].onclick();
  assert.equal(calls[0].op,'permission');assert.equal(calls[0].args.outcome,'approved');
  assert.equal(card.isConnected,false);assert.equal(r.run("agentSteps.get('background').summary.textContent"),'正在协作处理');
});
for(const ending of ['expire','cleanup','cancel'])test(`background approval cleanup remains correct after main completion (${ending})`,()=>{
  const r=backgroundApproval();const phase=r.run("agentSteps.get('background')"),card=r.run("permissions.get('pending')");
  assert(card?.isConnected);
  if(ending==='expire')for(const fn of r.timers.values())fn();
  else r.send(ending==='cancel'?'agent:cancelled':'permission:request-cleanup');
  assert.equal(r.run('permissions.size'),0);assert.notEqual(phase.summary.textContent,'等待你的确认');
  if(ending==='expire')assert.equal(card.children[0].textContent,'此审批已到期');else assert.equal(card.isConnected,false);
  assert.equal(r.$('activity').hidden,true);
});
test('desktop commands keep task updates on the same plan instead of duplicating it',()=>{
  const r=setup();r.send('agent:query',{query:'Review'});r.send('agent:processing-start');
  r.send('agent:todo',{todos:[{title:'Read',status:'pending'}]});const plan=r.run('todo');
  r.send('agent:query',{query:'/think',command:true});
  r.send('agent:todo',{todos:[{title:'Read',status:'done'}]});
  assert.equal(r.$('messages').children.filter(e=>e.className==='plan').length,1);
  assert.equal(r.run('todo'),plan);assert.equal(plan.children[0].textContent,'任务进度 · 1/1');
});
test('desktop commands between live text and its persisted segment cannot duplicate the answer',()=>{
  const r=setup();r.send('agent:query',{query:'Review'});r.send('agent:processing-start');
  r.send('agent:response-chunk',{blocks:[{type:'text',text:'Partial answer'}]});
  r.send('agent:query',{query:'/think',command:true});
  r.send('agent:response-segment',{text:'Partial answer'});r.send('agent:processing-done');
  assert.deepEqual(r.replies(),['Partial answer']);
});

for(const action of ['image','permission'])for(const change of ['none','switch','replay'])test(`late ${action} errors respect the current message view (${change})`,async()=>{
  const r=setup(),pending=deferred();r.run("user='demo';device='desktop';session='aaaaaa'");r.fetch(()=>pending.promise);
  let button;
  if(action==='image'){
    r.send('agent:query',{query:'Review image',images:[{id:'aaaaaa_img_test_one'}]});
    button=r.$('messages').children.find(e=>e.className==='message user').children[0];
  }else{
    r.send('agent:processing-start');r.send('permission:request',{requestId:'pending',expiresAt:Date.now()+60000});
    button=r.run("permissions.get('pending').children[2]");
  }
  const request=button.onclick();
  if(change==='switch')r.run("generation++;session='bbbbbb';resetMessages();notice('Current conversation status')");
  if(change==='replay')r.run("resetMessages();notice('Current conversation status')");
  pending.resolve(failure(503,'Previous operation failed'));await request;
  assert.equal(r.$('notice').textContent,change==='none'?'Previous operation failed':'Current conversation status');
});
test('an already-resolved approval cannot show a late conflict as a new warning',async()=>{
  const r=setup(),pending=deferred();r.fetch(()=>pending.promise);
  r.send('agent:processing-start');r.send('permission:request',{requestId:'pending',expiresAt:Date.now()+60000});
  const request=r.run("permissions.get('pending').children[2].onclick()");
  r.send('permission:resolved',{requestId:'pending'});
  pending.resolve(failure(409,'permission expired or already handled'));await request;
  assert.equal(r.$('notice').textContent,'');assert.equal(r.run('permissions.size'),0);
});
test('a replayed pending approval still reports a real decision failure',async()=>{
  const r=setup(),pending=deferred();r.fetch(()=>pending.promise);
  const payload={requestId:'pending',expiresAt:Date.now()+60000};
  r.send('agent:processing-start');r.send('permission:request',payload);
  const request=r.run("permissions.get('pending').children[2].onclick()");
  r.send('hub:branch-switched');r.send('agent:processing-start');r.send('permission:request',payload);
  pending.resolve(failure(503,'Decision not confirmed'));await request;
  assert.equal(r.$('notice').textContent,'Decision not confirmed');
  assert.equal(r.run("permissions.get('pending').isConnected"),true);
});

for(const busy of [false,true])test(`backgrounding immediately disables stale controls until replay completes (busy=${busy})`,async()=>{
  const r=setup(),pending=deferred();
  r.context.EventSource=class{constructor(){this.handlers=new Map();}addEventListener(name,fn){this.handlers.set(name,fn);}close(){this.closed=true;}};
  r.run("user='demo';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];capabilitiesDevice=device;connectStream()");
  if(busy)r.send('agent:processing-start');r.send('hub:replay-done');
  r.$('query').value='Unsent draft';
  assert.equal(r.$('send').disabled,false);
  r.context.document.hidden=true;r.listeners.get('visibilitychange').fn();
  assert.equal(r.run('streamReady'),false);
  for(const id of ['query','send','model','image-input'])assert.equal(r.$(id).disabled,true,`${id} must not look usable with a closed stream`);
  assert.equal(r.$('stop').hidden,true);
  assert.doesNotMatch(r.$('connection').textContent,/已同步/);
  assert.equal(r.$('query').value,'Unsent draft');
  r.fetch(()=>pending.promise);r.context.document.hidden=false;r.listeners.get('visibilitychange').fn();
  assert.equal(r.$('send').disabled,true,'resuming must not unlock controls while the device refresh is pending');
  r.fetch(async()=>ok([{instanceId:'aaaaaa',title:'Review'}]));pending.resolve(ok([{id:'desktop',online:true}]));
  for(let i=0;i<20;i++)await Promise.resolve();
  assert(r.run('!!source'),'foreground recovery reconnects the event stream');
  r.run("source.handlers.get('reset')()");if(busy)r.send('agent:processing-start');
  assert.equal(r.$('send').disabled,true);
  r.send('hub:replay-done');
  assert.equal(r.$('send').disabled,false);assert.equal(r.$('query').disabled,false);
  assert.equal(r.$('model').disabled,busy);assert.equal(r.$('stop').hidden,!busy);
  assert.equal(r.$('query').value,'Unsent draft');assert.match(r.$('connection').textContent,/已同步/);
});

test('actual Hub branch replay locks the composer until every history batch is rendered', async () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./render-branch-fixture.cjs', import.meta.url))], { encoding: 'utf8', timeout: 20000 });
  const frames = JSON.parse(output.split('\n').find(line => line.startsWith('BRANCH ')).slice(7));
  const r = setup();
  r.run("user='demo';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];source={close(){throw Error('branch replay must keep its stream')}}");
  r.send('agent:query', {query:'Old branch'}); r.send('agent:response-segment', {text:'Old answer'});
  r.send('agent:processing-done'); r.send('hub:replay-done');
  r.$('query').value = 'Unsent draft'; r.run("images=[{name:'draft.png',data:'AAAA',mimeType:'image/png'}];renderAttachments()");
  r.context.rebuiltFrames = frames; r.run('for(const data of rebuiltFrames)enqueueFrame(data)');
  assert.equal(r.$('send').disabled, false);
  r.run('drainFrames()');
  assert(r.run('frameQueue.length') > 0, 'replay must span multiple UI tasks');
  assert.equal(r.run('streamReady'), false, 'a rebuilt branch is not synced while history remains queued');
  for (const id of ['send','query','model','image-input']) assert.equal(r.$(id).disabled, true, id);
  assert.equal(r.$('stop').hidden, true, 'historical processing-start frames must not expose a live stop action');
  assert.match(r.$('connection').textContent, /正在同步/);
  let requests = 0; r.fetch(async () => { requests++; return ok({state:'done'}); });
  await r.$('composer').onsubmit({preventDefault(){}});
  assert.equal(requests, 0, 'submitting during replay must not send a request');
  r.run('while(frameQueue.length)drainFrames()');
  assert.equal(r.run('streamReady'), true); assert.equal(r.$('send').disabled, false);
  assert.equal(r.$('model').disabled, false); assert.equal(r.$('stop').hidden, true);
  assert.match(r.$('connection').textContent, /已同步/);
  assert.deepEqual(r.replies(), Array.from({length:29}, (_,i) => `Answer ${i}`));
  assert.equal(r.$('query').value, 'Unsent draft'); assert.equal(r.run('images[0].name'), 'draft.png');
});

test('rewound short conversations keep the complete-history action when reconnecting with previews', async () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./render-preview-fixture.cjs', import.meta.url))], { encoding: 'utf8', timeout: 20000 });
  const {preview, full} = JSON.parse(output.split('\n').find(line => line.startsWith('PREVIEW ')).slice(8));
  const r = setup();
  r.context.EventSource = class {
    constructor(url) { this.url = url; this.handlers = new Map(); }
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    close() {}
  };
  r.run("user='demo';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];connectStream();source.handlers.get('reset')()");
  for (const data of preview) r.send(data.meta.name, data.payload);
  const banners = () => r.$('messages').children.filter(node => node.className === 'history-window');
  assert.equal(banners().length, 1, 'previewed records must retain the full-history action after a persisted branch reset');
  assert.equal(r.$('messages').children[0], banners()[0], 'the preview notice belongs above the messages');
  assert.equal(r.run('streamReady'), true);
  r.run('for(const phase of phases){phase.box.open=true;phase.box.ontoggle()}');
  const previewCall = r.run('[...phases].flatMap(phase=>[...(phase.callRows?.values() || [])]).find(call=>call.result?.detailsOmitted)');
  assert(previewCall); previewCall.row.open=true;previewCall.row.ontoggle();
  assert.equal(previewCall.resultSection.hidden,false,'the compact preview must be readable without expanding raw JSON');
  assert.match(previewCall.resultText.textContent,/Report detail/);
  await banners()[0].children[1].onclick();
  assert.equal(r.run('source.url.searchParams.get("history")'), 'all');
  assert.equal(r.run('streamReady'), false);
  r.run("source.handlers.get('reset')()");
  for (const data of full) r.send(data.meta.name, data.payload);
  assert.equal(banners().length, 0, 'full history must not retain a stale preview notice');
  assert.deepEqual(r.replies(), ['Reading the file','The report is ready']);
  r.run('for(const phase of phases){phase.box.open=true;phase.box.ontoggle()}');
  const result = r.run('[...phases].flatMap(phase=>[...(phase.callRows?.values() || [])]).find(call=>call.result)');
  assert(result); result.row.open = true; result.row.ontoggle();
  assert.match(result.resultText.textContent, /END_OF_FULL_RESULT/);
  assert.equal(result.resultSection.children[0].textContent,'结果','full history must not keep a stale preview label');
  r.run('signOut()'); assert.equal(banners().length, 0);
});

test('a live branch replacement removes the previous preview notice without reviving old messages', () => {
  const r = setup(); r.send('hub:history-window', {hasEarlier:true});
  r.send('agent:query', {query:'Previous branch'}); r.send('hub:replay-done');
  r.send('hub:branch-switched'); r.send('agent:query', {query:'New branch'}); r.send('hub:replay-done');
  assert.equal(r.$('messages').children.filter(node=>node.className==='history-window').length, 0);
  assert.equal(r.$('messages').children.filter(node=>node.className==='message user').map(node=>node.textContent).join(''), 'New branch');
});

function deviceRefreshFixture() {
  const r = setup();
  r.context.EventSource = class { addEventListener() {} close() { this.closed = true; } };
  r.run("user='alice';device='desktop';session='aaaaaa';devices=[{id:device,name:'Computer',online:true}];sessions=[{instanceId:session,title:'Review'}];capabilitiesDevice=device;connectStream()");
  r.send('agent:processing-start'); r.send('agent:thinking-chunk', {text:'Reviewing'}); r.send('hub:replay-done');
  r.$('query').value = 'Keep this draft';
  return r;
}
function freshDeviceResponse(r, online) {
  r.fetch(async url => String(url).endsWith('/devices')
    ? ok([{id:'desktop',name:'Computer',online}]) : ok([{instanceId:'aaaaaa',title:'Review'}]));
}
for (const oldState of ['offline','missing']) test(`late ${oldState} device snapshots cannot replace a newer online view`, async () => {
  const r = deviceRefreshFixture(), pending = deferred(), source = r.run('source');
  r.fetch(() => pending.promise); const older = r.run('refreshDevices()');
  freshDeviceResponse(r, true); await r.run('refreshDevices()');
  pending.resolve(ok(oldState === 'missing' ? [] : [{id:'desktop',name:'Computer',online:false}]));
  await older;
  assert.equal(r.run('session'), 'aaaaaa'); assert.equal(r.run('source'), source);
  assert.notEqual(source.closed, true); assert.equal(r.$('send').disabled, false);
  assert.equal(r.run('streamReady'), true); assert.equal(r.$('device-status').textContent, '● 电脑在线');
  assert.equal(r.$('query').value, 'Keep this draft'); assert.equal(r.run('phases.size'), 1);
});
test('a late online device snapshot cannot reopen a newer offline view', async () => {
  const r = deviceRefreshFixture(), pending = deferred();
  r.fetch(() => pending.promise); const older = r.run('refreshDevices()');
  freshDeviceResponse(r, false); await r.run('refreshDevices()');
  freshDeviceResponse(r, true); pending.resolve(ok([{id:'desktop',name:'Computer',online:true}])); await older;
  assert.equal(r.run('source'), null); assert.equal(r.run('streamReady'), false);
  assert.equal(r.$('device-status').textContent, '○ 电脑离线'); assert.match(r.$('connection').textContent, /电脑离线/);
  assert.equal(r.$('query').value, 'Keep this draft');
});
test('a session-list response cannot reconnect after a newer offline device refresh', async () => {
  const r = deviceRefreshFixture(), pending = deferred(); let sessionsRequested = false;
  r.fetch(async url => {
    if (String(url).endsWith('/devices')) return ok([{id:'desktop',name:'Computer',online:true}]);
    sessionsRequested = true; return pending.promise;
  });
  const older = r.run('refreshDevices()');
  while (!sessionsRequested) await Promise.resolve();
  freshDeviceResponse(r, false); await r.run('refreshDevices()');
  pending.resolve(ok([{instanceId:'aaaaaa',title:'Review'}])); await older;
  assert.equal(r.run('source'), null); assert.equal(r.run('streamReady'), false);
  assert.match(r.$('connection').textContent, /电脑离线/); assert.equal(r.$('send').disabled, true);
});
test('superseded device refresh failures cannot show a stale warning after recovery', async () => {
  const r = deviceRefreshFixture(), pending = deferred();
  r.fetch(() => pending.promise); const older = r.$('refresh').onclick();
  freshDeviceResponse(r, true); await r.run('refreshDevices()');
  pending.resolve(failure(503, 'Old connection failure')); await older;
  assert.equal(r.$('notice').textContent, ''); assert.equal(r.$('send').disabled, false);
});
test('the latest device refresh still reports a real connection failure', async () => {
  const r = deviceRefreshFixture(); r.fetch(async () => failure(503, 'Current connection failure'));
  await r.$('refresh').onclick(); assert.equal(r.$('notice').textContent, 'Current connection failure');
});

for (const outcome of ['empty','failed']) test(`an obsolete ${outcome} session list cannot replace the newer offline view`, async () => {
  const r = deviceRefreshFixture(), pending = deferred(); let sessionsRequested = false;
  r.fetch(async url => {
    if (String(url).endsWith('/devices')) return ok([{id:'desktop',name:'Computer',online:true}]);
    sessionsRequested = true; return pending.promise;
  });
  const older = r.$('refresh').onclick();
  while (!sessionsRequested) await Promise.resolve();
  freshDeviceResponse(r, false); await r.run('refreshDevices()');
  pending.resolve(outcome === 'empty' ? ok([]) : failure(503, 'Obsolete session failure')); await older;
  assert.equal(r.run('session'), 'aaaaaa'); assert.equal(r.run('source'), null);
  assert.match(r.$('connection').textContent, /电脑离线/); assert.equal(r.$('notice').textContent, '');
  assert.equal(r.$('query').value, 'Keep this draft'); assert.equal(r.run('phases.size'), 1);
});


test('mobile landing exposes selection immediately and survives closing the drawer', async () => {
  const r = setup({ mobile: true });
  r.fetch(async () => ok([])); await r.run("start('alice')");
  assert.equal(r.$('workspace').classList.contains('choosing-session'), true);
  assert.equal(r.$('sidebar').inert, false);
  assert.equal(r.$('shade').hidden, true);
  assert.equal(r.$('devices').disabled, true);
  assert.match(r.$('selection-state').textContent, /登录同一账号/);
  r.run('menu(true); menu(false)');
  assert.equal(r.$('sidebar').inert, false);
  assert.equal(r.$('query').disabled, true);
});

test('mobile selection has distinct offline, loading, empty and filtered states', () => {
  const r = setup({ mobile: true });
  r.run("user='alice'; device='desk'; devices=[{id:device,online:false}]; deviceListReady=true; controls()");
  assert.match(r.$('selection-state').textContent, /电脑离线/);
  r.run('devices[0].online=true; controls()');
  assert.match(r.$('selection-state').textContent, /正在读取共享对话/);
  r.run("sessionListDevice=device; renderSessions()");
  assert.match(r.$('selection-state').textContent, /暂无共享对话/);
  r.run("sessions=[{instanceId:'abcdef',title:'Research'}]; renderSessions()");
  assert.equal(r.$('selection-state').hidden, true);
  r.$('session-search').value = 'unknown'; r.run('renderSessions()');
  assert.match(r.$('sessions').children[0].textContent, /没有符合条件/);
});

test('opening a mobile conversation enters chat and removing it restores selection', async () => {
  const r = setup({ mobile: true });
  r.context.EventSource = class { close() {} addEventListener() {} };
  r.run("user='alice'; device='desk'; devices=[{id:device,online:true}]; deviceListReady=true; sessions=[{instanceId:'abcdef',title:'Research'}]; renderSessions()");
  await r.run("openSession('abcdef')");
  assert.equal(r.$('workspace').classList.contains('choosing-session'), false);
  assert.equal(r.$('sidebar').inert, true);
  r.run('menu(true)'); assert.equal(r.$('sidebar').inert, false);
  r.$('query').value = 'unfinished draft';
  r.run('resetSession()');
  assert.equal(r.$('workspace').classList.contains('choosing-session'), true);
  assert.equal(r.$('sidebar').inert, false);
  assert.equal(r.$('shade').hidden, true);
  assert.equal(r.stored.get('ashub-mobile:alice:desk:abcdef:draft'), 'unfinished draft');
});

test('mobile landing surfaces fetch failures and recovers with refresh', async () => {
  const r = setup({ mobile: true });
  r.fetch(async () => { throw Error('network unavailable'); });
  await r.run("start('alice')");
  assert.equal(r.$('selection-notice').textContent, 'network unavailable');
  assert.equal(r.$('selection-notice').hidden, false);
  assert.equal(r.$('selection-state').hidden, true);
  r.fetch(async () => ok([])); await r.$('refresh').onclick();
  assert.equal(r.$('selection-notice').hidden, true);
  assert.equal(r.$('selection-state').hidden, false);
  r.run('signOut()'); assert.equal(r.$('selection-notice').textContent, '');
});


test('mobile home shows received sessions before optional capability lookup finishes', async () => {
  const r = setup({ mobile: true }), pending = deferred(); let capabilitiesRequested = false;
  r.run("user='alice'; device='desk'; devices=[{id:device,online:true}]; deviceListReady=true");
  r.fetch(async (_url, options) => {
    const {op} = JSON.parse(options.body);
    if (op === 'sessions') return ok([{instanceId:'abcdef', title:'Ready to open'}]);
    if (op === 'capabilities') { capabilitiesRequested = true; return pending.promise; }
    return ok([]);
  });
  const reading = r.run('refreshSessions()');
  while (!capabilitiesRequested || !sessionRows(r).length) await Promise.resolve();
  const renderedIds = sessionRows(r).map(e => e.dataset.sessionId);
  pending.resolve(ok({})); await reading;
  assert.deepEqual(renderedIds, ['abcdef'], 'received conversations must not wait for optional metadata');
});


test('opening an early session list invalidates pending metadata without resetting chat', async () => {
  const r = setup({ mobile: true }), pending = deferred(); let capabilitiesRequested = false, groupsRequested = false;
  r.context.EventSource = class { close() {} addEventListener() {} };
  r.run("user='alice'; device='desk'; devices=[{id:device,online:true}]; deviceListReady=true");
  r.fetch(async (_url, options) => {
    const {op} = JSON.parse(options.body);
    if (op === 'sessions') return ok([{instanceId:'abcdef',title:'Ready to open'}]);
    if (op === 'capabilities') { capabilitiesRequested = true; return pending.promise; }
    groupsRequested = true; return ok([]);
  });
  const reading = r.run('refreshSessions()');
  while (!capabilitiesRequested || !sessionRows(r).length) await Promise.resolve();
  await sessionRows(r)[0].onclick();
  const source = r.run('source');
  pending.resolve(ok({projects:true})); await reading;
  assert.equal(r.run('session'), 'abcdef'); assert.equal(r.run('source'), source);
  assert.equal(r.$('workspace').classList.contains('choosing-session'), false);
  assert.equal(groupsRequested, false);
});


test('independent filters exclude project conversations but project view retains them',()=>{
 const r=setup({mobile:true});
 r.run("viewFilter='all';sessions=[{instanceId:'aaaaaa',title:'Independent',projectId:null},{instanceId:'bbbbbb',title:'Grouped',projectId:'p',hasUnread:true},{instanceId:'cccccc',title:'Legacy grouped'}];groups=[{id:'p',name:'Project',sessionIds:['bbbbbb','cccccc']}];renderSessions()");
 assert.deepEqual(r.$('sessions').children.map(n=>n.dataset.sessionId),['aaaaaa']);
 r.run("viewFilter='project:p';renderSessions()");
 assert.deepEqual(r.$('sessions').children.map(n=>n.dataset.sessionId),['bbbbbb','cccccc']);
 r.run("viewFilter='all';sessions[1].projectId=null;renderSessions()");
 assert.deepEqual(r.$('sessions').children.map(n=>n.dataset.sessionId),['aaaaaa','bbbbbb']);
 r.run("groups=[];renderSessions()");
 assert.deepEqual(r.$('sessions').children.map(n=>n.dataset.sessionId),['aaaaaa','bbbbbb','cccccc']);
});

for (const failedOp of ['capabilities','project-groups']) test(`temporary ${failedOp} failure preserves the selected project and recovers`, async () => {
 const r=setup();
 r.run("user='alice';device='desk';capabilitiesDevice='desk';capabilities={projects:true};groups=[{id:'p',name:'Project',sessionIds:['aaaaaa']}];viewFilter='project:p'");
 if(failedOp==='capabilities')r.run("capabilitiesDevice=''");
 let fail=true, empty=false;
 r.fetch(async (_url,options)=>{
   const {op}=JSON.parse(options.body);
   if(op==='sessions')return ok([{instanceId:'aaaaaa',title:'Project chat',projectId:empty?null:'p'}]);
   if(fail && op===failedOp)return failure(503,'Temporary disconnect');
   if(op==='capabilities')return ok({projects:true});
   if(op==='project-groups')return ok(empty?[]:[{id:'p',name:'Project',sessionIds:['aaaaaa']}]);
   throw Error('Unexpected operation');
 });
 await r.run('refreshSessions()');
 assert.equal(r.run('viewFilter'),'project:p');assert.equal(r.run('groups.length'),1);
 assert.equal(sessionRows(r)[0].dataset.sessionId,'aaaaaa');
 assert.match(r.$('notice').textContent,/暂时无法更新/);
 fail=false;await r.run('refreshSessions()');assert.equal(r.run('viewFilter'),'project:p');assert.equal(r.$('notice').textContent,'');
 empty=true;await r.run('refreshSessions()');assert.equal(r.run('viewFilter'),'browse');assert.equal(r.run('groups.length'),0);
 assert.equal(sessionRows(r)[0].dataset.sessionId,'aaaaaa');
});

test('queued messages show independent edit actions and restore text and image references', async () => {
  const r=setup();
  r.run(`user='alice';device='desktop';session='aaaaaa';capabilities={queue:true};streamReady=true;images=[];queuedMessages=[{id:'first',query:'same'},{id:'second',query:'same',images:[{id:'aaaaaa_img_a_b',mimeType:'image/png'}]}];renderQueue()`);
  assert.equal(r.$('queued-messages').children.length,2);
  assert.equal(r.$('messages').children.length,0,'pending messages must not disturb streamed response ordering');
  r.$('query').value='new draft';let body;
  r.fetch(async(_url,opts)=>{body=JSON.parse(opts.body);return ok({id:'second',query:'same',images:[{id:'aaaaaa_img_a_b',mimeType:'image/png'}]});});
  await r.run('withdrawMessage(queuedMessages[1])');
  assert.equal(body.op,'queue-withdraw');assert.equal(body.args.id,'second');
  assert.equal(r.$('query').value,'same\nnew draft');
  assert.equal(r.run('images[0].id'),'aaaaaa_img_a_b');
  assert.equal(r.run('queuedMessages.length'),1);assert.equal(r.run('pendingWithdrawals().length'),0);
});
test('withdrawal retry reuses its request ID after a lost response', async () => {
  const r=setup();r.run(`user='alice';device='desktop';session='aaaaaa';capabilities={queue:true};streamReady=true;queuedMessages=[{id:'first',query:'restore me'}]`);
  const ids=[];r.fetch(async(_url,opts)=>{ids.push(JSON.parse(opts.body).args.requestId);throw Error('offline');});
  await r.run('withdrawMessage(queuedMessages[0])');
  assert.equal(r.run('pendingWithdrawals().length'),1);assert.equal(r.$('query').value,'');
  r.fetch(async(_url,opts)=>{ids.push(JSON.parse(opts.body).args.requestId);return ok({id:'first',query:'restore me'});});
  await r.run('withdrawMessage(queuedMessages[0])');assert.equal(ids[0],ids[1]);assert.equal(r.$('query').value,'restore me');
});
test('withdrawal completing after navigation restores only the owning draft', async () => {
  const r=setup(),pending=deferred();r.run(`user='alice';device='desktop';session='aaaaaa';capabilities={queue:true};streamReady=true;queuedMessages=[{id:'first',query:'old chat'}]`);
  r.$('query').value='existing';r.fetch(()=>pending.promise);
  const result=r.run('withdrawMessage(queuedMessages[0])');
  r.run(`saveDraft();generation++;session='bbbbbb';images=[];$('query').value='other conversation'`);
  pending.resolve(ok({id:'first',query:'old chat',images:[{id:'aaaaaa_img_a_b',mimeType:'image/png'}]}));await result;
  assert.equal(r.$('query').value,'other conversation');assert.equal(r.run('images.length'),0);
  assert.equal(r.run(`storage.get('ashub-mobile:alice:desktop:aaaaaa:draft')`),'old chat\nexisting');
  assert.equal(r.run(`draftImages('ashub-mobile:alice:desktop:aaaaaa:draft')[0].id`),'aaaaaa_img_a_b');
});
test('started queued messages cannot be restored as drafts after a conflict', async () => {
  const r=setup();r.run(`user='alice';device='desktop';session='aaaaaa';capabilities={queue:true};streamReady=true;queuedMessages=[{id:'first',query:'already running'}]`);
  r.$('query').value='keep';r.fetch(()=>failure(409,'Message is no longer queued'));
  await r.run('withdrawMessage(queuedMessages[0])');
  assert.equal(r.$('query').value,'keep');assert.equal(r.run('pendingWithdrawals().length'),0);
});
test('queued image references survive draft reload and resubmit without conversion', async () => {
  const r=setup();r.run(`user='alice';device='desktop';session='aaaaaa';storeImages(key('draft'),[{id:'aaaaaa_img_a_b',mimeType:'image/png',name:'image'}]);imageDrafts.clear();images=draftImages();streamReady=true`);
  r.$('query').value='edited';let sent;
  r.fetch(async(_url,opts)=>{const body=JSON.parse(opts.body);if(body.op==='submit'){sent=body.args;return ok({state:'done'});}return ok({state:'done',result:{queued:true}});});
  await r.$('composer').onsubmit({preventDefault(){}});
  assert.equal(sent.images[0].id,'aaaaaa_img_a_b');assert.equal(r.run('images.length'),0);
  assert.equal(r.run(`JSON.parse(storage.get(key('draft')+':images')).length`),0);
});
test('image send acknowledged after navigation removes submitted attachments but preserves new ones', async () => {
 const r=setup();r.run(`user='alice';device='desktop';session='aaaaaa';streamReady=true;images=[{id:'aaaaaa_img_a_b',mimeType:'image/png',name:'sent'}]`);
 const pending=deferred();r.fetch(()=>pending.promise);
 const send=r.$('composer').onsubmit({preventDefault(){}});
 r.run(`saveDraft();generation++;pendingSend=null;images=draftImages();images.push({data:'bmV3',mimeType:'image/png',name:'new'})`);
 pending.resolve(ok({state:'pending'}));await send;
 r.fetch(()=>ok({state:'done',result:{queued:true}}));
 await r.run(`checkPending(storage.get(key('pending')),generation,key('pending'))`);
 assert.equal(r.run('images.length'),1);assert.equal(r.run('images[0].name'),'new');
});

test('withdrawal completing after leaving and returning to the same chat clears its queue action', async () => {
 const r=setup(),pending=deferred();
 r.run(`user='alice';device='desktop';session='aaaaaa';capabilities={queue:true};streamReady=true;queuedMessages=[{id:'first',query:'restore'}];renderQueue()`);
 r.fetch(()=>pending.promise);
 const done=r.run('withdrawMessage(queuedMessages[0])');
 r.run(`generation+=2;renderQueue()`); // A → B → A, while the withdrawal is still in flight.
 assert.equal(r.$('queued-messages').children[0].children[2].disabled,true);
 pending.resolve(ok({id:'first',query:'restore'}));await done;
 assert.equal(r.$('query').value,'restore');
 assert.equal(r.run('queuedMessages.length'),0);
 assert.equal(r.$('queued-messages').hidden,true);
});
test('failed withdrawal after leaving and returning to the same chat remains retryable', async () => {
 const r=setup(),pending=deferred();
 r.run(`user='alice';device='desktop';session='aaaaaa';capabilities={queue:true};streamReady=true;queuedMessages=[{id:'first',query:'restore'}]`);
 r.fetch(()=>pending.promise);const done=r.run('withdrawMessage(queuedMessages[0])');
 r.run(`generation+=2;renderQueue()`);
 pending.resolve(failure(502,'offline'));await done;
 assert.equal(r.$('queued-messages').children[0].children[2].disabled,false);
 assert.equal(r.run('pendingWithdrawals().length'),1);
});

test('withdrawal completing after an account change does not alter the current draft or queue', async () => {
 const r=setup(),pending=deferred();
 r.run(`user='alice';device='desktop';session='aaaaaa';capabilities={queue:true};streamReady=true;queuedMessages=[{id:'first',query:'alice message'}]`);
 r.fetch(()=>pending.promise);const done=r.run('withdrawMessage(queuedMessages[0])');
 r.run(`user='bob';generation++;queuedMessages=[{id:'bob-queue',query:'bob message'}];$('query').value='bob draft';renderQueue()`);
 pending.resolve(ok({id:'first',query:'alice message'}));await done;
 assert.equal(r.$('query').value,'bob draft');assert.equal(r.run('queuedMessages[0].id'),'bob-queue');
 assert.equal(r.run('pendingWithdrawals().length'),0);
});

test('project directory marker uses desktop metadata even when the primary conversation is not shared',async()=>{
 const r=setup();r.run(`user='alice';device='desktop';groups=[{id:'p',name:'Research',sessionIds:['aaaaaa','bbbbbb']}];viewFilter='project:p';sessions=[{instanceId:'aaaaaa',title:'External',cwd:'/work/文献资料',projectId:'p',projectExternal:true},{instanceId:'bbbbbb',title:'Main',cwd:'/work/main',projectId:'p',projectExternal:false}];renderSessions()`);
 const row=r.$('sessions').children[0];assert.equal(row.className,'session-entry');
 assert.equal(row.children[1].textContent,'其他目录 · 文献资料');
 assert.equal(r.$('sessions').children[1].className,'session-button');
 await row.children[1].onclick();assert.equal(r.$('modal-body').children[0].textContent,'/work/文献资料');assert.equal(r.run('session'),'');
});
test('older desktops fall back to membership order for directory badges',()=>{
 const r=setup();r.run(String.raw`groups=[{id:'p',sessionIds:['aaaaaa','bbbbbb']}];viewFilter='project:p';sessions=[{instanceId:'bbbbbb',cwd:'C:\\Work\\Other'},{instanceId:'aaaaaa',cwd:'C:\\Work\\Main'}];renderSessions()`);
 assert.equal(r.$('sessions').children[0].children[1].textContent,'其他目录 · Other');
 assert.equal(r.$('sessions').children[1].className,'session-button');
 r.run(`viewFilter='all';renderSessions()`);assert.equal(r.$('sessions').children.length,1);assert.equal(r.$('sessions').children[0].className,'empty-list');
});


test('explicit operation preview survives mobile replay with plain text and one-time controls', () => {
  const r = setup();
  r.send('permission:request', { requestId: 'explicit-operation', explicit: true, pending: true, expiresAt: Date.now() + 300000,
    title: 'Confirm', items: [{ title: 'Create conversation', fields: [{ label: 'Instructions', value: '<script>never execute</script>' }] }] });
  const card = r.$('messages').children.find(e => e.className === 'permission');
  const preview = card.children.find(e => e.className === 'approval-items');
  assert.equal(preview.children[0].children[1].children[1].textContent, '<script>never execute</script>');
  assert.equal(preview.children[0].children[1].children[1].innerHTML, '');
  r.send('permission:resolved', { requestId: 'explicit-operation', outcome: 'denied' });
  assert.equal(r.run('permissions.size'), 0);
});

function completedRecord(r, text) {
  r.send('agent:processing-start');
  r.send('agent:thinking-chunk', { text });
  r.send('agent:processing-done');
}
test('adjacent finished records share one lazy disclosure without losing diagnostic text', () => {
  const r = setup();
  for (const text of ['first', 'second', 'third']) completedRecord(r, text);
  const nodes = r.$('messages').children;
  assert.equal(nodes.length, 1);
  const group = nodes[0];
  assert.equal(group.className, 'detail record-group');
  assert.equal(group.children[0].textContent, '处理记录');
  assert.equal(group._recordPhases.length, 3);
  for (const phase of group._recordPhases) { assert.equal(phase.pending.length, 1); assert.equal(phase.body.children.length, 0); }
  group.open = true; group.ontoggle();
  assert.deepEqual(Array.from(group._recordPhases, p => p.thinking.textContent), ['first', 'second', 'third']);
  group.ontoggle();
  assert.deepEqual(Array.from(group._recordPhases, p => p.thinking.textContent), ['first', 'second', 'third']);
  r.send('hub:branch-switched');
  assert.equal(r.$('messages').children.length, 0);
});
test('finished record grouping preserves text, plan, approval and user-message boundaries', () => {
  for (const boundary of [
    r => { r.send('agent:response-segment', { text: 'Answer stays here' }); r.send('agent:processing-done'); },
    r => r.send('agent:todo', { todos: [{ title: 'Review', status: 'pending' }] }),
    r => r.send('permission:request', { requestId: 'approval', expiresAt: Date.now() + 60000 }),
    r => r.send('agent:query', { query: 'Next question' }),
  ]) {
    const r = setup(); completedRecord(r, 'first'); boundary(r); completedRecord(r, 'second');
    assert.equal(r.$('messages').children.filter(n => n._recordPhases).length, 0);
    assert.equal(r.$('messages').children[0]._recordPhase.thinking, undefined);
  }
});
test('active, interrupted and stopped records remain distinct from successful records', () => {
  for (const outcome of ['agent:error', 'agent:cancelled']) {
    const r = setup(); completedRecord(r, 'first');
    r.send('agent:processing-start'); r.send('agent:thinking-chunk', { text: 'still working' });
    const active = r.run('details');
    assert.equal(active.box.parentNode, r.$('messages')); assert.equal(active.box.dataset.state, 'running');
    r.send(outcome, { message: 'connection failed' });
    assert.equal(r.$('messages').children.filter(n => n._recordPhases).length, 0);
    assert.equal(active.summary.textContent, outcome === 'agent:error' ? '回复中断' : '已停止');
  }
});
test('a later interruption unwraps a finished record group without losing its details', () => {
  const r = setup(); completedRecord(r, 'first'); completedRecord(r, 'second');
  const group = r.$('messages').children[0], phases = [...group._recordPhases];
  group.open = true; group.ontoggle(); r.send('agent:error', { message: 'late failure' });
  assert.equal(group.isConnected, false);
  assert.deepEqual(r.$('messages').children.slice(0, 2), phases.map(p => p.box));
  assert.deepEqual(phases.map(p => p.thinking.textContent), ['first', 'second']);
  assert(phases.every(p => p.summary.textContent === '回复中断'));
});
test('open records are not regrouped while the user is reading them', () => {
  const r = setup(); completedRecord(r, 'first'); completedRecord(r, 'second');
  const group = r.$('messages').children[0]; group.open = true; group.ontoggle();
  completedRecord(r, 'third');
  assert.equal(r.$('messages').children.length, 2); assert.equal(group._recordPhases.length, 2);
  group.open = false; group.ontoggle(); r.send('agent:usage', { total_tokens: 12 });
  assert.equal(r.$('messages').children.length, 1); assert.equal(group._recordPhases.length, 3);
  group.open = true; group.ontoggle();
  assert.deepEqual(Array.from(group._recordPhases, p => p.thinking.textContent), ['first', 'second', 'third']);
});

test('steady streaming does not repeatedly traverse completed message history', () => {
  const r = setup(); completedRecord(r, 'first'); completedRecord(r, 'second');
  r.send('agent:processing-start');
  r.send('agent:response-chunk', { blocks: [{ type: 'text', text: 'Start' }] });
  const children = r.$('messages').children;
  Object.defineProperty(r.$('messages'), 'children', { get() { throw Error('Unexpected history traversal'); } });
  r.send('agent:response-chunk', { blocks: [{ type: 'text', text: ' more' }] });
  assert(children.length > 0);
});

test('thoughts and tool output use compact disclosures while preserving complete content and order', () => {
 const r=setup();r.send('agent:processing-start');
 r.send('agent:thinking-chunk',{text:'**核对口径**'});
 r.send('agent:tool-started',{toolCallId:'wait',name:'conversation_wait',kind:'execute'});
 assert.equal(r.run('details.summary.textContent'),'正在等待协作结果');
 r.send('agent:tool-output-chunk',{toolCallId:'wait',chunk:'complete original output'});
 r.send('agent:tool-completed',{toolCallId:'wait',success:true});
 r.send('agent:thinking-chunk',{text:'**下一步**'});
 r.run('details.box.open=true;details.box.ontoggle()');
 const body=r.run('details.body');
 assert.equal(body.children[0].children[0].textContent,'思路 · 核对口径');
 assert.equal(body.children[0].children[1].textContent,'**核对口径**');
 const call=r.run('details.callRows.get("tool:wait")');
 assert.equal(body.children[1],call.row);
 assert.equal(call.title.textContent,'等待协作结果');
 assert.equal(body.children.length,3,'one thought, one complete call, next thought');
 assert.equal(call.output.textContent,'complete original output');
 call.row.open=true;call.row.ontoggle();
 assert.equal(call.output.parentNode,call.outputSection);
 assert.equal(body.children.at(-1).children[0].textContent,'思路 · 下一步');
 assert.notEqual(body.children[0].open,true);assert.notEqual(body.children[2].open,true);
});

for (const materialize of [false, true]) test(`late parallel completion cannot split the current thought (${materialize ? 'live' : 'replay'})`, () => {
 const r=setup();r.send('agent:processing-start');
 r.send('agent:tool-started',{toolCallId:'parallel',name:'read_file'});
 r.send('agent:thinking-chunk',{text:'**Review '});
 if(materialize) r.run('details.box.open=true;details.box.ontoggle()');
 r.send('agent:tool-completed',{toolCallId:'parallel',success:true});
 r.send('agent:thinking-chunk',{text:'results**'});
 r.run('details.box.open=true;details.box.ontoggle()');
 const sources=r.run('details.body.children.filter(n=>n.className==="step thinking-step").map(n=>n.children[1]._source)');
 assert.deepEqual(Array.from(sources),['**Review results**']);
});

function timedFrame(r, name, payload, ts, id) {
 r.context.timedInput={meta:{name,ts,id},payload};r.run('frame(timedInput)');
}
test('activity completion time survives later frames and lazy disclosure materialization',()=>{
 const r=setup(),ts=Date.UTC(2026,9,30,8,12,34);
 timedFrame(r,'agent:processing-start',{},ts-2000);
 timedFrame(r,'agent:thinking-chunk',{text:'Reasoning'},ts-1000);
 const phase=r.run('details');assert.equal(phase.timeNode.hidden,true);
 timedFrame(r,'agent:response-segment',{text:'Answer'},ts);
 assert.equal(phase.timeNode.dateTime,new Date(ts).toISOString());
 timedFrame(r,'agent:processing-done',{},ts+1000);
 phase.box.open=true;phase.box.ontoggle();
 assert.equal(phase.timeNode.dateTime,new Date(ts).toISOString());
 assert.equal(phase.timeNode.hidden,false);assert.equal(phase.thinking.textContent,'Reasoning');
});
test('adjacent completion records show latest reliable timestamp without changing individual times',()=>{
 const r=setup(),ts=Date.UTC(2026,9,30,8,12,34);
 for(let i=0;i<2;i++){
  timedFrame(r,'agent:processing-start',{},ts+i*1000-100);
  timedFrame(r,'agent:thinking-chunk',{text:'Reasoning '+i},ts+i*1000-50);
  timedFrame(r,'agent:processing-done',{},ts+i*1000);
 }
 const group=r.$('messages').children[0];assert.equal(group._recordPhases.length,2);
 assert.equal(group._timeNode.dateTime,new Date(ts+1000).toISOString());
 assert.equal(group._recordPhases[0].timeNode.dateTime,new Date(ts).toISOString());
 group.open=true;group.ontoggle();assert.equal(group._timeNode.hidden,false);
});
test('missing and synthetic history times remain absent and terminal cleanup retains error time',()=>{
 for(const synthetic of [false,true]){
  const r=setup();r.send('agent:processing-start');r.send('agent:thinking-chunk',{text:'Past work'});
  timedFrame(r,'agent:processing-done',{},synthetic?Date.now():undefined,synthetic?'hub:session:branch:12':undefined);
  assert.equal(r.run('[...phases][0].timeNode.hidden'),true);
 }
 for(const outcome of ['agent:error','agent:cancelled']){
  const r=setup(),ts=Date.UTC(2026,9,30,8,12,34);r.send('agent:processing-start');r.send('agent:thinking-chunk',{text:'Work'});
  timedFrame(r,outcome,{message:'Stopped'},ts);timedFrame(r,'agent:processing-done',{},ts+1000);
  assert.equal(r.run('[...phases][0].timeNode.dateTime'),new Date(ts).toISOString());
 }
});

for(const cleanup of ['resolved','expire']) test(`later approvals preserve completed timestamps (${cleanup})`,()=>{
 const r=setup(),ts=Date.UTC(2026,9,30,8,12,34);
 r.send('agent:processing-start');r.send('agent:thinking-chunk',{text:'First step'});
 timedFrame(r,'agent:response-segment',{text:'First result'},ts);
 const settled=r.run('[...phases][0]');
 r.send('agent:tool-started',{toolCallId:'next',name:'write_file'});const pending=r.run('details');
 timedFrame(r,'permission:request',{requestId:'later',expiresAt:Date.now()+60000},ts+1000);
 assert.equal(settled.box.dataset.state,'settled');assert.equal(settled.timeNode.hidden,false);
 assert.equal(pending.box.dataset.state,'waiting');
 if(cleanup==='expire')for(const fn of r.timers.values())fn();
 else timedFrame(r,'permission:resolved',{requestId:'later'},ts+2000);
 assert.equal(settled.timeNode.dateTime,new Date(ts).toISOString());
 assert.equal(pending.box.dataset.state,'running');
});

test('background completion uses its own time after approval and main turn completion',()=>{
 const r=setup(),ts=Date.UTC(2026,9,30,8,12,34);
 r.send('agent:processing-start');r.send('subagent:started',{subagentId:'worker'});
 const phase=r.run('details');
 timedFrame(r,'permission:request',{requestId:'worker-approval',expiresAt:Date.now()+60000},ts);
 timedFrame(r,'agent:processing-done',{},ts+1000);
 assert.equal(phase.timeNode.hidden,true);assert.equal(phase.box.dataset.state,'waiting');
 timedFrame(r,'permission:resolved',{requestId:'worker-approval'},ts+2000);
 assert.equal(phase.timeNode.hidden,true);assert.equal(phase.box.dataset.state,'running');
 timedFrame(r,'subagent:done',{subagentId:'worker'},ts+3000);
 assert.equal(phase.timeNode.dateTime,new Date(ts+3000).toISOString());
 timedFrame(r,'hub:replay-done',{},ts+5000);
 assert.equal(phase.timeNode.dateTime,new Date(ts+3000).toISOString());
});

for(const kind of ['tool','subagent']) test(`replayed response time cannot precede parallel ${kind} completion`,()=>{
 const ts=Date.UTC(2026,9,30,8,12,34),times=[];
 for(const replay of [false,true]){
  const r=setup();r.send('agent:processing-start');
  timedFrame(r,kind==='tool'?'agent:tool-started':'subagent:started',kind==='tool'?{toolCallId:'parallel',name:'read_file'}:{subagentId:'parallel'},ts-1000);
  if(!replay)timedFrame(r,'agent:response-chunk',{blocks:[{type:'text',text:'Partial result'}]},ts);
  timedFrame(r,kind==='tool'?'agent:tool-completed':'subagent:done',kind==='tool'?{toolCallId:'parallel',success:true}:{subagentId:'parallel'},ts+2000);
  timedFrame(r,'agent:response-segment',{text:'Partial result'},ts);
  times.push(r.run('[...phases][0].timeNode.dateTime'));
 }
 assert.deepEqual(times,[new Date(ts+2000).toISOString(),new Date(ts+2000).toISOString()]);
});

test('parallel completion timestamps stay scoped to their originating phases',()=>{
 const r=setup(),ts=Date.UTC(2026,9,30,8,12,34),send=(name,p,n)=>timedFrame(r,name,p,ts+n);
 r.send('agent:processing-start');
 send('agent:tool-started',{toolCallId:'a',name:'read_file'},0);
 send('agent:response-segment',{text:'First'},1000);
 const a=r.run('[...phases][0]');
 send('agent:tool-started',{toolCallId:'b',name:'read_file'},2000);
 const b=r.run('details');
 send('agent:tool-completed',{toolCallId:'b',success:true},4000);
 send('agent:tool-completed',{toolCallId:'a',success:true},5000);
 send('agent:response-segment',{text:'Second'},3000);
 assert.equal(a.timeNode.dateTime,new Date(ts+5000).toISOString());
 assert.equal(b.timeNode.dateTime,new Date(ts+4000).toISOString());
});


test('file preview binds the current device and becomes invalid after session or account change',async()=>{
 const r=setup();r.run("device='desktop';session='aaaaaa'");let options,closed=0;
 r.context.AsHubFilePreview={open:o=>{options=o;},close:()=>closed++};
 await r.run("showArtifactPreview(new URL('https://example.test/mobile/api/devices/desktop/artifact?session=aaaaaa&path=report.pdf'),'report.pdf','desktop')");
 assert.equal(options.name,'report.pdf');assert.equal(options.lang,'zh');assert.equal(options.current(),true);
 assert.equal(options.nativeAction,undefined,'remote must not expose native computer opening');
 r.run('generation++');assert.equal(options.current(),false);
 r.run('signOut()');assert.equal(closed,1);
});


test('sharing a preview preserves its version and refuses a replaced file', async()=>{
 const r=setup();r.run("device='desktop';session='aaaaaa'");let options;
 r.context.AsHubFilePreview={open:o=>{options=o;},close:()=>{}};
 await r.run("showArtifactPreview(new URL('https://example.test/mobile/api/devices/desktop/artifact?session=aaaaaa&path=report.pdf'),'report.pdf','desktop')");
 const requests=[];
 r.fetch(async(url,opts)=>{requests.push({url:String(url),method:opts.method});return new Response('File changed',{status:409});});
 const versioned=new URL(options.url);versioned.searchParams.set('version','reviewed-version');
 await options.share(versioned);
 assert.equal(new URL(requests[0].url).searchParams.get('version'),'reviewed-version');
 assert.deepEqual(requests.map(r=>r.method),['HEAD']);
 assert.match(r.$('modal-body').children[1].textContent,/文件已更新/);
 assert.equal(r.$('modal-body').children[2].children.length,0,'a replacement must not become shareable');
});


test('sharing an unchanged preview reads only its pinned revision',async()=>{
 const r=setup({pwa:true});r.run("device='desktop';session='aaaaaa'");r.context.File=File;
 let options;const requests=[],shared=[];
 r.context.AsHubFilePreview={open:o=>{options=o;},close:()=>{}};
 r.context.navigator.canShare=()=>true;r.context.navigator.share=async value=>shared.push(value);
 r.context.URL=class extends URL {static createObjectURL(){return 'blob:reviewed';}static revokeObjectURL(){}};
 await r.run("showArtifactPreview(new URL('https://example.test/mobile/api/devices/desktop/artifact?session=aaaaaa&path=report.pdf'),'report.pdf','desktop')");
 r.fetch(async(url,opts)=>{requests.push({url:String(url),method:opts.method||'GET'});return new Response(opts.method==='HEAD'?null:'pdf',{headers:{'content-disposition':'attachment;','content-length':'3'}});});
 const versioned=new URL(options.url);versioned.searchParams.set('version','reviewed-version');await options.share(versioned);
 assert.deepEqual(requests.map(x=>x.method),['HEAD','GET']);
 assert(requests.every(x=>new URL(x.url).searchParams.get('version')==='reviewed-version'));
 await r.$('modal-body').children[2].children[0].onclick();
 assert.equal(shared.length,1);assert.equal(await shared[0].files[0].text(),'pdf');
});

test('steering preserves task plan, background ownership and separates reply segments in live and replay',()=>{
 for(const live of [false,true]){
  const r=setup();r.run(`streamReady=${live};activity=true`);
  r.send('agent:query',{query:'Initial'});r.send('agent:processing-start');
  r.send('agent:todo',{todos:[{title:'Keep this plan',status:'in_progress'}]});
  const plan=r.run('todo');
  r.send('subagent:started',{subagentId:'child',task:'Background work'});const child=r.run("agentSteps.get('child')");
  if(live)r.send('agent:response-chunk',{blocks:[{type:'text',text:'Before'}]});
  r.send('agent:response-segment',{text:'Before'});
  r.send('agent:query',{query:'Correction',queueId:'steer1',steering:true});
  if(live)r.send('agent:response-chunk',{blocks:[{type:'text',text:'After'}]});
  r.send('agent:response-segment',{text:'After'});r.send('agent:processing-done');
  assert.deepEqual(r.replies(),['Before','After']);assert.equal(r.run('todo'),plan);
  assert.equal(r.run("agentSteps.get('child')"),child);
  assert.equal(r.run('activity'),false);
 }
});
test('mobile steering UI is capability-gated and forwards explicit delivery while retaining queue mode',async()=>{
 for(const supported of [true,false]){
  const r=setup({mobile:true});r.run(`user='demo';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];streamReady=true;activity=true;capabilities={steering:${supported}};controls()`);
  assert.equal(r.$('delivery-mode').hidden,!supported);
  const calls=[];r.fetch(async(_url,opts)=>{const payload=JSON.parse(opts.body);calls.push(payload);return ok(payload.op==='request-status'?{state:'done'}:{});});
  r.$('query').value='Correction';await r.$('composer').onsubmit({preventDefault(){}});
  assert.equal(calls.find(c=>c.op==='submit').args.delivery,supported?'steer':undefined);
  if(supported){r.$('delivery-mode').onclick();calls.length=0;r.$('query').value='Later';await r.$('composer').onsubmit({preventDefault(){}});assert.equal(calls.find(c=>c.op==='submit').args.delivery,'queue');}
 }
});
test('mobile pending messages distinguish steering and queued work',()=>{
 const r=setup();r.run("session='aaaaaa';streamReady=true;capabilities={queue:true};queuedMessages=[{id:'a',query:'Correction',delivery:'steer'},{id:'b',query:'Later',delivery:'queue'}];renderQueue()");
 assert.deepEqual(r.$('queued-messages').children.map(row=>row.children[0].textContent),['等待接入','排队中']);
});

test('desktop checkpoint metadata and completion render one compact boundary remotely', () => {
  const output=execFileSync(process.execPath,[fileURLToPath(new URL('./render-compaction-fixture.cjs',import.meta.url))],{encoding:'utf8',timeout:20000});
  const {frames,summary}=JSON.parse(output.split('\n').find(l=>l.startsWith('COMPACTION ')).slice(11));
  const r=setup();
  for(const f of frames){const wire=mobileReplayFrame('data: '+JSON.stringify(f)+'\n\n');r.context.input=JSON.parse(wire.match(/^data: (.+)$/m)[1]);r.run('frame(input)');}
  const records=()=>r.$('messages').children.filter(n=>n.classList.contains('compaction-marker'));
  assert.equal(records().length,1);const record=records()[0];
  assert.equal(record.children[0].children[1].textContent,'8 条记录 · ~10.0k → ~4.0k');
  assert.deepEqual(r.replies(),['Answer 4','Answer 5']);const visible=n=>n.textContent+n.children.map(visible).join('');assert(!visible(record).includes(summary),'internal summary stays out of the presentation');assert.equal(record.innerHTML,'');
  record.open=true;r.send('ui:info',{message:'(compacted: ~10,000 → ~3,999 tokens)'});
  assert.equal(records().length,1);assert.equal(record.open,true);assert.equal(record._compactionData.afterTokens,3999);
  r.send('ui:info',{message:'(compacted: ~20,000 → ~5,000 tokens)'});assert.equal(records().length,2,'unrelated compaction must remain visible');
  r.send('hub:branch-switched');assert(!r.$('messages').children.includes(record));
});

test('legacy compaction markers show a boundary without inventing unavailable metrics',()=>{
 const r=setup();r.send('hub:compaction-marker',{summary:'Legacy source text'});
 const record=r.$('messages').children.find(n=>n.classList.contains('compaction-marker'));
 assert.equal(record.children[0].children[0].textContent,'上下文已整理');assert.equal(record.children[0].children[1].textContent,'');
 assert.equal(record.children[1].children[0].children.length,0);
});

for(const live of [false,true]) test(`one tool row retains arguments, streamed output and result (${live?'live':'replay'})`,()=>{
 const r=setup();r.send('agent:processing-start');
 r.send('agent:tool-batch',{groups:[{kind:'execute',tools:[{name:'bash'}]}]});
 if(live)r.run('details.box.open=true;details.box.ontoggle()');
 r.send('agent:tool-started',{toolCallId:'cmd',name:'bash',rawInput:{command:'printf evidence'}});
 r.send('agent:tool-output-chunk',{toolCallId:'cmd',chunk:'evidence'});
 r.send('agent:tool-completed',{toolCallId:'cmd',exitCode:0,rawOutput:'evidence',extra:'kept'});
 r.send('agent:tool-batch-complete',{results:[{name:'bash',isError:false}]});
 r.run('details.box.open=true;details.box.ontoggle()');
 const phase=r.run('details'),call=phase.callRows.get('tool:cmd');
 assert.equal(phase.body.children.length,2,'one operation and one metadata footer');
 assert.equal(phase.body.children[0],call.row);assert.equal(phase.body.children[1],phase.traceRow);
 assert.equal(call.title.textContent,'运行命令');assert.equal(call.row.dataset.state,'done');
 assert.equal(call.body.children.length,0,'inner payload is lazy');
 call.row.open=true;call.row.ontoggle();
 assert.match(call.inputText.textContent,/printf evidence/);assert.equal(call.output.textContent,'evidence');
 assert.equal(call.resultSection.hidden,true,'identical output is shown once');
 call.source.open=true;call.source.ontoggle();assert.match(call.sourceText.textContent,/"extra": "kept"/);
 phase.traceRow.open=true;phase.traceRow.ontoggle();assert.match(phase.traceText.textContent,/agent:tool-batch-complete/);
 call.row.ontoggle();assert.equal(call.body.children.length,4,'reopening does not duplicate sections');
});
test('parallel calls and collaborators retain separate rows and quiet outcome metadata',()=>{
 const r=setup();r.send('agent:processing-start');
 r.send('agent:tool-started',{toolCallId:'a',name:'read_file'});
 r.send('agent:tool-started',{toolCallId:'b',name:'read_file'});
 r.send('subagent:started',{subagentId:'a',task:'Independent review'});
 r.send('agent:tool-output-chunk',{toolCallId:'b',chunk:'B'});
 r.send('agent:tool-output-chunk',{toolCallId:'a',chunk:'A'});
 r.send('agent:tool-completed',{toolCallId:'a',exitCode:1,rawOutput:'failed attempt'});
 r.send('agent:tool-completed',{toolCallId:'b',exitCode:0,rawOutput:'B'});
 r.send('subagent:done',{subagentId:'a',result:'Reviewed'});r.send('agent:processing-done');
 const phase=r.run('[...phases][0]');phase.box.open=true;phase.box.ontoggle();
 assert.equal(phase.callRows.size,3);assert.equal(phase.callRows.get('tool:a').output.textContent,'A');
 assert.equal(phase.callRows.get('tool:b').output.textContent,'B');
 assert.equal(phase.callRows.get('tool:a').row.dataset.state,'incomplete');
 assert.equal(phase.callRows.get('agent:a').title.textContent,'Independent review');
 assert.equal(phase.box.dataset.outcome,'','a retried tool is not a failed conversation');
});
test('missing call IDs are never guessed and unknown events remain readable',()=>{
 const r=setup();r.send('agent:processing-start');
 r.send('agent:tool-started',{name:'read_file'});r.send('agent:tool-started',{name:'bash'});
 r.send('agent:tool-completed',{rawOutput:'unassigned result'});
 r.send('agent:tool-custom',{important:'keep this extension payload'});
 r.run('details.box.open=true;details.box.ontoggle()');const phase=r.run('details');
 assert.equal(phase.callRows.size,3);phase.traceRow.open=true;phase.traceRow.ontoggle();
 assert.match(phase.traceText.textContent,/keep this extension payload/);
});

for(const kind of ['tool','collaborator']) test(`compact replay preserves long ${kind} previews in the main expanded content`,()=>{
 const r=setup();r.send('agent:processing-start');
 const send=(name,payload)=>{
  const wire=mobileReplayFrame('data: '+JSON.stringify({meta:{name},payload})+'\n\n');
  const data=JSON.parse(wire.slice(6));r.send(data.meta.name,data.payload);
 };
 if(kind==='tool') {
  send('agent:tool-started',{toolCallId:'long',name:'bash',rawInput:{command:'EVIDENCE_INPUT '.repeat(250)}});
  send('agent:tool-completed',{toolCallId:'long',rawOutput:'EVIDENCE_RESULT '.repeat(250),exitCode:0});
 }else{
  send('subagent:started',{subagentId:'long',task:'Review',systemPrompt:'EVIDENCE_INPUT '.repeat(250)});
  send('subagent:done',{subagentId:'long',task:'Review',result:'EVIDENCE_RESULT '.repeat(250)});
 }
 r.run('details.box.open=true;details.box.ontoggle()');
 const call=r.run('[...details.callRows.values()][0]');call.row.open=true;call.row.ontoggle();
 assert.equal(call.inputSection.hidden,false);assert.match(call.inputText.textContent,/EVIDENCE_INPUT/);
 assert.equal(call.resultSection.hidden,false);assert.match(call.resultText.textContent,/EVIDENCE_RESULT/);
 assert.match(call.inputSection.children[0].textContent,/精简预览/);
 assert.match(call.resultSection.children[0].textContent,/精简预览/);
 assert.match(call.resultText.textContent,/完整记录可在完整历史中查看/);
});

const eventContractCases = (await import('../tests/fixtures/conversation-events.cjs')).default;
for (const mode of ['full', 'preview']) for (const kind of ['tool', 'subagent']) {
 test(`${mode} ${kind} results share the desktop event contract`, () => {
  for (const c of eventContractCases) {
   const r = setup(); r.send('agent:processing-start');
   const child = kind === 'subagent', id = child ? { subagentId: 'call' } : { toolCallId: 'call' };
   r.send(child ? 'subagent:started' : 'agent:tool-started', { ...id, name: 'bash', task: 'Review' });
   const name = child ? 'subagent:done' : 'agent:tool-completed';
   const payload = { ...id, rawOutput: 'Long diagnostics '.repeat(300), ...c.payload };
   const wire = `data: ${JSON.stringify({ meta: { name }, payload })}\n\n`;
   const event = JSON.parse((mode === 'preview' ? mobileReplayFrame(wire) : wire).slice(6));
   r.send(name, event.payload); r.send('agent:processing-done');
   const phase = r.run('[...phases][0]'); phase.box.open = true; phase.box.ontoggle();
   const call = phase.callRows.get(`${child ? 'agent' : 'tool'}:call`);
   assert.equal(call.row.dataset.state, c.outcome === 'ended' ? 'done' : 'incomplete', c.name);
   assert.equal(call.status.textContent, c.outcome === 'failed' ? '未完成' : c.outcome === 'partial' ? '部分完成' : '已结束', c.name);
   assert.equal(phase.box.dataset.outcome, '', 'an individual result does not fail the main turn');
   assert.equal(phase.box.dataset.state, 'settled');
  }
 });
}


test('project pins follow desktop order, survive filtering and stay out of other views', () => {
  const r = setup();
  r.run("sessions=[{instanceId:'aaaaaa',title:'Alpha'},{instanceId:'bbbbbb',title:'Beta'},{instanceId:'cccccc',title:'Gamma'},{instanceId:'dddddd',title:'Other'}];groups=[{id:'p',name:'Project',sessionIds:['aaaaaa','bbbbbb','cccccc'],pinnedSessionIds:['cccccc','bbbbbb','dddddd']}];viewFilter='project:p';renderSessions()");
  const ids = () => r.$('sessions').children.map(e => e.dataset.sessionId);
  assert.deepEqual(ids(), ['cccccc','bbbbbb','aaaaaa']);
  assert.equal(r.$('sessions').children[0].children[0].children[0].textContent, '置顶');
  r.$('session-search').value = 'a'; r.run('renderSessions()');
  assert.deepEqual(ids(), ['cccccc','bbbbbb','aaaaaa']);
  r.$('session-search').value = 'Alpha'; r.run('renderSessions()');
  assert.deepEqual(ids(), ['aaaaaa']);
  r.$('session-search').value = ''; r.run("groups[0].pinnedSessionIds=['bbbbbb'];renderSessions()");
  assert.deepEqual(ids(), ['bbbbbb','aaaaaa','cccccc']);
  r.run("delete groups[0].pinnedSessionIds;renderSessions()");
  assert.deepEqual(ids(), ['aaaaaa','bbbbbb','cccccc']);
  r.run("viewFilter='all';renderSessions()");
  assert.deepEqual(ids(), ['dddddd']);
  assert.equal(r.$('sessions').children[0].children[0].children.length, 0);
});

test('a peer decision conflict clears a still visible mobile permission',async()=>{
  const r=setup();r.fetch(async()=>failure(409,'permission expired or already handled'));
  r.send('agent:processing-start');r.send('permission:request',{requestId:'owned',expiresAt:Date.now()+60000});
  const card=r.run("permissions.get('owned')");await card.children[2].onclick();
  assert.equal(r.run('permissions.size'),0);
  assert.equal(card.isConnected,false);assert.equal(r.$('notice').textContent,'');
});
test('an in-flight permission decision cannot be submitted again from its replayed card', async()=>{
  const r=setup(), pending=deferred();let calls=0;
  r.fetch(()=>{calls++;return pending.promise});
  const msg={requestId:'owned',expiresAt:Date.now()+60000};
  r.send('permission:request',msg);
  const first=r.run("permissions.get('owned').children[2].onclick()");
  r.send('hub:branch-switched');r.send('permission:request',msg);
  const second=r.run("permissions.get('owned').children[3].onclick()");
  const seen=calls;pending.resolve(ok({outcome:'approved'}));await Promise.all([first,second]);
  assert.equal(seen,1);
});

test('persistent browser grants require the desktop while mobile may decline', async () => {
  for (const metadata of [{scope:'site'}, {scope:'daily7'}, {requiresDesktop:true}]) {
    const r = setup();
    let decision;
    r.fetch(async (_url, options) => { decision = JSON.parse(options.body).args; return ok({outcome:'denied'}); });
    r.send('permission:request', {requestId:'persistent', ...metadata, expiresAt:Date.now()+60000});
    const card = r.run("permissions.get('persistent')");
    assert(!card.children.some(e=>e.textContent==='允许本次'));
    assert(card.children.some(e=>e.textContent.includes('在电脑端确认')));
    await card.children.find(e=>e.textContent==='拒绝').onclick();
    assert.equal(decision.outcome,'denied');
    assert.equal(r.run('permissions.size'),0);
  }
});

test('an ACP request with only rejection options does not direct the phone user to approve at the desktop',()=>{
  const r=setup();
  r.send('permission:request',{requestId:'reject-only',requiresDesktop:true,acpExtendedOption:null,expiresAt:Date.now()+60000});
  const card=r.run("permissions.get('reject-only')");
  assert(card.children.some(child=>child.textContent.includes('仅可拒绝')));
  assert(!card.children.some(child=>child.textContent.includes('需要在电脑端确认')));
});

test('returning to a conversation keeps its pending approval locked until the first decision settles',async()=>{
  const r=setup(), pending=deferred();let calls=0;
  r.run("device='desktop';session='first'");
  r.fetch(()=>{calls++;return pending.promise});
  const request={requestId:'grant',expiresAt:Date.now()+60000};
  r.send('permission:request',request);
  const first=r.run("permissions.get('grant').children[2].onclick()");
  r.run("generation++;session='other';resetMessages();generation++;session='first';resetMessages()");
  r.send('permission:request',request);
  const card=r.run("permissions.get('grant')");
  const second=card.children[3].onclick();
  pending.resolve(ok({outcome:'approved'}));await Promise.all([first,second]);
  assert.equal(calls,1);
  assert(!card.isConnected);
});

test('unconfirmed ACP delivery is visible once across RPC acknowledgement, SSE and history replay',async()=>{
  const r=setup();const payload={requestId:'grant',outcome:'unconfirmed'};
  r.fetch(async()=>ok({ok:true,outcome:'unconfirmed'}));
  r.send('permission:request',{requestId:'grant',expiresAt:Date.now()+30000});
  await r.run("permissions.get('grant').children[2].onclick()");
  const warnings=()=>r.$('messages').children.filter(e=>e.textContent.includes('授权送达未确认'));
  assert.equal(warnings().length,1);assert.equal(r.run('permissions.size'),0);
  r.send('permission:resolved',payload);assert.equal(warnings().length,1);
  r.send('hub:branch-switched');assert.equal(warnings().length,0);
  r.send('permission:request',{requestId:'grant',pending:false});
  r.send('permission:resolved',payload);assert.equal(warnings().length,1);
  assert.equal(r.run('permissions.size'),0,'an uncertain result cannot be approved again');
});

test('late uncertain RPC results cannot add old permissions to a different branch',async()=>{
 const r=setup(),pending=deferred();r.fetch(()=>pending.promise);
 r.send('permission:request',{requestId:'old-grant',expiresAt:Date.now()+30000});
 const decision=r.run("permissions.get('old-grant').children[2].onclick()");
 r.send('hub:branch-switched');r.send('agent:query',{query:'new branch'});
 pending.resolve(ok({outcome:'unconfirmed'}));await decision;
 assert(!r.$('messages').children.some(e=>e.textContent.includes('授权送达未确认')));
});

test('an authoritative uncertain outcome replaces a locally expired card',()=>{
 const r=setup();let expire;
 r.context.setTimeout=(fn,ms)=>{if(ms>1000)expire=fn;return 1;};
 r.send('permission:request',{requestId:'expiring',expiresAt:Date.now()+30000});
 const card=r.run("permissions.get('expiring')");
 expire();assert(card.isConnected);
 r.send('permission:resolved',{requestId:'expiring',outcome:'unconfirmed'});
 assert(!card.isConnected);
 assert.equal(r.$('messages').children.filter(e=>e.textContent.includes('授权送达未确认')).length,1);
});

test('project navigation exposes pinned members directly and search crosses project boundaries', async () => {
  const r=setup({mobile:true});r.context.EventSource=class{addEventListener(){}close(){}};
  r.run(`user='alice';device='desk';devices=[{id:device,online:true}];deviceListReady=true;sessionListDevice=device;
    groups=[{id:'p',name:'寻找阿尔法',sessionIds:['a','b'],pinnedSessionIds:['b']},{id:'q',name:'Paper review',sessionIds:['c']}];
    sessions=[{instanceId:'a',title:'研究员',projectId:'p'},{instanceId:'b',title:'调度中枢',projectId:'p'},{instanceId:'c',title:'作者',projectId:'q'},{instanceId:'d',title:'独立',projectId:null}];renderSessions()`);
  const group=id=>r.$('sessions').children.find(e=>e.dataset.groupId===id);
  assert.equal(group('p').children[0]['aria-expanded'],'false');
  await group('p').children[0].onclick();assert.equal(group('p').children[0]['aria-expanded'],'true');
  assert.deepEqual(sessionRows(r).map(e=>e.dataset.sessionId),['b','a']);
  await sessionRows(r)[0].onclick();assert.equal(r.run('session'),'b');assert.equal(r.$('chat-project').textContent,'寻找阿尔法');
  assert.equal(sessionRows(r).filter(e=>e.dataset.sessionId==='b'&&e.classList.contains('active')).length,2,'recent and project highlight together');
  r.$('session-search').value='Paper';r.run('renderSessions()');assert.deepEqual(sessionRows(r).map(e=>e.dataset.sessionId),['c']);
  r.$('session-search').value='独立';r.run("viewFilter='running';renderSessions()");assert.deepEqual(sessionRows(r).map(e=>e.dataset.sessionId),['d'],'search ignores hidden status scope');
  r.$('session-search').value='';r.run("viewFilter='browse';renderSessions()");assert.equal(group('p').children[0]['aria-expanded'],'true');
});

test('navigation storage isolates accounts/devices, keeps only IDs and tolerates invalid storage', () => {
 const r=setup();r.run(`user='alice';device='one';sessions=[{instanceId:'a',title:'Private title'}];rememberSession('a');loadNavigation()`);
 assert.equal(r.run('navigation.last'),'a');assert(!r.stored.get('ashub-mobile-navigation:alice:one').includes('Private title'));
 r.run(`device='two';loadNavigation()`);assert.equal(r.run('navigation.last'),'');
 r.run(`user='bob';device='one';loadNavigation()`);assert.equal(r.run('navigation.recent.length'),0);
 r.stored.set('ashub-mobile-navigation:bob:one','{bad');r.run('loadNavigation()');assert.equal(r.run('navigation.last'),'');
 r.run(`user='alice';device='one';loadNavigation()`);assert.equal(r.run('navigation.last'),'a');
 r.context.localStorage.setItem=()=>{throw Error('quota')};r.run(`rememberSession('b');loadNavigation()`);assert.equal(r.run('navigation.last'),'b');
});

test('saved offline device remains selected instead of connecting another online computer', async () => {
 const r=setup();r.stored.set('ashub-mobile-device:alice','old');let rpc=0;
 r.fetch(async(url)=>{if(String(url).includes('/rpc')){rpc++;return ok([])}return ok([{id:'online',name:'Online',online:true},{id:'old',name:'Old',online:false}])});
 await r.run("start('alice')");assert.equal(r.run('device'),'old');assert.equal(rpc,0);assert(r.$('selection-state').textContent.includes('离线'));
});

test('reload restores only an authorized last session after catalog refresh and preserves draft', async () => {
 const r=setup({mobile:true});r.context.EventSource=class{addEventListener(){}close(){}};
 r.stored.set('ashub-mobile-device:alice','desk');r.stored.set('ashub-mobile-navigation:alice:desk',JSON.stringify({last:'b',recent:['b'],expanded:['p']}));r.stored.set('ashub-mobile:alice:desk:b:draft','unsent');
 r.fetch(async(url,init)=>{
  if(!String(url).includes('/rpc'))return ok([{id:'desk',name:'Mac',online:true}]);
  const {op}=JSON.parse(init.body);return ok(op==='sessions'?[{instanceId:'b',title:'Coordinator',projectId:'p'}]:op==='capabilities'?{projects:true}:op==='project-groups'?[{id:'p',name:'Research',sessionIds:['b']}]:{});
 });
 await r.run("start('alice')");assert.equal(r.run('session'),'b');assert.equal(r.$('query').value,'unsent');assert.equal(r.$('chat-project').textContent,'Research');assert.equal(r.$('workspace').classList.contains('choosing-session'),false);
 assert.equal(r.run('restoreSession'),false);
});

test('session access and rendering capability reads overlap but replay waits for both', async () => {
 const r=setup(), access=deferred(), features=deferred();const requested=[];let opened=0;
 r.context.EventSource=class{constructor(){opened++}addEventListener(){}close(){}};
 r.run(`user='alice';device='desk';devices=[{id:'desk',online:true}];navigation={last:'a',recent:['a'],expanded:[],collapsed:[]};restoreSession=true;`);
 r.fetch(async(url,init)=>{const {op}=JSON.parse(init.body);requested.push(op);return op==='sessions'?access.promise:features.promise;});
 const reading=r.run('refreshSessions()');
 assert.deepEqual(requested.sort(),['capabilities','sessions'],'neither request should wait for the other');
 assert.equal(opened,0);
 access.resolve(ok([{instanceId:'a',title:'Assistant'}]));
 for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(opened,0,'image and queue capabilities must be known before automatic replay');
 features.resolve(ok({imageResources:true,artifacts:true,queue:true}));await reading;
 assert.equal(opened,1);assert.equal(r.run('capabilities.imageResources'),true);
});

for (const resumed of [false, true]) for (const delayed of ['project-groups', 'plugin-entries']) {
 test(`${resumed ? 'foreground' : 'initial'} conversation replay starts before slow ${delayed}`, async () => {
  const r=setup({mobile:true,pwa:true}), pending=deferred(); let waiting=false, opened=0;
  r.context.EventSource=class{constructor(){opened++}addEventListener(){}close(){}};
  r.run(`user='alice';device='desk';devices=[{id:'desk',online:true}];navigation={last:'a',recent:['a'],expanded:[],collapsed:[]};restoreSession=true;`);
  if(resumed)r.run(`session='a';restoreSession=false;`);
  r.stored.set('ashub-mobile:alice:desk:a:draft','unsent');
  r.fetch(async(url,init)=>{
   if(!init?.body)return ok([{id:'desk',online:true}]);
   const {op}=JSON.parse(init.body);
   if(op==='sessions')return ok([{instanceId:'a',title:'Assistant',projectId:'p'}]);
   if(op===delayed){waiting=true;return pending.promise;}
   return ok(op==='capabilities'?{projects:true,pluginResources:true}:op==='project-groups'?[{id:'p',name:'Research',sessionIds:['a']}]:[]);
  });
  const reading=r.run('refreshDevices()');while(!waiting)await Promise.resolve();
  try {
   assert.equal(opened,1,'optional sidebar metadata must not delay the authorized conversation stream');
   assert.equal(r.run('session'),'a');
   r.run(`source.onmessage({data:JSON.stringify({meta:{name:'agent:response-segment'},payload:{text:'Latest answer'}})});source.onmessage({data:JSON.stringify({meta:{name:'agent:processing-done'},payload:{}})});source.onmessage({data:JSON.stringify({meta:{name:'hub:replay-done'},payload:{}})});drainFrames()`);
   assert.deepEqual(r.replies(),['Latest answer']);assert.equal(r.run('streamReady'),true);
   if(!resumed)assert.equal(r.$('query').value,'unsent');
  } finally {
   pending.resolve(ok(delayed==='capabilities'?{projects:true,pluginResources:true}:delayed==='project-groups'?[{id:'p',name:'Research',sessionIds:['a']}]:[]));await reading;
  }
  assert.equal(opened,1,'finishing metadata must not reset the live stream');
  assert.equal(r.$('chat-project').textContent,'Research');assert.deepEqual(r.replies(),['Latest answer']);
 });
}

test('revoked last session is never opened and a failed catalog does not erase navigation history', async () => {
 const r=setup();r.stored.set('ashub-mobile-navigation:alice:desk',JSON.stringify({last:'secret',recent:['secret']}));let fail=true,opened=0;
 r.context.EventSource=class{constructor(){opened++}addEventListener(){}close(){}};
 r.fetch(async(url,init)=>{
  if(!String(url).includes('/rpc'))return ok([{id:'desk',online:true}]);
  const {op}=JSON.parse(init.body);if(op==='sessions'&&fail)throw Error('temporary');return ok(op==='sessions'?[{instanceId:'public',title:'Shared'}]:{});
 });
 await r.run("start('alice')");assert.equal(r.run('navigation.last'),'secret');assert.equal(opened,0);
 fail=false;await r.run('refreshDevices()');assert.equal(r.run('navigation.last'),'');assert.equal(r.run('navigation.recent.length'),0);assert.equal(opened,0);assert.equal(r.run('session'),'');
});

test('manual selection wins over a late restoration catalog and device switches isolate recent IDs', async () => {
 const r=setup();r.context.EventSource=class{addEventListener(){}close(){}};const pending=deferred();
 r.run(`user='alice';device='desk';devices=[{id:'desk',online:true}];sessions=[{instanceId:'a'},{instanceId:'b'}];navigation={last:'a',recent:['a'],expanded:[],collapsed:[]};restoreSession=true;`);
 r.fetch(async(url,init)=>{const {op}=JSON.parse(init.body);if(op==='sessions')return ok([{instanceId:'a'},{instanceId:'b'}]);if(op==='capabilities')return pending.promise;return ok([])});
 const refresh=r.run('refreshSessions()');for(let i=0;i<4;i++)await Promise.resolve();
 await r.run("openSession('b')");pending.resolve(ok({projects:true}));await refresh;
 assert.equal(r.run('session'),'b');assert.equal(r.run('navigation.last'),'b');
 r.run("resetDevice('other')");assert.equal(r.run('navigation.last'),'');assert.equal(r.run('session'),'');assert.equal(r.$('chat-project').hidden,true);
});

test('project metadata failure leaves authorized orphan members reachable and empty projects expandable', async () => {
 const r=setup();r.run(`user='alice';device='desk';sessions=[{instanceId:'a',title:'Member',projectId:'missing'}];groups=[{id:'empty',name:'New project',sessionIds:[]}];renderSessions()`);
 assert.deepEqual(sessionRows(r).map(e=>e.dataset.sessionId),['a']);
 const group=r.$('sessions').children.find(e=>e.dataset.groupId==='empty');await group.children[0].onclick();
 assert.equal(r.$('sessions').children.find(e=>e.dataset.groupId==='empty').children[0]['aria-expanded'],'true');
});

for (const interaction of ['search', 'project', 'new-chat', 'account']) {
 test(`manual ${interaction} intent cancels pending auto-restoration`, async () => {
  const r=setup(),pending=deferred();let sessionsStarted=false;
  r.context.EventSource=class{addEventListener(){}close(){}};
  r.run(`user='alice';device='desk';devices=[{id:'desk',online:true}];groups=[{id:'p',name:'Project',sessionIds:['a']}];navigation={last:'a',recent:['a'],expanded:[],collapsed:[]};restoreSession=true;`);
  r.fetch(async(url,init)=>{
   if(!init?.body)return ok([{id:'desk',name:'My Mac',online:true}]);
   const {op}=JSON.parse(init.body);
   if(op==='sessions'){sessionsStarted=true;return pending.promise}
   if(op==='capabilities')return ok({projects:false});
   return ok([]);
  });
  r.run('renderSessions()');
  const reading=r.run('refreshSessions()');while(!sessionsStarted)await Promise.resolve();
  if(interaction==='search'){r.$('session-search').value='another';r.$('session-search').oninput();}
  if(interaction==='project')await r.$('sessions').children.find(e=>e.dataset.groupId==='p').children[0].onclick();
  if(interaction==='new-chat')await r.$('new-chat').onclick();
  if(interaction==='account')await r.$('account').onclick();
  pending.resolve(ok([{instanceId:'a',title:'Previous',projectId:'p'}]));await reading;
  assert.equal(r.run('session'),'','a late initial catalog must not override explicit user navigation');
  assert.equal(r.run('restoreSession'),false);
  if(['new-chat','account'].includes(interaction))assert.equal(r.$('modal').open,true);
 });
}

test('stable navigation retains targets while pin, membership, title and status changes still refresh', () => {
 const r=setup();r.run(`user='alice';device='desk';groups=[{id:'p',name:'Project',sessionIds:['a','b'],pinnedSessionIds:['b']}];sessions=[{instanceId:'a',title:'Alpha',projectId:'p'},{instanceId:'b',title:'Beta',projectId:'p'}];navigation.expanded=['p'];renderSessions()`);
 const first=sessionRows(r)[0];
 r.run(`sessions=JSON.parse(JSON.stringify(sessions));groups=JSON.parse(JSON.stringify(groups));renderSessions()`);
 assert.equal(sessionRows(r)[0],first,'equal snapshots must retain interactive DOM');
 r.run(`groups[0].pinnedSessionIds=['a'];renderSessions()`);assert.deepEqual(sessionRows(r).map(e=>e.dataset.sessionId),['a','b']);
 r.run(`sessions[0].title='Renamed';sessions[0].isProcessing=true;renderSessions()`);
 assert.equal(sessionRows(r)[0].children[0].textContent,'Renamed');assert.equal(sessionRows(r)[0].dataset.status,'running');
 r.run(`sessions[0].projectId=null;renderSessions()`);assert.deepEqual(sessionRows(r).map(e=>e.dataset.sessionId),['b']);
 r.run(`navigation.expanded.push('@independent');renderSessions()`);assert.deepEqual(sessionRows(r).map(e=>e.dataset.sessionId),['b','a']);
});

for (const failFirst of [false,true]) {
 test(`manual navigation before device discovery survives ${failFirst?'a failed lookup and retry':'the late initial device response'}`, async()=>{
  const r=setup({mobile:true}),devices=deferred();let lookups=0;
  r.context.EventSource=class{addEventListener(){}close(){}};
  r.stored.set('ashub-mobile-navigation:alice:desk',JSON.stringify({last:'old',recent:['old']}));
  r.fetch(async(url,init)=>{
   if(!String(url).includes('/rpc')){lookups++;if(failFirst&&lookups===1)throw Error('temporary');return devices.promise;}
   const {op}=JSON.parse(init.body);return ok(op==='sessions'?[{instanceId:'old',title:'Old work'}]:{});
  });
  const boot=r.run("start('alice')");if(failFirst)await boot;
  r.$('session-search').value='new work';r.$('session-search').oninput();
  const refresh=failFirst?r.run('refreshDevices()'):boot;
  devices.resolve(ok([{id:'desk',name:'Mac',online:true}]));await refresh;
  assert.equal(r.run('session'),'','late device discovery must not override an explicit search');
  assert.equal(r.$('session-search').value,'new work');assert.equal(r.run('restoreSession'),false);
 });
}

test('explicit device selection and a new login may restore after earlier manual navigation', async()=>{
 const r=setup();r.context.EventSource=class{addEventListener(){}close(){}};
 r.run(`user='alice';device='first';cancelSessionRestore()`);
 r.stored.set('ashub-mobile-navigation:alice:second',JSON.stringify({last:'next',recent:['next']}));
 r.run("resetDevice('second')");assert.equal(r.run('restoreSession'),true);
 r.fetch(async(url,init)=>{
  if(!String(url).includes('/rpc'))return ok([{id:'second',online:true}]);
  const {op}=JSON.parse(init.body);return ok(op==='sessions'?[{instanceId:'next',title:'Next'}]:{});
 });
 await r.run('refreshDevices()');assert.equal(r.run('session'),'next');
 r.run('cancelSessionRestore()');await r.run("start('alice')");assert.equal(r.run('session'),'next','a new login resets navigation intent');
});


test('automatic replacement of a removed device does not discard manual navigation intent',async()=>{
 const r=setup();r.context.EventSource=class{addEventListener(){}close(){}};
 r.run(`user='alice';device='removed';devices=[{id:'removed',online:true}];cancelSessionRestore()`);
 r.stored.set('ashub-mobile-navigation:alice:remaining',JSON.stringify({last:'next',recent:['next']}));
 r.fetch(async(url,init)=>{
  if(!String(url).includes('/rpc'))return ok([{id:'remaining',online:true}]);
  const {op}=JSON.parse(init.body);return ok(op==='sessions'?[{instanceId:'next',title:'Next'}]:{});
 });
 await r.run('refreshDevices()');assert.equal(r.run('device'),'remaining');assert.equal(r.run('session'),'');assert.equal(r.run('restoreSession'),false);
});

test('conversation actions hide for old desktops and stay disabled when offline',()=>{
 const r=setup();r.run(`user='alice';device='desk';session='abcdef';devices=[{id:'desk',online:true}];syncSessionActions()`);assert.equal(r.$('session-actions').hidden,true);
 r.run(`capabilities={sessionNetwork:true,sessionDelete:true};syncSessionActions()`);assert.equal(r.$('session-actions').hidden,false);assert.equal(r.$('session-actions').disabled,false);
 r.run(`devices[0].online=false;syncSessionActions()`);assert.equal(r.$('session-actions').disabled,true);
 r.run(`session='';syncSessionActions()`);assert.equal(r.$('session-actions').hidden,true);
});

test('VPN choices preserve inheritance and a late read cannot change another conversation',async()=>{
 const r=setup(),pending=deferred();const calls=[];let slow=false;
 r.run(`user='alice';device='desk';session='abcdef';devices=[{id:'desk',online:true}];capabilities={sessionNetwork:true,sessionDelete:true};sessions=[{instanceId:'abcdef',title:'Alpha'}]`);
 r.fetch(async(url,init)=>{const b=JSON.parse(init.body);calls.push(b);if(slow)return pending.promise;return ok({session:b.args.session,enabled:b.op==='session-network'?null:b.args.enabled,effective:b.args.enabled??true,globalEnabled:true})});
 await r.run('showSessionActions()');
 const content=r.$('modal-body').children[0],section=content.children[1],choices=section.children[1];
 assert.equal(choices.children[0]['aria-pressed'],'true');await choices.children[2].onclick();assert.equal(choices.children[2]['aria-pressed'],'true');
 assert.deepEqual(calls.at(-1),{op:'set-session-network',args:{session:'abcdef',enabled:false}});
 slow=true;const reading=r.run('showSessionActions()');r.run(`generation++;session='bbbbbb';modal('Other',[el('p','Keep')])`);pending.resolve(ok({session:'abcdef',enabled:true,effective:true,globalEnabled:true}));await reading;
 assert.equal(r.$('modal-title').textContent,'Other');assert.equal(r.$('modal-body').children[0].textContent,'Keep');
});

test('deletion requires confirmation and retry reuses the request ID after a lost reply',async()=>{
 const r=setup();let attempts=0;const deletes=[];
 r.run(`user='alice';device='desk';session='abcdef';devices=[{id:'desk',online:true}];capabilities={sessionDelete:true};sessions=[{instanceId:'abcdef',title:'Delete me'}];navigation.last='abcdef';navigation.recent=['abcdef']`);
 r.$('query').value='old draft';
 r.fetch(async(url,init)=>{const b=JSON.parse(init.body);if(b.op==='session-delete'){deletes.push(b.args);if(++attempts===1)throw Error('lost reply');return ok({state:'done',result:{ok:true}})}if(b.op==='request-status')return ok({state:'done',result:{ok:true}});return ok(b.op==='sessions'?[]:{});});
 await r.run('showSessionActions()');assert.equal(deletes.length,0);
 await r.$('modal-body').children[0].children[1].onclick();assert.equal(deletes.length,0);
 const confirm=r.$('modal-body').children[4];await confirm.onclick();assert.equal(r.run('session'),'abcdef');assert.equal(confirm.textContent,'重试确认');
 await confirm.onclick();assert.equal(deletes.length,2);assert.equal(deletes[0].requestId,deletes[1].requestId);assert.equal(deletes[0].confirm,true);
 assert.equal(r.run('session'),'');assert.equal(r.run('navigation.last'),'');assert.equal(r.stored.get('ashub-mobile:alice:desk:abcdef:draft'),undefined);
});

test('a late deletion result cannot clear a different conversation or its draft',async()=>{
 const r=setup(),pending=deferred();r.run(`user='alice';device='desk';session='abcdef';devices=[{id:'desk',online:true}];capabilities={sessionDelete:true}`);
 r.fetch(async(url,init)=>{const b=JSON.parse(init.body);return b.op==='session-delete'?pending.promise:ok({state:'done',result:{ok:true}})});
 r.run(`confirmSessionDeletion('desk','abcdef','Alpha')`);const deleting=r.$('modal-body').children[4].onclick();
 r.run(`generation++;session='bbbbbb';modal('Other',[el('p','Keep')])`);r.$('query').value='new draft';pending.resolve(ok({state:'pending'}));await deleting;
 assert.equal(r.run('session'),'bbbbbb');assert.equal(r.$('query').value,'new draft');assert.equal(r.$('modal-title').textContent,'Other');assert.equal(r.run('sessionActionBusy.size'),0);
});

// Current-subscription recovery: deterministic clocks exercise real elapsed
// time and late callbacks without waiting seconds or sending any real messages.
function syncFixture() {
  const r=setup({mobile:true,pwa:true}),streams=[];let now=100000;
  r.context.Date=class extends Date { static now(){return now;} };
  r.context.EventSource=class {
    constructor(url){this.url=String(url);this.handlers=new Map();streams.push(this);}
    addEventListener(name,fn){this.handlers.set(name,fn);} close(){this.closed=true;}
  };
  r.run("user='alice';device='desktop';session='aaaaaa';devices=[{id:device,online:true}];sessions=[{instanceId:session,title:'Review'}];capabilitiesDevice=device;connectStream()");
  const timer=name=>{const id=r.run(name),fn=r.timers.get(id);assert(fn,`missing ${name}`);r.timers.delete(id);fn();};
  const emit=(name,payload={},s=streams.at(-1))=>{s.onmessage({data:JSON.stringify({meta:{name},payload})});r.run('drainFrames()');};
  return {...r,streams,advance:ms=>now+=ms,timer,emit};
}
test('device online and transport open cannot claim synced; slow current replay alone exposes retry',()=>{
  const r=syncFixture();assert.match(r.$('connection').textContent,/正在同步对话/);assert.equal(r.$('sync-retry').hidden,true);
  r.emit('hub:history-window',{hasEarlier:false});assert.doesNotMatch(r.$('messages').children[0].children[0].textContent,/已同步/,'history preview is not replay completion');
  r.streams[0].onopen();r.emit('agent:processing-done');assert.equal(r.run('streamReady'),false);assert.equal(r.$('send').disabled,true);
  r.advance(11999);r.timer('syncTimer');assert.equal(r.$('sync-retry').hidden,true,'early timer is not elapsed time');
  r.advance(1);r.timer('syncTimer');assert.equal(r.$('sync-retry').hidden,false);assert.match(r.$('sync-help').textContent,/草稿和待确认/);
  r.emit('hub:replay-done');assert.equal(r.run('streamReady'),true);assert.match(r.$('connection').textContent,/已同步/);assert.equal(r.$('sync-retry').hidden,true);assert.equal(r.run('syncTimer'),null);
});
for(const full of [false,true])test(`manual resync preserves ${full?'full':'recent'} history, text/image drafts and unknown send ownership without submission`,()=>{
  const r=syncFixture();let requests=0;r.fetch(async()=>{requests++;return ok({});});
  r.run(`fullHistory=${full};images=[{name:'local.png',mimeType:'image/png',data:'AAAA'},{id:'image-ref',name:'uploaded.png'}];sending=true;pendingSend={id:'pending-id',key:key('pending')};storage.set(key('pending'),'pending-id');storage.set(key('pending')+':draft','sent earlier');storage.set(key('pending')+':images','["image-ref"]');inFlightSends.set(key('pending'),{id:'pending-id'});renderAttachments();notice('发送结果待确认')`);
  r.$('query').value='Keep my edited draft';const owner=r.run('pendingSend'),transfer=r.run("inFlightSends.get(key('pending'))"),generation=r.run('generation');
  const old=r.streams[0];r.advance(12000);r.timer('syncTimer');r.$('sync-retry').onclick();r.$('sync-retry').onclick();
  assert.equal(r.streams.length,2,'double taps create only one new subscription');assert(old.closed);assert.equal(new URL(r.streams[1].url).searchParams.get('history'),full?'all':'recent');
  assert.equal(r.run('generation'),generation);assert.equal(r.run('pendingSend'),owner);assert.equal(r.run("inFlightSends.get(key('pending'))"),transfer);assert.equal(r.run('sending'),true);assert.equal(r.run("storage.get(key('pending'))"),'pending-id');assert.equal(r.run("storage.get(key('pending')+':draft')"),'sent earlier');
  assert.equal(r.$('query').value,'Keep my edited draft');assert.equal(r.run('images.length'),2);assert.equal(r.run('images[0].data'),'AAAA');assert.equal(r.$('attachments').children.length,2);assert.equal(r.$('notice').textContent,'发送结果待确认');assert.equal(requests,0);
  old.onerror();old.onopen();old.handlers.get('reset')();r.emit('hub:replay-done',{},old);assert.equal(r.run('streamReady'),false);
  r.streams[1].handlers.get('reset')();r.emit('hub:replay-done');assert.equal(r.run('streamReady'),true);assert.equal(r.$('send').disabled,true,'uncertain send remains locked after replay');assert.equal(requests,0);
});
test('automatic reconnect is independent of device polling and does not reset the prolonged-wait clock',()=>{
  const r=syncFixture();r.advance(9000);r.streams[0].onerror();assert.match(r.$('connection').textContent,/连接中断，正在自动重连/);assert.equal(r.run('source'),null);
  const start=r.run('syncWait.started');r.advance(2000);r.timer('reconnectTimer');assert.equal(r.streams.length,2);assert.equal(r.run('syncWait.started'),start);
  r.streams[1].onopen();assert.match(r.$('connection').textContent,/正在同步/);assert.equal(r.$('sync-retry').hidden,true);
  r.advance(1000);r.timer('syncTimer');assert.equal(r.$('sync-retry').hidden,false);r.streams[1].onerror();assert.equal(r.$('sync-retry').hidden,false,'another connection error cannot hide overdue retry');
  r.$('sync-retry').onclick();assert.equal(r.run('reconnectTimer'),null);assert.equal(r.streams.length,3);assert.equal(r.$('sync-retry').hidden,true);
});
test('a full subscription quota pauses automatic reconnect until explicit resync', async () => {
  const r=syncFixture(), sent=[];
  r.fetch(async (url, options) => { sent.push({url:String(url),method:options.method}); return ok({}); });
  const old=r.streams[0], initial=new URL(old.url);
  r.$('query').value='保留草稿';
  r.run("storage.set(key('pending'),'pending-send')");
  old.onopen();
  const lease=r.run('streamRenewal');
  r.intervals.get(lease)();
  await Promise.resolve();
  assert.deepEqual(sent,[{url:old.url,method:'POST'}]);
  r.emit('hub:stream-limit',{},old);
  old.onerror();
  r.run('resumeStream()');
  assert.equal(r.streams.length,1);
  assert.equal(r.run('reconnectTimer'),null);
  assert.equal(r.intervals.has(lease),false);
  assert.match(r.$('connection').textContent,/远控对话过多/);
  assert.equal(r.$('sync-retry').hidden,false);
  r.$('sync-retry').onclick();
  const next=new URL(r.streams[1].url);
  assert.equal(next.searchParams.get('viewer'),initial.searchParams.get('viewer'));
  assert.equal(Number(next.searchParams.get('attempt')),Number(initial.searchParams.get('attempt'))+1);
  r.emit('hub:replay-done');
  assert.equal(r.run('streamReady'),true);
  assert.equal(r.$('query').value,'保留草稿');
  assert.equal(r.run("storage.get(key('pending'))"),'pending-send');
});
for(const change of ['session','device','signout','offline','background','pagehide'])test(`${change} invalidates retry timers, old stream callbacks and scheduled reconnect`,async()=>{
  const r=syncFixture();r.$('query').value='preserved';r.run("images=[{name:'draft.png',data:'AAAA',mimeType:'image/png'}]");
  r.advance(12000);r.timer('syncTimer');r.streams[0].onerror();const reconnect=r.timers.get(r.run('reconnectTimer')),old=r.streams[0];
  if(change==='session')await r.run("openSession('bbbbbb')");
  if(change==='device'){r.run("resetDevice('other');devices=[{id:'other',online:true}];controls()");await r.run("openSession('aaaaaa')");}
  if(change==='signout')r.run('signOut()');
  if(change==='offline'){freshDeviceResponse(r,false);await r.run('refreshDevices()');}
  if(change==='background'){r.context.document.hidden=true;r.listeners.get('visibilitychange').fn();}
  if(change==='pagehide')r.listeners.get('window:pagehide').fn();
  const count=r.streams.length,title=r.$('connection').textContent;reconnect();old.onerror();old.onopen();old.handlers.get('reset')();r.emit('hub:replay-done',{},old);
  assert.equal(r.streams.length,count);assert.equal(r.$('connection').textContent,title);assert.equal(r.$('sync-retry').hidden,true);assert.equal(r.run('streamReady'),false);
  if(change==='offline'){assert.match(title,/电脑离线/);assert.match(r.$('sync-help').textContent,/设备互联/);}
  if(['background','pagehide','offline'].includes(change)){assert.equal(r.run('syncWait'),null);assert.equal(r.run('syncTimer'),null);assert.equal(r.run('reconnectTimer'),null);assert.equal(r.$('query').value,'preserved');assert.equal(r.run('images[0].data'),'AAAA');}
});
test('resumed PWA starts a fresh visible wait; offline streams cannot reconnect until the device returns online',async()=>{
  const r=syncFixture();r.advance(11000);const staleTimer=r.timers.get(r.run('syncTimer'));
  r.listeners.get('window:pagehide').fn();r.advance(60000);staleTimer();assert.equal(r.$('sync-retry').hidden,true);
  freshDeviceResponse(r,true);r.listeners.get('window:pageshow').fn({persisted:true});for(let i=0;i<30;i++)await Promise.resolve();
  assert.equal(r.streams.length,2);assert.equal(r.$('sync-retry').hidden,true);assert.equal(r.run('Date.now()-syncWait.started'),0);
  freshDeviceResponse(r,false);await r.run('refreshDevices()');r.run('connectStream()');assert.equal(r.streams.length,2);assert.equal(r.run('syncTimer'),null);
  freshDeviceResponse(r,true);await r.run('refreshDevices()');assert.equal(r.streams.length,3);assert.match(r.$('connection').textContent,/正在同步/);r.emit('hub:replay-done');assert.match(r.$('connection').textContent,/已同步/);
});
test('server reset after a synced conversation immediately relocks actions until current replay completes',()=>{
  const r=syncFixture();r.emit('hub:replay-done');assert.equal(r.$('send').disabled,false);
  r.streams[0].handlers.get('reset')();assert.equal(r.run('streamReady'),false);assert.equal(r.$('send').disabled,true);assert.match(r.$('connection').textContent,/正在同步/);
  r.emit('agent:processing-done');assert.equal(r.$('send').disabled,true);r.emit('hub:replay-done');assert.equal(r.$('send').disabled,false);
});
test('all sharing guidance uses device interconnect and the existing directory editor',()=>{
  const r=setup({mobile:true});r.run("user='alice';deviceListReady=true;controls()");assert.match(r.$('selection-state').textContent,/设备互联 → 允许其他设备访问本机/);
  r.run("device='desktop';devices=[{id:device,online:true}];sessionListDevice=device;controls()");assert.match(r.$('selection-state').textContent,/设置共享目录/);
  r.$('sharing-help').onclick();assert.match(r.$('modal-body').children.map(n=>n.textContent).join(''),/设备互联 → 允许其他设备访问本机 → 设置共享目录/);
  assert.doesNotMatch(fs.readFileSync(pageUrl,'utf8'),/移动访问/);
});

test('foreground recovery does not keep instructing the already-visible user to return to the page',async()=>{
 const r=syncFixture(),pending=deferred();r.context.document.hidden=true;r.listeners.get('visibilitychange').fn();
 r.fetch(()=>pending.promise);r.context.document.hidden=false;r.listeners.get('visibilitychange').fn();
 assert.match(r.$('connection').textContent,/正在自动重连/);assert.doesNotMatch(r.$('sync-help').textContent,/返回页面/);assert.equal(r.$('sync-retry').hidden,true);
 r.advance(12000);r.timer('syncTimer');assert.equal(r.$('sync-retry').hidden,false,'slow foreground discovery must not suppress recovery indefinitely');
 r.$('sync-retry').onclick();assert.equal(r.streams.length,2,'retry only replaces the current subscription while metadata is pending');
 r.run("resetDevice('other');devices=[{id:'other',online:false}];controls()");const title=r.$('connection').textContent;
 pending.resolve(ok([{id:'desktop',online:true}]));for(let n=0;n<20;n++)await Promise.resolve();assert.equal(r.$('connection').textContent,title);assert.equal(r.run('device'),'other');
});

test('late missing receipt cannot release a newer pending confirmation after reconnect',async()=>{
  const r=setup(),late=deferred();let calls=0;
  r.run("user='alice';device='computer';session='abcdef';streamReady=true;sending=true;storage.set(key('pending'),'request-1');storage.set(key('pending')+':draft','once')");r.$('query').value='once';
  r.fetch(async()=>++calls===1?late.promise:ok({state:'pending'}));
  const old=r.run("checkPending('request-1',generation,key('pending'))");
  await r.run("checkPending('request-1',generation,key('pending'))");
  late.resolve(ok({state:'missing'}));await old;
  assert.equal(r.run("storage.get(key('pending'))"),'request-1');assert.equal(r.run('sending'),true);assert.equal(r.$('query').value,'once');
});

test('late terminal receipt still settles its request but cannot affect another account or newer draft',async()=>{
  const r=setup(),late=deferred();let calls=0;
  r.run("user='alice';device='computer';session='abcdef';streamReady=true;sending=true;storage.set(key('pending'),'request-1');storage.set(key('pending')+':draft','sent earlier');images=[{id:'sent'},{id:'new'}];storage.set(key('pending')+':images','[\"sent\"]')");r.$('query').value='edited draft';
  r.fetch(async()=>++calls===1?late.promise:ok({state:'pending'}));
  const old=r.run("checkPending('request-1',generation,key('pending'))");await r.run("checkPending('request-1',generation,key('pending'))");late.resolve(ok({state:'done'}));await old;
  assert.equal(r.run('sending'),false);assert.equal(r.$('query').value,'edited draft');assert.equal(r.run('images.length'),1);assert.equal(r.run('images[0].id'),'new');
  const foreign=deferred();r.fetch(()=>foreign.promise);r.run("storage.set(key('pending'),'request-2');sending=true");const poll=r.run("checkPending('request-2',generation,key('pending'))");
  r.run("signOut();user='bob';device='other-computer';session='abcdef';images=[{id:'bob-image'}];storage.set(key('pending'),'bob-request');sending=true");r.$('query').value='bob draft';foreign.resolve(ok({state:'done'}));await poll;
  assert.equal(r.run("storage.get(key('pending'))"),'bob-request');assert.equal(r.$('query').value,'bob draft');assert.equal(r.run('images[0].id'),'bob-image');
});
