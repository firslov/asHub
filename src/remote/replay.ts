import { unicodeSlice } from '../unicode.js';

const diagnostic = (name: string) => name.startsWith('agent:tool-') || name.startsWith('subagent:')
  || name === 'agent:thinking' || name === 'agent:thinking-chunk';
function dataOf(frame: string): any {
  try { return JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? 'null'); } catch { return null; }
}
/** Select whole turns; never begin halfway through tool calls or approvals. */
export function mobileReplayStart(frames: string[], turns = 12): number {
  let found = 0;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (!frames[i]!.includes('"agent:query"')) continue;
    const data = dataOf(frames[i]!);
    if (data?.meta?.name === 'agent:query' && !data.payload?.command && ++found === turns) return i;
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
    success: p.success, detailsOmitted: true,
    text: unicodeSlice(JSON.stringify(p), 0, 1200) + '\n…（完整记录可在完整历史中查看）',
  };
  return frame.replace(/^data: .+$/m, () => 'data: ' + JSON.stringify(data));
}
