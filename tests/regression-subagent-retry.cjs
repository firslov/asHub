const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const timers = require('node:timers/promises');
const ts = require('typescript');

// Exercise the actual bridge retry closure without launching tools or a model.
const file = path.join(__dirname, '../src/bridges/ash.ts');
const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
let initializer;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'runSubagentWithRetry') initializer = node.initializer.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert(initializer, 'bridge retry closure missing');
const code = ts.transpileModule(`module.exports = ${initializer}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function retry(wait = (_delay, _value, options) => timers.setTimeout(0, undefined, options)) {
  const context = { module: { exports: {} }, Error, waitForRetry: wait };
  vm.runInNewContext(code, context);
  return context.module.exports;
}
function proxyError(retryable, message = 'net::ERR_HTTP2_PROTOCOL_ERROR') {
  return Object.assign(new Error(message), { type: 'codex_proxy_error', error: { status: 502, retryable } });
}

test('subagents recover a Codex SSE network error with no HTTP status on APIError', async () => {
  let calls = 0;
  const result = await retry()(async () => { if (++calls === 1) throw proxyError(true); return 'done'; });
  assert.equal(result, 'done'); assert.equal(calls, 2);
});
for (const message of ['net::ERR_HTTP2_PROTOCOL_ERROR', 'fetch failed', 'network certificate failure']) {
  test(`subagents honor explicit no-retry before message matching: ${message}`, async () => {
    let calls = 0;
    await assert.rejects(retry()(async () => { calls++; throw proxyError(false, message); }));
    assert.equal(calls, 1);
  });
}
test('subagents never repeat already executed mutating tools', async () => {
  let calls = 0;
  await assert.rejects(retry()(async () => { calls++; throw proxyError(true); }, { canRetry: () => false }));
  assert.equal(calls, 1);
});
test('subagent retry budget remains bounded', async () => {
  let calls = 0;
  await assert.rejects(retry()(async () => { calls++; throw proxyError(true); }));
  assert.equal(calls, 3);
});
for (const stage of ['before launch', 'on retry announcement', 'during backoff']) {
  test(`subagent cancellation ${stage} prevents another request`, async () => {
    const controller = new AbortController();
    let calls = 0;
    if (stage === 'before launch') controller.abort();
    const run = retry((ms, value, options) => {
      const pending = timers.setTimeout(10000, value, options);
      if (stage === 'during backoff') queueMicrotask(() => controller.abort());
      return pending;
    });
    await assert.rejects(run(async () => { calls++; throw proxyError(true); }, {
      signal: controller.signal,
      onRetry: () => { if (stage === 'on retry announcement') controller.abort(); },
    }), /abort/i);
    assert.equal(calls, stage === 'before launch' ? 0 : 1);
  });
}
test('legacy provider status and network retries still work', async () => {
  for (const error of [Object.assign(new Error('limited'), { status: 429 }), new Error('Connection error.')]) {
    let calls = 0;
    assert.equal(await retry()(async () => { if (++calls === 1) throw error; return 'done'; }), 'done');
    assert.equal(calls, 2);
  }
});
