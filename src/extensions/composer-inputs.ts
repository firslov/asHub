import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
const fail = (message: string, status = 400) => Object.assign(Error(message), { status });
const MAX_BYTES = 4 * 1024 * 1024;
const audioType = /^(audio\/(webm|mp4|ogg|wav|mpeg|x-m4a))(;\s*codecs=[a-z0-9., -]+)?$/i;
export interface ComposerInput {
    label: string;
    description: string;
    kind: 'audio';
    audioFormat?: 'pcm-wav';
    maxBytes: number;
    maxDuration: number;
    transform(input: { data: Uint8Array; mimeType: string; sessionId: string; signal: AbortSignal }): Promise<string>;
}
type Entry = { id: string; revision: string; input: ComposerInput; controller: AbortController };
type Job = { session: string; input: string; hash?: string; expires: number; controller: AbortController; state: 'pending' | 'done' | 'cancelled' | 'error'; text?: string; error?: string };
/** Ephemeral user-supplied media -> draft text. No provider, recording or send policy. */
export class ComposerInputs {
    private entries = new Map<string, Entry>();
    private jobs = new Map<string, Job>();
    constructor(private signal: AbortSignal, private session: (id: string) => void) {
        const cleanup = setInterval(() => this.prune(), 30000); cleanup.unref?.();
        signal.addEventListener('abort', () => { clearInterval(cleanup); }, { once: true });
        signal.addEventListener('abort', () => { for (const j of this.jobs.values()) j.controller.abort(); this.jobs.clear(); this.entries.clear(); }, { once: true });
    }
    bind(plugin: string, owner: AbortSignal) {
        return Object.freeze({ supportsPcmWav: true, register: (key: string, input: ComposerInput) => {
            this.signal.throwIfAborted(); owner.throwIfAborted();
            if (!/^[a-z][a-z0-9-]{0,79}$/.test(key) || input.kind !== 'audio' || typeof input.transform !== 'function'
                || !input.label?.trim() || input.label.length > 80 || !input.description?.trim() || input.description.length > 300
                || !Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_BYTES
                || !Number.isInteger(input.maxDuration) || input.maxDuration < 1 || input.maxDuration > 60
                || (input.audioFormat !== undefined && input.audioFormat !== 'pcm-wav')) throw fail('Invalid composer input');
            const id = createHash('sha256').update(plugin + '\0' + key).digest('hex').slice(0, 32);
            if (this.entries.has(id)) throw fail('Composer input already registered', 409);
            const entry: Entry = { id, revision: randomUUID(), input: { ...input }, controller: new AbortController() };
            this.entries.set(id, entry);
            const dispose = () => { entry.controller.abort(); if (this.entries.get(id) === entry) this.entries.delete(id);
                for (const j of this.jobs.values()) if (j.input === id) { j.controller.abort(); j.state = 'cancelled'; delete j.text; delete j.error; }
                owner.removeEventListener('abort', dispose); };
            owner.addEventListener('abort', dispose, { once: true });
            return dispose;
        } });
    }
    private prune() {
        for (const [id, job] of this.jobs) if (job.expires < Date.now()) { job.controller.abort(); this.jobs.delete(id); }
    }
    async handle(req: IncomingMessage, res: ServerResponse, read: (req: IncomingMessage) => Promise<string>) {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        if (!/^\/[a-f0-9]{4,32}\/composer-inputs(?:\/|$)/.test(pathname)) return false;
        const send = (status: number, data: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } };
        try {
            this.signal.throwIfAborted(); this.prune();
            const match = /^\/([a-f0-9]{4,32})\/composer-inputs(?:\/([a-f0-9]{32})\/([a-f0-9-]{36}))?$/.exec(pathname);
            if (!match) throw fail('Invalid composer input route', 404);
            const sid = match[1]!; this.session(sid);
            if (!match[2] && req.method === 'GET') {
                send(200, [...this.entries.values()].map(({ id, revision, input: { label, description, kind, audioFormat, maxBytes, maxDuration } }) => ({ id, revision, label, description, kind, audioFormat, maxBytes, maxDuration }))); return true;
            }
            const id = match[2], requestId = match[3]; if (!id || !requestId) throw fail('Method not allowed', 405);
            const key = sid + ':' + id + ':' + requestId;
            let job = this.jobs.get(key);
            if (req.method === 'DELETE') {
                if (!job) { if (this.jobs.size >= 64) throw fail('Too many media requests', 429); job = { session: sid, input: id, controller: new AbortController(), expires: Date.now() + 300000, state: 'cancelled' }; this.jobs.set(key, job); }
                job.controller.abort(); job.state = 'cancelled'; delete job.text; delete job.error;
            } else if (req.method === 'POST') {
                const body = JSON.parse(await read(req));
                this.signal.throwIfAborted(); this.session(sid); this.prune();
                const entry = this.entries.get(id);
                if (!entry || body.revision !== entry.revision) throw fail('输入插件已更新或停用，请重新录音', 409);
                if (typeof body.data !== 'string' || body.data.length > Math.ceil(entry.input.maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)
                    || typeof body.mimeType !== 'string' || !audioType.test(body.mimeType)) throw fail('Invalid media', 413);
                const data = Buffer.from(body.data, 'base64');
                if (!data.length || data.length > entry.input.maxBytes || data.toString('base64') !== body.data) throw fail('Invalid media', 413);
                const hash = createHash('sha256').update(body.revision + '\0' + body.mimeType + '\0').update(data).digest('hex');
                job = this.jobs.get(key);
                if (job?.hash && job.hash !== hash) throw fail('Media request ID already used', 409);
                if (!job) {
                    if (this.jobs.size >= 64 || [...this.jobs.values()].filter(j => j.state === 'pending').length >= 4) throw fail('请等待当前转写完成', 429);
                    job = { session: sid, input: id, hash, expires: Date.now() + 300000, controller: new AbortController(), state: 'pending' }; this.jobs.set(key, job);
                    const current = job;
                    const signal = AbortSignal.any([this.signal, entry.controller.signal, current.controller.signal, AbortSignal.timeout(90000)]);
                    // Never retain audio in the receipt or persist it to disk. No retries.
                    const cancelled = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(fail('转写已取消或超时', 408)), { once: true }));
                    void Promise.race([cancelled, Promise.resolve().then(() => { signal.throwIfAborted(); return entry.input.transform({ data, mimeType: body.mimeType, sessionId: sid, signal }); })]).then(text => {
                        signal.throwIfAborted(); this.session(sid);
                        if (typeof text !== 'string' || text.length > 20000) throw fail('Invalid media result');
                        current.text = text; current.state = 'done';
                    }).catch(e => { if (current.state !== 'cancelled') { current.state = 'error'; current.error = String(e?.message || '转写失败').slice(0, 300); } }).finally(() => current.controller.abort());
                }
            } else if (req.method !== 'GET') throw fail('Method not allowed', 405);
            if (!job) throw fail('录音结果已过期，请重新录音', 404);
            send(200, { state: job.state, ...(job.text !== undefined ? { text: job.text } : {}), ...(job.error ? { error: job.error } : {}) });
        } catch (e: any) { send(e.status || 400, { error: e.message || 'Media input unavailable' }); }
        return true;
    }
}
