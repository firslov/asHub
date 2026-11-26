import type { CollaborationPresentation } from '../services/collaboration-presentation.js';
import { stripContextWrappers } from './summarize.js';

/** Read the small metadata envelope without parsing a potentially multi-megabyte
 * tool result/image. Noncanonical legacy frames retain the general JSON path. */
export function replayEventName(frame: string): string {
  const firstLine = frame.startsWith('data: ');
  const marker = firstLine ? 0 : frame.indexOf('\ndata: ');
  if (marker < 0) return '';
  const start = marker + (firstLine ? 6 : 7);
  const name = (meta: unknown) => {
    const value = (meta as { name?: unknown } | null)?.name;
    return typeof value === 'string' ? value : '';
  };
  const end = frame.indexOf('\n', start);
  const lineEnd = end < 0 ? frame.length : end;
  if (frame[lineEnd - 1] === '}' && frame.startsWith('{"meta":{', start)) {
    let depth = 0, quoted = false, escaped = false;
    const metaStart = start + 8;
    for (let i = metaStart; i < Math.min(frame.length, metaStart + 4096); i++) {
      const c = frame[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return name(JSON.parse(frame.slice(metaStart, i + 1))); }
        catch { break; }
      }
    }
  }
  try { return name(JSON.parse(frame.slice(start, end < 0 ? undefined : end)).meta); }
  catch { return ''; }
}

/** Recover presentation only for a uniquely addressed entry in recorded host
 * replay. Message content alone never supplies a sender or task identity. */
export function collaborationReplayState(frames: string[]) {
  const marked = new Map<string, { query: string; collaboration: CollaborationPresentation; bound: boolean }>();
  if (!frames.some(frame => frame.includes('"collaboration":'))) return marked;
  const claimed = new Set<string>();
  const unboundQueries = new Set<string>();
  for (const frame of frames) {
    if (replayEventName(frame) !== 'agent:query') continue;
    try {
      const payload = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? 'null')?.payload;
      if (payload?.command === true || typeof payload?.query !== 'string') continue;
      if (typeof payload.entryId !== 'string' || !payload.entryId) {
        unboundQueries.add(stripContextWrappers(payload.query).trim());
        continue;
      }
      const id = payload.entryId;
      if (claimed.has(id)) marked.delete(id);
      else if (payload.collaboration && typeof payload.collaboration === 'object')
        marked.set(id, { query: payload.query, collaboration: payload.collaboration, bound: payload.collaborationEntryId === id });
      claimed.add(id);
    } catch { /* Unreadable replay frames cannot identify authored messages. */ }
  }
  // The live rewind tagger pairs identical queries by order. If a matching
  // frame never reached the kernel, the surviving entry could belong to
  // either turn. Never carry authenticated presentation through that guess.
  for (const [id, item] of marked) {
    if (!item.bound && unboundQueries.has(stripContextWrappers(item.query).trim())) marked.delete(id);
  }
  return marked;
}

interface SubagentReplayOutcome {
  subagentOutcome: true;
  cancelled?: true;
  degraded?: 'budget' | 'iterations' | null;
  error?: string;
}

type InterruptedSubagent = { subagentId?: string; toolCallId?: string; task?: string };
type InterruptedSwarm = { swarmId: string; done: number; failed: number };
const childPresets = new Set(['plan', 'explore', 'review', 'research', 'implement', 'subagent_resume']);

/** A cold bridge owns no previous running children or continuation state.
 * Keep completed outcomes while removing expired handles, then settle the
 * children/launchers that were still active when their old bridge ended. */
export function recoverSubagentReplay(frames: string[]): { children: InterruptedSubagent[]; swarms: InterruptedSwarm[] } {
  const children = new Map<string, InterruptedSubagent>();
  const swarms = new Map<string, InterruptedSwarm>();
  const queued = new Map<string, InterruptedSubagent>();
  const launchOwners = new Map<string, string>();
  for (const [index, frame] of frames.entries()) {
    const name = replayEventName(frame);
    if (name !== 'subagent:started' && name !== 'subagent:done' && !name.startsWith('subagent:swarm-') && name !== 'agent:tool-started' &&
        !(name === 'agent:tool-completed' && queued.size)) continue;
    try {
      const event = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? 'null');
      const p = event?.payload;
      if (!p || typeof p !== 'object') continue;
      if (typeof p.swarmId === 'string' && name.startsWith('subagent:swarm-')) {
        if (name === 'subagent:swarm-started') swarms.set(p.swarmId, { swarmId: p.swarmId, done: 0, failed: 0 });
        else if (name === 'subagent:swarm-done') swarms.delete(p.swarmId);
        else if (name === 'subagent:swarm-progress') {
          const swarm = swarms.get(p.swarmId);
          if (swarm && Number.isSafeInteger(p.done) && p.done >= 0 && Number.isSafeInteger(p.failed) && p.failed >= 0) {
            swarm.done = p.done;
            swarm.failed = p.failed;
          }
        }
        continue;
      }
      const subagentId = typeof p.subagentId === 'string' && p.subagentId ? p.subagentId : undefined;
      const toolCallId = typeof p.toolCallId === 'string' && p.toolCallId ? p.toolCallId : undefined;
      const task = typeof p.task === 'string' ? p.task : undefined;
      if (name === 'subagent:started' && subagentId) {
        if (toolCallId) {
          queued.delete(toolCallId);
          launchOwners.set(toolCallId, subagentId);
        }
        children.set(subagentId, { subagentId, toolCallId, task });
      } else if (name === 'subagent:done') {
        if (subagentId) {
          children.delete(subagentId);
          if (toolCallId && launchOwners.get(toolCallId) === subagentId) launchOwners.delete(toolCallId);
        } else if (toolCallId) queued.delete(toolCallId);
        if (subagentId && p.cancelled !== true && !p.error && p.resumable !== false) {
          p.resumable = false;
          frames[index] = frame.replace(/^data: .+$/m, () => 'data: ' + JSON.stringify(event));
        }
      } else if (toolCallId && name === 'agent:tool-started') {
        launchOwners.delete(toolCallId);
        queued.delete(toolCallId);
        if (childPresets.has(p.name)) queued.set(toolCallId, {
          toolCallId, task: typeof p.rawInput?.task === 'string' ? p.rawInput.task : undefined,
        });
      } else if (toolCallId && name === 'agent:tool-completed') queued.delete(toolCallId);
    } catch { /* An unreadable event cannot identify an interrupted child. */ }
  }
  const interrupted = [...children.values()].map(item => {
    if (item.toolCallId && launchOwners.get(item.toolCallId) !== item.subagentId) return { subagentId: item.subagentId, task: item.task };
    return item;
  });
  return { children: [...interrupted, ...queued.values()], swarms: [...swarms.values()] };
}

const toolKey = (entryId: string, callId: string) => JSON.stringify([entryId, callId]);

/** A branch rebuild can reuse a child only when the original launch and
 * the retained tool call both belong to the same user entry. */
export function subagentReplayState(frames: string[]) {
  const toolStarts = new Map<string, { entryId?: string; name?: string; task?: string; linked?: boolean; ambiguousQueue: boolean }>();
  const launches = new Map<string, { callId: string; entryId: string; terminal?: boolean }>();
  const running = new Map<string, { name: string; payload: { subagentId: string; toolCallId: string; task: string; type?: string } }>();
  const seen = new Set<string>(), ambiguous = new Set<string>();
  const saved = new Map<string, SubagentReplayOutcome>();
  let entryId: string | undefined;
  for (const frame of frames) {
    const name = replayEventName(frame);
    if (name !== 'agent:query' && name !== 'agent:tool-started' && name !== 'subagent:started' && name !== 'subagent:done' &&
        !(name === 'agent:tool-completed' && frame.includes('"subagentOutcome":true'))) continue;
    try {
      const p = JSON.parse(frame.match(/^data: (.+)$/m)?.[1] ?? 'null')?.payload;
      if (!p || typeof p !== 'object') continue;
      if (name === 'agent:query') {
        if (p.command !== true) entryId = typeof p.entryId === 'string' ? p.entryId : undefined;
        continue;
      }
      if (typeof p.toolCallId !== 'string') continue;
      const callId = p.toolCallId;
      if (name === 'agent:tool-started') {
        const previous = toolStarts.get(callId);
        toolStarts.set(callId, {
          entryId, ambiguousQueue: !!previous && !previous.linked,
          ...(childPresets.has(p.name) && typeof p.rawInput?.task === 'string' ? { name: p.name, task: p.rawInput.task } : {}),
        });
        if (entryId) {
          const key = toolKey(entryId, callId);
          if (seen.has(key)) { ambiguous.add(key); saved.delete(key); }
          seen.add(key);
        }
        continue;
      }
      const start = toolStarts.get(callId);
      if (name === 'subagent:started') {
        const owner = start ? start.entryId : entryId;
        if (owner && typeof p.subagentId === 'string' && !launches.has(p.subagentId) && !start?.linked) {
          launches.set(p.subagentId, { callId, entryId: owner });
          if (start) start.linked = true;
          if (start?.name && start.task !== undefined && start.task === p.task) {
            running.set(toolKey(owner, callId), { name: start.name, payload: {
              subagentId: p.subagentId, toolCallId: callId, task: start.task,
              ...(typeof p.type === 'string' ? { type: p.type } : {}),
            } });
          }
        }
        continue;
      }
      let owner: string | undefined;
      if (name === 'subagent:done') {
        const launch = launches.get(p.subagentId);
        if (launch && launch.callId === callId && !launch.terminal) {
          launch.terminal = true;
          owner = launch.entryId;
          running.delete(toolKey(owner, callId));
        }
        // A queued preset can be stopped after its launch tool starts but
        // before the child exists. Keep it attached to that original tool.
        else if (!p.subagentId && p.cancelled === true && start && !start.linked && !start.ambiguousQueue) {
          owner = start.entryId;
          start.linked = true;
        }
      } else if (p.subagentOutcome === true) {
        owner = entryId;
        if (start?.entryId === owner && start) start.linked = true;
      }
      if (!owner) continue;
      const key = toolKey(owner, callId);
      if (ambiguous.has(key)) continue;
      saved.set(key, {
        subagentOutcome: true,
        ...(p.cancelled === true ? { cancelled: true } : {}),
        ...(p.degraded === 'budget' || p.degraded === 'iterations' || p.degraded === null ? { degraded: p.degraded } : {}),
        ...(typeof p.error === 'string' ? { error: p.error } : {}),
      });
    } catch { /* An unreadable frame cannot establish a terminal status. */ }
  }
  return {
    outcome: (userEntry: string, callId: string) => saved.get(toolKey(userEntry, callId)),
    active(userEntry: string, callId: string, name: string | undefined, task: unknown) {
      const key = toolKey(userEntry, callId);
      if (ambiguous.has(key)) return undefined;
      const child = running.get(key);
      if (child && child.name === name && child.payload.task === task) return child.payload;
      return undefined;
    },
  };
}
