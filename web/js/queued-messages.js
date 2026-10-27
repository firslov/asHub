import { t } from './i18n.js';
// Exact IDs distinguish identical messages; only unacknowledged optimistic boxes
// may fall back to text. Old replay frames have no IDs and remain readable.
export function findQueued(root, payload, optimistic = true) {
  const boxes = [...(root?.querySelectorAll('.agent-box.pending') ?? [])];
  if (payload?.queueId) {
    const exact = boxes.find(b => b.dataset.queueId === payload.queueId);
    if (exact || !optimistic) return exact;
    return boxes.find(b => !b.dataset.queueId && (b._queryText ?? b.dataset.queued) === (payload.query ?? ''));
  }
  return boxes.find(b => (b._queryText ?? b.dataset.queued) === (payload?.query ?? ''));
}
export function attachQueueEdit(box, sessionId, queueId) {
  if (!queueId) return;
  box.dataset.queueId = queueId;
  if (box.querySelector('.queue-edit')) return;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'queue-edit';
  button.textContent = t('queue.edit');
  button.addEventListener('click', () => document.dispatchEvent(new CustomEvent('ash:queue-edit', { detail: { sessionId, queueId, button } })));
  box.append(button);
}
