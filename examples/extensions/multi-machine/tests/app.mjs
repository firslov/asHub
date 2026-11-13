import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionResource} from '../app.mjs';
const device='A'.repeat(43);
test('plugin owns device selection and open action; no account controls are exposed remotely',async()=>{
 const opened=[],account={cookie:'opaque',user:'user',error:'',records:new Map([[device,{device:{name:'Office',online:true}}]]),openDevice:async id=>opened.push(id)};
 const resource=connectionResource(account);assert.equal(resource.remote,undefined);
 let view=resource.view();assert(!view.form);assert.equal(view.rows[0].primaryAction,'open');assert.deepEqual(view.rows[0].actions[0].values,{device});
 await (await resource.prepare('open',{device})).execute();assert.deepEqual(opened,[device]);
 await assert.rejects(resource.prepare('open',{device:'https://untrusted.invalid'}),/无效/);
 account.records.get(device).device.online=false;view=resource.view();assert.equal(view.rows[0].primaryAction,undefined);assert.deepEqual(view.rows[0].actions,[]);
 account.cookie='';account.records.clear();view=resource.view();assert(view.form);assert.deepEqual(view.rows,[]);assert.deepEqual(view.actions,[]);
 const login=await resource.prepare('login',{username:'user',password:'do-not-display'});assert(!JSON.stringify(login.preview).includes('do-not-display'));
});

test('one device page separates account login from host-confirmed local sharing',async()=>{
 let configured,disabled=0;const account={cookie:'',user:'',error:'',records:new Map(),login:async()=>{account.cookie='account-only';}};
 const sharing={status:()=>({enabled:false,roots:['/workspace'],username:'existing-user'}),configure:async(v,id)=>{configured={v,id};},disable:()=>disabled++};
 const resource=connectionResource(account,sharing);let view=resource.view();assert.equal(view.rows[0].title,'本机');assert(view.rows[0].actions.some(a=>a.id==='edit-sharing'));
 await (await resource.prepare('login',{username:'alice',password:'secret'})).execute();assert.equal(configured,undefined,'login does not publish local data');
 view=await(await resource.prepare('edit-sharing',{})).execute();assert.equal(view.form.action,'configure-sharing');assert(view.form.fields.some(f=>f.id==='roots'));
 const plan=await resource.prepare('configure-sharing',{username:'alice',password:'secret',roots:'/workspace\n/workspace/project'});assert.deepEqual(plan.sharingAuthorization,{roots:['/workspace','/workspace/project']});assert(!JSON.stringify(plan.preview).includes('secret'));
 await plan.execute('host-approved-grant');assert.equal(configured.id,'host-approved-grant');assert.equal(resource.view().form,undefined);
 await(await resource.prepare('disable-sharing',{})).execute();assert.equal(disabled,1);assert.equal(account.cookie,'account-only','stopping publication keeps controller login');
});
