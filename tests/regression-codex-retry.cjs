const test = require('node:test');
const assert = require('node:assert/strict');
const { env } = require('./harness.cjs');
const failure = (status = 502, retryable = true, details = {}, message = 'temporary failure') =>
  Object.assign(new Error(message), { type: 'codex_proxy_error', error: { status, retryable, ...details } });
const deadline = () => failure(504, false, {partial:false}, 'Codex upstream timed out waiting for response headers after 900s');
const collect = async stream => { const result=[]; for await (const chunk of await stream) result.push(chunk); return result; };
function setup(stream, config={}, wait) {
  const waits=[], notices=[];
  const e=env({modules:{'node:timers/promises':{setTimeout:async(ms, value, options)=>{
    waits.push(ms); if(wait) await wait(options); options.signal?.throwIfAborted();
  }}}});
  e.settings.getSettings=()=>({'codex-provider':config});
  const {guardCodexRetries,registerCodexEndpoint}=e.load('src/providers/codex-retry.ts');
  const client={stream}; guardCodexRetries(client, message=>notices.push(message));
  guardCodexRetries(client, ()=>assert.fail('double wrapping'));
  return {client, waits, notices, registerCodexEndpoint};
}
test('Codex retries four times, then succeeds without duplicate chunks', async()=>{
  let calls=0;
  const x=setup(async function*(){assert.equal(this,x.client);if(++calls<5)throw failure();yield 'done';});
  assert.deepEqual(await collect(x.client.stream({})),['done']);
  assert.equal(calls,5);assert.deepEqual(x.waits,[2000,4000,8000,16000]);
  assert.match(x.notices.at(-1),/attempt 5\/5/);
});
test('exhaustion suppresses outer kernel and subagent retries',async()=>{
  let calls=0;
  const x=setup(async()=>{calls++;throw failure();});
  await assert.rejects(collect(x.client.stream({})),e=>e.error.retryable===false&&e.error.status===502);
  assert.equal(calls,5);
});
test('a local header deadline retries once; a second deadline ends the request',async()=>{
  let calls=0;
  const x=setup(async function*(){calls++;throw deadline();});
  await assert.rejects(collect(x.client.stream({})),e=>e.error.retryable===false);
  assert.equal(calls,2);assert.deepEqual(x.waits,[5000]);
});
test('header timeout budget is shared with the overall retry budget',async()=>{
  let calls=0;
  const x=setup(async()=>{calls++;throw calls===2?deadline():failure();},{maxRetries:2});
  await assert.rejects(collect(x.client.stream({})));assert.equal(calls,3);
});
for(const [label,error] of [
  ['authentication',failure(401,false)],
  ['invalid request',failure(400,false)],
  ['idle deadline',failure(504,false,{partial:false},'Codex upstream timed out waiting for stream data after 1800s')],
  ['credential deadline',failure(504,false,{partial:false},'Codex upstream timed out waiting for credentials after 120s')],
  ['partial output',failure(502,true,{partial:true})],
  ['timeout without explicit partial flag',failure(504,false,{},'Codex upstream timed out waiting for response headers after 900s')],
]) test(`${label} does not retry`,async()=>{
  let calls=0;const x=setup(async()=>{calls++;throw error;});
  await assert.rejects(collect(x.client.stream({})),e=>e.error.retryable===false);assert.equal(calls,1);
});
for (const chunk of [{choices:[{delta:{content:'hello'}}]},{choices:[{delta:{reasoning_content:'thinking'}}]},{choices:[{delta:{tool_calls:[{id:'one'}]}}]}]) {
  test('an emitted text/reasoning/tool chunk prevents replay even with retryable error',async()=>{
    let calls=0; const x=setup(async function*(){calls++;yield chunk;throw failure();});
    const stream=await x.client.stream({});assert.deepEqual((await stream.next()).value,chunk);
    await assert.rejects(stream.next(),e=>!e.error.retryable);assert.equal(calls,1);
  });
}
test('other providers keep the original error for the kernel retry policy',async()=>{
  const error=Object.assign(new Error('fetch failed'),{status:502});let calls=0;
  const x=setup(async()=>{calls++;throw error;});
  await assert.rejects(collect(x.client.stream({})),e=>e===error);assert.equal(calls,1);
});
test('explicit zero disables retries; invalid budgets fall back to bounded defaults',async()=>{
  for(const [config, expected] of [[{maxRetries:0},1],[{headersTimeoutRetries:0},1],[{maxRetries:Infinity},2]]) {
    let calls=0;const x=setup(async()=>{calls++;throw deadline();},config);
    await assert.rejects(collect(x.client.stream({})));assert.equal(calls,expected);
  }
});
test('Retry-After seconds and dates are honored',async()=>{
  for (const [value,expected] of [['8',8000],['Thu, 01 Jan 1970 00:01:45 GMT',5000],['Infinity',2000]]) {
    let calls=0;const x=setup(async function*(){if(++calls===1)throw failure(429,true,{retry_after:value});yield 'ok';});
    await collect(x.client.stream({}));assert.deepEqual(x.waits,[expected]);
  }
});
for(const stage of ['before request','during backoff']) test(`cancellation ${stage} stops retries`,async()=>{
  let calls=0;const c=new AbortController();
  const x=setup(async()=>{calls++;throw failure();},{},()=>c.abort());
  if(stage==='before request')c.abort();
  await assert.rejects(collect(x.client.stream({signal:c.signal})),/abort/i);
  assert.equal(calls,stage==='before request'?0:1);
});
test('consumer stop closes the underlying stream without retrying',async()=>{
  let closed=0;const x=setup(async function*(){try {yield 'one';yield 'two';} finally {closed++;}});
  const stream=await x.client.stream({});await stream.next();await stream.return();
  assert.equal(closed,1);assert.equal(x.waits.length,0);
});
for (const partial of [false,true]) test(`raw Codex loopback failure is terminal (partial=${partial})`,async()=>{
  let calls=0;
  const error=new Error('fetch failed: loopback disconnected');
  const x=setup(async function*(){calls++;if(partial)yield 'already visible';throw error;});
  x.client.config={baseURL:'http://127.0.0.1:12345/v1'};
  const release=x.registerCodexEndpoint(x.client.config.baseURL);
  try {
    await assert.rejects(collect(x.client.stream({})),e=>e.type==='codex_proxy_error'
      && e.error.status===502 && e.error.retryable===false && e.error.partial===partial && e.cause===error);
    assert.equal(calls,1);assert.equal(x.waits.length,0);
  } finally {release();}
});
test('raw failure after a structured Codex retry cannot restart the outer budget',async()=>{
  let calls=0;const x=setup(async()=>{if(++calls===1)throw failure();throw new Error('fetch failed');});
  await assert.rejects(collect(x.client.stream({})),e=>e.type==='codex_proxy_error'&&!e.error.retryable);
  assert.equal(calls,2);assert.equal(x.waits.length,1);
});
test('endpoint recognition is scoped to each request and cleanup is idempotent',async()=>{
  const error=new Error('fetch failed');const x=setup(async()=>{throw error;});
  x.client.config={baseURL:'http://127.0.0.1:12345/v1'};
  const first=x.registerCodexEndpoint(x.client.config.baseURL);
  const second=x.registerCodexEndpoint(x.client.config.baseURL);
  first();first();
  const inFlight=x.client.stream({});
  second();
  await assert.rejects(collect(inFlight),e=>e.type==='codex_proxy_error'&&!e.error.retryable);
  await assert.rejects(collect(x.client.stream({})),e=>e===error,'released addresses must not affect other providers');
  x.registerCodexEndpoint(undefined)();
});
test('switching to another endpoint does not retain Codex error handling',async()=>{
  const error=new Error('fetch failed');const x=setup(async()=>{throw error;});
  const release=x.registerCodexEndpoint('http://127.0.0.1:12345/v1');
  try {
    x.client.config={baseURL:'https://other-provider.invalid/v1'};
    await assert.rejects(collect(x.client.stream({})),e=>e===error);
  } finally {release();}
});
for (const key of ['baseURL','apiKey','model']) test(`changing ${key} during backoff does not send the old request with new settings`,async()=>{
  let calls=0;
  const x=setup(async function*(){if(++calls===1)throw failure();yield 'wrong request';}, {},
    ()=>{x.client.config={...x.client.config,[key]:'changed'};});
  x.client.config={baseURL:'http://127.0.0.1:12345/v1',apiKey:'fixture',model:'original'};
  const release=x.registerCodexEndpoint(x.client.config.baseURL);
  try {
    await assert.rejects(collect(x.client.stream({model:'original'})),e=>e.type==='codex_proxy_error'&&!e.error.retryable);
    assert.equal(calls,1);
  } finally {release();}
});
test('refreshing an equivalent configuration does not interrupt retries',async()=>{
  let calls=0;
  const x=setup(async function*(){if(++calls===1)throw failure();yield 'ok';},{},
    ()=>{x.client.config={...x.client.config};});
  x.client.config={baseURL:'http://127.0.0.1:12345/v1',apiKey:'fixture',model:'original'};
  const release=x.registerCodexEndpoint(x.client.config.baseURL);
  try {assert.deepEqual(await collect(x.client.stream({model:'original'})),['ok']);assert.equal(calls,2);}
  finally {release();}
});
