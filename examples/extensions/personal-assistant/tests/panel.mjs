import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Assistant } from '../shared.mjs';
import { AssistantPanel } from '../app.mjs';
function setup(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assistant-panel-'));let valid=true;
 const background={status:()=>{if(!valid)throw Error('revoked');return {};},targets:()=>[]};
 const a=new Assistant({dataDirectory:dir,background,host:{snapshot:()=>({sessions:[{instanceId:'a',cwd:dir,title:'工作',kind:'agent',model:'tiny',provider:'mock'}],projects:[]})}});
 t.after(()=>{a.stop();fs.rmSync(dir,{recursive:true,force:true});});
 return {a,p:new AssistantPanel(a),dir,revoke:()=>valid=false};
}
test('removed settings and memory browser actions cannot mutate legacy data',t=>{
 const {a,p,dir}=setup(t);a.store.bind('a',dir,true);
 const row=a.store.add({title:'偏好',content:'先给结论',kind:'preference',scope:'personal'},{type:'user'},'active');
 const profile=a.store.profile(),bindings=a.store.bindings();
 for(const id of ['assistant-control','learning','learning-start','settings','memories','new','search','find','detail','edit','save','forget','history','restore','approve','configure','bind','disconnect'])
   assert.throws(()=>p.prepare(id,{id:row.id,revision:row.revision,conversationId:'a'}),/不支持/);
 assert.deepEqual(a.store.get(row.id),row);assert.deepEqual(a.store.profile(),profile);assert.deepEqual(a.store.bindings(),bindings);
});
test('first setup reports unavailable models without exposing unrelated settings',async t=>{
 const {a,p}=setup(t);a.services.conversations={get:()=>null,models:()=>[]};
 const view=await p.welcome();assert.equal(view.form,undefined);assert.deepEqual(view.actions.map(a=>a.id),['retry']);assert.match(view.note,/模型提供商/);
 assert.deepEqual(p.overview().actions.map(a=>a.id),['setup']);
});

// Status is observational: it must never grant access or add management UI.
test('inline entry shows one quiet status without changing authorization or actions', t=>{
 const {a,p}=setup(t);a.services.conversations={get:()=> 'a'};a.learning.access=()=>true;
 let health={failures:0,errorClass:null};a.learning.health=()=>health;
 const profile=a.store.profile(),config=a.learning.config();
 const check=expected=>{const view=p.overview();assert.equal(view.toggle.status,expected);assert.equal(view.toggle.checked,true);assert.deepEqual(view.actions.map(x=>x.id),['pause']);assert.deepEqual(view.rows,[]);assert.equal(view.form,undefined);assert(!view.note.includes(expected),'only one place describes the status');};
 check('等待首次整理');
 health={backlog:true};check('待整理 · 空闲后继续');
 // Scanning or a busy conversation is not model inference.
 a.learning.busy=true;check('待整理 · 空闲后继续');a.learning.busy=false;
 health={backlog:true,failures:1,errorClass:'temporary'};check('待整理 · 空闲后继续');
 health={backlog:true,failures:2,errorClass:'temporary'};check('整理暂缓 · 将自动重试');
 const controller=new AbortController();a.learning.inferenceSignal=controller.signal;check('正在整理记忆…');
 controller.abort();check('整理暂缓 · 将自动重试');
 health={failures:1,errorClass:'capacity'};check('记忆空间已满');
 health={};check('等待首次整理');
 assert.deepEqual(a.store.profile(),profile);assert.deepEqual(a.learning.config(),config);
 a.learning.access=()=>false;assert.equal(p.overview().toggle.status,undefined);assert.equal(p.overview().toggle.checked,false);assert.deepEqual(p.overview().actions.map(x=>x.id),['authorize']);
 a.learning.access=()=>true;a.store.configure({name:profile.name,enabled:false},profile.revision);assert.equal(p.overview().toggle.status,undefined,'profile pause hides even stale health');
});

test('quota and retry status show the actual local eligibility time', t=>{
 const {a,p}=setup(t), now=new Date(2026,10,12,21,30).getTime();
 const health={backlog:true,errorClass:'quota',failures:1,retryAt:new Date(2026,10,12,22,0).getTime()};
 a.learning.health=()=>health;
 assert.equal(p.memoryStatus(now),'额度用完 · 今天 22:00 后继续');
 health.retryAt=new Date(2026,10,13,8,0).getTime();
 assert.equal(p.memoryStatus(now),'额度用完 · 明天 08:00 后继续');
 assert.equal(p.memoryStatus(health.retryAt),'待整理 · 空闲后继续');
 health.errorClass='temporary';health.failures=2;
 assert.equal(p.memoryStatus(now),'整理暂缓 · 明天 08:00 后重试');
 assert.equal(p.memoryStatus(health.retryAt),'待整理 · 空闲后继续');
});

test('last consolidation uses stable local dates, not a claim that all information was saved',t=>{
 const {a,p}=setup(t);const now=new Date(2026,10,12,14,25).getTime();
 let health={lastSuccessAt:new Date(2026,10,12,14,20).getTime()};a.learning.health=()=>health;
 assert.equal(p.memoryStatus(now),'最近整理 · 今天 14:20');
 assert.equal(p.memoryStatus(now+10000),'最近整理 · 今天 14:20','no second-by-second live announcements');
 health.lastSuccessAt=new Date(2025,10,12,9,5).getTime();assert.equal(p.memoryStatus(now),'最近整理 · 2025/11/12 09:05');
 for(const value of [null,undefined,NaN,Infinity,0,now+60000]){health.lastSuccessAt=value;assert.equal(p.memoryStatus(now),'等待首次整理');}
});

test('theme pilot requires current assistant authorization and closes independently of ordinary memory',t=>{
 const {a,p}=setup(t);
 let authorized=false, grant='g1', sid='a', themeEnabled=false, generation=0, cancellations=0, writes=0;
 a.dedicated=true;a.services.conversations={get:()=>sid};
 a.learning.access=id=>authorized&&id===sid;
 a.learning.config=()=>({enabled:authorized,grantId:grant});
 a.learning.cancelThemeOverview=()=>cancellations++;
 a.store.themeOverviewEnabled=()=>themeEnabled;
 a.store.themeOverviewGeneration=()=>generation;
 a.store.setThemeOverviewEnabled=enabled=>{themeEnabled=enabled;generation++;writes++;};
 const ordinary=new AbortController();a.learning.inferenceSignal=ordinary.signal;
 assert.deepEqual(p.overview().actions.map(row=>row.id),['authorize']);
 assert.throws(()=>p.prepare('enable-theme-overviews'),/长期记忆/);
 authorized=true;
 const current=()=>p.overview().actions.find(row=>row.id.includes('theme-overviews'));
 assert.equal(current().id,'enable-theme-overviews');
 assert.equal(writes,0);
 const stale=p.prepare(current().id,current().values);
 assert.match(stale.preview.fields[1].value,/最多 4 次.*最多占 1 次/);
 assert.equal(stale.backgroundAuthorization,undefined);
 grant='g2';
 assert.throws(stale.execute,/已变化/);
 sid='b';
 const enable=p.prepare(current().id,current().values);
 enable.execute();
 assert.equal(current().id,'disable-theme-overviews');
 const staleControl=current().values;
 p.prepare(current().id,current().values).execute();
 assert.equal(writes,2);
 assert.equal(cancellations,1);
 assert.equal(ordinary.signal.aborted,false);
 assert.equal(p.overview().toggle.checked,true);
 assert.throws(()=>p.prepare('disable-theme-overviews',staleControl),/已变化/);
 authorized=false;
 assert.equal(p.overview().manage,undefined);
});

test('desktop model controls preserve a legacy grant and require a current confirmation',async t=>{
 const {a,p}=setup(t);let sid='a',revision=0,policy=null,follow=false,changed=0;
 a.dedicated=true;a.services.conversations={get:()=>sid};a.learning.access=id=>id===sid;
 a.learning.config=()=>({enabled:true,grantId:'g1'});a.learning.modelPolicyChanged=id=>{assert.equal(id,'g1');changed++};
 a.services.background.status=id=>{assert.equal(id,'g1');return {modelRevision:revision,backgroundModel:policy,followModel:follow}};
 a.services.background.models=id=>{assert.equal(id,'g1');return [{provider:'p1',model:'same'},{provider:'p2',model:'same'},{provider:'p1',model:'same'}]};
 const view=p.overview(),button=view.actions.find(x=>x.id==='model-settings');assert(button);assert.match(view.note,/原授权固定模型/);
 const opened=await p.prepare(button.id,button.values),form=opened.execute().form,select=form.fields[0];
 assert.equal(select.value,'legacy');assert.equal(select.options.length,4);assert.match(opened.execute().note,/每天最多 4 次/);
 const value=select.options.find(o=>o.label==='same · p2').value;
 const plan=await p.prepare('model-change',{...form.values,modelPolicy:value});
 assert.deepEqual(plan.backgroundModelChange,{grantId:'g1',model:{provider:'p2',model:'same'}});assert.equal(changed,0);
 plan.validate();revision++;policy={provider:'p2',model:'same'};plan.execute('g1');assert.equal(changed,1);
 assert.match(p.overview().note,/same · p2/);
 const reopen=await p.prepare('model-settings',p.overview().actions.find(x=>x.id==='model-settings').values);
 const followPlan=await p.prepare('model-change',{...reopen.execute().form.values,modelPolicy:'follow'});
 assert.deepEqual(followPlan.backgroundModelChange,{grantId:'g1',model:null});
 sid='b';assert.throws(()=>followPlan.validate(),/变化/);assert.equal(changed,1);
});

test('model settings fail closed on stale forms and unavailable model selections',async t=>{
 const {a,p}=setup(t);let rev=0,profile=a.store.profile();
 a.dedicated=true;a.services.conversations={get:()=> 'a'};a.learning.access=()=>true;a.learning.config=()=>({enabled:true,grantId:'g'});
 a.learning.modelPolicyChanged=()=>{throw Error('must not change')};a.services.background.status=()=>({modelRevision:rev,followModel:true,backgroundModel:null});
 let finish;a.services.background.models=()=>new Promise(r=>{finish=r});
 const values=p.overview().actions.find(x=>x.id==='model-settings').values,pending=p.prepare('model-settings',values);
 rev++;finish([{provider:'p',model:'m'}]);await assert.rejects(pending,/变化/);
 a.services.background.models=()=>[{provider:'p',model:'m'}];const settings=await p.prepare('model-settings',p.overview().actions.find(x=>x.id==='model-settings').values);
 const form=settings.execute().form;await assert.rejects(p.prepare('model-change',{...form.values,modelPolicy:'model:missing'}),/不可用/);
 const plan=await p.prepare('model-change',{...form.values,modelPolicy:form.fields[0].options.find(x=>x.label==='m · p').value});
 a.store.configure({name:profile.name,enabled:true},profile.revision);assert.throws(plan.validate,/变化/);
});

test('long or ambiguous model names use bounded unique keys and require current catalog membership',async t=>{
 const {a,p}=setup(t);a.dedicated=true;a.services.conversations={get:()=> 'a'};a.learning.access=()=>true;a.learning.config=()=>({enabled:true,grantId:'g'});
 a.learning.modelPolicyChanged=()=>{};const first={provider:'p'.repeat(200),model:'m'.repeat(200)},second={provider:'p'.repeat(199)+'q',model:'m'.repeat(200)};
 let catalog=[first,second,...Array.from({length:505},(_,i)=>({provider:'provider',model:'name-'+i}))];
 a.services.background.status=()=>({modelRevision:4,followModel:false,backgroundModel:first});a.services.background.models=()=>catalog;
 const view=(await p.prepare('model-settings',p.overview().actions.find(x=>x.id==='model-settings').values)).execute();
 const options=view.form.fields[0].options;assert.equal(options.length,508);assert(JSON.stringify(view).length<262144);
 assert(options.every(o=>o.value.length<=200 && o.label.length<=200));assert.notEqual(options[1].value,options[2].value);assert.notEqual(options[1].label,options[2].label);
 const same=await p.prepare('model-change',{...view.form.values,modelPolicy:options[1].value});
 assert.deepEqual(same.backgroundModelChange,{grantId:'g',model:first},'same specified pair permits re-confirmation');
 catalog=[second];await assert.rejects(p.prepare('model-change',{...view.form.values,modelPolicy:options[1].value}),/不可用/);
});

test('a full thousand-entry model catalog fits the resource envelope without losing models',async t=>{
 const {a,p}=setup(t);a.dedicated=true;a.services.conversations={get:()=> 'a'};a.learning.access=()=>true;a.learning.config=()=>({enabled:true,grantId:'g'});
 a.learning.modelPolicyChanged=()=>{};a.services.background.status=()=>({modelRevision:0,followModel:true,backgroundModel:null});
 a.services.background.models=()=>Array.from({length:1000},(_,i)=>({provider:'\\"'.repeat(95)+String(i).padStart(4,'0'),model:'"'.repeat(200)}));
 const plan=await p.prepare('model-settings',p.overview().actions.find(x=>x.id==='model-settings').values),view=plan.execute();
 assert.equal(view.form.fields[0].options.length,1001);assert(JSON.stringify(view).length<262144);
 assert.equal(new Set(view.form.fields[0].options.map(x=>x.value)).size,1001);
 assert.equal(new Set(view.form.fields[0].options.map(x=>x.label)).size,1001);
});

test('unsupported model selection hides entry but retains recovery for an existing specified model',async t=>{
 const {a,p}=setup(t);let specified=null,supported=false,reads=0;
 a.dedicated=true;a.services.conversations={get:()=> 'a'};a.learning.access=()=>true;a.learning.config=()=>({enabled:true,grantId:'g'});
 a.learning.modelPolicyChanged=()=>{};a.services.background.status=()=>({modelRevision:2,followModel:!specified,backgroundModel:specified});
 a.services.background.supportsModelSelection=id=>{assert.equal(id,'g');return supported};
 a.services.background.models=()=>{reads++;throw Error('unsupported backend')};
 assert(!p.overview().actions.some(a=>a.id==='model-settings'));
 assert.throws(()=>p.prepare('model-settings',{conversationId:'a',profileRevision:a.store.profile().revision,grantId:'g',modelRevision:2}),/不支持/);
 specified={provider:'saved',model:'existing'};let action=p.overview().actions.find(a=>a.id==='model-settings');assert(action);
 const view=(await p.prepare(action.id,action.values)).execute();assert.equal(reads,0);assert.match(view.note,/不支持指定模型/);
 const plan=await p.prepare('model-change',{...view.form.values,modelPolicy:'follow'});assert.deepEqual(plan.backgroundModelChange,{grantId:'g',model:null});
 specified=null;supported=true;action=p.overview().actions.find(a=>a.id==='model-settings');assert(action);
 delete a.services.background.supportsModelSelection;assert(p.overview().actions.some(a=>a.id==='model-settings'),'older hosts retain models-based capability');
});
