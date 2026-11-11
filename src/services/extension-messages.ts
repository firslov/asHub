import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
export interface MessageGrant {
    targetId: string;
    template: string;
    variables?: string[];
    label: string;
    minIntervalMs: number;
    maxRuns?: number;
    expiresAt?: number;
    /** Explicit opt-in for event-triggered background work. */
    pauseOnStop?: boolean;
    recoverQueued?: boolean;
    projectId?: string;
}
export interface Delivery {
    id: string;
    pluginId: string;
    grantId: string;
    key: string;
    fingerprint: string;
    targetId: string;
    message: string;
    label: string;
    createdAt: number;
    expiresAt: number;
    state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'expired' | 'interrupted';
    error?: string;
    startedAt?: number;
    finishedAt?: number;
}
interface Grant extends MessageGrant {
    id: string;
    pluginId: string;
    binding: string;
    revoked: boolean;
    used: number;
    lastAt?: number;
}
export interface DeliveryPort {
    target(id: string): {
        title: string;
        binding: string;
        projectId?: string | null;
    } | undefined;
    busy(id: string): boolean;
    dispatch(delivery: Delivery, before: () => void, settled: (state: 'completed' | 'failed' | 'cancelled', error?: string) => void): Promise<void>;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !v.includes('\0');
/** Durable, authorized message admission. No calendar, recurrence, or plugin business rules. */
export class ExtensionMessages {
    private state: {
        version: 1;
        grants: Record<string, Grant>;
        deliveries: Record<string, Delivery>;
    };
    private active = new Map<string, AbortSignal>();
    private timer?: ReturnType<typeof setInterval>;
    private inFlight = new Set<string>();
    // Confirmation tokens are process-local; stops also invalidate previews
    // created before any grant exists. Ordinary scheduled grants are unaffected.
    private stopRevisions = new Map<string, number>();
    private closed = false;
    private shuttingDown = false;
    prepareShutdown() { this.shuttingDown = true; }
    private fault: unknown;
    constructor(private file: string, private port: DeliveryPort, private now = Date.now) {
        this.state = { version: 1, grants: {}, deliveries: {} };
        try {
            if (fs.existsSync(file)) {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (data.version !== 1 || !data.grants || !data.deliveries)
                    throw Error('Invalid extension message store');
                this.state = data;
                for (const d of Object.values(this.state.deliveries))
                    if (['queued', 'running'].includes(d.state) && !(d.state === 'queued' && this.state.grants[d.grantId]?.recoverQueued)) {
                        d.state = 'interrupted';
                        d.error = 'Host restarted; automatic replay is disabled';
                        d.finishedAt = this.now();
                    }
                this.save();
            }
        }
        catch (error) {
            this.fault = error;
        }
    }
    private save() {
        if (this.fault)
            throw Error('Message persistence unavailable; restart after resolving the storage error');
        const tmp = this.file + '.' + randomUUID() + '.tmp';
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
            fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600, flush: true });
            fs.renameSync(tmp, this.file);
        }
        catch (e) {
            this.fault = e;
            throw e;
        }
        finally {
            try {
                fs.unlinkSync(tmp);
            }
            catch { }
        }
    }
    private guard(pluginId: string) { if (this.closed || this.shuttingDown || this.fault || this.active.get(pluginId)?.aborted !== false)
        throw Error('Plugin message service unavailable'); }
    start() { if (!this.timer && !this.closed) {
        this.timer = setInterval(() => { void this.pump().catch(() => { }); }, 1000);
        this.timer.unref?.();
    } }
    bind(pluginId: string, signal: AbortSignal) {
        if (this.active.has(pluginId) && !this.active.get(pluginId)!.aborted)
            throw Error('Plugin already has an active message service');
        this.active.set(pluginId, signal);
        signal.addEventListener('abort', () => {
            if (this.active.get(pluginId) !== signal)
                return;
            this.active.delete(pluginId);
            for (const d of Object.values(this.state.deliveries))
                if (d.pluginId === pluginId && d.state === 'queued' && !(this.shuttingDown && this.state.grants[d.grantId]?.recoverQueued)) {
                    d.state = 'cancelled';
                    d.error = 'Plugin stopped';
                    d.finishedAt = this.now();
                }
            try {
                this.save();
            }
            catch { }
        }, { once: true });
        const guard = () => { signal.throwIfAborted(); this.guard(pluginId); };
        return Object.freeze({
            submit: (input: {
                grantId: string;
                key: string;
                values?: Record<string, string>;
                expiresAt: number;
            }) => { guard(); return this.submit(pluginId, input); },
            lookup: (key: string) => { guard(); const d = this.state.deliveries[hash([pluginId, key])]; return d ? copy(d) : undefined; },
            status: (id: string) => { guard(); const d = this.state.deliveries[id]; if (!d || d.pluginId !== pluginId)
                throw Error('Delivery unavailable'); return copy(d); },
            revoke: (id: string) => { guard(); this.revoke(pluginId, id); },
            authorization: (id: string) => { guard(); const g = this.state.grants[id];
                if (!g || g.pluginId !== pluginId) return undefined;
                return { revoked: g.revoked, used: g.used, maxRuns: g.maxRuns, expiresAt: g.expiresAt };
            },
            cancel: (key: string) => { guard(); const d = this.state.deliveries[hash([pluginId, key])];
                if (d?.state === 'queued') { d.state = 'cancelled'; d.finishedAt = this.now(); this.save(); }
            },
        });
    }
    prepare(pluginId: string, input: MessageGrant) {
        this.guard(pluginId);
        const spec = copy(input);
        if (!text(spec.targetId, 100) || !text(spec.label, 120) || !text(spec.template, 8000) || !Number.isSafeInteger(spec.minIntervalMs) || spec.minIntervalMs < 0 || spec.minIntervalMs > 366 * 86400000
            || (spec.maxRuns !== undefined && (!Number.isSafeInteger(spec.maxRuns) || spec.maxRuns < 1 || spec.maxRuns > 100000))
            || (spec.expiresAt !== undefined && (!Number.isSafeInteger(spec.expiresAt) || spec.expiresAt <= this.now())))
            throw Error('Invalid message authorization');
        if (!Array.isArray(spec.variables ?? []) || (spec.variables ?? []).length > 8 || (spec.variables ?? []).some(v => !/^\w{1,40}$/.test(v)))
            throw Error('Invalid message variables');
        if ([spec.pauseOnStop, spec.recoverQueued].some(v => v !== undefined && typeof v !== 'boolean')
            || (spec.projectId !== undefined && !text(spec.projectId, 100))) throw Error('Invalid message lifecycle policy');
        const target = this.port.target(spec.targetId);
        if (!target || (spec.projectId !== undefined && target.projectId !== spec.projectId))
            throw Error('Target conversation unavailable or project changed');
        return { spec, binding: target.binding, stopRevision: spec.pauseOnStop ? (this.stopRevisions.get(spec.targetId) ?? 0) : undefined, fields: [
                { label: '目标对话', value: `${target.title} (${spec.targetId})` },
                { label: '任务内容', value: spec.template },
                { label: '权限范围', value: '仅提交此消息；工具操作仍遵守原有授权' },
                ...(spec.pauseOnStop ? [{ label: '停止行为', value: '点击停止将撤销此自动接续授权，需手动恢复' }] : []),
                ...(spec.recoverQueued ? [{ label: '重启行为', value: '仅恢复尚未开始的消息；已开始但结果未知时不重发' }] : []),
                { label: '最短提交间隔', value: `${spec.minIntervalMs / 1000}s` },
                { label: '最多提交', value: String(spec.maxRuns ?? '持续有效，直到撤销') },
                ...(spec.expiresAt ? [{ label: '授权截止', value: new Date(spec.expiresAt).toISOString() }] : []),
            ] };
    }
    /** Called only by the host's confirmed interaction path; not injected into plugins. */
    approve(pluginId: string, prepared: ReturnType<ExtensionMessages['prepare']>) {
        const next = this.prepare(pluginId, prepared.spec);
        if (next.binding !== prepared.binding || next.stopRevision !== prepared.stopRevision)
            throw Error('Target conversation changed; review again');
        if (Object.keys(this.state.grants).length >= 20000)
            throw Error('Authorization store capacity reached');
        const id = randomUUID();
        this.state.grants[id] = { ...next.spec, id, pluginId, binding: next.binding, revoked: false, used: 0 };
        this.save();
        return id;
    }
    revoke(pluginId: string, id: string) {
        const g = this.state.grants[id];
        if (!g || g.pluginId !== pluginId)
            throw Error('Authorization unavailable');
        this.revokeGrants([g]);
    }
    private revokeGrants(grants: Grant[]) {
        const ids = new Set(grants.map(g => g.id));
        for (const g of grants) g.revoked = true;
        for (const d of Object.values(this.state.deliveries))
            if (ids.has(d.grantId) && d.state === 'queued') {
                d.state = 'cancelled';
                d.finishedAt = this.now();
            }
        this.save();
    }
    /** Explicit user stop revokes only grants which opted into this behavior. */
    stopTarget(targetId: string) {
        this.stopRevisions.set(targetId, (this.stopRevisions.get(targetId) ?? 0) + 1);
        const grants = Object.values(this.state.grants).filter(g => g.targetId === targetId && g.pauseOnStop && !g.revoked);
        // One durable commit: a stopped coordinator may own multiple workflows.
        // Never leave a recoverable checkpoint with only some grants revoked.
        if (grants.length) this.revokeGrants(grants);
    }
    private submit(pluginId: string, input: {
        grantId: string;
        key: string;
        values?: Record<string, string>;
        expiresAt: number;
    }) {
        if (!text(input.key, 180) || !Number.isSafeInteger(input.expiresAt))
            throw Error('Invalid delivery request');
        const fingerprint = hash(input), id = hash([pluginId, input.key]);
        const existing = this.state.deliveries[id];
        if (existing) {
            if (existing.fingerprint !== fingerprint)
                throw Error('Delivery key already bound to different parameters');
            return copy(existing);
        }
        const g = this.state.grants[input.grantId];
        if (!g || g.pluginId !== pluginId || g.revoked)
            throw Error('Message authorization revoked or unavailable');
        if (g.expiresAt !== undefined && g.expiresAt <= this.now())
            throw Error('Message authorization expired');
        if (g.maxRuns !== undefined && g.used >= g.maxRuns)
            throw Error('Message authorization exhausted');
        if (g.lastAt !== undefined && this.now() - g.lastAt < g.minIntervalMs)
            throw Error('Message authorization rate limit');
        const target = this.port.target(g.targetId);
        if (!target || target.binding !== g.binding)
            throw Error('Target conversation unavailable or changed');
        const values = input.values ?? {};
        if (!values || Array.isArray(values) || Object.entries(values).some(([k, v]) => !g.variables?.includes(k) || typeof v !== 'string' || v.length > 160 || /[\r\n\0]/.test(v)))
            throw Error('Invalid message variables');
        const message = g.template.replace(/\{\{(\w+)\}\}/g, (token, k) => { if (!Object.hasOwn(values, k))
            throw Error(`Missing variable ${k}`); return values[k]; });
        if (message.length > 10000)
            throw Error('Message too long');
        if (Object.keys(this.state.deliveries).length >= 20000)
            throw Error('Delivery receipt capacity reached; automatic pruning is disabled');
        const d: Delivery = { id, pluginId, grantId: g.id, key: input.key, fingerprint, targetId: g.targetId, message, label: g.label, createdAt: this.now(), expiresAt: Math.min(input.expiresAt, g.expiresAt ?? Infinity), state: input.expiresAt <= this.now() ? 'expired' : 'queued' };
        this.state.deliveries[id] = d;
        g.used++;
        g.lastAt = this.now();
        this.save();
        return copy(d);
    }
    async pump() {
        if (this.closed || this.shuttingDown || this.fault)
            return;
        const pending: Promise<void>[] = [];
        for (const d of Object.values(this.state.deliveries)) {
            if (d.state !== 'queued')
                continue;
            const g = this.state.grants[d.grantId], target = this.port.target(d.targetId);
            if (d.expiresAt <= this.now()) {
                d.state = 'expired';
                d.finishedAt = this.now();
                this.save();
                continue;
            }
            if (!g || g.revoked || !target || target.binding !== g.binding || (g.projectId !== undefined && target.projectId !== g.projectId)) {
                d.state = 'cancelled';
                d.error = 'Target or authorization unavailable';
                d.finishedAt = this.now();
                this.save();
                continue;
            }
            if (this.inFlight.has(d.id) || this.active.get(d.pluginId)?.aborted !== false || this.port.busy(d.targetId))
                continue;
            this.inFlight.add(d.id);
            pending.push((async () => {
                let admitted = false;
                try {
                    await this.port.dispatch(copy(d), () => {
                        this.guard(d.pluginId);
                        if (d.state !== 'queued' || g.revoked || d.expiresAt <= this.now() || this.port.target(d.targetId)?.binding !== g.binding || (g.projectId !== undefined && this.port.target(d.targetId)?.projectId !== g.projectId) || this.port.busy(d.targetId))
                            throw Object.assign(Error('Delivery admission changed'), { code: 'ADMISSION_CHANGED' });
                        d.state = 'running';
                        d.startedAt = this.now();
                        this.save();
                        admitted = true;
                    }, (state, error) => {
                        if (d.state !== 'running')
                            return;
                        d.state = state;
                        d.error = error?.slice(0, 1000);
                        d.finishedAt = this.now();
                        try {
                            this.save();
                        }
                        catch { }
                    });
                }
                catch (e) {
                    // Shutdown owns the final receipt state. A bridge may finish
                    // initialization after that commit; its aborted admission
                    // must not turn recoverable queued work into a failed turn.
                    if (this.closed || this.shuttingDown) return;
                    if (['queued', 'running'].includes(d.state) && (admitted || (e as {
                        code?: string;
                    })?.code !== 'ADMISSION_CHANGED')) {
                        d.state = admitted ? 'interrupted' : 'failed';
                        d.error = String(e).slice(0, 1000);
                        d.finishedAt = this.now();
                        this.save();
                    }
                }
            })().finally(() => this.inFlight.delete(d.id)));
        }
        await Promise.allSettled(pending);
    }
    close() { this.closed = true; clearInterval(this.timer); for (const d of Object.values(this.state.deliveries))
        if (['queued', 'running'].includes(d.state) && !(d.state === 'queued' && this.state.grants[d.grantId]?.recoverQueued)) {
            d.state = 'interrupted';
            d.finishedAt = this.now();
        } this.save(); }
}
