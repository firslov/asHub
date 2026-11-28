import type { ProjectWorkerBackend } from '../integrations.js';
import type { ProjectStore } from '../projects.js';

/** A backend can require consent, but only the host can issue or look up a grant. */
export function projectWorkerGrant(projects: ProjectStore, projectId: string, backend: ProjectWorkerBackend): string | undefined {
  if (backend.authorization !== 'project' || backend.taskProfile !== 'inline-review') return;
  return projects.projectWorkerGrant(projectId, backend.id);
}

/** Bind an operation to the grant at admission. Re-enabling must not revive it. */
export function bindProjectWorkerGrant(projects: ProjectStore, projectId: string, backend: ProjectWorkerBackend): () => void {
  const grant = projectWorkerGrant(projects, projectId, backend);
  const validate = () => {
    if (!grant || projectWorkerGrant(projects, projectId, backend) !== grant) {
      throw new Error(`${backend.label} is not authorized for this project or its authorization changed. Check Manage project on the desktop.`);
    }
  };
  validate();
  return validate;
}
