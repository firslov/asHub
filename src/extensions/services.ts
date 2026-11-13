import type { SharedConversations } from './shared-conversations.js';
import type { BackendConnections } from './backends.js';
import type { CollaborationTasks } from '../collaboration.js';
import type { ExtensionMessages } from '../services/extension-messages.js';
import type { HostCapabilities, HostSnapshot } from '../services/host-contract.js';
import type { HostInvalidation } from '../services/host-events.js';
import type { PluginActivities } from '../services/plugin-activities.js';
import type { PluginBackground } from './background.js';
import type { ConversationEntries } from './conversation-entries.js';
import type { PluginInteractions } from './interactions.js';

export interface ApplicationHostService {
  capabilities(): HostCapabilities;
  snapshot(): HostSnapshot;
  subscribe(listener: (event: HostInvalidation) => void): () => void;
}

export interface ApplicationCollaborationService {
  /** Metadata for work originating in this conversation, limited to its project. */
  snapshot(owner: string): ReturnType<CollaborationTasks['snapshot']>;
  subscribe(listener: () => void): () => void;
}

/** Application-scoped service contract. Bound services retain their own plugin
 * identity, lifecycle and authorization checks; these types add no authority.
 * Optional properties describe explicit injection, not a capability grant or
 * an implicit current conversation. Keep this module type-only at runtime. */
export interface ApplicationExtensionServices {
  readonly dataDirectory: string;
  readonly sharedConversations?: ReturnType<SharedConversations['bind']>;
  readonly backends?: ReturnType<BackendConnections['bind']>;
  readonly host?: Readonly<ApplicationHostService>;
  readonly activities?: Readonly<ReturnType<PluginActivities['bind']>>;
  readonly collaboration?: Readonly<ApplicationCollaborationService>;
  readonly conversations?: ReturnType<ConversationEntries['bind']>;
  readonly background?: ReturnType<PluginBackground['bind']>;
  readonly messages?: ReturnType<ExtensionMessages['bind']>;
  readonly interactions?: ReturnType<PluginInteractions['bind']>;
}
