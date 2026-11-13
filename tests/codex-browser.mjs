import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const appRoot = process.env.ASHUB_TEST_APP_ROOT || path.resolve(import.meta.dirname, '..');
const { openBrowser } = await import(pathToFileURL(path.join(appRoot, 'node_modules/agent-sh/dist/agent/extensions/codex-provider/auth.js')).href);

const loginURL = 'https://auth.openai.com/oauth/authorize?response_type=code&client_id=test&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid+profile&code_challenge=test&code_challenge_method=S256&state=test';
const unusualURL = loginURL + '&literal=%PATH%&quoted=\'"&value=$(throw "must not execute")&unicode=中文';

// Capture the real launcher without opening browsers or contacting OAuth.
function capture(platform, url, failure) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const original = childProcess.spawn;
  let call;
  let unref = false;
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    childProcess.spawn = (command, args, options) => {
      call = { command, args, options };
      if (failure === 'throw') throw new Error('unavailable launcher');
      return {
        on(event, callback) {
          assert.equal(event, 'error');
          if (failure === 'event') callback(new Error('unavailable launcher'));
          return this;
        },
        unref() { unref = true; },
      };
    };
    syncBuiltinESMExports();
    openBrowser(url);
    return { ...call, unref };
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', descriptor);
  }
}

test('Windows launcher preserves the complete OAuth URL outside shell source', () => {
  for (const url of [loginURL, unusualURL]) {
    const { command, args, options, unref } = capture('win32', url);
    assert.equal(command, 'powershell.exe');
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:AGENT_SH_CODEX_LOGIN_URL']);
    assert.equal(options.env.AGENT_SH_CODEX_LOGIN_URL, url);
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path');
    assert.ok(pathKey);
    assert.equal(options.env[pathKey], process.env[pathKey]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio, 'ignore');
    assert.equal(options.detached, true);
    assert.equal(options.shell, undefined);
    assert.equal(unref, true);
  }
});

test('macOS and Linux launchers still pass the URL as one argument', () => {
  for (const [platform, expected] of [['darwin', 'open'], ['linux', 'xdg-open']]) {
    const { command, args, options, unref } = capture(platform, loginURL);
    assert.equal(command, expected);
    assert.deepEqual(args, [loginURL]);
    assert.equal(options.env, undefined);
    assert.equal(unref, true);
  }
});

test('launcher failures leave manual URL login available', () => {
  for (const failure of ['throw', 'event']) {
    assert.doesNotThrow(() => capture('win32', loginURL, failure));
  }
});

test('Windows PowerShell passes all characters unchanged to Start-Process', { skip: process.platform !== 'win32' }, () => {
  for (const url of [loginURL, unusualURL]) {
    const { command, args, options } = capture('win32', url);
    // Replace only the final OS browser invocation, keeping the actual parser.
    const prefix = 'function Start-Process { param([string]$FilePath) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($FilePath)) }; ';
    const result = childProcess.spawnSync(command, [...args.slice(0, -1), prefix + args.at(-1)], {
      env: options.env, windowsHide: true, encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'), url);
  }
});


test('Codex summary item boundaries separate headings without changing answer or reasoning replay',async()=>{
 const {CodexStreamTranslator,toResponsesRequest}=await import(pathToFileURL(path.join(appRoot,'node_modules/agent-sh/dist/agent/extensions/codex-provider/translate.js')));
 const translator=new CodexStreamTranslator('fixture'),chunks=[];
 const push=e=>chunks.push(...translator.push(e));
 const part=(item,index)=>push({type:'response.reasoning_summary_part.added',item_id:item,summary_index:index});
 const delta=(item,text)=>push({type:'response.reasoning_summary_text.delta',item_id:item,delta:text});
 part('r1',0);delta('r1','**First');delta('r1',' summary**');
 push({type:'response.output_text.delta',delta:'**Complete'});
 part('r2',0);delta('r2','**Second summary**');
 part('r2',1);delta('r2','Additional context');
 push({type:'response.output_text.delta',delta:' answer**'});
 const item={type:'reasoning',id:'r2',summary:[{type:'summary_text',text:'**Second summary**'}],encrypted_content:'fixture-only'};
 push({type:'response.output_item.done',item,output_index:2});
 const deltas=chunks.flatMap(c=>c.choices.map(x=>x.delta));
 assert.equal(deltas.map(d=>d.reasoning??'').join(''),'**First summary**\n\n**Second summary**\n\nAdditional context');
 assert.equal(deltas.map(d=>d.content??'').join(''),'**Complete answer**');
 const details=deltas.flatMap(d=>d.reasoning_details??[]);
 assert.deepEqual(details.map(d=>d.item),[item]);
 const request=toResponsesRequest({model:'fixture',messages:[{role:'assistant',content:'**Complete answer**',reasoning_details:details}]});
 assert.deepEqual(request.input[0],item);
 const fresh=new CodexStreamTranslator('fixture');assert.deepEqual(fresh.push({type:'response.reasoning_summary_part.added',summary_index:0}),[]);
});

test('Codex summary patch applies cleanly to both kernel sources and is idempotent',async t=>{
 const fs=await import('node:fs'),os=await import('node:os');
 const {createRequire}=await import('node:module'),require=createRequire(import.meta.url);
 const {apply}=require('../scripts/patch-steering.cjs'),spec=require('../scripts/patches/codex-summary-boundaries.json');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ashub-codex-summary-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const expected=new Map();
 for(const entry of spec.files){
  const patched=fs.readFileSync(path.join(appRoot,'node_modules/agent-sh',entry.path),'utf8');expected.set(entry.path,patched);
  let original=patched;for(const hunk of [...entry.hunks].reverse()){assert.equal(original.split(hunk.after).length,2);original=original.replace(hunk.after,hunk.before);}
  const target=path.join(dir,entry.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,original);
 }
 assert.equal(apply(dir,spec,'summary boundaries'),2);assert.equal(apply(dir,spec,'summary boundaries'),0);
 for(const [file,source]of expected)assert.equal(fs.readFileSync(path.join(dir,file),'utf8'),source);
});
