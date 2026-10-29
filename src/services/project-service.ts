import * as path from 'node:path';
import * as fs from 'node:fs';
import { ProjectStore, type Project } from '../projects.js';
import type { HostEvents } from './host-events.js';
import type { Session } from './session-types.js';

interface ProjectRuntime {
  sessions: Map<string, Session>;
  events: HostEvents;
  deleteSession(id: string): Promise<void>;
  expandHome(value: string): string;
}

/** Core owns membership independently from optional workflow/UI plugins. All
 * project writes publish only after the existing atomic store commit succeeds. */
export class ProjectService extends ProjectStore {
  private deleting = false;
  constructor(file: string, private runtime: ProjectRuntime) { super(file); }
  isDeleting = () => this.deleting;
  override update(input: unknown, canAdd: (id: string) => boolean) {
    const result = super.update(input, canAdd);
    this.runtime.events.publish('projects');
    return result;
  }
  assertAvailable(): void {
    if (this.deleting) throw new Error('Project deletion in progress; retry shortly');
  }
  /** Direct, user-initiated HTTP command. Model/plugin callers use the explicit
   * operation gateway rather than supplying their own approval identity. */
  async change(raw: unknown) {
    this.assertAvailable();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid project request');
    const input = { ...raw } as Record<string, any>;
    const { sessions } = this.runtime;
    const affected = this.list().find(p => p.id === input.id)?.sessionIds ?? [];
    if ([...affected, ...(Array.isArray(input.add) ? input.add : [])].some(id => sessions.get(id)?._hostOperation)) throw new Error('Conversation operation in progress');
    if ((input.action === 'create' || input.action === 'edit') && typeof input.cwd === 'string') input.cwd = this.runtime.expandHome(input.cwd.trim());
    if (input.action === 'delete' && input.deleteConversations !== undefined && typeof input.deleteConversations !== 'boolean') throw new Error('Invalid deleteConversations option');
    if (input.action === 'delete' && input.deleteConversations === true) {
      const project = this.list().find(p => p.id === input.id);
      if (!project) throw new Error('Project no longer exists');
      this.deleting = true;
      try {
        for (const id of project.sessionIds) await this.runtime.deleteSession(id);
        return { projects: this.update(input, () => false), deletedSessionIds: project.sessionIds };
      } finally { this.deleting = false; }
    }
    return this.update(input, id => {
      const s = sessions.get(id); return !!s && s.kind === 'agent' && !s._closed && !s._closing;
    });
  }
  /** Common invariant for project conversation creation from UI and plugins. */
  directory(projectId: string, requested?: unknown): string {
    this.assertAvailable();
    const project = this.list().find(p => p.id === projectId);
    if (!project) throw new Error('Project no longer exists');
    return projectWorkingDirectory(project, requested, this.runtime.expandHome);
  }
}

/** One root rule shared by direct creation and explicitly approved plugins. */
export function projectWorkingDirectory(project: Project, requested: unknown, expandHome: (value: string) => string): string {
    if (!project.cwd) throw new Error('Set the project root directory in Manage project before creating a conversation');
    const cwd = project.cwd;
    if (requested !== undefined && (typeof requested !== 'string' || !path.isAbsolute(expandHome(requested.trim())) || path.relative(cwd, expandHome(requested.trim())) !== '')) throw new Error('New project conversations must use the project root directory');
    if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error('Choose an existing absolute working directory');
    return cwd;
}
