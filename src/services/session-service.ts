import * as path from 'node:path';
import type { Project, ProjectStore } from '../projects.js';
import { readNetworkPolicy, writeNetworkPolicy } from '../network-policy.js';
import type { Session } from './session-types.js';
import { HostEvents } from './host-events.js';

export interface SessionSetup { instructions?: string; model?: string; provider?: string; proxyEnabled?: boolean | null }
interface SessionServiceOptions {
  events?: HostEvents;
  busy(session: Session): boolean;
  thinking(session: Session): unknown;
  writeNetworkPolicy?: typeof writeNetworkPolicy;
}

class SessionRegistry extends Map<string, Session> {
  constructor(private changed: (id: string) => void) { super(); }
  override set(id: string, session: Session): this {
    const previous = this.get(id);
    if (previous && previous !== session) previous._onHostChange = undefined;
    session._onHostChange = () => { if (this.get(id) === session) this.changed(id); };
    super.set(id, session);
    this.changed(id);
    return this;
  }
  override delete(id: string): boolean {
    const session = this.get(id);
    const removed = super.delete(id);
    if (removed) { if (session) session._onHostChange = undefined; this.changed(id); }
    return removed;
  }
  override clear(): void {
    for (const session of this.values()) session._onHostChange = undefined;
    const populated = this.size > 0;
    super.clear();
    if (populated) this.changed('');
  }
}

/** Owns the live conversation registry and public read models. Kernel/runtime
 * adapters retain responsibility for history, context locks and bridge teardown. */
export class SessionService {
  readonly events: HostEvents;
  readonly sessions: Map<string, Session>;
  constructor(private options: SessionServiceOptions) {
    this.events = options.events ?? new HostEvents();
    this.sessions = new SessionRegistry(id => this.events.publish('sessions', id));
  }
  /** Shared commit port for host operations and the legacy settings route.
   * Failed persistence must not announce a network change. */
  readonly writeNetworkPolicy: typeof writeNetworkPolicy = (...args) => {
    const policy = (this.options.writeNetworkPolicy ?? writeNetworkPolicy)(...args);
    this.events.publish('network', args[1]);
    return policy;
  };
  readonly describe = (s: Session, groups: Project[] = [], network = readNetworkPolicy()) => ({
    id: s.id, title: s.title, cwd: s.cwd, provider: s.provider, model: s.model,
    thinking: this.options.thinking(s), proxyEnabled: network.sessions[s.id] ?? null,
    projectId: groups.find(p => p.sessionIds.includes(s.id))?.id ?? null,
    busy: this.options.busy(s) || !!s._hostOperation,
  });
  list(projects: Pick<ProjectStore, 'list'>, sessions = this.sessions) {
    const groups = projects.list();
    const membership = new Map(groups.flatMap(p => p.sessionIds.map(id => [id, p.id] as const)));
    const directories = new Map(groups.map(p => [p.id, p.cwd] as const));
    return [...sessions.values()]
      .sort((a, b) => (b.lastModified ?? b.startedAt ?? 0) - (a.lastModified ?? a.startedAt ?? 0))
      .map(s => ({ instanceId: s.id, projectId: membership.get(s.id) ?? null,
        projectExternal: !!directories.get(membership.get(s.id) ?? '') && path.relative(directories.get(membership.get(s.id) ?? '')!, s.cwd) !== '',
        title: s.title, kind: s.kind, model: s.model, provider: s.provider,
        thinkingLevel: this.options.thinking(s), cwd: s.cwd,
        readOnlyContext: s.bridge?.readOnlyContext ?? (s.backendId === 'ash' ? false : !!s.backendState),
        supportsCwdChange: !!s.bridge?.supportsCwdChange, startedAt: s.startedAt,
        lastModified: s.lastModified, isProcessing: s.isProcessing, hasUnread: s.hasUnread,
        waitingApproval: [...(s.pendingPermissions?.values() ?? [])].some(p => p.expiresAt > Date.now()),
        queuedCount: s.queuedQueries?.length ?? 0, lastTurnError: !!s.lastTurnError,
      }));
  }
}
