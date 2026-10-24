import { projectSessionStatus, sharesActiveWorkspace } from "./project-status.js";
import { allSessions, setSessions } from "./store.js";
import { activeSessionId, spaEnabled, switchTo } from "./session-manager.js";
import { effect } from "../vendor/signals-core.js";
import { t } from "./i18n.js";

const root = document.getElementById("projects");
let groups = [], visible = false, loading = false, error = "", generation = 0;
let dialog = null;
let workspaces = {}, pollTimer = null, polling = false, workspacePolling = false, rendered = "";
const collapsed = new Set();
try { for (const id of JSON.parse(localStorage.getItem("ash.project-folded") || "[]")) collapsed.add(id); } catch {}
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const button = (text, fn, cls = "project-button") => { const n = el("button", cls, text); n.type = "button"; n.addEventListener("click", fn); return n; };
const chats = () => allSessions.value.filter(s => s.kind === "agent");
async function request(body) {
  const res = await fetch("/api/projects", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(body ? t("projects.saveFailed") : t("projects.loadFailed"));
  return res.json();
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
  const signature = JSON.stringify([groups, loading, error, chats(), activeSessionId.value, [...collapsed], workspaces, t("projects.title")]);
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
    const isolate = button(t("projects.isolate"), () => isolatedChat(p), "project-history"); isolate.title = t("projects.isolate"); isolate.setAttribute("aria-label", t("projects.isolate"));
    const manage = button("···", () => edit(p), "project-manage"); manage.title = t("projects.manage"); manage.setAttribute("aria-label", t("projects.manage") + ": " + p.name);
    row.append(toggle, manage); block.append(row);
    const actions = el("div", "project-group-actions"); actions.append(history, isolate); block.append(actions);
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
        const workspace = workspaces[s.cwd];
        const location = [workspace?.branch, s.cwd].filter(Boolean).join(" · ");
        if (location) { const detail = el("small", "project-chat-location", location); detail.title = location; body.append(detail); }
        const labels = [status !== 'idle' ? t("projects.status." + status) : "", s.queuedCount > 0 && status !== 'queued' ? t("projects.queueCount", { n: s.queuedCount }) : "", shared ? t("projects.sharedWorkspace") : ""].filter(Boolean);
        if (labels.length) body.append(el("small", "project-chat-status " + status, labels.join(" · ")));
        if (shared) link.title += "\n" + t("projects.sharedWorkspaceHint");
        link.append(el("span", "project-chat-dot " + status), body);
        block.append(link);
      }
    }
    root.append(block);
  }
}
async function projectApi(route, body) {
  const res = await fetch(route, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  if (!res.ok) {
    let message = t("projects.loadFailed");
    try { const data = await res.json(); message = data.error || message; if (data.workspace) message += "\n" + data.workspace.root; } catch {}
    throw new Error(message);
  }
  return res.json();
}
async function pollStatus() {
  if (!visible || document.hidden) return;
  // Git discovery may be slow on network drives; never hold up task status.
  if (!workspacePolling) {
    workspacePolling = true;
    void projectApi('/api/projects/workspaces').then(locations => {
      if (visible) { workspaces = locations; render(); }
    }).catch(() => {}).finally(() => { workspacePolling = false; });
  }
  if (polling) return;
  polling = true;
  try { const sessions = await projectApi('/sessions'); if (visible) setSessions(sessions); }
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
function isolatedChat(project) {
  const view = projectDialog(t('projects.isolate')); if (!view) return;
  view.content.append(el('p', 'project-note', t('projects.isolateHint')));
  const list = el('div', 'project-picker');
  const members = chats().filter(s => project.sessionIds.includes(s.instanceId));
  let sourceId = members[0]?.instanceId, busy = false;
  for (const session of members) {
    const row = el('label', 'project-option'), input = el('input'); input.type = 'radio'; input.name = 'workspace-source'; input.checked = session.instanceId === sourceId;
    input.addEventListener('change', () => { sourceId = session.instanceId; });
    const body = el('span', 'project-option-body'); body.append(el('span', '', session.title || t('untitled')), el('small', '', session.cwd)); row.append(input, body); list.append(row);
  }
  if (!members.length) list.append(el('p', 'project-note', t('projects.isolateEmpty')));
  const error = el('p', 'project-error'); error.setAttribute('role', 'alert');
  const create = button(t('projects.createIsolated'), async () => {
    if (busy || !sourceId) return; busy = true; error.textContent = '';
    create.disabled = true; view.close.disabled = true;
    for (const input of list.querySelectorAll('input')) input.disabled = true;
    try {
      const result = await projectApi('/api/projects/worktree', { projectId: project.id, sourceId });
      await refresh(); await pollStatus(); view.node.close();
      if (spaEnabled()) await switchTo(result.instanceId); else window.location.href = '/' + result.instanceId + '/';
    } catch (e) { error.textContent = e.message; }
    finally { busy = false; create.disabled = false; view.close.disabled = false; for (const input of list.querySelectorAll('input')) input.disabled = false; }
  }, 'project-button primary');
  create.disabled = !sourceId;
  view.node.addEventListener('cancel', ev => { if (busy) ev.preventDefault(); });
  view.content.append(list, error, create);
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
  const save = el("button", "project-button primary", t("projects.save")); save.type = "submit";
  const cancel = button(t("projects.cancel"), () => dialog.close());
  const remove = project ? button(t("projects.delete"), () => {
    if (!deleting) { deleting = true; remove.textContent = t("projects.confirmDelete"); status.textContent = t("projects.deleteHint"); return; }
    void persist({ action: "delete", id: project.id });
  }, "project-delete") : null;
  if (remove) footer.append(remove);
  footer.append(cancel, save);
  async function persist(body) {
    if (busy) return; busy = true; status.textContent = "";
    for (const control of form.querySelectorAll("button, input")) control.disabled = true;
    try {
      const result = await request(body);
      // Invalidate older reads only after a successful write. A failed save
      // must leave the pending list request able to finish and clear loading.
      ++generation; groups = result; loading = false; error = "";
      render(); currentDialog.close();
    }
    catch (e) { status.textContent = e.message; }
    finally { busy = false; for (const control of form.querySelectorAll("button, input")) control.disabled = false; }
  }
  form.addEventListener("submit", ev => {
    ev.preventDefault();
    if (!name.value.trim()) { name.focus(); return; }
    void persist({ action: project ? "edit" : "create", id: project?.id, name: name.value,
      add: [...selected].filter(id => !initial.has(id)), remove: [...initial].filter(id => !selected.has(id)) });
  });
  form.append(top, nameLabel, hint, search, picker, status, footer); dialog.append(form);
  // Modal keyboard actions must not reach global shortcuts (Escape cancels a turn).
  dialog.addEventListener("keydown", ev => ev.stopPropagation());
  dialog.addEventListener("cancel", ev => { if (busy) ev.preventDefault(); });
  dialog.addEventListener("close", () => { currentDialog.remove(); dialog = null; if (opener?.isConnected) opener.focus(); else document.getElementById("sidebar-view-select")?.focus(); });
  document.body.append(dialog); dialog.showModal(); name.focus();
}
if (root) {
  effect(() => { allSessions.value; activeSessionId.value; render(); });
  document.addEventListener("langchange", render);
  window.addEventListener("focus", () => { if (visible && !dialog) void refresh(); });
}
