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
const paths = {
  edit: '<path d="m13 4 3 3M4 16l3-.6L17 5a2.1 2.1 0 0 0-3-3L3.6 13z"/>',
  withdraw: '<path d="m6 6 8 8M14 6l-8 8"/>',
  promote: '<path d="M5 4h10M10 16V7m-4 4 4-4 4 4"/>',
};
function action(name, run) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'queue-action';
  button.dataset.action = name; button.title = t('queue.' + name); button.setAttribute('aria-label', button.title);
  button.innerHTML = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  button.addEventListener('click', run); return button;
}
export function removeQueued(box) {
  const prev = box.previousElementSibling; box.remove();
  if (prev?.classList.contains('turn-sep')) prev.remove();
}
function error(box, message) {
  let node = box.querySelector('.queue-error');
  if (!node) { node = document.createElement('div'); node.className = 'queue-error'; node.setAttribute('role', 'status'); box.append(node); }
  node.textContent = message;
}
export function updateQueuedBox(box, item) {
  if (!box.classList.contains('pending') || Number(box.dataset.revision || 0) > (item.revision ?? 0)) return;
  box._queryText = item.query ?? ''; box.dataset.queued = box._queryText;
  const text = box.querySelector('.q-text'); if (text) { text.textContent = box._queryText; text.title = box._queryText; }
  attachQueueEdit(box, box.dataset.queueSession, item.queueId || item.id, item.delivery, item.revision);
}
async function mutate(box, actionName, query, revision) {
  if (box._queueBusy || !box.classList.contains('pending')) return false;
  const id = box.dataset.queueId, sid = box.dataset.queueSession;
  const payload = actionName === 'withdraw' ? { id } : { id, action: actionName, query, revision: revision ?? Number(box.dataset.revision || 0) };
  const fingerprint = JSON.stringify(payload);
  if (box._queueRequest?.fingerprint !== fingerprint) box._queueRequest = { fingerprint, requestId: crypto.randomUUID() };
  box._queueBusy = true; box.querySelector('.queue-error')?.remove();
  const editor = box.querySelector('.queue-editor textarea'); if (editor) editor.readOnly = true;
  for (const button of box.querySelectorAll('.queue-action, .queue-editor button')) button.disabled = true;
  try {
    const response = await fetch(`/${sid}/queue/${actionName === 'withdraw' ? 'withdraw' : 'update'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, requestId: box._queueRequest.requestId }),
    });
    if (!response.ok) {
      if (response.status < 500) box._queueRequest = null;
      throw Error(t(response.status === 409 ? 'queue.changed' : 'queue.failed'));
    }
    const item = await response.json(); box._queueRequest = null;
    // A consumed message may now be a normal conversation bubble. Never change it.
    if (box.classList.contains('pending') && box.dataset.queueId === id) {
      if (actionName === 'withdraw') removeQueued(box);
      else updateQueuedBox(box, item);
    }
    return true;
  } catch (e) { if (box.classList.contains('pending')) error(box, e.message || t('queue.failed')); return false; }
  finally {
    box._queueBusy = false; if (editor) editor.readOnly = false;
    for (const button of box.querySelectorAll('.queue-action, .queue-editor button')) button.disabled = false;
    const promote = box.querySelector('[data-action="promote"]'); if (promote) promote.disabled = box.dataset.delivery === 'steer' || !!box.querySelector('.queue-editor');
  }
}
function edit(box) {
  if (box._queueBusy) return;
  if (box.querySelector('.queue-editor')) { box.querySelector('textarea')?.focus(); return; }
  const revision = Number(box.dataset.revision || 0);
  const form = document.createElement('form'); form.className = 'queue-editor';
  const input = document.createElement('textarea'); input.value = box._queryText ?? box.dataset.queued ?? '';
  input.rows = 3; input.setAttribute('aria-label', t('queue.edit')); input.maxLength = 1000000;
  const actions = document.createElement('div'); actions.className = 'queue-editor-actions';
  const hint = document.createElement('span'); hint.textContent = t('queue.position');
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = t('projects.cancel');
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = t('projects.save');
  const close = () => { form.remove(); box.classList.remove('queue-editing'); const promote = box.querySelector('[data-action="promote"]'); if (promote) promote.disabled = box.dataset.delivery === 'steer' || !!box._queueBusy; box.querySelector('[data-action="edit"]')?.focus(); };
  cancel.onclick = close;
  form.onsubmit = async e => { e.preventDefault(); if (await mutate(box, 'edit', input.value, revision)) close(); };
  form.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (e.isComposing) return;
    e.preventDefault();
    if (!box._queueBusy) close();
  });
  input.onkeydown = e => {
    if (e.isComposing || box._queueBusy) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
  };
  actions.append(hint, cancel, save); form.append(input, actions); box.append(form); box.classList.add('queue-editing'); box.querySelector('[data-action="promote"]').disabled = true; input.focus();
}
export function attachQueueEdit(box, sessionId, queueId, delivery, revision = 0) {
  if (!queueId) return;
  box.dataset.queueId = queueId; box.dataset.queueSession = sessionId;
  box.dataset.delivery = delivery || 'queue'; box.dataset.revision = String(revision);
  box.dataset.queueHeading = t('queue.heading');
  let status = box.querySelector('.queue-status');
  if (!status) { status = document.createElement('span'); status.className = 'queue-status'; box.append(status); }
  const imageCount = box.querySelectorAll('.agent-box-img').length;
  status.textContent = t(delivery === 'steer' ? 'delivery.pending' : 'delivery.queued') + (imageCount ? ' · ' + t('queue.images', {n:imageCount}) : '');
  if (!box.querySelector('.queue-actions')) {
    const actions = document.createElement('div'); actions.className = 'queue-actions';
    actions.append(action('edit', () => edit(box)), action('withdraw', () => void mutate(box, 'withdraw')), action('promote', () => void mutate(box, 'promote')));
    box.append(actions);
  }
  const promote = box.querySelector('[data-action="promote"]'); promote.disabled = !!box._queueBusy || delivery === 'steer' || !!box.querySelector('.queue-editor');
  promote.title = t(delivery === 'steer' ? 'queue.promoted' : 'queue.promote');
}
