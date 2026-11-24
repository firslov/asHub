import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Assistant } from '../shared.mjs';
import { recall } from '../context.mjs';
function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-budget-fill-'));
 const session={instanceId:'budget',kind:'agent',cwd:dir};
 const a=new Assistant({dataDirectory:dir,host:{snapshot:()=>({sessions:[session],projects:[]})}});
 a.store.bind('budget',dir,true);t.after(()=>{a.stop();fs.rmSync(dir,{recursive:true,force:true})});return a;
}
function add(a,i,size,at) {
 return a.store.add({title:'主题 '+i,content:'预算测试 规则 '+i+' '+ '\"'.repeat(size),kind:'fact',scope:'personal'},
  {type:'user',at,context:{subject:'user'}},'active');
}
test('auto recall skips more than twelve oversize records to admit a fitting authorized memory',t=>{
 const a=fixture(t),wanted=add(a,'short',0,1);
 for(let i=0;i<13;i++)add(a,i,1700,100+i);
 const value=JSON.parse(recall(a,'budget','预算测试 规则'));
 assert.deepEqual(value.items.map(item=>item.id),[wanted.id]);assert(value.more);
 assert(value.items.reduce((n,item)=>n+JSON.stringify(item).length,0)<=2400);
});
test('auto recall fills remaining characters with shorter lower ranked memory',t=>{
 const a=fixture(t),first=add(a,'first',850,3),tooLarge=add(a,'large',500,2),last=add(a,'short',0,1);
 const value=JSON.parse(recall(a,'budget','预算测试 规则'));
 assert.deepEqual(value.items.map(item=>item.id),[first.id,last.id]);assert(!value.items.some(item=>item.id===tooLarge.id));
 assert(value.more);assert(value.items.reduce((n,item)=>n+JSON.stringify(item).length,0)<=2400);
});

test('four fitting records set more only when another valid distinct record is omitted',t=>{
 const a=fixture(t);for(let i=0;i<4;i++)add(a,i,0,10+i);
 let value=JSON.parse(recall(a,'budget','预算测试 规则'));
 assert.equal(value.items.length,4);assert.equal(value.more,undefined);
 add(a,'fifth',0,1);value=JSON.parse(recall(a,'budget','预算测试 规则'));
 assert.equal(value.items.length,4);assert(value.more);
});
test('explicit search keeps oversized items and ignores context budget',t=>{
 const a=fixture(t),row=add(a,'long',1700,5);
 assert(a.search('budget','预算测试 规则').some(result=>result.id===row.id));
});
test('unauthorized oversized memory does not count as omitted or consume budget',t=>{
 const a=fixture(t),denied=add(a,'denied',1700,10),wanted=add(a,'visible',0,1);
 const original=a.learning.validator.bind(a.learning);
 a.learning.validator=()=>{const valid=original();return row=>row.id!==denied.id && valid(row)};
 const value=JSON.parse(recall(a,'budget','预算测试 规则'));
 assert.deepEqual(value.items.map(item=>item.id),[wanted.id]);assert.equal(value.more,undefined);
});
