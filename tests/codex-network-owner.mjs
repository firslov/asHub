import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashub-codex-owner-'));
process.env.AGENT_SH_HOME = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const upstream = 'https://codex.invalid/responses';
const oauth = 'https://auth.openai.com/oauth/token';
const authFile = path.join(dir, 'codex-provider', 'auth.json');
fs.mkdirSync(path.dirname(authFile));
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
  'codex-provider': { models: ['fixture-model'], upstreamURL: upstream },
}));
const { createCore } = await import('agent-sh');
const { CodexProviderHost } = await import('../dist/providers/codex.js');
const { createPolicyFetch, withNetworkSession } = await import('../dist/network-policy.js');

function expireCredentials() {
  fs.writeFileSync(authFile, JSON.stringify({
    access: 'expired-fixture', refresh: 'fixture-refresh', accountId: 'fixture-account', expires: 1,
  }));
}

function createHost(t, owner) {
  const core = createCore({});
  if (owner) core.handlers.define('session:current-id', () => owner);
  let provider;
  const host = new CodexProviderHost({
    ...core.extensionContext({ quit() {} }),
    agent: { providers: {
      configure() {},
      register(reg) { provider = reg; return () => { provider = undefined; }; },
    } },
  });
  t.after(() => host.close());
  return { host, provider: () => provider };
}

for (const proxyEnabled of [true, false]) {
  test(`Codex refresh from catalog activation uses the owner instead of global ${proxyEnabled ? 'proxy' : 'direct'}`, { timeout: 10000 }, async t => {
    fs.rmSync(authFile, { force: true });
    const nativeFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = nativeFetch; });
    const calls = [];
    const policy = { proxyEnabled, sessions: { aaaa: proxyEnabled, bbbb: proxyEnabled, eeee: !proxyEnabled } };
    const transport = route => async (input, init) => {
      const url = String(input);
      const sessionId = new Headers(init?.headers).get('session_id');
      calls.push({ url, route, sessionId });
      if (url === oauth) {
        assert.equal(init.body.get('grant_type'), 'refresh_token');
        const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url');
        return Response.json({ access_token: `fixture.${claims}.fixture`, refresh_token: 'fixture-refreshed', expires_in: 3600 });
      }
      assert.equal(url, upstream, 'all outbound requests must be handled by the fixture');
      return new Response('data: {"type":"response.output_text.delta","delta":"FIXTURE_OK"}\n\n' +
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    };
    globalThis.fetch = createPolicyFetch(transport('proxy'), transport('direct'), () => policy);
    const first = createHost(t, 'aaaa');
    const second = createHost(t, 'bbbb');
    await withNetworkSession('ffff', () => first.host.sync()); // The timer can inherit an unrelated session.
    await second.host.sync();
    assert.equal(first.provider(), undefined, 'signed-out activation must not start the loopback server');
    assert.equal(second.provider(), undefined);
    expireCredentials();
    // Exercise the production catalog timer, not an explicit sync after sign-in.
    for (let attempts = 0; attempts < 250 && !(first.provider() && second.provider()); attempts++) await delay(20);
    assert(first.provider() && second.provider(), 'catalog polling did not activate both owners');

    const ownerless = createHost(t);
    await withNetworkSession('eeee', () => ownerless.host.sync());
    const normal = createHost(t, 'aaaa');
    await withNetworkSession('aaaa', () => normal.host.sync());

    const other = proxyEnabled ? 'direct' : 'proxy';
    const global = proxyEnabled ? 'proxy' : 'direct';
    const observations = [];
    for (const [host, owner, header] of [[first, 'aaaa', 'aaaa:compact'], [second, 'bbbb', 'bbbb'], [ownerless], [normal, 'aaaa', 'aaaa']]) {
      policy.sessions.aaaa = owner === 'aaaa' ? !proxyEnabled : proxyEnabled;
      policy.sessions.bbbb = owner === 'bbbb' ? !proxyEnabled : proxyEnabled;
      expireCredentials();
      calls.length = 0;
      const provider = host.provider();
      assert.equal(new URL(provider.baseURL).hostname, '127.0.0.1');
      const response = await nativeFetch(`${provider.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${provider.apiKey}`, 'content-type': 'application/json', ...(header ? { 'x-agent-sh-session': header } : {}) },
        body: JSON.stringify({ model: 'fixture-model', stream: false, messages: [{ role: 'user', content: 'fixture' }] }),
        signal: AbortSignal.timeout(1500),
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).choices[0].message.content, 'FIXTURE_OK');
      observations.push([...calls]);
    }
    assert.deepEqual(observations, [[other, 'aaaa:compact'], [other, 'bbbb'], [global, null], [other, 'aaaa']].map(([route, sessionId]) => [
      { url: oauth, route, sessionId: null }, { url: upstream, route, sessionId },
    ]));
    calls.length = 0;
    await globalThis.fetch(oauth, { body: new URLSearchParams({ grant_type: 'refresh_token' }) });
    assert.deepEqual(calls, [{ url: oauth, route: global, sessionId: null }], 'OAuth URL alone must not identify an owner');
  });
}
