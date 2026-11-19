import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createGateway } from './server.mjs';
import { RemoteConnector } from '../dist/remote/connector.js';
process.env.NODE_ENV = 'test';
async function waitFor(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw Error('timed out'); }
async function gatewayFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-rebind-'));
  const app = createGateway({database:path.join(dir,'db.sqlite'),publicUrl:'http://127.0.0.1/mobile/',testing:true});
  app.server.listen(0,'127.0.0.1'); await once(app.server,'listening');
  t.after(async () => { await app.close(); fs.rmSync(dir,{recursive:true,force:true}); });
  const request = async (route, body) => {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/mobile/api/${route}`, {method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1'},body:JSON.stringify(body)});
    return {status:res.status,data:await res.json()};
  };
  return {app, request};
}
test('re-enrollment proves identity, preserves device slots, and respects revocation', async t => {
  const {app,request} = await gatewayFixture(t);
  const auth = {username:'rebind-alice',password:'a safe test password',deviceName:'Same name'};
  const first = await request('device/enroll',{...auth,create:true}); assert.equal(first.status,200);
  const identity = {deviceId:first.data.deviceId,deviceToken:first.data.deviceToken};
  const user = app.db.prepare('SELECT id FROM users WHERE name=?').get(auth.username).id;
  for (let n=0;n<3;n++) {
    const next = await request('device/enroll',{...auth,...identity,deviceName:'Updated '+n});
    assert.equal(next.status,200); assert.equal(next.data.deviceId,identity.deviceId); assert.equal(next.data.deviceToken,identity.deviceToken);
  }
  assert.equal(app.db.prepare('SELECT count(*) n FROM devices WHERE user=?').get(user).n,1);
  assert.equal(app.db.prepare('SELECT name FROM devices WHERE id=?').get(identity.deviceId).name,'Updated 2');
  assert.equal((await request('device/enroll',{...auth,...identity,deviceToken:'wrong'})).status,403);
  assert.equal((await request('device/enroll',{...auth,...identity,password:'incorrect password'})).status,401);
  assert.equal((await request('register',{username:'rebind-bravo',password:auth.password})).status,200);
  assert.equal((await request('device/enroll',{...auth,...identity,username:'rebind-bravo'})).status,403);
  const other = await request('device/enroll',auth); assert.equal(other.status,200); assert.notEqual(other.data.deviceId,identity.deviceId);
  // Fill remaining slots as fixture data, without bypassing or exhausting auth rate limits.
  for (let i=2;i<10;i++) app.db.prepare('INSERT INTO devices(id,user,name,token) VALUES(?,?,?,?)').run('fixture-'+i,user,'Other computer','fixture-token-'+i);
  assert.equal((await request('device/enroll',{...auth,...identity})).status,200, 'updating a device at capacity succeeds');
  assert.equal((await request('device/enroll',auth)).status,409, 'a distinct eleventh device is still rejected');
  app.db.prepare('DELETE FROM devices WHERE id=?').run(identity.deviceId);
  const renewed = await request('device/enroll',{...auth,...identity}); assert.equal(renewed.status,200);
  assert.notEqual(renewed.data.deviceId,identity.deviceId); assert.notEqual(renewed.data.deviceToken,identity.deviceToken);
  assert.equal(app.db.prepare('SELECT count(*) n FROM devices WHERE user=?').get(user).n,10);
});
test('password recovery permits a fresh binding but never revives the revoked credential', async t => {
  const {app,request} = await gatewayFixture(t);
  const auth = {username:'recover-device',password:'original safe password'};
  const first = await request('device/enroll',{...auth,create:true});
  const identity = {deviceId:first.data.deviceId,deviceToken:first.data.deviceToken};
  const next = {...auth,password:'replacement safe password'};
  assert.equal((await request('recover',{...next,recovery:first.data.recovery})).status,200);
  assert.equal((await request('device/enroll',{...auth,...identity})).status,401);
  const rebound = await request('device/enroll',{...next,...identity}); assert.equal(rebound.status,200);
  assert.notEqual(rebound.data.deviceId,identity.deviceId);
  assert.equal(app.db.prepare('SELECT count(*) n FROM devices WHERE id=?').get(identity.deviceId).n,0);
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

test('web device revocation invalidates a request still awaiting local authorization', async t => {
  const { app, request } = await gatewayFixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-revoked-request-'));
  const auth = { username: 'revoked-request', password: 'a safe testing password' };
  const enrolled = await request('device/enroll', { ...auth, create: true });
  const config = { ...enrolled.data, roots: [fs.realpathSync(dir)], deviceName: 'Test' };
  const base = `http://127.0.0.1:${app.server.address().port}/mobile/`;
  const connector = new RemoteConnector({ gateway: base, dataDir: dir, store: { read: () => JSON.stringify(config), write() {} } });
  t.after(() => { connector.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  connector.start(1); await waitFor(() => connector.status().status === 'online');
  let release; const effects = [];
  connector.local = async route => {
    if (route === '/sessions') return new Promise(resolve => { release = resolve; });
    effects.push(route); return { ok: true };
  };
  const pending = connector.execute('permission', { session: 'abcdef', requestId: 'pending-approval', outcome: 'approved' });
  const rejected = assert.rejects(pending, e => e.status === 403);
  const login = await fetch(base + 'api/login', { method: 'POST', headers: { Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' }, body: JSON.stringify(auth) });
  assert.equal(login.status, 200);
  const removed = await fetch(base + 'api/devices/' + config.deviceId, { method: 'DELETE', headers: { Origin: 'http://127.0.0.1', Cookie: login.headers.get('set-cookie').split(';')[0] } });
  assert.equal(removed.status, 200);
  await waitFor(() => connector.status().status === 'revoked');
  release([{ instanceId: 'abcdef', kind: 'agent', cwd: dir }]);
  await rejected; assert.deepEqual(effects, []);
});

test('local enrollment preserves UTF-8 across HTTP chunks and enforces a byte limit', async t => {
  const { app } = await gatewayFixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-unicode-body-'));
  const project = path.join(dir, '项目目录'); fs.mkdirSync(project);
  let saved;
  const connector = new RemoteConnector({ gateway: `http://127.0.0.1:${app.server.address().port}/mobile/`, dataDir: dir, store: { read: () => saved, write: value => { saved = value; } } });
  t.after(() => { connector.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const body = { username: 'unicode-body', password: 'test password 中文字符', create: true, deviceName: '设计电脑 🟡', roots: [project] };
  const bytes = Buffer.from(JSON.stringify(body));
  const offsets = [0, ...['中', '设', '🟡', '项'].map(s => bytes.indexOf(Buffer.from(s)) + 1).sort((a, b) => a - b), bytes.length];
  async function handle(chunks) {
    const req = Object.assign(Readable.from(chunks), { method: 'POST', url: '/api/mobile/connect', headers: { 'x-ashub-local': '1' } });
    let status, value;
    await connector.handle(req, { writeHead(code) { status = code; }, end(data) { value = JSON.parse(data); } });
    return { status, value };
  }
  const result = await handle(offsets.slice(1).map((end, i) => bytes.subarray(offsets[i], end)));
  assert.equal(result.status, 200, JSON.stringify(result.value));
  assert.equal(JSON.parse(saved).deviceName, body.deviceName);
  assert.deepEqual(JSON.parse(saved).roots, [fs.realpathSync(project)]);
  const user = await fetch(`http://127.0.0.1:${app.server.address().port}/mobile/api/login`, { method: 'POST', headers: { Origin: 'http://127.0.0.1', 'Content-Type': 'application/json' }, body: JSON.stringify({ username: body.username, password: body.password }) });
  assert.equal(user.status, 200, 'registration must preserve the exact password');
  const oversized = Buffer.from(JSON.stringify({ ...body, create: false, note: '中'.repeat(6000) }));
  assert.ok(oversized.length > 16384);
  assert.equal((await handle([oversized])).status, 413);
});

async function loginRaceFixture(t) {
  const {app, request} = await gatewayFixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-login-race-'));
  const auth = {username:'login-race', password:'a safe login test password'};
  const enrolled = await request('device/enroll', {...auth,create:true});
  const config = {...enrolled.data, roots:[fs.realpathSync(dir)], deviceName:'Test'};
  const base = `http://127.0.0.1:${app.server.address().port}/mobile/`;
  const connector = new RemoteConnector({gateway:base,dataDir:dir,store:{read:()=>JSON.stringify(config),write(){}}});
  t.after(()=>{connector.close();fs.rmSync(dir,{recursive:true,force:true});});
  connector.start(1); await waitFor(()=>connector.status().status==='online');
  const headers = {'Content-Type':'application/json',Origin:'http://127.0.0.1'};
  const login = async () => {
    const res = await fetch(base+'api/login',{method:'POST',headers,body:JSON.stringify(auth)});
    assert.equal(res.status,200); await res.arrayBuffer();
    return res.headers.get('set-cookie').split(';')[0];
  };
  const cookie = await login();
  return {app,connector,base,headers,cookie,login,route:`api/devices/${config.deviceId}/rpc`};
}
test('logout during a slow request body prevents a later desktop operation', async t => {
  const f = await loginRaceFixture(t); let operations = 0;
  f.connector.execute = async () => {operations++;return {ok:true};};
  const body = JSON.stringify({op:'cancel',args:{session:'abcdef'}});
  const accepted = once(f.app.server,'request');
  const req = http.request(f.base+f.route,{method:'POST',headers:{...f.headers,Cookie:f.cookie,'Content-Length':Buffer.byteLength(body)}});
  t.after(()=>req.destroy());
  const response = once(req,'response'); req.write(body.slice(0,10)); await accepted;
  const loggedOut = await fetch(f.base+'api/logout',{method:'POST',headers:{...f.headers,Cookie:f.cookie},body:'{}'});
  assert.equal(loggedOut.status,200); await loggedOut.arrayBuffer();
  req.end(body.slice(10)); const [res] = await response;
  let output=''; for await(const part of res) output+=part;
  assert.equal(res.statusCode,401,output); assert.equal(operations,0);
});
test('revoked browser login cannot receive a delayed project task result', async t => {
  const f = await loginRaceFixture(t); let release;
  f.connector.execute = async () => new Promise(resolve=>{release=resolve;});
  const pending = fetch(f.base+f.route,{method:'POST',headers:{...f.headers,Cookie:f.cookie},body:JSON.stringify({op:'project-tasks',args:{projectId:'p'}})});
  await waitFor(()=>typeof release==='function');
  const newer = await f.login();
  const revoked = await fetch(f.base+'api/logout-others',{method:'POST',headers:{...f.headers,Cookie:newer},body:'{}'});
  assert.equal(revoked.status,200); await revoked.arrayBuffer();
  release({text:'private task content'});
  const res = await pending; const output = await res.text();
  assert.equal(res.status,401,output); assert.ok(!output.includes('private task content'));
});
