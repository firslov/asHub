import { ConversationEntries, type EntryInput } from './conversation-entries.js';
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
    entryAuthorization?: EntryInput;
    execute(grantId?: string): unknown | Promise<unknown>;
}
export interface PluginResource {
    remote?: { conversationId(): string | null; actions: string[] };
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
        context: string;
        entry: object;
        expires: number;
        run: () => Promise<unknown>;
        result?: Promise<unknown>;
    }>();
    constructor(private messages: ExtensionMessages, private requireActive: (pluginId: string) => void, private signal: AbortSignal, private run: <T>(pluginId: string, action: () => T | Promise<T>) => Promise<T> = async (_id, action) => action(), private background?: PluginBackground, private conversations?: ConversationEntries) { }
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
    catalog() { return [...this.entries.values()].filter(e=>!e.signal.aborted && e.resource.remote).map(e=>({pluginId:e.pluginId,resourceId:[...this.entries.entries()].find(([,v])=>v===e)![0].split('/')[1],sessionId:e.resource.remote!.conversationId()})); }
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
            const remoteSession = new URL(req.url ?? '/', 'http://localhost').searchParams.get('remoteSession');
            const context = remoteSession === null ? 'desktop' : 'remote:' + remoteSession;
            const guard = () => { if(remoteSession !== null && (!remoteSession || entry.resource.remote?.conversationId() !== remoteSession)) throw Error('Remote resource outside authorized conversation'); this.signal.throwIfAborted(); entry.signal.throwIfAborted(); this.requireActive(entry.pluginId); if (this.entries.get(key) !== entry)
                throw Error('Plugin resource changed'); };
            guard();
            const adapt = (value: any) => {
              if(remoteSession === null || !value?.view)return value;
              const view=clone(value.view),allowed=entry.resource.remote!.actions;let omitted=false;
              const filter=(actions:any[])=>actions.filter(a=>{if(allowed.includes(a.id))return true;omitted=true;return false;});
              view.actions=filter(view.actions??[]);for(const row of view.rows??[])row.actions=filter(row.actions??[]);
              if(view.form && !allowed.includes(view.form.action)){delete view.form;omitted=true;}
              if(omitted)view.note=(view.note??'')+'\n授权与首次设置请在桌面端完成';
              return {...value,view};
            };
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
                    if (!p || p.key !== key || p.context !== context || p.entry !== entry || p.expires < Date.now())
                        throw Error('Confirmation expired; review again');
                    p.result ??= Promise.resolve().then(p.run);
                    result = await p.result;
                }
                else {
                    if (!identifier(input.action) || !input.values || typeof input.values !== 'object' || Array.isArray(input.values))
                        throw Error('Invalid action');
                    if (remoteSession !== null && !entry.resource.remote?.actions.includes(input.action)) throw Error('请在桌面端完成此操作');
                    const plan = await entry.resource.prepare(input.action, clone(input.values));
                    guard();
                    if (!plan || typeof plan.execute !== 'function')
                        throw Error('Invalid action plan');
                    if (remoteSession !== null && (plan.authorization || plan.backgroundAuthorization || plan.entryAuthorization)) throw Error('请在桌面端确认授权');
                    if ([plan.authorization,plan.backgroundAuthorization,plan.entryAuthorization].filter(Boolean).length > 1) throw Error('Conflicting authorizations');
                    const conversation = plan.entryAuthorization ? await this.conversations?.prepare(entry.pluginId,plan.entryAuthorization) : undefined;
                    if (plan.entryAuthorization && !conversation) throw Error('Conversation entries unavailable');
                    const authorization = plan.authorization ? this.messages.prepare(entry.pluginId, plan.authorization) : undefined;
                    if (plan.authorization && plan.backgroundAuthorization) throw Error('Conflicting authorizations');
                    if (plan.backgroundAuthorization && !this.background) throw Error('Background services unavailable');
                    const background = plan.backgroundAuthorization ? this.background!.prepare(entry.pluginId, plan.backgroundAuthorization) : undefined;
                    const run = () => this.run(entry.pluginId, async () => {
                        guard();
                        const grantId = conversation ? await this.conversations!.approve(entry.pluginId,conversation) : authorization ? this.messages.approve(entry.pluginId, authorization) : background ? this.background!.approve(entry.pluginId, background) : undefined;
                        try {
                            return { view: clone(await plan.execute(grantId)) };
                        }
                        catch (error) {
                            if (grantId && !conversation)
                                try {
                                    if (background) this.background!.bind(entry.pluginId, entry.signal).revoke(grantId);
                                    else this.messages.revoke(entry.pluginId, grantId);
                                }
                                catch { }
                            throw error;
                        }
                    });
                    if (plan.preview || authorization || background || conversation) {
                        if (this.pending.size >= 100)
                            throw Error('Too many pending confirmations');
                        const preview = clone(plan.preview ?? { title: '授权消息投递 / Authorize messages', fields: [] });
                        if (typeof preview.title !== 'string' || !Array.isArray(preview.fields) || preview.fields.length > 32 || preview.fields.some((f: any) => typeof f?.label !== 'string' || typeof f?.value !== 'string'))
                            throw Error('Invalid approval preview');
                        preview.fields.push(...authorization?.fields ?? []);
                        preview.fields.push(...background?.fields ?? []);
                        // Only the host can collapse its authorization diagnostics.
                        delete preview.details;
                        if (background?.details) preview.details = background.details;
                        preview.fields.push(...conversation?.fields ?? []);
                        const id = randomUUID();
                        this.pending.set(id, { key, context, entry, expires: Date.now() + 300000, run });
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
            res.end(JSON.stringify(adapt(result)));
        }
        catch (e) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        }
        return true;
    }
}
