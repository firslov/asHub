// One contract corpus for full/preview transport and desktop/mobile consumers.
// These outcomes describe an individual execution, never the whole user task.
module.exports = [
  { name: 'nonzero exit', payload: { exitCode: 1 }, outcome: 'failed' },
  { name: 'explicit success false', payload: { success: false }, outcome: 'failed' },
  { name: 'explicit error flag', payload: { isError: true }, outcome: 'failed' },
  { name: 'timeout message', payload: { error: 'timeout after 20min' }, outcome: 'failed' },
  { name: 'structured error', payload: { error: { message: 'Connection closed' } }, outcome: 'failed' },
  { name: 'error overrides zero exit', payload: { exitCode: 0, success: true, error: 'Incomplete stream' }, outcome: 'failed' },
  { name: 'token budget', payload: { degraded: 'budget', tokensUsed: 1234 }, outcome: 'partial' },
  { name: 'iteration limit', payload: { degraded: 'iterations' }, outcome: 'partial' },
  { name: 'failure overrides partial', payload: { degraded: 'budget', error: 'timeout' }, outcome: 'failed' },
  { name: 'successful execution', payload: { exitCode: 0, success: true }, outcome: 'ended' },
  { name: 'unspecified result', payload: {}, outcome: 'ended' },
  { name: 'explicit false error', payload: { error: false, isError: false }, outcome: 'ended' },
];
