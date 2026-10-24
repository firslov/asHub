/** Only terminal failures count as errors; intermediate tool retries do not. */
export function projectSessionStatus(session) {
  if (session.waitingApproval) return 'approval';
  if (session.isProcessing) return 'running';
  if (session.lastTurnError) return 'failed';
  if (session.hasUnread) return 'unread';
  if (session.queuedCount > 0) return 'queued';
  return 'idle';
}
export function sharesActiveWorkspace(session, sessions, workspaces = {}) {
  if (!session.isProcessing || !session.cwd) return false;
  const root = workspaces[session.cwd]?.root || session.cwd;
  return sessions.some(other => other.instanceId !== session.instanceId && other.isProcessing
    && (workspaces[other.cwd]?.root || other.cwd) === root);
}
