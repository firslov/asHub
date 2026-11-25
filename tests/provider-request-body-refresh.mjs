import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-provider-body-'));
process.env.AGENT_SH_HOME = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
for (const key of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key) || key === 'OPENAI_BASE_URL') delete process.env[key];
const { createAgentHost, createSettingsService } = await import('agent-sh/runtime');
const { activateAgent } = await import('agent-sh/agent');

const baseURL = 'https://provider.invalid/v1';
const fixture = { apiKey: 'fixture-key', baseURL, defaultModel: 'fixture-model', models: ['fixture-model'] };
const oldBody = { provider: { order: ['old-route'] } };
const newBody = { provider: { order: ['new-route'] } };

test('provider refresh updates and clears requestBody on a running session', { timeout: 6000 }, async t => {
  const settingsService = createSettingsService({ defaultProvider: 'fixture', autoCompact: false,
    providers: { fixture: { ...fixture, requestBody: oldBody } } });
  const sent = [], firstSent = Promise.withResolvers(), finishFirst = Promise.withResolvers();
  let firstSignal, host;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, `${baseURL}/chat/completions`, 'no external fetch is allowed in the fixture');
    assert.equal(request.headers.get('authorization'), 'Bearer fixture-key');
    sent.push(await request.json());
    const index = sent.length;
    if (index === 1) {
      firstSignal = request.signal;
      firstSent.resolve();
      await finishFirst.promise;
      assert.equal(firstSignal.aborted, false, 'refresh must not cancel the in-flight request');
    }
    const chunk = { choices: [{ index: 0, delta: { content: `REPLY_${index}` }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  t.after(async () => { finishFirst.resolve(); await host?.dispose(); });
  host = await createAgentHost({ cwd: dir, settingsService, extensions: [{ name: 'agent', activate: activateAgent }] });
  const refresh = requestBody => {
    // Like reloading a saved provider object: missing requestBody is a true
    // deletion, not a deep merge with the previously saved value.
    settingsService.setSessionOverlay({ providers: { fixture: { ...fixture, ...(requestBody && { requestBody }) } } });
    host.context.bus.emit('agent:providers:changed', {});
  };
  const running = host.run('first turn', { rawErrors: true });
  await Promise.race([firstSent.promise, running.then(result => assert.fail(result.error ?? 'run finished before sending'))]);
  refresh(newBody);
  finishFirst.resolve();
  const first = await running;
  assert.equal(first.status, 'completed', first.error);
  assert.equal(first.text, 'REPLY_1');
  const second = await host.run('second turn', { rawErrors: true });
  refresh(undefined);
  const third = await host.run('third turn', { rawErrors: true });
  for (const [result, index] of [[second, 2], [third, 3]]) {
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.text, `REPLY_${index}`);
  }
  assert.deepEqual(sent.map(body => body.provider?.order ?? null), [['old-route'], ['new-route'], null]);
  assert.equal(Object.hasOwn(sent[2], 'provider'), false, 'deletion must omit the old routing field');
  assert(sent.every(body => body.model === 'fixture-model'));
  assert(sent[2].messages.some(message => message.content === 'REPLY_1'), 'the same session keeps its conversation history');
});
