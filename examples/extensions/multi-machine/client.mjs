import { Agent, fetch as nodeFetch } from 'undici';
import { randomUUID } from 'node:crypto';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const sid = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
/** Protocol/account policy belongs to this plugin, not the application host. */
export class RemoteAccount {
    constructor({ backends, signal, gateway = 'https://ashub.aihao.world/mobile/', fetch, interval = 30000 }) {
        this.backends = backends;
        this.signal = signal;
        this.gateway = new URL(gateway);
        this.records = new Map();
        this.epoch = 0;
        this.user = '';
        this.error = '';
        this.discovery = 'idle';
        this.opening = new Map();
        this.direct = new Agent({ headersTimeout: 30000, bodyTimeout: 45000 });
        if (this.gateway.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && this.gateway.hostname === '127.0.0.1'))
            throw Error('HTTPS gateway required');
        this.fetch = fetch ?? ((url, init) => nodeFetch(url, { ...init, dispatcher: this.direct }));
        this.controller = new AbortController();
        this.cookie = '';
        try {
            const saved = JSON.parse(backends.secrets.read('login') || 'null');
            if (saved?.gateway === this.gateway.href && typeof saved.cookie === 'string' && /^ash_mobile=[A-Za-z0-9_-]+$/.test(saved.cookie)) {
                this.cookie = saved.cookie;
                this.user = String(saved.user || '');
            }
        }
        catch { }
        const stop = () => this.close();
        signal.addEventListener('abort', stop, { once: true });
        this.removeListener = () => signal.removeEventListener('abort', stop);
        this.timer = setInterval(() => void this.refresh().catch(() => { }), interval);
        this.timer.unref?.();
    }
    current(epoch) { this.signal.throwIfAborted(); this.controller.signal.throwIfAborted(); if (epoch !== this.epoch)
        throw fail('连接已变更，请重试', 409); }
    async call(route, body, signal, raw = false, cookie = this.cookie, method) {
        const epoch = this.epoch;
        this.current(epoch);
        const response = await this.fetch(new URL(route, this.gateway), { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', Origin: this.gateway.origin, ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([this.signal, this.controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(raw ? 60000 : 30000)]) });
        this.current(epoch);
        if (!response.ok) {
            let message = '远程服务暂时不可用';
            try {
                message = (await response.json()).error || message;
            }
            catch { }
            this.current(epoch);
            if (response.status === 401 && cookie && cookie === this.cookie) this.expire();
            throw fail(message, response.status);
        }
        return raw ? response : response.json();
    }
    expire() {
        try { this.clear(); } finally { this.discovery = 'expired'; this.error = '登录已过期，请重新登录连接账号'; }
    }
    clear() { this.discovery = 'idle'; this.opening.clear(); this.epoch++; this.cookie = ''; this.user = ''; for (const r of this.records.values())
        r.registration.dispose(); this.records.clear(); this.backends.secrets.write('login', null); }
    async login(username, password) {
        if (!this.backends.secrets.available)
            throw fail('系统加密存储不可用，无法安全保存连接', 503);
        if (this.loggingIn)
            throw fail('正在登录，请稍候', 409);
        this.loggingIn = true;
        try {
            const epoch = this.epoch;
            const r = await this.call('api/login', { username, password }, undefined, true, '');
            const value = (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie')]).find(v => v?.startsWith('ash_mobile='))?.split(';')[0];
            if (!value || !/^ash_mobile=[A-Za-z0-9_-]+$/.test(value))
                throw fail('登录服务未返回有效凭据', 502);
            const data = await r.json();
            this.current(epoch);
            this.clear();
            this.cookie = value;
            this.user = data.username ?? username;
            try {
                this.backends.secrets.write('login', JSON.stringify({ gateway: this.gateway.href, cookie: value, user: this.user }));
            }
            catch (e) {
                this.cookie = '';
                this.user = '';
                throw e;
            }
            const accepted = this.epoch;
            try { await this.refresh(); }
            catch (e) {
                // Authentication already succeeded. A discovery outage belongs on
                // the account overview; expired/replaced credentials still fail closed.
                if (!this.cookie || this.epoch !== accepted || this.discovery !== 'error') throw e;
                this.current(accepted);
            }
        }
        finally {
            this.loggingIn = false;
        }
    }
    async logout() { const cookie = this.cookie; let storageError; try {
        this.clear();
    }
    catch (e) {
        storageError = e;
    } this.error = ''; try {
        await this.call('api/logout', {}, undefined, false, cookie);
    }
    catch { } if (storageError)
        throw storageError; }
    async openDevice(id) {
        if (this.opening.has(id)) return this.opening.get(id);
        const epoch = this.epoch, record = this.records.get(id);
        this.current(epoch);
        if (!this.cookie || !record) throw fail('设备已不可用，请刷新列表', 410);
        const task = (async () => {
            // Never open a stale row on failed discovery, revoked membership or account switch.
            await this.refresh();
            this.current(epoch);
            if (this.records.get(id) !== record) throw fail('设备已变更，请重新选择', 410);
            if (!record.device.online) throw fail('电脑离线，请在目标电脑打开 asHub 并检查设备互联共享', 503);
            await record.registration.open();
            this.current(epoch);
        })();
        this.opening.set(id, task);
        try { return await task; }
        finally { if (this.opening.get(id) === task) this.opening.delete(id); }
    }
    async refresh() {
        if (!this.cookie)
            return;
        if (this.refreshing && this.refreshEpoch === this.epoch)
            return this.refreshing;
        const epoch = this.epoch;
        this.discovery = 'loading';
        const task = (async () => {
            try {
                const devices = await this.call('api/devices');
                this.current(epoch);
                if (!Array.isArray(devices))
                    throw fail('设备列表无效', 502);
                const valid = devices.filter(d => typeof d.id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(d.id));
                for (const [id, r] of this.records)
                    if (!valid.some(d => d.id === id)) {
                        r.registration.dispose();
                        this.records.delete(id);
                    }
                for (const d of valid) {
                    const old = this.records.get(d.id);
                    if (old) {
                        old.device = d; old.confirmed = true;
                        continue;
                    }
                    const record = { device: d, confirmed: true };
                    const owner = this;
                    const adapter = { get label() { return String(record.device.name || '远程电脑').slice(0, 160); }, online: () => record.confirmed && !!record.device.online,
                        status: () => !record.confirmed ? 'unknown' : record.device.online ? 'online' : 'offline',
                        managementResource: 'connections',
                        request: (op, args, signal) => owner.call(`api/devices/${d.id}/rpc`, { op, args }, signal),
                        subscribe: (session, emit, signal, viewer) => owner.subscribe(d.id, session, emit, signal, viewer), resource: (args, signal) => owner.resource(d.id, args, signal) };
                    record.registration = this.backends.register(d.id, adapter);
                    this.records.set(d.id, record);
                }
                this.error = '';
                this.discovery = 'ready';
            }
            catch (e) {
                if (epoch === this.epoch) {
                    for (const record of this.records.values()) record.confirmed = false;
                    this.discovery = 'error';
                    this.error = e.message;
                }
                throw e;
            }
        })();
        this.refreshEpoch = epoch;
        this.refreshing = task;
        try {
            return await task;
        }
        finally {
            if (this.refreshing === task)
                this.refreshing = null;
        }
    }
    async subscribe(device, session, emit, signal, viewer = {id: randomUUID(), attempt: '1'}) {
        if (!sid(session))
            throw fail('会话无效');
        const epoch = this.epoch;
        this.current(epoch);
        // A stream is long-lived; the request timeout only bounds establishment.
        const establishment = new AbortController(), timer = setTimeout(() => establishment.abort(), 30000);
        const expired = new AbortController();
        const active = AbortSignal.any([signal, this.signal, this.controller.signal, expired.signal]);
        const query = new URLSearchParams({session, history:'recent', viewer:viewer.id, attempt:viewer.attempt});
        const route = `api/devices/${device}/events?${query}`;
        let response;
        try {
            response = await this.fetch(new URL(route, this.gateway), { headers: { Cookie: this.cookie }, redirect: 'error', signal: AbortSignal.any([active, establishment.signal]) });
        }
        finally {
            clearTimeout(timer);
        }
        this.current(epoch);
        if (response.status === 401) this.expire();
        if (response.status === 429) {
            await response.body?.cancel();
            this.current(epoch);
            if (!active.aborted) emit({meta:{name:'hub:stream-limit'}});
            return;
        }
        if (!response.ok || !response.body)
            throw fail('对话连接失败', response.status);
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let renewing = false;
        const renewal = setInterval(async () => {
            if (active.aborted || renewing) return;
            renewing = true;
            try { await this.call(route, {}, active); }
            catch (error) {
                if (error.status === 405) clearInterval(renewal); // Older relay.
                if (error.status === 404) expired.abort();
            } finally { renewing = false; }
        }, 15000);
        renewal.unref?.();
        let buffer = '';
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                this.current(epoch);
                buffer += decoder.decode(value, { stream: true });
                if (buffer.length > 8 * 1024 * 1024)
                    throw fail('事件过大', 413);
                let end;
                while ((end = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const line = frame.split('\n').find(l => l.startsWith('data: '));
                    if (!line)
                        continue;
                    if (frame.startsWith('event: reset'))
                        emit({ meta: { name: 'backend:reset' }, payload: {} });
                    else
                        emit(JSON.parse(line.slice(6)));
                }
            }
        }
        finally {
            clearInterval(renewal);
            expired.abort();
            await reader.cancel().catch(() => { });
        }
    }
    async resource(device, args, signal) {
        if (!sid(args.session) || !['artifact', 'image-resource'].includes(args.kind))
            throw fail('无效资源');
        const query = new URLSearchParams({ session: args.session, ...(args.kind === 'artifact' ? { path: args.path || '' } : { id: args.id || '' }), ...(args.version ? { version: args.version } : {}) });
        const r = await this.call(`api/devices/${device}/${args.kind}?${query}`, undefined, signal, true, this.cookie, args.method === 'HEAD' ? 'HEAD' : 'GET');
        const type = (r.headers.get('content-type') || '').split(';')[0], size = Number(r.headers.get('content-length')), version = r.headers.get('x-artifact-version') || '';
        if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024) {
            await r.body?.cancel();
            throw fail('文件超过 32 MB 预览上限或大小无效', 413);
        }
        if (args.method === 'HEAD')
            return { data: new Uint8Array(), type, size, version };
        const chunks = [];
        let received = 0;
        const reader = r.body.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                received += value.length;
                if (received > 32 * 1024 * 1024)
                    throw fail('文件超过 32 MB 预览上限', 413);
                chunks.push(value);
            }
        }
        finally {
            await reader.cancel().catch(() => { });
        }
        if (size !== received)
            throw fail('文件传输不完整', 502);
        return { data: Buffer.concat(chunks), type, size, version };
    }
    close() { if (this.controller.signal.aborted)
        return; this.controller.abort(); clearInterval(this.timer); this.removeListener?.(); for (const r of this.records.values())
        r.registration.dispose(); this.records.clear(); void this.direct.destroy(); }
}
