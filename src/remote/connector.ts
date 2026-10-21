import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RemoteSecretStore { read(): string | null; write(value: string | null): void }
type Config = { deviceId: string; deviceToken: string; username: string; roots: string[]; deviceName: string; enabled?: boolean };
type Entry = { digest: string; state: 'pending' | 'done' | 'unknown'; result?: unknown; error?: string };
const LIMIT = 6 * 1024 * 1024;
const error = (message: string, status = 400) => Object.assign(new Error(message), { status });
const idPattern = /^[0-9a-f]{4,32}$/;
export class RemoteConnector {
  private config: Config | null = null;
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private generation = 0;
  private attempts = 0;
  private streams = new Map<string, AbortController>();
  private entries: Record<string, Entry> = {};
  private operations = new Map<string, Promise<unknown>>();
  private validating = new Map<string, number>();
  private localUrl = '';
  private connecting = false;
  private statusText = 'disabled';
  private lastError = '';
  private journal: string;
  private gateway: URL;
  constructor(private opts: { store?: RemoteSecretStore; dataDir: string; localToken?: string; gateway?: string }) {
    this.gateway = new URL(opts.gateway || process.env.ASHUB_REMOTE_URL || 'https://ashub.aihao.world/mobile/');
    if (this.gateway.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && this.gateway.hostname === '127.0.0.1')) throw Error('Remote gateway requires HTTPS');
    if (this.gateway.username || this.gateway.password || this.gateway.search || this.gateway.hash) throw Error('Invalid gateway URL');
    this.gateway.pathname = this.gateway.pathname.replace(/\/?$/, '/');
    this.journal = path.join(opts.dataDir, 'remote-requests.json');
  }
  start(port: number) {
    this.localUrl = `http://127.0.0.1:${port}`;
    try {
      const saved = this.opts.store?.read();
      if (saved) this.config = JSON.parse(saved);
      try {
        this.entries = JSON.parse(fs.readFileSync(this.journal, 'utf8'));
        for (const e of Object.values(this.entries)) if (e.state === 'pending') e.state = 'unknown';
        this.saveJournal();
      } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      this.connect();
    } catch { this.statusText = 'error'; this.lastError = '无法读取移动访问凭证或发送记录，请在桌面重新绑定'; }
  }
  status() { return { available: !!this.opts.store, enabled: !!this.config && this.config.enabled !== false, status: this.statusText, error: this.lastError,
    username: this.config?.username, deviceName: this.config?.deviceName, roots: this.config?.roots || [], gateway: this.gateway.href }; }
  close() {
    this.stopped = true; this.generation++; clearTimeout(this.timer); this.socket?.close(); this.socket = null;
    for (const c of this.streams.values()) c.abort(); this.streams.clear();
  }
  private saveJournal() {
    fs.mkdirSync(path.dirname(this.journal), { recursive: true, mode: 0o700 });
    const tmp = this.journal + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.entries)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.journal);
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      // A custom header plus the hub's Origin/Host guard prevents cross-site requests.
      if (req.headers['x-ashub-local'] !== '1') throw error('Local application request required', 403);
      if (req.method === 'GET' && req.url === '/api/mobile') { reply(200, this.status()); return; }
      if (req.method !== 'POST') throw error('Method not allowed', 405);
      if (!this.opts.store) throw error('请在支持系统安全存储的 asHub 桌面端中启用移动访问', 409);
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length; if (size > 16384) throw error('Request too large', 413);
        chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (req.url === '/api/mobile/disconnect') {
        this.close(); this.statusText = 'disabled'; this.lastError = '';
        // Retain only the encrypted device identity for a later password-authenticated rebind.
        // A disabled connector never connects, executes requests, or resumes on restart.
        if (this.config) this.config = { ...this.config, enabled: false };
        this.opts.store.write(this.config ? JSON.stringify(this.config) : null);
        reply(200, this.status()); return;
      }
      if (req.url !== '/api/mobile/connect') throw error('Not found', 404);
      if (this.connecting) throw error('正在绑定，请稍候', 409);
      if (!Array.isArray(body.roots) || !body.roots.length || body.roots.length > 20) throw error('请选择至少一个允许移动访问的项目目录');
      const roots = [...new Set<string>(body.roots.map((p: unknown) => {
        if (typeof p !== 'string' || !path.isAbsolute(p)) throw error('项目目录必须是绝对路径');
        const real = fs.realpathSync(p); if (!fs.statSync(real).isDirectory()) throw error('项目目录不存在');
        return real;
      }))];
      this.connecting = true;
      const bindingGeneration = this.generation;
      try {
        const previous = this.config?.username === String(body.username || '').trim().toLowerCase() ? this.config : null;
        const r = await fetch(new URL('api/device/enroll', this.gateway), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: body.username, password: body.password, create: body.create === true && !previous, deviceName: body.deviceName, ...(previous ? { deviceId: previous.deviceId, deviceToken: previous.deviceToken } : {}) }), signal: AbortSignal.timeout(25000), redirect: 'error' });
        const result = await r.json() as any;
        if (!r.ok) throw error(result.error || '绑定失败', r.status);
        if (bindingGeneration !== this.generation) throw error('绑定已取消，请重新连接', 409);
        if (result.protocol !== 1 || typeof result.deviceToken !== 'string' || typeof result.deviceId !== 'string') throw error('网关协议不兼容');
        const config: Config = { deviceId: result.deviceId, deviceToken: result.deviceToken, username: result.username, roots, deviceName: String(body.deviceName || '我的电脑').slice(0, 80) };
        this.opts.store.write(JSON.stringify(config)); this.close(); this.config = config; this.stopped = false; this.attempts = 0; this.lastError = ''; this.connect();
        reply(200, { ...this.status(), recovery: result.recovery });
      } finally { this.connecting = false; }
    } catch (e: any) { reply(e.status || 400, { error: e.status ? e.message : '操作失败，请检查目录、网络和系统安全存储' }); }
  }
  private connect() {
    if (this.stopped || !this.config || this.config.enabled === false || !this.localUrl) return;
    const epoch = this.generation, url = new URL('connect', this.gateway);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.statusText = 'connecting';
    const ws = new WebSocket(url); this.socket = ws;
    const deadline = setTimeout(() => ws.close(), 15000);
    ws.onopen = () => this.send(ws, { type: 'hello', protocol: 1, deviceId: this.config?.deviceId, token: this.config?.deviceToken });
    ws.onerror = () => { this.lastError = '连接中断，正在自动重连'; };
    ws.onmessage = event => {
      if (epoch !== this.generation) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > LIMIT) throw Error('Invalid payload');
        const m = JSON.parse(event.data);
        if (m.type === 'ready' && m.protocol === 1) { clearTimeout(deadline); this.statusText = 'online'; this.lastError = ''; this.attempts = 0; }
        else if (m.type === 'request' && typeof m.id === 'string') {
          void this.execute(m.op, m.args || {}).then(data => this.send(ws, { type: 'response', id: m.id, data }),
            e => this.send(ws, { type: 'response', id: m.id, status: e.status || 500, error: e.status ? e.message : '本地操作失败' }));
        } else if (m.type === 'subscribe') void this.subscribe(ws, m.id, m.session);
        else if (m.type === 'unsubscribe') { this.streams.get(m.id)?.abort(); this.streams.delete(m.id); }
      } catch { ws.close(1008, 'invalid message'); }
    };
    ws.onclose = e => {
      clearTimeout(deadline);
      if (epoch !== this.generation || this.stopped) return;
      for (const c of this.streams.values()) c.abort(); this.streams.clear();
      if (e.code === 4001) {
        this.generation++; this.stopped = true;
        this.statusText = 'revoked'; this.lastError = '设备授权已撤销，请重新绑定'; return;
      }
      this.statusText = 'connecting'; this.timer = setTimeout(() => this.connect(), Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5)) + Math.random() * 1000);
    };
  }
  private send(ws: WebSocket, value: unknown) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > LIMIT * 2) { ws.close(1008, 'slow connection'); return; }
    const data = JSON.stringify(value);
    if (data.length > LIMIT) { ws.close(1009, 'message too large'); return; }
    ws.send(data);
  }
  private headers(): Record<string, string> { return this.opts.localToken ? { Authorization: `Bearer ${this.opts.localToken}` } : {}; }
  private async local(route: string, body?: unknown, long = false): Promise<any> {
    const r = await fetch(this.localUrl + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(long ? 24 * 3600000 : 20000), redirect: 'error' });
    const text = await r.text();
    if (!r.ok) throw error(text.slice(0, 400), r.status);
    try { return JSON.parse(text); } catch { return { ok: true }; }
  }
  private inside(cwd: string) {
    try { const real = fs.realpathSync(cwd); return !!this.config?.roots.some(root => { const rel = path.relative(root, real); return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); }); }
    catch { return false; }
  }
  private async sessions() { const list = await this.local('/sessions'); return list.filter((s: any) => s.kind === 'agent' && this.inside(s.cwd)); }
  private async session(id: unknown) {
    if (typeof id !== 'string' || !idPattern.test(id)) throw error('会话无效');
    const s = (await this.sessions()).find((s: any) => s.instanceId === id);
    if (!s) throw error('该会话未授权移动访问', 403); return s;
  }
  private projectId(root: string) {
    return createHmac('sha256', this.config!.deviceToken).update(root).digest('hex');
  }
  async execute(op: string, args: any): Promise<any> {
    if (!this.config || this.config.enabled === false || this.stopped) throw error('移动访问已关闭', 403);
    const epoch = this.generation;
    if (op === 'sessions') return this.sessions();
    if (op === 'projects') return this.config.roots.map(p => ({ id: this.projectId(p), name: path.basename(p) || p }));
    if (op === 'models') return this.local('/api/models');
    if (op === 'request-status') {
      if (typeof args.requestId !== 'string') throw error('请求 ID 无效');
      const key = this.config.deviceId + ':' + args.requestId;
      return this.entries[key] || { state: this.validating.has(key) ? 'pending' : 'missing' };
    }
    if (op === 'create') {
      const root = this.config.roots.find(p => this.projectId(p) === args.project);
      if (!root) throw error('项目授权已变更，请刷新项目列表后重试', 403);
      return this.once(args.requestId, op, { project: args.project }, () => this.local('/sessions', { cwd: root, kind: 'agent' }));
    }
    if (op === 'submit') return this.submit(args);
    const session = await this.session(args.session);
    // Disabling or rebinding advances the generation while session lookup may be awaiting the Hub.
    if (epoch !== this.generation || this.stopped) throw error('移动访问授权已变更，请重新确认', 403);
    if (op === 'cancel') return this.local(`/${session.instanceId}/cancel`, {});
    if (op === 'permission') {
      if (!['approved', 'denied'].includes(args.outcome) || typeof args.requestId !== 'string') throw error('审批参数无效');
      return this.local('/api/permission/decide', { sessionId: session.instanceId, requestId: args.requestId, outcome: args.outcome, sessionWide: false });
    }
    if (op === 'model') {
      if (session.isProcessing) throw error('请等待本轮回复结束', 409);
      if (typeof args.model !== 'string' || typeof args.provider !== 'string') throw error('模型无效');
      const r = await fetch(this.localUrl + `/${session.instanceId}/model`, { method: 'PUT', headers: { ...this.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ model: args.model, provider: args.provider }), signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw error('切换模型失败', r.status); return r.json();
    }
    if (op === 'image') {
      if (typeof args.id !== 'string' || !new RegExp(`^${session.instanceId}_img_[a-z0-9]+_[a-z0-9]+$`).test(args.id)) throw error('图片不属于此会话', 403);
      const r = await fetch(this.localUrl + '/api/uploads/' + args.id, { headers: this.headers(), signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw error('图片不存在', 404);
      const b = Buffer.from(await r.arrayBuffer()); if (b.length > 4 * 1024 * 1024) throw error('图片过大', 413);
      return { data: b.toString('base64'), mimeType: r.headers.get('content-type') };
    }
    throw error('该操作不支持远程调用', 403);
  }
  private async submit(args: any) {
    if (typeof args.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(args.requestId)) throw error('请求 ID 无效');
    const key = this.config!.deviceId + ':' + args.requestId, epoch = this.generation;
    this.validating.set(key, (this.validating.get(key) || 0) + 1);
    try {
      const session = await this.session(args.session);
      if (epoch !== this.generation || this.stopped || this.config?.enabled === false) throw error('移动访问授权已变更，请重新确认', 403);
      const query = args.query;
      if (typeof query !== 'string' || query.length > 200000 || (!query.trim() && !args.images?.length)) throw error('消息为空或过长');
      // Shell shortcuts and slash commands are separate local capabilities, not remote chat.
      if (/^\s*[!/]/.test(query)) throw error('请使用普通对话；命令和终端操作请在桌面进行', 403);
      const images = args.images || [];
      if (!Array.isArray(images) || images.length > 4 || images.some((x: any) => !x || typeof x.data !== 'string' || x.data.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(x.data) || !/^image\/(png|jpeg|webp|gif)$/.test(x.mimeType))) throw error('图片格式或大小无效');
      return this.once(args.requestId, 'submit', { session: session.instanceId, query, images }, () => this.local(`/${session.instanceId}/submit`, { query, images }, true));
    } finally {
      const remaining = (this.validating.get(key) || 1) - 1;
      if (remaining) this.validating.set(key, remaining); else this.validating.delete(key);
    }
  }
  private once(id: unknown, op: string, payload: unknown, run: () => Promise<unknown>) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(id)) throw error('请求 ID 无效');
    const key = this.config!.deviceId + ':' + id;
    const digest = createHash('sha256').update(JSON.stringify({ op, payload })).digest('hex');
    const old = this.entries[key];
    if (old) { if (old.digest !== digest) throw error('请求 ID 已用于其他内容', 409); return old; }
    if (Object.keys(this.entries).length >= 100000) throw error('远程发送记录已满，请在桌面维护记录', 507);
    if (this.operations.size >= 8) throw error('等待本地任务完成后再发送', 429);
    const entry: Entry = { digest, state: 'pending' }; this.entries[key] = entry;
    try { this.saveJournal(); } catch (e) { delete this.entries[key]; throw e; }
    // Save BEFORE invoking any effect. A crash leaves an unknown result, never automatic re-execution.
    const task = run().then(result => { entry.state = 'done'; entry.result = result; }, e => {
      entry.state = 'unknown'; entry.error = e.status ? e.message : '结果未知，请查看对话后再决定是否重发';
    }).finally(() => { try { this.saveJournal(); } catch { this.lastError = '发送状态保存失败，请检查磁盘'; } this.operations.delete(key); });
    this.operations.set(key, task); return entry;
  }
  private async subscribe(ws: WebSocket, id: string, sessionId: string) {
    if (typeof id !== 'string' || id.length > 80 || this.streams.size >= 8 || this.streams.has(id)) { this.send(ws, { type: 'end', id }); return; }
    const c = new AbortController(); this.streams.set(id, c);
    const permissionCheck = setInterval(() => { void this.session(sessionId).catch(() => c.abort()); }, 15000);
    try {
      await this.session(sessionId);
      if (c.signal.aborted || ws.readyState !== WebSocket.OPEN) return;
      const r = await fetch(this.localUrl + `/events?subs=${sessionId}:all`, { headers: this.headers(), signal: c.signal });
      if (!r.ok || !r.body) throw Error('stream unavailable');
      const reader = r.body.getReader(), decoder = new TextDecoder(); let buffer = '';
      while (!c.signal.aborted) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > LIMIT) throw Error('frame too large');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const line = frame.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
          const data = JSON.parse(line.slice(6));
          if (data.meta?.name === 'shell:cwd-change' && !this.inside(data.payload?.cwd || '')) throw Error('project no longer shared');
          if (data.meta?.name === 'shell:pty-data' || data.meta?.name === 'shell:output' || data.meta?.name === 'pty:data' || data.meta?.name === 'pty:resize' || data.meta?.name?.startsWith('terminal:')) continue;
          // Split transport chunks on code point boundaries; browser receives the original SSE bytes.
          const text = frame + '\n\n';
          for (let at = 0; at < text.length;) {
            let next = Math.min(at + 60000, text.length);
            if (next < text.length && /[\uD800-\uDBFF]/.test(text[next - 1])) next--;
            this.send(ws, { type: 'event', id, data: text.slice(at, next) }); at = next;
          }
        }
      }
    } catch { /* reconnect always requests a fresh replay, never a partial stale history */ }
    finally { c.abort(); clearInterval(permissionCheck); if (this.streams.get(id) === c) this.streams.delete(id); this.send(ws, { type: 'end', id }); }
  }
}
