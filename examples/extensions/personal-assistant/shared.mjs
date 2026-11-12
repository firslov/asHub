import { retrieve } from './retrieval.mjs';
import { observedAt } from './memory-context.mjs';
import { Learning } from './learning.mjs';
import path from 'node:path';
import { MemoryStore, text } from './store.mjs';
// Forgetting and reversing forgetting require a bounded direct command, not
// keyword matching in a search excerpt. Ordinary first-time learning is unchanged.
function explicitMemoryIntent(message, quote, action) {
  const source=message.trim();
  const command=action==='remember'
    ? /^(?:(?:请(?:你|帮我)?|麻烦(?:你)?|我(?:希望|想让)你)\s*)?(?:重新|再次)?(?:记住|记下)\s*[:：,，]?\s*/u.exec(source)
      ?? /^(?:please\s+)?(?:remember|relearn)\b\s*(?:that\s+)?[:：,，]?\s*/iu.exec(source)
    : /^(?:(?:请(?:你|帮我)?|麻烦(?:你)?|我(?:希望|想让)你)\s*)?(?:忘记|(?:不要|别)(?:再)?(?:记住|记下|记))\s*[:：,，]?\s*/u.exec(source)
      ?? /^(?:please\s+)?(?:forget|(?:do not|don't|don’t)\s+remember)\b\s*(?:that\s+)?[:：,，]?\s*/iu.exec(source);
  if(!command || /[?？]$/.test(source))return false;
  const payload=source.slice(command[0].length);
  const content=memoryTarget(payload), evidence=memoryTarget(quote.trim()===source ? payload : quote);
  return content && content===evidence ? content : null;
}
function memoryTarget(value) {
  let s=value.trim().replace(/[。.!！]+$/u,'').trim();
  for(const [left,right] of [['“','”'],['「','」'],['"','"'],["'","'"]])if(s.startsWith(left)&&s.endsWith(right))s=s.slice(1,-1).trim();
  return s;
}
// Only remove an explicit self-reference, never negation, numbers or qualifiers.
const targetContent=value=>memoryTarget(value).replace(/^(?:我|用户)(?=喜欢|偏好|希望|要求|认为|不|是|有|叫|从事|任职)/u,'');
const matchesTarget=(target,row)=>[row.id,row.title,row.content,...(row.source.type==='learned' ? (row.source.refs ?? []).map(ref=>ref.quote) : [])]
  .some(value=>typeof value==='string' && targetContent(value)===targetContent(target));
const generatedHistory = /^\[(?:Cross-conversation message|插件任务|Compacted conversation|Context checkpoint)/;
const managers = new Map();
export function current(directory) { return managers.get(path.resolve(directory)); }
export class Assistant {
  constructor(services) { this.services = services; this.store = new MemoryStore(services.dataDirectory); this.stopped = false; this.learning = new Learning(this);
    this.dedicated = !!services.conversations;
    if (this.dedicated && !this.store.state('assistant:v4')) {
      this.learning.pause();
      this.store.transaction(()=>{this.store.setState('assistant:v4',{legacyIds:this.store.memoryIds(),imported:[]});
      for (const b of this.store.bindings()) this.store.unbind(b.id);});
    }
  }
  conversationId() { return this.services.conversations?.get('assistant') ?? null; }
  visible(row) {
    if (!row) return false;
    if (!this.dedicated) return true;
    const state=this.store.state('assistant:v4');
    return !state?.legacyIds.includes(row.id) || state.imported.includes(row.id);
  }
  topics() {
    const groups=[['about','关于你'],['preferences','偏好与习惯'],['ongoing','正在关注'],['methods','经验与方法']];
    const rows=this.store.activeMemories().filter(r=>this.visible(r)&&(!this.learning.config().enabled||this.learning.valid(r)));
    const group=r=>['preference','principle'].includes(r.kind)?'preferences':['experience','procedure'].includes(r.kind)?'methods':r.scope==='personal'?'about':'ongoing';
    return groups.map(([id,title])=>({id,title,items:rows.filter(r=>group(r)===id)}));
  }
  historySearch(id,query) {
    this.require(id);const c=this.learning.config();const ignored=new Set(this.store.state('ignored:'+id)??[]);
    return this.services.background.search(c.grantId,id,query).filter(r=>!ignored.has(r.id));
  }
  historyRead(id,sourceId,offset=0) {
    this.require(id);if((this.store.state('ignored:'+id)??[]).includes(sourceId))throw Error('该来源不再用于记忆');
    return this.services.background.entry(this.learning.config().grantId,id,sourceId,offset);
  }
  remember(id,args) {
    this.require(id);const c=this.learning.config();
    const records=this.historySearch(id,args.quote).filter(r=>r.role==='user' && r.text.includes(args.quote));
    if(!records.length)throw Error('找不到当前授权对话中的原文，请重新搜索核对');
    const record=records.at(-1),target=this.learning.api.targets(c.grantId).find(t=>t.id===id);
    let alignment, alignedPrior;
    if(args.memoryId!==undefined || args.revision!==undefined || args.relation!==undefined){
      if(typeof args.memoryId!=='string' || !Number.isSafeInteger(args.revision) || args.revision<1 || !['support','revise','contradict'].includes(args.relation))throw Error('修订需提供完整的记忆 ID、版本和关系');
      const prior=this.store.check(args.memoryId,args.revision);
      if(!this.visible(prior)||!this.learning.valid(prior))throw Error('原记忆当前不可用，请重新搜索核对');
      alignedPrior=prior;alignment={memoryId:prior.id,revision:prior.revision,relation:args.relation};
    }
    const source=this.services.background.entry(c.grantId,id,record.id),context=[];
    if(source.id!==record.id||source.role!=='user'||generatedHistory.test(source.text))throw Error('找不到当前授权对话中的用户原文');
    // Search excerpts are evidence locations, never a sequence of neighboring
    // turns. Ask the host for the exact predecessor only for a complete reply.
    const evidence=source.more?{...record,truncated:true}:{...record,...source,truncated:false};
    if(!source.more&&source.text.trim()===args.quote.trim()&&typeof source.previousId==='string'
      && !(this.store.state('ignored:'+id)??[]).includes(source.previousId)){
      const previous=this.services.background.entry(c.grantId,id,source.previousId);
      if(previous.id===source.previousId&&previous.role==='assistant'&&!(previous.offset>0)&&!previous.more&&!generatedHistory.test(previous.text))context.push({...previous,truncated:false});
    }
    const checked=this.learning.check({...args,subject:args.subject??alignedPrior?.source.context?.subject,scope:args.scope??'personal',certainty:'explicit',aliases:[],evidence:[{id:record.id,quote:args.quote}]},[evidence],target,c.grantId,context);
    if(!checked)throw Error('记忆来源或格式未通过校验');
    // Re-learning forgotten content requires a fresh, explicit user request,
    // never a historical quote, a generated task, or an offline inference.
    const original=record.id===this.services.background.latestUser(c.grantId,id)?source:null;
    const renewalTarget=original?.role==='user' && !original.more ? explicitMemoryIntent(original.text,args.quote,'remember') : null;
    const explicitRequest=!!renewalTarget && targetContent(renewalTarget)===targetContent(checked.value.content);
    const row=this.store.learn(checked.value,checked.source,{explicitRequest,priorValid:this.learning.validator(),...(alignment?{alignment}:{})});return {id:row.id,state:row.state,revision:row.revision};
  }
  forgetFromChat(id,args) {
    this.require(id);const rows=this.historySearch(id,args.quote).filter(r=>r.role==='user' && r.id===this.services.background.latestUser(this.learning.config().grantId,id) && r.text.includes(args.quote));
    const original=rows.length ? this.services.background.entry(this.learning.config().grantId,id,rows.at(-1).id) : null;
    const target=original?.role==='user' && !original.more ? explicitMemoryIntent(original.text,args.quote,'forget') : null;
    if(!target)throw Error('需要用户明确的遗忘要求');
    const row=this.store.check(args.id,args.revision);if(!this.visible(row))throw Error('记忆不可用');
    if(!matchesTarget(target,row))throw Error('遗忘目标与指定记忆不匹配，请明确指定记忆标题或完整内容');
    const matching=this.store.memoryTargets().filter(other=>this.visible(other)&&matchesTarget(target,other));
    if(matching.some(other=>other.id!==row.id))throw Error('遗忘目标匹配多条记忆，请先澄清要忘记的具体内容，再使用明确指定的记忆 ID');
    this.store.forget(row.id,row.revision);return {forgotten:true};
  }
  stop() { if (this.stopped) return; this.stopped = true; this.learning.stop(); this.store.close(); }
  snapshot() { if (this.stopped) throw Error('个人助手已停止'); return this.services.host.snapshot(); }
  sessions() { return this.snapshot().sessions.filter(s => s.kind === 'agent' && !s.readOnlyContext); }
  scope(id) {
    if (this.dedicated && id !== this.conversationId()) return null;
    try { if (this.learning.exclusions().has(id)) return null; } catch { return null; }
    const session = this.sessions().find(s => s.instanceId === id);
    const binding = this.store.bindings().find(b => b.id === id && b.cwd === session?.cwd);
    const automatic = this.learning.access(id);
    if (!session || (!binding && !automatic) || !this.store.profile().enabled) return null;
    return { session, scopes: ['conversation:' + id, ...(session.projectId ? ['project:' + session.projectId] : []), ...((binding ? binding.personal : automatic) ? ['personal'] : [])] };
  }
  require(id) { const access = this.scope(id); if (!access) throw Error('此对话未关联个人助手或记忆已暂停，请通过个人助手标签右侧的记忆开关开启'); return access; }
  validateScope(scope) {
    if(this.dedicated && scope !== 'personal' && scope !== 'conversation:'+this.conversationId()) throw Error('仅支持个人助手专属记忆');
    const snapshot = this.snapshot();
    if (scope === 'personal') return;
    if (scope.startsWith('conversation:') && snapshot.sessions.some(s => s.instanceId === scope.slice(13) && s.kind === 'agent' && !s.readOnlyContext)) return;
    if (scope.startsWith('project:') && snapshot.projects.some(p => p.id === scope.slice(8))) return;
    throw Error('记忆对应的项目或对话已不可用');
  }
  label(scope) {
    const s = this.snapshot();
    return scope === 'personal' ? this.dedicated ? '个人记忆 · 专属助手' : '个人记忆 · 全局可检索' : scope.startsWith('project:')
      ? '来源项目 · ' + (s.projects.find(p => p.id === scope.slice(8))?.name ?? '已不可用')
      : '来源对话 · ' + (s.sessions.find(p => p.instanceId === scope.slice(13))?.title ?? scope.slice(13));
  }
  propose(id, args) {
    const { scopes } = this.require(id), value = this.store.normalize(args);
    if (!scopes.includes(value.scope)) throw Error('不能为当前对话无权使用的范围提出记忆');
    if (args.replaces) {
      const old = this.store.get(args.replaces);
      if (!old || old.state === 'forgotten' || !scopes.includes(old.scope)) throw Error('原记忆不可用');
    }
    const row = this.store.add({ ...value, replaces: args.replaces, replacesRevision: args.replacesRevision }, {
      type: 'model-proposal', conversationId: id, reason: text(args.reason, 1000, '提案依据'), at: Date.now(),
    });
    // The fingerprint identifies the original proposal, not the current
    // contents or scope after a user edit. Recheck deduplicated results too.
    if (!scopes.includes(row.scope)) throw Error('原提案已移出当前对话的授权范围，请重新核对记忆');
    if (row.state !== 'forgotten' && Object.keys(value).some(key => row[key] !== value[key])) {
      throw Error('原提案对应的记忆已修改，请搜索并读取当前记忆；如需调整，请使用其最新 id 和 revision 提出修订');
    }
    return { id: row.id, state: row.state, revision: row.revision, note: '模型提案不证明原文或事实；只有用户在个人助手面板确认后才生效' };
  }
  read(id, memoryId) {
    this.require(id); const row = this.store.get(memoryId);
    if (!row || !this.visible(row) || row.state !== 'active' || !this.learning.valid(row)) throw Error('记忆不存在或当前不可用');
    return publicMemory(row);
  }
  search(id, query, limit = 8) {
    if (typeof query !== 'string' || query.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12) throw Error('查询最多 500 字符，每次返回 1–12 条');
    return retrieve(this, this.require(id).session, query, limit).map(publicMemory);
  }
}
export const publicMemory = row => ({ id: row.id, title: row.title, content: row.content, kind: row.kind, ...(row.source.topic?{topic:row.source.topic}:{}), scope: 'global', context: row.source.context, observedAt: observedAt(row), revision: row.revision, updatedAt: row.updated, source: row.source.type === 'learned' ? { type:'learned', mode:row.source.mode, at:row.source.at, sources:row.source.refs.map(r=>({conversationId:r.conversationId,id:r.id})) } : row.source });
export function start(services) {
  const key = path.resolve(services.dataDirectory);
  if (managers.has(key)) throw Error('个人助手已在运行');
  const assistant = new Assistant(services); managers.set(key, assistant);
  return { assistant, dispose() { if (managers.get(key) === assistant) managers.delete(key); assistant.stop(); } };
}
