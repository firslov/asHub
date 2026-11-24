import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MessageEntry, SessionStore } from '../history/session-store.js';
import type { SummaryUsage } from '../history/summary-client.js';
import { extractText, stripContextWrappers, isSystemNoteMessage } from '../history/summarize.js';
import { unicodeSlice } from '../unicode.js';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export interface BackgroundModel { provider: string; model: string }
interface BackgroundEndpoint { identity: string; origin: string }
export interface BackgroundModelChange { grantId: string; model: BackgroundModel | null }
export interface BackgroundGrantInput { modelSessionId: string; includeHistory: boolean; excludedIds: string[]; includedIds?: string[]; dailyCalls: number; followModel?: boolean }
interface Target { id: string; cwd: string; title: string; model?: string; provider?: string; projectId?: string | null; busy: boolean }
interface Grant extends BackgroundGrantInput { id: string; pluginId: string; since: number; modelBinding: string; day: string; calls: number; backgroundModel?: BackgroundModel | null; modelRevision?: number; backgroundEndpoint?: BackgroundEndpoint; observedForeground?: string }
interface TokenUsage extends SummaryUsage { reportedCalls: number }
interface Usage { pluginId: string; day: string; calls: number; tokenUsage?: TokenUsage }
interface HistoryView {
  store: SessionStore;
  revision: number;
  leaf: string;
  entries: MessageEntry[];
  positions: Map<string, number>;
}
interface BackgroundPreview { fields: Array<{label: string; value: string}>; details?: Array<{label: string; value: string}> }
const utcDay = () => new Date().toISOString().slice(0, 10);
const foregroundIdentity = (provider: string | undefined, model: string | undefined) =>
  createHash('sha256').update(JSON.stringify([provider,model])).digest('hex');
const modelDescriptor = (value: unknown): value is BackgroundModel => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v=value as Record<string,unknown>;
  return Object.keys(v).length===2 && typeof v.provider==='string' && v.provider.trim()===v.provider && v.provider.length>0 && v.provider.length<=200 && typeof v.model==='string' && v.model.trim()===v.model && v.model.length>0 && v.model.length<=200;
};
const endpointDescriptor = (value: unknown): value is BackgroundEndpoint => {
  if(!value || typeof value!=='object' || Array.isArray(value))return false;
  const v=value as Record<string,unknown>;if(typeof v.identity!=='string' || !/^[0-9a-f]{64}$/.test(v.identity) || typeof v.origin!=='string')return false;
  try {const u=new URL(v.origin);return ['http:','https:'].includes(u.protocol) && u.origin===v.origin && !u.username && !u.password;}catch{return false;}
};
const validDay = (day: unknown) => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0,10) === day;
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validTokens = (usage: SummaryUsage | undefined) => !!usage && count(usage.inputTokens) && count(usage.outputTokens);
export interface BackgroundRuntime {
  targets(): Target[];
  store(id: string): SessionStore | undefined;
  complete(id: string, messages: Array<{role: string; content: string}>, signal: AbortSignal, onUsage?: (usage: SummaryUsage) => void): Promise<string>;
  supportsSpecified?(id: string): boolean;
  models?(id: string): BackgroundModel[] | Promise<BackgroundModel[]>;
  describeSpecified?(id: string, selection: BackgroundModel): Promise<BackgroundEndpoint | null>;
  completeSpecified?(id: string, messages: Array<{role: string; content: string}>, signal: AbortSignal, selection: BackgroundModel, expectedIdentity?: string, onUsage?: (usage: SummaryUsage) => void): Promise<string>;
}
/** Host-owned disclosures shared by existing and newly created conversation grants.
 * This describes access and cost, never a plugin's purpose or storage policy. */
export function singleConversationBackgroundPreview(
  input: Pick<BackgroundGrantInput, 'includeHistory' | 'dailyCalls' | 'followModel'>,
  model: Pick<Target, 'title' | 'model' | 'provider'>,
  createsConversation = false,
  historyStart: 'preview' | 'confirmation' = 'preview',
) {
  // Combined entry grants are prepared only after confirmation creates/resolves
  // their conversation; ordinary grants are prepared with the preview itself.
  const history = input.includeHistory ? '包括已有聊天记录及后续消息'
    : `仅包含本次${historyStart === 'confirmation' ? '确认生效时' : '确认预览生成时'}起的新消息，确认后才获得读取权`;
  return {
    fields: [
      { label: '读取范围', value: `仅处理${createsConversation ? '本次新建的' : ''}「${model.title || '此对话'}」对话，${history}；不读取其他对话` },
      { label: '后台模型', value: input.followModel ? `跟随此对话当前选择的模型与 VPN，包括今后切换的模型服务；当前 ${model.model} · ${model.provider}` : `${model.model} · ${model.provider}` },
      { label: '使用额度', value: `每天最多 ${input.dailyCalls} 次后台处理，失败也计入次数；可能产生模型费用，不执行工具，可随时撤销授权` },
    ],
    details: [{ label: '单次请求上限', value: '输入最多 16000 字符，输出预算 4096 tokens' }],
  };
}
/** Generic authorized history reads and bounded tool-free inference. Learning policy belongs to plugins. */
export class PluginBackground {
  private grants: Grant[];
  // Authorization can be replaced/revoked independently of work already paid
  // for. Keep one daily usage record per plugin, including revoked plugins.
  private usage = new Map<string, Usage>();
  private running = new Map<string, AbortController>();
  private fault: unknown;
  private historyCache = new Map<string, HistoryView>();
  constructor(private file: string, private runtime: BackgroundRuntime, private signal: AbortSignal) {
    let state;
    try { state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 2, grants: [], usage: [] };
    if (![1,2].includes(state.version) || !Array.isArray(state.grants) || state.grants.length > 100) throw Error('Invalid background grants');
    if (state.grants.some((g: Grant) => !g || typeof g.id !== 'string' || typeof g.pluginId !== 'string' || typeof g.modelBinding !== 'string' || (g.followModel !== undefined && typeof g.followModel !== 'boolean') || (g.modelRevision !== undefined && (!Number.isSafeInteger(g.modelRevision) || g.modelRevision < 0)) || (g.backgroundModel !== undefined && g.backgroundModel !== null && !modelDescriptor(g.backgroundModel)) || !Number.isSafeInteger(g.since) || !Number.isSafeInteger(g.calls) || g.calls < 0 || (g.day !== '' && !validDay(g.day)) || (g.calls > 0 && !validDay(g.day)) || !Number.isInteger(g.dailyCalls) || g.dailyCalls < 1 || g.dailyCalls > 24 || !Array.isArray(g.excludedIds) || (g.includedIds !== undefined && (!Array.isArray(g.includedIds) || !g.includedIds.length || g.includedIds.some(id=>typeof id!=='string'||!/^[-a-zA-Z0-9]+$/.test(id)))))) throw Error('Invalid background grant');
    if (state.grants.some((g: Grant) => g.backgroundModel !== undefined && ((g.backgroundModel === null ? g.followModel !== true || g.backgroundEndpoint !== undefined : g.followModel !== false || !endpointDescriptor(g.backgroundEndpoint)) || g.includedIds?.length !== 1 || g.includedIds[0] !== g.modelSessionId || g.excludedIds.length !== 0 || !Number.isSafeInteger(g.modelRevision) || g.modelRevision! < 1))) throw Error('Invalid persisted model policy');
    if (state.grants.some((g: Grant) => g.backgroundEndpoint !== undefined && (g.backgroundModel === undefined || g.backgroundModel === null))) throw Error('Invalid persisted model policy');
    if (state.grants.some((g: Grant) => g.observedForeground !== undefined && (typeof g.observedForeground !== 'string' || !/^[0-9a-f]{64}$/.test(g.observedForeground) || g.backgroundModel))) throw Error('Invalid persisted foreground model');
    if (new Set(state.grants.map((g: Grant) => g.pluginId)).size !== state.grants.length) throw Error('Duplicate background grants');
    if (state.version === 2) {
      if (!Array.isArray(state.usage) || state.usage.length > 10000 || state.usage.some((u: Usage) => !u || typeof u.pluginId !== 'string' || !validDay(u.day) || !Number.isSafeInteger(u.calls) || u.calls < 0)) throw Error('Invalid background usage');
      for (const u of state.usage as Usage[]) {
        if (this.usage.has(u.pluginId)) throw Error('Duplicate background usage');
        // Optional diagnostics can be discarded without affecting the quota.
        if (u.tokenUsage !== undefined && (!validTokens(u.tokenUsage) || !count(u.tokenUsage.reportedCalls)
          || u.tokenUsage.reportedCalls < 1 || u.tokenUsage.reportedCalls > u.calls)) delete u.tokenUsage;
        this.usage.set(u.pluginId, u);
      }
    }
    // Version 1 stored usage on the currently approved grant. Preserve every
    // known call when migrating, including before a revoke/renew operation.
    // Version 2 mirrors counts onto grants for diagnostics; a missing/lower
    // ledger value must never silently replenish the allowance.
    for (const g of state.grants as Grant[]) if (g.day) {
      const u = this.usage.get(g.pluginId);
      if (state.version === 2 && (!u || (u.day === g.day && u.calls < g.calls) || u.day < g.day)) throw Error('Inconsistent background usage');
      if (state.version === 1) this.usage.set(g.pluginId, { pluginId:g.pluginId, day:g.day, calls:g.calls });
    }
    this.grants = state.grants;
    } catch (error) { this.fault = error; this.grants = []; this.usage.clear(); }
    signal.addEventListener('abort', () => { for (const c of this.running.values()) c.abort(); }, { once: true });
  }
  private save(required = true) {
    if (this.fault) throw this.fault;
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify({ version: 2, grants: this.grants, usage: [...this.usage.values()] }), { mode: 0o600, flush: true }); fs.renameSync(tmp, this.file); }
    catch (e) {
      if (required) {
        this.fault = e;
        for (const c of this.running.values()) c.abort();
        throw e;
      }
    }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  private currentUsage(pluginId: string): Usage {
    const day = utcDay(), prior = this.usage.get(pluginId);
    return prior?.day === day ? copy(prior) : { pluginId, day, calls: 0 };
  }
  private recordTokens(pluginId: string, day: string, observed: SummaryUsage) {
    const usage = this.usage.get(pluginId);
    if (this.fault || usage?.day !== day) return;
    const previous = usage.tokenUsage;
    const tokenUsage = {
      inputTokens: (previous?.inputTokens ?? 0) + observed.inputTokens,
      outputTokens: (previous?.outputTokens ?? 0) + observed.outputTokens,
      reportedCalls: (previous?.reportedCalls ?? 0) + 1,
    };
    if (!validTokens(tokenUsage) || tokenUsage.reportedCalls > usage.calls) return;
    this.usage.set(pluginId, { ...usage, tokenUsage });
    // The quota was already persisted before dispatch. A statistics write
    // must never invalidate a paid reply or disable existing authorizations.
    this.save(false);
  }
  private binding(t: Target) { return JSON.stringify([t.id, t.cwd, t.provider, t.model]); }
  noteForegroundModelChange(id: string, cwd: string, provider: string | undefined, model: string | undefined) {
    if (this.fault || this.signal.aborted || !provider || !model) return;
    let changed = false;
    let current: string | undefined;
    for (const g of this.grants) {
      if (g.modelSessionId !== id || g.backgroundModel) continue;
      const [owner, directory, originalProvider, originalModel] = JSON.parse(g.modelBinding);
      if (owner !== id || directory !== cwd) continue;
      current ??= foregroundIdentity(provider,model);
      const previous = g.observedForeground ?? foregroundIdentity(originalProvider,originalModel);
      if (current === previous) continue;
      if ((g.modelRevision ?? 0) >= Number.MAX_SAFE_INTEGER) throw Error('后台模型版本已达上限');
      g.observedForeground = current;
      g.modelRevision = (g.modelRevision ?? 0) + 1;
      this.running.get(g.pluginId)?.abort();
      changed = true;
    }
    if (changed) this.save();
  }
  private async modelOptions(g: Grant): Promise<BackgroundModel[]> {
    if (!this.runtime.models || !this.runtime.completeSpecified || !this.runtime.describeSpecified) return [];
    const values=await this.runtime.models(g.modelSessionId);
    if (!Array.isArray(values) || values.length>1000) throw Error('后台模型列表不可用');
    const seen=new Set<string>(), result: BackgroundModel[]=[];
    for (const value of values) {
      // Runtime adapters may have private fields; never return them to plugins.
      if (!value || typeof value.provider!=='string' || typeof value.model!=='string') continue;
      const safe={provider:value.provider,model:value.model};
      if (!modelDescriptor(safe)) continue;
      const key=JSON.stringify(safe);if(!seen.has(key)){seen.add(key);result.push(safe);}
    }
    return result;
  }
  private async endpoint(g: Grant, model: BackgroundModel): Promise<BackgroundEndpoint> {
    if(!this.runtime.describeSpecified)throw Error('后台模型端点不可用');
    const value=await this.runtime.describeSpecified(g.modelSessionId,model);
    if(!endpointDescriptor(value))throw Error('后台模型端点不可用');
    return {identity:value.identity,origin:value.origin};
  }
  async prepareModelChange(pluginId: string, input: BackgroundModelChange) {
    if (!input || typeof input!=='object' || Object.keys(input).some(k=>!['grantId','model'].includes(k)) || typeof input.grantId!=='string' || !(input.model===null || modelDescriptor(input.model))) throw Error('Invalid background model change');
    const selection=input.model ? copy(input.model) : null;
    const g=this.get(pluginId,input.grantId,this.signal);
    if (g.includedIds?.length!==1 || g.includedIds[0]!==g.modelSessionId || g.excludedIds.length) throw Error('模型设置仅适用于专属对话授权');
    const target=this.runtime.targets().find(t=>t.id===g.modelSessionId);
    if(!target || JSON.stringify([target.id,target.cwd])!==JSON.stringify(JSON.parse(g.modelBinding).slice(0,2)))throw Error('后台授权的对话已变化');
    const revision=g.modelRevision??0, binding=this.binding(target);
    if(selection && !(await this.modelOptions(g)).some(m=>m.provider===selection.provider && m.model===selection.model))throw Error('所选后台模型不可用');
    if(this.get(pluginId,g.id,this.signal)!==g || (g.modelRevision??0)!==revision || this.binding(this.runtime.targets().find(t=>t.id===g.modelSessionId)??{} as Target)!==binding)throw Error('后台授权已变化，请重新确认');
    const endpoint=selection ? await this.endpoint(g,selection) : null;
    if(this.get(pluginId,g.id,this.signal)!==g || (g.modelRevision??0)!==revision || this.binding(this.runtime.targets().find(t=>t.id===g.modelSessionId)??{} as Target)!==binding)throw Error('后台授权已变化，请重新确认');
    return { grantId:g.id, revision, binding, model:selection, endpoint, fields:[{label:'读取范围',value:`仅处理「${target.title || target.id}」对话，${g.includeHistory ? '包括已有聊天记录及后续消息' : '仅包含原授权生效后的消息'}`},{label:'后台模型',value:selection ? `指定 ${selection.provider} / ${selection.model} · ${endpoint?.origin}` : `跟随此对话当前选择的模型与 VPN；当前 ${target.provider} / ${target.model}`},{label:'UTC 日额度',value:`今日已用 ${this.currentUsage(pluginId).calls} / ${g.dailyCalls} 次；失败也计入次数，可能产生模型费用，不执行工具`} ] };
  }
  async approveModelChange(pluginId: string, plan: Awaited<ReturnType<PluginBackground['prepareModelChange']>>, validate: () => void = () => {}) {
    validate();
    const g=this.get(pluginId,plan.grantId,this.signal);
    if ((g.modelRevision??0)!==plan.revision) throw Error('后台模型授权已变化，请重新确认');
    const target=this.runtime.targets().find(t=>t.id===g.modelSessionId);
    if(!target || this.binding(target)!==plan.binding) throw Error('对话模型已变化，请重新确认');
    if(plan.model && !(await this.modelOptions(g)).some(m=>m.provider===plan.model!.provider && m.model===plan.model!.model))throw Error('所选后台模型不可用');
    if(plan.model && JSON.stringify(await this.endpoint(g,plan.model))!==JSON.stringify(plan.endpoint))throw Error('后台模型端点已变化，请重新确认');
    if(this.get(pluginId,g.id,this.signal)!==g || (g.modelRevision??0)!==plan.revision || this.binding(this.runtime.targets().find(t=>t.id===g.modelSessionId)??{} as Target)!==plan.binding)throw Error('后台授权已变化，请重新确认');
    validate();
    if((g.modelRevision??0)>=Number.MAX_SAFE_INTEGER)throw Error('后台模型版本已达上限');
    this.running.get(pluginId)?.abort();
    g.backgroundModel=plan.model ? copy(plan.model) : null;if(plan.endpoint)g.backgroundEndpoint=copy(plan.endpoint);else delete g.backgroundEndpoint;g.followModel=plan.model===null;g.modelBinding=plan.model ? JSON.stringify([target.id,target.cwd]) : this.binding(target);g.modelRevision=(g.modelRevision??0)+1;
    delete g.observedForeground;
    this.save();return g.id;
  }
  prepare(pluginId: string, input: BackgroundGrantInput) {
    this.signal.throwIfAborted(); if (this.fault) throw this.fault;
    if (!input || typeof input.modelSessionId !== 'string' || typeof input.includeHistory !== 'boolean'
      || !Number.isInteger(input.dailyCalls) || input.dailyCalls < 1 || input.dailyCalls > 24
      || !Array.isArray(input.excludedIds) || input.excludedIds.length > 1000 || input.excludedIds.some(id => typeof id !== 'string' || !/^[-a-zA-Z0-9]+$/.test(id))) throw Error('Invalid background authorization');
    if (input.followModel !== undefined && typeof input.followModel !== 'boolean') throw Error('Invalid model policy');
    if (input.followModel && (input.includedIds?.length !== 1 || input.includedIds[0] !== input.modelSessionId || input.excludedIds.length)) throw Error('Following a model requires one dedicated conversation');
    if (input.includedIds !== undefined && (!Array.isArray(input.includedIds) || !input.includedIds.length || input.includedIds.length > 100 || input.includedIds.some(id => typeof id !== 'string' || !/^[-a-zA-Z0-9]+$/.test(id)))) throw Error('Invalid history scope');
    if (input.includedIds?.some(id => !this.runtime.targets().some(t => t.id === id))) throw Error('History target unavailable');
    const model = this.runtime.targets().find(t => t.id === input.modelSessionId);
    if (!model?.model || !model.provider) throw Error('请选择已配置模型的 agent 对话');
    const {day,calls}=this.currentUsage(pluginId);
    const grant: Grant = { modelSessionId:input.modelSessionId, includeHistory:input.includeHistory, excludedIds:[...input.excludedIds], ...(input.includedIds ? {includedIds:[...input.includedIds]} : {}), dailyCalls:input.dailyCalls, ...(input.followModel !== undefined ? {followModel:input.followModel} : {}), id: randomUUID(), since: input.includeHistory ? 0 : Date.now(), modelBinding: this.binding(model), pluginId, day, calls };
    const details = [
      { label: '观察范围', value: input.includedIds ? '仅限指定对话：' + input.includedIds.join(', ') : '全部现有及未来的活动 agent 对话（排除所选对话）；归档、终端和附件内容不读取' },
      { label: '历史范围', value: input.includeHistory ? '包含已有持久化历史' : '仅包含本次确认预览生成时起新增的持久化消息，确认后才获得读取权' },
      { label: '排除对话', value: input.excludedIds.join(', ') || '无' },
      { label: '后台模型', value: `${model.provider} / ${model.model} · ${model.title}` },
      { label: '成本上限', value: `每天最多 ${input.dailyCalls} 次；每次输入最多 16000 字符，输出预算 4096 tokens。可能产生模型费用，不执行工具。失败请求也计入次数` },
    ];
    // Summarize only the unambiguous single-conversation case. Do not repeat
    // scope/history or empty exclusions in details. The stored grant is unchanged.
    const compact = input.includedIds?.length === 1 && input.includedIds[0] === model.id && input.excludedIds.length === 0;
    const preview: BackgroundPreview = compact ? singleConversationBackgroundPreview(input, model) : { fields: details };
    return { grant, previous: this.grants.find(g => g.pluginId === pluginId)?.id, ...preview };
  }
  approve(pluginId: string, plan: ReturnType<PluginBackground['prepare']>) {
    this.signal.throwIfAborted();
    if (pluginId !== plan.grant.pluginId || this.grants.find(g => g.pluginId === pluginId)?.id !== plan.previous) throw Error('Background authorization changed');
    if (plan.grant.includedIds?.some(id => !this.runtime.targets().some(t => t.id === id))) throw Error('History scope changed');
    const model = this.runtime.targets().find(t => t.id === plan.grant.modelSessionId);
    if (!model || this.binding(model) !== plan.grant.modelBinding) throw Error('后台模型配置已变化，请重新确认');
    if (this.grants.length >= 100 && !plan.previous) throw Error('Too many background grants');
    const usage = this.currentUsage(pluginId);
    // An approval changes the day's total limit, never grants an extra quota.
    // Read usage at approval time because an old grant can run after preview.
    if (!this.usage.has(pluginId) && this.usage.size >= 10000) throw Error('Too many background usage records');
    this.running.get(pluginId)?.abort();
    this.usage.set(pluginId, usage);
    this.grants = [...this.grants.filter(g => g.pluginId !== pluginId), { ...copy(plan.grant), day:usage.day, calls:usage.calls }]; this.save(); return plan.grant.id;
  }
  private get(pluginId: string, id: string, signal: AbortSignal) {
    this.signal.throwIfAborted(); signal.throwIfAborted(); if (this.fault) throw this.fault;
    const g = this.grants.find(g => g.pluginId === pluginId && g.id === id); if (!g) throw Error('后台授权已撤销或不存在'); return g;
  }
  bind(pluginId: string, signal: AbortSignal) {
    const get = (id: string) => this.get(pluginId, id, signal);
    const target = (g: Grant, id: string) => {
      const t = this.runtime.targets().find(t => t.id === id);
      if (!t || g.excludedIds.includes(id) || (g.includedIds && !g.includedIds.includes(id))) throw Error('Conversation outside background authorization'); return t;
    };
    const historyView = (g: Grant, id: string): HistoryView => {
      target(g, id); const store = this.runtime.store(id); if (!store) throw Error('Persisted history unavailable');
      const prior = this.historyCache.get(id), revision = store.getRevision(), leaf = store.getActiveLeaf();
      if (prior?.store === store && prior.revision === revision && prior.leaf === leaf) return prior;
      const entries = store.getHistoryEntries(), positions = new Map<string, number>();
      entries.forEach((entry, index) => positions.set(entry.id, index));
      const view = { store, revision, leaf, entries, positions };
      this.historyCache.set(id, view);
      if (this.historyCache.size > 64) this.historyCache.delete(this.historyCache.keys().next().value!);
      return view;
    };
    // Do not cache authorization decisions in the branch index. The same
    // branch can be used with different grants and history start times.
    const readable = (g: Grant, e: MessageEntry | undefined): e is MessageEntry =>
      !!e && e.timestamp >= g.since && !isSystemNoteMessage(e.message);
    return Object.freeze({
      supportsFollowModel: true,
      supportsModelSelection: (id: string) => {
        const g = get(id);
        return g.includedIds?.length === 1 && g.includedIds[0] === g.modelSessionId && g.excludedIds.length === 0
          && !!(this.runtime.models && this.runtime.completeSpecified && this.runtime.describeSpecified)
          && (this.runtime.supportsSpecified?.(g.modelSessionId) ?? true);
      },
      status: (id: string) => { const g = get(id), t=this.runtime.targets().find(t=>t.id===g.modelSessionId); const chosen=g.backgroundModel??t; return { ...copy(g), ...this.currentUsage(pluginId), modelBinding: undefined, backgroundEndpoint: undefined, observedForeground: undefined, modelRevision:g.modelRevision??0, backgroundModel:g.backgroundModel??null, modelTarget:t && chosen?.provider && chosen.model ? {conversationId:t.id,cwd:t.cwd,provider:chosen.provider,model:chosen.model} : null }; },
      models: async (id: string) => { const g=get(id), revision=g.modelRevision??0; if(g.includedIds?.length!==1 || g.includedIds[0]!==g.modelSessionId || g.excludedIds.length)throw Error('模型设置仅适用于专属对话授权'); const target=this.runtime.targets().find(t=>t.id===g.modelSessionId); if(!target || JSON.stringify([target.id,target.cwd])!==JSON.stringify(JSON.parse(g.modelBinding).slice(0,2)))throw Error('后台授权的对话已变化'); const binding=this.binding(target), result=await this.modelOptions(g); if(get(id)!==g || (g.modelRevision??0)!==revision || this.binding(this.runtime.targets().find(t=>t.id===g.modelSessionId)??{} as Target)!==binding)throw Error('后台授权已变化'); return result; },
      targets: (id: string) => { const g = get(id); return this.runtime.targets().filter(t => !g.excludedIds.includes(t.id) && (!g.includedIds || g.includedIds.includes(t.id))).map(t => ({ ...t })); },
      revoke: (id: string) => { get(id); this.running.get(pluginId)?.abort(); this.grants = this.grants.filter(g => g.id !== id); this.save(); },
      valid: (id: string, conversationId: string, sourceIds: string[]) => {
        const g = get(id); if (!Array.isArray(sourceIds) || sourceIds.length > 200) throw Error('Invalid source IDs');
        const { entries, positions } = historyView(g, conversationId);
        return sourceIds.filter(sourceId => {
          const index = positions.get(sourceId);
          return index !== undefined && readable(g, entries[index]);
        });
      },
      entry: (id: string, conversationId: string, sourceId: string, offset = 0) => {
        const g = get(id); if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid history offset');
        const { entries, positions } = historyView(g, conversationId);
        const index = positions.get(sourceId);
        const e = index === undefined ? undefined : entries[index];
        if (index === undefined || !readable(g, e)) throw Error('History source unavailable');
        // Preserve direct adjacency, including tools/generated tasks, without
        // exposing even an ID from outside this grant's authorized history.
        const previous = entries[index - 1];
        const previousId = readable(g, previous) ? previous.id : null;
        const text = stripContextWrappers(extractText(e.message.content));
        if(offset>text.length || (offset>0 && /[\uD800-\uDBFF]/.test(text[offset-1]) && /[\uDC00-\uDFFF]/.test(text[offset]??'')))throw Error('Invalid history offset');
        const part = unicodeSlice(text, offset, offset + 3000);
        return { id:e.id, previousId, at:e.timestamp, role:e.message.role, text:part, offset, nextOffset:offset+part.length, more:offset+part.length<text.length };
      },
      latestUser: (id: string, conversationId: string) => {
        const g = get(id), entries = historyView(g, conversationId).entries;
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (readable(g, entry) && entry.message.role === 'user') return entry.id;
        }
        return null;
      },
      search: (id: string, conversationId: string, query: string) => {
        const g = get(id); if (typeof query !== 'string' || !query.trim() || query.length > 300) throw Error('Invalid history query');
        const words = query.toLocaleLowerCase().split(/\s+/).slice(0,8);
        return historyView(g, conversationId).entries.filter(e => readable(g, e)).flatMap(e => {
          const text = stripContextWrappers(extractText(e.message.content)), lower = text.toLocaleLowerCase();
          const exact=lower.indexOf(query.trim().toLocaleLowerCase());
          const at = exact>=0 ? exact : Math.max(0, ...words.map(w => lower.indexOf(w)));
          return words.some(w => lower.includes(w)) ? [{id:e.id,at:e.timestamp,role:/^\[(?:Cross-conversation message|插件任务|Compacted conversation|Context checkpoint)/.test(text)?'generated':e.message.role,text:unicodeSlice(text,Math.max(0,at-100),Math.max(0,at-100)+800)}] : [];
        }).slice(-12);
      },
      read: (id: string, conversationId: string, cursor?: string) => {
        const g = get(id), t = target(g, conversationId), { entries: all, positions } = historyView(g, conversationId);
        const index = cursor ? (positions.get(cursor) ?? -1) : -1;
        const page = all.slice(index + 1, index + 41);
        const rows = page.filter(e => readable(g, e)).map((e: MessageEntry) => {
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
        if (g.followModel || g.backgroundModel ? JSON.stringify([model.id,model.cwd]) !== JSON.stringify(JSON.parse(g.modelBinding).slice(0,2)) : this.binding(model) !== g.modelBinding) throw Error('后台模型配置已变化，请重新授权');
        if (model.busy || this.running.has(pluginId)) throw Error('后台模型忙碌，稍后重试');
        if (!Array.isArray(messages) || !messages.length || messages.length > 8 || messages.some(m => !m || !['system','user'].includes(m.role) || typeof m.content !== 'string') || JSON.stringify(messages).length > 16000) throw Error('Background request exceeds input limits');
        const binding = this.binding(model), revision=g.modelRevision??0, selection=g.backgroundModel ? copy(g.backgroundModel) : null;
        if(selection && !(await this.modelOptions(g)).some(m=>m.provider===selection.provider && m.model===selection.model))throw Error('所选后台模型不可用');
        if(selection && JSON.stringify(await this.endpoint(g,selection))!==JSON.stringify(g.backgroundEndpoint))throw Error('后台模型端点已变化，请重新确认');
        const prior=get(id), now=this.runtime.targets().find(t=>t.id===model.id);
        if(prior!==g || (prior.modelRevision??0)!==revision || !now || (selection ? JSON.stringify([now.id,now.cwd])!==JSON.stringify([model.id,model.cwd]) : this.binding(now)!==binding))throw Error('后台模型已切换，本次结果未保存');
        if(now.busy || this.running.has(pluginId))throw Error('后台模型忙碌，稍后重试');
        const usage = this.currentUsage(pluginId);
        if (usage.calls >= g.dailyCalls) throw Error('今日后台处理额度已用完');
        const c = new AbortController(), combined = AbortSignal.any([this.signal, signal, c.signal, ...(cancellation ? [cancellation] : [])]);
        combined.throwIfAborted(); this.running.set(pluginId, c);
        let observed: SummaryUsage | undefined;
        const onUsage = (value: SummaryUsage) => {
          if (validTokens(value)) observed = { inputTokens:value.inputTokens, outputTokens:value.outputTokens };
        };
        try {
          usage.calls++; this.usage.set(pluginId, usage); g.day = usage.day; g.calls = usage.calls; this.save();
          const result = selection
            ? await this.runtime.completeSpecified!(model.id, messages, combined, selection, g.backgroundEndpoint!.identity, onUsage)
            : await this.runtime.complete(model.id, messages, combined, onUsage);
          combined.throwIfAborted();
          if(selection && !(await this.modelOptions(g)).some(m=>m.provider===selection.provider && m.model===selection.model))throw Error('所选后台模型不可用');
          if(selection && JSON.stringify(await this.endpoint(g,selection))!==JSON.stringify(g.backgroundEndpoint))throw Error('后台模型端点已变化，请重新确认');
          combined.throwIfAborted();const live=get(id), current=this.runtime.targets().find(t=>t.id===model.id);
          if(live!==g || (live.modelRevision??0)!==revision || !current || (selection ? JSON.stringify([current.id,current.cwd])!==JSON.stringify([model.id,model.cwd]) : this.binding(current)!==binding)) throw Error('后台模型已切换，本次结果未保存');
          return result;
        }
        finally {
          if (this.running.get(pluginId) === c) this.running.delete(pluginId);
          if (observed) this.recordTokens(pluginId, usage.day, observed);
        }
      },
    });
  }
}
