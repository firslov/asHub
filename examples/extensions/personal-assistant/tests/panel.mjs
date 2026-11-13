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
 const check=expected=>{const view=p.overview();assert.equal(view.toggle.status,expected);assert.equal(view.toggle.checked,true);assert.deepEqual(view.actions.map(x=>x.id),['pause']);assert.deepEqual(view.rows,[]);assert.equal(view.form,undefined);assert(view.toggle.status.length<=160);};
 check('随交流逐步形成记忆');
 health={backlog:true};check('等待空闲整理');
 // Scanning or a busy conversation is not model inference.
 a.learning.busy=true;check('等待空闲整理');a.learning.busy=false;
 health={backlog:true,failures:1,errorClass:'temporary'};check('等待空闲整理');
 health={backlog:true,failures:2,errorClass:'temporary'};check('整理暂缓 · 稍后重试');
 const controller=new AbortController();a.learning.inferenceSignal=controller.signal;check('正在整理记忆…');
 controller.abort();check('整理暂缓 · 稍后重试');
 health={backlog:true,failures:1,errorClass:'quota',retryAt:Date.now()+60000};check('今日整理已暂停 · 已有记忆可用');
 health.retryAt=Date.now()-1;check('等待空闲整理');
 health={failures:1,errorClass:'capacity'};check('记忆整理暂缓 · 存储额度已满');
 health={};check('随交流逐步形成记忆');
 assert.deepEqual(a.store.profile(),profile);assert.deepEqual(a.learning.config(),config);
 a.learning.access=()=>false;assert.equal(p.overview().toggle.status,undefined);assert.equal(p.overview().toggle.checked,false);assert.deepEqual(p.overview().actions.map(x=>x.id),['authorize']);
 a.learning.access=()=>true;a.store.configure({name:profile.name,enabled:false},profile.revision);assert.equal(p.overview().toggle.status,undefined,'profile pause hides even stale health');
});

test('last consolidation uses stable local dates, not a claim that all information was saved',t=>{
 const {a,p}=setup(t);const now=new Date(2026,10,12,14,25).getTime();
 let health={lastSuccessAt:new Date(2026,10,12,14,20).getTime()};a.learning.health=()=>health;
 assert.equal(p.memoryStatus(now),'最近整理 · 今天 14:20');
 assert.equal(p.memoryStatus(now+10000),'最近整理 · 今天 14:20','no second-by-second live announcements');
 health.lastSuccessAt=new Date(2025,10,12,9,5).getTime();assert.equal(p.memoryStatus(now),'最近整理 · 2025/11/12 09:05');
 for(const value of [null,undefined,NaN,Infinity,0,now+60000]){health.lastSuccessAt=value;assert.equal(p.memoryStatus(now),'随交流逐步形成记忆');}
});
