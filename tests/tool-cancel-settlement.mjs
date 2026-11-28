import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-tool-cancel-'));
process.env.AGENT_SH_HOME = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key) || key === 'OPENAI_BASE_URL') delete process.env[key];
const base = 'https://fixture.invalid/v1';
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ startupBanner: false, autoCompact: false,
  'ashub.permissions.autoApprove': true, disabledBuiltins: ['codex-provider', 'rolling-history'],
  defaultProvider: 'fixture', providers: { fixture: { apiKey: 'fixture', baseURL: base, models: ['fixture-model'] } },
}));
const { AshBridge } = await import('../dist/bridges/ash.js');
const call = (id, index, name = 'cancel_fixture') => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify({ id }) } });
const sse = (delta, finish_reason) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

async function fixture(t, firstResponse) {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, `${base}/chat/completions`, 'unexpected fetch destination');
    seen.push(await request.json());
    if (seen.length === 1 && typeof firstResponse === 'function') return firstResponse();
    const data = seen.length === 1
      ? sse({ content: 'batch', tool_calls: firstResponse }, 'tool_calls')
      : sse({ content: 'FOLLOWUP' }, 'stop');
    return new Response(data + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const bridge = new AshBridge({ cwd: dir, provider: 'fixture', model: 'fixture-model' });
  t.after(() => bridge.close());
  await bridge.ready();
  return { bridge, seen };
}

function tool(bridge, execute, name = 'cancel_fixture', modifiesFiles = true) {
  // Scheduling and permission metadata only: these fake tools never touch files.
  bridge.extCtx.agent.registerTool({ name, description: 'Synthetic cancellation test', modifiesFiles,
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, execute });
}

function resultsFor(messages, ids) {
  const index = messages.findIndex(m => m.role === 'assistant' && m.tool_calls?.some(c => c.id === ids[0]));
  assert.notEqual(index, -1, 'the committed assistant tool batch was lost');
  assert.deepEqual(messages[index].tool_calls.map(c => c.id), ids);
  const actual = messages.slice(index + 1, index + 1 + ids.length);
  assert.deepEqual(actual.map(m => [m.role, m.tool_call_id]), ids.map(id => ['tool', id]), 'the batch must have contiguous ordered receipts');
  for (const id of ids) assert.equal(messages.filter(m => m.tool_call_id === id).length, 1, 'exactly one result per call');
  return actual.map(m => m.content);
}

test('cancel preserves confirmed results, marks in-flight outcome unknown and pairs skipped calls', { timeout: 8000 }, async t => {
  const ids = ['fixture-done', 'fixture-active', 'fixture-skipped'];
  const { bridge, seen } = await fixture(t, ids.map((id, i) => call(id, i)));
  const started = [], entered = Promise.withResolvers(), late = Promise.withResolvers();
  t.after(() => late.resolve({ content: 'late unconfirmed success' }));
  tool(bridge, ({ id }) => {
    started.push(id);
    if (id === ids[0]) return { content: 'confirmed fixture result' };
    if (id === ids[1]) { entered.resolve(); return late.promise; }
    assert.fail('the skipped tool was executed');
  });
  const settled = () => bridge.core.handlers.call('conversation:tool-calls-settled');
  const first = bridge.submit('first turn');
  await Promise.race([entered.promise, first.then(r => assert.fail(`turn returned before dispatch: ${r.stopReason}`))]);
  const whileActive = settled();
  bridge.cancel();
  assert.equal((await first).stopReason, 'cancelled');
  const afterCancel = settled();
  assert.deepEqual(started, ids.slice(0, 2));
  assert.equal(seen.length, 1);
  const followup = await bridge.submit('second turn');
  assert.notEqual(followup.stopReason, 'cancelled');
  assert.equal(seen.length, 2);
  assert.deepEqual(started, ids.slice(0, 2), 'next turn must not rerun tools');
  const saved = resultsFor((await bridge.snapshot()).messages, ids);
  assert.deepEqual(resultsFor(seen[1].messages, ids), saved, 'wire history must use the same durable receipts, not transport-only stubs');
  assert.equal(saved[0], 'confirmed fixture result');
  assert.match(saved[1], /result not confirmed/i);
  assert.match(saved[2], /tool was not started/i);
  assert.equal(whileActive, false);
  assert.equal(afterCancel, true);
  late.resolve({ content: 'late unconfirmed success' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(resultsFor((await bridge.snapshot()).messages, ids), saved, 'late results must not rewrite or duplicate receipts');
});

test('cancel after assistant batch is committed but before scheduling pairs every call without starting any', { timeout: 8000 }, async t => {
  const ids = ['fixture-first', 'fixture-second'];
  const { bridge, seen } = await fixture(t, ids.map((id, i) => call(id, i)));
  let launches = 0;
  tool(bridge, () => { launches++; return { content: 'must not execute' }; });
  const observed = [];
  bridge.core.bus.on('conversation:message-appended', message => {
    if (message.role === 'assistant' && message.content === 'batch') {
      observed.push(bridge.core.handlers.call('conversation:tool-calls-settled'));
      bridge.cancel();
    }
    if (message.role === 'tool') observed.push(bridge.core.handlers.call('conversation:tool-calls-settled'));
  });
  assert.equal((await bridge.submit('cancel before batch')).stopReason, 'cancelled');
  await bridge.submit('follow up');
  assert.equal(launches, 0);
  const saved = resultsFor((await bridge.snapshot()).messages, ids);
  assert(saved.every(content => /tool was not started/i.test(content)));
  assert.deepEqual(resultsFor(seen[1].messages, ids), saved);
  assert.deepEqual(observed, [false, true, true], 'the handler must stay false until every result is stored');
});

test('failure settling an interrupted batch does not reserve the next turn or certify the history', { timeout: 8000 }, async t => {
  const { bridge, seen } = await fixture(t, [call('fixture-fault', 0)]);
  const loop = bridge.core.handlers.call('agent:get-self');
  const fault = t.mock.method(loop.toolProtocol, 'recordResults', () => { throw Error('fixture history write failure'); });
  let launches = 0;
  const kernelTool = { name: 'cancel_fixture', description: 'Synthetic grouping failure', modifiesFiles: true,
    input_schema: { type: 'object' }, execute() { launches++; return { content: 'must not run' }; },
    formatCall() { bridge.cancel(); throw Error('interrupt before normal settlement'); } };
  bridge.extCtx.agent.registerTool(kernelTool);
  assert.equal((await bridge.submit('fault during settlement')).stopReason, 'cancelled');
  assert.equal(fault.mock.callCount(), 1, 'the failing finalizer must not retry a possibly partial write');
  assert.equal(bridge.core.handlers.call('conversation:tool-calls-settled'), false);
  await bridge.submit('another turn must still run');
  assert.equal(fault.mock.callCount(), 1);
  assert.equal(launches, 0);
  assert.equal(seen.length, 2);
});

test('reset during cancellation cannot append old tool receipts to the new conversation', { timeout: 8000 }, async t => {
  const { bridge, seen } = await fixture(t, [call('fixture-old', 0)]);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve({ content: 'late old tool' }));
  tool(bridge, () => { entered.resolve(); return release.promise; });
  const first = bridge.submit('about to reset');
  await Promise.race([entered.promise, first.then(r => assert.fail(`turn returned before dispatch: ${r.stopReason}`))]);
  bridge.core.bus.emit('agent:reset-session', {});
  assert.equal((await first).stopReason, 'cancelled');
  assert.equal(bridge.core.handlers.call('conversation:tool-calls-settled'), true);
  assert.deepEqual((await bridge.snapshot()).messages, []);
  await bridge.submit('new conversation');
  assert(!seen[1].messages.some(message => message.role === 'tool' || message.tool_calls?.length));
});

test('cancel during a partial model frame does not commit a provisional tool call', { timeout: 8000 }, async t => {
  let source;
  const { bridge, seen } = await fixture(t, () => new Response(new ReadableStream({ start(controller) {
    source = controller;
    const partial = call('fixture-provisional', 0);
    partial.function.arguments = '{"id":';
    controller.enqueue(new TextEncoder().encode(sse({ content: 'partial answer', tool_calls: [partial] }, null)));
  } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  t.after(() => { try { source?.close(); } catch {} });
  let launches = 0;
  tool(bridge, () => { launches++; return { content: 'must not execute' }; });
  bridge.core.bus.on('llm:chunk', ({ chunk }) => {
    if (chunk.choices[0]?.delta.tool_calls) bridge.cancel();
  });
  assert.equal((await bridge.submit('cancel while streaming')).stopReason, 'cancelled');
  await bridge.submit('follow up');
  assert.equal(launches, 0);
  assert(!seen[1].messages.some(m => m.tool_calls?.length || m.role === 'tool'));
  const messages = (await bridge.snapshot()).messages;
  assert(!messages.some(m => m.tool_calls?.length || m.role === 'tool'));
  assert(messages.some(m => m.role === 'assistant' && m.content === 'partial answer'), 'keep received assistant text');
});
