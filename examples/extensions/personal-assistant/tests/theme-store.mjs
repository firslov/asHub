import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryStore} from '../store.mjs';
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-theme-store-'));let store=new MemoryStore(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});return {dir,get store(){return store},reopen(){store.close();store=new MemoryStore(dir);return store}}}
const authorize=store=>store.setState('learning',{enabled:true,grantId:'grant',dailyCalls:4});
function memory(store,name,sourceId='source-'+name,conversationId='conversation'){
 const content='证据内容 '+name;
 return store.add({title:name,content,kind:'fact',scope:'personal'}, {type:'user',context:{subject:'user'},refs:[{conversationId,id:sourceId,quote:content,start:0,end:content.length}]},'active');
}
const ref=(row,role='support')=>({memoryId:row.id,revision:row.revision,conversationId:row.source.refs[0].conversationId,sourceId:row.source.refs[0].id,start:0,end:3,role});
const request=(store,key,rows,generation=store.themeOverviewGeneration())=>({themeKey:key,kind:'preference',title:'协作偏好',basisKey:'basis-1',generation,statements:rows.map((row,i)=>({text:'陈述 '+key+' '+i,evidence:[ref(row)]}))});
test('opt in requires memory grant; enable generation and close erase bodies and dependencies',t=>{
 const f=fixture(t),s=f.store;assert.equal(s.themeOverviewEnabled(),false);assert.equal(s.themeOverviewGeneration(),0);assert.throws(()=>s.setThemeOverviewEnabled(true),/长期记忆/);
 authorize(s);s.setThemeOverviewEnabled(true);const row=memory(s,'公开事实');const gen=s.themeOverviewGeneration();
 const result=s.saveThemeStatements(request(s,'scope',[row],gen));assert.equal(result.length,1);const list=s.listThemeStatements();assert.equal(list.length,1);assert.equal(list[0].id,result[0].id);assert.equal(list[0].revision,1);assert.equal(list[0].text,'陈述 scope 0');
 s.setThemeOverviewEnabled(false);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM theme_statements').get().n,0);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM theme_evidence').get().n,0);
 s.setThemeOverviewEnabled(true);assert.throws(()=>s.saveThemeStatements(request(s,'scope',[row],gen)),/授权已变化/);assert.deepEqual(s.listThemeStatements(),[]);
});
test('stable id and revision are transactional and independent statements survive other evidence edits',t=>{
 const f=fixture(t),s=f.store;authorize(s);s.setThemeOverviewEnabled(true);const a=memory(s,'甲'),b=memory(s,'乙');
 const q=request(s,'theme',[a,b]);const before=s.saveThemeStatements(q);assert.deepEqual(s.saveThemeStatements(q),before);
 q.statements[1].text='独立更新';const revised=s.saveThemeStatements(q);assert.equal(revised[0].revision,1);assert.equal(revised[1].id,before[1].id);assert.equal(revised[1].revision,2);
 s.edit(a.id,a.revision,{title:a.title,content:'修改后的事实',kind:a.kind,scope:a.scope});const rows=s.listThemeStatements();assert.deepEqual(rows.map(x=>x.id),[before[1].id]);
 assert.throws(()=>s.saveThemeStatements(request(s,'other',[a])),/证据已变化/);assert.equal(s.listThemeStatements().length,1);
});
test('forget removes all statements sharing original source but preserves unrelated sources',t=>{
 const f=fixture(t),s=f.store;authorize(s);s.setThemeOverviewEnabled(true);
 const a=memory(s,'甲','shared'),b=memory(s,'乙','shared'),c=memory(s,'丙','other');
 s.saveThemeStatements(request(s,'group',[a,b,c]));s.forget(a.id,a.revision);
 const list=s.listThemeStatements();assert.deepEqual(list.map(row=>row.evidence[0].memoryId),[c.id]);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM theme_evidence').get().n,1);assert(!JSON.stringify(list).includes('shared'));
});
test('rollback writer changes evidence and reopening prunes stale rows even after changes log truncation',t=>{
 const f=fixture(t);let s=f.store;authorize(s);s.setThemeOverviewEnabled(true);const a=memory(s,'甲'),b=memory(s,'乙');s.saveThemeStatements(request(s,'group',[a,b]));
 // Simulate a previous version that does not know about the derived tables.
 s.db.prepare('UPDATE memories SET revision=revision+1 WHERE id=?').run(a.id);s.db.prepare('DELETE FROM changes').run();
 s=f.reopen();assert.deepEqual(s.listThemeStatements().map(x=>x.evidence[0].memoryId),[b.id]);
});
test('stale generation, stale revision, wrong provenance and malformed spans are rejected atomically',t=>{
 const f=fixture(t),s=f.store;authorize(s);s.setThemeOverviewEnabled(true);const a=memory(s,'甲'),good=request(s,'group',[a]);s.saveThemeStatements(good);
 for(const change of [q=>q.statements[0].evidence[0].revision++,q=>q.statements[0].evidence[0].sourceId='wrong',q=>q.statements[0].evidence[0].end=0,q=>q.statements[0].evidence[0].role='counterexample',q=>q.generation++]) {
  const q=structuredClone(good);change(q);assert.throws(()=>s.saveThemeStatements(q));assert.equal(s.listThemeStatements()[0].text,good.statements[0].text);
 }
});
test('old schema is additive and project evidence plus exception roles round trip',t=>{
 const f=fixture(t),s=f.store;authorize(s);s.setThemeOverviewEnabled(true);const a=memory(s,'甲'),b=memory(s,'乙');
 const q={themeKey:'project:alpha',kind:'project',projectId:'alpha',title:'决策',basisKey:'k',generation:s.themeOverviewGeneration(),statements:[{text:'先完成设计',validFrom:100,validTo:200,evidence:[ref(a),ref(b,'exception'),ref(b,'counterexample')]}]};
 s.saveThemeStatements(q);const [row]=s.listThemeStatements();assert.equal(row.projectId,'alpha');assert.equal(row.validFrom,100);assert.deepEqual(row.evidence.map(e=>e.role),['support','exception','counterexample']);
});
test('pausing learning or replacing grant atomically disables and clears the pilot and invalidates pending writes',t=>{
 const f=fixture(t),s=f.store;authorize(s);s.setThemeOverviewEnabled(true);const a=memory(s,'甲'),old=request(s,'theme',[a]);s.saveThemeStatements(old);
 s.setState('learning',{enabled:false,grantId:null});assert.equal(s.themeOverviewEnabled(),false);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM theme_statements').get().n,0);
 authorize(s);s.setThemeOverviewEnabled(true);assert.throws(()=>s.saveThemeStatements(old),/授权已变化/);
 const fresh=request(s,'theme',[a]);s.saveThemeStatements(fresh);s.setState('learning',{enabled:true,grantId:'new-grant'});
 assert.equal(s.themeOverviewEnabled(),false);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM theme_evidence').get().n,0);
});
test('pausing the profile removes content and an old generation cannot publish after resume',t=>{
 const f=fixture(t),s=f.store;authorize(s);s.setThemeOverviewEnabled(true);const a=memory(s,'甲'),pending=request(s,'theme',[a]);s.saveThemeStatements(pending);
 let p=s.profile();s.configure({name:p.name,enabled:false},p.revision);assert.equal(s.themeOverviewEnabled(),false);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM theme_statements').get().n,0);
 p=s.profile();s.configure({name:p.name,enabled:true},p.revision);s.setThemeOverviewEnabled(true);assert.throws(()=>s.saveThemeStatements(pending),/授权已变化/);
});
test('two connections reject an in-flight result after off/on generation changes',t=>{
 const f=fixture(t),a=f.store;authorize(a);a.setThemeOverviewEnabled(true);const m=memory(a,'甲'),pending=request(a,'theme',[m]);const b=new MemoryStore(f.dir);
 try {b.setThemeOverviewEnabled(false);b.setThemeOverviewEnabled(true);assert.throws(()=>a.saveThemeStatements(pending),/授权已变化/);assert.deepEqual(a.listThemeStatements(),[])}finally{b.close()}
});
test('source IDs are scoped by conversation when forgetting',t=>{
 const f=fixture(t),s=f.store;authorize(s);s.setThemeOverviewEnabled(true);
 const a=memory(s,'甲','same','conversation-one'),b=memory(s,'乙','same','conversation-two');s.saveThemeStatements(request(s,'group',[a,b]));s.forget(a.id,a.revision);
 assert.deepEqual(s.listThemeStatements().map(x=>x.evidence[0].memoryId),[b.id]);
});
test('previous version pausing learning is reconciled on reopen before derived content is exposed',t=>{
 const f=fixture(t);let s=f.store;authorize(s);s.setThemeOverviewEnabled(true);const row=memory(s,'甲'),pending=request(s,'theme',[row]);s.saveThemeStatements(pending);
 // A rollback version does not know the new cleanup hook.
 s.db.prepare("UPDATE learning_state SET value=? WHERE key='learning'").run(JSON.stringify({enabled:false,grantId:null}));
 s=f.reopen();assert.equal(s.themeOverviewEnabled(),false);assert.equal(s.db.prepare('SELECT COUNT(*) n FROM theme_statements').get().n,0);
 authorize(s);s.setThemeOverviewEnabled(true);assert.throws(()=>s.saveThemeStatements(pending),/授权已变化/);
});
test('real storage and host revalidate source then save and remove a derived project statement',async t=>{
 const {SessionStore}=await import('../../../../dist/history/session-store.js');
 const {PluginBackground}=await import('../../../../dist/extensions/background.js');
 const {Assistant}=await import('../shared.mjs');
 const {maybeConsolidateOverview,themeEvidenceValid}=await import('../theme-overviews.mjs');
 const {themeRecall}=await import('../context.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'theme-real-host-'));const controller=new AbortController();
 const target={id:'a',instanceId:'a',kind:'agent',cwd:dir,title:'A',model:'m',provider:'p',busy:false,projectId:'b'};
 const history=new SessionStore(path.join(dir,'a.jsonl'),{create:{sessionId:'a',cwd:dir}});
 const original='项目乙决定采用方案甲';const [id]=await history.appendMessages([{role:'user',content:original}]);let calls=0;
 const host=new PluginBackground(path.join(dir,'grant.json'),{targets:()=>[target],store:()=>history,complete:async()=>{calls++;return '{"indices":[0]}'}},controller.signal);
 const api=host.bind('plugin',controller.signal);const grant=host.approve('plugin',host.prepare('plugin',{modelSessionId:'a',includedIds:['a'],dailyCalls:4,includeHistory:true,excludedIds:[],followModel:true}));
 const assistant=new Assistant({dataDirectory:dir,background:api,conversations:{get:()=>target.id},host:{snapshot:()=>({sessions:[target],projects:[{id:'b',name:'乙'}]}),projectNames:(entry,conversation,grantId)=>{assert.equal(entry,'assistant');assert.equal(conversation,target.id);assert.equal(grantId,grant);const authorization=api.status(grantId);assert.equal(authorization.followModel,true);assert.deepEqual(authorization.includedIds,[conversation]);return [{id:'b',name:'乙',nameSince:0,nameObserved:'乙'}];}}});
 t.after(()=>{assistant.stop();controller.abort();history.close?.();fs.rmSync(dir,{recursive:true,force:true})});
 const s=assistant.store,c={enabled:true,grantId:grant,modelSessionId:'a'};s.setState('learning',c);s.setThemeOverviewEnabled(true);
 const row=s.add({title:'项目决策',content:original,kind:'fact',scope:'project:b'}, {type:'learned',grantId:grant,context:{projectId:'b',subject:'project',conversationId:'a'},refs:[{conversationId:'a',id,quote:original,at:api.entry(grant,'a',id,0).at,start:0,end:original.length}]},'active');
 assert.equal(await maybeConsolidateOverview(assistant.learning,c,target,assistant.learning.controller.signal),true);assert.equal(calls,1);
 const [saved]=s.listThemeStatements();assert.equal(saved.text,original);assert.equal(saved.evidence[0].memoryId,row.id);assert(themeEvidenceValid(assistant,saved));
 const overview=themeRecall(assistant,target,'项目乙决策演变脉络');assert(overview);assert.equal(overview.statements[0].text,original);
 api.revoke(grant);assert(!themeEvidenceValid(assistant,saved));s.forget(row.id,row.revision);assert.deepEqual(s.listThemeStatements(),[]);
});
test('legacy Node lacking isTransaction supports learning state inside store transaction',t=>{
 const s=fixture(t).store,db=s.db;s.db=new Proxy(db,{get(target,key){if(key==='isTransaction')return undefined;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}});
 s.transaction(()=>s.setState('learning',{enabled:true,grantId:'grant'}));assert.equal(s.state('learning').enabled,true);
});
test('forget physically removes derived copies caught by history guard without erasing independently evidenced statements',t=>{
 const s=fixture(t).store;authorize(s);s.setThemeOverviewEnabled(true);
 const quote='我对花生过敏需要避免花生油';
 const create=(name,content,id,original)=>s.add({title:name,content,kind:'fact',scope:'personal'},
  {type:'learned',namespace:'assistant-v4',grantId:'grant',context:{subject:'user',conversationId:'conversation'},refs:[{conversationId:'conversation',id,quote:original,start:0,end:original.length}]},'active');
 const forgotten=create('过敏事实',quote,'source-old',quote);
 const copied=create('聚餐提示','聚餐注意食物风险','source-copy','提醒：'+quote+'。');
 const independent=create('答复习惯','回复先列依据','source-independent','答复请先列出依据然后给总结');
 const pending=request(s,'theme',[copied,independent]);s.saveThemeStatements(pending);s.forget(forgotten.id,forgotten.revision);
 assert.throws(()=>s.saveThemeStatements(pending),/证据已变化/,'a late result backed by a forgotten copy must not recreate its body');
 const rows=s.db.prepare('SELECT body FROM theme_statements').all();assert.equal(rows.length,1);assert.match(rows[0].body,/陈述 theme 1/);
 assert.equal(s.db.prepare('SELECT COUNT(*) n FROM theme_evidence').get().n,1);
});
test('unknown legacy forgotten source fails closed on new publication without deleting independent statements',t=>{
 const s=fixture(t).store;authorize(s);s.setThemeOverviewEnabled(true);const row=memory(s,'独立证据','independent');const pending=request(s,'theme',[row]);s.saveThemeStatements(pending);
 // Old databases may retain only ignored IDs and lack recoverable fingerprints.
 s.setState('ignored:conversation',['unknown-legacy-source']);
 assert.equal(s.listThemeStatements().length,1,'uncertain provenance must not physically erase independent data');
 assert.throws(()=>s.saveThemeStatements(pending),/证据已变化/,'new publication must fail closed until history is revalidated');
});
