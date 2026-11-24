import { AsyncLocalStorage } from 'node:async_hooks';
const childExecution = new AsyncLocalStorage<boolean>();
export const isChildExecution = () => childExecution.getStore() === true;
/** Supported extension hooks; no asHub bridge changes or process-global patches. */
export function isolateDesktopTools(ctx: any, owns: (tool: any) => boolean): void {
  for (const name of ['subagent:run', 'subagent:resume', 'tool:agentswarm']) {
    ctx.advise(name, (next: (...args: any[]) => any, ...args: any[]) => childExecution.run(true, () => next(...args)));
  }
  // Subscribe after this activation registers its tool contributions.
  ctx.bus.onPipe('agent:tools', (payload: { tools: any[] }) => {
    if (isChildExecution()) payload.tools = payload.tools.filter(tool => !owns(tool));
    return payload;
  });
}
