import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('DeepSeek is usable before and after first-run credential setup', async t => {
  const root = process.env.ASHUB_TEST_ROOT ?? path.resolve(import.meta.dirname, '..');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ashub-provider-onboarding-'));
  process.env.AGENT_SH_HOME = home;
  for (const k of Object.keys(process.env)) if (/API_KEY|AUTH_TOKEN|ACCESS_TOKEN|^OPENAI_BASE_URL$/.test(k)) delete process.env[k];
  const settings = { defaultProvider: 'openai', disabledBuiltins: ['codex-provider'], providers: {} };
  const save = () => fs.writeFile(path.join(home,'settings.json'),JSON.stringify(settings));
  const originalFetch = globalThis.fetch;
  const requests = [];
  let completionAttempts = 0;
  globalThis.fetch = async (input, init) => {
    const req = new Request(input,init);
    if (new URL(req.url).pathname.endsWith('/chat/completions')) completionAttempts++;
    if (!['https://deepseek.invalid/v1/chat/completions','https://custom.invalid/v1/chat/completions','https://replacement.invalid/v1/chat/completions'].includes(req.url)) throw Error('External network disabled');
    requests.push({url:req.url,body:await req.json(),auth:req.headers.get('authorization')});
    return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'OK'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  const bridges=[];
  t.after(async()=>{for (const b of bridges) b.close(); globalThis.fetch=originalFetch; await fs.rm(home,{recursive:true,force:true});});
  await save();
  const {AshBridge}=await import(pathToFileURL(path.join(root,'dist/bridges/ash.js')));
  const {reloadSettings}=await import(pathToFileURL(createRequire(path.join(root,'package.json')).resolve('agent-sh/settings')));
  async function open(options={}) {
    const b=new AshBridge({cwd:home, ...options}); bridges.push(b); await b.ready(); return b;
  }
  const early=await open();
  assert.equal(early.backendRegistered,false);
  settings.providers.deepseek={apiKey:'fixture-key',baseURL:'https://deepseek.invalid/v1'};
  await save(); await reloadSettings(); early.reloadProviders();
  await t.test('existing conversation recovers on first request',async()=>{
    await early.submit('hi');
    assert.equal(requests.at(-1)?.auth,'Bearer fixture-key');
    assert.equal(requests.at(-1)?.body.model,'deepseek-flash');
  });
  await t.test('new conversation skips empty Ollama when saved default has no key',async()=>{
    const cold=await open();
    assert.equal(cold.core.handlers.call('agent:get-model')?.provider,'deepseek');
    await cold.submit('hi');
    assert.equal(requests.at(-1)?.body.model,'deepseek-flash');
  });
  await t.test('restored model from an unavailable provider is not sent to its fallback',async()=>{
    const restored=await open({provider:'openai',model:'model-from-old-provider'});
    assert.equal(restored.core.handlers.call('agent:get-model')?.model,'deepseek-flash');
  });
  await t.test('restoring a model without provider metadata selects a provider offering that model', async () => {
    delete settings.defaultProvider;
    await save(); await reloadSettings();
    const bridge = await open({model:'deepseek-v4-pro'});
    const active = bridge.core.handlers.call('agent:get-model');
    assert.equal(active?.provider,'deepseek');
    assert.equal(active?.model,'deepseek-v4-pro');
    await bridge.submit('hi');
    assert.equal(requests.at(-1)?.body.model,'deepseek-v4-pro');
  });
  await t.test('model-only restore keeps its model even when the global default is another service', async () => {
    settings.defaultProvider = 'other';
    settings.providers.other = {apiKey:'other-fixture', baseURL:'https://other.invalid/v1', models:['other-model'], defaultModel:'other-model'};
    await save(); await reloadSettings();
    const bridge = await open({isRestored:true, model:'deepseek-v4-pro'});
    assert.equal(bridge.core.handlers.call('agent:get-model')?.provider,'deepseek');
    await bridge.submit('hi');
    assert.equal(requests.at(-1)?.auth,'Bearer fixture-key');
    assert.equal(requests.at(-1)?.body.model,'deepseek-v4-pro');

    settings.providers.other.models.push('deepseek-v4-pro');
    await save(); await reloadSettings();
    const ambiguous = await open({isRestored:true, model:'deepseek-v4-pro'});
    assert.equal(ambiguous.core.handlers.call('agent:get-model')?.provider,'other');
  });
  await t.test('live settings save preserves the new default and refreshes the active API client', async liveTest => {
    const {startHub} = await import(pathToFileURL(path.join(root,'dist/hub.js')));
    const {once} = await import('node:events');
    process.env.ASHUB_TOKEN = 'local-config-fixture';
    settings.defaultProvider = 'deepseek';
    settings.providers = {};
    await save(); await reloadSettings();
    let active;
    const hub = startHub({host:'127.0.0.1',port:0,webRoot:path.join(root,'web'),makeBridge:opts=>(active=new AshBridge(opts))});
    try {
      await once(hub.server,'listening');
      const base = 'http://127.0.0.1:' + hub.server.address().port;
      const headers = {Authorization:'Bearer local-config-fixture','Content-Type':'application/json'};
      const call = (url,method,body) => originalFetch(base+url,{method,headers,body:JSON.stringify(body)});
      const created = await call('/sessions','POST',{cwd:home}); assert.equal(created.status,200);
      const {instanceId} = await created.json();
      const existing = active;
      assert.equal(existing.backendRegistered,false);
      const activate = existing.core.activateBackend.bind(existing.core);
      existing.core.activateBackend = async () => {
        await new Promise(resolve => setImmediate(resolve));
        throw Error('fixture activation failure');
      };
      settings.providers.deepseek = {apiKey:'fixture-first',baseURL:'https://deepseek.invalid/v1'};
      const failed = await call('/api/config','PUT',settings);
      assert.equal(failed.status,500,'saving must report a rejected first activation');
      assert.equal((await failed.json()).ok,false);
      existing.core.activateBackend = activate;
      assert.equal((await call('/api/config/reload','POST',{})).status,200);
      await existing.submit('retry initial activation after save');
      assert.equal(requests.at(-1).auth,'Bearer fixture-first');
      const updated = {...settings,defaultProvider:'custom',providers:{
        deepseek:{apiKey:'fixture-rotated',baseURL:'https://deepseek.invalid/v1'},
        custom:{apiKey:'fixture-custom',baseURL:'https://custom.invalid/v1',defaultModel:'fixture-new',models:['fixture-new']},
      }};
      assert.equal((await call('/api/config','PUT',updated)).status,200);
      await liveTest.test('stale settings cannot pair a rotated key with its previous service URL', async () => {
        const view = await call('/api/config','GET');
        const revision = view.headers.get('x-ashub-provider-revision'), draft = await view.json();
        assert.match(revision,/^[a-f0-9]{64}$/);
        const changed = structuredClone(updated);
        changed.providers.custom.baseURL = 'https://replacement.invalid/v1';
        changed.providers.custom.apiKey = 'fixture-new-origin';
        try {
          assert.equal((await call('/api/config','PUT',changed)).status,200);
          draft.providers.deepseek.apiKey = 'fixture-unrelated-edit';
          const rejected = await originalFetch(base+'/api/config',{method:'PUT',body:JSON.stringify(draft),
            headers:{...headers,...(revision ? {'x-ashub-provider-revision':revision} : {})}});
          const onDisk = JSON.parse(await fs.readFile(path.join(home,'settings.json'),'utf8'));
          assert.equal(onDisk.providers.custom.baseURL,changed.providers.custom.baseURL,'stale draft restored obsolete endpoint');
          assert.equal(onDisk.providers.custom.apiKey,'fixture-new-origin');
          const custom = await open({provider:'custom',model:'fixture-new'});
          await custom.submit('verify the next request after a stale save');
          assert.equal(requests.at(-1).url,'https://replacement.invalid/v1/chat/completions');
          assert.equal(requests.at(-1).auth,'Bearer fixture-new-origin');
          assert.equal(rejected.status,409);
          assert.equal((await call('/api/config','PUT',draft)).status,409,'older clients must not restore a masked key to a different endpoint');
          const fresh = await call('/api/config','GET');
          const retry = await fresh.json();
          retry.providers.deepseek.apiKey = 'fixture-unrelated-edit';
          const freshHeaders = {...headers,'x-ashub-provider-revision':fresh.headers.get('x-ashub-provider-revision')};
          assert.equal((await originalFetch(base+'/api/config',{method:'PUT',headers:freshHeaders,body:JSON.stringify(retry)})).status,200);
          changed.providers.custom.apiKey = 'fixture-key-only-rotation';
          assert.equal((await call('/api/config','PUT',changed)).status,200);
          assert.equal((await originalFetch(base+'/api/config',{method:'PUT',headers:freshHeaders,body:JSON.stringify(retry)})).status,200);
          assert.equal(JSON.parse(await fs.readFile(path.join(home,'settings.json'),'utf8')).providers.custom.apiKey,'fixture-key-only-rotation');
        } finally { await call('/api/config','PUT',updated); }
      });
      await liveTest.test('a key save from a stale editor cannot undo a Codex plugin endpoint change', async () => {
        const original = {...updated,'codex-provider':{upstreamURL:'https://old-codex.invalid/responses'}};
        const changed = {...original,'codex-provider':{upstreamURL:'https://new-codex.invalid/responses'}};
        try {
          assert.equal((await call('/api/config','PUT',original)).status,200);
          const read = await call('/api/config','GET');
          const draft = await read.json();
          const revision = read.headers.get('x-ashub-provider-revision');
          assert(revision);
          const plugin = await (await call('/api/plugins/config?id=builtin:codex-provider&namespace=codex-provider','GET')).json();
          assert.equal((await call('/api/plugins/config','PUT',{
            id:'builtin:codex-provider', namespace:'codex-provider', config:changed['codex-provider'], revision:plugin.revision
          })).status,200);
          draft.providers.deepseek.apiKey = 'fixture-wanted-edit';
          const file = path.join(home,'settings.json');
          const before = await fs.readFile(file,'utf8');
          const result = await originalFetch(base+'/api/config',{method:'PUT',body:JSON.stringify(draft),
            headers:{...headers,'x-ashub-provider-revision':revision}});
          assert.equal(result.status,409,'a stale save was allowed to restore the previous Codex endpoint');
          assert.equal(await fs.readFile(file,'utf8'),before);
          const fresh = await call('/api/config','GET');
          const retry = await fresh.json();
          retry.providers.deepseek.apiKey = draft.providers.deepseek.apiKey;
          assert.equal((await originalFetch(base+'/api/config',{method:'PUT',body:JSON.stringify(retry),
            headers:{...headers,'x-ashub-provider-revision':fresh.headers.get('x-ashub-provider-revision')}})).status,200);
          const saved = JSON.parse(await fs.readFile(file,'utf8'));
          assert.equal(saved.providers.deepseek.apiKey,draft.providers.deepseek.apiKey);
          assert.deepEqual(saved['codex-provider'],changed['codex-provider']);
        } finally { await call('/api/config','PUT',updated); }
      });
      await liveTest.test('retrying a stale new-provider save cannot roll back a later key rotation', async () => {
        const file = path.join(home,'settings.json');
        const view = await call('/api/config','GET');
        const draft = await view.json();
        const oldHeaders = {...headers,'x-ashub-provider-revision':view.headers.get('x-ashub-provider-revision')};
        draft.providers.team = {baseURL:'https://custom.invalid/v1',apiKey:'fixture-first',models:['fixture-model']};
        const saveDraft = () => originalFetch(base+'/api/config',{method:'PUT',headers:oldHeaders,body:JSON.stringify(draft)});
        try {
          const refresh = existing.reloadProviders;
          try {
            existing.reloadProviders = () => { throw Error('fixture refresh failure'); };
            const partial = await saveDraft();
            assert.equal(partial.status,500);
            assert.match((await partial.json()).error,/Settings saved/);
          } finally { existing.reloadProviders = refresh; }
          assert.equal((await call('/api/settings/network','PUT',{session:instanceId,enabled:false})).status,200);
          assert.equal((await saveDraft()).status,200,'a retry after live refresh failed must remain possible');
          assert.equal((await (await call('/api/settings/network','GET')).json()).sessions[instanceId],false);
          const nextView = await call('/api/config','GET');
          const next = await nextView.json();
          next.providers.team.apiKey = 'fixture-rotated';
          assert.equal((await originalFetch(base+'/api/config',{method:'PUT',body:JSON.stringify(next),
            headers:{...headers,'x-ashub-provider-revision':nextView.headers.get('x-ashub-provider-revision')}})).status,200);
          const before = await fs.readFile(file,'utf8');
          assert.equal((await saveDraft()).status,409,'a stale retry replaced the rotated key');
          assert.equal(await fs.readFile(file,'utf8'),before);
        } finally {
          await call('/api/settings/network','PUT',{session:instanceId,enabled:null});
          await call('/api/config','PUT',updated);
        }
      });
      await liveTest.test('stale explicit edits to an existing key cannot overwrite a newer key-only save', async () => {
        const file = path.join(home,'settings.json');
        const read = await call('/api/config','GET');
        const draft = await read.json();
        const revision = read.headers.get('x-ashub-provider-revision');
        const saveWith = (data, rev) => originalFetch(base+'/api/config',{method:'PUT',body:JSON.stringify(data),
          headers:{...headers,'x-ashub-provider-revision':rev}});
        try {
          const rotated = structuredClone(draft);
          rotated.providers.custom.apiKey = 'fixture-winning-key';
          assert.equal((await saveWith(rotated,revision)).status,200);
          const unchanged = await fs.readFile(file,'utf8');
          for (const operation of ['replace','clear','remove','reroute']) {
            const stale = structuredClone(draft);
            if (operation === 'replace') stale.providers.custom.apiKey = 'fixture-losing-key';
            if (operation === 'clear') delete stale.providers.custom.apiKey;
            if (operation === 'remove') delete stale.providers.custom;
            if (operation === 'reroute') stale.providers.custom.baseURL = 'https://old-draft.invalid/v1';
            assert.equal((await saveWith(stale,revision)).status,409,operation + ' lost the concurrent key rotation');
            assert.equal(await fs.readFile(file,'utf8'),unchanged);
          }
          assert.equal((await saveWith(rotated,revision)).status,200,'identical retry');
          draft.providers.deepseek.apiKey = 'fixture-independent-key';
          assert.equal((await saveWith(draft,revision)).status,200,'editing an independent key is safe');
          const persisted=JSON.parse(await fs.readFile(file,'utf8'));
          assert.equal(persisted.providers.deepseek.apiKey,'fixture-independent-key');
          assert.equal(persisted.providers.custom.apiKey,'fixture-winning-key');
        } finally { await call('/api/config','PUT',updated); }
      });
      await liveTest.test('masked keys can only be reused for their existing provider', async () => {
        const draft = await (await call('/api/config','GET')).json();
        assert.equal(draft.providers.custom.apiKey, '••••••••');
        assert.equal((await call('/api/config','PUT',draft)).status,200);
        const file = path.join(home,'settings.json');
        const original = await fs.readFile(file,'utf8');
        assert.equal(JSON.parse(original).providers.custom.apiKey,'fixture-custom');
        draft.providers.renamed = draft.providers.custom;
        delete draft.providers.custom;
        draft.defaultProvider = 'renamed';
        const conflict = await call('/api/config','PUT',draft);
        assert.equal(conflict.status,409,'renaming a masked provider must not persist the display placeholder');
        assert.equal(await fs.readFile(file,'utf8'),original);
        assert.match(await conflict.text(),/Re-enter the key/);
        draft.providers.renamed.apiKey = 'fixture-reentered';
        assert.equal((await call('/api/config','PUT',draft)).status,200);
        assert.equal(JSON.parse(await fs.readFile(file,'utf8')).providers.renamed.apiKey,'fixture-reentered');
        assert.equal((await call('/api/config','PUT',updated)).status,200);
      });
      assert.equal(JSON.parse(await fs.readFile(path.join(home,'settings.json'),'utf8')).defaultProvider,'custom');
      await existing.submit('continue with the original model');
      assert.equal(requests.at(-1).auth,'Bearer fixture-rotated');
      const catalog = await (await call('/api/models','GET')).json();
      assert(catalog.providers.find(p=>p.name==='custom')?.models.some(m=>m.id==='fixture-new'));
      assert.equal((await call('/sessions','POST',{cwd:home})).status,200);
      assert.equal(active.core.handlers.call('agent:get-model')?.model,'fixture-new');
      await liveTest.test('a failed settings save never returns credential text from malformed disk JSON', async () => {
        const file = path.join(home,'settings.json');
        const previous = await fs.readFile(file,'utf8');
        const malformed = '{"providers":{"custom":{"apiKey":TOPSECRET}}}';
        await fs.writeFile(file,malformed);
        const failed = await call('/api/config','PUT',updated);
        assert.equal(failed.status,500);
        const detail = await failed.text();
        assert(!detail.includes('TOPSECRET'), 'settings save returned part of the credential');
        assert.match(detail,/Invalid JSON in settings\.json/);
        assert.equal(await fs.readFile(file,'utf8'),malformed);
        const count = completionAttempts;
        await existing.submit('continue after a rejected save');
        assert.equal(completionAttempts,count + 1);
        assert.equal(requests.at(-1).auth,'Bearer fixture-rotated');
        await fs.writeFile(file,previous);
        assert.equal((await call('/api/config','PUT',updated)).status,200);
      });
      await liveTest.test('switching the session model preserves a damaged settings document', async () => {
        const file = path.join(home,'settings.json');
        const saved = await fs.readFile(file,'utf8');
        const damaged = '{"providers":{"custom":{"apiKey":TOPSECRET}}}';
        try {
          await fs.writeFile(file,damaged);
          const messages = [];
          existing.onEvent(event => { if (event.name === 'ui:info') messages.push(event.payload.message); });
          const selected = await call('/'+instanceId+'/model','PUT',{model:'fixture-new',provider:'custom'});
          assert.equal(selected.status,200);
          assert(messages.some(message => message.includes('session only')));
          assert.equal(await fs.readFile(file,'utf8'),damaged,'model switch overwrote damaged settings');
          assert.equal(existing.core.handlers.call('agent:get-model').provider,'custom');
        } finally {
          await fs.writeFile(file,saved);
          await existing.execCommand('/model','deepseek-flash@deepseek');
          await fs.writeFile(file,saved);
          await call('/api/config/reload','POST',{});
        }
      });
      // Reject partial external edits before invalidating the working runtime.
      for (const invalid of ['{"providers":{"test":"fixture-secret"', '[]', '{"providers":[]}']) {
        await fs.writeFile(path.join(home,'settings.json'),invalid);
        const rejected = await call('/api/config/reload','POST',{});
        assert.equal(rejected.status,400,'invalid settings must not be acknowledged');
        const result = await rejected.json();
        assert.equal(result.ok,false);
        assert(!JSON.stringify(result).includes('fixture-secret'));
        assert.equal(await fs.readFile(path.join(home,'settings.json'),'utf8'),invalid);
      }
      await existing.submit('continue using the last valid settings');
      assert.equal(requests.at(-1).auth,'Bearer fixture-rotated');
      // External edits use the explicit reload route. Both open sessions must
      // send their very next requests with the newly loaded credentials.
      updated.providers.deepseek.apiKey = 'fixture-reloaded-deepseek';
      updated.providers.custom.apiKey = 'fixture-reloaded-custom';
      await fs.writeFile(path.join(home,'settings.json'),JSON.stringify(updated));
      assert.equal((await call('/api/config/reload','POST',{})).status,200);
      await existing.submit('continue after external edit');
      assert.equal(requests.at(-1).auth,'Bearer fixture-reloaded-deepseek');
      await active.submit('other open session after reload');
      assert.equal(requests.at(-1).auth,'Bearer fixture-reloaded-custom');
      assert.equal((await call('/'+instanceId+'/model','PUT',{model:'fixture-new',provider:'custom'})).status,200);
      await existing.submit('use the added model');
      assert.equal(requests.at(-1).body.model,'fixture-new');
      assert.equal(requests.at(-1).auth,'Bearer fixture-reloaded-custom');
      for (const change of ['clear key', 'remove provider']) {
        if (change === 'clear key') updated.providers.custom.apiKey = '';
        else delete updated.providers.custom;
        assert.equal((await call('/api/config','PUT',updated)).status,200);
        const count = completionAttempts;
        await assert.rejects(existing.submit('after credential removal'), /Authentication failed|Provider unavailable/);
        const client = existing.core.handlers.call('llm:get-client');
        await assert.rejects(client.complete({messages:[]}), /Provider unavailable/);
        assert.equal(completionAttempts,count,'must not send a request with a removed key');
        updated.providers.custom = {apiKey:'fixture-restored',baseURL:'https://custom.invalid/v1',defaultModel:'fixture-new',models:['fixture-new']};
        assert.equal((await call('/api/config','PUT',updated)).status,200);
        await existing.submit('after credential restoration');
        assert.equal(requests.at(-1).auth,'Bearer fixture-restored');
      }
      await liveTest.test('key-file providers follow endpoint removal, restoration and external key rotation', async () => {
        const auth = await import(pathToFileURL(createRequire(path.join(root,'package.json')).resolve('agent-sh/auth')));
        auth.saveKeysFile({vault:'fixture-vault-first'});
        const provider = {baseURL:'https://custom.invalid/v1',defaultModel:'vault-model',models:['vault-model']};
        const config = {...updated,defaultProvider:'vault',providers:{vault:provider}};
        assert.equal((await call('/api/config','PUT',config)).status,200);
        assert.equal((await call('/sessions','POST',{cwd:home})).status,200);
        const vaultSession = active;
        await vaultSession.submit('use the key file');
        assert.equal(requests.at(-1).auth,'Bearer fixture-vault-first');
        delete config.providers.vault;
        assert.equal((await call('/api/config','PUT',config)).status,200);
        const count = completionAttempts;
        await assert.rejects(vaultSession.submit('provider removed'), /Authentication failed|Provider unavailable/);
        assert.equal(completionAttempts,count);
        assert(!vaultSession.core.handlers.call('agent:get-models').some(m=>m.provider==='vault'));
        config.providers.vault = provider;
        assert.equal((await call('/api/config','PUT',config)).status,200);
        await vaultSession.submit('provider restored');
        assert.equal(requests.at(-1).auth,'Bearer fixture-vault-first');
        const keyfile = path.join(home,'keys.json');
        await fs.writeFile(keyfile,JSON.stringify({vault:'fixture-vault-rotated'}));
        assert.equal((await call('/api/config/reload','POST',{})).status,200);
        await vaultSession.submit('use rotated key');
        assert.equal(requests.at(-1).auth,'Bearer fixture-vault-rotated');
        for (const invalid of ['{"vault":"fixture-secret"', '[]', '{"vault":123}']) {
          await fs.writeFile(keyfile,invalid);
          const rejected = await call('/api/config/reload','POST',{});
          assert.equal(rejected.status,400,'invalid key files must not be accepted');
          const error = await rejected.json();
          assert.equal(error.ok,false);
          assert(!JSON.stringify(error).includes('fixture-secret'));
          await vaultSession.submit('keep the last valid key');
          assert.equal(requests.at(-1).auth,'Bearer fixture-vault-rotated');
        }
        await fs.unlink(keyfile);
        await fs.mkdir(keyfile);
        const unreadable = await call('/api/config/reload','POST',{});
        assert.equal(unreadable.status,500);
        await vaultSession.submit('read failure preserves valid credentials');
        assert.equal(requests.at(-1).auth,'Bearer fixture-vault-rotated');
        await fs.rmdir(keyfile);
        await fs.writeFile(keyfile,'{}');
        assert.equal((await call('/api/config/reload','POST',{})).status,200);
        const beforeRevokedRequest = completionAttempts;
        await assert.rejects(vaultSession.submit('revoked key-file credential'), /Authentication failed|Provider unavailable/);
        assert.equal(completionAttempts,beforeRevokedRequest);
      });
    } finally {
      await hub.shutdown();
    }
  });
  await t.test('an open DeepSeek session releases its startup key and accepts a valid fallback', async () => {
    settings.defaultProvider = 'deepseek';
    settings.providers = {deepseek:{apiKey:'fixture-startup-key',baseURL:'https://deepseek.invalid/v1'}};
    await save(); await reloadSettings();
    const bridge = await open();
    await bridge.submit('before clearing the startup key');
    assert.equal(requests.at(-1).auth,'Bearer fixture-startup-key');
    delete settings.providers.deepseek.apiKey;
    await save(); await reloadSettings(); await bridge.reloadProviders();
    assert(!bridge.core.handlers.call('agent:get-models').some(m => m.provider === 'deepseek'));
    const count = completionAttempts;
    await assert.rejects(bridge.submit('after clearing the startup key'), /Authentication failed|Provider unavailable/);
    assert.equal(completionAttempts,count);
    process.env.DEEPSEEK_API_KEY = 'fixture-env-fallback';
    try {
      await bridge.reloadProviders();
      await bridge.submit('use the independently configured environment key');
      assert.equal(requests.at(-1).auth,'Bearer fixture-env-fallback');
    } finally { delete process.env.DEEPSEEK_API_KEY; }
  });
  await t.test('an optional Codex configuration error does not prevent late DeepSeek activation', async () => {
    settings.disabledBuiltins = [];
    settings.providers = {};
    settings['codex-provider'] = {upstreamURL: 'invalid-url'};
    await save(); await reloadSettings();
    const bridge = await open();
    assert.equal(bridge.backendRegistered, false);
    assert.match(bridge.codexFailure, /Codex provider/);

    settings.providers.deepseek = {apiKey:'fixture-key', baseURL:'https://deepseek.invalid/v1'};
    await save(); await reloadSettings();
    const count = requests.length;
    bridge.reloadProviders();
    await bridge.submit('hi after saving DeepSeek');
    assert.equal(requests.length, count + 1);
    assert.equal(requests.at(-1).auth, 'Bearer fixture-key');
    assert.equal(requests.at(-1).body.model, 'deepseek-flash');
  });
  await t.test('custom provider IDs cannot inherit missing key-file credentials', async () => {
    const auth = await import(pathToFileURL(createRequire(path.join(root,'package.json')).resolve('agent-sh/auth')));
    const ids = ['constructor', '__proto__', 'toString'];
    const provider = {baseURL:'https://custom.invalid/v1', defaultModel:'fixture-model', models:['fixture-model']};
    settings.disabledBuiltins = [];
    settings['codex-provider'] = {upstreamURL:'invalid-url'};
    settings.defaultProvider = 'constructor';
    settings.providers = Object.fromEntries(ids.map(id => [id,provider]));
    await save(); await reloadSettings();
    auth.saveKeysFile(Object.fromEntries(ids.map(id => [id,'fixture-' + id])));
    const bridge = await open();
    for (const id of ids) assert.equal(auth.resolveApiKey(id).key,'fixture-' + id);
    await bridge.submit('before removing credentials');
    assert.equal(requests.at(-1).auth,'Bearer fixture-constructor');
    auth.saveKeysFile({});
    await bridge.reloadProviders();
    for (const id of ids) assert.deepEqual(auth.resolveApiKey(id),{key:null, source:'none'});
    assert.equal(auth.anyProviderConfigured(),false);
    const count = completionAttempts;
    await assert.rejects(bridge.submit('after removing credentials'), /Authentication failed|Provider unavailable/);
    assert.equal(completionAttempts,count);
  });
});

test('cold kernel settings and key-file diagnostics identify the file without its contents', async t => {
  const root = process.env.ASHUB_TEST_ROOT ?? path.resolve(import.meta.dirname, '..');
  const home = await fs.mkdtemp(path.join(os.tmpdir(),'ashub-config-diagnostics-'));
  t.after(() => fs.rm(home,{recursive:true,force:true}));
  for (const file of ['settings.json','keys.json']) {
    await fs.writeFile(path.join(home,file),'{"key":TOPSECRET}');
  }
  const child = spawnSync(process.execPath, ['--input-type=module','-e', `
    import { getSettings } from 'agent-sh/settings';
    import { loadKeysFile } from 'agent-sh/auth';
    getSettings();
    loadKeysFile();
  `], {cwd:root, env:{...process.env,AGENT_SH_HOME:home}, encoding:'utf8'});
  assert.equal(child.status,0);
  assert.match(child.stderr,/invalid JSON in .*settings\.json/);
  assert.match(child.stderr,/invalid JSON in .*keys\.json/);
  assert(!child.stderr.includes('TOPSECRET'));
});
