import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const delivery = { summary: 'Fixture review verified', artifacts: [], unresolved: [] };

function fakeAgy(dir) {
  let serial = 0, held, previous;
  const log = (event, data = {}) => fs.appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ event, pid: process.pid, ...data }) + '\n');
  const frame = value => JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n';
  const send = value => process.stdout.write(frame(value));
  const chunk = (sessionId, text, sessionUpdate = 'agent_message_chunk') => ({ method: 'session/update', params: { sessionId, update: { sessionUpdate, content: { type: 'text', text } } } });
  const reply = (id, stopReason = 'end_turn') => ({ id, result: { stopReason } });
  const complete = (token, status = 'reviewed') => JSON.stringify({ review: token, status, summary: delivery.summary, unresolved: [] });
  createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params, result } = JSON.parse(line);
    try {
      if (method === 'initialize') {
        log('launch', { args: process.argv.slice(3), cwd: process.cwd(), token: !!process.env.ASHUB_TOKEN });
        send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      } else if (method === 'session/new') {
        const sessionId = `fake-${process.pid}-${++serial}`;
        log('session/new', { ...params, sessionId });
        if (fs.existsSync(path.join(dir, 'hold-session-new'))) {
          log('waiting for session/new', { sessionId });
          const timer = setInterval(() => {
            if (fs.existsSync(path.join(dir, 'hold-session-new'))) return;
            clearInterval(timer);
            send({ id, result: { sessionId } });
          }, 10);
        } else send({ id, result: { sessionId } });
      } else if (method === 'session/load') {
        log('session/load', { params });
        send({ id, result: {} });
      } else if (method === 'session/prompt') {
        const { sessionId, prompt } = params;
        const text = prompt[0]?.text;
        const token = /^Review token: (.+)$/m.exec(text)?.[1];
        const encoded = /^Task material \(JSON string\): (.+)$/m.exec(text)?.[1];
        if (!token || !encoded) throw Error('Missing review contract');
        const material = JSON.parse(encoded);
        log('prompt', { material, token, text, sessionId });
        if (material === 'disconnect' || material === 'disconnect after text') {
          if (material.endsWith('text')) process.stdout.write(frame(chunk(sessionId, complete(token))), () => process.exit(17));
          else process.exit(17);
          return;
        }
        const json = complete(material === 'old token' ? 'stale-token' : token, material === 'blocked' ? 'blocked' : 'reviewed');
        if (material === 'hold' || material === 'ignore cancel' || material === 'revoke membership') {
          held = { id, sessionId, text: json, material };
          if (material === 'revoke membership') {
            let count = 0;
            const timer = setInterval(() => {
              if (!fs.existsSync(path.join(dir, 'revoke')) && ++count < 400) return;
              clearInterval(timer);
              send(chunk(sessionId, json)); send(reply(id)); held = undefined;
            }, 10);
          }
          return;
        }
        if (material === 'permission request') {
          held = { id, sessionId, text: json, material };
          send({ id: 'approval', method: 'session/request_permission', params: { sessionId,
            toolCall: { title: 'Run mcp_ashub_task_get_task', kind: 'other' }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }] } });
          return;
        }
        if (material === 'reply then late text') {
          process.stdout.write(frame(reply(id)) + frame(chunk(sessionId, json)));
          return;
        }
        if (previous) send(chunk(previous, 'interleaved stale text'));
        previous = sessionId;
        send(chunk(sessionId, 'untrusted thought', 'agent_thought_chunk'));
        send(chunk(undefined, 'unbound text'));
        const output = material === 'malformed' ? 'plain text' : material === 'oversized' ? ' '.repeat(16001) : json;
        process.stdout.write(frame(chunk(sessionId, output.slice(0, 12))) + frame(chunk(sessionId, output.slice(12))) +
          frame(reply(id, material === 'not normal' ? 'max_tokens' : 'end_turn')) + frame(chunk(sessionId, 'late text after a valid reply')) + frame(reply(id)));
      } else if (id === 'approval') {
        log('permission', { result });
        send(chunk(held.sessionId, held.text)); send(reply(held.id)); held = undefined;
      } else if (method === 'session/cancel') {
        log('cancel', { sessionId: params.sessionId });
        if (held && held.material !== 'ignore cancel') {
          // A valid response after user cancellation must not become a delivery.
          send(chunk(held.sessionId, held.text)); send(reply(held.id)); held = undefined;
        }
      }
    } catch (error) { log('failure', { error: String(error) }); process.exit(1); }
  });
}

if (process.argv[2] === '--fake-agy') fakeAgy(process.env.TMPDIR);
else test('Antigravity reviews require a current project grant and persist only a scoped final response', {
  timeout: 45000, skip: process.platform === 'win32' && 'PATH shim uses a POSIX executable',
}, async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ashub-agy-review-'));
  const home = path.join(dir, 'home'), cwd = path.join(dir, 'project');
  const savedEnv = process.env;
  let hub;
  t.after(async () => {
    try { await hub?.shutdown(); }
    finally { process.env = savedEnv; await fsp.rm(dir, { recursive: true, force: true }); }
  });
  await Promise.all([fsp.mkdir(home), fsp.mkdir(cwd)]);
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  await fsp.writeFile(path.join(dir, 'agy'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --fake-agy "$@"\n`, { mode: 0o755 });
  await fsp.writeFile(path.join(home, 'settings.json'), JSON.stringify({ disabledBuiltins: ['codex-provider'] }));
  process.env = { ...savedEnv, PATH: dir, TMPDIR: dir, AGENT_SH_HOME: home, ASHUB_TOKEN: 'agy-project-test', ASHUB_EXPERIMENTAL_ANTIGRAVITY_WORKER: '1' };
  const { startHub } = await import('../dist/hub.js');
  const { AshBridge } = await import('../dist/bridges/ash.js');
  const { createAntigravityPlugin } = await import('../dist/builtin-plugins/google-antigravity/bridge.js');
  const { default: activateProjectManagement } = await import('../examples/extensions/project-management/index.mjs');
  const coordinator = new Map();
  const plugin = createAntigravityPlugin();
  const start = async () => {
    hub = startHub({ host: '127.0.0.1', port: 0, webRoot: path.resolve(import.meta.dirname, '../web'),
      makeBridge(opts) { coordinator.set(opts.sessionId, opts); return new AshBridge(opts); },
      makeAntigravityBridge(opts) {
        if (opts.projectWorker) { assert.equal(opts.conversationAccess, undefined); assert.equal(opts.hostAccess, undefined); }
        return plugin.makeBridge(opts);
      },
      projectSessionBackends: plugin.projectSessionBackends,
    });
    if (!hub.server.listening) await once(hub.server, 'listening');
  };
  const request = async (route, body, status = 200) => {
    const r = await fetch(`http://127.0.0.1:${hub.server.address().port}${route}`, {
      method: body === undefined ? 'GET' : 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      headers: { authorization: 'Bearer agy-project-test', 'content-type': 'application/json' },
    });
    const text = await r.text();
    assert.equal(r.status, status, `${route}: ${text}`);
    return status === 200 ? JSON.parse(text) : text;
  };
  const rows = () => {
    const file = path.join(dir, 'events.jsonl');
    const result = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    assert(!result.some(row => row.event === 'failure'), JSON.stringify(result.find(row => row.event === 'failure')));
    return result;
  };
  const until = async (label, fn) => {
    for (let n = 0; n < 350; n++) { const value = await fn(); if (value) return value; await delay(20); }
    assert.fail(`Timed out waiting for ${label}`);
  };
  const event = (name, match = () => true) => until(name, () => rows().find(row => row.event === name && match(row)));
  await start();
  const { instanceId: owner } = await request('/sessions', { cwd });
  const { instanceId: independent } = await request('/sessions', { cwd, kind: 'antigravity' });
  const [{ id: project }] = await request('/api/projects', { action: 'create', name: 'Worker fixture', cwd, add: [owner] });
  let { instanceId: worker } = await request('/api/projects/session', { projectId: project, backend: 'google-antigravity' });
  assert.deepEqual(await request('/api/projects/session-backends'), { backends: [
    { id: 'google-antigravity', label: 'Google Antigravity (Experimental)', taskProfile: 'inline-review' },
  ] });
  const checkTaskProfile = async () => {
    const sessions = await request('/sessions');
    assert.equal(sessions.find(s => s.instanceId === worker).projectTaskProfile, 'inline-review');
    assert.equal(sessions.find(s => s.instanceId === owner).projectTaskProfile, undefined);
    const standalone = sessions.find(s => s.instanceId === independent);
    if (standalone) assert.equal(standalone.projectTaskProfile, undefined);
    const { conversations } = await coordinator.get(owner).hostAccess.catalog();
    const entry = conversations.find(s => s.id === worker);
    assert.equal(entry.projectWorker, true);
    assert.equal(entry.projectTaskProfile, 'inline-review');
    assert.equal(conversations.find(s => s.id === owner).projectTaskProfile, undefined);
  };
  await checkTaskProfile();
  let access = coordinator.get(owner).conversationAccess;
  await assert.rejects(access.send(independent, 'not a project recipient'), /conversation|project/i);
  assert.match(await request(`/${worker}/submit`, { query: 'not authorized' }, 409), /authorized task/i);
  const tasks = () => request(`/api/projects/tasks?projectId=${project}`);
  const terminal = id => until('terminal receipt', async () => (await tasks()).find(r => r.id === id && ['completed', 'cancelled', 'failed'].includes(r.state)));
  const prompt = material => event('prompt', row => row.material === material);
  const promptCount = () => rows().filter(row => row.event === 'prompt').length;
  const submit = (material, key) => access.send(worker, material, undefined, key);
  const fail = async (taskId, state, message) => {
    const result = await terminal(taskId);
    assert.equal(result.state, state, result.error);
    assert.equal(result.delivery, undefined);
    if (message) assert.match(result.error, message);
  };
  const run = async material => {
    const value = await submit(material);
    return { ...value, wire: await prompt(material) };
  };

  await assert.rejects(submit('not authorized to send'), /not authorized/);
  await request('/api/projects', { action: 'antigravity-review', id: project, enabled: true }, 400);
  await request('/api/projects', { action: 'edit', id: project, name: 'Worker fixture', antigravityReviewEnabled: true });
  assert.equal(hub.antigravityReviewPolicy(project).enabled, false);
  assert.equal(promptCount(), 0);
  const host = coordinator.get(owner).hostAccess;
  const tools = new Map();
  let approve = () => { throw Error('Unexpected creation approval'); };
  activateProjectManagement({ list: () => ['ashub:catalog', 'ashub:execute'], agent: {
    registerTool: tool => tools.set(tool.name, tool), registerInstruction() {},
  }, call: (name, args) => name === 'ashub:catalog' ? host.catalog(args.signal) : host.execute(args.request, approve, args.signal) });
  const workerTool = tools.get('project_management_create_worker');
  assert(workerTool, 'project management must expose the worker creation tool');
  const args = { requestKey: 'create-review-fixture', title: 'Plugin reviewer', projectId: project, backend: 'google-antigravity' };
  const discovered = async () => (await host.catalog()).projectSessionBackends.find(backend => backend.id === args.backend);
  assert.equal((await discovered()).authorized, false);
  const rejected = await workerTool.execute(args);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content, /not authorized/);
  const beforeCreate = (await request('/sessions')).length;
  hub.antigravityReviewPolicy(project, true);
  assert.equal((await discovered()).authorized, true);
  approve = () => false;
  const denied = await workerTool.execute(args);
  assert.equal(JSON.parse(denied.content).status, 'denied');
  assert.equal((await request('/sessions')).length, beforeCreate);
  approve = () => {
    hub.antigravityReviewPolicy(project, false);
    hub.antigravityReviewPolicy(project, true);
    return true;
  };
  const expired = await workerTool.execute({ ...args, requestKey: 'revoked-review-fixture' });
  assert.equal(expired.isError, true);
  assert.match(expired.content, /authorization changed/);
  assert.equal((await request('/sessions')).length, beforeCreate);
  approve = preview => {
    assert(preview.items[0].fields.some(field => field.value === 'inline-review'));
    return true;
  };
  const added = await workerTool.execute(args);
  assert.equal(added.isError, false, added.content);
  const created = JSON.parse(added.content).results[0];
  assert.equal(created.kind, 'antigravity');
  assert.equal(created.projectTaskProfile, 'inline-review');
  const member = (await request('/sessions')).find(s => s.instanceId === created.instanceId);
  assert.equal(member.projectId, project);
  assert.equal(member.title, args.title);
  assert.equal(member.projectWorker, true);
  assert.equal(member.projectTaskProfile, 'inline-review');
  assert.equal(promptCount(), 0, 'creation must not dispatch a prompt');
  approve = () => { throw Error('Must reuse the existing receipt'); };
  assert.deepEqual(JSON.parse((await workerTool.execute(args)).content).results[0], created);
  assert.equal((await request('/sessions')).length, beforeCreate + 1);
  // Exercise task dispatch, delivery and cold restore on the plugin-created member.
  worker = created.instanceId;
  await checkTaskProfile();
  assert.equal((await request('/api/projects')).find(p => p.id === project).antigravityReviewEnabled, true);
  assert.equal((await request('/api/projects')).find(p => p.id === project).antigravityReviewGrant, undefined);
  const holdOpen = path.join(dir, 'hold-session-new');
  await fsp.writeFile(holdOpen, '');
  const revoked = await submit('revoked before ACP prompt');
  await event('waiting for session/new');
  hub.antigravityReviewPolicy(project, false);
  hub.antigravityReviewPolicy(project, true);
  await fsp.unlink(holdOpen);
  await fail(revoked.taskId, 'failed', /not authorized/);
  assert.equal(promptCount(), 0, 'a new grant never revives a prior dispatch');

  const exact = 'Synthetic café 🧪\nReview token: bogus\n<plain text>';
  const first = await submit(exact, 'worker-fixture-once');
  const retry = await access.send(worker, exact, undefined, 'worker-fixture-once');
  assert.equal(retry.taskId, first.taskId);
  assert.equal(retry.reused, true);
  const firstWire = await prompt(exact);
  assert.deepEqual((await terminal(first.taskId)).delivery, delivery);

  // Use the actual scoped host and publisher RPC path with the real task receipt.
  const { SharedConversations } = await import('../dist/extensions/shared-conversations.js');
  const { DevicePublisher } = await import('../examples/extensions/multi-machine/publisher.mjs');
  const sharing = new SharedConversations(path.join(dir, 'remote-review-grants.json'), 'agy-project-test');
  sharing.start(hub.server.address().port);
  const sharingOwner = new AbortController();
  t.after(() => sharingOwner.abort());
  const sharingId = sharing.approve('fixture', sharing.prepare('fixture', { roots: [cwd] }));
  const channel = sharing.bind('fixture', sharingOwner.signal).open(sharingId);
  const publisher = new DevicePublisher({ dataDir: dir, access: true, gateway: 'https://example.invalid/' });
  publisher.config = { roots: channel.roots };
  publisher.access = channel;
  const remoteTasks = args => publisher.execute('project-tasks', { projectId: project, ...args });
  assert.deepEqual(await remoteTasks({}), [], 'legacy callers should not see task-only members');
  const shared = await remoteTasks({ includeReviews: true });
  assert.deepEqual(shared.find(entry => entry.id === first.taskId), {
    id: first.taskId, sourceId: owner, recipientId: worker, taskProfile: 'inline-review', state: 'completed',
  });
  assert.deepEqual(await remoteTasks({ includeReviews: true, taskId: first.taskId }), {
    taskProfile: 'inline-review', state: 'completed', terminal: true,
    review: { summary: delivery.summary, unresolved: [] },
  });
  assert.deepEqual(await remoteTasks({ includeReviews: true, taskId: revoked.taskId }), {
    taskProfile: 'inline-review', state: 'failed', terminal: true,
  });
  assert.deepEqual((await publisher.execute('sessions', {})).map(s => s.instanceId), [owner]);
  assert.deepEqual((await publisher.execute('project-groups', {}))[0].sessionIds, [owner]);
  channel.close();
  const otherRoot = path.join(dir, 'not-shared-project');
  await fsp.mkdir(otherRoot);
  const narrowId = sharing.approve('fixture', sharing.prepare('fixture', { roots: [otherRoot] }));
  const narrowChannel = sharing.bind('fixture', sharingOwner.signal).open(narrowId);
  publisher.access = narrowChannel;
  publisher.config = { roots: narrowChannel.roots };
  await assert.rejects(remoteTasks({ includeReviews: true }), /项目未授权/);
  narrowChannel.close();

  const launch = rows().find(row => row.event === 'launch' && row.pid === firstWire.pid);
  assert.deepEqual(launch.args, ['acp', '--sandbox', '--include-default-customizations=false']);
  assert.equal(launch.token, false);
  assert.notEqual(launch.cwd, cwd);
  assert.deepEqual(await fsp.readdir(launch.cwd), []);
  for (const privateText of [first.taskId, cwd, owner]) assert(!firstWire.text.includes(privateText));
  assert.equal(promptCount(), 1);

  for (const material of ['malformed', 'reply then late text', 'old token', 'not normal', 'oversized']) {
    const { taskId } = await run(material);
    await fail(taskId, 'failed', /structured review|normally|size limit/);
  }
  const permission = await run('permission request');
  assert.deepEqual((await event('permission')).result, { outcome: { outcome: 'cancelled' } });
  assert.deepEqual((await terminal(permission.taskId)).delivery, delivery);
  const blocked = await run('blocked');
  const blockedResult = (await terminal(blocked.taskId)).delivery;
  assert.match(blockedResult.summary, /Review blocked/);
  assert.deepEqual(blockedResult.unresolved, [delivery.summary]);
  const holding = await run('hold');
  await assert.rejects(access.send(worker, 'while running'), /idle|in progress/);
  await request(`/${worker}/cancel`, {});
  await fail(holding.taskId, 'cancelled');
  assert.equal(rows().filter(r => r.event === 'cancel' && r.sessionId === holding.wire.sessionId).length, 1);

  const membership = await run('revoke membership');
  await request('/api/projects', { action: 'members', id: project, remove: [worker] });
  await assert.rejects(access.send(worker, 'out of project'), /conversation|project/i);
  await fsp.writeFile(path.join(dir, 'revoke'), '');
  await until('no longer processing', async () => !(await request('/sessions')).find(s => s.instanceId === worker)?.isProcessing);
  await request('/api/projects', { action: 'members', id: project, add: [worker] });
  await fail(membership.taskId, 'failed', /no longer active|outside this project/);

  const disconnected = await run('disconnect after text');
  await fail(disconnected.taskId, 'failed');
  const recovery = await run('normal recovery');
  assert.notEqual(recovery.wire.pid, disconnected.wire.pid);
  assert.deepEqual((await terminal(recovery.taskId)).delivery, delivery);
  const ignoringCancel = await run('ignore cancel');
  await request(`/${worker}/cancel`, {});
  await request(`/${worker}/cancel`, {});
  await fail(ignoringCancel.taskId, 'cancelled');
  assert.equal(rows().filter(r => r.event === 'cancel' && r.sessionId === ignoringCancel.wire.sessionId).length, 1);
  const afterCancel = await run('after unacknowledged cancel');
  assert.notEqual(afterCancel.wire.pid, ignoringCancel.wire.pid, 'an unresponsive CLI is replaced, without replaying its previous task');
  assert.deepEqual((await terminal(afterCancel.taskId)).delivery, delivery);
  await hub.shutdown();
  coordinator.clear();
  await start();
  assert.deepEqual((await terminal(first.taskId)).delivery, delivery, 'receipt survives restart');
  assert.equal(hub.antigravityReviewPolicy(project).enabled, true, 'project authorization survives restart');
  const { instanceId: otherOwner } = await request('/sessions', { cwd });
  const otherProject = (await request('/api/projects', { action: 'create', name: 'Unrelated project', cwd, add: [otherOwner] })).find(p => p.name === 'Unrelated project');
  const { instanceId: otherWorker } = await request('/api/projects/session', { projectId: otherProject.id, backend: 'google-antigravity' });
  const otherAccess = coordinator.get(otherOwner).conversationAccess;
  const beforeOther = promptCount();
  await assert.rejects(otherAccess.send(worker, 'unrelated project'), /outside this project/);
  await assert.rejects(otherAccess.send(otherWorker, 'must not borrow the other project grant'), /not authorized/);
  assert.equal(hub.antigravityReviewPolicy(otherProject.id).enabled, false);
  assert.equal(promptCount(), beforeOther);
  await request(`/${owner}/context`);
  await checkTaskProfile();
  access = coordinator.get(owner).conversationAccess;
  const restored = await run('after restart');
  assert.deepEqual((await terminal(restored.taskId)).delivery, delivery);
  const sessions = rows().filter(row => row.event === 'session/new');
  assert(sessions.every(row => row.mcpServers.length === 0));
  assert.equal(new Set(sessions.map(row => row.sessionId)).size, sessions.length);
  assert(!rows().some(row => row.event === 'session/load'), 'review must never restore remote task context');
});
