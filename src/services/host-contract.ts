import type { Project } from '../projects.js';
import type { ApplicationExtensionRegistry } from '../extensions/application.js';
import type { HostVersion } from './host-events.js';
import type { SessionService } from './session-service.js';

export const HOST_OPERATION_TYPES = ['project.create', 'conversation.create', 'conversation.update', 'conversation.detach', 'conversation.archive', 'conversation.delete'] as const;
export type HostOperationType = typeof HOST_OPERATION_TYPES[number];
export interface ConversationConfiguration {
  title?: string;
  model?: string;
  provider?: string;
  thinking?: string;
  proxyEnabled?: boolean | null;
}
export type HostPlanOperation =
  | { type: 'project.create'; input: { name: string; cwd: string; members?: string[] } }
  | { type: 'conversation.create'; input: ConversationConfiguration & { title: string; projectId?: string | null; cwd?: string; instructions?: string } }
  | { type: 'conversation.update'; input: ConversationConfiguration & { id: string } }
  | { type: 'conversation.detach' | 'conversation.archive' | 'conversation.delete'; input: { id: string } };
export interface HostPlan { idempotencyKey: string; operations: HostPlanOperation[] }

export interface HostSnapshot extends HostVersion {
  version: 1;
  sessions: ReturnType<SessionService['list']>;
  projects: Project[];
  extensions: ReturnType<ApplicationExtensionRegistry['snapshot']>;
}
export interface HostCapabilities {
  version: 1;
  hostApi: 1;
  queries: readonly ['capabilities', 'snapshot'];
  operations: readonly HostOperationType[];
  events: { transport: 'sse'; path: '/api/host/events'; mode: 'invalidation'; reconnect: 'refetch-snapshot' };
  approval: 'source-bound-explicit';
  receipts: 'durable-partial-results';
}
