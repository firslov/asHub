// Real Hub protocol with a synthetic bridge: a desktop command during a turn,
// followed by main completion while an async collaborator still needs approval.
const { env, Bridge, assert, path, root, fs } = require('../tests/harness.cjs');
const { once } = require('node:events');
(async () => {
  const e = env(); e.clock(Date.now());
  let bridge, proceed, decision;
  const gate = new Promise(resolve => { proceed = resolve; });
  class TestBridge extends Bridge {
    constructor(opts) { super(opts); bridge = this; }
    emitFrame(name, payload) { this.emit('event', { name, payload }); }
    async submit() {
      this.emitFrame('subagent:started', { subagentId: 'background', task: 'Review in the background' });
      this.emitFrame('agent:tool-started', { toolCallId: 'background-tool-1', name: 'write_file' });
      this.emitFrame('permission:request', { requestId: 'background-approval', expiresAt: Date.now() + 60000, title: 'Save review notes' });
      this.emitFrame('agent:tool-started', { toolCallId: 'main-read', name: 'read_file' });
      await gate;
      this.emitFrame('agent:tool-completed', { toolCallId: 'main-read', success: true });
      this.emitFrame('agent:response-chunk', { blocks: [{ type: 'text', text: 'The background review continues.' }] });
      return { stopReason: 'done' };
    }
    execCommand() { this.emitFrame('ui:info', { message: 'Current thinking level: high' }); }
    decidePermission(requestId, outcome) { decision = { requestId, outcome }; }
  }
  const hub = e.hub().startHub({ host: '127.0.0.1', port: 0, webRoot: path.join(root, 'web'), makeBridge: o => new TestBridge(o) });
  await once(hub.server, 'listening'); const base = `http://127.0.0.1:${hub.server.address().port}`;
  let reader;
  const parse = text => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  async function readTo(marker) {
    let text = '';
    while (!text.includes(marker)) { const next = await reader.read(); if (next.done) break; text += Buffer.from(next.value).toString(); }
    assert(text.includes(marker), 'missing ' + marker); return parse(text);
  }
  try {
    const sid = (await (await fetch(base + '/sessions', { method: 'POST', body: JSON.stringify({ cwd: e.dir }) })).json()).instanceId;
    const events = base + `/events?subs=${sid}:all&view=mobile`;
    reader = (await fetch(events, { signal: AbortSignal.timeout(10000) })).body.getReader();
    await readTo('hub:replay-done');
    await fetch(base + `/${sid}/submit`, { method: 'POST', body: JSON.stringify({ query: 'Review' }) });
    const live = await readTo('main-read');
    const command = await fetch(base + `/${sid}/command`, { method: 'POST', body: JSON.stringify({ name: '/think' }) });
    assert(command.ok, 'desktop commands must be accepted during a turn');
    live.push(...await readTo('Current thinking level: high'));
    proceed();
    const completion = await readTo('agent:processing-done');
    await reader.cancel();
    reader = (await fetch(events, { signal: AbortSignal.timeout(10000) })).body.getReader();
    const replay = await readTo('hub:replay-done');
    const approval = replay.find(frame => frame.meta.name === 'permission:request');
    assert(approval?.payload.pending === true, 'the async approval remains authoritative after main completion');
    const accepted = await fetch(base + '/api/permission/decide', { method: 'POST', body: JSON.stringify({ sessionId: sid, requestId: 'background-approval', outcome: 'approved' }) });
    assert(accepted.ok && decision?.outcome === 'approved', 'the completed main turn must not invalidate a background decision');
    const resolved = await readTo('permission:resolved');
    bridge.emitFrame('agent:tool-completed', { toolCallId: 'background-tool-1', success: true });
    bridge.emitFrame('subagent:done', { subagentId: 'background', result: 'Saved' });
    resolved.push(...await readTo('subagent:done'));
    console.log('LIFECYCLE ' + JSON.stringify({ live, completion, replay, resolved }));
  } finally { proceed(); await reader?.cancel(); await hub.shutdown(); fs.rmSync(e.dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
