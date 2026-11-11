import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const terminal = x => ['completed','failed','cancelled','interrupted'].includes(x);
const action = (id,label,values={}) => ({id,label,values});
const labels = {off:'自动接续未开启',waiting:'等待成员交付',ready:'待协调验收',queued:'等待协调者空闲',running:'正在协调处理',paused:'已暂停',blocked:'等待你的决定',completed:'已完成',stalled:'无进展，已暂停',error:'接续异常，已暂停'};
export class Continuation {
  constructor(services,{now=Date.now,delay=10000}={}) {
    this.s=services;this.now=now;this.delay=delay;this.stopped=false;this.fault=null;
    fs.mkdirSync(services.dataDirectory,{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path.join(services.dataDirectory,'work.sqlite'));
    this.db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS work (project TEXT, owner TEXT, name TEXT, data TEXT NOT NULL, PRIMARY KEY(project,owner,name)); CREATE TABLE IF NOT EXISTS continuation (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  }
  records() { return this.db.prepare('SELECT data FROM continuation').all().map(r=>JSON.parse(r.data)); }
  save(r) { this.db.prepare('INSERT INTO continuation VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE data<>excluded.data').run(r.id,JSON.stringify(r)); }
  works() {
    const snapshot=this.s.host.snapshot(), groups=new Map(snapshot.projects.map(p=>[p.id,p])), sessions=new Map(snapshot.sessions.filter(s=>s.kind==='agent'&&!s.readOnlyContext).map(s=>[s.instanceId,s]));
    return this.db.prepare('SELECT project,owner,name,data FROM work ORDER BY rowid DESC').all().flatMap(row=>{
      const project=groups.get(row.project),owner=sessions.get(row.owner);
      if(!project?.sessionIds.includes(row.owner)||!owner)return [];
      const plan=JSON.parse(row.data),id=hash([row.project,row.owner,row.name]);
      const membersValid=plan.steps.every(s=>project.sessionIds.includes(s.member)&&sessions.has(s.member));
      return [{...row,plan,id,ownerInfo:owner,projectName:project.name,membersValid}];
    });
  }
  inspect(w) {
    const tasks=new Map(this.s.collaboration.snapshot(w.owner).map(t=>[t.id,t]));
    const steps=w.plan.steps.map(s=>{const a=s.attempts.at(-1);const t=a?.taskId?tasks.get(a.taskId):undefined;return {id:s.id,member:s.member,dependsOn:s.dependsOn,attempt:a?.id,taskId:a?.taskId,review:a?.review?.decision,taskState:t?.state,revision:t?.revision};});
    const mismatch=steps.some(s=>s.taskId&&!s.review&&!tasks.has(s.taskId));
    const blocked=steps.some(s=>s.review==='blocked');
    const ready=steps.filter(s=>!s.attempt||s.review==='revise').filter(s=>s.dependsOn.every(id=>steps.find(p=>p.id===id)?.review==='accepted'));
    const review=steps.filter(s=>!s.review&&terminal(s.taskState));
    const unknown=steps.some(s=>s.attempt&&!s.taskId);
    const finished=steps.every(s=>s.review==='accepted');
    return {fingerprint:hash(steps),steps,ready,review,finished,blocked:blocked||mismatch||unknown};
  }
  revoke(r) {
    const grant=this.s.messages.authorization(r.grantId);
    if(grant&&!grant.revoked)this.s.messages.revoke(r.grantId);
  }
  pause(r,state,reason) {
    // Revoke admission before persisting the paused UI state. A crash between
    // these stores must leave either a revoked grant or a durable pause, never
    // a recoverable queued notice with no remaining owner to cancel it.
    this.revoke(r);
    r.enabled=false;r.state=state;r.reason=reason;r.epoch=randomUUID();this.save(r);
  }
  tick() {
    if(this.stopped||this.fault)return;
    try {
      const works=new Map(this.works().map(w=>[w.id,w]));
      for(const r of this.records()) {
        if(!r.enabled) {this.revoke(r);continue;} // Reconcile older partial pause commits on startup.
        const w=works.get(r.id);
        if(!w||!w.membersValid||hash(w.plan.spec)!==r.spec) {this.pause(r,'blocked','项目、成员或任务范围已变化，请重新确认');continue;}
        const grant=this.s.messages.authorization(r.grantId);
        if(!grant||grant.revoked) {this.pause(r,'paused','授权已撤销，或用户已停止协调对话');continue;}
        const current=this.inspect(w);
        if(r.pending) {
          let receipt=this.s.messages.lookup(r.pending.key);
          // The exact submission is persisted before calling the host. Recovery may
          // retry only this same key and payload; a running/uncertain turn is never replayed.
          if(!receipt) {
            if(grant.expiresAt<=this.now()||grant.used>=grant.maxRuns||r.pending.request.expiresAt<=this.now()) {
              this.pause(r,'paused','待发送通知或接续授权已到期，请核查后恢复');continue;
            }
            if(current.fingerprint!==r.pending.fingerprint) {r.pending=null;this.save(r);continue;}
            receipt=this.s.messages.submit(r.pending.request);
          }
          if(receipt.state==='queued'&&!r.pending.superseded&&(current.fingerprint!==r.pending.fingerprint||current.blocked||current.finished)) {
            // Record our cancellation intent before cancelling in the host store.
            // A restart can then distinguish supersession from an external stop.
            r.pending.superseded=true;this.save(r);
          }
          if(r.pending.superseded&&['queued','cancelled'].includes(receipt.state)) {
            if(receipt.state==='queued')this.s.messages.cancel(r.pending.key);
            r.pending=null;r.observed=null;this.save(r);continue;
          }
          if(['queued','running'].includes(receipt.state)) {
            r.state=receipt.state;this.save(r);continue;
          }
          if(receipt.state!=='completed') {this.pause(r,'error','接续未确认完成，请查看协调对话后手动恢复');continue;}
          // Keep the completed receipt durable until its progress decision is saved.
          const before=r.pending.fingerprint;r.pending=null;
          if(current.fingerprint===before) {this.pause(r,'stalled','协调轮次结束，但没有验收、返工或派发进展');continue;}
        }
        if(current.finished) {this.pause(r,'completed','本工作流全部步骤已验收');continue;}
        if(current.blocked) {this.pause(r,'blocked','存在明确阻塞、成员回执缺失或派发结果待确认');continue;}
        if(grant.expiresAt<=this.now()||grant.used>=grant.maxRuns) {this.pause(r,'paused','本次接续授权已到期或达到次数上限');continue;}
        if(!current.ready.length&&!current.review.length) {r.state='waiting';r.observed=null;this.save(r);continue;}
        r.state='ready';
        if(w.ownerInfo.isProcessing) {r.observed=null;this.save(r);continue;}
        if(r.observed!==current.fingerprint) {r.observed=current.fingerprint;r.observedAt=this.now();this.save(r);continue;}
        if(this.now()-r.observedAt<this.delay||this.now()-(r.lastAt??0)<30000) {this.save(r);continue;}
        const key=`continue:${r.id}:${r.epoch}:${++r.seq}`;
        const changes=`${current.review.length} 项待验收（${[...new Set(current.review.map(s=>s.taskState))].join(',')||'无'}），${current.ready.length} 项 ready；详细任务与回执请查询工作流`;
        const request={grantId:r.grantId,key,values:{changes},expiresAt:this.now()+86400000};
        r.pending={key,request,fingerprint:current.fingerprint};r.lastAt=this.now();r.state='queued';this.save(r);
        this.s.messages.submit(request);
      }
      this.publish();
    } catch(e) {this.fault=String(e); // Fail closed; cancel only messages which have not started.
      try { for(const r of this.records())if(r.enabled){try{this.s.messages.revoke(r.grantId);}catch{}} } catch {}
    }
  }
  publish() {
    const works=new Map(this.works().map(w=>[w.id,w]));
    this.s.activities?.replace(this.records().filter(r=>works.has(r.id)).slice(0,100).map(r=>({id:r.id,projectId:works.get(r.id).project,sessionId:works.get(r.id).owner,state:r.state,label:`${works.get(r.id).name} · ${labels[r.state]??r.state}`})));
  }
  view() {
    this.tick();const records=new Map(this.records().map(r=>[r.id,r]));
    return {actions:[],note:this.fault?'自动接续已停止：'+this.fault:'成员交付后自动接续验收 · 不增加工具权限 · 点击对话停止会暂停接续',rows:this.works().slice(0,100).map(w=>{
      const r=records.get(w.id),state=r?.state??'off';
      return {title:w.name,conversationId:w.owner,status:labels[state]??state,detail:`${w.projectName} · ${w.ownerInfo.title||w.owner}\n${r?.reason||w.plan.goal}`,actions:[action(r?.enabled?'pause':'enable',r?.enabled?'暂停接续':state==='off'?'开启自动接续':'恢复接续',{id:w.id,epoch:r?.epoch??''})]};
    })};
  }
  prepare(actionId,input) {
    if(this.fault||this.stopped)throw Error('接续服务不可用');
    const check=()=>{
      const w=this.works().find(w=>w.id===input.id),r=this.records().find(r=>r.id===input.id);
      if(!w||!w.membersValid||(r?.epoch??'')!==input.epoch)throw Error('工作或配置已变化，请刷新');
      return {w,r};
    };
    const {w,r}=check();
    if(actionId==='pause')return {execute:()=>{const {r}=check();if(r)this.pause(r,'paused','用户暂停自动接续；当前执行不会被强行中断');return this.view();}};
    if(actionId!=='enable')throw Error('不支持的操作');
    const current=this.inspect(w);if(current.finished)throw Error('本工作流已全部验收，无需接续');
    const spec=hash(w.plan.spec);
    const grant={targetId:w.owner,projectId:w.project,label:`项目接续 · ${w.name}`,template:`工作流 ${w.name} 有待处理状态。先用 project_work_status 核对最新状态，仅推进用户已授权的本工作流。读取实际成果后 review；完成回复不等于验收。失败或不确定结果先核查，不重复运行；存在必须由用户决定的阻塞时记录 blocked 并停止。不要扩大目标或自动新建工作流。\n变化提示（以工具读取为准）：\n{{changes}}`,variables:['changes'],minIntervalMs:30000,maxRuns:64,expiresAt:this.now()+7*86400000,pauseOnStop:true,recoverQueued:true};
    return {authorization:grant,preview:{title:'开启项目自动接续',fields:[{label:'工作目标',value:w.plan.goal},{label:'接续方式',value:'只在协调对话空闲时处理新交付或就绪步骤；最多64次，7天有效。无进展、运行异常或用户停止时暂停。不自动批准工具操作。'}]},execute:grantId=>{
      const latest=check();if(hash(latest.w.plan.spec)!==spec)throw Error('工作范围已变化');
      if(latest.r?.pending&&this.s.messages.lookup(latest.r.pending.key)?.state==='running')throw Error('上一轮接续尚在运行，请稍后恢复');
      if(latest.r)this.s.messages.revoke(latest.r.grantId);
      this.save({id:w.id,spec,enabled:true,grantId,epoch:randomUUID(),seq:0,state:'ready',reason:'',pending:null});return this.view();
    }};
  }
  start() {
    this.dispose=this.s.collaboration.subscribe(()=>this.tick());
    this.timer=setInterval(()=>this.tick(),2000);this.timer.unref?.();this.tick();
  }
  stop() {if(this.stopped)return;this.stopped=true;clearInterval(this.timer);this.dispose?.();this.db.close();}
}
export default function activate(ctx) {
  const runtime=new Continuation(ctx.services);
  const unregister=ctx.services.interactions.register('continuation',{view:()=>runtime.view(),prepare:(a,v)=>runtime.prepare(a,v)});
  ctx.onDispose(()=>{unregister();runtime.stop();});runtime.start();
}
