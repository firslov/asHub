import path from 'node:path';
import { start } from './shared.mjs';

const action = (id, label, values = {}) => ({ id, label, values });
const field = (id, label, type, value, extra = {}) => ({ id, label, type, value, ...extra });
const back = (id = 'overview') => [action(id, '返回')];
export class AssistantPanel {
  constructor(assistant) { this.a = assistant; this.store = assistant.store; }
  overview() {
    const id=this.a.conversationId(),profile=this.store.profile(),running=!!id&&this.a.learning.access(id)&&profile.enabled;
    if(!id)return {actions:[action('setup','开启个人助手')],note:'一个专属对话，慢慢了解你',rows:[{title:'从这里开始',detail:'只从你与个人助手的交流中整理记忆，其他对话不受影响',actions:[]}]};
    const notice=running ? this.memoryStatus() : '';
    return {toggle:{label:'长期记忆',checked:running,action:running?'pause':'authorize',...(notice?{status:notice}:{})},actions:[action(running?'pause':'authorize',running?'关闭长期记忆':'开启长期记忆')],
      note:(running?'长期记忆已开启':'长期记忆已关闭')+' · 只用于这段助手对话'+(notice?'\n'+notice:''),rows:[]};
  }

  memoryStatus(now=Date.now()) {
    const health=this.a.learning.health();
    // This is live inference, not the scheduler's short periodic scan. Never
    // persist it: an interrupted request must not look active after restart.
    if(this.a.learning.inferenceSignal && !this.a.learning.inferenceSignal.aborted)return '正在整理记忆…';
    if(health.errorClass==='capacity')return '记忆整理暂缓 · 存储额度已满';
    if(health.errorClass==='quota' && health.retryAt>now)return '今日整理已暂停 · 已有记忆可用';
    if(health.errorClass && health.errorClass!=='quota' && health.failures>=2)return '整理暂缓 · 稍后重试';
    if(health.backlog)return '等待空闲整理';
    if(Number.isFinite(health.lastSuccessAt) && health.lastSuccessAt>0 && health.lastSuccessAt<=now) {
      const date=new Date(health.lastSuccessAt),today=new Date(now);
      const sameDay=date.getFullYear()===today.getFullYear() && date.getMonth()===today.getMonth() && date.getDate()===today.getDate();
      const day=sameDay?'今天':`${date.getFullYear()}/${date.getMonth()+1}/${date.getDate()}`;
      const time=`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
      return `最近整理 · ${day} ${time}`;
    }
    return '随交流逐步形成记忆';
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
    if(!['overview','setup','create-assistant','authorize','pause'].includes(id))throw Error('不支持的个人助手操作');
    if(id==='overview')return {execute:()=>this.overview()};
    const simple=view=>({execute:()=>view});
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
    if(id==='pause')return {execute:()=>{this.a.learning.pause();return this.overview()}};

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
