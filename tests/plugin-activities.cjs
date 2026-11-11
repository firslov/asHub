const test=require('node:test');
const assert=require('node:assert/strict');
const {env}=require('./harness.cjs');
test('activity hints are bounded, scoped, immutable and removed on disable',()=>{
 const {PluginActivities}=env().load('src/services/plugin-activities.ts');let valid=true,changes=0;
 const service=new PluginActivities((p,s)=>valid&&p==='p'&&s==='owner',()=>changes++),control=new AbortController(),api=service.bind('plugin',control.signal);
 const hint={id:'work',projectId:'p',sessionId:'owner',label:'验收中',state:'running'};
 api.replace([hint]);assert.equal(changes,1);api.replace([hint]);assert.equal(changes,1);
 hint.label='changed';assert.equal(service.list('p')[0].label,'验收中');
 service.list('p')[0].label='changed';assert.equal(service.list('p')[0].label,'验收中');
 assert.equal(service.list('other').length,0);assert.throws(()=>api.replace([{...hint,label:'x'.repeat(201)}]));
 valid=false;assert.equal(service.list('p').length,0);valid=true;
 control.abort();assert.equal(service.list('p').length,0);assert.throws(()=>api.replace([hint]));
});
