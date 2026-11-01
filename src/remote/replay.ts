import { unicodeSlice } from '../unicode.js';

const diagnostic = (name: string) => name.startsWith('agent:tool-') || name.startsWith('subagent:')
  || name === 'agent:thinking' || name === 'agent:thinking-chunk';
function dataOf(frame: string): any {
  try { return JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? 'null'); } catch { return null; }
}
/** Select whole tasks; commands and steering continue the current lifecycle. */
export function mobileReplayStart(frames: string[], turns = 12): number {
  let found = 0;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (!frames[i]!.includes('"agent:query"')) continue;
    const data = dataOf(frames[i]!);
    if (data?.meta?.name === 'agent:query' && !data.payload?.command && !data.payload?.steering && ++found === turns) return i;
  }
  return 0;
}
/** Only diagnostics are previewed. Answers, errors, permissions and files retain
 * their full content. The client offers an explicit full-history stream. */
export function mobileReplayFrame(frame: string): string {
  const data = dataOf(frame);
  if (!data || !diagnostic(data.meta?.name || '') || JSON.stringify(data.payload ?? {}).length <= 1600) return frame;
  const p = data.payload || {};
  data.payload = {
    name: p.name, title: p.title, toolName: p.toolName, toolCallId: p.toolCallId,
    subagentId: p.subagentId, swarmId: p.swarmId,
    // Identity and result semantics must survive previewing. Limit only the
    // error's detail; dropping it would turn a failed call into an ended one.
    success: p.success, isError: p.isError, exitCode: p.exitCode,
    error: typeof p.error === 'string' ? unicodeSlice(p.error, 0, 240) : p.error ? true : p.error,
    degraded: p.degraded, tokensUsed: p.tokensUsed, kind: p.kind,
    task: typeof p.task === 'string' ? unicodeSlice(p.task, 0, 160) : undefined,
    detailsOmitted: true,
    text: unicodeSlice(JSON.stringify(p), 0, 1200) + '\n…（完整记录可在完整历史中查看）',
  };
  return frame.replace(/^data: .+$/m, () => 'data: ' + JSON.stringify(data));
}
