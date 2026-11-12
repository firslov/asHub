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

// The switch is authorization state; only a persistent fault adds a status line.
test('inline entry reports persistent learning faults without adding settings', t=>{
 const {a,p}=setup(t);a.services.conversations={get:()=> 'a'};a.learning.access=()=>true;
 let health={failures:0,errorClass:null};a.learning.health=()=>health;
 assert.equal(p.overview().toggle.status,undefined);
 health={failures:1,errorClass:'network'};assert.equal(p.overview().toggle.status,undefined);
 health={failures:2,errorClass:'network'};assert.match(p.overview().toggle.status,/暂缓/);
 assert.equal(p.overview().toggle.checked,true);assert.deepEqual(p.overview().actions.map(x=>x.id),['pause']);
 health={failures:3,errorClass:'quota'};assert.equal(p.overview().toggle.status,undefined,'daily quota is expected scheduling');
 health={failures:1,errorClass:'capacity'};assert.match(p.overview().toggle.status,/已满/);
 a.learning.access=()=>false;assert.equal(p.overview().toggle.status,undefined,'disabled memory has no stale warning');
});
