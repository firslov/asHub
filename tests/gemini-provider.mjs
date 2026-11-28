import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const endpoint = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const otherEndpoint = 'https://other.invalid/v1/chat/completions';
const model = 'gemini-4-hydrogen';
const signature = 'opaque-google-fixture+/==';

function stream(chunks) {
  return new Response(chunks.map(([delta, finish_reason]) =>
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'
  ).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}

test('Google Gemini enrolls, runs an installed tool, restores its signature, and isolates it on model switch', { timeout: 20000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ashub-gemini-'));
  process.env.AGENT_SH_HOME = home;
  process.env.ASHUB_TOKEN = 'gemini-config-fixture';
  for (const key of Object.keys(process.env)) {
    if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key) || key === 'OPENAI_BASE_URL') delete process.env[key];
  }
  const extensions = path.join(home, 'extensions');
  await fs.mkdir(extensions);
  await fs.writeFile(path.join(extensions, 'fixture.mjs'), `
    export default function activate(ctx) {
      ctx.agent.registerTool({
        name: 'fixture_lookup', description: 'Look up the test value', readOnly: true,
        input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
        async execute({ key }) { return { content: 'plugin-answer:' + key }; },
      });
    }
  `);
  const settings = {
    startupBanner: false, autoCompact: false, disabledBuiltins: ['rolling-history', 'codex-provider'],
    providers: {},
  };
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify(settings));
  const requests = [];
  const fetchLocal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    assert([endpoint, otherEndpoint].includes(request.url), request.url);
    const body = await request.json();
    requests.push({ url: request.url, auth: request.headers.get('authorization'), body });
    if (request.url === endpoint && body.messages.some(message => message.content === 'Run the fixture lookup')
      && !body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'fixture-call')) {
      return stream([
        [{ tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'fixture_lookup', arguments: '{"key":' } }] }, null],
        [{ tool_calls: [{ id: 'fixture-call', function: { arguments: '"check"}' }, extra_content: { google: { thought_signature: signature } } }] }, null],
        [{ tool_calls: [{ id: 'project-call', type: 'function', function: { name: 'conversation_list', arguments: '{}' } }] }, null],
        [{}, 'stop'],
      ]);
    }
    return stream([[{ content: 'Fixture complete' }, 'stop']]);
  });
  const { AshBridge } = await import('../dist/bridges/ash.js');
  const { startHub } = await import('../dist/hub.js');
  let active;
  const hub = startHub({
    host: '127.0.0.1', port: 0, webRoot: path.resolve(import.meta.dirname, '../web'),
    makeBridge: opts => (active = new AshBridge(opts)),
  });
  let restored;
  t.after(async () => {
    restored?.close();
    try { await hub.shutdown(); } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
  await once(hub.server, 'listening');
  const base = 'http://127.0.0.1:' + hub.server.address().port;
  const call = (route, method = 'GET', body) => fetchLocal(base + route, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: 'Bearer gemini-config-fixture', 'Content-Type': 'application/json' },
  });

  const cold = await call('/api/models/gemini');
  assert.equal(cold.status, 200);
  const catalog = await cold.json();
  assert.equal(catalog.defaultModel, model);
  assert.deepEqual(catalog.models[0].modalities, ['text', 'image']);
  const created = await call('/sessions', 'POST', { cwd: home });
  assert.equal(created.status, 200);
  const { instanceId } = await created.json();
  const project = await call('/api/projects', 'POST', {
    action: 'create', cwd: home, name: 'Gemini project fixture', add: [instanceId],
  });
  assert.equal(project.status, 200, await project.text());
  assert.equal(active.backendRegistered, false);
  const configured = await call('/api/config', 'PUT', {
    ...settings, defaultProvider: 'gemini', providers: { gemini: { apiKey: 'fixture-key' } },
  });
  assert.equal(configured.status, 200, await configured.text());
  const masked = await (await call('/api/config')).json();
  assert.equal(masked.providers.gemini.apiKey, '••••••••');
  assert.equal(masked.anyProviderConfigured, true);

  await active.submit('Run the fixture lookup');
  const gemini = requests.filter(request => request.url === endpoint);
  assert.equal(gemini.length, 2, JSON.stringify(gemini));
  assert(gemini.every(request => request.auth === 'Bearer fixture-key' && request.body.model === model));
  assert(gemini[0].body.tools.some(tool => tool.function.name === 'fixture_lookup'));
  assert(gemini[0].body.tools.some(tool => tool.function.name === 'conversation_list'));
  assert(gemini[1].body.messages.some(message => message.role === 'tool' && message.content === 'plugin-answer:check'));
  assert(gemini[1].body.messages.some(message =>
    message.role === 'tool' && message.tool_call_id === 'project-call' && message.content.includes(instanceId)
  ));
  const findCall = messages => messages.find(message => message.tool_calls?.some(call => call.id === 'fixture-call'))
    ?.tool_calls.find(call => call.id === 'fixture-call');
  const wireSignature = messages => findCall(messages)?.extra_content?.google?.thought_signature;
  assert.equal(wireSignature(gemini[1].body.messages), signature);
  assert.equal(findCall(gemini[1].body.messages)?.googleThoughtSignature, undefined);

  const snapshot = await active.snapshot({ skipTokens: true });
  assert.equal(findCall(snapshot.messages)?.googleThoughtSignature, signature);
  restored = new AshBridge({ cwd: home, provider: 'gemini', model, initialMessages: snapshot.messages, isRestored: true });
  await restored.ready();
  await restored.submit('Continue the same conversation');
  assert.equal(wireSignature(requests.at(-1).body.messages), signature);
  assert.equal(await active.backgroundComplete(
    [{ role: 'user', content: 'Organize this memory' }], new AbortController().signal, { provider: 'gemini', model },
  ), 'Fixture complete');

  const switched = await call('/api/config', 'PUT', {
    ...settings, defaultProvider: 'gemini', providers: {
      gemini: { apiKey: 'fixture-rotated' },
      other: { apiKey: 'other-key', baseURL: 'https://other.invalid/v1', models: ['other-model'] },
    },
  });
  assert.equal(switched.status, 200, await switched.text());
  await active.submit('Use the rotated key');
  assert.equal(requests.at(-1).auth, 'Bearer fixture-rotated');
  await active.execCommand('/model', 'other-model@other');
  await active.submit('Continue with another provider');
  const other = requests.at(-1);
  assert.equal(other.url, otherEndpoint);
  assert.equal(wireSignature(other.body.messages), undefined);
  assert.equal(findCall(other.body.messages)?.googleThoughtSignature, undefined);
  assert(other.body.messages.some(message => message.role === 'tool' && message.content === 'plugin-answer:check'));
  assert.equal(findCall((await active.snapshot({ skipTokens: true })).messages)?.googleThoughtSignature, signature);

  await hub.shutdown();
  const tree = await fs.readFile(path.join(home, 'hub-sessions', instanceId + '.jsonl'), 'utf8');
  const stored = tree.trim().split('\n').map(line => JSON.parse(line).message).filter(Boolean);
  assert.equal(findCall(stored)?.googleThoughtSignature, signature);
  assert(!tree.includes('fixture-rotated'));
});
