import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PluginBackground } from '../dist/extensions/background.js';
import { SessionStore } from '../dist/history/session-store.js';
import { Learning } from '../examples/extensions/personal-assistant/learning.mjs';

test('host cache follows authorization, store identity, revisions and branch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-source-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const target = { id:'a', cwd:dir, title:'A', model:'m', provider:'p', busy:false };
  let store = new SessionStore(path.join(dir, 'a.jsonl'), { create:{ sessionId:'a', cwd:dir } });
  const host = new PluginBackground(path.join(dir, 'grants.json'), { targets:()=>[target], store:()=>store, complete:async()=>'' }, new AbortController().signal);
  const api = host.bind('plugin', new AbortController().signal);
  const approve = extra => host.approve('plugin', host.prepare('plugin', { modelSessionId:'a', dailyCalls:1, includeHistory:true, excludedIds:[], ...extra }));
  const [first, second] = await store.appendMessages([{role:'user',content:'one'},{role:'user',content:'two'}]);
  let reads = 0, original = store.getHistoryEntries.bind(store);
  store.getHistoryEntries = (...args) => { reads++; return original(...args); };
  let grant = approve({});
  assert.deepEqual(api.valid(grant,'a',[first,second]), [first,second]);
  assert.deepEqual(api.valid(grant,'a',[second]), [second]);
  assert.equal(reads,1);
  assert.throws(()=>api.valid(grant,'a',Array(201).fill(first)),/Invalid source IDs/);
  store.setActiveLeaf(first);
  assert.deepEqual(api.valid(grant,'a',[first,second]),[first]);
  const [third] = await store.appendMessages([{role:'user',content:'three'}]);
  assert.deepEqual(api.valid(grant,'a',[second,third]),[third]);
  const old = grant; grant = approve({includeHistory:false});
  assert.throws(()=>api.valid(old,'a',[first]));
  assert.deepEqual(api.valid(grant,'a',[first]),[]);
  api.revoke(grant); assert.throws(()=>api.valid(grant,'a',[third]));
  grant = approve({});
  store = new SessionStore(path.join(dir,'replacement.jsonl'), { create:{ sessionId:'a',cwd:dir } });
  await store.appendMessages([{role:'user',content:'replacement'}]);
  assert.deepEqual(api.valid(grant,'a',[first,third]),[]);
  assert.throws(()=>api.valid(grant,'b',[first]),/outside/);
});

test('prefetch deduplicates and batches sources, feedback and question IDs and fails closed', () => {
  const calls = [], unavailable = new Set(['missing']);
  const api = {status:()=>({excludedIds:[]}), targets:()=>[{id:'a'},{id:'b'}], valid:(_grant,id,ids)=>{
    calls.push([id,ids]); if (id === 'b') throw Error('unavailable'); return ids.filter(x=>!unavailable.has(x));
  }};
  const db = {state:()=>({enabled:true,grantId:'g'}),forgottenCopy:()=>false};
  const learning = new Learning({store:db,services:{background:api},visible:()=>true,dedicated:false});
  const refs = Array.from({length:405},(_,i)=>({conversationId:'a',id:`id${i}`}));
  const row = {source:{type:'learned',grantId:'g',refs,feedback:[{conversationId:'a',id:'feedback',contextId:'question'}]}};
  const missing = {source:{type:'learned',grantId:'g',refs:[{conversationId:'a',id:'missing'}]}};
  const denied = {source:{type:'learned',grantId:'g',refs:[{conversationId:'b',id:'bad'}]}};
  const valid = learning.validator(); valid.prefetch([row,row,missing,denied]);
  assert.deepEqual(calls.map(([id,ids])=>[id,ids.length]),[['a',200],['a',200],['a',8],['b',1]]);
  assert(valid(row)); assert(!valid(missing)); assert(!valid(denied));
  assert.equal(calls.length,5, 'failed batch is retried and denied individually');
  assert(calls.flatMap(([,ids])=>ids).includes('question'));
  assert(calls.flatMap(([,ids])=>ids).includes('feedback'));
});

test('long unauthorized history advances empty pages without accepting their IDs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-pages-'));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const target = {id:'a',cwd:dir,title:'A',model:'m',provider:'p',busy:false};
  const rows = Array.from({length:105},(_,i)=>({id:`old${i}`,timestamp:0,message:{role:'user',content:'old'}}));
  let revision = 0;
  const store = {getRevision:()=>revision,getActiveLeaf:()=>String(revision),getHistoryEntries:()=>rows.slice()};
  const host = new PluginBackground(path.join(dir,'grant.json'),{targets:()=>[target],store:()=>store,complete:async()=>''},new AbortController().signal);
  const api = host.bind('plugin',new AbortController().signal);
  const grant = host.approve('plugin',host.prepare('plugin',{modelSessionId:'a',dailyCalls:1,includeHistory:false,excludedIds:[]}));
  let cursor, pages = 0, page;
  do { page = api.read(grant,'a',cursor); assert.deepEqual(page.entries,[]); cursor=page.cursor; pages++; } while(page.more && pages < 10);
  assert.equal(pages,3); assert.equal(cursor,'old104');
  assert.deepEqual(api.valid(grant,'a',['old0','old104']),[]);
  rows.push({id:'new',timestamp:Date.now()+1,message:{role:'user',content:'new'}}); revision++;
  assert.deepEqual(api.read(grant,'a',cursor).entries.map(e=>e.id),['new']);
  assert.deepEqual(api.valid(grant,'a',['old104','new']),['new']);
});

test('failed bulk validation falls back per source while partial success stays authoritative', () => {
  let mode = 'bulk-fails'; const calls = [];
  const api = {status:()=>({excludedIds:[]}),targets:()=>[{id:'a'}],valid:(_grant,_id,ids)=>{
    calls.push([...ids]);
    if (mode === 'revoked' || (mode === 'bulk-fails' && ids.length > 1) || ids.includes('single-fails')) throw Error('unavailable');
    return ids.filter(id=>id === 'allowed');
  }};
  const db = {state:()=>({enabled:true,grantId:'g'}),forgottenCopy:()=>false};
  const learning = new Learning({store:db,services:{background:api},visible:()=>true,dedicated:false});
  const row = id => ({source:{type:'learned',grantId:'g',refs:[{conversationId:'a',id}]}});
  const rows = ['allowed','missing','single-fails'].map(row);
  let valid = learning.validator(); valid.prefetch(rows);
  assert(valid(rows[0])); assert(!valid(rows[1])); assert(!valid(rows[2]));
  assert.deepEqual(calls.map(ids=>ids.length),[3,1,1,1]);
  mode = 'partial'; calls.length = 0; valid = learning.validator(); valid.prefetch(rows.slice(0,2));
  assert(valid(rows[0])); assert(!valid(rows[1])); assert.deepEqual(calls.map(ids=>ids.length),[2]);
  mode = 'revoked'; calls.length = 0; valid = learning.validator(); valid.prefetch(rows.slice(0,2));
  assert(!valid(rows[0])); assert(!valid(rows[1]));
});

test('latestUser walks backward and skips unauthorized or non-user entries', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'latest-user-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const target = {id:'a',cwd:dir,title:'A',model:'m',provider:'p',busy:false};
  const store = new SessionStore(path.join(dir,'a.jsonl'),{create:{sessionId:'a',cwd:dir}});
  const host = new PluginBackground(path.join(dir,'grant.json'),{targets:()=>[target],store:()=>store,complete:async()=>''},new AbortController().signal);
  const api = host.bind('plugin',new AbortController().signal);
  const grant = host.approve('plugin',host.prepare('plugin',{modelSessionId:'a',dailyCalls:1,includeHistory:true,excludedIds:[]}));
  assert.equal(api.latestUser(grant,'a'),null);
  const [user] = await store.appendMessages([{role:'user',content:'hello'},{role:'assistant',content:'reply'}]);
  assert.equal(api.latestUser(grant,'a'),user);
  const [latest] = await store.appendMessages([{role:'user',content:'next'}]);
  assert.equal(api.latestUser(grant,'a'),latest);
  store.setActiveLeaf(user); assert.equal(api.latestUser(grant,'a'),user);
  api.revoke(grant); assert.throws(()=>api.latestUser(grant,'a'));
});
