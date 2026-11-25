const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-child-retry-'));
process.env.AGENT_SH_HOME = path.join(cwd, 'config');
test.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

async function runChild(stream, opts = {}) {
  const { runSubagent } = await import('agent-sh');
  return runSubagent({
    cwd, llmClient: { stream, model: 'fixture' }, tools: [],
    task: 'Run the fixture', systemPrompt: 'Use only the supplied test inputs.',
    ...opts,
  });
}
function proxyError(retryable, message = 'net::ERR_HTTP2_PROTOCOL_ERROR') {
  return Object.assign(new Error(message), {
    type: 'codex_proxy_error', error: { status: 502, retryable, retry_after: '0' },
  });
}
function response(delta, finish_reason, completion_tokens) {
  return { choices: [{ index: 0, delta, finish_reason }],
    ...(completion_tokens === undefined ? {} : { usage: { prompt_tokens: 10, completion_tokens, total_tokens: 10 + completion_tokens } }) };
}
function toolCall(id, finish, completionTokens) {
  return response({ tool_calls: [{ index: 0, id, type: 'function',
    function: { name: 'test_tool', arguments: '{}' } }] }, finish, completionTokens);
}

test('the installed child engine retries just a broken request after a tool has run', async () => {
  const requests = [];
  let executions = 0;
  const outMeta = {};
  const result = await runChild(async function* (options) {
    requests.push(structuredClone(options.messages));
    switch (requests.length) {
      case 1: yield toolCall('valid-call', 'tool_calls', 3); return;
      case 2:
        yield toolCall('incomplete-call', null);
        yield response({ content: 'INTERRUPTED_TEXT' }, null);
        throw Object.assign(new TypeError('terminated'), { headers: { 'retry-after': '0' } });
      case 3: yield response({ content: 'SUBAGENT_DONE' }, 'stop', 2);
    }
  }, { outMeta, maxIterations: 2, tools: [{ name: 'test_tool', description: 'Record a test observation',
    input_schema: { type: 'object' }, modifiesFiles: true, async execute() {
      executions++;
      return { content: 'TOOL_RESULT_FROZEN', exitCode: 0, isError: false };
    } }] });
  assert.equal(executions, 1);
  assert.equal(requests.length, 3);
  assert.equal(result, 'SUBAGENT_DONE');
  assert.deepEqual(requests[2], requests[1]);
  assert(requests[2].some(message => message.role === 'tool' && message.tool_call_id === 'valid-call' && message.content === 'TOOL_RESULT_FROZEN'));
  assert(!JSON.stringify(outMeta.messages).includes('incomplete-call'));
  assert(!JSON.stringify(outMeta.messages).includes('INTERRUPTED_TEXT'));
  assert.equal(outMeta.tokensUsed, 5);
  assert.equal(outMeta.degraded, null);
});

test('clean EOF before a child tool turn closes cannot execute the buffered tool call', async () => {
  const requests = [];
  let executions = 0;
  const outMeta = {};
  const result = await runChild(async function* ({ messages }) {
    requests.push(structuredClone(messages));
    if (requests.length === 1) yield toolCall('completed-write', 'tool_calls');
    else if (requests.length === 2) {
      // Some proxies cut the upstream socket but end the local body normally.
      // A syntactically complete argument fragment still has no finish marker.
      yield toolCall('uncommitted-write', null);
    } else yield response({ content: 'Completed using the retained receipt.' }, 'stop');
  }, { outMeta, maxIterations: 3, tools: [{ name: 'test_tool', description: 'Record a test write',
    input_schema: { type: 'object' }, modifiesFiles: true,
    async execute() { executions++; return { content: 'WRITE_RECEIPT', exitCode: 0, isError: false }; },
  }] });
  assert.equal(result, 'Completed using the retained receipt.');
  assert.equal(executions, 1);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2], requests[1]);
  assert(requests[2].some(message => message.role === 'tool' && message.tool_call_id === 'completed-write'));
  assert(!JSON.stringify(outMeta.messages).includes('uncommitted-write'));
});

test('a truncated or malformed child tool call cannot become default arguments', async () => {
  let executions = 0;
  const tool = { name: 'test_tool', description: 'A tool with optional arguments', input_schema: { type: 'object' },
    async execute(args) {
      executions++;
      assert.deepEqual(args, {});
      return { content: 'RECEIPT', exitCode: 0, isError: false };
    }
  };
  for (const [finish, argumentsJson, expected] of [
    ['length', '{}', /incomplete \(length\)/],
    ['content_filter', '{}', /incomplete \(content_filter\)/],
    ['tool_calls', '{"partial":', /invalid JSON arguments/],
    ['tool_calls', '[]', /invalid JSON arguments/],
  ]) {
    let requests = 0;
    await assert.rejects(runChild(async function* () {
      requests++;
      const chunk = toolCall('partial-tool', finish);
      chunk.choices[0].delta.tool_calls[0].function.arguments = argumentsJson;
      yield chunk;
    }, { tools: [tool] }), expected);
    assert.equal(requests, 1);
    assert.equal(executions, 0);
  }
  let requests = 0;
  const result = await runChild(async function* () {
    if (++requests > 1) { yield response({ content: 'Valid no-argument result' }, 'stop'); return; }
    const chunk = toolCall('valid-no-args', 'tool_calls');
    chunk.choices[0].delta.tool_calls[0].function.arguments = '';
    yield chunk;
  }, { tools: [tool] });
  assert.equal(result, 'Valid no-argument result');
  assert.equal(executions, 1);
  assert.equal(requests, 2);
});

test('an unfinished child tool call at the completion budget retains the partial outcome', async () => {
  let requests = 0, executions = 0;
  const outMeta = {};
  const result = await runChild(async function* () {
    requests++;
    if (requests === 1) yield toolCall('completed-write', 'tool_calls', 3);
    else yield toolCall('budget-cut-write', 'length', 2);
  }, { outMeta, budgetTokens: 5, tools: [{ name: 'test_tool', description: 'Record a write receipt', input_schema: { type: 'object' },
    modifiesFiles: true, async execute() {
      executions++;
      return { content: 'COMMITTED_RECEIPT', exitCode: 0, isError: false };
    },
  }] });
  assert.match(result, /completion-token budget/);
  assert.equal(outMeta.degraded, 'budget');
  assert.equal(outMeta.tokensUsed, 5);
  assert.equal(requests, 2);
  assert.equal(executions, 1);
  assert(outMeta.messages.some(message => message.role === 'tool' && message.tool_call_id === 'completed-write'));
  assert(!JSON.stringify(outMeta.messages).includes('budget-cut-write'));
});

test('the child engine honors structured proxy retry without an SDK HTTP status', async () => {
  let requests = 0;
  const result = await runChild(async function* () {
    if (++requests === 1) throw proxyError(true);
    yield response({ content: 'ready' }, 'stop');
  });
  assert.equal(result, 'ready');
  assert.equal(requests, 2);
});

for (const message of ['net::ERR_HTTP2_PROTOCOL_ERROR', 'fetch failed', 'network certificate failure', 'maximum context length']) {
  test(`the child engine honors explicit no-retry for ${message}`, async () => {
    let requests = 0;
    const notices = [];
    const bus = { emit(name, event) { if (name === 'ui:info') notices.push(event.message); }, emitTransform() {} };
    await assert.rejects(runChild(async function* () { requests++; throw proxyError(false, message); }, { bus }),
      error => error.message.includes(message));
    assert.equal(requests, 1);
    assert.deepEqual(notices, []);
  });
}

test('persistent transient errors respect the child engine request limit', async () => {
  let requests = 0;
  await assert.rejects(runChild(async function* () { requests++; throw proxyError(true); }), /HTTP2_PROTOCOL_ERROR/);
  assert.equal(requests, 4);
});

test('the child engine can accept an empty terminal reply without opening a fresh retry budget', async () => {
  let requests = 0;
  assert.equal(await runChild(async function* () {
    requests++;
    yield response({}, 'stop');
  }, { retryEmptyReplies: false }), '');
  assert.equal(requests, 1);
});

for (const error of [Object.assign(new Error('rate limited'), { status: 429 }), Object.assign(new Error('busy'), { status: 503 }), new Error('Connection error.')]) {
  test(`the child engine retries a transient provider error: ${error.message}`, async () => {
    let requests = 0;
    const result = await runChild(async function* () {
      if (++requests === 1) throw Object.assign(error, { headers: { 'retry-after': '0' } });
      yield response({ content: 'ready' }, 'stop');
    });
    assert.equal(result, 'ready');
    assert.equal(requests, 2);
  });
}
for (const when of ['before dispatch', 'on retry notice', 'during backoff']) {
  test(`cancellation ${when} prevents another child request`, async () => {
    const controller = new AbortController();
    let requests = 0, notices = 0;
    if (when === 'before dispatch') controller.abort();
    const outMeta = {};
    const retry = Object.assign(proxyError(true), { headers: { 'retry-after': '60' } });
    await runChild(async function* () { requests++; throw retry; }, { signal: controller.signal, outMeta,
      bus: { emit(name, payload) {
        if (name !== 'ui:info' || !payload.message.includes('retrying')) return;
        notices++;
        if (when === 'on retry notice') controller.abort();
        else setTimeout(() => controller.abort(), 10);
      }, emitTransform() {} },
    });
    assert.equal(requests, when === 'before dispatch' ? 0 : 1);
    assert.equal(notices, when === 'before dispatch' ? 0 : 1);
    assert.equal(outMeta.degraded, null);
  });
}

const assistantCalls = (...ids) => ({ role: 'assistant', content: null, tool_calls: ids.map(id => ({
  id, type: 'function', function: { name: 'fixture_observation', arguments: '{}' },
})) });
const toolOutput = (id, content) => ({ role: 'tool', tool_call_id: id, content });

test('subagent checkpoint preserves long task and tool output in their original roles', async () => {
  const { retainSubagentHistory } = await import('../dist/bridges/subagent-history.js');
  const history = [
    { role: 'user', content: `${'task details '.repeat(300)}LATEST_TASK_CONSTRAINT` },
    assistantCalls('tool-1'), toolOutput('tool-1', `${'line\n'.repeat(3000)}OUTPUT_TAIL_RECEIPT`),
    { role: 'assistant', content: `${'progress '.repeat(300)}LATEST_FINDING` },
  ];
  const retained = retainSubagentHistory(history, 32_000);
  assert.deepEqual(retained, history);
  assert.notEqual(retained, history, 'caller cannot append a follow-up to the saved array');
});

test('bounded continuation keeps whole tool groups even if long commentary must be omitted', async () => {
  const { retainSubagentHistory } = await import('../dist/bridges/subagent-history.js');
  const task = { role: 'user', content: 'Original user task and scope.' };
  const observations = [assistantCalls('tool-1', 'tool-2'), toolOutput('tool-1', 'FIRST_RECEIPT'), toolOutput('tool-2', 'SECOND_RECEIPT')];
  const report = { role: 'assistant', content: 'Most recent finding.' };
  const original = [task, ...observations, { role: 'assistant', content: 'old '.repeat(10_000) }, report];
  const retained = retainSubagentHistory(original, 2048);
  assert.deepEqual(retained[0], task);
  assert.match(retained[1].content, /Omitted tool output does not imply the tool was never executed/);
  assert.deepEqual(retained.slice(2), [...observations, report]);
  const next = retainSubagentHistory([...retained, { role: 'assistant', content: 'large '.repeat(10_000) }], 2048);
  assert.deepEqual(next, retained, 'repeated trimming does not stack synthetic notes or split completed calls');
});

test('subagent checkpoints reject incomplete tool groups and cap large inline payloads', async () => {
  const { retainSubagentHistory } = await import('../dist/bridges/subagent-history.js');
  const task = { role: 'user', content: 'Original task.' };
  assert.equal(retainSubagentHistory([task, assistantCalls('a', 'b'), toolOutput('a', 'not complete')]), undefined);
  assert.equal(retainSubagentHistory([task, assistantCalls(undefined), toolOutput(undefined, 'missing identity')]), undefined);
  assert.equal(retainSubagentHistory([task, toolOutput('a', 'orphan')]), undefined);
  assert.equal(retainSubagentHistory([task, assistantCalls('a'), toolOutput('a', 'complete'), toolOutput('a', 'duplicate')]), undefined);
  const image = [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'a'.repeat(2 * 1024 * 1024)}` } }];
  const oversized = [task, assistantCalls('image'), toolOutput('image', image)];
  assert.equal(retainSubagentHistory(oversized), undefined, 'do not continue without any usable prior output');
  const report = { role: 'assistant', content: 'Other observations remain.' };
  const retained = retainSubagentHistory([...oversized, report]);
  assert.deepEqual(retained.map(message => message.role), ['user', 'user', 'assistant']);
  assert.deepEqual(retained.at(-1), report);
});

test('continuation neutralizes a cleared tool marker after native overflow compaction', async () => {
  const { retainSubagentHistory, sanitizeSubagentCompactionMarkers } = await import('../dist/bridges/subagent-history.js');
  const runs = {}, outMeta = {};
  let requests = 0;
  const initial = await runChild(async function* () {
    requests++;
    if (requests <= 5) yield toolCall(`observation-${requests}`, 'tool_calls');
    else if (requests === 6) throw Object.assign(new Error('maximum context length'), { code: 'context_length_exceeded' });
    else yield response({ content: 'Prior work finished.' }, 'stop');
  }, { outMeta, tools: [{ name: 'test_tool', description: 'Record a read-only observation', input_schema: { type: 'object' },
    async execute() {
      runs.observed = (runs.observed ?? 0) + 1;
      return { content: 'x'.repeat(28_000), exitCode: 0, isError: false };
    },
  }] });
  assert.equal(initial, 'Prior work finished.');
  assert.equal(requests, 7);
  assert.equal(runs.observed, 5);
  const nativeMarker = outMeta.messages.find(message => message.role === 'tool' && /re-run the tool/.test(message.content));
  assert.equal(nativeMarker?.tool_call_id, 'observation-1', 'explicit provider overflow can compact despite no contextWindow option');
  const system = { role: 'system', content: 'Follow the original scope.' };
  const ordinaryOutput = toolOutput('quoted', `The log quoted: ${nativeMarker.content}`);
  const upload = [system, ...outMeta.messages, ordinaryOutput];
  const sanitized = sanitizeSubagentCompactionMarkers(upload);
  assert.equal(sanitized[0], system);
  assert.equal(sanitized.at(-1), ordinaryOutput, 'ordinary quoted observations are not rewritten');
  assert.match(sanitized.find(message => message.tool_call_id === 'observation-1').content, /already attempted/);
  assert.equal(sanitizeSubagentCompactionMarkers(sanitized), sanitized, 'uploads without native markers need no copy');
  const markerText = '[earlier steps of this run were removed to fit the context window; continue from the recent steps below and re-check state before relying on earlier ones]';
  const originalTask = { role: 'user', content: markerText };
  const tasks = [system, originalTask, { role: 'assistant', content: 'Earlier work.' }, { ...originalTask }];
  assert.equal(sanitizeSubagentCompactionMarkers(tasks), tasks, 'tasks that quote a native omission notice remain intact');
  const retained = retainSubagentHistory(outMeta.messages);
  assert.equal(retained[0].content, 'Run the fixture');
  assert.match(retained.find(message => message.tool_call_id === 'observation-1').content, /already attempted/);
  assert.equal(retained.filter(message => message.role === 'tool').length, 5);
  const followup = await runChild(async function* (options) {
    assert(!JSON.stringify(options.messages).includes('re-run the tool'));
    assert(options.messages.some(message => message.tool_call_id === 'observation-5' && message.content.length === 28_000));
    yield response({ content: 'Continued with the retained evidence.' }, 'stop');
  }, { task: 'Continue the fixture.', history: retained });
  assert.equal(followup, 'Continued with the retained evidence.');
  assert.equal(runs.observed, 5, 'replaying known evidence does not execute its tools');
});
