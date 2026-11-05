import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MessageEntry, SessionStore } from '../history/session-store.js';
import { extractText, stripContextWrappers, isSystemNoteMessage } from '../history/summarize.js';
import { unicodeSlice } from '../unicode.js';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export interface BackgroundGrantInput { modelSessionId: string; includeHistory: boolean; excludedIds: string[]; dailyCalls: number }
interface Target { id: string; cwd: string; title: string; model?: string; provider?: string; projectId?: string | null; busy: boolean }
interface Grant extends BackgroundGrantInput { id: string; pluginId: string; since: number; modelBinding: string; day: string; calls: number }
export interface BackgroundRuntime {
  targets(): Target[];
  store(id: string): SessionStore | undefined;
  complete(id: string, messages: Array<{role: string; content: string}>, signal: AbortSignal): Promise<string>;
}
/** Generic authorized history reads and bounded tool-free inference. Learning policy belongs to plugins. */
export class PluginBackground {
  private grants: Grant[];
  private running = new Map<string, AbortController>();
  private fault: unknown;
  private historyCache = new Map<string, { store: SessionStore; revision: number; leaf: string; entries: MessageEntry[]; ids: Set<string> }>();
  constructor(private file: string, private runtime: BackgroundRuntime, private signal: AbortSignal) {
    let state;
    try { state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, grants: [] };
    if (state.version !== 1 || !Array.isArray(state.grants) || state.grants.length > 100) throw Error('Invalid background grants');
    if (state.grants.some((g: Grant) => !g || typeof g.id !== 'string' || typeof g.pluginId !== 'string' || typeof g.modelBinding !== 'string' || !Number.isSafeInteger(g.since) || !Number.isInteger(g.calls) || g.calls < 0 || !Number.isInteger(g.dailyCalls) || g.dailyCalls < 1 || g.dailyCalls > 24 || !Array.isArray(g.excludedIds))) throw Error('Invalid background grant');
    this.grants = state.grants;
    } catch (error) { this.fault = error; this.grants = []; }
    signal.addEventListener('abort', () => { for (const c of this.running.values()) c.abort(); }, { once: true });
  }
  private save() {
    if (this.fault) throw this.fault;
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify({ version: 1, grants: this.grants }), { mode: 0o600, flush: true }); fs.renameSync(tmp, this.file); }
    catch (e) { this.fault = e; for (const c of this.running.values()) c.abort(); throw e; }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  private binding(t: Target) { return JSON.stringify([t.id, t.cwd, t.provider, t.model]); }
  prepare(pluginId: string, input: BackgroundGrantInput) {
    this.signal.throwIfAborted(); if (this.fault) throw this.fault;
    if (!input || typeof input.modelSessionId !== 'string' || typeof input.includeHistory !== 'boolean'
      || !Number.isInteger(input.dailyCalls) || input.dailyCalls < 1 || input.dailyCalls > 24
      || !Array.isArray(input.excludedIds) || input.excludedIds.length > 1000 || input.excludedIds.some(id => typeof id !== 'string' || !/^[-a-zA-Z0-9]+$/.test(id))) throw Error('Invalid background authorization');
    const model = this.runtime.targets().find(t => t.id === input.modelSessionId);
    if (!model?.model || !model.provider) throw Error('请选择已配置模型的 agent 对话');
    const grant: Grant = { ...copy(input), id: randomUUID(), pluginId, since: input.includeHistory ? 0 : Date.now(), modelBinding: this.binding(model), day: '', calls: 0 };
    return { grant, previous: this.grants.find(g => g.pluginId === pluginId)?.id, fields: [
      { label: '观察范围', value: '全部现有及未来的活动 agent 对话（排除所选对话）；归档、终端和附件内容不读取' },
      { label: '历史范围', value: input.includeHistory ? '包含已有持久化历史' : '仅从本次授权起新增的持久化消息' },
      { label: '排除对话', value: input.excludedIds.join(', ') || '无' },
      { label: '后台模型', value: `${model.provider} / ${model.model} · ${model.title}` },
      { label: '成本上限', value: `每天最多 ${input.dailyCalls} 次；每次输入最多 16000 字符，输出预算 4096 tokens。可能产生模型费用，不执行工具。失败请求也计入次数` },
    ] };
  }
  approve(pluginId: string, plan: ReturnType<PluginBackground['prepare']>) {
    this.signal.throwIfAborted();
    if (pluginId !== plan.grant.pluginId || this.grants.find(g => g.pluginId === pluginId)?.id !== plan.previous) throw Error('Background authorization changed');
    const model = this.runtime.targets().find(t => t.id === plan.grant.modelSessionId);
    if (!model || this.binding(model) !== plan.grant.modelBinding) throw Error('后台模型配置已变化，请重新确认');
    if (this.grants.length >= 100 && !plan.previous) throw Error('Too many background grants');
    this.running.get(pluginId)?.abort();
    this.grants = [...this.grants.filter(g => g.pluginId !== pluginId), copy(plan.grant)]; this.save(); return plan.grant.id;
  }
  private get(pluginId: string, id: string, signal: AbortSignal) {
    this.signal.throwIfAborted(); signal.throwIfAborted(); if (this.fault) throw this.fault;
    const g = this.grants.find(g => g.pluginId === pluginId && g.id === id); if (!g) throw Error('后台授权已撤销或不存在'); return g;
  }
  bind(pluginId: string, signal: AbortSignal) {
    const get = (id: string) => this.get(pluginId, id, signal);
    const target = (g: Grant, id: string) => {
      const t = this.runtime.targets().find(t => t.id === id);
      if (!t || g.excludedIds.includes(id)) throw Error('Conversation outside background authorization'); return t;
    };
    const entries = (g: Grant, id: string) => {
      target(g, id); const store = this.runtime.store(id); if (!store) throw Error('Persisted history unavailable');
      const prior = this.historyCache.get(id), revision = store.getRevision(), leaf = store.getActiveLeaf();
      if (prior?.store === store && prior.revision === revision && prior.leaf === leaf) return prior.entries;
      const rows = store.getHistoryEntries(); this.historyCache.set(id, { store, revision, leaf, entries: rows, ids: new Set(rows.map(e => e.id)) });
      if (this.historyCache.size > 64) this.historyCache.delete(this.historyCache.keys().next().value!);
      return rows;
    };
    return Object.freeze({
      status: (id: string) => { const g = get(id); return { ...copy(g), modelBinding: undefined }; },
      targets: (id: string) => { const g = get(id); return this.runtime.targets().filter(t => !g.excludedIds.includes(t.id)).map(t => ({ ...t })); },
      revoke: (id: string) => { get(id); this.running.get(pluginId)?.abort(); this.grants = this.grants.filter(g => g.id !== id); this.save(); },
      valid: (id: string, conversationId: string, sourceIds: string[]) => {
        const g = get(id); if (!Array.isArray(sourceIds) || sourceIds.length > 200) throw Error('Invalid source IDs');
        entries(g, conversationId); const allowed = this.historyCache.get(conversationId)!.ids; return sourceIds.filter(x => allowed.has(x));
      },
      read: (id: string, conversationId: string, cursor?: string) => {
        const g = get(id), t = target(g, conversationId), all = entries(g, conversationId);
        const index = cursor ? all.findIndex(e => e.id === cursor) : -1;
        const page = all.slice(index + 1, index + 41);
        const rows = page.filter(e => e.timestamp >= g.since && !isSystemNoteMessage(e.message)).map((e: MessageEntry) => {
          const text = stripContextWrappers(extractText(e.message.content));
          const generated = /^\[(?:Cross-conversation message|插件任务|Compacted conversation|Context checkpoint)/.test(text);
          return { id: e.id, at: e.timestamp, role: generated ? 'generated' : e.message.role,
            text: unicodeSlice(text, 0, 3000), truncated: text.length > 3000 };
        });
        return { target: { ...t }, entries: rows, cursor: page.at(-1)?.id ?? (index >= 0 ? cursor : null) ?? null, reset: !!cursor && index < 0, more: index + 1 + page.length < all.length };
      },
      infer: async (id: string, messages: Array<{role: string; content: string}>, cancellation?: AbortSignal) => {
        const g = get(id), model = this.runtime.targets().find(t => t.id === g.modelSessionId);
        if (!model) throw Error('后台模型不可用');
        if (this.binding(model) !== g.modelBinding) throw Error('后台模型配置已变化，请重新授权');
        if (model.busy || this.running.has(pluginId)) throw Error('后台模型忙碌，稍后重试');
        if (!Array.isArray(messages) || !messages.length || messages.length > 8 || messages.some(m => !m || !['system','user'].includes(m.role) || typeof m.content !== 'string') || JSON.stringify(messages).length > 16000) throw Error('Background request exceeds input limits');
        const day = new Date().toISOString().slice(0, 10);
        if (g.day !== day) { g.day = day; g.calls = 0; }
        if (g.calls >= g.dailyCalls) throw Error('今日后台整理额度已用完');
        const c = new AbortController(), combined = AbortSignal.any([this.signal, signal, c.signal, ...(cancellation ? [cancellation] : [])]);
        combined.throwIfAborted(); this.running.set(pluginId, c);
        try { g.calls++; this.save(); const result = await this.runtime.complete(model.id, messages, combined); combined.throwIfAborted(); get(id); return result; }
        finally { if (this.running.get(pluginId) === c) this.running.delete(pluginId); }
      },
    });
  }
}
