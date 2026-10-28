import { networkPolicy, saveNetworkPolicy, loadNetworkPolicy } from "./network-settings.js";
import { thinkingLabel } from "./thinking-control.js";
import { toast } from "./toast.js";
import { projectSessionStatus, sharesActiveWorkspace } from "./project-status.js";
import { allSessions, setSessions } from "./store.js";
import { activeSessionId, spaEnabled, switchTo, closeTab, openTabs, sessions } from "./session-manager.js";
import { effect } from "../vendor/signals-core.js";
import { t } from "./i18n.js";

const root = document.getElementById("projects");
let groups = [], visible = false, loading = false, error = "", generation = 0;
let dialog = null;
let workspaces = {}, pollTimer = null, polling = false, groupPolling = false, workspacePolling = false, rendered = "", statusGeneration = 0;
const collapsed = new Set();
const networkSaving = new Set();
try { for (const id of JSON.parse(localStorage.getItem("ash.project-folded") || "[]")) collapsed.add(id); } catch {}
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const button = (text, fn, cls = "project-button") => { const n = el("button", cls, text); n.type = "button"; n.addEventListener("click", fn); return n; };
const chats = () => allSessions.value.filter(s => s.kind === "agent");
async function request(body) {
  const res = await fetch("/api/projects", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(body ? t("projects.saveFailed") : t("projects.loadFailed"));
  const result = await res.json();
  if (body) document.dispatchEvent(new CustomEvent("ash:sessions-changed"));
  return result;
}
async function refresh() {
  const seq = ++generation;
  loading = true; error = ""; render();
  try { const result = await request(); if (seq === generation) groups = result; }
  catch (e) { if (seq === generation) error = e.message; }
  finally { if (seq === generation) { loading = false; render(); } }
}
export function showProjects(show) {
  if (!root) return;
  root.hidden = !show;
  const changed = visible !== show; visible = show;
  if (show && changed) { void refresh(); void pollStatus(); pollTimer = setInterval(pollStatus, 5000); }
  if (!show && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function render() {
  if (!root || !visible) return;
  // Preserve focus and expanded navigation when a status poll has no changes.
  const signature = JSON.stringify([groups, loading, error, chats(), activeSessionId.value, [...collapsed], workspaces, networkPolicy.value, [...networkSaving], t("projects.title")]);
  if (signature === rendered) return;
  rendered = signature;
  root.replaceChildren();
  const head = el("div", "projects-head sidebar-action");
  const create = button("", () => edit(null), "sidebar-new-btn project-add");
  create.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`;
  create.append(el("span", "", t("projects.new")));
  create.title = t("projects.new");
  create.setAttribute("aria-label", t("projects.new"));
  head.append(create);
  root.append(head);
  if (error) { root.append(el("p", "project-note", error), button(t("projects.retry"), refresh)); return; }
  if (loading) { root.append(el("p", "project-note", t("projects.loading"))); return; }
  if (!groups.length) {
    root.append(el("p", "project-note", t("projects.empty")));
    return;
  }
  const list = chats();
  for (const p of groups) {
    const block = el("section", "project-group");
    const row = el("div", "project-heading");
    const members = list.filter(s => p.sessionIds.includes(s.instanceId));
    const primaryCwd = p.cwd;
    const toggle = button("", () => {
      if (collapsed.has(p.id)) collapsed.delete(p.id); else collapsed.add(p.id);
      try { localStorage.setItem("ash.project-folded", JSON.stringify([...collapsed])); } catch {}
      render(); root.querySelector(`[data-project-id="${p.id}"]`)?.focus();
    }, "project-toggle");
    toggle.dataset.projectId = p.id;
    toggle.setAttribute("aria-expanded", String(!collapsed.has(p.id)));
    toggle.append(el("span", "project-caret", collapsed.has(p.id) ? "›" : "⌄"), el("span", "project-name", p.name), el("span", "project-count", String(members.length)));
    const attention = members.filter(s => ['approval', 'failed'].includes(projectSessionStatus(s))).length;
    const unread = members.filter(s => s.hasUnread).length;
    const running = members.filter(s => s.isProcessing).length;
    const summary = attention ? t("projects.attentionCount", { n: attention }) : unread ? t("projects.unreadCount", { n: unread }) : running ? t("projects.runningCount", { n: running }) : "";
    if (summary) { const badge = el("span", "project-summary" + (attention ? " attention" : ""), summary); toggle.append(badge); }
    const history = button(t("projects.tasks"), () => taskHistory(p), "project-history");
    const createChat = button(t("projects.newChat"), () => newProjectChat(p), "project-history"); createChat.title = t("projects.newChat"); createChat.setAttribute("aria-label", t("projects.newChat"));
    const manage = button("···", () => edit(p), "project-manage"); manage.title = t("projects.manage"); manage.setAttribute("aria-label", t("projects.manage") + ": " + p.name);
    row.append(toggle, manage); block.append(row);
    if (primaryCwd) {
      const path = el('div', 'project-directory', [workspaces[primaryCwd]?.branch, primaryCwd].filter(Boolean).join(' · '));
      path.title = path.textContent; block.append(path);
    }
    const actions = el("div", "project-group-actions"); actions.append(createChat, history); block.append(actions);
    if (!collapsed.has(p.id)) {
      if (!members.length) block.append(button(t("projects.add"), () => edit(p), "project-empty"));
      for (const s of members) {
        const link = el("a", "project-chat" + (s.instanceId === activeSessionId.value ? " current" : ""));
        link.href = `/${s.instanceId}/`; link.title = (s.title || t("untitled")) + "\n" + (s.cwd || "");
        link.addEventListener("click", ev => {
          if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
          if (spaEnabled()) { ev.preventDefault(); switchTo(s.instanceId); }
        });
        const status = projectSessionStatus(s), shared = sharesActiveWorkspace(s, chats(), workspaces);
        const body = el("span", "project-chat-body");
        body.append(el("span", "project-chat-name", s.title || t("untitled")));
        const policy = networkPolicy.value;
        const vpn = policy ? (policy.sessions[s.instanceId] ?? policy.proxyEnabled) : null;
        const location = [s.model || t('projects.defaultModel'), thinkingLabel(s.thinkingLevel || 'default'), vpn === null ? '' : t(vpn ? 'network.on' : 'network.off')].filter(Boolean).join(' · ');
        if (location) { const detail = el("small", "project-chat-location", location); detail.title = location; body.append(detail); }
        if (s.cwd && (s.projectExternal ?? (!!primaryCwd && s.cwd !== primaryCwd))) {
          const directory = el('small', 'project-chat-directory', t('projects.otherDirectory') + ' · ' + (s.cwd.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || s.cwd));
          directory.title = s.cwd; body.append(directory);
        }
        const labels = [status !== 'idle' ? t("projects.status." + status) : "", s.queuedCount > 0 && status !== 'queued' ? t("projects.queueCount", { n: s.queuedCount }) : "", shared ? t("projects.sharedWorkspace") : ""].filter(Boolean);
        if (labels.length) body.append(el("small", "project-chat-status " + status, labels.join(" · ")));
        if (shared) link.title += "\n" + t("projects.sharedWorkspaceHint");
        link.append(el("span", "project-chat-dot " + status), body);
        const chatRow = el('div', 'project-chat-row');
        const remove = button('×', () => deleteProjectChat(s, p), 'project-chat-delete');
        remove.title = t('projects.removeChat'); remove.setAttribute('aria-label', t('projects.removeChat') + ': ' + (s.title || t('untitled')));
        const actions = el('div', 'project-chat-actions');
        const rename = button('', () => renameProjectChat(s), 'project-chat-action');
        rename.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/></svg>';
        rename.title = rename.ariaLabel = t('network.rename');
        const proxy = button('', () => changeProxy(s.instanceId), 'project-chat-action project-chat-proxy');
        proxy.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/>${vpn ? '<path d="m8 12 3 3 5-6"/>' : '<path d="m9 9 6 6m0-6-6 6"/>'}</svg>`;
        proxy.title = proxy.ariaLabel = t(vpn ? 'network.on' : 'network.off') + '\n' + t('network.tabHint');
        proxy.ariaPressed = String(!!vpn); proxy.disabled = !policy || networkSaving.has(s.instanceId);
        proxy.addEventListener('contextmenu', e => { e.preventDefault(); void changeProxy(s.instanceId, true); });
        actions.append(rename, proxy, remove); chatRow.append(link, actions); block.append(chatRow);
      }
    }
    root.append(block);
  }
}
async function changeProxy(id, inherit = false) {
  const policy = networkPolicy.peek(); if (!policy || networkSaving.has(id)) return;
  networkSaving.add(id); render();
  try { await saveNetworkPolicy(inherit ? null : !(policy.sessions[id] ?? policy.proxyEnabled), id); }
  catch (e) { toast(t('network.failed'), { type: 'error', detail: String(e) }); }
  finally { networkSaving.delete(id); render(); }
}
function renameProjectChat(session) {
  const view = projectDialog(t('network.rename')); if (!view) return;
  const field = el('label', 'project-field', t('projects.chatTitle'));
  const input = el('input', 'p-input'); input.value = session.title || ''; input.maxLength = 100; field.append(input);
  const error = el('p', 'project-error'); error.setAttribute('role', 'alert');
  let busy = false;
  const save = button(t('projects.save'), async () => {
    if (busy || !input.value.trim()) return;
    busy = true; input.disabled = save.disabled = view.close.disabled = true; error.textContent = '';
    try {
      await projectApi('/' + session.instanceId + '/title', { title: input.value.trim() });
      ++statusGeneration;
      setSessions(allSessions.value.map(s => s.instanceId === session.instanceId ? { ...s, title: input.value.trim() } : s));
      document.dispatchEvent(new Event('sse:title')); view.node.close();
    } catch (e) { error.textContent = e.message; }
    finally { busy = false; input.disabled = save.disabled = view.close.disabled = false; }
  }, 'project-button primary');
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); save.click(); } });
  view.node.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
  view.content.append(field, error, save); input.focus(); input.select();
}
async function projectApi(route, body) {
  const res = await fetch(route, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!res.ok) {
    let message = t("projects.loadFailed"), instanceId;
    try {
      const data = await res.json(); message = data.error || message;
      if (data.workspace) message += "\n" + data.workspace.root;
      if (typeof data.instanceId === 'string' && /^[0-9a-f]{4,32}$/i.test(data.instanceId)) instanceId = data.instanceId;
    } catch {}
    throw Object.assign(new Error(message), { instanceId });
  }
  return res.json();
}
async function pollStatus() {
  if (!visible || document.hidden) return;
  // Plugins and other clients can change project membership without a local
  // management action. Refresh that snapshot too, without flashing a loader or
  // letting a slow request hold up conversation status updates.
  if (!loading && !groupPolling) {
    groupPolling = true;
    const seq = generation;
    void request().then(result => {
      if (visible && seq === generation) { groups = result; error = ""; render(); }
    }).catch(() => {}).finally(() => { groupPolling = false; });
  }
  // Git discovery may be slow on network drives; never hold up task status.
  if (!workspacePolling) {
    workspacePolling = true;
    void projectApi('/api/projects/workspaces').then(locations => {
      if (visible) { workspaces = locations; render(); }
    }).catch(() => {}).finally(() => { workspacePolling = false; });
  }
  if (polling) return;
  polling = true;
  const seq = statusGeneration;
  try { const sessions = await projectApi('/sessions'); if (visible && seq === statusGeneration) setSessions(sessions); }
  catch { /* Keep the last successful view during a brief disconnect. */ }
  finally { polling = false; }
}
function projectDialog(title) {
  if (dialog) return null;
  const opener = document.activeElement;
  const node = el('dialog', 'project-dialog'); dialog = node;
  const content = el('div', 'project-form');
  const head = el('div', 'project-dialog-head');
  const heading = el('h2', '', title); heading.id = 'project-action-title';
  node.setAttribute('aria-labelledby', heading.id);
  const close = button('×', () => node.close(), 'project-manage'); close.setAttribute('aria-label', t('projects.cancel'));
  head.append(heading, close); content.append(head); node.append(content);
  node.addEventListener('keydown', ev => ev.stopPropagation());
  node.addEventListener('close', () => { node.remove(); if (dialog === node) dialog = null; if (opener?.isConnected) opener.focus(); else document.getElementById('sidebar-view-select')?.focus(); });
  document.body.append(node); node.showModal(); close.focus();
  return { node, content, close };
}
function deleteProjectChat(session, project) {
  const view = projectDialog(t('projects.removeChat')); if (!view) return;
  view.content.append(el('p', 'project-note', session.title || t('untitled')));
  const choices = el('div', 'project-removal-options');
  const descriptions = { keep: 'projects.moveToSessionsHint', archive: 'projects.archiveChatHint', delete: 'projects.deleteChatHint' };
  const labels = { keep: 'projects.moveToSessions', archive: 'projects.archiveChat', delete: 'projects.deletePermanently' };
  let mode = 'keep', busy = false, archived = false;
  const inputs = [];
  const error = el('p', 'project-error'); error.setAttribute('role', 'alert');
  for (const value of ['keep', 'archive', 'delete']) {
    const label = el('label', 'project-removal-option');
    const radio = el('input'); radio.type = 'radio'; radio.name = 'project-chat-removal'; radio.value = value; radio.checked = mode === value;
    const text = el('span', 'project-option-body'); text.append(el('span', '', t(labels[value])), el('small', '', t(descriptions[value])));
    radio.addEventListener('change', () => { if (radio.checked) { mode = value; confirm.textContent = t(labels[mode]); confirm.classList.toggle('danger', mode === 'delete'); } });
    inputs.push(radio); label.append(radio, text); choices.append(label);
  }
  const detach = async () => {
    // Archiving may already have succeeded before a connection failure. Retry
    // only the membership update, and accept an already-removed project/member.
    const current = await projectApi('/api/projects');
    if (current.some(p => p.id === project.id && p.sessionIds.includes(session.instanceId)))
      await request({ action: 'members', id: project.id, remove: [session.instanceId] });
  };
  const confirm = button(t(labels.keep), async () => {
    if (busy) return;
    busy = true; confirm.disabled = view.close.disabled = true; inputs.forEach(n => n.disabled = true); error.textContent = '';
    try {
      if (mode === 'keep') await detach();
      else if (mode === 'archive') {
        if (!archived) { await projectApi('/api/sessions/archive', { id: session.instanceId }); archived = true; }
        await detach();
      } else {
        const response = await fetch(`/${session.instanceId}/`, { method: 'DELETE' });
        if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
      }
      ++statusGeneration;
      if (mode === 'keep') setSessions(allSessions.value.map(s => s.instanceId === session.instanceId && s.projectId === project.id ? { ...s, projectId: null, projectExternal: false } : s));
      else setSessions(allSessions.value.filter(s => s.instanceId !== session.instanceId));
      view.node.close();
      document.dispatchEvent(new CustomEvent('ash:sessions-changed'));
      if (mode !== 'keep') {
        if (!spaEnabled() && activeSessionId.value === session.instanceId) { window.location.href = '/'; return; }
        if (openTabs.peek().includes(session.instanceId)) await closeTab(session.instanceId, { backendClosed: true });
        else if (activeSessionId.value === session.instanceId) { window.location.href = '/'; return; }
        else sessions.get(session.instanceId)?.remove();
      }
      await refresh();
    } catch (e) { error.textContent = e.message; }
    finally { busy = false; confirm.disabled = view.close.disabled = false; inputs.forEach(n => n.disabled = archived); }
  }, 'project-button primary project-chat-confirm');
  view.node.addEventListener('cancel', ev => { if (busy) ev.preventDefault(); });
  view.content.append(choices, error, confirm);
}

function taskHistory(project) {
  const view = projectDialog(t('projects.tasks')); if (!view) return;
  const list = el('div', 'project-task-list');
  let generation = 0;
  const base = '/api/projects/tasks?projectId=' + encodeURIComponent(project.id);
  const load = async () => {
    const seq = ++generation; list.replaceChildren(el('p', 'project-note', t('projects.loading')));
    try {
      const tasks = await projectApi(base);
      if (!view.node.open || seq !== generation) return;
      list.replaceChildren();
      if (!tasks.length) list.append(el('p', 'project-note', t('projects.noTasks')));
      for (const task of tasks) {
        const card = el('details', 'project-task');
        const title = el('summary', '', t('projects.task.' + task.state) + ' · ' + task.message);
        const names = chats();
        const name = id => names.find(s => s.instanceId === id)?.title || id;
        const route = el('p', 'project-note', name(task.sourceId) + ' → ' + name(task.recipientId));
        const result = el('pre', 'project-task-result'), error = el('p', 'project-error'); error.setAttribute('role', 'alert');
        const recipient = el('a', 'project-history', t('projects.openChat')); recipient.href = '/' + task.recipientId + '/';
        const download = el('a', 'project-history', t('projects.fullResult')); download.href = base + '&taskId=' + encodeURIComponent(task.id) + '&download=1';
        let offset = 0, loading = false, loaded = false;
        const more = button(t('projects.moreResult'), async () => {
          if (loading) return; loading = true; more.disabled = true; error.textContent = '';
          try {
            const page = await projectApi(base + '&taskId=' + encodeURIComponent(task.id) + '&offset=' + offset);
            if (!view.node.open || seq !== generation) return;
            result.textContent += page.text; offset = page.nextOffset; loaded = true;
            error.textContent = page.error || '';
            more.hidden = !page.hasMore; if (!result.textContent) result.textContent = t('projects.noResult');
          } catch (e) { error.textContent = e.message; }
          finally { loading = false; more.disabled = false; }
        });
        card.addEventListener('toggle', () => { if (card.open && !loaded) more.click(); });
        card.append(title, route, result, error, more, recipient, download); list.append(card);
      }
    } catch (e) { if (view.node.open && seq === generation) list.replaceChildren(el('p', 'project-error', e.message)); }
  };
  view.content.append(button(t('projects.refresh'), load), list); void load();
}
function newProjectChat(project) {
  if (!project.cwd) { edit(project); return; }
  const projectRoot = project.cwd;
  const view = projectDialog(t('projects.newChat')); if (!view) return;
  view.content.append(el('p', 'project-note', t('projects.newChatHint')));
  const titleField = el('label', 'project-field', t('projects.chatTitle'));
  const title = el('input', 'p-input'); title.name = 'title'; title.maxLength = 100; title.placeholder = t('projects.autoTitle'); titleField.append(title);
  const modelField = el('div', 'project-field'); modelField.append(el('span', '', t('projects.model')));
  const modelToggle = button(t('projects.defaultModel'), () => { modelList.hidden = !modelList.hidden; modelToggle.ariaExpanded = String(!modelList.hidden); if (!modelList.hidden) modelSearch.focus(); }, 'project-model-toggle');
  modelToggle.ariaExpanded = 'false';
  const modelList = el('div', 'project-model-list'); modelList.hidden = true;
  const modelSearch = el('input', 'p-input'); modelSearch.type = 'search'; modelSearch.placeholder = t('projects.searchModel'); modelSearch.ariaLabel = t('projects.searchModel');
  const modelOptions = el('div', 'project-model-options'); modelList.append(modelSearch, modelOptions); modelField.append(modelToggle, modelList);
  const thinkingField = el('div', 'project-field'); thinkingField.append(el('span', '', t('model.thinking.title')));
  const levels = el('div', 'project-choices'); thinkingField.append(levels);
  const vpnField = el('div', 'project-field'); vpnField.append(el('span', '', t('network.title')));
  const vpnChoices = el('div', 'project-choices'); vpnField.append(vpnChoices);
  let selectedModel = null, thinking = 'default', proxyEnabled = null, catalog = [], catalogLoaded = false;
  const chooseLevel = () => {
    levels.replaceChildren();
    const choices = selectedModel?.thinkingLevels?.length ? ['default', ...selectedModel.thinkingLevels] : ['default'];
    for (const level of choices) {
      const b = button(thinkingLabel(level), () => { thinking = level; chooseLevel(); }, 'project-choice');
      b.ariaPressed = String(thinking === level); b.disabled = busy || !!createdId; levels.append(b);
    }
  };
  const chooseVpn = () => {
    vpnChoices.replaceChildren();
    for (const [value, label] of [[null, 'network.reset'], [true, 'network.on'], [false, 'network.off']]) {
      const b = button(t(label), () => { proxyEnabled = value; chooseVpn(); }, 'project-choice');
      b.ariaPressed = String(proxyEnabled === value); b.disabled = busy || !!createdId; vpnChoices.append(b);
    }
  };
  const chooseModel = model => {
    selectedModel = model; thinking = 'default'; chooseLevel();
    modelToggle.textContent = model ? model.id + ' · ' + model.provider : t('projects.defaultModel');
    modelList.hidden = true; modelToggle.ariaExpanded = 'false'; modelToggle.focus();
  };
  const drawModels = () => {
    const query = modelSearch.value.trim().toLowerCase(); modelOptions.replaceChildren();
    modelOptions.append(button(t('projects.defaultModel'), () => chooseModel(null), 'project-model-option'));
    for (const model of catalog.filter(m => (m.id + ' ' + m.provider).toLowerCase().includes(query))) {
      const b = button('', () => chooseModel(model), 'project-model-option');
      b.append(el('span', '', model.id), el('small', '', model.provider)); b.ariaPressed = String(selectedModel === model); modelOptions.append(b);
    }
    if (!catalogLoaded) modelOptions.append(button(t('projects.retry'), loadModels, 'project-history'));
  };
  const loadModels = async () => {
    modelOptions.replaceChildren(el('p', 'project-note', t('projects.loading')));
    try {
      const data = await projectApi('/api/models'); if (!view.node.open) return;
      catalog = (data.providers || []).flatMap(p => p.models.map(m => ({ ...m, provider: p.name })));
      catalogLoaded = true; drawModels();
    } catch { if (view.node.open) drawModels(); }
  };
  modelSearch.addEventListener('input', drawModels);
  modelList.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); modelList.hidden = true; modelToggle.ariaExpanded = 'false'; modelToggle.focus(); } });
  const field = el('div', 'project-field'); field.append(el('span', '', t('projects.rootDirectory')), el('p', 'project-directory', projectRoot));
  const option = el('label', 'project-option'), isolated = el('input'); isolated.type = 'checkbox'; isolated.checked = false;
  option.append(isolated, el('span', 'project-option-body', t('projects.independentDirectory')));
  const hint = el('p', 'project-note', t('projects.isolateHint')); hint.hidden = true;
  isolated.addEventListener('change', () => { hint.hidden = !isolated.checked; });
  const error = el('p', 'project-error'); error.setAttribute('role', 'alert');
  let busy = false, createdId = '';
  const update = () => { create.disabled = busy; };
  const openCreated = () => {
    if (spaEnabled()) switchTo(createdId); else window.location.href = '/' + createdId + '/';
    view.node.close();
  };
  const create = button(t('projects.createIsolated'), async () => {
    if (busy) return;
    if (createdId) { openCreated(); return; }
    // Bind creation to the root displayed when this dialog opened.
    const body = { projectId: project.id, cwd: projectRoot, isolated: isolated.checked,
      ...(title.value.trim() ? { title: title.value.trim() } : {}),
      ...(selectedModel ? { model: selectedModel.id, provider: selectedModel.provider, thinking } : {}),
      ...(proxyEnabled !== null ? { proxyEnabled } : {}) };
    busy = true; error.textContent = ''; update();
    view.close.disabled = isolated.disabled = title.disabled = modelToggle.disabled = true;
    modelList.hidden = true; modelToggle.ariaExpanded = 'false'; chooseLevel(); chooseVpn();
    try {
      const result = await projectApi('/api/projects/session', body);
      createdId = result.instanceId;
      await loadNetworkPolicy(); await refresh(); await pollStatus(); openCreated();
    } catch (e) {
      createdId ||= e.instanceId || '';
      error.textContent = e.message;
      if (createdId) {
        error.textContent += '\n' + t('projects.createdWithError');
        create.textContent = t('projects.openCreatedChat');
      }
    }
    finally {
      busy = false; view.close.disabled = false;
      isolated.disabled = title.disabled = modelToggle.disabled = !!createdId; chooseLevel(); chooseVpn(); update();
    }
  }, 'project-button primary');
  update();
  view.node.addEventListener('cancel', ev => { if (busy) ev.preventDefault(); });
  view.content.append(titleField, modelField, thinkingField, vpnField, field, option, hint, error, create); chooseLevel(); chooseVpn(); void loadModels(); title.focus();
}
function edit(project) {
  if (dialog) return;
  const opener = document.activeElement;
  dialog = el("dialog", "project-dialog");
  const currentDialog = dialog;
  const form = el("form", "project-form");
  const heading = el("h2", "", project ? t("projects.manage") : t("projects.new")); heading.id = "project-dialog-title";
  dialog.setAttribute("aria-labelledby", heading.id);
  const top = el("div", "project-dialog-head");
  const close = button("×", () => dialog.close(), "project-manage"); close.setAttribute("aria-label", t("projects.cancel"));
  top.append(heading, close);
  const nameLabel = el("label", "project-field", t("projects.name"));
  const name = el("input", "p-input"); name.required = true; name.maxLength = 80; name.value = project?.name || ""; name.autocomplete = "off";
  nameLabel.append(name);
  const directoryLabel = el('label', 'project-field', t('projects.rootDirectory'));
  const initialRoot = project?.cwd || '';
  const cwd = el('input', 'p-input'); cwd.name = 'cwd'; cwd.required = true; cwd.autocomplete = 'off'; cwd.value = initialRoot; cwd.placeholder = t('projects.directoryPlaceholder'); directoryLabel.append(cwd);
  const directoryHint = el('p', 'project-note', t(project && !project.cwd ? 'projects.rootRequired' : 'projects.rootHint'));
  let picking = false;
  const browse = button(t('projects.chooseDirectory'), async () => {
    if (busy || picking) return;
    picking = true; browse.disabled = cwd.disabled = save.disabled = true;
    try {
      const picked = window.electronAPI?.pickDirectory ? await window.electronAPI.pickDirectory() : await projectApi('/pick-dir');
      if (currentDialog.open && !picked.cancelled && picked.cwd) cwd.value = picked.cwd;
    } catch (e) { if (currentDialog.open) status.textContent = e.message; }
    finally { picking = false; browse.disabled = cwd.disabled = save.disabled = busy; }
  });
  const hint = el("p", "project-note", t("projects.hint"));
  const search = el("input", "p-input"); search.type = "search"; search.placeholder = t("projects.search"); search.setAttribute("aria-label", t("projects.search"));
  const picker = el("div", "project-picker");
  const available = chats();
  const initial = new Set(project?.sessionIds || []), selected = new Set(initial);
  const checkRows = [];
  for (const s of available) {
    const row = el("label", "project-option");
    const check = el("input"); check.type = "checkbox"; check.checked = selected.has(s.instanceId);
    check.addEventListener("change", () => { if (check.checked) selected.add(s.instanceId); else selected.delete(s.instanceId); });
    const body = el("span", "project-option-body");
    body.append(el("span", "", s.title || t("untitled")));
    const previous = groups.find(p => p.id !== project?.id && p.sessionIds.includes(s.instanceId));
    body.append(el("small", "", previous ? t("projects.moveFrom", { name: previous.name }) : s.cwd || ""));
    row.append(check, body); picker.append(row);
    checkRows.push({ row, text: `${s.title || ""} ${s.cwd || ""}`.toLowerCase() });
  }
  const noMatches = el("p", "project-note", t("projects.noMatches")); noMatches.hidden = available.length > 0; picker.append(noMatches);
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const item of checkRows) item.row.hidden = !item.text.includes(q);
    noMatches.hidden = checkRows.some(item => !item.row.hidden);
  });
  const status = el("p", "project-error"); status.setAttribute("role", "alert");
  const footer = el("div", "project-footer");
  let busy = false, deleting = false;
  const deleteOptions = el('div', 'project-delete-options'); deleteOptions.hidden = true;
  const keepLabel = el('label', 'project-option');
  const keep = el('input'); keep.type = 'checkbox'; keep.checked = true;
  keepLabel.append(keep, el('span', '', t('projects.keepChats')));
  const deleteHint = el('p', 'project-note', t('projects.deleteHint'));
  keep.addEventListener('change', () => { deleteHint.textContent = t(keep.checked ? 'projects.deleteHint' : 'projects.deleteAllHint'); });
  deleteOptions.append(keepLabel, deleteHint);
  const save = el("button", "project-button primary", t("projects.save")); save.type = "submit";
  const cancel = button(t("projects.cancel"), () => dialog.close());
  const remove = project ? button(t("projects.delete"), () => {
    if (!deleting) {
      deleting = true; heading.textContent = t("projects.delete"); remove.textContent = t("projects.confirmDelete");
      name.readOnly = true;
      hint.hidden = search.hidden = picker.hidden = save.hidden = directoryLabel.hidden = directoryHint.hidden = browse.hidden = true;
      deleteOptions.hidden = false; keep.focus(); return;
    }
    void persist({ action: "delete", id: project.id, deleteConversations: !keep.checked });
  }, "project-delete") : null;
  if (remove) footer.append(remove);
  footer.append(cancel, save);
  async function persist(body) {
    if (busy || picking) return; busy = true; status.textContent = "";
    for (const control of form.querySelectorAll("button, input")) control.disabled = true;
    try {
      const result = await request(body);
      // Invalidate older reads only after a successful write. A failed save
      // must leave the pending list request able to finish and clear loading.
      ++generation; groups = Array.isArray(result) ? result : result.projects; loading = false; error = "";
      render(); currentDialog.close();
      if (body.action === 'delete' && body.deleteConversations) {
        // Use the server's deletion snapshot, not membership from when the
        // dialog opened: another window may have moved conversations since.
        const deleted = result.deletedSessionIds || [];
        ++statusGeneration;
        setSessions(allSessions.value.filter(s => !deleted.includes(s.instanceId)));
        // closeTab changes activeSessionId. Full-page mode must navigate before
        // that mutation, just like deleting an individual conversation.
        if (!spaEnabled() && deleted.includes(activeSessionId.value)) {
          window.location.href = '/'; return;
        }
        for (const id of deleted) {
          if (openTabs.peek().includes(id)) await closeTab(id, { backendClosed: true });
          else sessions.get(id)?.remove();
        }
      }
    }
    catch (e) {
      status.textContent = e.message;
      if (body.action === "delete" && body.deleteConversations) {
        ++statusGeneration; void pollStatus();
        document.dispatchEvent(new CustomEvent("ash:sessions-changed"));
      }
    }
    finally { busy = false; for (const control of form.querySelectorAll("button, input")) control.disabled = false; }
  }
  form.addEventListener("submit", ev => {
    ev.preventDefault();
    if (deleting) return; // Only the explicit confirmation button deletes a project.
    if (!name.value.trim()) { name.focus(); return; }
    if (!cwd.value.trim()) { cwd.focus(); return; }
    void persist({ action: project ? "edit" : "create", id: project?.id, name: name.value,
      // Unrelated edits must not reset a root changed in another window.
      ...(!project || cwd.value.trim() !== initialRoot ? { cwd: cwd.value.trim() } : {}),
      add: [...selected].filter(id => !initial.has(id)), remove: [...initial].filter(id => !selected.has(id)) });
  });
  form.append(top, nameLabel, directoryLabel, browse, directoryHint, hint, search, picker, deleteOptions, status, footer); dialog.append(form);
  // Modal keyboard actions must not reach global shortcuts (Escape cancels a turn).
  dialog.addEventListener("keydown", ev => ev.stopPropagation());
  dialog.addEventListener("cancel", ev => { if (busy) ev.preventDefault(); });
  dialog.addEventListener("close", () => { currentDialog.remove(); dialog = null; if (opener?.isConnected) opener.focus(); else document.getElementById("sidebar-view-select")?.focus(); });
  document.body.append(dialog); dialog.showModal(); name.focus();
}
if (root) {
  effect(() => { allSessions.value; activeSessionId.value; networkPolicy.value; render(); });
  document.addEventListener("langchange", render);
  window.addEventListener("focus", () => { if (visible && !dialog) void refresh(); });
}
