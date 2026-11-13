import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
export interface PluginSecretStore {
    read(key: string): string | null;
    write(key: string, value: string | null): void;
}
export interface BackendAdapter {
    label: string;
    online(): boolean;
    request(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
    subscribe(session: string, emit: (event: unknown) => void, signal: AbortSignal): Promise<void>;
    resource?(args: Record<string, string>, signal: AbortSignal): Promise<{
        data: Uint8Array;
        type: string;
        size?: number;
        version?: string;
    }>;
}
const operations = new Set(['capabilities', 'sessions', 'project-groups', 'projects', 'create', 'models', 'model', 'thinking', 'set-thinking', 'session-network', 'set-session-network', 'session-delete', 'queue', 'queue-update', 'queue-withdraw', 'submit', 'request-status', 'cancel', 'permission', 'image', 'plugin-entries', 'plugin-resource']);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
type Entry = {
    id: string;
    plugin: string;
    adapter: BackendAdapter;
    controller: AbortController;
};
/** Scoped adapters only. Credentials/protocols and device discovery belong to plugins. */
export class BackendConnections {
    private entries = new Map<string, Entry>();
    constructor(private options: {
        signal: AbortSignal;
        secrets?: PluginSecretStore;
        open?(id: string, label: string): Promise<void> | void;
    }) {
        options.signal.addEventListener('abort', () => { for (const e of this.entries.values())
            e.controller.abort(); this.entries.clear(); }, { once: true });
    }
    bind(plugin: string, signal: AbortSignal) {
        const active = () => { signal.throwIfAborted(); this.options.signal.throwIfAborted(); };
        const secretKey = (key: string) => { active(); if (!identifier(key))
            throw fail('Invalid credential key'); return createHash('sha256').update(plugin + '\0' + key).digest('hex'); };
        return Object.freeze({
            secrets: Object.freeze({ available: !!this.options.secrets, read: (key: string) => this.options.secrets?.read(secretKey(key)) ?? null,
                write: (key: string, value: string | null) => { const k = secretKey(key); if (!this.options.secrets)
                    throw fail('System credential storage unavailable', 503); if (value !== null && (typeof value !== 'string' || value.length > 16384))
                    throw fail('Credential too large'); this.options.secrets.write(k, value); } }),
            register: (key: string, adapter: BackendAdapter) => {
                active();
                if (!identifier(key) || !adapter || typeof adapter.request !== 'function' || typeof adapter.subscribe !== 'function' || typeof adapter.online !== 'function' || typeof adapter.label !== 'string' || !adapter.label.trim() || adapter.label.length > 160)
                    throw fail('Invalid backend');
                const id = createHash('sha256').update(plugin + '\0' + key).digest('hex').slice(0, 32);
                if (this.entries.has(id))
                    throw fail('Backend already registered', 409);
                const entry: Entry = { id, plugin, adapter, controller: new AbortController() };
                this.entries.set(id, entry);
                const dispose = () => { entry.controller.abort(); if (this.entries.get(id) === entry)
                    this.entries.delete(id); signal.removeEventListener('abort', dispose); };
                signal.addEventListener('abort', dispose, { once: true });
                return Object.freeze({ id, dispose, open: async () => {
                    const current = () => { active(); if (this.entries.get(id) !== entry || entry.controller.signal.aborted)
                        throw fail('Backend unavailable', 410); };
                    current();
                    if (!adapter.online()) throw fail('Backend offline', 503);
                    if (!this.options.open) throw fail('Desktop window unavailable', 501);
                    await this.options.open(id, adapter.label);
                    current();
                } });
            },
        });
    }
    list() { return [...this.entries.values()].map(e => ({ id: e.id, label: e.adapter.label, online: e.adapter.online() })); }
    async handle(req: IncomingMessage, res: ServerResponse, read: (req: IncomingMessage) => Promise<string>): Promise<boolean> {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/api/backends' && !url.pathname.startsWith('/api/backends/'))
            return false;
        const json = (status: number, value: unknown) => { if (res.destroyed || res.writableEnded)
            return; res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
        let cancel: AbortController | undefined, cleanup = () => { };
        try {
            if (req.method === 'GET' && url.pathname === '/api/backends') {
                json(200, this.list());
                return true;
            }
            const match = /^\/api\/backends\/([a-f0-9]{32})\/(info|request|events|resource)$/.exec(url.pathname);
            if (!match)
                throw fail('Invalid backend route', 404);
            const entry = this.entries.get(match[1]!);
            if (!entry || entry.controller.signal.aborted)
                throw fail('Backend unavailable', 410);
            cancel = new AbortController();
            const abort = () => cancel!.abort();
            entry.controller.signal.addEventListener('abort', abort, { once: true });
            res.on('close', abort);
            cleanup = () => { entry.controller.signal.removeEventListener('abort', abort); res.removeListener('close', abort); };
            const current = () => { cancel!.signal.throwIfAborted(); if (this.entries.get(entry.id) !== entry)
                throw fail('Backend changed', 409); };
            if (match[2] === 'info' && req.method === 'GET') {
                json(200, { id: entry.id, label: entry.adapter.label, online: entry.adapter.online() });
                return true;
            }
            if (!entry.adapter.online())
                throw fail('远程电脑离线，草稿已保留', 503);
            if (match[2] === 'request' && req.method === 'POST') {
                const body = JSON.parse(await read(req));
                current();
                if (!operations.has(body.op) || !body.args || typeof body.args !== 'object' || Array.isArray(body.args))
                    throw fail('Unsupported backend operation');
                // Remote clients never gain persistent/local-desktop approval authority.
                if (body.op === 'permission' && (body.args.sessionWide || body.args.onceOnly === false))
                    throw fail('Only one-time remote approvals are supported', 403);
                const result = await entry.adapter.request(body.op, body.args, cancel.signal);
                current();
                if (JSON.stringify(result ?? null).length > 8 * 1024 * 1024)
                    throw fail('Backend response too large', 413);
                json(200, result ?? null);
                return true;
            }
            if (match[2] === 'events' && req.method === 'GET') {
                const session = url.searchParams.get('session');
                if (!identifier(session))
                    throw fail('Invalid conversation');
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
                res.write(': connected\n\n');
                const timer = setInterval(() => { if (!res.destroyed)
                    res.write(': heartbeat\n\n'); }, 15000);
                const close = () => res.end();
                cancel.signal.addEventListener('abort', close, { once: true });
                try {
                    await entry.adapter.subscribe(session, event => {
                        // Adapter callbacks can arrive after cancellation or normal stream completion.
                        if(cancel!.signal.aborted || this.entries.get(entry.id)!==entry || res.destroyed || res.writableEnded)return;
                        const text = JSON.stringify(event); if (text.length > 6 * 1024 * 1024 || res.writableLength > 8 * 1024 * 1024) {
                        cancel!.abort();
                        return;
                    } res.write('data: ' + text + '\n\n'); }, cancel.signal);
                }
                finally {
                    clearInterval(timer);
                    cancel.signal.removeEventListener('abort', close);
                    res.end();
                }
                return true;
            }
            if (match[2] === 'resource' && ['GET', 'HEAD'].includes(req.method ?? '') && entry.adapter.resource) {
                const data = await entry.adapter.resource({ ...Object.fromEntries(url.searchParams), method: req.method! }, cancel.signal);
                current();
                if (data.data.byteLength > 32 * 1024 * 1024)
                    throw fail('File exceeds preview limit', 413);
                const safe = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(data.type) ? data.type : 'application/octet-stream';
                const size = data.size ?? data.data.byteLength;
                if (!Number.isSafeInteger(size) || size < 0 || size > 32 * 1024 * 1024)
                    throw fail('Invalid resource size', 413);
                const version = data.version && /^[a-zA-Z0-9_-]{1,200}$/.test(data.version) ? data.version : undefined;
                res.writeHead(200, { 'Content-Type': safe, 'Content-Length': size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'attachment; filename="download"', 'Content-Security-Policy': 'sandbox', ...(version ? { 'X-Artifact-Version': version } : {}) });
                res.end(req.method === 'HEAD' ? undefined : data.data);
                return true;
            }
            throw fail('Unsupported backend operation', 405);
        }
        catch (e: any) {
            if (res.headersSent)
                res.end();
            else
                json(e.status ?? 502, { error: e.name === 'AbortError' ? 'Connection closed' : e.status ? e.message : '后端请求失败，请检查连接' });
            return true;
        }
        finally {
            cleanup();
        }
    }
}
