process.env.ASHUB_TEST_ROOT ||= require('path').resolve(__dirname,'..');
const {env,Bridge,assert,fs,path,root}=require('./harness.cjs');const http=require('http');const {once}=require('events');
(async()=>{
 const e=env();e.context.setTimeout=setTimeout;e.context.clearTimeout=clearTimeout;e.context.setInterval=setInterval;e.context.clearInterval=clearInterval;
 let release,started,b,closed=0;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 fs.writeFileSync(path.join(e.dir,'settings.json'),JSON.stringify({providers:{test:{apiKey:'FAKE-LOCAL-TEST-KEY'}}}));
 const app=e.hub().startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:o=>{b=new Bridge(o);b.ready=async()=>{started();await gate};b.close=()=>closed++;return b}});await once(app.server,'listening');const port=app.server.address().port;
 const request=(method,url,headers={},body='')=>new Promise((resolve,reject)=>{const q=http.request({hostname:'127.0.0.1',port,path:url,method,headers},r=>{let data='';r.on('data',c=>data+=c);r.on('end',()=>resolve({status:r.statusCode,body:data}))});q.on('error',reject);q.end(body)});
 const host='untrusted.example:'+port;const hostile=await request('GET','/api/config/apikey?provider=test',{Host:host,Origin:'http://'+host});assert(hostile.status===400&&!hostile.body.includes('FAKE-LOCAL-TEST-KEY'),'foreign Host accepted');
 const foreign=await request('GET','/sessions',{Host:'localhost:'+port,Origin:'http://untrusted.example'});assert(foreign.status===403,'control request not rejected');
 const spawning=request('POST','/sessions',{'Content-Type':'application/json'},JSON.stringify({cwd:e.dir}));await ready;await app.shutdown();const closedAtShutdown=closed;release();const result=await spawning;assert(result.status>=400&&closedAtShutdown===1&&closed===1,'in-flight spawn escaped shutdown');
 const data={hostCheck:{untrustedHostStatus:hostile.status,fakeKeyReturned:false,foreignOriginStatus:foreign.status},shutdownCheck:{spawnCompletedAfterShutdown:result.status,bridgeCloseCalls:closed}};
 console.log('PASS real HTTP shutdown during pending creation',JSON.stringify(data));
 // Drain the just-created fake session and cancel remaining persistence timers.
 app.server.closeAllConnections?.();for(let i=0;i<2;i++)await new Promise(r=>setTimeout(r,50));
})().then(()=>process.exit(0),e=>{console.error(e);process.exit(1)});
