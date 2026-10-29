const test = require('node:test');
const assert = require('node:assert/strict');
const { env, req, Res, fs, path } = require('./harness.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => typeof data === 'string' ? data : JSON.stringify(data) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const readBody = async input => { const chunks = []; for await (const chunk of input) chunks.push(chunk); return Buffer.concat(chunks).toString(); };
const skill = (dir, content = 'fixture') => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'SKILL.md'), content); };

function balance(e = env(), overrides = {}) {
  const { createProviderBalanceService } = e.load('src/services/provider-balance.ts');
  return createProviderBalanceService({ resolveApiKey: () => ({ key: 'test-key' }), resolveProvider: () => undefined, ...overrides });
}
function market(e = env(), overrides = {}) {
  const { createSkillsMarketplaceService } = e.load('src/services/skills-marketplace.ts');
  return createSkillsMarketplaceService({
    settingsPath: () => path.join(e.dir, 'settings.json'), getSettings: () => ({}), readBody,
    invalidateGlobalSkillsCache() {}, homedir: e.os.homedir,
    fetch: async () => { throw Error('offline fixture'); }, ...overrides,
  });
}
async function invoke(service, method, body = {}, url = '/') {
  const res = new Res(); await service[method](req(body, url), res); return res;
}

test('balance HTTP compatibility, provider endpoints and independent cache expiry', async () => {
  const e = env(), calls = []; let now = 1;
  const factory = amount => balance(e, {
    now: () => now,
    resolveProvider: provider => ({ baseURL: provider === 'deepseek' ? 'https://deepseek.invalid/custom/v1' : 'https://router.invalid/api/v1/' }),
    fetch: async (url, opts) => { calls.push({ url, opts }); return response(url.endsWith('/credits') ? { data: { total_credits: 20, total_usage: 3.125 } } : { is_available: true, amount }); },
  });
  const first = factory('one'), second = factory('two');
  assert.equal((await invoke(first, 'getBalance', {}, '/api/balance')).statusCode, 400);
  assert.equal((await first.query('deepseek')).amount, 'one');
  assert.equal((await second.query('deepseek')).amount, 'two');
  assert.equal(calls[0].url, 'https://deepseek.invalid/user/balance');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-key');
  now = 20_001; await first.query('deepseek'); now = 40_001; await first.query('deepseek');
  assert.equal(calls.length, 2, 'reads must not renew cache timestamps');
  now = 60_001; await first.query('deepseek'); assert.equal(calls.length, 3);
  assert.equal((await invoke(first, 'getBalance', {}, '/api/balance?provider=openrouter')).json().balance_infos[0].total_balance, '16.88');
  assert.equal(calls.at(-1).url, 'https://router.invalid/api/v1/credits');
  assert.deepEqual(plain(await first.query('other')), { is_available: false });
});

for (const failure of [false, true]) test(`balance invalidation rejects late old-account ${failure ? 'errors' : 'successes'}`, async () => {
  const e = env(), ready = deferred(), gate = deferred(); let account = 'old', calls = 0;
  const service = balance(e, {
    resolveApiKey: () => ({ key: account }),
    fetch: async (_, opts) => {
      calls++; const old = opts.headers.Authorization === 'Bearer old';
      if (old) { ready.resolve(); await gate.promise; if (failure) throw Error('old credentials rejected'); }
      return response({ is_available: true, account: old ? 'old' : 'new' });
    },
  });
  const old = service.query('deepseek'); await ready.promise;
  account = 'new'; service.invalidate(); assert.equal((await service.query('deepseek')).account, 'new');
  gate.resolve(); assert.equal((await old).account, 'new'); assert.equal((await service.query('deepseek')).account, 'new');
  assert.equal(calls, 2); assert.equal(service.pendingCount, 0);
});

test('balance failures retry and close cancels read-only queries while rejecting new requests', async () => {
  const e = env(); let calls = 0, credentials = 0;
  const service = balance(e, { resolveApiKey: () => { credentials++; return { key: credentials <= 2 ? '' : 'key' }; }, fetch: async () => { calls++; return response({}, 401); } });
  await service.query('deepseek'); await service.query('deepseek'); assert.equal(credentials, 2);
  await service.query('deepseek'); await service.query('deepseek'); assert.equal(calls, 2, 'HTTP failures must not be cached');
  const gate = deferred(), ready = deferred();
  const draining = balance(e, { fetch: async () => { ready.resolve(); await gate.promise; return response({ is_available: true }); } });
  const running = draining.query('deepseek'); await ready.promise;
  let closed = false; const closing = draining.close().then(() => { closed = true; });
  assert.equal(draining.pendingCount, 1); assert.equal(closed, false);
  assert.equal((await invoke(draining, 'getBalance', {}, '/api/balance?provider=deepseek')).statusCode, 503);
  await assert.rejects(draining.query('deepseek'), /closed/);
  await closing; assert.equal((await running).is_available, false); assert.equal(closed, true); assert.equal(draining.pendingCount, 0);
  gate.resolve();
});

test('skill catalogs isolate application snapshots, validate sources and cache empty successful results', async () => {
  const e = env(); let calls = 0, online = false;
  const first = market(e, { fetch: async () => { calls++; if (!online) throw Error('offline'); return response([]); } });
  assert.equal((await invoke(first, 'searchSkills', {}, '/api/skills?source=other')).statusCode, 400);
  assert.equal(calls, 0);
  assert.equal((await invoke(first, 'searchSkills', {}, '/api/skills?source=gitee')).statusCode, 502);
  online = true;
  assert.deepEqual((await invoke(first, 'searchSkills', {}, '/api/skills?source=gitee')).json(), { skills: [] });
  const successfulCalls = calls; await invoke(first, 'searchSkills', {}, '/api/skills?source=gitee'); assert.equal(calls, successfulCalls);
  const second = market(e, { fetch: async () => response([{ name: 'different', description: 'different application' }]) });
  assert.equal((await invoke(second, 'searchSkills', {}, '/api/skills?source=gitee')).json().skills[0].name, 'different');
  assert.equal((await invoke(first, 'searchSkills', {}, '/api/skills?source=gitee')).json().skills.length, 0);
});

test('skill catalog partial outages retain source snapshots, label stale data and retry', async () => {
  const e = env(); let now = 1, offline = false, calls = 0;
  const service = market(e, { now: () => now, fetch: async url => {
    calls++;
    if (offline && String(url).includes('/anthropics/')) throw Error('one repository unavailable');
    if (String(url).includes('api.github.com')) return response([{ name: 'demo', type: 'dir' }]);
    return response('---\nname: Demo\ndescription: searchable fixture\n---\nBody');
  } });
  const initial = await invoke(service, 'searchSkills', {}, '/api/skills?source=github'); assert.equal(initial.json().skills.length, 3);
  now = 3_600_002; offline = true;
  const stale = await invoke(service, 'searchSkills', {}, '/api/skills?source=github&q=searchable');
  assert.equal(stale.statusCode, 200); assert.equal(stale.json().cached, true); assert.equal(stale.json().skills.length, 3);
  offline = false; const before = calls;
  const recovered = await invoke(service, 'searchSkills', {}, '/api/skills?source=github');
  assert.equal(recovered.json().cached, undefined); assert(calls > before);
});

test('installed skills preserve precedence, standalone roots, source identity and instance boundaries', async () => {
  const e = env(), other = path.join(e.dir, 'other'), configured = path.join(e.dir, 'standalone'), cwd = path.join(e.os.homedir(), 'project');
  skill(path.join(e.dir, 'skills/demo')); skill(configured); skill(path.join(cwd, '.agents/skills/demo')); skill(path.join(cwd, '.agents/skills/local')); skill(path.join(other, 'skills/second'));
  fs.writeFileSync(path.join(configured, '.ashub-source.json'), JSON.stringify({ url: 'https://github.com/owner/standalone.git', subdir: '' }));
  const service = market(e, { getSettings: () => ({ skillPaths: [configured] }) });
  const list = (await invoke(service, 'listInstalledSkills', {}, '/api/skills/installed?cwd=' + encodeURIComponent(cwd))).json().installed;
  assert.equal(list.find(s => s.name === 'demo').path, path.join(e.dir, 'skills/demo'));
  assert.equal(list.find(s => s.name === 'standalone').sourceId, 'github:owner/standalone');
  assert(list.some(s => s.name === 'local'));
  const second = market(e, { settingsPath: () => path.join(other, 'settings.json') });
  const otherList = (await invoke(second, 'listInstalledSkills', {}, '/api/skills/installed?cwd=' + encodeURIComponent(cwd))).json().installed;
  assert(otherList.some(s => s.name === 'second')); assert(!otherList.some(s => s.name === 'standalone'));
  assert.equal((await invoke(service, 'uninstallSkill', { name: 'standalone', path: configured, sourceId: 'github:wrong/standalone' })).statusCode, 409);
  assert(fs.existsSync(configured));
  assert.equal((await invoke(service, 'uninstallSkill', { name: '..', path: e.dir })).statusCode, 400);
  assert.equal((await invoke(service, 'uninstallSkill', { name: path.basename(e.dir), path: e.dir })).statusCode, 403);
  assert.equal((await invoke(service, 'uninstallSkill', { name: 'standalone', path: configured, sourceId: 'github:owner/standalone' })).statusCode, 200);
  assert(!fs.existsSync(configured));
});

test('skill invalidation restarts an in-flight scan instead of restoring deleted entries', async () => {
  const gate = deferred(), ready = deferred(); let gatePath, hold = true;
  const e = env({ modules: { 'node:fs': { ...fs, promises: { ...fs.promises, readdir: async (dir, ...args) => {
    if (hold && dir === gatePath) { hold = false; ready.resolve(); await gate.promise; }
    return fs.promises.readdir(dir, ...args);
  } } } } });
  gatePath = path.join(e.os.homedir(), '.agents/skills'); const dest = path.join(e.dir, 'skills/demo'); skill(dest);
  let invalidations = 0, changes = 0;
  const service = market(e, { getSettings: () => ({ skillPaths: [gatePath] }), invalidateGlobalSkillsCache() { invalidations++; }, onChanged() { changes++; } });
  const loading = invoke(service, 'listInstalledSkills', {}, '/api/skills/installed'); await ready.promise;
  assert.equal((await invoke(service, 'uninstallSkill', { name: 'demo', path: dest })).statusCode, 200);
  gate.resolve(); assert.equal((await loading).json().installed.length, 0);
  assert.equal((await invoke(service, 'listInstalledSkills', {}, '/api/skills/installed')).json().installed.length, 0);
  assert.equal(invalidations, 1); assert.equal(changes, 1);
});

test('skill install serializes target mutations and shutdown drains accepted work', async () => {
  const e = env(), ready = deferred(); let releaseVersion;
  const service = market(e, { execFile: (command, args, options, done) => {
    if (args[0] === '--version') { releaseVersion = () => done(null, ''); ready.resolve(); return; }
    if (args[0] === 'clone') skill(args.at(-1), 'installed');
    done(null, '');
  } });
  const installing = invoke(service, 'installSkill', { id: 'github:owner/demo' }); await ready.promise;
  assert.equal((await invoke(service, 'installSkill', { id: 'github:owner/demo' })).statusCode, 409);
  assert.equal((await invoke(service, 'uninstallSkill', { name: 'demo' })).statusCode, 409);
  let finished = false; const closing = service.close().then(() => { finished = true; });
  assert.equal(service.pendingCount, 1); assert.equal(finished, false);
  assert.equal((await invoke(service, 'listInstalledSkills', {}, '/api/skills/installed')).statusCode, 503);
  releaseVersion(); const installed = await installing; await closing;
  assert.equal(installed.statusCode, 200); assert.equal(installed.json().sourceId, 'github:owner/demo');
  assert.equal(fs.readFileSync(path.join(installed.json().path, 'SKILL.md'), 'utf8'), 'installed');
  assert.equal(finished, true); assert.equal(service.pendingCount, 0);
});

test('sparse skill update rollback retains the old skill and releases the operation lock', async () => {
  let rejectRename = true;
  const e = env({ modules: { 'node:fs': { ...fs, promises: { ...fs.promises, rename: async (source, dest) => {
    if (rejectRename && path.basename(source) === 'skill') throw Error('fixture rename failure');
    return fs.promises.rename(source, dest);
  } } } } });
  const dest = path.join(e.dir, 'skills/demo'); skill(dest, 'old');
  fs.writeFileSync(path.join(dest, '.ashub-source.json'), JSON.stringify({ url: 'https://github.com/owner/repo.git', subdir: 'skills/demo' }));
  const service = market(e, { execFile: (command, args, options, done) => {
    if (args[0] === 'clone') skill(path.join(args.at(-1), 'skills/demo'), 'new');
    assert(!args.includes('pull'), 'sparse installs must stage a new checkout'); done(null, '');
  } });
  assert.equal((await invoke(service, 'installSkill', { id: 'github:owner/repo/demo' })).statusCode, 500);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), 'old');
  assert(!fs.readdirSync(path.dirname(dest)).some(name => name.startsWith('.tmp-')));
  rejectRename = false;
  assert.equal((await invoke(service, 'installSkill', { id: 'github:owner/repo/demo' })).statusCode, 200);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), 'new'); assert.equal(service.pendingCount, 0);
});

test('balance close stops invalidated old-account queries without another fetch', { timeout: 1000 }, async () => {
  const e = env(), ready = deferred(), gate = deferred(); let account = 'old', calls = 0;
  const service = balance(e, { resolveApiKey: () => ({ key: account }), fetch: async (_, opts) => {
    calls++; const old = opts.headers.Authorization === 'Bearer old';
    if (old) { ready.resolve(); await gate.promise; }
    return response({ is_available: true, account: old ? 'old' : 'new' });
  } });
  const reading = service.query('deepseek'); await ready.promise;
  const closing = service.close(); account = 'new'; service.invalidate();
  await closing;
  assert.deepEqual(plain(await reading), { is_available: false, error: 'Provider balance service is closed' });
  gate.resolve(); await new Promise(setImmediate);
  assert.equal(calls, 1); assert.equal(service.pendingCount, 0);
});

test('balance close cancels an uncooperative JSON body and cannot start late generation fetches', { timeout: 1000 }, async () => {
  const e = env(), ready = deferred(), body = deferred(); let calls = 0, reads = 0;
  const service = balance(e, { fetch: async () => {
    calls++;
    return { ok: true, json: async () => { reads++; ready.resolve(); return body.promise; } };
  } });
  const reading = service.query('openrouter'); await ready.promise;
  service.invalidate(); await service.close();
  assert.equal((await reading).is_available, false); assert.equal(service.pendingCount, 0);
  body.resolve({ data: { total_credits: 100, total_usage: 1 } }); await new Promise(setImmediate);
  assert.equal(calls, 1); assert.equal(reads, 1);
  await assert.rejects(service.query('openrouter'), /closed/);
});

test('skills close cancels a partial body before destroying it and ignores a late valid body', { timeout: 1000 }, async () => {
  const { PassThrough } = require('node:stream');
  const e = env(), ready = deferred(), body = deferred(); let commands = 0;
  const request = new PassThrough(); request.complete = false;
  const service = market(e, {
    readBody: () => { ready.resolve(); return body.promise; },
    execFile: () => { commands++; throw Error('late installation executed'); },
  });
  const res = new Res(), running = service.installSkill(request, res); await ready.promise;
  await service.close(); await running;
  assert.equal(request.destroyed, true); assert.equal(service.pendingCount, 0); assert.equal(res.statusCode, 503);
  body.resolve(JSON.stringify({ id: 'github:fixture/late-install' })); await new Promise(setImmediate);
  assert.equal(commands, 0); assert(!fs.existsSync(path.join(e.dir, 'skills')));
  assert.equal(request.listenerCount('aborted'), 0); assert.equal(request.listenerCount('close'), 0);
});

test('skills close cancels an unaccepted complete body without destroying its socket or deleting data', { timeout: 1000 }, async () => {
  const { PassThrough } = require('node:stream');
  const e = env(), ready = deferred(), body = deferred(), dest = path.join(e.dir, 'skills/demo'); skill(dest);
  const request = new PassThrough(); request.complete = true;
  const service = market(e, { readBody: () => { ready.resolve(); return body.promise; } });
  const res = new Res(), running = service.uninstallSkill(request, res); await ready.promise;
  await service.close(); await running;
  assert.equal(request.destroyed, false); assert.equal(res.statusCode, 503);
  body.resolve(JSON.stringify({ name: 'demo', path: dest })); await new Promise(setImmediate);
  assert(fs.existsSync(dest)); assert.equal(service.pendingCount, 0); request.destroy();
});

test('skills reject an already-aborted partial request without invoking the body reader', async () => {
  const { PassThrough } = require('node:stream');
  const e = env(), request = new PassThrough(); let reads = 0;
  request.destroy();
  const service = market(e, { readBody: async () => { reads++; return JSON.stringify({ id: 'github:fixture/late-install' }); } });
  const res = new Res(); await service.installSkill(request, res); await service.close();
  assert.equal(res.statusCode, 503); assert.equal(reads, 0); assert(!fs.existsSync(path.join(e.dir, 'skills')));
});


test('cached balance results recheck generation and shutdown before query and HTTP delivery', async () => {
  const e = env(); let account = 'old', calls = 0;
  const service = balance(e, { resolveApiKey: () => ({ key: account }), fetch: async (_, opts) => {
    calls++; return response({ is_available: true, account: opts.headers.Authorization.slice(7) });
  } });
  assert.equal((await service.query('deepseek')).account, 'old');
  const cachedQuery = service.query('deepseek'); account = 'new'; service.invalidate();
  assert.equal((await cachedQuery).account, 'new');
  const cachedHttp = invoke(service, 'getBalance', {}, '/api/balance?provider=deepseek'); account = 'third'; service.invalidate();
  assert.equal((await cachedHttp).json().account, 'third');
  const closingQuery = service.query('deepseek');
  const closingHttp = invoke(service, 'getBalance', {}, '/api/balance?provider=deepseek');
  await service.close();
  assert.equal((await closingQuery).is_available, false); assert.equal((await closingHttp).json().is_available, false);
  assert.equal(calls, 3); assert.equal(service.pendingCount, 0);
});
