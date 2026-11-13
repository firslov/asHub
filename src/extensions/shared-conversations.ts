import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openArtifact } from '../artifacts.js';

export interface SharingInput { roots: string[] }
type Grant = { pluginId: string; roots: string[] };
const fail = (message: string, status = 403) => Object.assign(new Error(message), { status });
const sid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{4,32}$/.test(value);
/** Host-owned directory grants and a bounded conversation API. No accounts,
 * gateway addresses, sockets or device identities are known to this service. */
export class SharedConversations {
    private grants: Record<string, Grant> = {};
    private fault: unknown;
    private base = '';
    private statuses = new Map<string, { signal: AbortSignal; read: () => any }>();
    private channels = new Map<string, Set<AbortController>>();
    constructor(private file: string, private token: string | undefined) {
        try {
            if (fs.existsSync(file)) this.grants = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!this.grants || typeof this.grants !== 'object' || Array.isArray(this.grants)
                || Object.values(this.grants).some(g => !g || typeof g.pluginId !== 'string' || !Array.isArray(g.roots) || g.roots.some(r => typeof r !== 'string' || !path.isAbsolute(r)))) throw Error('Invalid sharing grants');
        } catch (e) { this.fault = e; this.grants = {}; }
    }
    start(port: number) { this.base = 'http://127.0.0.1:' + port; }
    private save() {
        if (this.fault) throw this.fault;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.grants), { mode: 0o600, flush: true });
        fs.renameSync(this.file + '.tmp', this.file);
    }
    prepare(pluginId: string, input: SharingInput) {
        if (this.fault) throw this.fault;
        if (!input || Object.keys(input).some(k => k !== 'roots') || !Array.isArray(input.roots) || !input.roots.length || input.roots.length > 20) throw fail('请选择需要共享的目录', 400);
        const roots = [...new Set(input.roots.map(r => {
            if (typeof r !== 'string' || !path.isAbsolute(r)) throw fail('共享目录必须使用绝对路径', 400);
            const real = fs.realpathSync(r); if (!fs.statSync(real).isDirectory()) throw fail('共享目录不可用', 400); return real;
        }))];
        return { pluginId, roots, fields: [{ label: '允许访问本机', value: roots.join('\n') }, { label: '访问范围', value: '仅这些目录中的对话、消息、模型选择及成果文件；不开放本机设置、终端或持续授权。目录范围用于筛选对话，不是工具执行沙箱。' }] };
    }
    approve(pluginId: string, plan: ReturnType<SharedConversations['prepare']>) {
        if (plan.pluginId !== pluginId) throw fail('Sharing owner changed');
        const checked = this.prepare(pluginId, { roots: plan.roots });
        if (JSON.stringify(checked.roots) !== JSON.stringify(plan.roots)) throw fail('共享目录已变更，请重新确认');
        return this.importGrant(pluginId, plan.roots);
    }
    /** Migration-only: preserve the exact previously approved scope, including
     * temporarily unavailable directories. Never called by plugin services. */
    importGrant(pluginId: string, roots: string[]) {
        if (!roots.length || roots.some(r => typeof r !== 'string' || !path.isAbsolute(r))) throw fail('Invalid legacy sharing scope');
        const id = randomUUID(); this.grants[id] = { pluginId, roots: [...roots] };
        try { this.save(); } catch (e) { delete this.grants[id]; throw e; } return id;
    }
    revoke(pluginId: string, id: string) {
        if (this.grants[id]?.pluginId !== pluginId) return;
        const previous = this.grants[id]!; delete this.grants[id];
        try { this.save(); } catch (e) { this.grants[id] = previous; throw e; }
        for (const c of this.channels.get(id) || []) c.abort();
    }
    status() {
        for (const source of this.statuses.values()) if (!source.signal.aborted) { try { return source.read(); } catch { } }
        return { available: false, enabled: false, status: 'disabled' };
    }
    bind(pluginId: string, signal: AbortSignal) {
        return Object.freeze({
            scope: (id: string) => { signal.throwIfAborted(); const g = this.grants[id]; return g?.pluginId === pluginId ? [...g.roots] : null; },
            revoke: (id: string) => { signal.throwIfAborted(); this.revoke(pluginId, id); },
            registerStatus: (read: () => any) => {
                signal.throwIfAborted(); const item = { signal, read }; this.statuses.set(pluginId, item);
                signal.addEventListener('abort', () => { if (this.statuses.get(pluginId) === item) this.statuses.delete(pluginId); }, { once: true });
            },
            open: (id: string) => this.open(pluginId, id, signal),
        });
    }
    private open(pluginId: string, id: string, owner: AbortSignal) {
        const grant = this.grants[id], controller = new AbortController();
        const current = () => { owner.throwIfAborted(); controller.signal.throwIfAborted(); if (!this.base || !grant || grant.pluginId !== pluginId || this.grants[id] !== grant) throw fail('本机会话访问授权已失效'); };
        current();
        const active = this.channels.get(id) || new Set<AbortController>(); active.add(controller); this.channels.set(id, active);
        const close = () => { controller.abort(); active.delete(controller); if (!active.size) this.channels.delete(id); owner.removeEventListener('abort', close); };
        owner.addEventListener('abort', close, { once: true });
        const inside = (cwd: string) => {
            try { const real = fs.realpathSync(cwd); return grant.roots.some(root => { const relative = path.relative(root, real); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }); } catch { return false; }
        };
        const fetchLocal = async (route: string, body?: any, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal) => {
            current();
            const r = await fetch(this.base + route, { method, headers: { ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([owner, controller.signal, signal || AbortSignal.timeout(/^\/[a-f0-9]{4,32}\/submit$/.test(route) ? 24 * 3600000 : 20000)]), redirect: 'error' });
            current(); return r;
        };
        const json = async (route: string, body?: any, method?: string) => { const r = await fetchLocal(route, body, method); const text = await r.text(); current(); if (!r.ok) throw fail(text.slice(0, 400), r.status); try { return JSON.parse(text); } catch { return { ok: true }; } };
        const sessions = async () => (await json('/sessions')).filter((s: any) => s.kind === 'agent' && inside(s.cwd));
        const session = async (value: unknown) => { if (!sid(value)) throw fail('会话无效'); const s = (await sessions()).find((s: any) => s.instanceId === value); current(); if (!s) throw fail('会话不在授权目录内'); return s; };
        const groups = async () => { const ids = new Set((await sessions()).map((s: any) => s.instanceId)); return (await json('/api/projects')).map((p: any) => ({ id:p.id, name:p.name, sessionIds: p.sessionIds.filter((s: string) => ids.has(s)), pinnedSessionIds: (p.pinnedSessionIds || []).filter((s: string) => ids.has(s)), activities: (p.activities || []).filter((a: any) => ids.has(a.sessionId)) })).filter((p: any) => p.sessionIds.length); };
        const request = async (route: string, body?: any, method = body === undefined ? 'GET' : 'POST') => {
            current(); if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || route.includes('\\')) throw fail('Unsupported conversation route');
            const u = new URL(route, this.base), p = u.pathname;
            if (route === '/sessions' && method === 'GET') return sessions();
            if (route === '/sessions' && method === 'POST') {
                if (!body || body.kind !== 'agent' || typeof body.cwd !== 'string' || !grant.roots.includes(fs.realpathSync(body.cwd)) || Object.keys(body).some(k => !['cwd', 'kind'].includes(k))) throw fail('创建目录未授权');
                return json(route, { cwd: fs.realpathSync(body.cwd), kind: 'agent' });
            }
            if (route === '/api/models' && method === 'GET') return json(route);
            if (route === '/api/projects' && method === 'GET') return groups();
            if (p === '/api/projects/tasks' && method === 'GET') {
                const group = (await groups()).find((g: any) => g.id === u.searchParams.get('projectId')); if (!group) throw fail('项目未授权');
                const all = (await json('/api/projects/tasks?projectId=' + encodeURIComponent(group.id))).filter((t: any) => group.sessionIds.includes(t.sourceId) && group.sessionIds.includes(t.recipientId));
                const task = u.searchParams.get('taskId'); if (!task) return all;
                if (!all.some((t: any) => t.id === task)) throw fail('任务未授权');
                const result = await json(route); const latest = (await groups()).find((g: any) => g.id === group.id), selected = all.find((t: any) => t.id === task);
                if (!latest?.sessionIds.includes(selected.sourceId) || !latest.sessionIds.includes(selected.recipientId)) throw fail('任务授权已变更'); return result;
            }
            if (['/api/plugin-conversations', '/api/plugin-resource-catalog'].includes(route) && method === 'GET') { const ids = new Set((await sessions()).map((s: any) => s.instanceId)); return (await json(route)).filter((e: any) => ids.has(e.sessionId)); }
            if (/^\/api\/plugin-resources\/[a-z0-9-]+\/[a-z0-9-]+$/.test(p) && ['GET','POST'].includes(method)) { await session(u.searchParams.get('remoteSession')); return json(route, body, method); }
            if (route === '/api/settings/network') {
                if (method === 'GET') { const policy = await json(route), ids = new Set((await sessions()).map((s: any) => s.instanceId)); return { proxyEnabled: policy.proxyEnabled, sessions: Object.fromEntries(Object.entries(policy.sessions || {}).filter(([s]) => ids.has(s))) }; }
                if (method === 'PUT' && body && Object.keys(body).every(k => ['session', 'enabled'].includes(k)) && (body.enabled === null || typeof body.enabled === 'boolean')) { await session(body.session); await json(route, body, method); return request(route); }
                throw fail('禁止修改全局网络设置');
            }
            if (route === '/api/permission/decide' && method === 'POST') {
                await session(body?.sessionId); if (!['approved','denied'].includes(body.outcome) || body.sessionWide !== false || body.onceOnly !== true) throw fail('仅支持单次授权');
                return json(route, { sessionId: body.sessionId, requestId: body.requestId, outcome: body.outcome, sessionWide: false, onceOnly: true });
            }
            const match = /^\/([a-f0-9]{4,32})(\/.*)$/.exec(p);
            if (!match) throw fail('Unsupported conversation route');
            await session(match[1]);
            const allowed: Record<string, string[]> = { '/': ['DELETE'], '/submit': ['POST'], '/cancel': ['POST'], '/queue': ['GET'], '/queue/update': ['POST'], '/queue/withdraw': ['POST'], '/thinking': ['GET','POST'], '/model': ['PUT'] };
            if (method === 'GET' && /^\/image-resources\/[a-f0-9]{64}$/.test(match[2]!)) return json(route);
            if (!allowed[match[2]!]?.includes(method)) throw fail('Unsupported conversation operation');
            if (match[2] === '/submit' && (typeof body?.query !== 'string' || /^\s*[!/]/.test(body.query) || Object.keys(body).some(k => !['query','images','delivery'].includes(k)))) throw fail('仅允许普通对话消息');
            return json(route, body, method);
        };
        return Object.freeze({
            roots: [...grant.roots], close, request,
            openArtifact: async (id: string, requested: string) => { const s = await session(id); const opened = await openArtifact(s.cwd, requested); try { current(); return opened; } catch (e) { await opened.file.close(); throw e; } },
            image: async (id: string, imageId: string) => { await session(id); if (!new RegExp(`^${id}_img_[a-z0-9]+_[a-z0-9]+$`).test(imageId)) throw fail('图片不属于此对话'); return fetchLocal('/api/uploads/' + imageId); },
            events: async (id: string, recent: boolean, signal: AbortSignal) => {
                await session(id); const combined = AbortSignal.any([owner, controller.signal, signal]);
                const abort = new AbortController(), streamSignal = AbortSignal.any([combined, abort.signal]);
                const response=await fetchLocal(`/events?subs=${id}:all${recent ? '&view=mobile' : ''}`, undefined, 'GET', streamSignal);
                if(!response.ok || !response.body) return response;
                const reader=response.body.getReader(), decoder=new TextDecoder(), encoder=new TextEncoder();let buffer='';
                const timer=setInterval(()=>{void session(id).catch(()=>abort.abort());},15000);
                const finish=()=>{clearInterval(timer);abort.abort();};
                const body=new ReadableStream<Uint8Array>({
                    async pull(output) {
                        try {
                            // A pending read will not pull again if this pull produces no chunk.
                            // Keep reading when a network chunk is partial or entirely filtered.
                            while (true) {
                                current(); streamSignal.throwIfAborted();
                                const {value,done}=await reader.read();
                                current(); streamSignal.throwIfAborted();
                                if(done){finish();output.close();return;}
                                buffer+=decoder.decode(value,{stream:true});if(buffer.length>6*1024*1024)throw fail('Event too large');
                                let end;let outgoing='';
                                while((end=buffer.indexOf('\n\n'))>=0){
                                    const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
                                    const data=frame.split('\n').find(l=>l.startsWith('data: '));
                                    if(data){const event=JSON.parse(data.slice(6)), name=event.meta?.name;
                                        if(event.meta?.source && event.meta.source!==id)continue;
                                        if(name==='shell:cwd-change'&&!inside(event.payload?.cwd||''))throw fail('Conversation moved outside sharing scope');
                                        if(['shell:pty-data','shell:output','pty:data','pty:resize'].includes(name)||name?.startsWith('terminal:'))continue;
                                    }
                                    outgoing+=frame+'\n\n';
                                }
                                if(outgoing){output.enqueue(encoder.encode(outgoing));return;}
                            }
                        }catch(e){finish();output.error(e);}
                    },cancel(){finish();void reader.cancel().catch(()=>{});},
                });
                return new Response(body,{status:response.status,headers:response.headers});
            },
        });
    }
}
