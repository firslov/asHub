import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readBodyWithSignal } from '../transport/body-reader.js';
import { ExtensionMessages, type MessageGrant } from '../services/extension-messages.js';
import { PluginBackground, type BackgroundGrantInput } from './background.js';
export interface ResourcePlan {
    preview?: {
        title: string;
        fields: Array<{
            label: string;
            value: string;
        }>;
    };
    authorization?: MessageGrant;
    backgroundAuthorization?: BackgroundGrantInput;
    execute(grantId?: string): unknown | Promise<unknown>;
}
export interface PluginResource {
    view(): unknown | Promise<unknown>;
    prepare(action: string, values: Record<string, unknown>): ResourcePlan | Promise<ResourcePlan>;
}
const identifier = (v: unknown) => typeof v === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(v);
const clone = (value: unknown) => {
    const encoded = JSON.stringify(value);
    if (!encoded || encoded.length > 262144)
        throw Error('Plugin resource response too large');
    return JSON.parse(encoded);
};
/** Scoped dynamic views and host-confirmed actions; no plugin HTML, script or URL loading. */
export class PluginInteractions {
    private entries = new Map<string, {
        pluginId: string;
        signal: AbortSignal;
        resource: PluginResource;
    }>();
    private pending = new Map<string, {
        key: string;
        entry: object;
        expires: number;
        run: () => Promise<unknown>;
        result?: Promise<unknown>;
    }>();
    constructor(private messages: ExtensionMessages, private requireActive: (pluginId: string) => void, private signal: AbortSignal, private run: <T>(pluginId: string, action: () => T | Promise<T>) => Promise<T> = async (_id, action) => action(), private background?: PluginBackground) { }
    bind(pluginId: string, signal: AbortSignal) {
        return Object.freeze({ register: (id: string, resource: PluginResource) => {
                signal.throwIfAborted();
                if (!identifier(id) || !resource || typeof resource.view !== 'function' || typeof resource.prepare !== 'function')
                    throw Error('Invalid plugin resource');
                const key = pluginId + '/' + id;
                if (this.entries.has(key))
                    throw Error('Plugin resource already registered');
                const entry = { pluginId, signal, resource };
                this.entries.set(key, entry);
                const dispose = () => { if (this.entries.get(key) === entry)
                    this.entries.delete(key); for (const [id, p] of this.pending)
                    if (p.entry === entry)
                        this.pending.delete(id); };
                signal.addEventListener('abort', dispose, { once: true });
                return dispose;
            } });
    }
    async handle(req: IncomingMessage, res: ServerResponse, read: (req: IncomingMessage) => Promise<string>) {
        const parts = (req.url ?? '').split('?')[0].split('/');
        if (parts[1] !== 'api' || parts[2] !== 'plugin-resources')
            return false;
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        try {
            if (parts.length !== 5)
                throw Error('Invalid plugin resource route');
            const key = decodeURIComponent(parts[3]) + '/' + decodeURIComponent(parts[4]);
            const entry = this.entries.get(key);
            if (!entry)
                throw Error('Plugin resource unavailable');
            const guard = () => { this.signal.throwIfAborted(); entry.signal.throwIfAborted(); this.requireActive(entry.pluginId); if (this.entries.get(key) !== entry)
                throw Error('Plugin resource changed'); };
            guard();
            let result: unknown;
            if (req.method === 'GET')
                result = { view: clone(await entry.resource.view()) };
            else if (req.method === 'POST') {
                const raw = await readBodyWithSignal(req, read, this.signal);
                if (raw.length > 65536)
                    throw Error('Action too large');
                const input = JSON.parse(raw);
                guard();
                if (!input || typeof input !== 'object' || Array.isArray(input))
                    throw Error('Invalid action');
                for (const [id, p] of this.pending)
                    if (p.expires < Date.now())
                        this.pending.delete(id);
                if (input.confirm) {
                    const p = this.pending.get(input.confirm);
                    if (!p || p.key !== key || p.entry !== entry || p.expires < Date.now())
                        throw Error('Confirmation expired; review again');
                    p.result ??= Promise.resolve().then(p.run);
                    result = await p.result;
                }
                else {
                    if (!identifier(input.action) || !input.values || typeof input.values !== 'object' || Array.isArray(input.values))
                        throw Error('Invalid action');
                    const plan = await entry.resource.prepare(input.action, clone(input.values));
                    guard();
                    if (!plan || typeof plan.execute !== 'function')
                        throw Error('Invalid action plan');
                    const authorization = plan.authorization ? this.messages.prepare(entry.pluginId, plan.authorization) : undefined;
                    if (plan.authorization && plan.backgroundAuthorization) throw Error('Conflicting authorizations');
                    if (plan.backgroundAuthorization && !this.background) throw Error('Background services unavailable');
                    const background = plan.backgroundAuthorization ? this.background!.prepare(entry.pluginId, plan.backgroundAuthorization) : undefined;
                    const run = () => this.run(entry.pluginId, async () => {
                        guard();
                        const grantId = authorization ? this.messages.approve(entry.pluginId, authorization) : background ? this.background!.approve(entry.pluginId, background) : undefined;
                        try {
                            return { view: clone(await plan.execute(grantId)) };
                        }
                        catch (error) {
                            if (grantId)
                                try {
                                    if (background) this.background!.bind(entry.pluginId, entry.signal).revoke(grantId);
                                    else this.messages.revoke(entry.pluginId, grantId);
                                }
                                catch { }
                            throw error;
                        }
                    });
                    if (plan.preview || authorization || background) {
                        if (this.pending.size >= 100)
                            throw Error('Too many pending confirmations');
                        const preview = clone(plan.preview ?? { title: '授权消息投递 / Authorize messages', fields: [] });
                        if (typeof preview.title !== 'string' || !Array.isArray(preview.fields) || preview.fields.length > 32 || preview.fields.some((f: any) => typeof f?.label !== 'string' || typeof f?.value !== 'string'))
                            throw Error('Invalid approval preview');
                        preview.fields.push(...authorization?.fields ?? []);
                        preview.fields.push(...background?.fields ?? []);
                        const id = randomUUID();
                        this.pending.set(id, { key, entry, expires: Date.now() + 300000, run });
                        result = { confirmation: { id, preview } };
                    }
                    else
                        result = await run();
                }
            }
            else {
                res.writeHead(405);
                res.end(JSON.stringify({ error: 'Method not allowed' }));
                return true;
            }
            guard();
            res.end(JSON.stringify(result));
        }
        catch (e) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
        return true;
    }
}
