const { env, Bridge, assert, path, root, fs } = require('../tests/harness.cjs');
const { once } = require('node:events');
(async () => {
  const { createGateway } = await import('./server.mjs');
  const e = env({ globals: { fetch, WebSocket, setTimeout, clearTimeout, setInterval, clearInterval,Response,ReadableStream } });
  const gateway = createGateway({ database: path.join(e.dir, 'gateway.sqlite'), publicUrl: 'http://127.0.0.1/mobile/', testing: true });
  gateway.server.listen(0, '127.0.0.1'); await once(gateway.server, 'listening');
  const remote = `http://127.0.0.1:${gateway.server.address().port}/mobile/`;
  e.context.process.env.NODE_ENV = 'test'; e.context.process.env.ASHUB_REMOTE_URL = remote; e.context.process.env.ASHUB_TOKEN = 'test-local-token';
  let saved, received = 0, bridge, decision;
  class TestBridge extends Bridge {
    constructor(opts) { super(opts); bridge = this; this.level = 'high'; }
    getThinking() { return {model:'deepseek-v4-flash',provider:'deepseek',level:this.level,levels:['off','low','high','max'],supported:true}; }
    setThinking(level) { this.level = level; this.emit('event', {name:'agent:info',payload:{thinkingLevel:level}}); }
    decidePermission(requestId, outcome, sessionWide) { decision = { requestId, outcome, sessionWide }; }
    async submit(value) {
      received++;
      this.emit('event', { name: 'agent:response-chunk', payload: { blocks: [{ type: 'text', text: 'Hello from the desktop 🟡' }] } });
      this.emit('event', { name: 'agent:response-done', payload: { response: 'Hello from the desktop 🟡' } });
      return { stopReason: 'done' };
    }
  }
  const body = { username: 'hub-integration', password: 'hub integration password', create: true, roots: [e.dir], deviceName: 'Integration' };
  const enrolled=await (await fetch(remote+'api/device/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
  saved=JSON.stringify({...enrolled,roots:body.roots.map(r=>fs.realpathSync(r)),deviceName:body.deviceName});const vault=new Map();
  const hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: o => new TestBridge(o), pluginSecretStore:{read:k=>vault.get(k)||null,write:(k,v)=>vault.set(k,v)}, remoteSecretStore: { read: () => saved, write: value => { saved = value; } } });
  await once(hub.server, 'listening'); const local = `http://127.0.0.1:${hub.server.address().port}`;
  const headers = { Authorization: 'Bearer test-local-token', 'X-Ashub-Local': '1', 'Content-Type': 'application/json' };
  async function call(route, body, cookie) {
    const res = await fetch(remote + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert(res.ok, `${route}: ${res.status}`); return { data: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  async function wait(fn) { for (let i = 0; i < 100; i++) { const r = await fn(); if (r) return r; await new Promise(r => setTimeout(r, 30)); } throw Error('timed out'); }
  let reader;
  try {
    assert((await fetch(local + '/api/mobile')).status === 401, 'mobile setup requires local authentication');
    assert((await fetch(local + '/api/mobile', { headers: { Authorization: headers.Authorization } })).status === 403, 'mobile setup requires custom header');
    const resource=await require('./interconnect-fixture.cjs')(local,headers,wait);
    assert((await fetch(local+'/api/mobile/connect',{method:'POST',headers,body:'{}'})).status===410,'old route cannot bypass scope confirmation');
    await wait(async () => (await (await fetch(local + '/api/mobile', { headers })).json()).status === 'online');
    const { cookie } = await call('api/login', { username: body.username, password: body.password });
    const device = (await call('api/devices', undefined, cookie)).data[0].id;
    const rpc = async (op, args = {}) => (await call(`api/devices/${device}/rpc`, { op, args }, cookie)).data;
    await rpc('create', { project: (await rpc('projects'))[0].id, requestId: 'create-hub-00000001' });
    const created = await wait(async () => { const r = await rpc('request-status', { requestId: 'create-hub-00000001' }); return r.state === 'done' && r.result; });
    const sid = created.instanceId; assert(sid, 'real Hub create shape');
    assert((await rpc('sessions')).some(s => s.instanceId === sid), 'shared session missing');
    assert((await rpc('capabilities')).artifacts, 'new connector capabilities');
    assert((await rpc('capabilities')).thinking, 'native thinking capability advertised');
    assert((await rpc('thinking', {session:sid})).levels.join(',') === 'off,low,high,max', 'native levels pass through gateway');
    const changed = await rpc('set-thinking', {session:sid,model:'deepseek-v4-flash',provider:'deepseek',level:'max'});
    assert(changed.level === 'max' && bridge.level === 'max', 'remote selection reaches real Hub route');
    for (const [args,status] of [
      [{model:'old-model',provider:'deepseek',level:'high'},409],
      [{model:'deepseek-v4-flash',provider:'deepseek',level:'medium'},400],
      [{level:'high'},400],
      [{session:'ffffff',model:'deepseek-v4-flash',provider:'deepseek',level:'high'},403]
    ]) {
      const r = await fetch(remote + `api/devices/${device}/rpc`, {method:'POST',headers:{Origin:'http://127.0.0.1',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({op:'set-thinking',args:{session:sid,...args}})});
      assert(r.status === status, 'invalid or unauthorized thinking selection rejected: '+r.status);
      assert(bridge.level === 'max', 'rejected selection cannot change the desktop');
    }
    const sessionCapabilities=await rpc('capabilities');
    const sessionControls=!!(sessionCapabilities.sessionNetwork && sessionCapabilities.sessionDelete);
    if (sessionControls) {
    const initialNetwork=await rpc('session-network',{session:sid});assert(initialNetwork.enabled===null,'initial proxy follows global');
    for(const enabled of [false,true,null]) {
      const network=await rpc('set-session-network',{session:sid,enabled});
      const localPolicy=await (await fetch(local+'/api/settings/network',{headers})).json();
      assert(network.enabled===enabled && network.effective===(enabled??localPolicy.proxyEnabled),'remote VPN returns effective state');
      assert((localPolicy.sessions[sid]??null)===enabled,'remote VPN reaches real Hub');
      assert(!('sessions' in network),'other session network settings stay private');
    }
    for(const [op,args] of [['session-network',{session:'ffffff'}],['set-session-network',{session:'ffffff',enabled:false}],['session-delete',{session:'ffffff',confirm:true,requestId:'unauthorized-delete-01'}]]) {
      const denied=await fetch(remote+`api/devices/${device}/rpc`,{method:'POST',headers:{Origin:'http://127.0.0.1',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({op,args})});
      assert(denied.status===403,'session controls cannot access unshared sessions');
    }
    } else {
      for (const op of ['session-network','set-session-network','session-delete']) {
        const unsupported=await fetch(remote+`api/devices/${device}/rpc`,{method:'POST',headers:{Origin:'http://127.0.0.1',Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({op,args:{session:sid,enabled:false,confirm:true,requestId:'legacy-delete-000001'}})});
        assert(unsupported.status===403,'older desktop rejects unsupported '+op);
      }
    }
    const grouped = await fetch(local + '/api/projects', { method: 'POST', headers, body: JSON.stringify({ action: 'create', cwd: e.dir, name: 'Remote project', add: [sid] }) });
    assert(grouped.ok, 'create local project');
    const groups = await rpc('project-groups'); assert(groups.length === 1 && groups[0].sessionIds.includes(sid), 'remote project membership');
    assert((await rpc('project-tasks', {projectId: groups[0].id})).length === 0, 'empty project tasks');
    const filename = '成果 #1 🟡.zip', bytes = Buffer.alloc(7 * 1024 * 1024 + 19, 153);
    fs.writeFileSync(path.join(e.dir, filename), bytes);
    const download = new URL(`api/devices/${device}/artifact`, remote); download.searchParams.set('session',sid);download.searchParams.set('path',filename);
    const head = await fetch(download,{method:'HEAD',headers:{Cookie:cookie}});
    assert(head.ok && Number(head.headers.get('content-length')) === bytes.length, 'remote file metadata');
    assert(head.headers.get('content-disposition').includes(encodeURIComponent(filename)), 'Unicode attachment filename');
    const file = await fetch(download,{headers:{Cookie:cookie}});
    assert(file.ok && Buffer.from(await file.arrayBuffer()).equals(bytes), 'file larger than one relay frame streams intact');
    assert(file.headers.get('content-security-policy') === 'sandbox', 'download cannot execute on app origin');
    assert((await fetch(download)).status === 401, 'download requires login');
    const other = await call('api/register', {username:'other-account', password:'another test password'});
    assert((await fetch(download,{headers:{Cookie:other.cookie}})).status === 404, 'other accounts cannot download device files');
    download.searchParams.set('path','../outside');assert((await fetch(download,{headers:{Cookie:cookie}})).status===403,'remote traversal denied');
    fs.writeFileSync(path.join(e.dir,'empty'),'');download.searchParams.set('path','empty');
    assert((await (await fetch(download,{headers:{Cookie:cookie}})).arrayBuffer()).byteLength===0,'empty file completes');
    const stream = await fetch(remote + `api/devices/${device}/events?session=${sid}`, { headers: { Cookie: cookie } }); reader = stream.body.getReader();
    let frames = '', timedOut = false; const timer = setTimeout(() => { timedOut = true; reader.cancel(); }, 8000);
    while (!frames.includes('hub:replay-done')) { const next = await reader.read(); if (next.done) break; frames += new TextDecoder().decode(next.value); }
    assert(!timedOut, 'initial real Hub replay');
    await rpc('submit', { session: sid, query: 'Review this image', images: [{ mimeType: 'image/png', data: 'aW1hZ2U=' }], requestId: 'submit-hub-00000001' });
    while (!frames.includes('Hello from the desktop')) { const next = await reader.read(); if (next.done) break; frames += new TextDecoder().decode(next.value); }
    clearTimeout(timer); assert(!timedOut && frames.includes('Review this image'), 'real Hub query and stream');
    assert(received === 1, 'exactly one model invocation');
    const imageId = frames.match(/"id":"([a-f0-9]+_img_[a-z0-9_]+)"/)?.[1]; assert(imageId, 'image persisted into real Hub replay');
    const image = await rpc('image', { session: sid, id: imageId }); assert(image.data === 'aW1hZ2U=', 'image round trip');
    await reader.cancel();
    const largeQuery = '助手长消息：' + '内容🌐'.repeat(22000);
    await rpc('submit', { session: sid, query: largeQuery, requestId: 'submit-hub-large-replay' });
    await wait(async () => (await rpc('request-status', { requestId: 'submit-hub-large-replay' })).state === 'done');
    const replay = await fetch(remote + `api/devices/${device}/events?session=${sid}&history=recent`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(8000) });
    assert(replay.ok && replay.body, 'reopen the conversation over the gateway');
    reader = replay.body.getReader();
    const decoder = new TextDecoder();
    let history = '';
    while (!history.includes('hub:replay-done')) {
      const next = await reader.read();
      if (next.done) break;
      history += decoder.decode(next.value, { stream: true });
    }
    assert(history.includes('hub:replay-done'), 'remote replay must reach the completion event');
    assert(history.includes(largeQuery), 'remote replay must preserve the complete long Unicode message');
    bridge.emit('event', { name: 'permission:request', payload: { requestId: 'permission-live', expiresAt: Date.now() + 30000, title: 'Test approval' } });
    await rpc('permission', { session: sid, requestId: 'permission-live', outcome: 'approved', sessionWide: true });
    assert(decision.outcome === 'approved' && decision.sessionWide === false, 'remote approval cannot grant session-wide permission');
    const duplicate = await fetch(remote + `api/devices/${device}/rpc`, { method: 'POST', headers: { Origin: 'http://127.0.0.1', Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'permission', args: { session: sid, requestId: 'permission-live', outcome: 'approved' } }) });
    assert(duplicate.status === 409, 'resolved approval cannot be reused');
    for (const scope of ['site', 'daily7', 'acp']) {
      const requestId = 'grant-' + scope;
      bridge.emit('event', {name:'permission:request', payload:{requestId, ...(scope==='acp'?{requiresDesktop:true}:{scope}), expiresAt:Date.now()+30000}});
      const args = {session:sid, requestId, outcome:'approved', scope:'once', onceOnly:false};
      const rejected = await fetch(remote + `api/devices/${device}/rpc`, {method:'POST',
        headers:{Origin:'http://127.0.0.1', Cookie:cookie, 'Content-Type':'application/json'},
        body:JSON.stringify({op:'permission',args})});
      assert(rejected.status === 403, 'mobile cannot approve a persistent ' + scope + ' grant');
      if (scope === 'site') {
        const approved = await fetch(local + '/api/permission/decide', {method:'POST',headers,
          body:JSON.stringify({sessionId:sid,requestId,outcome:'approved'})});
        assert(approved.ok && decision.outcome === 'approved', 'desktop can approve the pending site grant');
      } else {
        await rpc('permission', {...args,outcome:'denied'});
        assert(decision.outcome === 'denied','mobile can decline the pending grant');
      }
    }
    await resource('disable-sharing'); assert([...vault.values()].some(v=>v&&JSON.parse(v).enabled===false),'local disable persists disabled identity');
    await wait(async () => !(await call('api/devices', undefined, cookie)).data[0].online);
    const rebind = async (name, roots = body.roots) => {
      await resource('configure-sharing',{...body,create:false,deviceName:name,roots:roots.join('\n')}); await wait(async () => (await (await fetch(local + '/api/mobile',{headers})).json()).status === 'online');
      const list = (await call('api/devices',undefined,cookie)).data;
      assert(list.length === 1 && list[0].id === device && list[0].name === name, 'rebind reuses device identity and updates name');
    };
    await rebind('Re-enabled');
    const narrow = path.join(e.dir, 'narrow'); fs.mkdirSync(narrow);
    await rebind('Narrowed', [narrow]); assert((await rpc('sessions')).length === 0, 'updated roots take effect');
    assert((await fetch(download,{headers:{Cookie:cookie}})).status===403,'removed sharing blocks downloads');
    assert((await rpc('project-groups')).length===0,'removed sharing hides project groups');
    await rebind('Updated'); assert((await rpc('sessions')).some(s => s.instanceId === sid), 'restored roots share original sessions');
    if (sessionControls) {
    const deleteArgs={session:sid,confirm:true,requestId:'delete-integration-0001'};
    await rpc('session-delete',deleteArgs);
    await wait(async()=>{const status=await rpc('request-status',{requestId:deleteArgs.requestId});return status.state==='done'&&status.result?.ok});
    assert(!(await rpc('sessions')).some(s=>s.instanceId===sid),'deleted session removed from desktop/remote list');
    assert(!(await rpc('project-groups')).some(p=>p.sessionIds.includes(sid)),'deleted project member is no longer shared');
    assert((await rpc('session-delete',deleteArgs)).state==='done','lost deletion reply remains retryable after removal');
    assert(fs.existsSync(path.join(e.dir,filename)),'deletion preserves work directory files');
    }
    console.log('Session controls: '+(sessionControls?'new desktop verified':'released desktop fallback verified'));
    console.log('PASS actual Hub: local authentication, bind, create, shared projects, bounded file downloads and account isolation, streaming, image round trip, one-time approvals, disconnect, re-enable, stable identity, per-session VPN, confirmed/idempotent deletion');
  } finally { await reader?.cancel(); await hub.shutdown(); await gateway.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
