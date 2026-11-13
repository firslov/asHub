// Legacy adapter for integrations. Device protocol implementation lives in the optional plugin.
import {openArtifact} from '../artifacts.js';
import {DevicePublisher} from '../../examples/extensions/multi-machine/publisher.mjs';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {remoteTransport} from './transport.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
export interface RemoteSecretStore {read():string|null;write(value:string|null):void}
type Config={deviceId:string;deviceToken:string;username:string;roots:string[];deviceName:string;enabled?:boolean};
const error=(message:string,status=400)=>Object.assign(new Error(message),{status});
export class RemoteConnector extends DevicePublisher {
 constructor(opts:{store?:RemoteSecretStore;dataDir:string;localToken?:string;gateway?:string}){super({...opts,openArtifact});}
  handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.track(this.requests, () => this.handleRequest(req, res));
  }
  async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const epoch = this.generation;
    const reply = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      // A custom header plus the hub's Origin/Host guard prevents cross-site requests.
      if (req.headers['x-ashub-local'] !== '1') throw error('Local application request required', 403);
      if (req.method === 'GET' && req.url === '/api/mobile') { reply(200, this.status()); return; }
      if (req.method !== 'POST') throw error('Method not allowed', 405);
      if (!this.accepting) throw error('移动访问功能已停用', 409);
      if (!this.opts.store) throw error('请在支持系统安全存储的 asHub 桌面端中启用移动访问', 409);
      let size = 0; const chunks: Buffer[] = [];
      this.requestBodies.add(req);
      try {
        for await (const chunk of req) {
          if (!this.accepting || epoch !== this.generation) throw error('移动访问请求已取消，请重试', 409);
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length; if (size > 16384) throw error('Request too large', 413);
          chunks.push(bytes);
        }
      } finally { this.requestBodies.delete(req); }
      // Closing while a chunked body is arriving must never launch enrollment
      // or persist credentials after the application has stopped.
      if (!this.accepting || epoch !== this.generation) throw error('移动访问请求已取消，请重试', 409);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (req.url === '/api/mobile/disconnect') {
        this.stopConnection(); this.statusText = 'disabled'; this.lastError = '';
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
        const r = await remoteTransport.fetch(new URL('api/device/enroll', this.gateway), { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: body.username, password: body.password, create: body.create === true && !previous, deviceName: body.deviceName, ...(previous ? { deviceId: previous.deviceId, deviceToken: previous.deviceToken } : {}) }), signal: AbortSignal.timeout(25000), redirect: 'error' });
        const result = await r.json() as any;
        if (!r.ok) throw error(result.error || '绑定失败', r.status);
        if (!this.accepting || bindingGeneration !== this.generation) throw error('绑定已取消，请重新连接', 409);
        if (result.protocol !== 1 || typeof result.deviceToken !== 'string' || typeof result.deviceId !== 'string') throw error('网关协议不兼容');
        const config: Config = { deviceId: result.deviceId, deviceToken: result.deviceToken, username: result.username, roots, deviceName: String(body.deviceName || '我的电脑').slice(0, 80) };
        this.opts.store.write(JSON.stringify(config)); this.stopConnection(); this.config = config; this.stopped = false; this.attempts = 0; this.lastError = ''; this.connect();
        reply(200, { ...this.status(), recovery: result.recovery });
      } finally { this.connecting = false; }
    } catch (e: any) { reply(e.status || 400, { error: e.status ? e.message : '操作失败，请检查目录、网络和系统安全存储' }); }
  }
}
