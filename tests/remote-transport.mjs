import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { RemoteConnector } from '../dist/remote/connector.js';
import { remoteTransport } from '../dist/remote/transport.js';
import { createPolicyFetch, withNetworkSession } from '../dist/network-policy.js';

const listen = async server => { server.listen(0,'127.0.0.1'); await once(server,'listening'); return server.address().port; };
const wait = async fn => { for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('Timed out'); };

test('remote enrollment and reconnect bypass proxy while model VPN policy remains intact', async t => {
  const previousEnv=process.env.NODE_ENV;process.env.NODE_ENV='test';
  t.after(()=>{if(previousEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousEnv;});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-remote-direct-'));
  const sockets=new Set(), tunnels=[];let enrollment=0, upgrades=0, saved, proxyBroken=false, latestSocket;const hellos=[];
  const watch=socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});};
  const origin=http.createServer(async(req,res)=>{
    if(req.url==='/mobile/api/device/enroll'){
      let body='';for await(const chunk of req)body+=chunk;
      assert.equal(JSON.parse(body).username,'fixture');enrollment++;
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({protocol:1,deviceId:'desktop',deviceToken:'fixture-token',username:'fixture'}));
    }else if(req.url==='/mobile/redirect'){res.writeHead(302,{Location:'/model'});res.end();}
    else res.end('model response');
  });
  origin.on('connection',watch);
  origin.on('upgrade',(req,socket)=>{
    upgrades++;latestSocket=socket;assert.equal(req.url,'/mobile/connect');
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
    let pending=Buffer.alloc(0);
    socket.on('data',data=>{
      pending=Buffer.concat([pending,data]);
      while(pending.length>=2){
        const opcode=pending[0]&15,masked=!!(pending[1]&128);let length=pending[1]&127,offset=2;
        if(length===126){if(pending.length<4)return;length=pending.readUInt16BE(2);offset=4;}
        assert.notEqual(length,127,'fixture frames are small');assert(masked);
        if(pending.length<offset+4+length)return;
        const mask=pending.subarray(offset,offset+4),body=Buffer.from(pending.subarray(offset+4,offset+4+length));
        pending=pending.subarray(offset+4+length);for(let i=0;i<body.length;i++)body[i]^=mask[i%4];
        if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}
        if(opcode===1){
          const hello=JSON.parse(body.toString());hellos.push(hello);
          assert.deepEqual(hello,{type:'hello',protocol:1,deviceId:'desktop',token:'fixture-token'});
          const ready=Buffer.from(JSON.stringify({type:'ready',protocol:1}));socket.write(Buffer.concat([Buffer.from([0x81,ready.length]),ready]));
        }
      }
    });
  });
  const port=await listen(origin),proxy=http.createServer();
  proxy.on('connection',watch);
  proxy.on('connect',(req,client,head)=>{
    tunnels.push(req.url);
    if(proxyBroken){client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');return;}
    const upstream=net.connect(port,'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream).pipe(client);});watch(upstream);
  });
  const proxyPort=await listen(proxy),dispatcher=new ProxyAgent(`http://127.0.0.1:${proxyPort}`),previous=getGlobalDispatcher();
  const nativeFetch=globalThis.fetch, policy={proxyEnabled:true,sessions:{aaaa:false,bbbb:true}};
  const snapshot=JSON.stringify(policy);let desktopFetchCalls=0;
  const policyFetch=createPolicyFetch(nativeFetch,nativeFetch,()=>policy);
  t.mock.method(globalThis,'fetch',(...args)=>{desktopFetchCalls++;return policyFetch(...args);});
  setGlobalDispatcher(dispatcher);
  let restored;
  const connector=new RemoteConnector({gateway:`http://127.0.0.1:${port}/mobile/`,dataDir:dir,store:{read:()=>saved,write:v=>saved=v}});
  t.after(async()=>{connector.close();restored?.close();await connector.drain();await restored?.drain();setGlobalDispatcher(previous);await dispatcher.destroy();for(const s of sockets)s.destroy();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>origin.close(r))]);fs.rmSync(dir,{recursive:true,force:true});});
  connector.start(port);
  const bind=async()=>{
    const req=Object.assign(Readable.from([JSON.stringify({username:'fixture',password:'fixture-password',roots:[dir]})]),{method:'POST',url:'/api/mobile/connect',headers:{'x-ashub-local':'1'}});
    let code;await connector.handle(req,{writeHead:n=>code=n,end(){}});assert.equal(code,200);await wait(()=>connector.status().status==='online');
  };
  await bind();assert.equal(enrollment,1);assert.equal(upgrades,1);assert.equal(desktopFetchCalls,0);assert.deepEqual(tunnels,[]);
  assert.equal(getGlobalDispatcher(),dispatcher);
  assert.equal(await withNetworkSession('bbbb',async()=> (await fetch('http://model.invalid/model')).text()),'model response');
  assert.deepEqual(tunnels,['model.invalid:80']);
  assert.equal(await withNetworkSession('aaaa',async()=> (await fetch(`http://127.0.0.1:${port}/model`)).text()),'model response');
  assert.equal(tunnels.length,1);assert.equal(JSON.stringify(policy),snapshot);
  proxyBroken=true;
  // A broken VPN must not prevent binding or starting a fresh persistent socket.
  await bind();assert.equal(enrollment,2);assert.equal(upgrades,2);
  connector.close();await connector.drain();connector.start(port);await wait(()=>connector.status().status==='online');
  assert.equal(upgrades,3);assert.equal(tunnels.length,1);assert.equal(desktopFetchCalls,2);
  // A real dropped TCP connection must abort old subscriptions and reconnect
  // without a new enrollment, even when the model proxy remains broken.
  const abandoned=new AbortController();connector.streams.set('old-stream',abandoned);
  const previousSocket=connector.socket;latestSocket.destroy();
  await wait(()=>connector.socket!==previousSocket&&connector.status().status==='online');
  assert(abandoned.signal.aborted);assert.equal(connector.streams.size,0);
  assert.equal(upgrades,4);assert.equal(enrollment,2);assert.equal(tunnels.length,1);
  // Recreate the connector rather than reusing its in-memory config: this is
  // the startup path that must restore the encrypted store's saved identity.
  connector.close();await connector.drain();
  restored=new RemoteConnector({gateway:`http://127.0.0.1:${port}/mobile/`,dataDir:dir,store:{read:()=>saved,write:v=>saved=v}});
  restored.start(port);await wait(()=>restored.status().status==='online');
  assert.equal(upgrades,5);assert.equal(hellos.length,5);assert.equal(enrollment,2);assert.equal(tunnels.length,1);
  restored.start(port);assert.equal(upgrades,5,'duplicate startup does not create another socket');
  proxyBroken=false;
  assert.equal(await withNetworkSession('bbbb',async()=> (await fetch('http://model-after.invalid/model')).text()),'model response');
  assert.deepEqual(tunnels,['model.invalid:80','model-after.invalid:80']);

  await assert.rejects(remoteTransport.fetch(new URL(`http://127.0.0.1:${port}/mobile/redirect`),{redirect:'error'}));
  const abort=new AbortController();abort.abort();await assert.rejects(remoteTransport.fetch(new URL(`http://127.0.0.1:${port}/model`),{signal:abort.signal}));
  assert.equal(getGlobalDispatcher(),dispatcher);assert.equal(JSON.stringify(policy),snapshot);
});
