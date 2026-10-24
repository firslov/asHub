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
    for (const op of ['cancel', 'permission', 'model', 'thinking', 'set-thinking', 'image']) {
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
  assert.deepEqual(await connector.execute('project-groups', {}), [{ id: 'project', name: 'Mixed project', sessionIds: ['aaaaaa', 'bbbbbb'] }]);
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
