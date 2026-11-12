import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { RemoteConnector } from '../dist/remote/connector.js';
process.env.NODE_ENV = 'test';
// Connector-only regressions run without the separately deployed gateway package.
async function waitFor(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('timed out'); }
test('local enrollment preserves chunked UTF-8 and rejects oversized byte payloads', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-connector-body-'));
  const project = path.join(dir, '项目目录'); fs.mkdirSync(project);
  let saved, enrolled;
  const connector = new RemoteConnector({ dataDir: dir, store: { read: () => saved, write: value => { saved = value; } } });
  t.after(() => { connector.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    enrolled = JSON.parse(options.body);
    return Response.json({ protocol: 1, deviceId: 'device', deviceToken: 'secret', username: enrolled.username });
  });
  const body = { username: 'unicode-body', password: 'test password 中文字符', deviceName: '设计电脑 🟡', roots: [project] };
  const bytes = Buffer.from(JSON.stringify(body));
  const offsets = [0, ...['中', '设', '🟡', '项'].map(s => bytes.indexOf(Buffer.from(s)) + 1).sort((a, b) => a - b), bytes.length];
  async function handle(chunks) {
    const req = Object.assign(Readable.from(chunks), { method: 'POST', url: '/api/mobile/connect', headers: { 'x-ashub-local': '1' } });
    let status;
    await connector.handle(req, { writeHead(code) { status = code; }, end() {} });
    return status;
  }
  assert.equal(await handle(offsets.slice(1).map((end, i) => bytes.subarray(offsets[i], end))), 200);
  assert.equal(enrolled.password, body.password);
  assert.equal(JSON.parse(saved).deviceName, body.deviceName);
  assert.deepEqual(JSON.parse(saved).roots, [fs.realpathSync(project)]);
  assert.equal(await handle([Buffer.from(JSON.stringify({ ...body, note: '中'.repeat(6000) }))]), 413);
});

test('gateway revocation cancels local authorization still in progress', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-connector-revoked-'));
  let socket;
  const nativeWebSocket = globalThis.WebSocket;
  t.after(() => { globalThis.WebSocket = nativeWebSocket; });
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor() { socket = this; }
    close() {}
  };
  const config = { deviceId: 'desktop', deviceToken: 'secret', username: 'alice', roots: [fs.realpathSync(dir)], deviceName: 'Desktop' };
  const connector = new RemoteConnector({ dataDir: dir, store: { read: () => JSON.stringify(config), write() {} } });
  t.after(() => { connector.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  connector.start(1);
  let release; const effects = [];
  connector.local = async route => route === '/sessions' ? new Promise(resolve => { release = resolve; }) : effects.push(route);
  const pending = connector.execute('permission', { session: 'abcdef', requestId: 'approval', outcome: 'approved' });
  const rejected = assert.rejects(pending, e => e.status === 403);
  socket.onclose({ code: 4001 });
  release([{ instanceId: 'abcdef', kind: 'agent', cwd: dir }]);
  await rejected;
  assert.equal(connector.status().status, 'revoked'); assert.deepEqual(effects, []);
});

test('abnormal SSE exits release local HTTP streams on every retry', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ashub-sse-release-'));
  let active = 0, mode = 'malformed', latest;
  const local = http.createServer((req,res) => {
    if (req.url === '/sessions') { res.end(JSON.stringify([{instanceId:'abcdef',kind:'agent',cwd:dir}])); return; }
    res.writeHead(200,{'Content-Type':'text/event-stream'}); latest=res; active++; res.on('close',()=>active--);
    if (mode === 'cwd') res.write('data: '+JSON.stringify({meta:{name:'shell:cwd-change'},payload:{cwd:os.tmpdir()}})+'\n\n');
    else if (mode === 'malformed') res.write('data: {invalid json}\n\n');
    else if (mode === 'oversize') res.write('data: '+ 'x'.repeat(6*1024*1024+1));
    else res.write(': keepalive\n\n');
  });
  local.listen(0,'127.0.0.1'); await once(local,'listening');
  const connector = new RemoteConnector({gateway:'http://127.0.0.1/mobile/',dataDir:dir});
  connector.config = {deviceId:'test',deviceToken:'test',username:'test',roots:[fs.realpathSync(dir)],deviceName:'Test'};
  connector.localUrl = `http://127.0.0.1:${local.address().port}`;
  const frames=[], ws={readyState:WebSocket.OPEN,bufferedAmount:0,send:s=>frames.push(JSON.parse(s)),close(){}};
  t.after(async () => { connector.close(); latest?.end(); local.closeAllConnections(); await new Promise(r=>local.close(r)); fs.rmSync(dir,{recursive:true,force:true}); });
  for (mode of ['cwd','malformed','oversize','malformed']) {
    await connector.subscribe(ws,'stream', 'abcdef'); await waitFor(()=>active===0);
    assert.equal(connector.streams.size,0); assert.equal(frames.at(-1).type,'end');
  }
  mode='normal'; const running=connector.subscribe(ws,'normal','abcdef'); await waitFor(()=>active===1);
  connector.close(); await running; await waitFor(()=>active===0); assert.equal(connector.streams.size,0);
});
test('disabled saved identity cannot reconnect or execute after restart', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-disabled-'));
  const config={deviceId:'old-device',deviceToken:'old-token',username:'alice',deviceName:'Computer',roots:[dir],enabled:false};
  const connector=new RemoteConnector({gateway:'http://127.0.0.1/mobile/',dataDir:dir,store:{read:()=>JSON.stringify(config),write(){}}});
  t.after(()=>{connector.close();fs.rmSync(dir,{recursive:true,force:true});});
  connector.start(1); assert.equal(connector.status().enabled,false); assert.equal(connector.status().status,'disabled'); assert.equal(connector.socket,null);
  await assert.rejects(()=>connector.execute('projects',{}), /移动访问已关闭/);
});

test('project identity survives reorder, rejects stale roots and preserves create deduplication', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-project-identity-'));
  const a=path.join(dir,'A'),b=path.join(dir,'B');fs.mkdirSync(a);fs.mkdirSync(b);
  const created=[];
  const local=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;created.push(JSON.parse(body).cwd);res.end(JSON.stringify({instanceId:'abcdef'}));});
  local.listen(0,'127.0.0.1');await once(local,'listening');
  const connector=new RemoteConnector({gateway:'http://127.0.0.1/mobile/',dataDir:dir});
  connector.config={deviceId:'same-device',deviceToken:'same-secret',username:'alice',deviceName:'Computer',roots:[a,b]};
  connector.localUrl=`http://127.0.0.1:${local.address().port}`;
  t.after(async()=>{connector.close();local.closeAllConnections();await new Promise(r=>local.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const projects=await connector.execute('projects',{}),idA=projects[0].id;
  assert.equal(typeof idA,'string');assert.notEqual(idA,projects[1].id);assert.ok(!idA.includes(dir));
  connector.config.roots=[b,a];assert.equal((await connector.execute('projects',{}))[1].id,idA);
  const args={project:idA,requestId:'stable-project-create-0001'};
  await connector.execute('create',args);await waitFor(async()=>(await connector.execute('request-status',{requestId:args.requestId})).state==='done');
  assert.deepEqual(created,[a]);await connector.execute('create',args);assert.equal(created.length,1);
  connector.config.roots=[b];
  await assert.rejects(()=>connector.execute('create',{project:idA,requestId:'removed-project-0001'}),e=>e.status===403);
  await assert.rejects(()=>connector.execute('create',{project:0,requestId:'legacy-project-0001'}),e=>e.status===403);
  connector.config.roots=[a,b];connector.config.deviceToken='new-secret';
  await assert.rejects(()=>connector.execute('create',{project:idA,requestId:'old-binding-000001'}),e=>e.status===403);
  assert.equal(created.length,1);
});

test('status stays pending throughout concurrent submit validation and effects execute once',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-validating-'));const waiting=[];let effects=0;
  const local=http.createServer(async(req,res)=>{
    if(req.url==='/sessions'){waiting.push(res);return;}
    effects++;res.end('{"ok":true}');
  });local.listen(0,'127.0.0.1');await once(local,'listening');
  const connector=new RemoteConnector({gateway:'http://127.0.0.1/mobile/',dataDir:dir});
  connector.config={deviceId:'desktop',deviceToken:'test',username:'alice',deviceName:'Test',roots:[fs.realpathSync(dir)]};connector.localUrl=`http://127.0.0.1:${local.address().port}`;
  t.after(async()=>{connector.close();for(const res of waiting)res.end('[]');local.closeAllConnections();await new Promise(r=>local.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const args={session:'abcdef',query:'once',requestId:'validation-race-00001'},status=()=>connector.execute('request-status',{requestId:args.requestId});
  const first=connector.execute('submit',args),second=connector.execute('submit',args);await waitFor(()=>waiting.length===2);
  assert.equal((await status()).state,'pending');assert.equal(effects,0);
  const sessions=JSON.stringify([{instanceId:'abcdef',kind:'agent',cwd:dir}]);
  waiting[0].end(sessions);await first;assert.equal(connector.validating.size,1);
  waiting[1].end(sessions);await second;await waitFor(async()=>(await status()).state==='done');
  assert.equal(effects,1);assert.equal(connector.validating.size,0);
  const deniedArgs={...args,requestId:'validation-denied-001'};
  const denied=connector.execute('submit',deniedArgs);const rejected=assert.rejects(denied,e=>e.status===403);
  await waitFor(()=>waiting.length===3);assert.equal((await connector.execute('request-status',{requestId:deniedArgs.requestId})).state,'pending');
  waiting[2].end('[]');await rejected;assert.equal(connector.validating.size,0);assert.equal((await connector.execute('request-status',{requestId:deniedArgs.requestId})).state,'missing');assert.equal(effects,1);
});

for (const change of ['disable', 'rebind']) {
  test(`session operations cannot outlive ${change} during authorization`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-authorization-race-'));
    const connector = new RemoteConnector({ gateway: 'http://127.0.0.1/mobile/', dataDir: dir });
    const config = { deviceId: 'old-device', deviceToken: 'secret', username: 'alice', deviceName: 'Desktop', roots: [fs.realpathSync(dir)] };
    t.after(() => { connector.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const effects = [];
    t.mock.method(globalThis, 'fetch', async (url) => { effects.push(String(url)); return new Response('{}', { headers: { 'content-type': 'image/png' } }); });
    for (const op of ['cancel', 'permission', 'model', 'thinking', 'set-thinking', 'image', 'queue', 'queue-withdraw', 'queue-update', 'session-network', 'set-session-network']) {
      connector.config = { ...config }; connector.stopped = false;
      let release;
      connector.local = async route => {
        if (route === '/sessions') return new Promise(resolve => { release = resolve; });
        effects.push(route); return { ok: true };
      };
      const pending = connector.execute(op, { session: 'abcdef', requestId: 'approval-1', outcome: 'approved', provider: 'test', model: 'test', id: 'abcdef_img_123_abc' });
      const rejected = assert.rejects(pending, e => e.status === 403, `${op} must reject stale authorization`);
      assert.equal(typeof release, 'function');
      connector.close();
      if (change === 'rebind') {
        connector.config = { ...config, deviceId: 'new-device', username: 'bravo' };
        connector.stopped = false;
      } else connector.config.enabled = false;
      release([{ instanceId: 'abcdef', kind: 'agent', cwd: dir, isProcessing: false }]);
      await rejected;
      assert.deepEqual(effects, [], `${op} must not reach the local Hub after ${change}`);
    }
  });
}

function adapterFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-remote-adapter-'));
  const shared = path.join(dir, 'shared'), privateDir = path.join(dir, 'private');
  fs.mkdirSync(shared); fs.mkdirSync(privateDir);
  const connector = new RemoteConnector({ dataDir: dir });
  connector.config = { deviceId: 'desktop', deviceToken: 'secret', username: 'alice', deviceName: 'Desktop', roots: [fs.realpathSync(shared)] };
  let members = ['aaaaaa', 'bbbbbb', 'cccccc'];
  const chats = [{ instanceId: 'aaaaaa', kind: 'agent', cwd: shared }, { instanceId: 'bbbbbb', kind: 'agent', cwd: shared }, { instanceId: 'cccccc', kind: 'agent', cwd: privateDir }];
  const tasks = [{ id: 'shared-task', sourceId: 'aaaaaa', recipientId: 'bbbbbb', state: 'completed' }, { id: 'private-task', sourceId: 'cccccc', recipientId: 'aaaaaa', state: 'completed' }];
  connector.local = async route => {
    if (route === '/sessions') return chats;
    if (route === '/api/projects') return [{ id: 'project', name: 'Mixed project', sessionIds: members }, { id: 'private', name: 'Secret', sessionIds: ['cccccc'] }];
    const params = new URL(route, 'http://local').searchParams;
    return params.has('taskId') ? { ...tasks[0], text: 'shared output 🟡', nextOffset: 16, hasMore: false } : tasks;
  };
  t.after(() => { connector.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { connector, dir, shared, privateDir, chats, members: next => { members = next; } };
}
test('remote groups and task receipts expose only shared conversations on both sides', async t => {
  const { connector } = adapterFixture(t);
  assert.deepEqual(await connector.execute('project-groups', {}), [{ id: 'project', name: 'Mixed project', sessionIds: ['aaaaaa', 'bbbbbb'], pinnedSessionIds: [] }]);
  assert.deepEqual((await connector.execute('project-tasks', { projectId: 'project' })).map(t => t.id), ['shared-task']);
  assert.equal((await connector.execute('project-tasks', { projectId: 'project', taskId: 'shared-task' })).text, 'shared output 🟡');
  await assert.rejects(connector.execute('project-tasks', { projectId: 'project', taskId: 'private-task' }), e => e.status === 403);
  await assert.rejects(connector.execute('project-tasks', { projectId: 'private' }), e => e.status === 403);
  await assert.rejects(connector.execute('project-tasks', { projectId: 'project', taskId: 'shared-task', offset: -1 }), e => e.status === 400);
});
test('remote task pages recheck membership after reading output', async t => {
  const f = adapterFixture(t), original = f.connector.local;
  f.connector.local = async route => { const result = await original(route); if (route.includes('taskId=')) f.members(['aaaaaa']); return result; };
  await assert.rejects(f.connector.execute('project-tasks', { projectId: 'project', taskId: 'shared-task' }), e => e.status === 403);
});
test('group responses cannot outlive desktop revocation', async t => {
  const { connector } = adapterFixture(t), original = connector.local;
  connector.local = async route => { const result = await original(route); if (route === '/api/projects') connector.close(); return result; };
  await assert.rejects(connector.execute('project-groups', {}), e => e.status === 403);
});
test('remote artifacts transfer exact bounded bytes and Unicode names', async t => {
  const { connector, shared } = adapterFixture(t);
  const bytes = Buffer.alloc(800123); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  fs.writeFileSync(path.join(shared, '成果 #1 🟡.zip'), bytes);
  const args = { session: 'aaaaaa', path: '成果 #1 🟡.zip' };
  const meta = await connector.execute('artifact', args); assert.equal(meta.size, bytes.length); assert.equal(meta.name, args.path);
  const chunks = [];
  for (let offset = 0; offset < meta.size;) {
    const part = await connector.execute('artifact', { ...args, version: meta.version, offset });
    const b = Buffer.from(part.data, 'base64'); assert.ok(b.length <= 256 * 1024); chunks.push(b); offset = part.nextOffset;
  }
  assert.deepEqual(Buffer.concat(chunks), bytes);
  fs.writeFileSync(path.join(shared, 'empty'), ''); assert.equal((await connector.execute('artifact', { session: 'aaaaaa', path: 'empty' })).size, 0);
});
test('artifact chunks reject updates, traversal, unshared owners and escaped symlinks', async t => {
  const { connector, shared, privateDir } = adapterFixture(t);
  fs.writeFileSync(path.join(shared, 'result'), 'original'); fs.writeFileSync(path.join(privateDir, 'secret'), 'secret');
  fs.symlinkSync(path.join(privateDir, 'secret'), path.join(shared, 'link'));
  const args = { session: 'aaaaaa', path: 'result' }, meta = await connector.execute('artifact', args);
  fs.writeFileSync(path.join(shared, 'result'), 'changed content');
  await assert.rejects(connector.execute('artifact', { ...args, version: meta.version, offset: 0 }), e => e.status === 409);
  for (const path of ['../private/secret', 'link']) await assert.rejects(connector.execute('artifact', { session: 'aaaaaa', path }), e => e.status === 403);
  await assert.rejects(connector.execute('artifact', { session: 'cccccc', path: 'secret' }), e => e.status === 403);
  await assert.rejects(connector.execute('artifact', { ...args, offset: -1 }), e => e.status === 400);
  await assert.rejects(connector.execute('artifact', { ...args, offset: 0 }), e => e.status === 400);
});

test('remote thinking reads stay available while running but writes require idle shared sessions and identity', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-remote-thinking-'));
  const connector=new RemoteConnector({gateway:'http://127.0.0.1/mobile/',dataDir:dir});
  connector.config={deviceId:'test',deviceToken:'test',username:'test',roots:[fs.realpathSync(dir)]};
  t.after(()=>{connector.close();fs.rmSync(dir,{recursive:true,force:true});});
  let running=true; const writes=[];
  connector.local=async(route,body)=>{
    if(route==='/sessions')return [{instanceId:'abcdef',kind:'agent',cwd:dir,isProcessing:running}];
    writes.push({route,body});return {model:'deepseek-v4-flash',provider:'deepseek',level:body?.level||'high',levels:['off','low','high','max'],supported:true};
  };
  assert.equal((await connector.execute('capabilities',{})).thinking,true);
  assert.equal((await connector.execute('thinking',{session:'abcdef'})).level,'high');writes.length=0;
  const args={session:'abcdef',model:'deepseek-v4-flash',provider:'deepseek',level:'max'};
  await assert.rejects(()=>connector.execute('set-thinking',args),e=>e.status===409);
  running=false;
  await assert.rejects(()=>connector.execute('set-thinking',{session:'abcdef',level:'max'}),e=>e.status===400);
  await assert.rejects(()=>connector.execute('thinking',{session:'ffffff'}),e=>e.status===403);
  assert.equal(writes.length,0);
  assert.equal((await connector.execute('set-thinking',args)).level,'max');
  assert.deepEqual(writes,[{route:'/abcdef/thinking',body:{model:args.model,provider:args.provider,level:'max'}}]);
});

test('queue editing is scoped to authorized sessions and uploaded image references', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-remote-queue-'));
 const connector=new RemoteConnector({dataDir:dir});
 t.after(()=>{connector.close();fs.rmSync(dir,{recursive:true,force:true});});
 connector.config={deviceId:'desktop',deviceToken:'secret',username:'alice',roots:[fs.realpathSync(dir)],deviceName:'Desktop'};connector.stopped=false;
 const effects=[];
 connector.local=async(route,body)=>{if(route==='/sessions')return[{instanceId:'abcdef',kind:'agent',cwd:dir}];effects.push({route,body});return {id:'queue-id'};};
 assert.equal((await connector.execute('capabilities',{})).queue,true);
 await connector.execute('queue',{session:'abcdef'});
 await connector.execute('queue-withdraw',{session:'abcdef',id:'queued-item-0000001',requestId:'withdraw-request-01'});
 assert.equal(effects[1].route,'/abcdef/queue/withdraw');assert.equal(effects[1].body.requestId,'withdraw-request-01');
 await assert.rejects(connector.execute('queue-withdraw',{session:'cccccc',id:'queued-item-0000001',requestId:'withdraw-request-01'}),e=>e.status===403||e.status===404);
 await assert.rejects(connector.execute('submit',{session:'abcdef',requestId:'submit-invalid-ref',query:'test',images:[{id:'cccccc_img_a_b',mimeType:'image/png'}]}));
 assert.equal(effects.length,2,'foreign image must not be submitted');
 await connector.execute('submit',{session:'abcdef',requestId:'submit-owned-image',query:'test',images:[{id:'abcdef_img_a_b',mimeType:'image/png'}]});
 await waitFor(()=>effects.length===3);assert.equal(effects[2].body.images[0].id,'abcdef_img_a_b');
});

test('remote delivery mode is validated, forwarded and part of retry identity',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-steer-connector-')),effects=[];
 const local=http.createServer(async(req,res)=>{if(req.url==='/sessions'){res.end(JSON.stringify([{instanceId:'abcdef',kind:'agent',cwd:dir}]));return;}let body='';for await(const chunk of req)body+=chunk;effects.push(JSON.parse(body));res.end('{"ok":true}');});
 local.listen(0,'127.0.0.1');await once(local,'listening');
 const c=new RemoteConnector({gateway:'http://127.0.0.1/mobile/',dataDir:dir});c.config={deviceId:'desktop',deviceToken:'test',username:'alice',deviceName:'Test',roots:[fs.realpathSync(dir)]};c.localUrl=`http://127.0.0.1:${local.address().port}`;
 t.after(async()=>{c.close();local.closeAllConnections();await new Promise(r=>local.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const args={session:'abcdef',query:'Correction',requestId:'steering-request-001',delivery:'steer'};
 await c.execute('submit',args);await waitFor(async()=>(await c.execute('request-status',{requestId:args.requestId})).state==='done');
 await c.execute('submit',args);assert.equal(effects.length,1);assert.equal(effects[0].delivery,'steer');
 await assert.rejects(c.execute('submit',{...args,delivery:'queue'}),e=>e.status===409);
 await assert.rejects(c.execute('submit',{...args,requestId:'steering-request-002',delivery:'interrupt'}));assert.equal(effects.length,1);
});

test('queue mutations forward revision and identity only for authorized sessions',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-queue-update-')),effects=[];
 const connector=new RemoteConnector({dataDir:dir});t.after(()=>{connector.close();fs.rmSync(dir,{recursive:true,force:true});});
 connector.config={deviceId:'desktop',deviceToken:'secret',username:'alice',roots:[fs.realpathSync(dir)],deviceName:'Desktop'};connector.stopped=false;
 connector.local=async(route,body)=>{if(route==='/sessions')return[{instanceId:'abcdef',kind:'agent',cwd:dir}];effects.push({route,body});return {};};
 assert.equal((await connector.execute('capabilities',{})).queueActions,true);
 const args={session:'abcdef',id:'queued-message-0001',requestId:'edit-request-000001',revision:3,action:'edit',query:'new text'};
 await connector.execute('queue-update',args);
 assert.deepEqual(effects,[{route:'/abcdef/queue/update',body:{id:args.id,requestId:args.requestId,revision:3,action:'edit',query:'new text'}}]);
 await assert.rejects(connector.execute('queue-update',{...args,session:'cccccc'}),e=>e.status===403||e.status===404);
 assert.equal(effects.length,1);
});


test('project pins preserve desktop order without exposing unshared or nonmember conversations', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-remote-pins-'));
  const connector = new RemoteConnector({ dataDir: dir });
  connector.config = { deviceId:'desk', deviceToken:'test', username:'alice', deviceName:'Desk', roots:[dir] };
  t.after(() => { connector.close(); fs.rmSync(dir, { recursive:true, force:true }); });
  const projects = [{ id:'p', name:'Project', sessionIds:['aaaaaa','bbbbbb','hidden'], pinnedSessionIds:['hidden','bbbbbb','outsid','aaaaaa'] },
    { id:'legacy', name:'Legacy', sessionIds:['aaaaaa'] }, { id:'private', name:'Private', sessionIds:['hidden'], pinnedSessionIds:['hidden'] }];
  connector.sessions = async () => ['aaaaaa','bbbbbb','outsid'].map(instanceId => ({instanceId}));
  connector.local = async route => { assert.equal(route, '/api/projects'); return projects; };
  const groups = await connector.groups(0);
  assert.deepEqual(groups, [
    {id:'p',name:'Project',sessionIds:['aaaaaa','bbbbbb'],pinnedSessionIds:['bbbbbb','aaaaaa']},
    {id:'legacy',name:'Legacy',sessionIds:['aaaaaa'],pinnedSessionIds:[]}
  ]);
  assert.deepEqual(projects[0].pinnedSessionIds, ['hidden','bbbbbb','outsid','aaaaaa']);
  connector.config.enabled = false;
  await assert.rejects(connector.groups(0), /移动访问授权已变更/);
});

test('image resources recheck authorization after reads and reject forged IDs or offsets',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-images-remote-'));let socket;
 const native=globalThis.WebSocket;globalThis.WebSocket=class{static OPEN=1;constructor(){socket=this}close(){}};
 const config={deviceId:'desktop',deviceToken:'secret',username:'alice',roots:[fs.realpathSync(dir)],deviceName:'Desktop'};
 const c=new RemoteConnector({dataDir:dir,store:{read:()=>JSON.stringify(config),write(){}}});
 t.after(()=>{c.close();globalThis.WebSocket=native;fs.rmSync(dir,{recursive:true,force:true})});c.start(1);
 let allowed=true,release,waiting=false;const routes=[];
 c.local=async route=>{routes.push(route);if(route==='/sessions')return allowed?[{instanceId:'abcdef',kind:'agent',cwd:dir}]:[];if(waiting)return new Promise(r=>release=r);return {version:'a'.repeat(64),size:1};};
 const args={session:'abcdef',id:'a'.repeat(64)};
 assert.equal((await c.execute('image-resource',args)).size,1);
 await assert.rejects(c.execute('image-resource',{...args,id:'../secret'}));await assert.rejects(c.execute('image-resource',{...args,offset:-1}));
 waiting=true;const pending=c.execute('image-resource',args);await waitFor(()=>release);allowed=false;release({data:'private'});await assert.rejects(pending);
 assert(routes.some(r=>r.includes('/image-resources/')));
});

test('remote network controls are scoped to the shared conversation and preserve inheritance', async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-remote-network-')),effects=[];
 const connector=new RemoteConnector({gateway:'http://127.0.0.1/mobile/',dataDir:dir});
 connector.config={deviceId:'test',deviceToken:'secret',username:'alice',roots:[fs.realpathSync(dir)],deviceName:'Test'};
 t.after(()=>{connector.close();fs.rmSync(dir,{recursive:true,force:true})});
 const policy={proxyEnabled:true,sessions:{private:false}};
 connector.local=async(route,body,long,method)=>{
  if(route==='/sessions')return [{instanceId:'abcdef',kind:'agent',cwd:dir}];
  assert.equal(route,'/api/settings/network');
  if(method==='PUT'){effects.push(body);assert.equal(body.session,'abcdef');if(body.enabled===null)delete policy.sessions.abcdef;else policy.sessions.abcdef=body.enabled;}
  return policy;
 };
 assert.equal((await connector.execute('capabilities',{})).sessionNetwork,true);
 assert.deepEqual(await connector.execute('session-network',{session:'abcdef'}),{session:'abcdef',enabled:null,effective:true,globalEnabled:true});
 for(const enabled of [false,true,null]){
  const result=await connector.execute('set-session-network',{session:'abcdef',enabled});
  assert.equal(result.enabled,enabled);assert.equal(result.effective,enabled??true);assert.equal('sessions' in result,false);
 }
 assert.deepEqual(effects.map(e=>e.enabled),[false,true,null]);assert.equal(policy.proxyEnabled,true);assert.equal(policy.sessions.private,false);
 for(const enabled of [undefined,'false',0,{}])await assert.rejects(connector.execute('set-session-network',{session:'abcdef',enabled}),e=>e.status===400);
 await assert.rejects(connector.execute('set-session-network',{session:'bbbbbb',enabled:false}),e=>e.status===403);
 assert.equal(effects.length,3);
});

test('confirmed remote deletion is scoped, durable and idempotent after the conversation disappears', async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-remote-delete-'));let deleted=false,calls=0;
 const connector=new RemoteConnector({gateway:'http://127.0.0.1/mobile/',dataDir:dir});
 connector.config={deviceId:'test',deviceToken:'secret',username:'alice',roots:[fs.realpathSync(dir)],deviceName:'Test'};
 t.after(()=>{connector.close();fs.rmSync(dir,{recursive:true,force:true})});
 connector.local=async(route,body,long,method)=>{
  if(route==='/sessions')return deleted?[]:[{instanceId:'abcdef',kind:'agent',cwd:dir}];
  assert.equal(route,'/abcdef/');assert.equal(method,'DELETE');assert.equal(body,undefined);calls++;deleted=true;return {ok:true};
 };
 const args={session:'abcdef',requestId:'remote-delete-00001',confirm:true};
 assert.equal((await connector.execute('capabilities',{})).sessionDelete,true);
 await assert.rejects(connector.execute('session-delete',{...args,confirm:false}),e=>e.status===400);
 await assert.rejects(connector.execute('session-delete',{...args,session:'bbbbbb'}),e=>e.status===403);
 const entry=await connector.execute('session-delete',args);await waitFor(()=>entry.state==='done');
 assert.equal(calls,1);assert.deepEqual(entry.result,{ok:true});
 assert.equal(await connector.execute('session-delete',args),entry);assert.equal(calls,1);
 assert.equal((await connector.execute('request-status',{requestId:args.requestId})).state,'done');
 await assert.rejects(connector.execute('session-delete',{...args,session:'bbbbbb'}),e=>e.status===409);
 const receipt=JSON.parse(fs.readFileSync(path.join(dir,'remote-requests.json'),'utf8'))['test:'+args.requestId];assert.equal(receipt.state,'done');
});

test('remote deletion rechecks authorization before the durable effect starts',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-remote-delete-race-'));let lookups=0,release,effects=0;
 const connector=new RemoteConnector({gateway:'http://127.0.0.1/mobile/',dataDir:dir});
 connector.config={deviceId:'test',deviceToken:'secret',username:'alice',roots:[fs.realpathSync(dir)],deviceName:'Test'};
 t.after(()=>{connector.close();fs.rmSync(dir,{recursive:true,force:true})});
 const shared=[{instanceId:'abcdef',kind:'agent',cwd:dir}];
 connector.local=async route=>{if(route==='/sessions'){lookups++;if(lookups===2)return new Promise(r=>release=r);return shared;}effects++;return {ok:true};};
 const entry=await connector.execute('session-delete',{session:'abcdef',requestId:'remote-delete-race01',confirm:true});
 assert.equal(typeof release,'function');connector.close();release(shared);await waitFor(()=>entry.state==='unknown');assert.equal(effects,0);
});

test('project activity hints exclude unshared owners and extra plugin metadata',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-remote-activity-'));const connector=new RemoteConnector({dataDir:dir});
 connector.config={deviceId:'desk',deviceToken:'test',username:'alice',deviceName:'Desk',roots:[dir]};
 t.after(()=>{connector.close();fs.rmSync(dir,{recursive:true,force:true})});
 connector.sessions=async()=>[{instanceId:'aaaaaa'}];
 connector.local=async()=>[{id:'p',name:'Project',sessionIds:['aaaaaa','bbbbbb'],activities:[{id:'shared',sessionId:'aaaaaa',projectId:'p',label:'Waiting',state:'waiting',private:'not shared'},{id:'hidden',sessionId:'bbbbbb',label:'Hidden',state:'running'}]}];
 const groups=await connector.groups(0);assert.deepEqual(groups[0].activities,[{id:'shared',sessionId:'aaaaaa',label:'Waiting',state:'waiting'}]);
});

test('plugin resources preserve exactly-once receipts, isolate shared owners and keep private views out of the journal',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-remote-resource-'));const c=new RemoteConnector({dataDir:dir});c.config={deviceId:'desk',deviceToken:'test',username:'u',deviceName:'Desk',roots:[dir]};
 t.after(()=>{c.close();fs.rmSync(dir,{recursive:true,force:true});});
 let shared=true,release,delay=false,calls=0;
 c.sessions=async()=>shared?[{instanceId:'abcdef'}]:[];
 c.session=async id=>{if(!shared||id!=='abcdef')throw Error('not shared');return {instanceId:id};};
 c.local=async(route)=>{
  if(route==='/api/plugin-conversations')return [{pluginId:'0123456789abcdef01234567',key:'assistant',resource:'assistant',label:'助手',sessionId:'abcdef'},{pluginId:'other',key:'assistant',resource:'assistant',label:'私有',sessionId:'bbbbbb'}];
  if(route==='/api/plugin-resource-catalog')return [{pluginId:'0123456789abcdef01234567',resourceId:'assistant',sessionId:'abcdef'}];
  assert.equal(route,'/api/plugin-resources/0123456789abcdef01234567/assistant?remoteSession=abcdef');calls++;
  if(delay)return new Promise(r=>release=r);return {view:{actions:[],rows:[{title:'private memory'}]}};
 };
 assert.equal((await c.execute('plugin-entries',{})).length,1);
 const args={session:'abcdef',pluginId:'0123456789abcdef01234567',resourceId:'assistant'};
 assert.equal((await c.execute('plugin-resource',args)).view.rows[0].title,'private memory');
 const action={...args,body:{action:'detail',values:{}},requestId:'resource-request-0001'};
 const write=await c.execute('plugin-resource',action);await waitFor(()=>write.state==='done');const before=calls;await c.execute('plugin-resource',action);assert.equal(calls,before);
 assert(!JSON.stringify(c.entries).includes('private memory'));assert.equal((await c.execute('plugin-resource',{...args,receipt:write.result.resourceReceipt})).view.rows[0].title,'private memory');
 await assert.rejects(c.execute('plugin-resource',{...args,pluginId:'other'}));await assert.rejects(c.execute('plugin-resource',{...args,resourceId:'../settings'}));
 delay=true;const pending=c.execute('plugin-resource',args);await waitFor(()=>release);shared=false;release({view:{rows:[{title:'secret'}],actions:[]}});await assert.rejects(pending,/not shared/);
 await assert.rejects(c.execute('plugin-resource',{...args,receipt:write.result.resourceReceipt}),/not shared/);
});
