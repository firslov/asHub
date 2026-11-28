'use strict';

function createProjectReviewPolicy({ trusted, owner, policy }) {
  return (event, id, enabled) => {
    if (!trusted(event)) throw new Error('Untrusted desktop sender');
    if (typeof id !== 'string' || !id || id.length > 128 || (enabled !== undefined && typeof enabled !== 'boolean')) {
      throw new Error('Invalid project review settings');
    }
    const current = policy();
    if (enabled === undefined) return current(id);
    const win = owner(event);
    if (!win || win.isDestroyed()) throw new Error('Project review settings require an active desktop window');
    if (!enabled) return current(id, false);
    // The explicit project button is the consent action. Apply it in this IPC
    // turn; there is no pending native prompt that could outlive the project.
    const state = current(id);
    if (state.enabled) return state;
    if (!state.available) throw new Error('Google Antigravity project reviews are unavailable');
    return current(id, true);
  };
}

module.exports = { createProjectReviewPolicy };
