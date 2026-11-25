import path from 'node:path';
import { createHash } from 'node:crypto';
import { start } from './shared.mjs';

const action = (id, label, values = {}) => ({ id, label, values });
const field = (id, label, type, value, extra = {}) => ({ id, label, type, value, ...extra });
const back = (id = 'overview') => [action(id, '返回')];
const themeEnable = 'enable-theme-overviews';
const themeDisable = 'disable-theme-overviews';
const modelKey = model => 'model:' + createHash('sha256').update(JSON.stringify([model.provider,model.model])).digest('hex');
const displayName = value => value.toWellFormed().replace(/[\u0000-\u001f"\\]/g,'�');
const modelLabel = model => {
  const name=displayName(model.model),provider=displayName(model.provider),label=name+' · '+provider;
  return label.length<=80 ? label : name.slice(0,30).toWellFormed()+'… · '+provider.slice(0,30).toWellFormed()+'…';
};
const modelOptions = models => {
  const counts=new Map();for(const m of models){const label=modelLabel(m);counts.set(label,(counts.get(label)??0)+1);}
  return models.map(m=>{const key=modelKey(m),label=modelLabel(m), changed=displayName(m.model)!==m.model || displayName(m.provider)!==m.provider;
    return {value:key,label:counts.get(label)>1 || changed || (m.model+' · '+m.provider).length>80 ? label.slice(0,60).toWellFormed()+' ['+key.slice(6)+']' : label};});
};
const themePreview = {
  title:'开启主题概览试点',
  fields:[
    {label:'用途',value:'整理项目决策与反复出现的协作偏好，保留对话出处。项目名称的使用时间仅用于辨别同名项目。'},
    {label:'模型与额度',value:'沿用已授权的整理模型和范围。在每天最多 4 次后台整理中，概览最多占 1 次（UTC）；普通记忆和纠正优先。'},
  ],
};
function localStatusTime(timestamp, now) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const date = new Date(timestamp), today = new Date(now);
  if (!Number.isFinite(date.getTime())) return '';
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(today.getDate() + 1);
  const day = date.toDateString();
  if (day === today.toDateString()) return `今天 ${clock}`;
  if (day === tomorrow.toDateString()) return `明天 ${clock}`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}
export class AssistantPanel {
  constructor(assistant) { this.a = assistant; this.store = assistant.store; }
  themeScope() {
    const sid=this.a.conversationId(),profile=this.store.profile();
    if(!this.a.dedicated || !sid || !profile.enabled || typeof this.store.themeOverviewEnabled!=='function'
      || typeof this.store.setThemeOverviewEnabled!=='function' || typeof this.store.themeOverviewGeneration!=='function'
      || typeof this.a.learning.cancelThemeOverview!=='function' || !this.a.learning.access(sid))return null;
    const grant=this.a.learning.config().grantId;
    return grant ? {sid,grant,profileRevision:profile.revision,generation:this.store.themeOverviewGeneration()} : null;
  }
  modelScope() {
    const sid=this.a.conversationId(),profile=this.store.profile(),config=this.a.learning.config(),api=this.a.services.background;
    if(!this.a.dedicated || !sid || !profile.enabled || !config.enabled || !config.grantId || !api || !this.a.learning.access(sid))return null;
    try {
      const grant=api.status(config.grantId), revision=grant.modelRevision ?? 0;
      if(!Number.isSafeInteger(revision) || revision<0)return null;
      return {sid,grantId:config.grantId,profileRevision:profile.revision,modelRevision:revision,grant};
    } catch { return null; }
  }
  modelCanSpecify(scope) {
    const api=this.a.services.background;
    if(typeof api?.models!=='function' || typeof this.a.learning.modelPolicyChanged!=='function')return false;
    if(typeof api.supportsModelSelection!=='function')return true;
    try { return api.supportsModelSelection(scope.grantId)===true; } catch { return false; }
  }
  modelCanManage(scope) {
    return !!scope && typeof this.a.services.background?.models==='function' && typeof this.a.learning.modelPolicyChanged==='function'
      && (!!scope.grant.backgroundModel || this.modelCanSpecify(scope));
  }
  modelScopeCurrent(expected) {
    const current=this.modelScope();
    return current && current.sid===expected.sid && current.grantId===expected.grantId && current.profileRevision===expected.profileRevision && current.modelRevision===expected.modelRevision;
  }
  overview() {
    const id=this.a.conversationId(),profile=this.store.profile(),running=!!id&&this.a.learning.access(id)&&profile.enabled;
    if(!id)return {actions:[action('setup','开启个人助手')],note:'一个专属对话，慢慢了解你',rows:[{title:'从这里开始',detail:'只从你与个人助手的交流中整理记忆，其他对话不受影响',actions:[]}]};
    const theme=running && this.themeScope();
    const pilot=theme ? this.store.themeOverviewEnabled() : false;
    const binding={conversationId:id,profileRevision:profile.revision};
    const model=running && this.modelScope();
    const canChangeModel=this.modelCanManage(model);
    const actions=[...(canChangeModel?[action('model-settings','整理模型',{...binding,grantId:model.grantId,modelRevision:model.modelRevision})]:[]),
      ...(theme?[action(pilot?themeDisable:themeEnable,pilot?'关闭概览':'开启概览',{...binding,generation:theme.generation})]:[]),
      action(running?'pause':'authorize',running?'关闭记忆':'开启记忆',binding)];
    return {actions,note:running?this.memoryStatus():'长期记忆已关闭',rows:[]};
  }

  memoryStatus(now=Date.now()) {
    const health=this.a.learning.health();
    // This is live inference, not the scheduler's short periodic scan. Never
    // persist it: an interrupted request must not look active after restart.
    if(this.a.learning.inferenceSignal && !this.a.learning.inferenceSignal.aborted)return '正在整理记忆…';
    if (health.errorClass === 'capacity') return '记忆空间已满';
    const retryTime = health.retryAt > now ? localStatusTime(health.retryAt, now) : '';
    if (health.errorClass === 'quota' && retryTime) return `额度用完 · ${retryTime} 后继续`;
    if (health.errorClass && health.errorClass !== 'quota' && health.failures >= 2) {
      if (retryTime) return `整理暂缓 · ${retryTime} 后重试`;
      if (!health.retryAt) return '整理暂缓 · 将自动重试';
    }
    if (health.backlog) return '待整理 · 空闲后继续';
    const lastTime = health.lastSuccessAt <= now ? localStatusTime(health.lastSuccessAt, now) : '';
    return lastTime ? `最近整理 · ${lastTime}` : '等待首次整理';
  }

  async welcome() {
    const sid=this.a.conversationId();
    if(!sid) {
      const plan=await this.prepare('setup');
      const view=await plan.execute();
      return {...view,actions:view.form?[]:[action('retry','刷新模型列表')],note:view.form?'先选一个聊天模型，之后随时可以更换。聊过的重要信息会在授权后自动整理，只在这个助手对话中使用':view.note};
    }
    const running=this.store.profile().enabled&&this.a.learning.access(sid);
    return {actions:running?[action('chat','开始聊天')]:[action('authorize','开启记忆并开始聊天'),action('chat','暂不开启，先聊聊')],
      note:running?'准备好了。从今天的想法聊起，或告诉我一点关于你的事':'最后一步：允许助手在后台整理这段对话。重要信息会自动记住，需要时再回忆，不必逐条确认',rows:[]};
  }
  async prepareWelcome(id,values={}) {
    if(id==='retry')return {execute:()=>this.welcome()};
    if(id==='chat') {
      const sid=this.a.conversationId();if(!sid)throw Error('请先创建助手对话');
      return {execute:()=>{if(this.a.conversationId()!==sid)throw Error('助手对话已变化');return {actions:[],rows:[],openConversation:sid};}};
    }
    if(!['create-assistant','authorize'].includes(id))throw Error('不支持的助手准备操作');
    const plan=await this.prepare(id,values),run=plan.execute;
    return {...plan,execute:async grant=>{await run(grant);const view=await this.welcome();return id==='authorize'||(id==='create-assistant'&&(plan.entryBackground||values.memory===false))?{...view,openConversation:this.a.conversationId()}:view;}};
  }
  prepare(id,values={}) {
    if(!['overview','setup','create-assistant','authorize','pause','model-settings','model-change',themeEnable,themeDisable].includes(id))throw Error('不支持的个人助手操作');
    if(id==='overview')return {execute:()=>this.overview()};
    const simple=view=>({execute:()=>view});
    if(['authorize','pause','model-settings','model-change',themeEnable,themeDisable].includes(id) && (
      (values.conversationId!==undefined && values.conversationId!==this.a.conversationId()) ||
      (values.profileRevision!==undefined && values.profileRevision!==this.store.profile().revision)
    ))throw Error('设置已变化，请重新打开');
    if(id==='model-settings' || id==='model-change') {
      const scope=this.modelScope(),api=this.a.services.background;
      if(!this.modelCanManage(scope))throw Error('当前宿主暂不支持更改整理模型');
      if(values.conversationId!==scope.sid || values.profileRevision!==scope.profileRevision || values.grantId!==scope.grantId || values.modelRevision!==scope.modelRevision)throw Error('设置已变化，请重新打开');
      const supported=this.modelCanSpecify(scope);
      return Promise.resolve(supported ? api.models(scope.grantId) : []).then(models=>{
        if(!this.modelScopeCurrent(scope))throw Error('设置已变化，请重新打开');
        if(!Array.isArray(models))throw Error('整理模型列表暂不可用');
        const available=models.filter(m=>m && typeof m.provider==='string' && m.provider.trim() && typeof m.model==='string' && m.model.trim())
          .map(m=>({provider:m.provider,model:m.model}));
        const unique=[...new Map(available.map(m=>[JSON.stringify(m),m])).values()];
        const current=scope.grant.backgroundModel, currentValue=current ? modelKey(current) : scope.grant.followModel ? 'follow' : 'legacy';
        if(id==='model-settings') {
          const options=[{value:'follow',label:'跟随对话模型'},...modelOptions(unique)];
          if(currentValue==='legacy')options.unshift({value:'legacy',label:'原授权固定模型（保留）'});
          else if(current && !options.some(option=>option.value===currentValue))options.unshift({value:currentValue,label:modelLabel(current).slice(0,60).toWellFormed()+' ['+currentValue.slice(6)+']（当前不可用）'});
          return simple({actions:back(),rows:[],...(!supported?{note:'当前不支持指定模型，可改为跟随对话。'}:{}),
            form:{action:'model-change',submit:'继续',compact:true,
              guidance:[{summary:'整理范围与额度',detail:'所选模型提供商会收到本助手对话的授权原文。每天最多整理 4 次（UTC），不调用工具。模型不可用时保留已有记忆。'}],
              values:{conversationId:scope.sid,profileRevision:scope.profileRevision,grantId:scope.grantId,modelRevision:scope.modelRevision},
              fields:[field('modelPolicy','整理模型','select',currentValue,{options})]}});
        }
        if(typeof values.modelPolicy!=='string')throw Error('请选择整理模型');
        if((values.modelPolicy==='legacy' && currentValue==='legacy') || (values.modelPolicy==='follow' && currentValue==='follow'))return simple(this.overview());
        let model=null;
        if(values.modelPolicy!=='follow') {
          model=unique.find(m=>modelKey(m)===values.modelPolicy);
          if(!model)throw Error('整理模型不可用，请重新选择');
        }
        const validate=()=>{if(!this.modelScopeCurrent(scope))throw Error('设置已变化，请重新打开');};
        return {backgroundModelChange:{grantId:scope.grantId,model},validate,
          preview:{title:'更改整理模型',fields:[
            {label:'发送内容',value:'为整理记忆，所选模型提供商会收到本助手对话中已授权的原文。'},
            {label:'额度与工具',value:'沿用每天最多 4 次的共享后台整理额度（UTC），主题概览最多占其中 1 次；不执行工具。'},
          ]},execute:approvedGrant=>{
          if(approvedGrant!==scope.grantId)throw Error('后台授权已变化，请重新打开');
          const latest=this.modelScope();
          if(!latest || latest.sid!==scope.sid || latest.grantId!==scope.grantId || latest.profileRevision!==scope.profileRevision || latest.modelRevision!==scope.modelRevision+1)throw Error('设置已变化，请重新打开');
          this.a.learning.modelPolicyChanged(scope.grantId);
          return this.overview();
        }};
      });
    }
    if(id===themeEnable || id===themeDisable) {
      const granted=this.themeScope();
      if(!granted)throw Error('请先在桌面端开启助手的长期记忆');
      if(values.generation!==undefined && values.generation!==granted.generation)throw Error('设置已变化，请重新打开');
      const enabled=id===themeEnable;
      return { ...(enabled&&!this.store.themeOverviewEnabled()?{preview:themePreview}:{}),execute:()=>{
        const current=this.themeScope();
        if(!current || current.sid!==granted.sid || current.grant!==granted.grant
          || current.profileRevision!==granted.profileRevision || current.generation!==granted.generation)throw Error('设置已变化，请重新打开');
        this.store.setThemeOverviewEnabled(enabled);
        if(!enabled)this.a.learning.cancelThemeOverview();
        return this.overview();
      }};
    }
    if(id==='setup') {
      return Promise.resolve(this.a.services.conversations.models()).then(models=>!models.length?simple({actions:back(),rows:[],note:'尚无可用模型，请先在设置中配置模型提供商，再返回开启个人助手'}):simple({actions:back(),note:'选择对话模型。开启记忆后，仅整理这段对话',rows:[],form:{action:'create-assistant',submit:'开始聊天',values:{},fields:[field('model','对话模型','select',models.length?JSON.stringify(models[0]):'',{options:models.map(m=>({value:JSON.stringify(m),label:(m.model+' · '+m.provider).slice(0,200)}))}),field('memory','自动记住重要信息','checkbox',true)]}}));
    }
    if(id==='create-assistant') {
      if(values.memory!==undefined&&typeof values.memory!=='boolean')throw Error('无效的记忆选择');
      const model=JSON.parse(values.model),combined=!!this.a.services.conversations.supportsEntryBackground&&values.memory!==false;
      return {entryAuthorization:{key:'assistant',model:model.model,provider:model.provider},...(combined?{entryBackground:{dailyCalls:4,includeHistory:true,followModel:true}}:{}),preview:{title:'开始与个人助手聊天',fields:[]},execute:grant=>{
        if(combined){const sid=this.a.conversationId(),profile=this.store.profile();if(!sid)throw Error('助手对话尚未就绪');this.store.configure({name:profile.name,enabled:true},profile.revision);this.a.learning.configure(grant,{modelSessionId:sid,includedIds:[sid],excludedIds:[],includeHistory:true,dailyCalls:4,followModel:true});}
        return this.overview();}};
    }
    if(id==='authorize') {
      const sid=this.a.conversationId();if(!sid)throw Error('请先创建助手对话');
      const profile=this.store.profile();
      return {backgroundAuthorization:{modelSessionId:sid,includedIds:[sid],excludedIds:[],includeHistory:true,dailyCalls:4,...(this.a.services.background.supportsFollowModel?{followModel:true}:{})},preview:{title:'开启长期记忆',fields:[]},execute:grant=>{if(this.store.profile().revision!==profile.revision||this.a.conversationId()!==sid)throw Error('设置已变化');this.store.configure({name:profile.name,enabled:true},profile.revision);this.a.learning.configure(grant,{modelSessionId:sid,includedIds:[sid],excludedIds:[],includeHistory:true,dailyCalls:4});return this.overview();}};
    }
    if(id==='pause') {
      const sid=this.a.conversationId(), revision=this.store.profile().revision;
      return {execute:()=>{
        if(this.a.conversationId()!==sid || this.store.profile().revision!==revision)throw Error('设置已变化，请重新打开');
        this.a.learning.pause();return this.overview();
      }};
    }

  }
}
export default function activate(ctx) {
  if(!ctx.services.conversations)throw Error('请升级 asHub：需要专属对话接口');
  const active = start(ctx.services);
  ctx.onDispose(active.dispose);
  ctx.onDispose(ctx.services.conversations.register('assistant',{label:'个人助手',resource:'assistant',setupResource:'welcome',description:'从日常交流中，慢慢了解你',cwd:path.join(ctx.services.dataDirectory,'workspace')}));
  const panel = new AssistantPanel(active.assistant);
  ctx.onDispose(ctx.services.interactions.register('assistant', {view:()=>panel.overview(),prepare:(id,values)=>panel.prepare(id,values),remote:{conversationId:()=>active.assistant.conversationId(),actions:['overview','pause']}}));
  ctx.onDispose(ctx.services.interactions.register('welcome',{view:()=>panel.welcome(),prepare:(id,values)=>panel.prepareWelcome(id,values)}));
  active.assistant.learning.start();
  return { stop: active.dispose };
}
