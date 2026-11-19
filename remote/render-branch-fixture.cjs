// Actual Hub frames from a desktop rewind while a remote client is connected.
// The synthetic bridge and temporary history never touch user sessions.
const { env, Res, req, Bridge, assert } = require('../tests/harness.cjs');
(async () => {
  const e = env(), sessions = new Map();
  const hub = e.load('src/hub.ts', 'export const audit={createSession,rewindToTurn,shutdownHub};').audit;
  try {
    const session = await hub.createSession(sessions, { makeBridge: opts => new Bridge(opts) }, e.dir);
    session.bridge.messages = Array.from({ length: 30 }, (_, i) => [
      { role: 'user', content: `Question ${i}` },
      { role: 'assistant', content: `Answer ${i}` },
    ]).flat();
    await session.capture.flush();
    const entryId = session.store.buildBranchWithIds().entryIds[58];
    const stream = new Res(), response = new Res();
    session.sseClients.add(stream);
    await hub.rewindToTurn(req({ entryId }), response, session);
    assert(response.statusCode === 200, 'rewind must succeed');
    const frames = stream.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    assert(frames[0].meta.name === 'hub:branch-switched', 'rewind must start a new replay');
    assert(frames.at(-1).meta.name === 'hub:replay-done', 'rewind must complete the replay');
    assert(frames.filter(f => f.meta.name === 'agent:query').length === 29, 'rewind must preserve earlier turns');
    console.log('BRANCH ' + JSON.stringify(frames));
  } finally { await hub.shutdownHub(undefined, sessions); }
})().catch(error => { console.error(error); process.exitCode = 1; });
