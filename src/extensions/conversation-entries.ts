import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
export interface EntryInput { key: string; provider: string; model: string }
interface Spec { label: string; resource: string; cwd: string; setupResource?: string; description?: string }
interface Binding { id: string; cwd: string; state: string }
/** Generic named conversation bindings. Only a host-confirmed resource plan creates one. */
export class ConversationEntries {
  private specs = new Map<string, {pluginId:string; key:string; spec:Spec; signal:AbortSignal}>();
  private bindings: Record<string,Binding>;
  private fault: unknown;
  private pending = new Map<string,{plan:object; work:Promise<string>}>();
  constructor(private file:string, private runtime:{ exists(id:string):boolean; models():{provider:string;model:string}[] | Promise<{provider:string;model:string}[]>; create(id:string,spec:Spec,input:EntryInput):Promise<void>; changed():void }) {
    this.bindings={};
    try {this.bindings=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
    if (!this.bindings || typeof this.bindings!=='object' || Array.isArray(this.bindings)) throw Error('Invalid conversation bindings');
    for(const b of Object.values(this.bindings))if(!b || !/^[a-f0-9]{12}$/.test(b.id) || !path.isAbsolute(b.cwd))throw Error('Invalid conversation binding');
    }catch(error){this.fault=error;this.bindings={};}
  }
  private save(){if(this.fault)throw this.fault;fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.bindings),{mode:0o600,flush:true});fs.renameSync(tmp,this.file);}
  /** Bindings are persisted before create() starts a kernel. Restored kernels may
   * also load before application entries register, so this uses durable ownership,
   * not the currently visible entry catalog. It does not grant history access. */
  matchesSession(pluginId:string, keys:readonly string[], sessionId:string):boolean {
    return !this.fault && !!sessionId && keys.some(key => this.bindings[pluginId+'/'+key]?.id === sessionId);
  }
  bind(pluginId:string,signal:AbortSignal){return Object.freeze({
    supportsEntryBackground:true,
    register:(key:string,spec:Spec)=>{
      signal.throwIfAborted();if(this.fault)throw this.fault;if(!/^[a-z][a-z0-9-]{0,79}$/.test(key)||!spec||typeof spec.label!=='string'||spec.label.length>100||!path.isAbsolute(spec.cwd)||!/^[a-z][a-z0-9-]{0,79}$/.test(spec.resource))throw Error('Invalid conversation entry');
      if(spec.setupResource !== undefined && !/^[a-z][a-z0-9-]{0,79}$/.test(spec.setupResource))throw Error('Invalid setup resource');
      if(spec.description !== undefined && (typeof spec.description !== 'string'||spec.description.length>300))throw Error('Invalid entry description');
      const k=pluginId+'/'+key;if(this.specs.has(k))throw Error('Entry already registered');const record={pluginId,key,spec:{...spec},signal};this.specs.set(k,record);this.runtime.changed();
      const dispose=()=>{if(this.specs.get(k)===record){this.specs.delete(k);this.runtime.changed();}};signal.addEventListener('abort',dispose,{once:true});return dispose;
    },
    get:(key:string)=>{signal.throwIfAborted();const b=this.bindings[pluginId+'/'+key];return b&&this.runtime.exists(b.id)?b.id:null;},
    models:async()=>{signal.throwIfAborted();const models=await this.runtime.models();signal.throwIfAborted();return models;},
  });}
  list(){return [...this.specs.values()].filter(e=>!e.signal.aborted).map(e=>({pluginId:e.pluginId,key:e.key,label:e.spec.label,resource:e.spec.resource,...(e.spec.setupResource?{setupResource:e.spec.setupResource}:{}),...(e.spec.description?{description:e.spec.description}:{}),sessionId:this.runtime.exists(this.bindings[e.pluginId+'/'+e.key]?.id)?this.bindings[e.pluginId+'/'+e.key].id:null}));}
  async prepare(pluginId:string,input:EntryInput){
    if(this.fault)throw this.fault;
    const k=pluginId+'/'+input?.key,e=this.specs.get(k);if(!e||e.signal.aborted)throw Error('Conversation entry unavailable');
    if(!(await this.runtime.models()).some(m=>m.provider===input.provider&&m.model===input.model))throw Error('Model unavailable');
    e.signal.throwIfAborted();if(this.specs.get(k)!==e)throw Error('Conversation entry changed');
    const createsConversation=!this.bindings[k]||!this.runtime.exists(this.bindings[k].id);
    return {key:k,entry:e,previous:this.bindings[k]?.id,input:{...input},createsConversation,fields:[...(this.bindings[k]&&createsConversation?[{label:'恢复入口',value:'原对话不可用，将创建新的专属对话；此操作不删除原对话数据'}]:[]),{label:createsConversation?'新建对话':'使用对话',value:e.spec.label},{label:'模型',value:input.provider+' / '+input.model},{label:'工作目录',value:e.spec.cwd}]};
  }
  approve(pluginId:string,plan:Awaited<ReturnType<ConversationEntries['prepare']>>):Promise<string>{
    if(plan.entry.pluginId!==pluginId||this.specs.get(plan.key)!==plan.entry||plan.entry.signal.aborted)throw Error('Conversation entry changed');
    const prior=this.pending.get(plan.key);
    // Only retries of this exact preview may share a creation in flight. A
    // different confirmation must not inherit its target or authorization.
    if(prior)return prior.plan===plan?prior.work:Promise.reject(Error('Conversation binding changed; review again'));
    const checkBinding=()=>{
      const b=this.bindings[plan.key],createsConversation=!b||!this.runtime.exists(b.id);
      if(b?.id!==plan.previous||createsConversation!==plan.createsConversation)throw Error('Conversation binding changed; review again');
      return b;
    };
    const work=(async()=>{
      let b=checkBinding();if(b&&!plan.createsConversation)return b.id;
      await this.prepare(pluginId,plan.input);plan.entry.signal.throwIfAborted();if(this.specs.get(plan.key)!==plan.entry)throw Error('Conversation entry changed');
      // Model discovery is asynchronous; a deleted conversation may have been
      // restored while it was pending. Recheck before persisting a replacement.
      checkBinding();fs.mkdirSync(plan.entry.spec.cwd,{recursive:true,mode:0o700});
      b={id:randomBytes(6).toString('hex'),cwd:fs.realpathSync(plan.entry.spec.cwd),state:'creating'};this.bindings[plan.key]=b;try{this.save();}catch(error){this.fault=error;throw error;}
      await this.runtime.create(b.id,{...plan.entry.spec,cwd:b.cwd},plan.input);
      b.state='ready';this.save();this.runtime.changed();plan.entry.signal.throwIfAborted();return b.id;
    })();this.pending.set(plan.key,{plan,work});void work.finally(()=>{if(this.pending.get(plan.key)?.work===work)this.pending.delete(plan.key)}).catch(()=>{});return work;
  }
}
