import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createGateway } from './server.mjs';
import { DevicePublisher } from '../examples/extensions/multi-machine/publisher.mjs';

process.env.NODE_ENV = 'test';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ashub-stream-lease-'));
  const gateway = createGateway({ database:join(dir,'remote.sqlite'), publicUrl:'http://127.0.0.1/mobile/', testing:true });
  gateway.server.listen(0,'127.0.0.1');
  await once(gateway.server,'listening');
  const base = 'http://127.0.0.1:' + gateway.server.address().port + '/mobile/';
  const controllers = new Set(), publishers = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    for (const publisher of publishers) publisher.stopConnection();
    await gateway.close();
    await rm(dir, {recursive:true,force:true});
  });
  const credentials = {username:'stream-fixture', password:'stream-fixture-passphrase'};
  const call = (route, method='GET', cookie, body, signal) => fetch(base+route, {
    method, headers:{Origin:'http://127.0.0.1', 'Content-Type':'application/json', ...(cookie?{Cookie:cookie}:{})},
    body:body === undefined ? undefined : JSON.stringify(body), signal,
  });
  const enrollment = await call('api/device/enroll','POST',undefined,{...credentials,create:true,deviceName:'Fixture'});
  assert.equal(enrollment.status,200);
  const identity = await enrollment.json();
  const login = async () => {
    const response = await call('api/login','POST',undefined,credentials);
    assert.equal(response.status,200);
    await response.json();
    return response.headers.get('set-cookie').split(';')[0];
  };
  const cookie = await login();
  const route = 'api/devices/' + identity.deviceId;
  const events = (viewer, attempt = 1, session = 'aaaa') => route + '/events?' + new URLSearchParams({
    session, ...(viewer ? {viewer, attempt} : {}),
  });
  const open = async (viewer, attempt, session) => {
    const controller = new AbortController(); controllers.add(controller);
    const response = await call(events(viewer,attempt,session),'GET',cookie,undefined,controller.signal);
    return {response,reader:response.body.getReader(),controller};
  };
  const publish = () => {
    const publisher = new DevicePublisher({gateway:base,dataDir:dir,store:{read:()=>JSON.stringify(identity),write(){}}});
    publishers.push(publisher); publisher.start(7878);
    return publisher;
  };
  return {base, identity, route, events, call, login, cookie, open, publish};
}

async function waitFor(check) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await pause(25);
  }
  throw Error('State did not settle');
}

test('expired and replaced subscriptions free an account slot before opening a new stream', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(f.base.replace('http:', 'ws:') + 'connect');
  t.after(() => ws.terminate());
  await once(ws,'open');
  const ready = once(ws,'message');
  ws.send(JSON.stringify({type:'hello',protocol:1,deviceId:f.identity.deviceId,token:f.identity.deviceToken}));
  assert.equal(JSON.parse((await ready)[0]).type,'ready');
  const start = Date.now();
  t.mock.timers.enable({apis:['Date'],now:start});
  const viewers = Array.from({length:8},()=>randomUUID());
  const opened = await Promise.all(viewers.map(id=>f.open(id)));
  const decode = value => new TextDecoder().decode(value);
  for (const {response,reader} of opened) {
    assert.equal(response.status,200);
    assert.match(decode((await reader.read()).value),/event: reset/);
  }
  const legacy = await f.call(f.events(),'GET',f.cookie);
  assert.equal(legacy.status,429);
  await legacy.json();
  const limited = await f.open(randomUUID());
  assert.match(decode((await limited.reader.read()).value),/hub:stream-limit/);
  assert.equal((await limited.reader.read()).done,true);

  const renewedViewer = viewers[0];
  const replacement = await f.open(renewedViewer,2,'bbbb');
  assert.match(decode((await replacement.reader.read()).value),/event: reset/);
  assert.equal((await opened[0].reader.read()).done,true);
  const stale = await f.call(f.events(renewedViewer,1),'GET',f.cookie);
  assert.equal(stale.status,409);
  await stale.json();
  const renew = async (attempt, session, cookie = f.cookie) => {
    const response = await f.call(f.events(renewedViewer,attempt,session),'POST',cookie);
    await response.json();
    return response.status;
  };
  assert.equal(await renew(1,'aaaa'),404);
  assert.equal(await renew(2,'bbbb',await f.login()),404);
  t.mock.timers.setTime(start + 45_000);
  assert.equal(await renew(2,'bbbb'),200);
  t.mock.timers.setTime(start + 61_000);
  const recovered = await f.open(randomUUID());
  assert.match(decode((await recovered.reader.read()).value),/event: reset/);
  for (const {reader} of opened.slice(1)) assert.equal((await reader.read()).done,true);
  assert.equal(await renew(2,'bbbb'),200);

  const legacyOpen = await f.open();
  assert.match(decode((await legacyOpen.reader.read()).value),/event: reset/);
  t.mock.timers.setTime(start + 362_000);
  const next = await f.open(randomUUID());
  assert.match(decode((await next.reader.read()).value),/event: reset/);
  assert.equal((await legacyOpen.reader.read()).done,true);
});

test('replacement waits for the active device to leave; revocation stops reconnecting', async t => {
  const f = await fixture(t);
  const first = f.publish();
  await waitFor(()=>first.status().status==='online');
  const second = f.publish();
  await waitFor(()=>second.status().status==='online' && first.status().status==='replaced');
  assert.equal(first.status().enabled,true);
  assert.equal(first.stopped,false);
  await waitFor(()=>first.attempts >= 2);
  assert.equal(second.status().status,'online','resumption must not evict the active socket');
  second.stopConnection();
  await waitFor(()=>first.status().status==='online');
  const revoked = await f.call(f.route,'DELETE',f.cookie);
  assert.equal(revoked.status,200);
  await revoked.json();
  await waitFor(()=>first.status().status==='revoked');
  assert.equal(first.stopped,true);
});
