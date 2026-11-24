import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from '../store.mjs';
import { retrieve } from '../retrieval.mjs';
import { stableNumberMatch } from '../context.mjs';
const create=(t)=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recall-index-'));const store=new MemoryStore(dir);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});return store};
const add=(store,title,content,scope='personal',kind='fact')=>store.add({title,content,scope,kind},{type:'user',at:1},'active');
const assistant=(store,valid=()=>true)=>({store,learning:{validator:()=>valid},snapshot:()=>({projects:[{id:'p',name:'项目甲'},{id:'q',name:'项目乙'}]})});
const ids=rows=>rows.map(x=>x.id);
test('index updates, forget and migration preserve search and exact identifiers',t=>{
 const store=create(t),row=add(store,'记录','部署版本 build-123 和安全措施'); const a=assistant(store);
 assert(ids(retrieve(a,{},'build-123',8,true,true)).includes(row.id));
 assert(!ids(retrieve(a,{},'build-124',8,true,true,{accept:r=>stableNumberMatch('build-124',r)})).includes(row.id));
 const changed=store.edit(row.id,row.revision,{title:'记录',content:'部署版本 build-987 和安全措施',scope:'personal',kind:'fact'});
 assert(!ids(retrieve(a,{},'build-123',8,true,true,{accept:r=>stableNumberMatch('build-123',r)})).includes(row.id));
 assert(ids(retrieve(a,{},'build-987',8,true,true)).includes(row.id));
 store.db.prepare("DELETE FROM learning_state WHERE key='recall-index-format'").run();store.db.prepare('DELETE FROM memory_search').run();
 const dir=path.dirname(store.db.location());store.close();const reopened=new MemoryStore(dir);
 try {assert(ids(retrieve(assistant(reopened),{},'build-987',8,true,true)).includes(row.id));reopened.forget(row.id,changed.revision);assert.equal(retrieve(assistant(reopened),{},'build-987',8,true,true).length,0)} finally {reopened.close()}
 // Restore fixture connection for teardown.
 store.db=new DatabaseSync(path.join(dir,'memory.sqlite'));
});
test('concept routing, project boundary, style and irrelevant input match legacy behavior',t=>{
 const store=create(t),age=add(store,'个人资料','我今年42岁'),food=add(store,'饮食限制','花生过敏'),foreign=add(store,'项目乙配置','项目乙的菜单采用蓝色','project:q'),style=add(store,'回复偏好','请用中文简洁回答','personal','preference');
 const a=assistant(store),session={projectId:'p'};
 assert(ids(retrieve(a,session,'我的年龄是多少',8,true,true)).includes(age.id));
 assert(ids(retrieve(a,session,'晚餐有什么要注意',8,true,true)).includes(food.id));
 assert(!ids(retrieve(a,session,'菜单有什么要求',8,true,true)).includes(foreign.id));
 assert(ids(retrieve(a,session,'二叉树是什么',8,true,true)).includes(style.id));
 assert.deepEqual(ids(retrieve(a,session,'火箭引擎材料',8,false,true)),[]);
});
test('matched candidates refill in bounded authorization windows',()=>{
 const rows=Array.from({length:410},(_,i)=>({id:String(i).padStart(3,'0'),title:'共同主题',content:'共同主题 '+i,kind:'fact',scope:'personal',created:1,source:{context:{subject:'user'}}}));
 let prefetched=false,scans=0,calls=0;
 const valid=row=>{assert(prefetched);return row.id==='400'};
 valid.prefetch=batch=>{assert(batch.length<=24);prefetched=true};
 const store={recallCandidates:(_terms,limit,offset)=>{calls++;return rows.slice(offset,offset+limit)},activeMemories:()=>{scans++;return rows}};
 const a=assistant(store,valid);
 assert.deepEqual(ids(retrieve(a,{},'共同主题',4,false,false,{window:24})),['400']);
 assert.equal(scans,0);assert.equal(calls,1);
});
test('normal matching candidates validate only the needed results',()=>{
 const rows=Array.from({length:60},(_,i)=>({id:String(i),title:'共同主题',content:'共同主题 '+i,kind:'fact',scope:'personal',created:1,source:{context:{subject:'user'}}}));
 let calls=0;const store={recallCandidates:(_t,n,o)=>{calls++;return rows.slice(o,o+n)},activeMemories:()=>{throw Error('unexpected fallback')}};
 assert.equal(retrieve(assistant(store),{},'共同主题',4,false).length,4);assert.equal(calls,1);
});
test('explicit legacy path and unavailable index fallback remain comparable',t=>{
 const store=create(t),row=add(store,'专业','我的专业是材料科学');const a=assistant(store);
 assert.deepEqual(ids(retrieve(a,{},'我的专业',8,false,true)),ids(retrieve(a,{},'我的专业',8,false,true,{legacy:true})));
 store.recallCandidates=()=>{throw Error('index unavailable')};assert(ids(retrieve(a,{},'我的专业',8,false,true)).includes(row.id));
});
test('full identifiers survive 50 closer lexical distractors in auto and explicit queries',t=>{
 const store=create(t),a=assistant(store);
 const port=add(store,'旧联系人','负责人林澄，地址 192.168.1.13:7878'),version=add(store,'升级备忘','版本 0.21.6 使用北岛'),part=add(store,'旧备件','组件 PL-792B 配铜线');
 for(let i=0;i<50;i++){
  add(store,'旧设备联系人','识别代码 192.168.1.13:'+(7880+i)+' 原始旧设备联系人 '+i);
  add(store,'升级核对原始发版','升级核对 v0.21.'+(10+i)+' 原始发版负责人 '+i);
  add(store,'采购单号旧备件归档','采购单号 PL-792'+(100+i)+' 的全部旧备件归档报告 '+i);
 }
 for(const [query,wanted] of [['识别代码 192.168.1.13:7878 原始旧设备联系人',port],['升级核对 v0.21.6 原始发版代号',version],['采购单号 ＰＬ－７９２Ｂ 全部旧备件归档报告',part]]){
  assert(ids(retrieve(a,{},query,8,false,true)).includes(wanted.id),query);
  assert(ids(retrieve(a,{},query,12,true,true,{accept:r=>stableNumberMatch(query,r)})).includes(wanted.id),query);
 }
});
test('actual FTS refills after 260 revoked candidates and restores eligibility',t=>{
 const store=create(t),wanted=add(store,'玉桂路线','玉桂路线使用树皮标记'),invalid=new Set();
 for(let i=0;i<260;i++)invalid.add(add(store,'玉桂路线短程西行','玉桂路线短程西行候选 '+i).id);
 const a=assistant(store,row=>!invalid.has(row.id));
 assert(ids(retrieve(a,{},'玉桂路线短程西行',8,true,true)).includes(wanted.id));
 invalid.add(wanted.id);assert(!ids(retrieve(a,{},'玉桂路线短程西行',8,true,true)).includes(wanted.id));
 invalid.delete(wanted.id);assert(ids(retrieve(a,{},'玉桂路线短程西行',8,true,true)).includes(wanted.id));
});

test('legacy FTS writes after upgrade trigger repair without forgetting resurrection',t=>{
 const store=create(t),style=add(store,'旧风格','回答先说结论','personal','preference');
 // Emulate a previous version editing shared FTS and its transactional change log.
 const legacyWrite=(row,body)=>store.transaction(()=>{
  store.db.prepare('UPDATE memories SET content=?,revision=revision+1 WHERE id=?').run(body,row.id);
  store.db.prepare('DELETE FROM memory_search WHERE id=?').run(row.id);
  store.db.prepare('INSERT INTO memory_search(id,terms) VALUES(?,?)').run(row.id,body);
  store.db.prepare("INSERT INTO changes(memory_id,action,at) VALUES(?,'edit',1)").run(row.id);
 });
 legacyWrite(style,'回答请先报关键风险');
 add(store,'新版写入','不应掩盖旧版的索引过期');
 assert(ids(retrieve(assistant(store),{},'解释余弦',4,true)).includes(style.id));
 const updated=store.get(style.id);store.forget(updated.id,updated.revision);
 assert(!ids(retrieve(assistant(store),{},'解释余弦',4,true)).includes(style.id));
});
test('fullwidth applicability is indexed after equivalent normalization',t=>{
 const store=create(t),row=add(store,'健康备忘','ｐｅａｎｕｔ ａｌｌｅｒｇｙ');
 assert(ids(retrieve(assistant(store),{},'晚餐怎么安排',4,true)).includes(row.id));
});
test('exact postings are candidates only and FTS failure still matches short complete identifier',t=>{
 const store=create(t),fake=add(store,'字面字符串','编码值 exact712d382d78'),real=add(store,'维修编号','关联工单 Q-8-X');const a=assistant(store);
 assert.deepEqual(ids(retrieve(a,{},'Q-8-X')), [real.id]);
 store.recallCandidates=()=>{throw Error('FTS unavailable')};
 assert.deepEqual(ids(retrieve(a,{},'Q-8-X')), [real.id]);
});
test('middle query term is not truncated',t=>{
 const store=create(t),row=add(store,'定位','皓月矿石');
 const query=Array.from({length:55},(_,i)=>'a'+String(i).padStart(2,'0')).join(' ')+' 皓月矿石 '+Array.from({length:55},(_,i)=>'b'+String(i).padStart(2,'0')).join(' ');
 assert(query.length<=500);assert(ids(retrieve(assistant(store),{},query)).includes(row.id));
});
test('complete matched FTS set refills after more than 384 invalid candidates',t=>{
 const store=create(t),wanted=add(store,'玉桂路线','玉桂路线使用树皮标记'),invalid=new Set();
 for(let i=0;i<410;i++)invalid.add(add(store,'玉桂路线短程西行','玉桂路线短程西行候选 '+i).id);
 const original=store.activeMemories.bind(store);let fallback=0;store.activeMemories=()=>{fallback++;return original()};
 const found=retrieve(assistant(store,row=>!invalid.has(row.id)),{},'玉桂路线短程西行',4,true,true);
 assert(ids(found).includes(wanted.id));assert.equal(fallback,0);
});
test('exact identifier outranks arbitrarily many lexical matches',t=>{
 const store=create(t),wanted=add(store,'储物箱','塔台钥匙保存在 Q-8-X。');
 const phrase='俄罗斯圣彼得堡夜间道路清扫专用设备采购计划急需了解负责人姓名报销凭证和发票规格安装到货完整安排，针对布雷顿森林体系的相关流程委托采购库。';
 for(let i=0;i<10;i++)add(store,'近似流程',`${phrase} Q-${i+20}-X 的采购文件负责人另附。`);
 const found=retrieve(assistant(store),{},`${phrase} 查询 Q-8-X 真实内容`,8);
 assert.equal(found[0].id,wanted.id);
});
test('empty derived FTS is repaired on the live connection without reviving forgotten rows',t=>{
 const store=create(t),row=add(store,'保留','回答先说明风险','personal','preference'),forgotten=add(store,'遗忘','秘密编号 ZZ-188');
 store.forget(forgotten.id,forgotten.revision);store.db.prepare('DELETE FROM memory_search').run();
 assert(ids(retrieve(assistant(store),{},'解释余弦',4,true)).includes(row.id));
 assert(!ids(retrieve(assistant(store),{},'ZZ-188',4,true)).includes(forgotten.id));
});
test('AND candidate lane finds long complete match hidden behind short partial matches',t=>{
 const store=create(t),a=assistant(store),terms=['ember','glacier','harbor','orchid','zephyr'],query=terms.join(' ');
 const wanted=add(store,'原始合同',query+' '+Array.from({length:120},(_,i)=>'appendix'+i).join(' '));
 for(let i=0;i<50;i++)add(store,'近似项目 '+i,terms.filter((_,j)=>j!==i%terms.length).join(' ')+' '+i);
 assert.equal(retrieve(a,{},query,8,false,true)[0].id,wanted.id);
 assert.equal(retrieve(a,{},query,8,false,true,{legacy:true})[0].id,wanted.id);
});
test('exact lane continues after unrelated lexical results fill requested count',t=>{
 const store=create(t),invalid=new Set(),wanted=add(store,'维修备忘','塔台钥匙保存在 Q-8-X。'+Array.from({length:50},(_,i)=>' 样本名r'+i).join(''));
 for(let i=0;i<30;i++)invalid.add(add(store,'作废','作废 Q-8-X '+i).id);
 for(let i=0;i<16;i++)add(store,'档案采购','档案采购实际经办是候补工位 '+i);
 const a=assistant(store,row=>!invalid.has(row.id));
 assert.equal(retrieve(a,{},'档案采购 Q-8-X 实际经办是谁',8,false,true)[0].id,wanted.id);
});

test('multiple identifiers rank complete match above many partial matches',t=>{
 const store=create(t),a=assistant(store),terms=['Q-8-X','Q-9-Z'],query=terms.join(' ');
 const wanted=add(store,'原始合同',query+' '+Array.from({length:120},(_,i)=>'appendix'+i).join(' '));
 for(let i=0;i<50;i++)add(store,'近似项目 '+i,terms.filter((_,j)=>j!==i%2).join(' ')+' '+i);
 assert.equal(retrieve(a,{},query,8,false,true)[0].id,wanted.id);
});
test('extra absent term does not hide highest coverage long candidate',t=>{
 const store=create(t),a=assistant(store),terms=['灯塔','补给','钥匙','工时','货仓'];
 const wanted=add(store,'沿岸核验',terms.join(' ')+' '+Array.from({length:50},(_,i)=>'附件k'+i).join(' '));
 for(let i=0;i<40;i++)add(store,'巡查条目 '+i,terms.filter((_,j)=>j!==i%5).join(' ')+' '+i);
 assert.equal(retrieve(a,{},[...terms,'探索'].join(' '),8,false,true)[0].id,wanted.id);
});
test('standalone underscore query uses bounded legacy search and validates authorization',t=>{
 const store=create(t),one=add(store,'代码约定','中间分隔符使用 __ 。'),two=add(store,'其他分隔符','字段以 ___ 分隔。');
 let prefetched=0,checked=0;
 const valid=row=>{checked++;return row.id!==one.id};valid.prefetch=rows=>{prefetched++;assert(rows.length<=24)};
 const allowed=assistant(store),restricted=assistant(store,valid);
 assert.deepEqual(ids(retrieve(allowed,{},'查找 __')), [one.id]);
 assert.deepEqual(ids(retrieve(allowed,{},'查找 ___')), [two.id]);
 assert.deepEqual(ids(retrieve(restricted,{},'查找 __')), []);assert(prefetched>0&&checked>0);
 store.forget(one.id,one.revision);assert.deepEqual(ids(retrieve(allowed,{},'查找 __')), []);
});
