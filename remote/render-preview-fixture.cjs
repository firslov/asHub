// Reconnect to a short, rewound conversation with a previewed tool result.
const { env, Res, req, Bridge, assert } = require('../tests/harness.cjs');
const { EventEmitter } = require('node:events');
(async () => {
  const e = env(), sessions = new Map();
  const hub = e.load('src/hub.ts', 'export const audit={createSession,rewindToTurn,openSseMulti,shutdownHub};').audit;
  try {
    const session = await hub.createSession(sessions, { makeBridge: opts => new Bridge(opts) }, e.dir);
    session.bridge.messages = [
      { role: 'user', content: 'Inspect the report' },
      { role: 'assistant', content: 'Reading the file', tool_calls: [{ id: 'read', function: { name: 'read_file', arguments: '{"path":"report.txt"}' } }] },
      { role: 'tool', tool_call_id: 'read', content: 'Report detail '.repeat(400) + 'END_OF_FULL_RESULT' },
      { role: 'assistant', content: 'The report is ready' },
      { role: 'user', content: 'Discard this turn' },
      { role: 'assistant', content: 'Discard this answer' },
    ];
    await session.capture.flush();
    const entryId = session.store.buildBranchWithIds().entryIds[4], response = new Res();
    await hub.rewindToTurn(req({ entryId }), response, session);
    assert(response.statusCode === 200, 'rewind must succeed');
    const replay = async mobile => {
      const request = Object.assign(new EventEmitter(), { headers: {} }), stream = new Res();
      await hub.openSseMulti(request, stream, sessions, session.id + ':all', '', mobile);
      request.emit('close');
      return stream.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    };
    const preview = await replay(true), full = await replay(false);
    assert(preview.findIndex(f => f.meta.name === 'hub:history-window') < preview.findIndex(f => f.meta.name === 'hub:branch-switched'), 'preview notice precedes persisted branch reset');
    assert(preview.some(f => f.payload?.detailsOmitted), 'tool output must use the mobile preview');
    assert(full.some(f => f.payload?.rawOutput?.endsWith('END_OF_FULL_RESULT')), 'full replay must retain the complete result');
    console.log('PREVIEW ' + JSON.stringify({ preview, full }));
  } finally { await hub.shutdownHub(undefined, sessions); }
})().catch(error => { console.error(error); process.exitCode = 1; });
