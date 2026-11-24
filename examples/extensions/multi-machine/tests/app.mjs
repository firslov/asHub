import test from 'node:test';
import assert from 'node:assert/strict';
import {connectionResource} from '../app.mjs';
const device='A'.repeat(43);
test('separate overview sections, explicit sharing controls and phone entry without an extra copy action',async()=>{
 const opened=[],account={cookie:'opaque',user:'controller',error:'',records:new Map([[device,{device:{name:'Office',online:true}}]]),openDevice:async id=>opened.push(id)};
 const sharing={status:()=>({enabled:true,status:'online',roots:['/workspace'],username:'publisher',deviceName:'Mac',gateway:'https://example.test/mobile/'})};
 const resource=connectionResource(account,sharing);assert.equal(resource.remote,undefined);
 const view=resource.view();assert(!view.form);assert.deepEqual([...new Set(view.rows.map(r=>r.section))],['访问其他电脑','允许其他设备访问本机']);
 assert.equal(view.rows[0].title,'controller');account.user='';assert.equal(resource.view().rows[0].title,'已登录连接账号','restored credentials without a username must not look signed out');const local=view.rows.at(-1);assert.match(local.status,/publisher/);assert(local.inlineActions);
 assert(local.actions.some(a=>a.id==='disable-sharing'));assert(!local.actions.some(a=>a.id==='copy-entry'));assert.match(view.rows.find(r=>r.title==='手机入口').detail,/https:\/\/example.test\/mobile\//);
 await (await resource.prepare('open',{device})).execute();assert.deepEqual(opened,[device]);
 await assert.rejects(resource.prepare('open',{device:'https://untrusted.invalid'}),/无效/);
 account.records.get(device).device.online=false;assert.deepEqual(resource.view().rows[1].actions,[]);
});
test('phone QR follows the public gateway and excludes credentials and private state',()=>{
 const account={cookie:'controller-credential',user:'controller',records:new Map()};
 const local={gateway:'https://example.test/mobile/',enabled:true,status:'online',roots:['/private-root'],username:'publisher'};
 const resource=connectionResource(account,{status:()=>local,recovery:'account-recovery'});
 const row=()=>resource.view().rows.find(r=>r.title==='手机入口');
 const first=row().qr;
 assert(first.label);assert(first.modules.length>=21);
 assert(first.modules.every(r=>r.length===first.modules.length && /^[01]+$/.test(r)));
 assert.equal(row().detail,'https://example.test/mobile/');
 local.gateway='https://example.test/another/';
 assert.notDeepEqual(row().qr.modules,first.modules);
 local.gateway='https://example.test/mobile/';
 account.cookie='different-token';local.username='different-account';local.roots=['/other-root'];
 assert.deepEqual(row().qr,first);
 for(const invalid of ['https://user:secret@example.test/mobile/', 'https://example.test/?token=secret', 'https://example.test/#secret', 'http://localhost/mobile/', 'javascript:secret']) {
  local.gateway=invalid;
  assert.equal(row(),undefined);assert.doesNotMatch(JSON.stringify(resource.view()),/secret|localhost/);
 }
 local.gateway='https://example.test/'+ 'a'.repeat(520);
 assert.equal(row().qr,undefined);assert(row().detail.includes(local.gateway));
});
test('daily directory edit is separate, cancellation is inert, delta is reviewed and sharing/account operations stay independent',async()=>{
 let configured,updated,disabled=0,revision={};
 const account={cookie:'',user:'',error:'',records:new Map(),login:async()=>{account.cookie='controller';},logout:async()=>{account.cookie='';}};
 const local={enabled:true,status:'online',roots:['/workspace','/old'],username:'publisher'};
 const sharing={status:()=>local,directoryChange:roots=>({roots,added:roots.filter(p=>!local.roots.includes(p)),removed:local.roots.filter(p=>!roots.includes(p))}),revision:()=>revision,updateRoots:async(id,rev)=>{assert.equal(rev,revision);updated=id;},configure:async(v,id)=>{configured={v,id};},disable:()=>{disabled++;local.enabled=false;}};
 const resource=connectionResource(account,sharing);
 await (await resource.prepare('login',{username:'controller',password:'secret'})).execute();assert.equal(configured,undefined);
 let view=await(await resource.prepare('edit-sharing',{})).execute();assert.equal(view.form.action,'update-roots');assert.deepEqual(view.form.fields.map(f=>f.id),['roots']);assert.equal(view.form.fields[0].type,'directories');
 await(await resource.prepare('cancel-sharing',{})).execute();assert.equal(updated,undefined);assert.deepEqual(local.roots,['/workspace','/old']);
 const plan=await resource.prepare('update-roots',{roots:'/workspace\n/new\n/new'});assert.deepEqual(plan.sharingAuthorization,{roots:['/workspace','/new']});
 assert.equal(plan.preview.fields[0].value,'/new');assert.equal(plan.preview.fields[1].value,'/old');assert.match(plan.preview.fields[2].value,/不会删除/);
 await plan.execute('approved');assert.equal(updated,'approved');assert.equal(configured,undefined);
 view=await(await resource.prepare('bind-sharing',{})).execute();assert.equal(view.form.action,'configure-sharing');assert(view.form.fields.some(f=>f.type==='password'));
 const binding=await resource.prepare('configure-sharing',{username:'publisher',password:'secret',roots:'/workspace'});assert(!JSON.stringify(binding.preview).includes('secret'));await binding.execute('bound');assert.equal(configured.id,'bound');
 await(await resource.prepare('logout',{})).execute();assert.equal(local.enabled,true);assert.equal(disabled,0);
 account.cookie='controller';const stop=await resource.prepare('disable-sharing',{});assert.match(stop.preview.fields[0].value,/手机和其他电脑/);assert.equal(disabled,0);await stop.execute();assert.equal(disabled,1);assert.equal(account.cookie,'controller');
 await assert.rejects(resource.prepare('update-roots',{roots:'/new'}),/重新验证/);
 local.enabled=true;local.status='revoked';await assert.rejects(resource.prepare('update-roots',{roots:'/new'}),/重新验证/);
});

test('device overview gives actionable loading, empty, offline, unknown and expired states',async()=>{
 const account={cookie:'token',records:new Map(),error:'network',discovery:'loading'};
 const resource=connectionResource(account);
 assert.equal(resource.view().rows[0].status,'正在查询设备…');account.discovery='ready';
 assert.equal(resource.view().rows[0].status,'暂无已授权设备');assert.match(resource.view().rows[0].detail,/设备互联 → 允许其他设备访问本机/);
 account.records.set(device,{device:{name:'Office',online:false}});assert.equal(resource.view().rows[1].status,'离线');assert.match(resource.view().rows[1].detail,/启动 asHub/);
 account.discovery='error';assert.equal(resource.view().rows[1].status,'状态待确认');assert.equal(resource.view().rows[1].actions[0].label,'核验并打开');assert.match(resource.view().rows[1].actions[0].pendingLabel,/Office/);
 account.cookie='';account.records.clear();account.discovery='expired';assert.equal(resource.view().rows[0].status,'登录已过期');assert.equal(resource.view().rows[0].actions[0].id,'connect-account');
 await(await resource.prepare('connect-account',{})).execute();assert(resource.view().form);account.showDevices();assert(!resource.view().form);
});
