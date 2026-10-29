import type { Session } from './session-types.js';

/** Shared postconditions for direct UI commands and explicitly approved plugin
 * operations. Backends cannot silently ignore a requested model or reasoning. */
export async function selectSessionModel(session: Session, model: string, provider: string, check: () => void = () => {}): Promise<void> {
  check();
  if (!session.bridge.execCommand) throw new Error('Backend does not support model selection');
  await session.bridge.execCommand('/model', `${model}@${provider}`);
  check();
  if (session.model !== model || session.provider !== provider) throw new Error('Model selection was not applied');
}

export function selectSessionThinking(session: Session, level: string, check: () => void = () => {}): void {
  check();
  const thinking = session.bridge.getThinking?.();
  if (thinking?.supported && session.bridge.setThinking && (level === 'default' || thinking.levels.includes(level))) {
    session.bridge.setThinking(level);
    check();
    if (level !== 'default' && session.bridge.getThinking?.()?.level !== level) throw new Error('Thinking selection was not applied');
  } else if (level !== 'default') throw new Error('Unsupported thinking level');
}
