import { lang, t } from './i18n.js';

const textKey = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();
const pathKey = value => textKey(value).replaceAll('\\', '/');
const pathTail = value => String(value ?? '').split(/[/\\]/).filter(Boolean).slice(-2).join('/');
const compareId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const dateFor = value => new Date(Number.isFinite(value) ? value : 0);

export function findSidebarItems(projects, sessions, value, translate = t, locale = lang.peek()) {
  const query = pathKey(value);
  if (!query) return { projects: [], sessions: [] };
  const byId = new Map(projects.map(p => [p.id, p]));
  const membership = new Map();
  const titleCounts = new Map(), directoryCounts = new Map();
  for (const p of projects) for (const id of p.sessionIds ?? []) membership.set(id, p.id);
  const candidates = [];
  function add(type, id, title, cwd, context, projectId, timestamp = 0, projectCwd = '') {
    const key = textKey(title);
    const groupKey = `${type}\0${key}\0${textKey(context)}`;
    const dirKey = `${groupKey}\0${textKey(pathTail(cwd))}`;
    const titleKey = `${type}\0${key}`;
    titleCounts.set(titleKey, (titleCounts.get(titleKey) ?? 0) + 1);
    directoryCounts.set(dirKey, (directoryCounts.get(dirKey) ?? 0) + 1);
    const rank = key === query ? 0 : key.startsWith(query) ? 1 : key.includes(query) ? 2
      : pathKey(cwd).includes(query) ? 3
      : (projectId && (textKey(context).includes(query) || pathKey(projectCwd).includes(query))) ? 4 : -1;
    if (rank < 0) return;
    candidates.push({ type, id, title, cwd, context, projectId, rank, titleKey, dirKey, timestamp });
  }
  for (const p of projects) add('project', p.id, p.name, p.cwd, '');
  for (const s of sessions) {
    if (!['agent', 'antigravity'].includes(s.kind ?? 'agent')) continue;
    const projectId = membership.get(s.instanceId) ?? (byId.has(s.projectId) ? null : s.projectId);
    const p = byId.get(projectId);
    const origin = p?.name ?? (projectId ? translate('sidebar.find.unknownProject') : translate('sidebar.find.independent'));
    add('session', s.instanceId, s.title && s.title !== s.instanceId ? s.title : translate('untitled'),
      s.cwd, origin, projectId, s.lastModified ?? s.startedAt ?? 0, p?.cwd);
  }
  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });
  const order = (a, b) => a.rank - b.rank || b.timestamp - a.timestamp || a.title.localeCompare(b.title, locale) || compareId(a, b);
  const hits = { projects: [], sessions: [] };
  for (const x of candidates.sort(order)) {
    const duplicate = titleCounts.get(x.titleKey) > 1;
    const sameTail = directoryCounts.get(x.dirKey) > 1;
    const date = dateFor(x.timestamp);
    const path = duplicate && sameTail ? x.cwd : pathTail(x.cwd);
    const meta = [x.context, (duplicate || x.rank === 3) && path].filter(Boolean);
    if (duplicate && sameTail) {
      if (x.timestamp && Number.isFinite(+date)) meta.push(formatter.format(date));
      meta.push(x.id.slice(-8));
    }
    hits[x.type === 'project' ? 'projects' : 'sessions'].push({ ...x, detail: meta.join(' · ') });
  }
  return hits;
}

export function initUnifiedSidebarSearch({ input, results, onSelect, onDismiss }) {
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  const message = el('p', 'sidebar-search-message');
  message.setAttribute('role', 'status');
  const list = el('div');
  list.id = `${results.id}-options`;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('sidebar.find.label'));
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  results.append(message, list);

  let open = false, composing = false, projects = [], sessions = [];
  let query = '', activeKey = '', signature = '', entries = [];
  const keyOf = hit => `${hit.type}:${hit.id}`;
  function setActive(index, scroll = false) {
    const entry = entries.at(index);
    activeKey = entry ? keyOf(entry.hit) : '';
    if (entry) input.setAttribute('aria-activedescendant', entry.node.id);
    else input.removeAttribute('aria-activedescendant');
    for (const [i, { node }] of entries.entries()) node.setAttribute('aria-selected', String(index === i));
    if (scroll) entry?.node.scrollIntoView({ block: 'nearest' });
  }
  function render() {
    if (!open || composing) return;
    const locale = lang.value;
    const hits = findSidebarItems(projects, sessions, query, t, locale);
    const next = JSON.stringify([query, locale, ...Object.values(hits).map(choices => choices.map(x => [keyOf(x), x.projectId, x.title, x.detail, x.cwd]))]);
    if (next === signature) return;
    signature = next;
    const groups = [];
    entries = [];
    for (const [name, choices] of Object.entries(hits)) {
      if (!choices.length) continue;
      const group = el('div', 'sidebar-search-group');
      const heading = el('div', 'sidebar-search-group-label', t(name === 'projects' ? 'sidebar.find.projects' : 'sidebar.find.conversations'));
      heading.id = `${list.id}-${name}`;
      group.setAttribute('role', 'group');
      group.setAttribute('aria-labelledby', heading.id);
      group.append(heading);
      for (const hit of choices) {
        const option = el('div', 'sidebar-search-option');
        option.id = `${list.id}-${entries.length}`;
        option.setAttribute('role', 'option');
        option.title = [hit.title, hit.detail, hit.cwd].filter(Boolean).join('\n');
        option.append(el('span', 'sidebar-search-title', hit.title));
        if (hit.detail) option.append(el('span', 'sidebar-search-context', hit.detail));
        option.addEventListener('mousedown', event => { if (event.button === 0) event.preventDefault(); });
        option.addEventListener('click', () => { if (open && !composing) onSelect(hit); });
        entries.push({ node: option, hit });
        group.append(option);
      }
      groups.push(group);
    }
    list.replaceChildren(...groups);
    list.hidden = !entries.length;
    list.setAttribute('aria-label', t('sidebar.find.label'));
    message.hidden = !!entries.length;
    message.textContent = entries.length ? '' : t(query.trim() ? 'sidebar.find.noMatch' : 'sidebar.find.hint');
    input.setAttribute('aria-expanded', String(!!entries.length));
    const selected = entries.findIndex(({ hit }) => keyOf(hit) === activeKey);
    setActive(Math.max(0, selected));
  }
  function setQuery(value) {
    if (query !== value) { query = value; activeKey = ''; results.scrollTop = 0; }
    render();
  }
  input.addEventListener('input', () => { if (open && !composing) setQuery(input.value); });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; if (open) setQuery(input.value); });
  input.addEventListener('keydown', event => {
    if (!open || !['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
    // Escape during composition belongs to the IME, not the active conversation.
    event.stopPropagation();
    if (composing || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (event.key === 'Escape') { onDismiss(); return; }
    if (!entries.length) return;
    const i = entries.findIndex(({ hit }) => keyOf(hit) === activeKey);
    if (event.key === 'Enter') { if (i >= 0) onSelect(entries[i].hit); return; }
    const next = Math.max(0, Math.min(entries.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)));
    setActive(next, true);
  });
  input.setAttribute('aria-expanded', 'false');
  return {
    open() { open = true; setQuery(input.value); },
    close() { open = false; composing = false; activeKey = ''; query = ''; signature = ''; entries = []; list.replaceChildren(); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); },
    update(nextProjects, nextSessions) { projects = nextProjects; sessions = nextSessions; render(); },
    setQuery,
  };
}
