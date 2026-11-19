import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createManagedVoice, loadManagedVoice, VOICE_REQUEST_LIMIT } from './managed-voice.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const derive = promisify(scrypt);
const fail = (status, message) => Object.assign(new Error(message), { status });
const LIMIT = 6 * 1024 * 1024;
export function createGateway({ database, publicUrl, publicDir = path.join(here, 'public'), testing = false, voiceConfig, voiceFetch }) {
  const base = new URL(publicUrl), prefix = base.pathname.replace(/\/$/, '');
  if (!testing && base.protocol !== 'https:') throw Error('HTTPS public URL required');
  fs.mkdirSync(path.dirname(database), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(database);
  fs.chmodSync(database, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, password TEXT NOT NULL, recovery TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS logins (token TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, token TEXT UNIQUE NOT NULL, seen INTEGER NOT NULL DEFAULT 0);`);
  let managedVoice;
  try { managedVoice = createManagedVoice(db, voiceConfig, voiceFetch); }
  catch { console.error('Unable to enable asHub voice transcription'); }
  const devices = new Map(), pending = new Map(), streams = new Map(), rates = new Map(), downloads = new Map();
  let hashing = 0;
  function rate(key, max, duration) {
    const now = Date.now(); let r = rates.get(key);
    if (!r || now > r.until) { r = { count: 0, until: now + duration }; rates.set(key, r); }
    if (++r.count > max || rates.size > 20000) throw fail(429, '请求过于频繁，请稍后重试');
  }
  async function password(value, saved) {
    if (hashing >= 3) throw fail(429, '服务繁忙，请稍后重试');
    hashing++;
    try {
      const salt = saved?.split(':')[0] || randomBytes(16).toString('hex');
      const bytes = await derive(value, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      if (saved) return timingSafeEqual(bytes, Buffer.from(saved.split(':')[1], 'hex'));
      return `${salt}:${bytes.toString('hex')}`;
    } finally { hashing--; }
  }
  function credentials(body) {
    const name = String(body.username || '').trim().toLowerCase(), pass = body.password;
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(name) || typeof pass !== 'string' || pass.length < 12 || pass.length > 128)
      throw fail(400, '用户名需为 3–32 位字母、数字或 ._-；密码需为 12–128 位');
    return { name, pass };
  }
  async function authenticate(body, create = false) {
    const { name, pass } = credentials(body);
    rate(`account:${name}`, 12, 15 * 60_000);
    let user = db.prepare('SELECT * FROM users WHERE name=?').get(name);
    if (create) {
      if (user) throw fail(409, '该用户名不可用');
      const recovery = token(), encoded = await password(pass);
      user = { id: token(), name, password: encoded, recovery: hash(recovery) };
      try { db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(user.id, name, encoded, user.recovery); }
      catch { throw fail(409, '该用户名不可用'); }
      return { user, recovery };
    }
    const valid = await password(pass, user?.password || `00000000000000000000000000000000:${'0'.repeat(64)}`);
    if (!user || !valid || db.prepare('SELECT password FROM users WHERE id=?').get(user.id)?.password !== user.password) throw fail(401, '用户名或密码错误');
    return { user };
  }
  function login(req) {
    const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('ash_mobile='))?.slice(11);
    const row = raw && db.prepare('SELECT l.*, u.name FROM logins l JOIN users u ON u.id=l.user WHERE l.token=? AND l.expires>?').get(hash(raw), Date.now());
    if (!row) throw fail(401, '请重新登录');
    return row;
  }
  function owns(user, id) {
    const d = db.prepare('SELECT id, name, seen FROM devices WHERE id=? AND user=?').get(id, user);
    if (!d) throw fail(404, '设备不存在');
    return d;
  }
  function send(ws, data) {
    if (ws.readyState !== 1 || ws.bufferedAmount > 2 * LIMIT) { ws.terminate(); throw fail(503, '设备连接中断'); }
    ws.send(JSON.stringify(data));
  }
  function closeStream(id) {
    const s = streams.get(id); if (!s) return;
    streams.delete(id); clearInterval(s.timer); s.res.end();
    try { send(s.ws, { type: 'unsubscribe', id }); } catch {}
  }
  function offline(ws) {
    if (devices.get(ws.device)?.ws === ws) devices.delete(ws.device);
    for (const [id, p] of pending) if (p.ws === ws) { clearTimeout(p.timer); pending.delete(id); p.reject(fail(503, '电脑离线，请重新连接后查看发送状态')); }
    for (const [id, s] of streams) if (s.ws === ws) closeStream(id);
  }
  function revokeDevice(id) {
    const ws = devices.get(id)?.ws;
    if (ws) { ws.close(4001, 'revoked'); offline(ws); }
  }
  async function rpc(device, op, args) {
    const ws = devices.get(device)?.ws;
    if (!ws || ws.readyState !== 1) throw fail(503, '电脑离线');
    if ([...pending.values()].filter(p => p.ws === ws).length >= 16) throw fail(429, '设备繁忙');
    const id = token();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(fail(504, '请求超时，请检查电脑连接')); }, 25000);
      pending.set(id, { ws, resolve, reject, timer });
      try { send(ws, { type: 'request', id, op, args }); } catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
    });
  }
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
  async function read(req, limit = LIMIT) {
    let size = 0, chunks = [];
    for await (const c of req) { size += c.length; if (size > limit) throw fail(413, '内容过大'); chunks.push(c); }
    try { const data = JSON.parse(Buffer.concat(chunks).toString() || '{}'); if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error(); return data; }
    catch { throw fail(400, '请求格式错误'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const u = new URL(req.url, base.origin), pathname = u.pathname;
      if (!pathname.startsWith(prefix + '/')) throw fail(404, 'Not found');
      const route = pathname.slice(prefix.length), method = req.method;
      // Only the loopback reverse proxy supplies a single authoritative real IP.
      const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
      rate(`ip:${ip}`, 600, 60000);
      if (req.headers.origin && req.headers.origin !== base.origin) throw fail(403, '来源不受信任');
      if (route === '/voice/transcribe' && method === 'POST') {
        if (!managedVoice) throw fail(503, 'asHub 免费转写暂不可用');
        if (req.headers['content-type'] !== 'application/json') throw fail(415, '需要 JSON 录音请求');
        if (Number(req.headers['content-length']) > VOICE_REQUEST_LIMIT) throw fail(413, '录音请求过大');
        rate(`voice:${ip}`, 10, 60_000);
        const disconnect = new AbortController();
        const abort = () => disconnect.abort();
        res.once('close', abort);
        try {
          const input = await read(req, VOICE_REQUEST_LIMIT);
          const result = await managedVoice(input, ip, disconnect.signal);
          if (!res.destroyed) json(res, 200, result);
          return;
        } finally { res.off('close', abort); }
      }
      if (method !== 'GET' && method !== 'HEAD' && route !== '/api/device/enroll' && req.headers.origin !== base.origin) throw fail(403, '需要同源请求');
      if (route === '/health' && method === 'GET') return json(res, 200, { ok: true });
      if (['/api/login', '/api/register', '/api/device/enroll', '/api/recover'].includes(route) && method === 'POST') {
        rate(`auth:${ip}`, 20, 15 * 60000);
        const b = await read(req);
        if (route === '/api/recover') {
          const { name, pass } = credentials(b);
          const user = db.prepare('SELECT * FROM users WHERE name=? AND recovery=?').get(name, hash(String(b.recovery || '')));
          if (!user) throw fail(401, '账号或恢复码无效');
          const recovery = token(), encoded = await password(pass);
          const updated = db.prepare('UPDATE users SET password=?, recovery=? WHERE id=? AND recovery=?').run(encoded, hash(recovery), user.id, hash(String(b.recovery || '')));
          if (updated.changes !== 1) throw fail(401, '恢复码已使用');
          db.prepare('DELETE FROM logins WHERE user=?').run(user.id);
          for (const d of db.prepare('SELECT id FROM devices WHERE user=?').all(user.id)) revokeDevice(d.id);
          db.prepare('DELETE FROM devices WHERE user=?').run(user.id);
          return json(res, 200, { recovery });
        }
        const { user, recovery } = await authenticate(b, route === '/api/register' || (route === '/api/device/enroll' && b.create === true));
        if (route === '/api/device/enroll') {
          // Password authentication alone does not prove which installation is being updated.
          // Require its existing credential; equal display names are never deduplicated.
          if (b.deviceId !== undefined || b.deviceToken !== undefined) {
            if (typeof b.deviceId !== 'string' || typeof b.deviceToken !== 'string') throw fail(400, '设备凭证无效');
            const old = db.prepare('SELECT * FROM devices WHERE id=?').get(b.deviceId);
            if (old) {
              if (old.user !== user.id || old.token !== hash(b.deviceToken)) throw fail(403, '设备凭证无效');
              db.prepare('UPDATE devices SET name=? WHERE id=?').run(String(b.deviceName || '我的电脑').slice(0, 80), old.id);
              return json(res, 200, { deviceId: old.id, deviceToken: b.deviceToken, username: user.name, protocol: 1 });
            }
            // Revocation/recovery removed the old row. A fresh password-authenticated
            // enrollment gets a new identity; the revoked token remains unusable.
          }
          if (db.prepare('SELECT count(*) AS n FROM devices WHERE user=?').get(user.id).n >= 10) throw fail(409, '最多绑定 10 台设备，请先移除旧设备');
          const id = token(), secret = token(), name = String(b.deviceName || '我的电脑').slice(0, 80);
          db.prepare('INSERT INTO devices(id,user,name,token) VALUES (?,?,?,?)').run(id, user.id, name, hash(secret));
          return json(res, 200, { deviceId: id, deviceToken: secret, username: user.name, recovery, protocol: 1 });
        }
        const secret = token();
        db.prepare('INSERT INTO logins VALUES (?,?,?)').run(hash(secret), user.id, Date.now() + 7 * 86400000);
        res.setHeader('Set-Cookie', `ash_mobile=${secret}; Path=${prefix || '/'}; HttpOnly; SameSite=Strict; Max-Age=604800${testing ? '' : '; Secure'}`);
        return json(res, 200, { username: user.name, recovery });
      }
      if (route.startsWith('/api/')) {
        const l = login(req);
        if (route === '/api/me' && method === 'GET') return json(res, 200, { username: l.name });
        if (route === '/api/logout' && method === 'POST') {
          db.prepare('DELETE FROM logins WHERE token=?').run(l.token);
          for (const [id, s] of streams) if (s.login === l.token) closeStream(id);
          res.setHeader('Set-Cookie', `ash_mobile=; Path=${prefix || '/'}; HttpOnly; SameSite=Strict; Max-Age=0${testing ? '' : '; Secure'}`);
          return json(res, 200, { ok: true });
        }
        if (route === '/api/logout-others' && method === 'POST') {
          db.prepare('DELETE FROM logins WHERE user=? AND token<>?').run(l.user, l.token);
          for (const [id, s] of streams) if (s.user === l.user && s.login !== l.token) closeStream(id);
          return json(res, 200, { ok: true });
        }
        if (route === '/api/devices' && method === 'GET') return json(res, 200,
          db.prepare('SELECT id,name,seen FROM devices WHERE user=? ORDER BY name').all(l.user).map(d => ({ ...d, online: devices.has(d.id) })));
        const match = route.match(/^\/api\/devices\/([A-Za-z0-9_-]{43})(?:\/(rpc|events|artifact|image-resource))?$/);
        if (!match) throw fail(404, 'Not found');
        const id = match[1]; owns(l.user, id);
        if (!match[2] && method === 'DELETE') { db.prepare('DELETE FROM devices WHERE id=?').run(id); revokeDevice(id); return json(res, 200, { ok: true }); }
        if (match[2] === 'rpc' && method === 'POST') {
          const b = await read(req);
          // Reading the body can outlive logout, expiry, or device revocation.
          login(req); owns(l.user, id);
          const allowed = ['composer-input', 'plugin-entries', 'plugin-resource', 'capabilities', 'project-groups', 'project-tasks', 'sessions', 'projects', 'create', 'models', 'model', 'thinking', 'set-thinking', 'session-network', 'set-session-network', 'session-delete', 'queue', 'queue-withdraw', 'queue-update', 'submit', 'request-status', 'cancel', 'permission', 'image'];
          if (!allowed.includes(b.op)) throw fail(403, '该操作不支持远程调用');
          rate(`device:${id}:${b.op}`, b.op === 'submit' || b.op === 'create' ? 30 : 300, 60000);
          const result = await rpc(id, b.op, b.args || {});
          // Do not disclose a late result to a browser whose access was revoked.
          login(req); owns(l.user, id);
          return json(res, 200, result);
        }
        if (['artifact','image-resource'].includes(match[2]) && (method === 'GET' || method === 'HEAD')) {
          const image = match[2] === 'image-resource', op = image ? 'image-resource' : 'artifact';
          const session = u.searchParams.get('session'), requested = u.searchParams.get(image ? 'id' : 'path');
          if (image && !/^[a-f0-9]{64}$/.test(requested || '')) throw fail(400,'图片参数无效');
          if (!/^[0-9a-f]{4,32}$/.test(session || '') || !requested || requested.length > 8192) throw fail(400, '文件参数无效');
          rate(`${image ? 'image' : 'download'}:${l.user}`, image ? 120 : 30, 60000);
          if ((downloads.get(l.user) || 0) >= 3) throw fail(429, '请等待当前下载完成');
          downloads.set(l.user, (downloads.get(l.user) || 0) + 1);
          const authorized = () => { login(req); owns(l.user, id); if (res.destroyed) throw fail(499, '下载已取消'); };
          try {
            const args = { session, ...(image ? {id:requested} : {path:requested}), ...(u.searchParams.has('version') ? { version: u.searchParams.get('version') } : {}) };
            const meta = await rpc(id, op, args); authorized();
            if (!Number.isSafeInteger(meta?.size) || meta.size < 0 || typeof meta.name !== 'string' || typeof meta.version !== 'string') throw fail(502, '文件信息无效');
            if (image && (!['image/png','image/jpeg','image/webp'].includes(meta.mimeType) || meta.size > 8388608 || meta.size < 1 || meta.version !== requested)) throw fail(502,'图片信息无效');
            const name = encodeURIComponent(meta.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
            res.writeHead(200, { 'Content-Type': image ? meta.mimeType : 'application/octet-stream', 'Content-Length': meta.size, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
              'X-Artifact-Version': meta.version,
              'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${name}`, 'Content-Security-Policy': 'sandbox', 'X-Accel-Buffering': 'no' });
            if (method === 'HEAD') { res.end(); return; }
            for (let offset = 0; offset < meta.size;) {
              authorized();
              const chunk = await rpc(id, op, { ...args, version: meta.version, offset }); authorized();
              if (typeof chunk?.data !== 'string' || chunk.data.length > 350000 || chunk.version !== meta.version || chunk.size !== meta.size) throw fail(502, '文件传输中断');
              const bytes = Buffer.from(chunk.data, 'base64');
              if (!bytes.length || bytes.length > 256 * 1024 || chunk.nextOffset !== offset + bytes.length || chunk.nextOffset > meta.size) throw fail(502, '文件传输中断');
              offset = chunk.nextOffset;
              if (!res.write(bytes)) await new Promise((resolve, reject) => {
                const cleanup = () => { res.off('drain', drained); res.off('close', closed); res.off('error', closed); };
                const drained = () => { cleanup(); resolve(); };
                const closed = () => { cleanup(); reject(fail(499, '下载已取消')); };
                res.once('drain', drained); res.once('close', closed); res.once('error', closed);
                if (res.destroyed) closed();
              });
            }
            res.end(); return;
          } catch (e) { if (res.headersSent) { res.destroy(); return; } throw e; }
          finally { const n = (downloads.get(l.user) || 1) - 1; if (n) downloads.set(l.user, n); else downloads.delete(l.user); }
        }
        if (match[2] === 'events' && method === 'GET') {
          const session = u.searchParams.get('session');
          if (!/^[0-9a-f]{4,32}$/.test(session || '')) throw fail(400, '会话无效');
          const ws = devices.get(id)?.ws;
          if (!ws) throw fail(503, '电脑离线');
          if ([...streams.values()].filter(s => s.user === l.user).length >= 8) throw fail(429, '打开的对话过多');
          const sid = token();
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
          res.write('event: reset\ndata: {}\n\n');
          const timer = setInterval(() => {
            if (l.expires <= Date.now() || !db.prepare('SELECT 1 FROM logins WHERE token=?').get(l.token)) { closeStream(sid); return; }
            res.write(': heartbeat\n\n');
          }, 15000);
          streams.set(sid, { ws, res, timer, login: l.token, user: l.user });
          res.on('close', () => closeStream(sid));
          send(ws, { type: 'subscribe', id: sid, session, history: u.searchParams.get('history') === 'recent' ? 'recent' : 'all' }); return;
        }
        throw fail(405, 'Method not allowed');
      }
      if (method !== 'GET') throw fail(405, 'Method not allowed');
      const name = route === '/' ? 'index.html' : route.slice(1);
      const files = { 'composer-pcm.js':'text/javascript','composer-pcm-worklet.js':'text/javascript','composer-media.js':'text/javascript','composer-media.css':'text/css', 'plugin-resource-view.js':'text/javascript', 'math.js':'text/javascript', 'artifact-images.js':'text/javascript', 'image-resources.js':'text/javascript', 'image-resources.css':'text/css', 'file-preview.js':'text/javascript', 'file-preview-renderers.js':'text/javascript', 'file-preview.css':'text/css', 'index.html': 'text/html', 'app.js': 'text/javascript', 'approval-preview.js': 'text/javascript', 'style.css': 'text/css', 'conversation-scrollbar.css': 'text/css', 'conversation-scrollbar.js': 'text/javascript', 'sw.js': 'text/javascript', 'manifest.webmanifest': 'application/manifest+json', 'icon.svg': 'image/svg+xml', 'icon-192.png': 'image/png', 'icon-512.png': 'image/png', 'apple-touch-icon.png': 'image/png', 'marked.min.js': 'text/javascript', 'markdown-compat.js': 'text/javascript', 'conversation-presentation.js': 'text/javascript', 'dompurify.min.js': 'text/javascript' };
      if (/^katex\/(?:katex\.min\.(?:js|css)|fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2?|ttf))$/.test(name)) {
        const vendor = path.join(publicDir,name);
        if (!fs.existsSync(vendor) || !fs.statSync(vendor).isFile()) throw fail(404,'Not found');
        const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : name.endsWith('.woff') ? 'font/woff' : 'font/ttf';
        res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff'}); fs.createReadStream(vendor).pipe(res); return;
      }
      // Explicit vendor asset boundary; never map arbitrary server paths.
      if (/^pdfjs\/(?:pdf(?:\.worker)?\.min\.mjs|(?:cmaps|standard_fonts|wasm|iccs)\/[A-Za-z0-9_.-]+)$/.test(name)) {
        const vendor = path.join(publicDir, name);
        if (!fs.existsSync(vendor) || !fs.statSync(vendor).isFile()) throw fail(404, 'Not found');
        const type = /\.m?js$/.test(name) ? 'text/javascript' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
        res.writeHead(200, {'Content-Type':type}); fs.createReadStream(vendor).pipe(res); return;
      }
      if (!files[name]) throw fail(404, 'Not found');
      res.writeHead(200, { 'Content-Type': `${files[name]}; charset=utf-8` }); res.end(fs.readFileSync(path.join(publicDir, name)));
    } catch (e) { if (res.destroyed) return; if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : '服务暂不可用' }); else res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMIT, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== prefix + '/connect' || req.headers.origin) { socket.destroy(); return; }
    try { rate(`ws:${req.headers['x-real-ip'] || req.socket.remoteAddress}`, 60, 60000); }
    catch { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.alive = true;
    const authTimer = setTimeout(() => ws.terminate(), 5000);
    ws.on('error', () => {}); ws.on('pong', () => { ws.alive = true; });
    ws.on('close', () => { clearTimeout(authTimer); offline(ws); });
    ws.on('message', raw => {
      try {
        const m = JSON.parse(raw.toString());
        if (!ws.device) {
          if (m.type !== 'hello' || m.protocol !== 1 || typeof m.token !== 'string') return ws.close(4001, 'invalid credentials');
          const d = db.prepare('SELECT id FROM devices WHERE id=? AND token=?').get(m.deviceId, hash(m.token));
          if (!d) return ws.close(4001, 'revoked');
          clearTimeout(authTimer); revokeDevice(d.id);
          ws.device = d.id; devices.set(d.id, { ws });
          db.prepare('UPDATE devices SET seen=? WHERE id=?').run(Date.now(), d.id);
          send(ws, { type: 'ready', protocol: 1 }); return;
        }
        if (m.type === 'response') {
          const p = pending.get(m.id); if (!p || p.ws !== ws) return;
          pending.delete(m.id); clearTimeout(p.timer);
          if (m.error) p.reject(fail(Number.isInteger(m.status) && m.status >= 400 && m.status <= 599 ? m.status : 502, String(m.error).slice(0, 500)));
          else p.resolve(m.data);
        } else if (m.type === 'event') {
          const s = streams.get(m.id); if (!s || s.ws !== ws) return;
          if (typeof m.data !== 'string' || m.data.length > 256 * 1024 || s.res.writableLength > LIMIT) return closeStream(m.id);
          s.res.write(m.data);
        } else if (m.type === 'end') closeStream(m.id);
      } catch { ws.close(1008, 'invalid message'); }
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping();
      if (ws.device) db.prepare('UPDATE devices SET seen=? WHERE id=?').run(Date.now(), ws.device);
    }
    for (const [key, r] of rates) if (r.until < Date.now()) rates.delete(key);
    db.prepare('DELETE FROM logins WHERE expires<?').run(Date.now());
  }, 25000);
  return { server, db, close: async () => { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); for (const id of streams.keys()) closeStream(id); await new Promise(r => server.close(r)); wss.close(); db.close(); } };
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createGateway({ database: process.env.ASHUB_REMOTE_DB || './data/remote.sqlite', publicUrl: process.env.ASHUB_REMOTE_URL || 'https://ashub.aihao.world/mobile/', voiceConfig: loadManagedVoice(process.env.CREDENTIALS_DIRECTORY) });
  app.server.listen(Number(process.env.PORT || 3002), '127.0.0.1', () => console.log('asHub remote gateway ready'));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
}
