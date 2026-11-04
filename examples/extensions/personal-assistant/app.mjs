import { randomUUID } from 'node:crypto';
import { start } from './shared.mjs';
import { kinds, states, text, previewText } from './store.mjs';

const action = (id, label, values = {}) => ({ id, label, values });
const field = (id, label, type, value, extra = {}) => ({ id, label, type, value, ...extra });
const time = at => new Date(at).toLocaleString('zh-CN', { hour12: false });
const back = (id = 'overview') => [action(id, '返回')];
export class AssistantPanel {
  constructor(assistant) { this.a = assistant; this.store = assistant.store; }
  overview() {
    const profile = this.store.profile(), counts = this.store.counts(), config = this.a.learning.config();
    const running = profile.enabled && (config.enabled || this.store.bindings().length > 0);
    return { actions: [action('assistant-control', running ? '暂停助手' : config.enabled ? '继续运行' : '开启助手'), action('memories', '查看记忆')],
      note: profile.name + '\n' + this.a.learning.status() + '\n' + (counts.active ?? 0) + ' 条正式记忆 · ' + (counts.candidate ?? 0) + ' 条观察记录',
      rows: [{ title:running ? '在日常对话中，逐渐了解你' : config.enabled ? '已暂停，记忆仍然保留' : '让助手逐渐了解你',
        detail:running ? (config.enabled ? '全局记住重要信息，在需要时轻量召回。你可以随时查看或忘记' : '此前关联的对话仍可召回记忆；开启后台学习后才会自动整理新信息') : config.enabled ? '继续后恢复学习与召回，沿用已授权的模型和范围' : '首次开启时选择整理模型并确认授权，之后无需逐条管理',
        actions: running && !config.enabled ? [action('learning','开启后台学习')] : config.enabled && (!profile.enabled || /授权|配置已变化|不可用/.test(this.a.learning.error)) ? [action('learning','重新设置授权')] : [] }],
    };
  }
  bindings() {
    const sessions = this.a.sessions();
    return { refresh:false, actions:[action('connect','关联对话'), ...back('settings')],
      note:'手动关联 · 用于未开启后台学习的对话，召回当前用户的全局记忆',
      rows:this.store.bindings().map(b => {
        const s=sessions.find(s => s.instanceId===b.id && s.cwd===b.cwd);
        return { title:s?.title || '对话不可用', detail:b.cwd, status:s ? '全局长期记忆' : '关联范围已失效',
          ...(s ? {conversationId:b.id} : {}), actions:[action('disconnect','解除关联',{id:b.id,binding:JSON.stringify(b)})] };
      }),
    };
  }
  listing(state = 'all', offset = 0) {
    const all = this.store.list(state, offset), rows = all.slice(0, 30);
    const route = ['all','active'].includes(state) ? 'memories' : state === 'retired' ? 'retired' : 'candidates';
    return { refresh: false, actions: [action('search', '搜索'), ...back(),
      ...(offset ? [action(route, '上一页', { offset: Math.max(0, offset - 30) })] : []),
      ...(all.length > 30 ? [action(route, '下一页', { offset: offset + 30 })] : [])],
      note: state === 'candidate' ? '尚未参与召回 · 后台观察记录会继续积累证据，无需逐条确认；也可手动核对' : state === 'retired' ? '已替代的历史记忆 · 不再参与召回，可查看或忘记' : '自动整理的记忆与观察记录 · 可查看来源，或忘记不希望保留的内容',
      rows: rows.map(r => this.row(r)),
    };
  }
  row(r) { return { title: r.title, detail: previewText(r.content, 240), status: (r.state === 'candidate' ? '观察中 · ' : r.state === 'retired' ? '历史 · ' : '正式记忆 · ') + kinds[r.kind] + ' · ' + this.a.label(r.scope), actions: [action('detail', '查看', { id: r.id, revision: r.revision })] }; }
  scopes() { return [
    { value: 'personal', label: '个人 · 全局可检索' },
    ...this.a.snapshot().projects.map(p => ({ value: 'project:' + p.id, label: '项目 · ' + p.name })),
    ...this.a.sessions().map(s => ({ value: 'conversation:' + s.instanceId, label: '对话 · ' + (s.title || s.instanceId) })),
  ]; }
  editor(row) {
    const options = this.scopes();
    if (row && !options.some(o => o.value === row.scope)) options.push({ value: row.scope, label: '原范围已不可用，请重新选择' });
    return { actions: back('memories'), rows: [], note: '保存前会显示确认预览；记忆可能随关联对话发送给模型服务，请勿保存密码或密钥',
      form: { action: 'save', submit: '预览并确认', values: row ? { id: row.id, revision: row.revision } : {}, fields: [
        field('title', '标题', 'text', row?.title ?? ''), field('content', '记忆内容', 'textarea', row?.content ?? ''),
        field('kind', '类型', 'select', row?.kind ?? 'preference', { options: Object.entries(kinds).map(([value, label]) => ({ value, label })) }),
        field('scope', '适用范围', 'select', row?.scope ?? 'personal', { options }),
      ] },
    };
  }
  details(row) {
    return { refresh: false, actions: [...back('memories'),
      action('forget', '忘记', { id: row.id, revision: row.revision })],
      note: (row.source.type === 'learned' ? (row.state === 'active' ? '正式记忆' : '观察中') : states[row.state]) + ' · ' + kinds[row.kind] + ' · ' + this.a.label(row.scope),
      rows: [
        { title: row.title, detail: row.content, actions: [] },
        { title: '来源与时间', detail: row.source.type === 'learned' ? '后台自动整理 · ' + (row.source.mode === 'hypothesis' ? '待积累证据' : '有用户原文依据，仍需结合适用条件') + '\n' + row.source.refs.map(r => r.conversationId + ' / ' + r.id + ' · ' + time(r.at) + '\n' + r.quote).join('\n') : row.source.type === 'model-proposal'
          ? '旧版模型候选 · 后台会在授权范围内核验，依据不足时继续观察，无需手动确认\n' + row.source.reason + '\n对话：' + row.source.conversationId + '\n提出于 ' + time(row.source.at)
          : '由用户在面板中确认填写或修改\n更新于 ' + time(row.updated), actions: [] },
        ...(row.source.feedback?.length ? [{ title:'后续反馈', detail:row.source.feedback.slice(-10).map(f => (f.decision === 'reject' ? '反例' : '支持') + ' · ' + time(f.at) + ' · ' + f.conversationId + ' / ' + f.id + '\n' + f.quote).join('\n'), actions:[] }] : []),
        ...(row.replaces ? [{ title: '修订原记忆', detail: this.store.get(row.replaces)?.content || '原记忆已不可用', actions: [] }] : []),
      ],
    };
  }
  review(title, fields, run) { return { preview: { title, fields }, execute: run }; }
  prepare(id, values = {}) {
    const simple = view => ({ execute: () => view });
    if (id === 'overview') return simple(this.overview());
    if (id === 'assistant-control') {
      const p = this.store.profile(), c = this.a.learning.config();
      if (!c.enabled && !(p.enabled && this.store.bindings().length > 0)) return this.prepare('learning');
      if (!p.enabled) { try { this.a.services.background.status(c.grantId); } catch { return this.prepare('learning'); } }
      return this.review(p.enabled ? '暂停个人助手' : '继续运行个人助手', [{ label:'影响', value:p.enabled ? '停止后台学习和记忆召回，保留已有记忆和授权' : '恢复学习与召回，沿用已授权的模型、范围及每日额度' }], () => {
        if (JSON.stringify(this.a.learning.config()) !== JSON.stringify(c)) throw Error('学习配置已变化，请重新操作');
        if (!p.enabled) this.a.services.background.status(c.grantId);
        this.store.configure({ name:p.name, enabled:!p.enabled }, p.revision);
        if (p.enabled) this.a.learning.cancel(); else void this.a.learning.tick();
        return this.overview();
      });
    }
    if (id === 'bindings') return simple(this.bindings());
    if (id === 'memory-options') return simple({ refresh:false, actions:back('memories'), note:'记忆管理', rows:[
      {title:'补充记忆',detail:'手动记录一条希望助手长期记住的信息',actions:[action('new','添加记忆')]},
      {title:'观察记录',detail:'尚未参与召回的信息，可继续积累证据或手动核对',actions:[action('candidates','查看观察记录')]},
      {title:'历史记忆',detail:'查看已被替代的内容',actions:[action('retired','查看历史记忆')]},
    ] });
    if (id === 'growth') return simple({ refresh: false, actions: [action('candidates','观察记录'), ...back()],
      note: '自动整理保留原文依据；经验与流程先观察，获得至少两条独立的后续用户效果反馈后才参与召回，明确反例会停用。没有实际任务验证时，不宣称策略已验证成功',
      rows: ['active','candidate'].flatMap(state => this.store.list(state).filter(r => r.source.type === 'learned').slice(0,15).map(r => ({ ...this.row(r), status: (r.source.mode === 'withdrawn' ? '已撤下 · 收到反例' : r.state === 'active' ? (this.a.learning.valid(r) && this.store.profile().enabled ? '可参与召回' : '暂不参与召回') : '观察中 · 证据不足') + ' · ' + (r.source.refs?.length ?? 0) + ' 条来源' }))),
    });
    if (id === 'learning' || id === 'settings') {
      const c = this.a.learning.config();
      return simple({ actions: back(), rows: [],
        note: '仅需选择整理模型 · 每日最多 ' + (c.dailyCalls ?? 4) + ' 次后台整理\n授权后自动学习，无需手动关联。整理可能产生模型费用；已有记忆保留',
        form: { action:'learning-start', submit:'预览并授权', values:{}, fields:[
          field('modelSessionId','整理模型来源会话','select',c.modelSessionId ?? (this.a.sessions().filter(s=>s.model && s.provider).length === 1 ? this.a.sessions().find(s=>s.model && s.provider).instanceId : ''),{options:[{value:'',label:'请选择已配置模型的对话'},...this.a.sessions().filter(s => s.model && s.provider).map(s=>({value:s.instanceId,label:(s.title + ' · ' + s.provider + '/' + s.model).slice(0,190).toWellFormed()}))]}),
          field('excludedIds','排除的对话 ID（逗号分隔）','text',(c.excludedIds ?? []).join(','),{advanced:true}),
          field('includeHistory','同时整理已有历史（会使用整理额度）','checkbox',false,{advanced:true}),
        ] } });
    }
    if (id === 'learning-start') {
      if (!this.a.services.background) throw Error('当前宿主不支持后台学习');
      const previous = this.a.learning.config(), profile = this.store.profile();
      const input = { modelSessionId:values.modelSessionId, dailyCalls:values.dailyCalls === undefined ? previous.dailyCalls ?? 4 : Number(values.dailyCalls), excludedIds:values.excludedIds === undefined ? previous.excludedIds ?? [] : String(values.excludedIds).split(/[,，\s]+/).filter(Boolean), includeHistory:values.includeHistory ?? false };
      return { backgroundAuthorization:input, preview:{title:'开启自动学习',fields:[{label:'自动整理',value:'重要信息自动形成记忆；推测和策略积累独立证据后启用。可暂停、排除、修改或忘记。已有用户确认的记忆不会被自动改写'}]},
        execute: grantId => {
          if (JSON.stringify(this.a.learning.config()) !== JSON.stringify(previous) || this.store.profile().revision !== profile.revision) throw Error('助手配置已变化，请重新授权');
          this.a.learning.configure(grantId,input);
          if (!profile.enabled) { this.store.configure({name:profile.name,enabled:true},profile.revision); void this.a.learning.tick(); }
          return this.overview();
        } };
    }
    if (id === 'learning-pause') return this.review('暂停后台学习',[{label:'影响',value:'停止后台读取与整理，撤销后台调用授权；本地记忆保留，自动学习的记忆暂不参与召回'}],()=>{ this.a.learning.pause(); return this.overview(); });
    if (id === 'memories' || id === 'candidates' || id === 'retired') return simple(this.listing(id === 'memories' ? 'all' : id === 'retired' ? 'retired' : 'candidate', values.offset ?? 0));
    if (id === 'new') return simple(this.editor());
    if (id === 'search') return simple({ actions: back('memories'), rows: [], form: { action: 'find', submit: '搜索', values: {}, fields: [field('query', '记忆关键词', 'text', '')] } });
    if (id === 'find') {
      const query = text(values.query, 500, '关键词');
      return simple({ refresh: false, actions: [action('search', '重新搜索'), ...back('memories')], note: '最多显示 30 条可用记忆', rows: this.store.search(query, [...new Set(this.store.activeMemories().map(r=>r.scope))], 30).map(r => this.row(r)) });
    }
    if (id === 'configure') {
      const name = text(values.name, 60, '助手名称');
      if (typeof values.enabled !== 'boolean') throw Error('无效的启用状态');
      return this.review('更新个人助手', [{ label: '名称', value: name }, { label: '记忆', value: values.enabled ? '开启' : '暂停' }], () => {
        this.store.configure({ name, enabled: values.enabled }, values.revision); if (!values.enabled) this.a.learning.cancel(); return this.overview();
      });
    }
    if (id === 'connect') return simple({ actions: back('bindings'), rows: [], note: '只关联选中的对话，不读取它的既有历史；更换模型后，召回片段会随消息发给新的模型服务',
      form: { action: 'bind', submit: '预览并确认', values: {}, fields: [
        field('conversationId', '选择助手对话', 'select', '', { options: [{ value: '', label: '请选择对话' }, ...this.a.sessions().map(s => ({ value: s.instanceId, label: s.title || s.instanceId }))] }),
      ] },
    });
    if (id === 'bind') {
      const session = this.a.sessions().find(s => s.instanceId === values.conversationId);
      if (!session || (values.personal !== undefined && typeof values.personal !== 'boolean')) throw Error('请选择可用的对话');
      const old = JSON.stringify(this.store.bindings().find(b => b.id === session.instanceId));
      return this.review('关联助手对话', [
        { label: '对话', value: session.title || session.instanceId }, { label: '目录', value: session.cwd },
        { label: '记忆范围', value: '当前用户的全局正式记忆；项目与对话保留为适用背景' },
        { label: '模型服务', value: '相关记忆片段会随请求发送给此对话使用的模型服务；不授予新的工具权限' },
      ], () => {
        const now = this.a.sessions().find(s => s.instanceId === session.instanceId);
        if (!now || now.cwd !== session.cwd || now.projectId !== session.projectId || now.title !== session.title || old !== JSON.stringify(this.store.bindings().find(b => b.id === session.instanceId))) throw Error('对话或关联配置已变化，请重新预览');
        this.store.bind(session.instanceId, session.cwd, true); return this.bindings();
      });
    }
    if (id === 'disconnect') return this.review('解除助手关联', [{ label: '影响', value: '解除手动关联，已有记忆保留；若对话仍在后台学习授权范围内，仍会自动使用记忆。需停止自动使用时，请在后台学习中排除此对话' }], () => {
      if (JSON.stringify(this.store.bindings().find(b => b.id === values.id)) !== values.binding) throw Error('关联配置已变化');
      this.store.unbind(values.id); return this.bindings();
    });
    if (id === 'save') {
      const normalized = this.store.normalize(values);
      this.a.validateScope(normalized.scope);
      const old = values.id ? this.store.check(values.id, values.revision) : null;
      if (old && old.state !== 'active') throw Error('只能编辑正式记忆');
      const source = { type: 'user', userOperation: randomUUID(), at: Date.now() };
      return this.review(old ? '修改记忆' : '添加记忆', [
        ...(old ? [{ label: '原内容', value: old.content }] : []),
        { label: '标题', value: normalized.title }, { label: '内容', value: normalized.content },
        { label: '类型', value: kinds[normalized.kind] }, { label: '范围', value: this.a.label(normalized.scope) },
      ], () => {
        this.a.validateScope(normalized.scope);
        const row = old ? this.store.edit(old.id, old.revision, normalized) : this.store.add(normalized, source, 'active');
        return this.details(row);
      });
    }
    const row = this.store.check(values.id, values.revision);
    if (id === 'detail') return simple(this.details(row));
    if (id === 'edit' && row.state === 'active') return simple(this.editor(row));
    if (id === 'history') return simple({ refresh: false, actions: [action('detail', '返回记忆', { id: row.id, revision: row.revision })], note: '保留最近 10 个版本；恢复也需要重新确认', rows: this.store.history(row.id).map(v => ({
      title: '版本 ' + v.revision + ' · ' + states[v.value.state], detail: v.value.content,
      actions: row.state === 'active' && v.value.state === 'active' && v.revision !== row.revision ? [action('restore', '恢复此版本', { id: row.id, revision: row.revision, version: v.revision })] : [],
    })) });
    if (id === 'restore') {
      const version = this.store.history(row.id).find(v => v.revision === values.version)?.value;
      if (row.state !== 'active' || version?.state !== 'active') throw Error('此版本不能恢复');
      return this.review('恢复记忆版本', [{ label: '当前内容', value: row.content }, { label: '恢复内容', value: version.content }, { label: '范围', value: this.a.label(version.scope) }], () => {
        this.a.validateScope(version.scope); return this.details(this.store.edit(row.id, row.revision, version));
      });
    }
    if (id === 'approve' && row.state === 'candidate') return this.review('确认长期记忆', [
      { label: '标题', value: row.title }, { label: '内容', value: row.content }, { label: '类型', value: kinds[row.kind] },
      { label: '范围', value: this.a.label(row.scope) }, { label: '来源', value: row.source.reason ?? '用户填写' },
      ...(row.replaces ? [{ label: '替代原记忆', value: this.store.get(row.replaces)?.content ?? '已不可用' }] : []),
    ], () => {
      this.a.validateScope(row.scope);
      if (!this.a.learning.valid(row)) throw Error('记忆来源已不可用，请重新核对');
      if (row.source.type === 'model-proposal' && !this.a.require(row.source.conversationId).scopes.includes(row.scope)) throw Error('提案的来源范围已变化，请重新提出');
      return this.details(this.store.approve(row.id, row.revision));
    });
    if (id === 'forget') return this.review(row.state === 'candidate' ? '不采纳这条提案' : '忘记这条记忆', [
      { label: '内容', value: row.content }, { label: '影响', value: '删除记忆内容、检索索引及版本记录。保留去重指纹，避免同一提案重复出现；不会删除原对话、已发送上下文或你另行保存的备份' },
    ], () => { this.store.forget(row.id, row.revision); return this.listing(); });
    throw Error('不支持的个人助手操作');
  }
}
export default function activate(ctx) {
  const active = start(ctx.services);
  ctx.onDispose(active.dispose);
  const panel = new AssistantPanel(active.assistant);
  ctx.onDispose(ctx.services.interactions.register('assistant', { view: () => panel.overview(), prepare: (id, values) => panel.prepare(id, values) }));
  active.assistant.learning.start();
  return { stop: active.dispose };
}
