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
test('normal panel has only power and memory; first authorization exposes one basic model choice',t=>{
 const {a,p}=setup(t);assert.deepEqual(p.overview().actions.map(x=>x.id),['assistant-control','memories']);
 assert(p.overview().rows.every(r=>!r.actions.length));
 const form=p.prepare('assistant-control').execute().form;
 assert.equal(form.action,'learning-start');assert.deepEqual(form.fields.filter(f=>!f.advanced).map(f=>f.id),['modelSessionId']);
 assert.equal(form.fields[0].value,'a');
 a.store.setState('learning',{enabled:false,grantId:null,dailyCalls:2,excludedIds:['private']});
 const plan=p.prepare('learning-start',{modelSessionId:'a'});
 assert.equal(plan.backgroundAuthorization.dailyCalls,2);assert.deepEqual(plan.backgroundAuthorization.excludedIds,['private']);assert.equal(plan.backgroundAuthorization.includeHistory,false);
 assert.throws(()=>plan.execute(),/授权/);
});
test('pause stops recall and cancels work; resume retains grant, cursor and approved budget',async t=>{
 const {a,p,dir,revoke}=setup(t);a.store.bind('a',dir,true);
 const grant={enabled:true,grantId:'g',dailyCalls:2,excludedIds:['private']};a.store.setState('learning',grant);a.store.setState('scan:a',{cursor:'last'});
 const prior=a.learning.controller.signal;
 const pause=p.prepare('assistant-control');assert(pause.preview);pause.execute();assert.equal(a.store.profile().enabled,false);assert(prior.aborted);assert.equal(a.scope('a'),null);assert.deepEqual(a.learning.config(),grant);
 assert.equal(p.overview().actions[0].label,'继续运行');p.prepare('assistant-control').execute();assert.equal(a.store.profile().enabled,true);assert.deepEqual(a.store.state('scan:a'),{cursor:'last'});assert.deepEqual(a.learning.config(),grant);
 const stale=p.prepare('assistant-control');a.store.configure({name:'变更',enabled:true},a.store.profile().revision);assert.throws(()=>stale.execute(),/变化/);
 p.prepare('assistant-control').execute();revoke();assert.equal(p.prepare('assistant-control').execute().form.action,'learning-start');
});
test('memory inspection preserves pagination and forgetting without manual management controls',t=>{
 const {a,p}=setup(t);
 for(let i=0;i<65;i++)a.store.add({title:'记录'+i,content:'内容'+i,kind:'fact',scope:'personal'},{type:'user'},'active');
 const middle=p.listing('active',30);assert.equal(middle.rows.length,30);assert.equal(middle.actions.length,4);assert(!middle.actions.some(a=>a.id==='memory-options'));
 const next=middle.actions.find(x=>x.label==='下一页');assert.equal(p.prepare(next.id,next.values).execute().rows.length,5);
 const row=a.store.list()[0];assert.deepEqual(p.details(row).actions.map(x=>x.id),['memories','forget']);
 const forget=p.prepare('forget',{id:row.id,revision:row.revision});assert(forget.preview);forget.execute();assert.equal(a.store.get(row.id).state,'forgotten');
});
test('re-authorization enables a paused assistant only after confirmation and preserves configured exclusions',t=>{
 const {a,p}=setup(t);a.store.configure({name:'助手',enabled:false},a.store.profile().revision);
 const plan=p.prepare('learning-start',{modelSessionId:'a'});assert.equal(a.store.profile().enabled,false);plan.execute('g');assert.equal(a.store.profile().enabled,true);assert.equal(a.learning.config().dailyCalls,4);
});

test('inspection includes observations and retired records without exposing confirmation controls',t=>{
 const {a,p}=setup(t);const row=a.store.add({title:'待观察',content:'未经确认的记录',kind:'fact',scope:'personal'},{type:'model-proposal'});
 const view=p.prepare('memories').execute();assert.equal(view.rows[0].title,'待观察');assert.match(view.rows[0].status,/观察中/);assert.deepEqual(p.details(row).actions.map(a=>a.id),['memories','forget']);
 p.prepare('forget',{id:row.id,revision:row.revision}).execute();assert.equal(p.prepare('memories').execute().rows.length,0);
});

test('users with legacy manual associations can pause recall without first granting background access',t=>{
 const {a,p,dir}=setup(t);a.store.bind('a',dir,true);assert.equal(p.overview().actions[0].label,'暂停助手');
 p.prepare('assistant-control').execute();assert.equal(a.scope('a'),null);assert.equal(a.learning.config().enabled,false);
});
