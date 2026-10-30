const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.ASHUB_TEST_ROOT || path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
// The separately maintained remote site is absent from a core-only checkout.
// An existing but incomplete remote directory must still fail its checks.
const remoteOptions = { skip: fs.existsSync(path.join(root, 'remote/public')) ? false : 'remote/public is not included in this core-only checkout' };
const clientOptions = client => client === 'remote' ? remoteOptions : {};

function between(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Missing source boundary: ${start}`);
  return source.slice(first, last);
}
function rules(file = 'web/js/conversation-presentation.js', globals = {}) {
  const context = vm.createContext(globals);
  vm.runInContext(read(file), context, { filename: file });
  return context;
}
function renderer(client) {
  if (client === 'desktop') {
    const source = read('web/js/stream/renderers.js');
    const element = { innerHTML: '', classList: { toggle() {} } };
    const context = rules(undefined, { t: key => key, fmtNum: value => String(value) });
    vm.runInContext(between(source, 'const { usageMetrics }', 'export const renderTurnSep')
      .replace(/^export /gm, '') + '\nglobalThis.renderUsageForTest = renderUsage;', context);
    return {
      element,
      render(payload, contextWindow) { context.renderUsageForTest({ state: { lastUsage: payload, contextWindow }, usageEl: element }); },
      total() { return /class="usage-chip usage-total"[^>]*>([^<]+)/.exec(element.innerHTML)?.[1]; },
    };
  }
  const source = read('remote/public/app.js'), element = { textContent: '' };
  const context = rules('remote/public/conversation-presentation.js', { modelInfo: {}, usage: null, $: () => element });
  // Evaluate the actual binding and render function without booting account/session effects.
  vm.runInContext(source.match(/^const \{ toolActivityKey, usageMetrics \}[^\n]+/m)[0] + '\n'
    + between(source, 'function renderUsage(p)', 'async function renderImage'), context);
  return {
    element,
    render(payload, contextWindow) { context.modelInfo.contextWindow = contextWindow; context.renderUsage(payload); },
  };
}

test('desktop uses frozen presentation rules and imports them before its actual consumers', () => {
  assert(Object.isFrozen(rules().AsHubConversationPresentation));
  for (const file of ['web/js/stream/activity.js', 'web/js/stream/renderers.js']) {
    assert.match(read(file), /import ["']\.\.\/conversation-presentation\.js["'];/);
  }
});

test('remote shares the desktop rules and loads them before its actual consumer', remoteOptions, () => {
  assert.equal(read('web/js/conversation-presentation.js'), read('remote/public/conversation-presentation.js'));
  const html = read('remote/public/index.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)><\/script>/g)].map(match => match[1]);
  const shared = scripts.findIndex(attrs => attrs.includes('src="./conversation-presentation.js"'));
  const app = scripts.findIndex(attrs => attrs.includes('src="./app.js"'));
  assert(shared >= 0 && shared < app, 'remote helper must precede its app consumer');
  assert.match(scripts[shared], /\bdefer\b/); assert.match(scripts[app], /\bdefer\b/);
  new vm.Script(read('remote/public/app.js'));
});

for (const client of ['desktop', 'remote']) {
  test(`${client} actual activity call sites retain exact tool labels and unknown-tool fallback`, clientOptions(client), () => {
    let labelFor;
    if (client === 'desktop') {
      const source = read('web/js/stream/activity.js');
      const context = rules(undefined, { document: { addEventListener() {} } });
      vm.runInContext(source.slice(source.indexOf('const { toolActivityKey,')).replace(/^export /gm, '')
        + '\nglobalThis.toolLabelForTest = toolLabel;', context);
      labelFor = tool => context.toolLabelForTest({ dataset: tool });
    } else {
      const source = read('remote/public/app.js'), context = rules('remote/public/conversation-presentation.js');
      vm.runInContext(source.match(/^const \{ toolActivityKey, usageMetrics \}[^\n]+/m)[0] + '\n'
        + between(source, 'function toolProgress(tool)', 'function refreshProgress'), context);
      labelFor = tool => context.toolProgress(tool);
    }
    const groups = [
      [['read', 'read_file', 'ls', 'list_files'], 'activity.reading', '正在查阅资料'],
      [['grep', 'glob', 'search', 'web_search', 'web_fetch'], 'activity.searching', '正在查找资料'],
      [['write', 'edit', 'write_file', 'edit_file', 'apply_patch'], 'activity.writing', '正在更新文件'],
      [['bash', 'read_and_delete', '<script>', ''], 'activity.working', '正在处理任务'],
    ];
    for (const [names, key, label] of groups) for (const name of names) {
      assert.equal(labelFor({ toolName: name }), client === 'desktop' ? key : label);
    }
    for (const [kind, key, label] of [['read', 'activity.reading', '正在查阅资料'],
      ['search', 'activity.searching', '正在查找资料'], ['edit', 'activity.writing', '正在更新文件'],
      ['write', 'activity.writing', '正在更新文件']]) {
      assert.equal(labelFor(client === 'desktop' ? { kind, toolName: 'custom' } : { kind, name: 'custom' }), client === 'desktop' ? key : label);
    }
  });

  test(`${client} actual usage renderer honors provider totals, explicit zero and missing-total fallback`, clientOptions(client), () => {
    const f = renderer(client);
    for (const [total, expected, mobile] of [[3000, '3000', '3.0k'], [0, '0', '0.0k'], [undefined, '1500', '1.5k']]) {
      f.render({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: total }, 10000);
      if (client === 'desktop') {
        assert.equal(f.total(), expected); assert.match(f.element.innerHTML, /width:10%/);
      } else {
        assert.match(f.element.textContent, new RegExp('^' + mobile.replace('.', '\\.') + ' tokens'));
        assert.match(f.element.textContent, /上下文 10%/);
      }
    }
  });

  test(`${client} distinguishes unreported cache, measured zero hits and absent counters`, clientOptions(client), () => {
    const f = renderer(client);
    f.render({ prompt_tokens: 100, cache_reported: false }, 1000);
    if (client === 'desktop') assert.match(f.element.innerHTML, /usage\.cache\.unknown/);
    else assert.match(f.element.textContent, /缓存未提供/);
    f.render({ prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 }, 0);
    if (client === 'desktop') assert.match(f.element.innerHTML, /cache-pct low">0\.0%/);
    else assert.match(f.element.textContent, /缓存 0%/);
    f.render({}, 0);
    if (client === 'desktop') assert.doesNotMatch(f.element.innerHTML, /class="usage-chip usage-cache"/);
    else assert.doesNotMatch(f.element.textContent, /缓存/);
  });

  test(`${client} cache near misses never display a perfect hit rate on its actual renderer`, clientOptions(client), () => {
    const f = renderer(client);
    f.render({ prompt_cache_hit_tokens: 9985, prompt_cache_miss_tokens: 15 }, 0);
    if (client === 'desktop') {
      assert.match(f.element.innerHTML, /99\.8%/); assert.doesNotMatch(f.element.innerHTML, /100\.0%/);
    } else assert.match(f.element.textContent, /缓存 99\.8%/);
  });

  test(`${client} rejects invalid counters rather than producing NaN, Infinity, negative or concatenated metrics`, clientOptions(client), () => {
    const f = renderer(client);
    for (const value of [NaN, Infinity, -1, '999', null, undefined]) {
      f.render({ prompt_tokens: value, completion_tokens: value, total_tokens: value,
        prompt_cache_hit_tokens: value, prompt_cache_miss_tokens: value }, value);
      if (client === 'desktop') {
        assert.equal(f.total(), '0'); assert.doesNotMatch(f.element.innerHTML, /NaN|Infinity|999|width:/);
      } else assert.equal(f.element.textContent, '0.0k tokens');
    }
  });

  test(`${client} retains reported utilization above the advertised context window`, clientOptions(client), () => {
    const f = renderer(client); f.render({ prompt_tokens: 1250 }, 1000);
    if (client === 'desktop') assert.match(f.element.innerHTML, /width:125%/);
    else assert.match(f.element.textContent, /上下文 125%/);
  });
}

test('shared desktop metrics preserve immutable event payloads', () => {
  const p = Object.freeze({ prompt_tokens: 80, completion_tokens: 20,
    prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 90 });
  const metrics = rules().AsHubConversationPresentation.usageMetrics(p, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(metrics)), { input: 80, output: 20, total: 100,
    cacheHit: 10, cacheMiss: 90, cacheRatio: 0.1, cacheReported: true, hasCache: true,
    cachePercent: 10, contextPercent: 40 });
});

test('remote offline shell caches the shared dependency with the app', remoteOptions, async () => {
  const listeners = new Map(); let files, cache;
  vm.runInNewContext(read('remote/public/sw.js'), {
    self: { addEventListener: (name, handler) => listeners.set(name, handler) },
    caches: { open: async name => { cache = name; return { addAll: async paths => { files = paths; } }; } },
  });
  let install; listeners.get('install')({ waitUntil(promise) { install = promise; } }); await install;
  assert(files.includes('./conversation-presentation.js')); assert(files.includes('./app.js'));
  assert.notEqual(cache, 'ashub-mobile-shell-v34', 'old shell cache must be invalidated for the new dependency');
});

test('tool labels describe real operations with safe unknown-tool fallback', () => {
  const {toolDisplayName,toolActivityKey}=rules().AsHubConversationPresentation;
  assert.equal(toolDisplayName({name:'conversation_wait'},'zh'),'等待协作结果');
  assert.equal(toolActivityKey({name:'conversation_wait',kind:'execute'}),'activity.collaboration.wait');
  assert.equal(toolDisplayName({name:'conversation_send'},'en'),'Send collaboration message');
  for(const name of ['plugin_custom','constructor','toString']) assert.equal(toolDisplayName({name}),name);
  assert.equal(toolDisplayName({name:'custom',title:'Inspect worksheet'}),'Inspect worksheet');
});
test('thought previews remove formatting without corrupting Unicode or mutating source', () => {
  const {thinkingPreview}=rules().AsHubConversationPresentation;
  const source='**核对口径**\n\n## Next step\n[参考资料](https://example.test) `code`';
  assert.equal(thinkingPreview(source),'核对口径 Next step 参考资料 code');
  const preview=thinkingPreview('🟡'.repeat(110));
  assert.equal(Array.from(preview).length,101);assert(preview.endsWith('…'));assert.equal(preview.toWellFormed(),preview);
});

for (const client of ['desktop', 'remote']) test(`${client} activity times use original metadata and reject reconstructed history`, clientOptions(client), () => {
  const file = client === 'desktop' ? 'web/js/conversation-presentation.js' : 'remote/public/conversation-presentation.js';
  const {activityTimestamp, renderActivityTime} = rules(file).AsHubConversationPresentation;
  const ts = Date.UTC(2026,9,30,8,12,34), date = new Date(ts), value = activityTimestamp({ts});
  assert.equal(value.iso,date.toISOString());
  assert.equal(value.label,[date.getHours(),date.getMinutes(),date.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':'));
  assert.equal(activityTimestamp({ts:date.toISOString()}).iso,value.iso);
  for (const meta of [null, {}, {ts:''}, {ts:'invalid'}, {ts:Infinity}, {ts:true}, {ts,id:'hub:abc:branch:12'}]) assert.equal(activityTimestamp(meta),null);
  const node={}; renderActivityTime(node,value); assert.equal(node.hidden,false); assert.equal(node.dateTime,value.iso); assert(node.title.includes('2026-10-30'));
  renderActivityTime(node,null); assert.equal(node.hidden,true); assert.equal(node.textContent,'');
});
