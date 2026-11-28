import { t } from './i18n.js';
import { registerPanel } from './panel-manager.js';

const app = document.querySelector('.app');
const panel = document.getElementById('archive-panel');
const toggle = document.getElementById('archive-toggle');
const close = document.getElementById('archive-close');
const refresh = document.getElementById('archive-refresh');
const filter = document.getElementById('archive-filter');
const list = document.getElementById('archive-list');
const status = document.getElementById('archive-status');
const search = document.getElementById('archive-search');
const body = document.getElementById('archive-body');
const back = document.getElementById('archive-back');
const preview = document.getElementById('archive-preview');
const previewTitle = document.getElementById('archive-preview-title');
const previewStatus = document.getElementById('archive-preview-status');
const messages = document.getElementById('archive-messages');
let historyItem = null, historyRead = null, historyNotice = '', listScroll = 0;

let snapshot = [];
let loaded = false, loadError = false;
let readController, readSeq = 0;
let composing = false;
const restoring = new Set();
const restoreErrors = new Set();
const rows = new Map();
const isOpen = () => !panel.hidden;
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase();

function create(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function createRow(id) {
  const element = create('li', 'archive-row');
  element.dataset.sessionId = id;
  const link = create('button', 'archive-history');
  link.type = 'button';
  link.addEventListener('click', () => openHistory(id));
  const title = create('span', 'archive-title');
  const meta = create('span', 'archive-meta');
  const cwd = create('span', 'archive-cwd');
  const date = create('time', 'archive-date');
  meta.append(cwd, date);
  link.append(title, meta);
  const restore = create('button', 'p-btn archive-restore');
  restore.type = 'button';
  restore.addEventListener('click', () => void restoreSession(id));
  const error = create('p', 'archive-row-error');
  error.setAttribute('role', 'status');
  error.id = `archive-restore-error-${id}`;
  element.append(link, restore, error);
  return { element, link, title, cwd, date, restore, error };
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function render() {
  const query = normalize(filter.value).trim();
  const remaining = new Set(snapshot.map(item => item.id));
  let focusTarget;
  for (const [id, row] of rows) {
    if (remaining.has(id)) continue;
    // A local or another window's restore can remove the focused row.
    // Leave focus alone if the reader is already elsewhere.
    const focused = document.activeElement;
    if (focused === row.link || focused === row.restore) {
      focusTarget = nextRowControl(row, remaining, focused === row.restore ? 'restore' : 'link');
    }
    row.element.remove();
    rows.delete(id);
    restoreErrors.delete(id);
  }
  let cursor = list.firstElementChild;
  let visible = 0;
  for (const item of snapshot) {
    const { id } = item;
    let row = rows.get(id);
    if (!row) { row = createRow(id); rows.set(id, row); }
    if (row.element !== cursor) list.insertBefore(row.element, cursor);
    cursor = row.element.nextElementSibling;
    const title = item.title || t('untitled');
    const cwd = item.cwd || '';
    row.element.hidden = !!query && !normalize(title).includes(query) && !normalize(cwd).includes(query);
    if (!row.element.hidden) ++visible;
    setText(row.title, title);
    setText(row.cwd, cwd);
    row.cwd.title = cwd;
    row.cwd.hidden = !cwd;
    const time = new Date(Number(item.startedAt || item.archivedAt || 0));
    row.date.hidden = !(time.getTime() > 0);
    if (!row.date.hidden) {
      row.date.dateTime = time.toISOString();
      setText(row.date, time.toLocaleDateString(document.documentElement.lang || undefined));
    }

    const pending = restoring.has(id);
    const caption = t(pending ? 'archive.restoring' : 'archive.restore');
    setText(row.restore, caption);
    row.restore.setAttribute('aria-label', `${caption}: ${title}`);
    // Native disabled would discard keyboard focus during the request.
    if (pending) row.restore.setAttribute('aria-disabled', 'true');
    else row.restore.removeAttribute('aria-disabled');
    const failed = restoreErrors.has(id);
    row.error.hidden = !failed;
    setText(row.error, failed ? t('archive.restoreFailed') : '');
    if (failed) row.restore.setAttribute('aria-describedby', row.error.id);
    else row.restore.removeAttribute('aria-describedby');
  }
  const notice = loadError ? 'archive.loadFailed'
    : !loaded && readController ? 'archive.loading'
    : loaded && !visible ? (query && snapshot.length ? 'archive.noMatch' : 'archive.empty')
    : '';
  status.hidden = !notice;
  setText(status, notice ? t(notice) : '');
  if (focusTarget && !historyItem) {
    (focusTarget.closest('[hidden]') ? filter : focusTarget).focus();
  }
}

function cancelRead() {
  ++readSeq;
  readController?.abort();
  readController = null;
}

async function readArchive() {
  if (!isOpen()) return;
  cancelRead();
  const seq = readSeq, controller = new AbortController();
  readController = controller;
  const current = () => isOpen() && seq === readSeq;
  loadError = false;
  render();
  try {
    const response = await fetch('/api/sessions/archived', { signal: controller.signal });
    if (!response.ok) throw new Error('Archive load failed');
    const items = await response.json();
    if (!current()) return;
    if (!Array.isArray(items)) throw new Error('Invalid archive response');
    const unique = new Set();
    snapshot = items.filter(item => {
      // Same ID contract as the Hub's session routes; never make arbitrary URLs navigable.
      if (typeof item?.id !== 'string' || !/^[0-9a-f]{4,32}$/i.test(item.id) || unique.has(item.id)) return false;
      unique.add(item.id);
      return true;
    });
    loaded = true;
  } catch {
    if (current()) loadError = true;
  } finally {
    if (current()) { readController = null; render(); }
  }
}

function nextRowControl(row, remaining, control) {
  for (const direction of ['nextElementSibling', 'previousElementSibling']) {
    for (let other = row.element[direction]; other; other = other[direction]) {
      const id = other.dataset.sessionId;
      if (other.hidden || !remaining.has(id) || restoring.has(id)) continue;
      const candidate = rows.get(id)?.[control];
      if (candidate) return candidate;
    }
  }
  return filter;
}

async function restoreSession(id) {
  const row = rows.get(id);
  if (!isOpen() || !row || row.element.hidden || restoring.has(id)) return;
  restoring.add(id);
  restoreErrors.delete(id);
  render();
  try {
    const response = await fetch('/api/sessions/unarchive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) throw new Error('Archive restore failed');
  } catch {
    restoring.delete(id);
    if (snapshot.some(item => item.id === id)) restoreErrors.add(id);
    if (isOpen()) render();
    return;
  }
  snapshot = snapshot.filter(item => item.id !== id);
  restoreErrors.delete(id);
  if (isOpen()) render();
  restoring.delete(id);
  // The normal list and this drawer both re-read on this event. Starting the
  // new GET invalidates any GET that captured the archive before the POST.
  document.dispatchEvent(new CustomEvent('ash:sessions-changed'));
}

function setHistoryNotice(key = '') {
  historyNotice = key;
  previewStatus.hidden = !key;
  setText(previewStatus, key ? t(key) : '');
}

function renderMessages(items) {
  let start = items.length;
  const earlier = create('button', 'p-btn archive-earlier');
  earlier.type = 'button';
  const thread = create('div', 'archive-thread');
  const prepend = (focus = false) => {
    const next = Math.max(0, start - 60);
    const batch = document.createDocumentFragment();
    for (const {role, text} of items.slice(next, start)) {
      const message = create('article', 'archive-message');
      const label = create('h3', 'archive-message-role');
      label.dataset.archiveLabel = role === 'user' ? 'archive.historyUser' : 'archive.historyAssistant';
      setText(label, t(label.dataset.archiveLabel));
      const content = create('div', 'archive-message-content');
      setText(content, text);
      // Archived text is inert: format Markdown without loading remote content,
      // allowing inline HTML controls, or following links out of the drawer.
      if (role === 'assistant' && window.marked?.parse && window.DOMPurify?.sanitize) {
        try {
          content.innerHTML = DOMPurify.sanitize(marked.parse(text), {
            ALLOWED_TAGS: ['p','br','em','strong','del','ol','ul','li','pre','code','blockquote','hr',
              'h1','h2','h3','h4','h5','h6','table','thead','tbody','tr','th','td'], ALLOWED_ATTR: [],
          });
          content.classList.add('archive-markdown');
        } catch { /* Keep the plain-text version. */ }
      }
      message.append(label, content);
      batch.append(message);
    }
    thread.prepend(batch);
    start = next;
    if (focus) {
      const message = /** @type {HTMLElement} */ (thread.firstElementChild);
      message.tabIndex = -1;
      message.focus();
    }
    earlier.hidden = start === 0;
  };
  earlier.dataset.archiveLabel = 'archive.historyEarlier';
  setText(earlier, t(earlier.dataset.archiveLabel));
  earlier.addEventListener('click', () => prepend(true));
  messages.replaceChildren(earlier, thread);
  prepend();
}

async function readHistory() {
  historyRead?.abort();
  const requested = historyItem;
  const controller = new AbortController();
  historyRead = controller;
  const current = () => !controller.signal.aborted && historyItem === requested && isOpen();
  messages.replaceChildren();
  setHistoryNotice('archive.historyLoading');
  try {
    const response = await fetch(`/api/sessions/archived/${requested.id}/history`, { signal: controller.signal });
    if (!response.ok) throw new Error('Archive history unavailable');
    const data = await response.json();
    if (!current()) return;
    if (!Array.isArray(data.messages) || !data.messages.every(item =>
      (item?.role === 'user' || item?.role === 'assistant') && typeof item.text === 'string')) throw new Error('Invalid history');
    if (data.messages.length) { renderMessages(data.messages); setHistoryNotice(); }
    else setHistoryNotice('archive.historyEmpty');
  } catch {
    if (current()) setHistoryNotice('archive.historyFailed');
  } finally {
    if (historyRead === controller) historyRead = null;
  }
}

function openHistory(id) {
  const item = snapshot.find(item => item.id === id);
  if (!isOpen() || historyItem || !item) return;
  historyItem = item;
  listScroll = body.scrollTop;
  search.hidden = body.hidden = true;
  back.hidden = preview.hidden = false;
  setText(previewTitle, item.title || t('untitled'));
  preview.scrollTop = 0;
  back.focus();
  void readHistory();
}

function exitHistory(restoreFocus = false) {
  if (!historyItem) return;
  const { id } = historyItem;
  historyItem = null;
  historyRead?.abort();
  historyRead = null;
  back.hidden = preview.hidden = true;
  search.hidden = body.hidden = false;
  messages.replaceChildren();
  setHistoryNotice();
  body.scrollTop = listScroll;
  if (restoreFocus) {
    const row = rows.get(id);
    (row && !row.element.hidden ? row.link : filter).focus({ preventScroll: true });
  }
}

if (panel && toggle && close && refresh && filter && list && status && search && body && back && preview && previewTitle && previewStatus && messages) {
  function setOpen(open) {
    panel.hidden = !open;
    app?.classList.toggle('archive-open', open);
    toggle.classList.toggle('active', open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) void readArchive();
    else { cancelRead(); exitHistory(); composing = false; }
  }

  registerPanel('archive', { toggleBtnId: 'archive-toggle', panelId: 'archive-panel',
    open: () => setOpen(true), close: () => setOpen(false) });
  close.addEventListener('click', () => { setOpen(false); toggle.focus(); });
  back.addEventListener('click', () => exitHistory(true));
  panel.addEventListener('keydown', event => {
    if (!historyItem || event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    exitHistory(true);
  });
  refresh.addEventListener('click', () => void (historyItem ? readHistory() : readArchive()));
  filter.addEventListener('input', () => { if (isOpen()) render(); });
  filter.addEventListener('compositionstart', () => { composing = true; });
  filter.addEventListener('compositionend', () => { composing = false; });
  filter.addEventListener('keydown', event => {
    if (event.key === 'Escape' && (composing || event.isComposing || event.keyCode === 229)) event.stopPropagation();
  });
  document.addEventListener('langchange', () => {
    if (!isOpen()) return;
    render();
    if (!historyItem) return;
    setText(previewTitle, historyItem.title || t('untitled'));
    setHistoryNotice(historyNotice);
    for (const label of messages.querySelectorAll('[data-archive-label]')) {
      setText(label, t(label.getAttribute('data-archive-label')));
    }
  });
  document.addEventListener('ash:sessions-changed', () => void readArchive());
  document.addEventListener('ash:host-state-changed', event => {
    const domains = event.detail?.domains;
    if (!Array.isArray(domains) || domains.includes('sessions')) void readArchive();
  });
}
