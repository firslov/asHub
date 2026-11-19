import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGateway } from './server.mjs';
import { RemoteConnector } from '../dist/remote/connector.js';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-remote-test-'));
process.env.NODE_ENV = 'test';
const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(r => reserve.close(r));
const url = `http://127.0.0.1:${port}/mobile/`;
const app = createGateway({ database: path.join(tmp, 'gateway.sqlite'), publicUrl: url, testing: true });
app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
let cookieA, cookieB, device, secret, received = 0, liveResponse, saved;
const project = path.join(tmp, 'project'); fs.mkdirSync(project);
const imageId='a'.repeat(64), imageBytes=Buffer.from('fixture image');
const local = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/sessions') return res.end(JSON.stringify([{ instanceId: 'abcdef', kind: 'agent', cwd: project, title: 'Test', isProcessing: false }, { instanceId: 'badbad', kind: 'agent', cwd: os.tmpdir() }, { instanceId: 'eeeeee', kind: 'terminal', cwd: project }]));
  if (req.url.startsWith(`/abcdef/image-resources/${imageId}?`)) {
    const u=new URL(req.url,'http://localhost');
    return res.end(JSON.stringify(u.searchParams.has('meta') ? {id:imageId,version:imageId,name:'image.png',mimeType:'image/png',width:1,height:1,size:imageBytes.length} : {version:imageId,size:imageBytes.length,data:imageBytes.toString('base64'),nextOffset:imageBytes.length}));
  }
  if (req.url === '/abcdef/submit') { received++; const p = JSON.parse(body); liveResponse?.write(`data: ${JSON.stringify({ meta: { name: 'agent:query', source: 'abcdef' }, payload: { query: p.query } })}\n\n`); return res.end(JSON.stringify({ ok: true })); }
  if (req.url?.startsWith('/events?')) { res.setHeader('Content-Type', 'text/event-stream'); liveResponse = res; res.write('data: {"meta":{"name":"agent:query"},"payload":{"query":"saved history"}}\n\n'); res.write('data: {"meta":{"name":"hub:replay-done"}}\n\n'); return; }
  res.writeHead(404); res.end('{}');
});
local.listen(0, '127.0.0.1'); await once(local, 'listening');
let connector = new RemoteConnector({ gateway: url, dataDir: path.join(tmp, 'local'), store: { read: () => saved, write: s => { saved = s; } } });
async function request(route, body, cookie, method = body === undefined ? 'GET' : 'POST', origin = new URL(url).origin) {
  const r = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, cookie: r.headers.get('set-cookie')?.split(';')[0], data: await r.json() };
}
const auth = (username, password = 'a very strong test password') => ({ username, password });
const rpc = (op, args = {}, cookie = cookieA) => request(`api/devices/${device}/rpc`, { op, args }, cookie);
async function waitFor(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 30)); } throw Error('timed out'); }
test('public rendering scripts load through the gateway and enable shared presentation and Chinese bold', async () => {
  const page = await fetch(url); assert.equal(page.status, 200);
  const html = await page.text();
  const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map(match => match[1]);
  const context = vm.createContext({});
  for (const script of scripts) {
    const response = await fetch(new URL(script, url));
    assert.equal(response.status, 200, script);
    assert.match(response.headers.get('content-type'), /^text\/javascript/, script);
    const content = await response.text();
    if (/\/(?:marked\.min|markdown-compat|conversation-presentation)\.js$/.test(script)) vm.runInContext(content, context);
  }
  assert.equal(context.AsHubConversationPresentation.usageMetrics({prompt_tokens: 3, completion_tokens: 2, total_tokens: 7}).total, 7);
  assert.equal(context.AsHubConversationPresentation.toolActivityKey({name: 'read_file'}), 'activity.reading');
  assert.equal(context.marked.ashubCjkStrong, true);
  assert.equal(context.marked.parse('**没有证据。**正式库'), '<p><strong>没有证据。</strong>正式库</p>\n');
});
test('every PWA precache resource is available through the gateway', async () => {
  const response = await fetch(new URL('sw.js', url)); assert.equal(response.status, 200);
  const worker = await response.text();
  const files = vm.runInNewContext(worker + '\nfiles;', { self: { addEventListener() {} } });
  assert.ok(files.includes('./plugin-resource-view.js'));
  assert.ok(files.includes('./markdown-compat.js'));
  assert.ok(files.includes('./conversation-presentation.js'));
  assert.ok(files.includes('./conversation-scrollbar.css'));
  assert.ok(files.includes('./conversation-scrollbar.js'));
  for (const file of files) {
    const response = await fetch(new URL(file, url));
    assert.equal(response.status, 200, file);
    assert.ok((await response.arrayBuffer()).byteLength > 0, file);
  }
});
test('register and store hashed credentials, login cookies', async () => {
  const a = await request('api/register', auth('alice')); assert.equal(a.status, 200); cookieA = a.cookie;
  assert.ok(a.data.recovery); const stored = app.db.prepare('SELECT password FROM users WHERE name=?').get('alice').password;
  assert.notEqual(stored, auth('alice').password); assert.ok(stored.includes(':'));
  const b = await request('api/register', auth('bravo')); cookieB = b.cookie; assert.equal(b.status, 200);
  assert.equal((await request('api/login', auth('alice', 'wrong password value'))).status, 401);
  assert.equal((await request('api/register', auth('alice'))).status, 409);
});
test('CSRF and anonymous requests rejected', async () => {
  assert.equal((await request('api/devices')).status, 401);
  assert.equal((await request('api/logout', {}, cookieA, 'POST', 'https://evil.example')).status, 403);
});
test('device enrollment and authenticated outbound connection', async () => {
  const e = await request('api/device/enroll', { ...auth('alice'), deviceName: 'Test computer' }); assert.equal(e.status, 200);
  device = e.data.deviceId; secret = e.data.deviceToken;
  saved = JSON.stringify({ deviceId: device, deviceToken: secret, username: 'alice', roots: [fs.realpathSync(project)], deviceName: 'Test computer' });
  connector.start(local.address().port); await waitFor(() => connector.status().status === 'online');
  const a = await request('api/devices', undefined, cookieA); assert.equal(a.data[0].online, true);
  assert.equal((await request('api/devices', undefined, cookieB)).data.length, 0);
});
test('image resources relay authenticated bytes without opening cross-user or cross-session access',async()=>{
 const resource=`api/devices/${device}/image-resource?session=abcdef&id=${imageId}`;
 const get=(route,cookie,method='GET')=>fetch(url+route,{method,headers:cookie?{Cookie:cookie}:{}});
 const r=await get(resource,cookieA);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(Buffer.from(await r.arrayBuffer()),imageBytes);
 for(let i=0;i<31;i++){const image=await get(resource,cookieA);assert.equal(image.status,200);await image.arrayBuffer();}
 const head=await get(resource,cookieA,'HEAD');assert.equal(head.status,200);assert.equal(await head.text(),'');
 assert.equal((await get(resource)).status,401);assert.equal((await get(resource,cookieB)).status,404);
 assert.equal((await get(resource.replace('abcdef','badbad'),cookieA)).status,403);
 assert.equal((await get(resource.replace(imageId,'../secret'),cookieA)).status,400);
});
test('cross-user read, write, delete and event stream are denied', async () => {
  assert.equal((await rpc('sessions', {}, cookieB)).status, 404);
  assert.equal((await request(`api/devices/${device}`, {}, cookieB, 'DELETE')).status, 404);
  const r = await fetch(url + `api/devices/${device}/events?session=abcdef`, { headers: { Cookie: cookieB } }); assert.equal(r.status, 404);
});
test('only authorized projects and agent sessions are visible', async () => {
  const r = await rpc('sessions'); assert.equal(r.status, 200); assert.deepEqual(r.data.map(s => s.instanceId), ['abcdef']);
  assert.equal((await rpc('submit', { session: 'badbad', query: 'hello', requestId: 'request-000000001' })).status, 403);
  assert.equal((await rpc('submit', { session: 'eeeeee', query: 'hello', requestId: 'request-000000002' })).status, 403);
});
test('raw paths, commands and cross-session images are rejected', async () => {
  assert.equal((await rpc('/api/config/apikey')).status, 403);
  assert.equal((await rpc('submit', { session: 'abcdef', query: '!cat secret', requestId: 'request-000000003' })).status, 403);
  assert.equal((await rpc('image', { session: 'abcdef', id: 'badbad_img_123_abc' })).status, 403);
  assert.equal((await rpc('create', { project: 999, requestId: 'request-000000004' })).status, 403);
});
test('persistent idempotency: repeated send executes once, different payload conflicts', async () => {
  const args = { session: 'abcdef', query: 'hello 🟡', requestId: 'request-000000005' };
  const results = await Promise.all([rpc('submit', args), rpc('submit', args)]); assert.ok(results.every(r => r.status === 200));
  await waitFor(() => received === 1);
  assert.equal((await rpc('submit', { ...args, query: 'different' })).status, 409);
  await waitFor(async () => (await rpc('request-status', { requestId: args.requestId })).data.state === 'done');
  assert.ok(fs.readFileSync(path.join(tmp, 'local/remote-requests.json'), 'utf8').includes(args.requestId));
});
test('restart retains completed IDs and marks interrupted sends unknown', async () => {
  connector.close();
  const journal = path.join(tmp, 'local/remote-requests.json');
  const records = JSON.parse(fs.readFileSync(journal, 'utf8'));
  records[device + ':interrupted-00001'] = { digest: 'test', state: 'pending' };
  fs.writeFileSync(journal, JSON.stringify(records));
  connector = new RemoteConnector({ gateway: url, dataDir: path.join(tmp, 'local'), store: { read: () => saved, write: s => { saved = s; } } });
  connector.start(local.address().port); await waitFor(() => connector.status().status === 'online');
  assert.equal((await rpc('request-status', { requestId: 'interrupted-00001' })).data.state, 'unknown');
  assert.equal((await rpc('submit', { session: 'abcdef', query: 'hello 🟡', requestId: 'request-000000005' })).data.state, 'done');
  assert.equal(received, 1);
});
test('SSE replays local history; logout closes active stream', async () => {
  const ctl = new AbortController();
  const r = await fetch(url + `api/devices/${device}/events?session=abcdef`, { headers: { Cookie: cookieA }, signal: ctl.signal }); assert.equal(r.status, 200);
  const reader = r.body.getReader(); let text = '';
  while (!text.includes('saved history')) text += new TextDecoder().decode((await reader.read()).value);
  assert.ok(text.includes('event: reset'));
  assert.equal((await request('api/logout', {}, cookieA)).status, 200);
  let done = false; for (let i = 0; i < 5 && !done; i++) done = (await reader.read()).done; assert.ok(done); ctl.abort();
  cookieA = (await request('api/login', auth('alice'))).cookie;
});
test('device revocation disconnects connector and removes access', async () => {
  assert.equal((await request(`api/devices/${device}`, {}, cookieA, 'DELETE')).status, 200);
  await waitFor(() => connector.status().status === 'revoked');
  assert.equal((await rpc('sessions')).status, 404);
});
test('recovery rotates recovery code and revokes logins', async () => {
  const r = await request('api/register', auth('recover-user'));
  const reset = await request('api/recover', { ...auth('recover-user', 'new very strong password'), recovery: r.data.recovery }); assert.equal(reset.status, 200);
  assert.notEqual(reset.data.recovery, r.data.recovery);
  assert.equal((await request('api/me', undefined, r.cookie)).status, 401);
  assert.equal((await request('api/login', auth('recover-user'))).status, 401);
  assert.equal((await request('api/login', auth('recover-user', 'new very strong password'))).status, 200);
});
test('production entry starts through the release symlink', async () => {
  const linked = path.join(tmp, 'current.mjs'); fs.symlinkSync(fileURLToPath(new URL('./server.mjs', import.meta.url)), linked);
  const child = spawn(process.execPath, [linked], { env: { ...process.env, PORT: '0', ASHUB_REMOTE_DB: path.join(tmp, 'entry.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.resume();
  try { await waitFor(() => output.includes('asHub remote gateway ready')); }
  finally { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } }
});
test.after(async () => { connector.close(); liveResponse?.end(); local.closeAllConnections(); await new Promise(r => local.close(r)); await app.close(); fs.rmSync(tmp, { recursive: true, force: true }); });


test('preview assets are available with module and WASM MIME types within their vendor boundary',async()=>{
 for(const [file,type] of [['file-preview.js','text/javascript'],['file-preview-renderers.js','text/javascript'],['file-preview.css','text/css'],['pdfjs/pdf.min.mjs','text/javascript'],['pdfjs/pdf.worker.min.mjs','text/javascript'],['pdfjs/wasm/openjpeg.wasm','application/wasm'],['pdfjs/wasm/openjpeg_nowasm_fallback.js','text/javascript'],['pdfjs/wasm/jbig2_nowasm_fallback.js','text/javascript'],['pdfjs/wasm/quickjs-eval.js','text/javascript']]) {
  const response=await fetch(new URL(file,url));assert.equal(response.status,200,file);assert.match(response.headers.get('content-type'),new RegExp(type));await response.arrayBuffer();
 }
 for(const file of ['pdfjs/server.mjs','pdfjs/../server.mjs','pdfjs/%2e%2e%2fserver.mjs'])assert.equal((await fetch(new URL(file,url))).status,404,file);
});


test('formula and ordinary image assets preserve their restricted static boundary',async()=>{
 for(const [file,type] of [['math.js','text/javascript'],['artifact-images.js','text/javascript'],['katex/katex.min.js','text/javascript'],['katex/katex.min.css','text/css'],['katex/fonts/KaTeX_Main-Regular.woff2','font/woff2']]) {
  const r=await fetch(new URL(file,url));assert.equal(r.status,200,file);assert(r.headers.get('content-type').startsWith(type));await r.arrayBuffer();
 }
 for(const file of ['katex/server.mjs','katex/fonts/../../server.mjs','katex/fonts/%2e%2e%2fserver.mjs'])assert.equal((await fetch(new URL(file,url))).status,404,file);
 const desktop=new URL('../web/js/',import.meta.url);
 const idle=fs.readFileSync(new URL('stream/idle-work.js',desktop),'utf8').replaceAll('export function ','function ');
 const math=fs.readFileSync(new URL('math.js',desktop),'utf8').replace('import { scheduleIdleWork } from "./stream/idle-work.js";\n','').replaceAll('export const ','const ');
 const generated=fs.readFileSync(new URL('./public/math.js',import.meta.url),'utf8');
 assert(generated.includes(idle+'\n'+math),'remote parser stays identical to desktop');
});
