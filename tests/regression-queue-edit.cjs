const test=require('node:test'),assert=require('node:assert/strict');
const {ui,El}=require('./ui-harness.cjs');
const {env}=require('./harness.cjs');
const crypto=require('node:crypto');
test('queued rendering distinguishes identical messages and only matches unacknowledged optimistic boxes',()=>{
 const e=env({modules:{'./i18n.js':{t:x=>x}}}),{findQueued}=e.load('web/js/queued-messages.js');
 const first={dataset:{queueId:'one',queued:'same'}},second={dataset:{queueId:'two',queued:'same'}},optimistic={dataset:{queued:'same'}};
 const root={querySelectorAll:()=>[first,second,optimistic]};
 assert.equal(findQueued(root,{queueId:'two',query:'same'}),second);
 assert.equal(findQueued(root,{queueId:'three',query:'same'}),optimistic);
 assert.equal(findQueued(root,{queueId:'unknown',query:'same'},false),undefined);
});
function setup(){const u=ui();u.e.context.crypto=crypto;const composer=u.composer();const input=u.doc.getElementById('query');
 const box=new El();box.classList.add('pending');const button=new El();button.closest=()=>box;
 const withdraw=()=>u.doc.events['ash:queue-edit'][0]({detail:{sessionId:'aaaaaa',queueId:'queue-message-id',button}});
 return {...u,composer,input,box,button,withdraw};}
test('desktop queue withdrawal merges the draft and restores uploaded image references',async()=>{
 const s=setup();s.input.value='new draft';s.e.context.fetch=async()=>({ok:true,json:async()=>({query:'queued',images:[{id:'aaaaaa_img_a_b',mimeType:'image/png'}]})});
 await s.withdraw();assert.equal(s.input.value,'queued\nnew draft');assert.equal(s.composer.getImages()[0].id,'aaaaaa_img_a_b');assert(s.box.removed);
});
test('desktop queue withdrawal retry reuses receipt identity',async()=>{
 const s=setup(),requests=[];s.e.context.fetch=async(_url,opts)=>{requests.push(JSON.parse(opts.body));throw Error('offline');};
 await s.withdraw();assert(!s.box.removed);assert.equal(s.button.disabled,false);
 s.e.context.fetch=async(_url,opts)=>{requests.push(JSON.parse(opts.body));return{ok:true,json:async()=>({query:'recovered'})};};
 await s.withdraw();assert.equal(requests[0].requestId,requests[1].requestId);assert.equal(s.input.value,'recovered');
});
test('a withdrawal conflict must not remove a message that has already started',async()=>{
 const s=setup();s.box.classList.remove('pending');s.e.context.fetch=async()=>({ok:false,status:409});
 await s.withdraw();assert(!s.box.removed);assert.equal(s.input.value,'');assert.equal(s.toasts.length,1);
});
test('switching conversations during withdrawal preserves draft ownership',async()=>{
 const s=setup();let finish;s.input.value='original draft';s.e.context.fetch=()=>new Promise(r=>finish=r);
 const done=s.withdraw();s.active.value={id:'bbbbbb',state:{},agentInfo:{}};s.input.value='other draft';
 finish({ok:true,json:async()=>({query:'queued',images:[{id:'aaaaaa_img_a_b',mimeType:'image/png'}]})});await done;
 assert.equal(s.input.value,'other draft');assert.equal(s.composer.getImages().length,0);
 s.active.value={id:'aaaaaa',state:{},agentInfo:{}};
 assert.equal(s.input.value,'queued\noriginal draft');assert.equal(s.composer.getImages()[0].id,'aaaaaa_img_a_b');
});
test('withdrawing a chat message must not inherit a terminal draft execution mode',async()=>{
 const s=setup();s.input.value='!echo keep-this-draft';s.input.dispatchEvent({type:'input'});
 assert.equal(s.doc.getElementById('form').classList.contains('shell-mode'),true);
 s.e.context.fetch=async()=>({ok:true,json:async()=>({query:'Review the files'})});
 await s.withdraw();
 assert.equal(s.input.value,'Review the files\necho keep-this-draft');
 assert.equal(s.doc.getElementById('form').classList.contains('shell-mode'),false);
 const calls=[];s.e.context.fetch=async(url)=>{calls.push(url);return {ok:true,json:async()=>({})};};
 await s.composer.doSubmit(s.input.value);
 assert(calls.some(url=>url==='/aaaaaa/submit'));assert(!calls.some(url=>url.endsWith('/pty-input')));
});
test('a delayed queue removal must not delete a newer optimistic message with identical text',()=>{
 const {ts,fs,path,root,vm}=require('./harness.cjs');
 const e=env({modules:{'./i18n.js':{t:x=>x}}});
 e.context.findQueued=e.load('web/js/queued-messages.js').findQueued;
 const file=ts.createSourceFile('sse.js',fs.readFileSync(path.join(root,'web/js/sse.js'),'utf8'),ts.ScriptTarget.Latest,true);
 let handler;const visit=n=>{if(ts.isMethodDeclaration(n)&&n.name?.text==='agent:queued-done')handler=n;ts.forEachChild(n,visit);};visit(file);
 const run=vm.runInContext('({'+handler.getText(file)+'})["agent:queued-done"]',e.context);
 const optimistic=new El();optimistic.dataset.queued='same';optimistic._queryText='same';
 run.call({state:{},streamEl:{querySelectorAll:()=>[optimistic]}},{queueId:'already-withdrawn',query:'same',dropped:true});
 assert(!optimistic.removed);
 const identified=new El();identified.dataset.queueId='current';identified.dataset.queued='same';
 const separator=new El();separator.classList.add('turn-sep');identified.previousElementSibling=separator;
 run.call({state:{},streamEl:{querySelectorAll:()=>[optimistic,identified]}},{queueId:'current',query:'same',dropped:true});
 assert(identified.removed);assert(separator.removed);assert(!optimistic.removed);
 run.call({state:{},streamEl:{querySelectorAll:()=>[optimistic]}},{query:'same',dropped:true});
 assert(optimistic.removed); // Older kernels have no queue IDs.
});

test('a withdrawn chat clears terminal mode in its inactive draft without changing the active one',async()=>{
 const s=setup();s.input.value='!echo original';s.input.dispatchEvent({type:'input'});
 let finish;s.e.context.fetch=()=>new Promise(resolve=>finish=resolve);
 const done=s.withdraw();s.active.value={id:'bbbbbb',state:{},agentInfo:{}};
 s.input.value='!echo other';s.input.dispatchEvent({type:'input'});
 finish({ok:true,json:async()=>({query:'Review the files'})});await done;
 assert.equal(s.input.value,'echo other');assert(s.doc.getElementById('form').classList.contains('shell-mode'));
 s.active.value={id:'aaaaaa',state:{},agentInfo:{}};
 assert.equal(s.input.value,'Review the files\necho original');
 assert.equal(s.doc.getElementById('form').classList.contains('shell-mode'),false);
});
