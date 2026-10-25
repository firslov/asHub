const test = require('node:test');
const assert = require('node:assert/strict');
const { env, fs, path, Res, Bridge } = require('./harness.cjs');
const { EventEmitter } = require('node:events');
const tools = [{ type: 'function', function: { name: 'read_file' } }];
const image = (size, fill = 1) => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + Buffer.alloc(size, fill).toString('base64'), detail: 'high' } });
const reference = part => JSON.parse(part.text.match(/preserved at (".*?")\. To/s)[1]);
function fixture() { const e = env(); return { e, uploads: path.join(e.dir, 'uploads'), ...e.load('src/image-context.ts') }; }

test('historical images are bounded newest first, with lossless references and unchanged history', () => {
  const x = fixture(), older = image(300, 1), recent = image(300, 2);
  const input = { tools, messages: [
    { role: 'user', content: 'inspect' },
    { role: 'tool', tool_call_id: 'old', content: [{ type: 'text', text: 'useful caption' }, older] },
    { role: 'assistant', content: 'inspected' },
    { role: 'tool', tool_call_id: 'recent', content: [recent] },
    { role: 'assistant', content: 'inspected again' },
    { role: 'user', content: 'summarize' },
  ] };
  const before = JSON.stringify(input), out = x.imageContext(input, x.uploads, 'session-a', 450);
  assert.equal(JSON.stringify(input), before);
  assert.equal(out.messages[3].content[0], recent);
  assert.equal(out.messages[1].content[0].text, 'useful caption');
  assert.equal(out.messages[1].tool_call_id, 'old');
  const file = reference(out.messages[1].content[1]);
  assert.deepEqual(fs.readFileSync(file), Buffer.alloc(300, 1));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(x.uploads).length, 1);
  assert.equal(JSON.stringify(x.imageContext(input, x.uploads, 'session-a', 450)), JSON.stringify(out));
  assert.equal(fs.readdirSync(x.uploads).length, 1, 'repeated sends reuse the same file');
});

test('fresh input, fresh tool images and current user attachments are never removed', () => {
  const x = fixture(), img = image(500), messages = [
    { role: 'user', content: [img] }, { role: 'assistant', content: 'reading' },
    { role: 'tool', content: [img] },
  ];
  const input = { tools, messages };
  assert.equal(x.imageContext(input, x.uploads, 'a', 0), input);
  assert.equal(x.imageContext({ tools, messages: [{ role: 'user', content: [img] }] }, x.uploads, 'a', 0).messages[0].content[0], img);
  assert(!fs.existsSync(x.uploads));
});

test('unreadable images and requests without read_file retain their original input', () => {
  const x = fixture();
  for (const img of [image(5 * 1024 * 1024 + 1), { type: 'image_url', image_url: 'https://example.invalid/image.png' }, { type: 'image_url', image_url: 'data:image/png;base64,broken!' }]) {
    const input = { tools, messages: [{ role: 'tool', content: [img] }, { role: 'assistant', content: 'ok' }] };
    assert.equal(x.imageContext(input, x.uploads, 'a', 0), input);
  }
  const input = { messages: [{ role: 'tool', content: [image(50)] }, { role: 'assistant', content: 'ok' }] };
  assert.equal(x.imageContext(input, x.uploads, 'a', 0), input);
  assert.equal(x.imageContext({ ...input, tools }, x.uploads, '../escape', 0).messages, input.messages);
});

test('storage failures or corrupt cached references preserve the original image', () => {
  const x = fixture(), input = { tools, messages: [{ role: 'tool', content: [image(50)] }, { role: 'assistant', content: 'ok' }] };
  const out = x.imageContext(input, x.uploads, 'a', 0), file = reference(out.messages[0].content[0]);
  fs.writeFileSync(file, 'corrupt');
  assert.equal(x.imageContext(input, x.uploads, 'a', 0), input);
  const blocked = path.join(x.e.dir, 'not-a-directory'); fs.writeFileSync(blocked, 'x');
  assert.equal(x.imageContext(input, blocked, 'a', 0), input);
});

test('shared client guard preserves binding, streaming, cancellation, options and complete calls', async () => {
  const x = fixture(), calls = [], stream = { [Symbol.asyncIterator]: async function* () {} };
  const client = { id: 1, stream(o) { calls.push([this.id, o]); return stream; }, complete(o) { calls.push([this.id, o]); return Promise.resolve('ok'); } };
  const controller = new AbortController();
  const input = { tools, signal: controller.signal, max_tokens: 32, headers: { session_id: 'a' }, messages: [
    { role: 'tool', content: [image(2 * 1024 * 1024)] }, { role: 'assistant', content: 'ok' },
  ] };
  x.guardImageContext(client, x.uploads, 'a'); const wrapped = client.stream; x.guardImageContext(client, x.uploads, 'a');
  assert.equal(client.stream, wrapped); assert.equal(client.stream(input), stream);
  client.id = 2; assert.equal(await client.complete(input), 'ok');
  assert.equal(calls[1][0], 2); assert.equal(calls[0][1].signal, controller.signal);
  controller.abort(); assert(calls[0][1].signal.aborted);
  assert.equal(calls[0][1].max_tokens, 32); assert.equal(calls[0][1].headers, input.headers);
  assert.equal(calls[0][1].messages[0].content[0].type, 'text');
  assert.equal(input.messages[0].content[0].type, 'image_url');
});

test('the installed kernel can reread an omitted image byte-for-byte, including images over 2 MiB', async () => {
  const x = fixture(), img = image(3 * 1024 * 1024);
  const input = { tools, messages: [{ role: 'tool', content: [img] }, { role: 'assistant', content: 'ok' }] };
  const out = x.imageContext(input, x.uploads, 'a', 0), file = reference(out.messages[0].content[0]);
  const { createReadFileTool } = await import('../node_modules/agent-sh/dist/agent/tools/read-file.js');
  const tool = createReadFileTool(() => x.e.dir, new Map());
  for (let i = 0; i < 2; i++) {
    const result = await tool.execute({ path: file, offset: 1 });
    assert.equal(result.isError, false);
    assert.equal(result.content[0].data, img.image_url.url.split(',')[1]);
  }
});

test('request logs are bounded, redact arbitrary fields and tolerate storage failures', () => {
  const e = env(), { logRequest, requestErrorCode } = e.load('src/request-diagnostics.ts');
  const dir = path.join(e.dir, 'logs'), file = path.join(dir, 'requests.jsonl');
  const event = { requestId: 'r1', phase: 'error', elapsedMs: 123, requestBytes: 5, code: 'ERR_HTTP2_PROTOCOL_ERROR', body: 'SECRET', url: 'SECRET', headers: 'SECRET', message: 'SECRET' };
  logRequest(dir, 'a', 2, event);
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(row.attempt, 2); assert.equal(row.requestBytes, 5); assert(!JSON.stringify(row).includes('SECRET'));
  assert.equal(requestErrorCode(new Error('net::ERR_HTTP2_PROTOCOL_ERROR https://SECRET')), 'ERR_HTTP2_PROTOCOL_ERROR');
  assert.equal(requestErrorCode(new Error('SECRET')), 'NETWORK_ERROR');
  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024)); logRequest(dir, 'a', 1, event);
  assert(fs.existsSync(file + '.1')); assert(fs.statSync(file).size < 1024);
  fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024)); logRequest(dir, 'a', 1, event);
  assert.equal(fs.readdirSync(dir).length, 2);
  assert.doesNotThrow(() => logRequest(file, 'a', 1, event));
});

test('request monitor isolates turns, deduplicates status and ignores late old responses', () => {
  const e = env(), { RequestMonitor } = e.load('src/request-diagnostics.ts'), status = [];
  const m = new RequestMonitor(e.dir, 'a', s => status.push(s.phase));
  const event = (requestId, phase) => m.observe({ requestId, phase, elapsedMs: 1 });
  m.begin(); event('r1', 'request'); event('r1', 'error');
  assert(m.retry('(error 502, retrying in 1s — attempt 2/4)'));
  event('r2', 'request'); event('r1', 'headers'); event('r2', 'headers');
  m.output(); m.output(); event('r2', 'complete');
  assert.deepEqual(status, ['sending', 'retrying', 'sending', 'waiting', 'clear']);
  m.end(); event('r2', 'headers'); assert.equal(status.at(-1), 'clear');
  assert(!m.retry('(error 502, retrying in 1s — attempt 3/4)'));
  m.begin(); event('r3', 'request'); event('r2', 'complete'); assert.equal(status.at(-1), 'sending');
  const logs = fs.readFileSync(path.join(e.dir, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(logs.find(r => r.requestId === 'r2' && r.phase === 'request').attempt, 2);
});

test('limited diagnostics cannot carry a retry number into the next model round', () => {
  const e = env(), { RequestMonitor } = e.load('src/request-diagnostics.ts');
  const m = new RequestMonitor(e.dir, 'a', () => {});
  const event = (requestId, phase) => m.observe({ requestId, phase, elapsedMs: 1 });
  const retry = attempt => assert(m.retry(`(error 502, retrying in 1s — attempt ${attempt}/4)`));
  m.begin(); event('r1', 'request'); event('r1', 'error'); retry(2);
  event('r2', 'request'); event('r2', 'unobserved');
  event('r3', 'request'); // Tool execution finished; this is a fresh model round.
  event('r3', 'error'); retry(2); event('r4', 'request'); event('r4', 'unobserved');
  retry(3); event('r5', 'request'); // A real retry notice still takes precedence.
  event('r5', 'error'); retry(4); event('r4', 'unobserved'); event('r6', 'request');
  const logs = fs.readFileSync(path.join(e.dir, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(logs.filter(r => r.phase === 'request').map(r => r.attempt), [1, 2, 1, 2, 3, 4]);
});

test('reconnecting receives current request status even outside the replay tail; terminal and late events clear it', async () => {
  const e = env(), h = e.load('src/hub.ts', 'export const audit={createSession,routeEvent,pushFrame,openSseMulti,deleteSessionFiles};').audit;
  const sessions = new Map(), s = await h.createSession(sessions, { makeBridge: o => new Bridge(o) }, e.dir);
  s.isProcessing = true;
  h.routeEvent(s, { name: 'agent:request-status', payload: { phase: 'retrying' } });
  assert.equal(s.lastRequestStatus.phase, 'retrying');
  for (let i = 0; i < 60; i++) h.routeEvent(s, { name: 'ui:info', payload: { message: 'fixture' } });
  const res = new Res(), req = Object.assign(new EventEmitter(), { headers: {} });
  await h.openSseMulti(req, res, sessions, s.id + ':1', '');
  assert(res.body.includes('"phase":"retrying"'));
  req.emit('close');
  h.pushFrame(s, 'agent:processing-done', ''); s.isProcessing = false;
  h.routeEvent(s, { name: 'agent:request-status', payload: { phase: 'waiting' } });
  assert.equal(s.lastRequestStatus, undefined);
  const after = new Res(); await h.openSseMulti(Object.assign(new EventEmitter(), { headers: {} }), after, sessions, s.id + ':1', '');
  assert(after.body.includes('"phase":"clear"'));
  const uploads = path.join(e.dir, 'hub-sessions', 'uploads'); fs.mkdirSync(uploads, { recursive: true });
  fs.writeFileSync(path.join(uploads, s.id + '_context_fixture.png'), 'fixture');
  await h.deleteSessionFiles(s.id);
  assert.equal(fs.readdirSync(uploads).length, 0, 'deleting a session also removes image references');
});
