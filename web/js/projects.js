import { networkPolicy, saveNetworkPolicy, loadNetworkPolicy } from "./network-settings.js";
import { thinkingLabel } from "./thinking-control.js";
import { toast } from "./toast.js";
import { projectSessionStatus } from "./project-status.js";
import { allSessions, setSessions } from "./store.js";
import { activeSessionId, spaEnabled, switchTo, closeTab, openTabs, sessions, setSessionKind } from "./session-manager.js";
import { effect, signal } from "../vendor/signals-core.js";
import { t } from "./i18n.js";

const root = document.getElementById("projects");
export const sidebarProjects = signal([]);
let groups = sidebarProjects.peek(), visible = false, loading = false, error = "", generation = 0;
let dialog = null;
let workspaces = {}, pollTimer = null, polling = false, groupPolling = false, workspacePolling = false, statusGeneration = 0;
let statusReadSeq = 0, groupReadSeq = 0, workspaceReadSeq = 0;
let refreshRead, pollRead, sessionsRead, loaded = false, hostReadRevision = 0;
const initialRouteSession = globalThis.location?.pathname.match(/^\/([0-9a-f]{4,32})\/?$/)?.[1];
let defaultOpen, temporaryOpen, viewRevision = 0, revealRevision = 0, focusRevision = 0;
let appliedGroupPoll = 0;
const projectPinIcon = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/></svg>';
const projectCaretIcon = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 4 4 4-4 4"/></svg>';
const projectMoreIcon = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12" cy="8" r="1"/></svg>';
const projectDirectoryIcon = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M2 4h4l1.5 2H14v6H2z"/></svg>';
const expansionKey = "ash.project-expanded";
const otherExpansionKey = "ash.project-others-expanded";
const readIds = key => {
  try { const value = JSON.parse(localStorage.getItem(key)); return Array.isArray(value) ? new Set(value) : null; }
  catch { return null; }
};
let explicitOpen = readIds(expansionKey);
const legacyFolded = explicitOpen ? null : readIds("ash.project-folded");
const expandedOthers = readIds(otherExpansionKey) ?? new Set();
const revealedOthers = new Set();
const networkSaving = new Set();
const pinSaving = new Set();
const groupViews = new Map();
let note, retry;
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const button = (text, fn, cls = "project-button") => { const n = el("button", cls, text); n.type = "button"; n.addEventListener("click", fn); return n; };
const chats = () => allSessions.value.filter(s => s.kind === "agent" || s.projectWorker === true);
const projectVersions = new WeakMap();
function compareGroups(next, current) {
  const a = projectVersions.get(next), b = projectVersions.get(current);
  return a && b && a.epoch === b.epoch ? a.revision - b.revision : null;
}
function acceptGroups(next, currentRequest) {
  const order = compareGroups(next, groups) ?? 0;
  // Request order breaks ties and handles unversioned or different-epoch reads.
  if (order < 0 || (order === 0 && !currentRequest)) return false;
  publishGroups(next);
  return true;
}
function publishGroups(next) {
  groups = next;
  loaded = true;
  sidebarProjects.value = next;
}
async function request(body) {
  const res = await fetch("/api/projects", body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store", signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(body ? t("projects.saveFailed") : t("projects.loadFailed"));
  const result = await res.json();
  const stamp = /^([^:]+):(\d+)$/.exec(res.headers?.get('X-asHub-Project-Version') ?? '');
  if (stamp) projectVersions.set(Array.isArray(result) ? result : result.projects, { epoch: stamp[1], revision: Number(stamp[2]) });
  if (body) document.dispatchEvent(new CustomEvent("ash:sessions-changed"));
  return result;
}
function readProjects({ background = false } = {}) {
  const seq = ++generation, pollAtStart = appliedGroupPoll, before = groups, host = hostReadRevision;
  const current = () => seq === generation && appliedGroupPoll === pollAtStart;
  loading = !loaded && !background; error = ""; render();
  const read = request().then(result => {
    if (host !== hostReadRevision) throw new Error(t("projects.loadFailed"));
    if (acceptGroups(result, current())) error = "";
    return groups;
  }).catch(e => {
    if (host !== hostReadRevision) throw e;
    if (!current() || groups !== before) return groups;
    if (!loaded) error = e.message;
    throw e;
  }).finally(() => {
    if (refreshRead === read) refreshRead = null;
    if (seq === generation) loading = false;
    render();
  });
  return refreshRead = read;
}
function refresh(options) { return readProjects(options).catch(() => groups); }
// Search can read while Projects is hidden. Preserve the accepted snapshot on
// failure, but reject the call so its caller can distinguish offline from empty.
export function loadSidebarProjects() { return refreshRead || pollRead || readProjects({ background: loaded }); }
// A versioned write must not invalidate an in-flight read: that read may
// already contain a later commit from another window.
async function applyProjectWrite(next, previousGroups = groups, seq = generation) {
  const order = compareGroups(next, groups);
  if (order !== null) {
    if (order >= 0) { publishGroups(next); loading = false; error = ""; }
  } else if (projectVersions.has(next) && projectVersions.has(groups)) {
    // Across Hub restarts neither revision counter orders the two snapshots.
    await refresh({ background: true });
    return projectVersions.get(next).epoch === projectVersions.get(groups)?.epoch;
  } else if (groups === previousGroups && seq === generation) {
    ++generation; // Legacy responses have no revision to compare against older reads.
    publishGroups(next); loading = false; error = "";
  } else {
    if (seq === generation && JSON.stringify(groups) === JSON.stringify(previousGroups)) publishGroups(next);
    await refresh({ background: true });
  }
  return true;
}
export function showProjects(show) {
  if (!root) return;
  root.hidden = !show;
  const changed = visible !== show; visible = show;
  if (!changed) return;
  ++viewRevision;
  if (show) {
    render();
    void loadSidebarProjects().catch(() => {});
    void pollStatus({ groups: false });
    pollTimer = setInterval(pollStatus, 5000);
  } else {
    for (const menu of root.querySelectorAll(".project-menu:popover-open")) menu.hidePopover();
    temporaryOpen = null;
    revealedOthers.clear();
    clearInterval(pollTimer); pollTimer = null;
  }
}
function projectMenu(invoke) {
  const trigger = button("", () => {
    if (panel.matches(":popover-open")) { panel.hidePopover(); return; }
    panel.showPopover({ source: trigger });
    const box = trigger.getBoundingClientRect(), menu = panel.getBoundingClientRect();
    panel.style.left = Math.max(8, Math.min(box.right - menu.width, innerWidth - menu.width - 8)) + "px";
    panel.style.top = (box.bottom + menu.height + 8 <= innerHeight ? box.bottom : Math.max(8, box.top - menu.height)) + "px";
    [...panel.querySelectorAll("button")].find(item => !item.disabled)?.focus();
  }, "project-more");
  trigger.innerHTML = projectMoreIcon;
  const panel = el("div", "project-menu");
  panel.setAttribute("popover", "auto");
  panel.setAttribute("data-sidebar-action-menu", "");
  trigger.setAttribute("aria-expanded", "false");
  panel.addEventListener("toggle", () => setAttr(trigger, "aria-expanded", String(panel.matches(":popover-open"))));
  panel.addEventListener("keydown", ev => {
    if (ev.key !== "Escape" || !panel.matches(":popover-open")) return;
    ev.preventDefault(); ev.stopPropagation();
    panel.hidePopover(); trigger.focus({ preventScroll: true });
  });
  const item = (name, cls, action) => {
    const btn = button(name, () => {
      if (panel.matches(":popover-open")) { panel.hidePopover(); trigger.focus({ preventScroll: true }); }
      return action(invoke());
    }, cls);
    panel.append(btn);
    return btn;
  };
  return { trigger, panel, item };
}
function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
function setAttr(node, key, value) { if (node.getAttribute(key) !== value) node.setAttribute(key, value); }
function setClass(node, value) { if (node.className !== value) node.className = value; }
function setHidden(node, value) { if (node.hidden !== value) node.hidden = value; }
function setDisabled(node, value) { if (node.disabled !== value) node.disabled = value; }
function setTitle(node, value) { if (node.title !== value) node.title = value; }

// Keep unchanged nodes in place, even when inserting/reordering other keys.
function arrange(parent, nodes, first = parent.firstChild) {
  let cursor = first;
  for (const node of nodes) {
    if (node !== cursor) parent.insertBefore(node, cursor);
    cursor = node.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}
function normallyOpen(id) { return explicitOpen ? explicitOpen.has(id) : legacyFolded ? !legacyFolded.has(id) : id === defaultOpen; }
function isOpen(id) { return id === temporaryOpen || normallyOpen(id); }
function toggleProject(id) {
  const open = isOpen(id);
  if (!explicitOpen) explicitOpen = new Set(groups.filter(p => normallyOpen(p.id)).map(p => p.id));
  if (id === temporaryOpen) temporaryOpen = null;
  if (open) { explicitOpen.delete(id); revealedOthers.delete(id); } else explicitOpen.add(id);
  try { localStorage.setItem(expansionKey, JSON.stringify([...explicitOpen])); } catch {}
  render();
}
function othersOpen(id) { return expandedOthers.has(id) || revealedOthers.has(id); }
function toggleOthers(id) {
  if (othersOpen(id)) { expandedOthers.delete(id); revealedOthers.delete(id); }
  else expandedOthers.add(id);
  try { localStorage.setItem(otherExpansionKey, JSON.stringify([...expandedOthers])); } catch {}
  render();
}
function buildGroup(p) {
  const block = el("section", "project-group"), heading = el("div", "project-heading");
  const toggle = button("", () => toggleProject(p.id), "project-toggle");
  toggle.dataset.projectId = p.id;
  const caret = el("span", "project-caret"), name = el("span", "project-name"), count = el("span", "project-count"), summary = el("span", "project-summary");
  caret.innerHTML = projectCaretIcon;
  summary.setAttribute("aria-hidden", "true");
  toggle.append(caret, name, count, summary);
  const view = { block, toggle, name, count, summary, p, members: new Map() };
  view.menu = projectMenu(() => view.p);
  view.menu.panel.className += " project-group-actions";
  view.newChat = view.menu.item("", "project-new-chat", newProjectChat);
  view.history = view.menu.item("", "project-history", taskHistory);
  view.manage = view.menu.item("", "project-manage", edit);
  heading.append(toggle, view.menu.trigger, view.menu.panel); block.append(heading);
  view.details = el("div", "project-details");
  view.path = el("div", "project-directory");
  view.path.innerHTML = projectDirectoryIcon;
  view.pathLabel = el("span", "project-directory-label");
  view.path.append(view.pathLabel);
  view.activity = el("div");
  view.list = el("div", "project-members");
  view.otherList = el("div", "project-other-list");
  view.otherList.id = `project-others-${p.id}`;
  view.otherToggle = button("", () => toggleOthers(p.id), "project-other-toggle");
  view.otherToggle.setAttribute("aria-controls", view.otherList.id);
  const otherHead = el("span", "project-other-head"), otherCaret = el("span", "project-other-caret");
  view.otherLabel = el("span", "project-other-label");
  view.otherCount = el("span", "project-other-count");
  const otherStatus = el("span", "project-other-status");
  otherCaret.innerHTML = projectCaretIcon;
  otherStatus.setAttribute("aria-hidden", "true");
  view.otherStatus = otherStatus;
  view.otherMetrics = new Map(["attention", "running", "queued", "unread"].map(key =>
    [key, el("span", `project-other-metric ${key}`)]));
  otherStatus.append(...view.otherMetrics.values());
  otherHead.append(otherCaret, view.otherLabel, view.otherCount);
  view.otherToggle.append(otherHead, otherStatus);
  view.empty = button("", () => edit(view.p), "project-empty");
  view.details.append(view.path, view.activity, view.empty, view.list); block.append(view.details);
  return view;
}
function setMenuLabel(menu, label) { setAttr(menu.trigger, "aria-label", label); setTitle(menu.trigger, label); }
function buildMember(view, s) {
  const row = el("div", "project-chat-row"), link = el("a", "project-chat");
  link.href = `/${s.instanceId}/`;
  link.addEventListener("click", ev => {
    if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey && spaEnabled()) { ev.preventDefault(); switchTo(s.instanceId); }
  });
  const dot = el("span", "project-chat-dot"), name = el("span", "project-chat-name"), marker = el("span", "project-pin-mark");
  marker.innerHTML = projectPinIcon;
  dot.setAttribute("aria-hidden", "true");
  link.append(dot, name, marker);
  const member = { row, link, dot, name, marker, s };
  const menu = member.menu = projectMenu(() => member.s);
  menu.panel.className += " project-chat-actions";
  member.location = el("small", "project-chat-location");
  member.directory = el("small", "project-chat-directory");
  member.statusText = el("small", "project-chat-status");
  menu.panel.append(member.location, member.directory, member.statusText);
  member.rename = menu.item("", "project-chat-action", renameProjectChat);
  member.pin = menu.item("", "project-chat-action project-chat-pin", async current => {
    const id = current.instanceId;
    if (pinSaving.has(id)) return;
    pinSaving.add(id); setDisabled(member.pin, true);
    const previousGroups = groups, seq = generation;
    try {
      const confirmed = await request({ action: "pin", id: view.p.id, sessionId: id, pinned: !member.pinned });
      await applyProjectWrite(confirmed, previousGroups, seq);
    } catch (e) { toast(t("projects.saveFailed"), { type: "error", detail: String(e) }); }
    finally { pinSaving.delete(id); setDisabled(member.pin, false); render(); }
  });
  member.proxy = menu.item("", "project-chat-action project-chat-proxy", current => void changeProxy(current.instanceId));
  member.proxy.addEventListener("contextmenu", e => { e.preventDefault(); void changeProxy(member.s.instanceId, true); });
  member.inherit = menu.item("", "project-chat-action", current => void changeProxy(current.instanceId, true));
  member.remove = menu.item("", "project-chat-delete", current => void deleteProjectChat(current, view.p));
  row.append(link, menu.trigger, menu.panel);
  return member;
}
function updateMember(v, s, primaryCwd, pinned, policy, active, shared) {
  v.s = s; v.pinned = pinned;
  const title = s.title || t("untitled"), status = projectSessionStatus(s);
  const worker = s.projectWorker === true;
  const vpn = !worker && policy ? (policy.sessions[s.instanceId] ?? policy.proxyEnabled) : null;
  const labels = [status !== "idle" ? t("projects.status." + status) : "", s.queuedCount > 0 && status !== "queued" ? t("projects.queueCount", { n: s.queuedCount }) : "", shared ? t("projects.sharedWorkspace") : ""].filter(Boolean);
  setText(v.name, title); setHidden(v.marker, !pinned); setClass(v.dot, "project-chat-dot " + status);
  setClass(v.link, "project-chat" + (active === s.instanceId ? " current" : ""));
  setAttr(v.link, "aria-current", active === s.instanceId ? "page" : "false");
  setAttr(v.link, "aria-label", [title, ...labels].join(" · "));
  setTitle(v.link, [title, s.cwd, ...labels, shared ? t("projects.sharedWorkspaceHint") : ""].filter(Boolean).join("\n"));
  setMenuLabel(v.menu, t("projects.chatActions") + ": " + title);
  const location = worker ? t(s.projectTaskProfile === 'inline-review' ? "projects.inlineReviewLabel" : "project.worker.title") : [s.model || t("projects.defaultModel"), thinkingLabel(s.thinkingLevel || "default"), vpn === null ? "" : t(vpn ? "network.on" : "network.off")].filter(Boolean).join(" · ");
  setText(v.location, location); setTitle(v.location, location);
  const external = !!s.cwd && (s.projectExternal ?? (!!primaryCwd && s.cwd !== primaryCwd));
  setHidden(v.directory, !external); setText(v.directory, external ? t("projects.otherDirectory") + " · " + (s.cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || s.cwd) : "");
  setTitle(v.directory, external ? s.cwd : "");
  setText(v.statusText, labels.join(" · ")); setHidden(v.statusText, !labels.length); setClass(v.statusText, "project-chat-status " + status);
  setText(v.rename, t("network.rename")); setText(v.pin, t(pinned ? "unpin" : "pin"));
  setAttr(v.pin, "aria-pressed", String(pinned)); setDisabled(v.pin, pinSaving.has(s.instanceId));
  setText(v.proxy, t(vpn ? "network.on" : "network.off")); setTitle(v.proxy, t("network.tabHint"));
  setAttr(v.proxy, "aria-pressed", String(!!vpn)); setDisabled(v.proxy, worker || !policy || networkSaving.has(s.instanceId));
  setText(v.inherit, t("network.inherit")); setDisabled(v.inherit, worker || !policy || networkSaving.has(s.instanceId));
  setHidden(v.proxy, worker); setHidden(v.inherit, worker);
  setText(v.remove, t("projects.removeChat"));
}
function firstCrossing(nodes, y, end = nodes.length) {
  let lo = 0, hi = end;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (nodes[mid].getBoundingClientRect().bottom <= y) lo = mid + 1; else hi = mid;
  }
  return lo < end ? nodes[lo] : null;
}
function visibleAnchor() {
  if (!root.scrollTop || !root.getBoundingClientRect) return null;
  const top = root.getBoundingClientRect().top;
  const block = firstCrossing(Array.from(root.children).slice(1), top);
  if (!block) return null;
  const view = groupViews.get(block.dataset.projectGroup);
  const list = view?.list;
  let node = block;
  if (list?.parentNode.hidden === false && list.getBoundingClientRect().top < top) {
    const hiddenTail = view.otherList.parentNode === list && view.otherList.hidden;
    node = firstCrossing(list.children, top, list.children.length - Number(hiddenTail)) || block;
    if (node === view.otherList) node = firstCrossing(node.children, top) || view.otherToggle;
  }
  return { node, top: node.getBoundingClientRect().top };
}
function renderOtherSummary(v, n, counts, summary, current, expanded) {
  const label = t("projects.otherChats");
  setText(v.otherLabel, label);
  setText(v.otherCount, String(n));
  setAttr(v.otherToggle, "aria-expanded", String(expanded));
  setClass(v.otherToggle, "project-other-toggle" + (current ? " contains-current" : ""));
  const state = `${t("projects.overallStatus")} · ${summary || t("projects.quiet")}`;
  setHidden(v.otherStatus, expanded || !summary);
  const detail = [state, current ? t("projects.currentInOthers") : ""].filter(Boolean).join(" · ");
  setAttr(v.otherToggle, "aria-label", `${label} · ${n} · ${detail}`);
  setTitle(v.otherToggle, detail);
  for (const [key, node] of v.otherMetrics) {
    const text = counts[key];
    setHidden(node, !text);
    setText(node, text);
  }
}
function render() {
  if (!root || !visible) return;
  const active = activeSessionId.value;
  if (loaded && defaultOpen === undefined) defaultOpen = groups.find(p => p.sessionIds.includes(active || initialRouteSession))?.id ?? null;
  if (!note) {
    note = el("div", "project-notice"); note.append(el("p", "project-note"));
    retry = button("", () => void loadSidebarProjects().catch(() => {})); note.append(retry);
    root.append(note);
  }
  const focus = root.contains(document.activeElement) ? document.activeElement : null;
  let focusFallback;
  const anchor = visibleAnchor();
  setHidden(note, !!groups.length || (!loading && !error && !loaded));
  setText(note.firstChild, error || t(loading ? "projects.loading" : "projects.empty"));
  setHidden(retry, !error); setText(retry, t("projects.retry"));
  const ordered = new Map(), activeRoots = new Map();
  const list = chats();
  for (const [idx, s] of list.entries()) {
    ordered.set(s.instanceId, { s, idx });
    if (s.isProcessing && s.cwd) {
      const key = workspaces[s.cwd]?.root || s.cwd;
      activeRoots.set(key, (activeRoots.get(key) || 0) + 1);
    }
  }
  const policy = networkPolicy.value, next = [];
  for (const p of groups) {
    let v = groupViews.get(p.id);
    if (!v) { v = buildGroup(p); v.block.dataset.projectGroup = p.id; groupViews.set(p.id, v); }
    v.p = p; next.push(v.block);
    const pins = new Map((p.pinnedSessionIds ?? []).map((id, index) => [id, index]));
    const members = [...new Set(p.sessionIds)].map(id => ordered.get(id)).filter(Boolean);
    const open = isOpen(p.id);
    setAttr(v.toggle, "aria-expanded", String(open));
    setText(v.name, p.name); setTitle(v.name, p.name); setText(v.count, String(members.length));
    setAttr(v.toggle, "aria-current", active && p.sessionIds.includes(active) ? "true" : "false");
    let attention = 0, failed = 0, unread = 0, running = 0, queued = 0;
    for (const { s } of members) {
      const status = projectSessionStatus(s);
      if (status === "approval" || status === "failed") ++attention;
      if (status === "failed") ++failed;
      if (status === "running") ++running;
      // Queue and unread can coexist with an active turn. Count conversations, not turns.
      if (s.queuedCount > 0) ++queued;
      if (s.hasUnread) ++unread;
    }
    const counts = {
      attention: attention ? t("projects.attentionCount", { n: attention }) : "",
      running: running ? t("projects.runningCount", { n: running }) : "",
      queued: queued ? t("projects.queuedChats", { n: queued }) : "",
      unread: unread ? t("projects.unreadCount", { n: unread }) : "",
    };
    const summary = Object.values(counts).filter(Boolean).join(" · ");
    setClass(v.summary, "project-summary " + (failed ? "failed" : attention ? "attention" : running ? "running" : unread ? "unread" : "queued"));
    setHidden(v.summary, !summary); setText(v.summary, failed ? "×" : attention ? "!" : ""); setTitle(v.summary, summary);
    setAttr(v.toggle, "aria-label", [p.name, members.length, summary].filter(s => s !== "").join(" · "));
    if (!open && v.menu.panel.matches(":popover-open")) v.menu.panel.hidePopover();
    setHidden(v.details, !open); setHidden(v.menu.trigger, !open);
    const memberIds = new Set(members.map(({ s }) => s.instanceId));
    for (const [id, row] of v.members) if (!memberIds.has(id)) { row.row.remove(); v.members.delete(id); }
    if (!open) { v.details.remove(); continue; }
    if (v.details.parentNode !== v.block) v.block.append(v.details);
    setMenuLabel(v.menu, t("projects.actions") + ": " + p.name);
    setText(v.newChat, t("projects.newChat"));
    setText(v.history, t("projects.tasks")); setText(v.manage, t("projects.manage"));
    const branch = p.cwd && workspaces[p.cwd]?.branch;
    const directory = p.cwd && (p.cwd.split(/[\\/]+/).filter(Boolean).at(-1) || p.cwd);
    setText(v.pathLabel, [directory, branch].filter(Boolean).join(" · "));
    setTitle(v.path, [p.cwd, branch].filter(Boolean).join(" · "));
    setHidden(v.path, !p.cwd);
    const activities = (p.activities ?? []).map(a => a.label);
    const activityText = activities.join(" · "); setText(v.activity, activityText); setTitle(v.activity, activities.join("\n"));
    setClass(v.activity, "project-activity"); setHidden(v.activity, !activityText);
    setHidden(v.empty, !!members.length); setText(v.empty, t("projects.add"));
    members.sort((a, b) => (pins.get(a.s.instanceId) ?? pins.size) - (pins.get(b.s.instanceId) ?? pins.size) || a.idx - b.idx);
    const pinnedRows = [], otherRows = [];
    for (const { s } of members) {
      let row = v.members.get(s.instanceId);
      if (!row) { row = buildMember(v, s); v.members.set(s.instanceId, row); }
      const pinned = pins.has(s.instanceId);
      (pinned ? pinnedRows : otherRows).push(row.row);
      updateMember(row, s, p.cwd, pinned, policy, active,
        !!s.isProcessing && !!s.cwd && activeRoots.get(workspaces[s.cwd]?.root || s.cwd) > 1);
    }
    if (pinnedRows.length && otherRows.length) {
      const expanded = othersOpen(p.id);
      arrange(v.otherList, otherRows);
      if (!expanded) {
        if (focus && v.otherList.contains(focus)) focusFallback = v.otherToggle;
        if (!v.otherList.hidden) for (const menu of v.otherList.querySelectorAll(".project-menu:popover-open")) menu.hidePopover();
      }
      setHidden(v.otherList, !expanded);
      const activeRow = v.members.get(active)?.row;
      renderOtherSummary(v, otherRows.length, counts, summary, !expanded && activeRow?.parentNode === v.otherList, expanded);
      arrange(v.list, [...pinnedRows, v.otherToggle, v.otherList]);
    } else {
      if (focus === v.otherToggle) focusFallback = v.members.get(active)?.link || v.toggle;
      arrange(v.list, [...pinnedRows, ...otherRows]);
    }
  }
  const projectIds = new Set(groups.map(p => p.id));
  for (const id of groupViews.keys()) if (!projectIds.has(id)) { groupViews.get(id).block.remove(); groupViews.delete(id); revealedOthers.delete(id); }
  arrange(root, next, note.nextSibling);
  if (focusFallback) focusFallback.focus({ preventScroll: true });
  else if (focus?.isConnected && document.activeElement !== focus && !focus.closest("[hidden]")) focus.focus({ preventScroll: true });
  if (anchor?.node.isConnected && !anchor.node.closest("[hidden]")) {
    const offset = anchor.node.getBoundingClientRect().top - anchor.top;
    if (offset) root.scrollTop += offset;
  }
}
export function revealSidebarProject(projectId, sessionId = null) {
  if (!visible) return false;
  const revision = viewRevision, intent = ++revealRevision;
  const fallback = document.activeElement, focusAtSelection = focusRevision;
  const reveal = node => {
    node.scrollIntoView({ block: "nearest" });
    node.focus({ preventScroll: true });
    return true;
  };
  const find = () => {
    const group = groupViews.get(projectId);
    if (!group) return false;
    if (sessionId === null) return reveal(group.toggle);
    if (!group.p.sessionIds.includes(sessionId) || !chats().some(s => s.instanceId === sessionId)) return false;
    if (!isOpen(projectId)) { temporaryOpen = projectId; render(); }
    const row = group.members.get(sessionId);
    if (!row) return false;
    if (row.row.parentNode === group.otherList && group.otherList.hidden) {
      revealedOthers.add(projectId);
      render();
    }
    return reveal(row.link);
  };
  if (find()) return true;
  const pending = [refreshRead, pollRead, sessionsRead].filter(Boolean);
  return pending.length ? Promise.allSettled(pending).then(() => visible && revision === viewRevision && intent === revealRevision &&
    fallback === document.activeElement && focusAtSelection === focusRevision && find()) : false;
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
  const res = await fetch(route, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  if (!res.ok) {
    let message = t("projects.loadFailed"), instanceId, kind;
    try {
      const data = await res.json(); message = data.error || message;
      if (data.workspace) message += "\n" + data.workspace.root;
      if (typeof data.instanceId === 'string' && /^[0-9a-f]{4,32}$/i.test(data.instanceId)) {
        instanceId = data.instanceId;
        if (typeof data.kind === 'string') kind = data.kind;
      }
    } catch {}
    throw Object.assign(new Error(message), { instanceId, kind });
  }
  return res.json();
}
async function pollStatus(options) {
  if (!visible || document.hidden) return;
  // Plugins and other clients can change project membership without a local
  // management action. Refresh that snapshot too, without flashing a loader or
  // letting a slow request hold up conversation status updates.
  if (options?.groups !== false && !loading && (!groupPolling || options?.force)) {
    groupPolling = true;
    const seq = generation, read = ++groupReadSeq;
    const pending = request().then(result => {
      if (read === groupReadSeq && acceptGroups(result, seq === generation)) {
        ++appliedGroupPoll;
        error = ""; render();
      }
      return groups;
    }).finally(() => {
      if (pollRead === pending) pollRead = null;
      if (read === groupReadSeq) groupPolling = false;
    });
    pollRead = pending;
    void pending.catch(() => {});
  }
  // Git discovery may be slow on network drives; never hold up task status.
  if (!workspacePolling || options?.force) {
    workspacePolling = true;
    const read = ++workspaceReadSeq;
    void projectApi('/api/projects/workspaces').then(locations => {
      if (visible && read === workspaceReadSeq) { workspaces = locations; render(); }
    }).catch(() => {}).finally(() => { if (read === workspaceReadSeq) workspacePolling = false; });
  }
  if (polling && !options?.force) return;
  polling = true;
  const seq = statusGeneration, read = ++statusReadSeq;
  const pending = projectApi('/sessions').then(sessions => {
    if (visible && seq === statusGeneration && read === statusReadSeq) setSessions(sessions);
  }).catch(() => { /* Keep the last successful view during a brief disconnect. */ }).finally(() => {
    if (sessionsRead === pending) sessionsRead = null;
    if (read === statusReadSeq) polling = false;
  });
  return sessionsRead = pending;
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

function taskHistoryLabel(key, fallback) {
  const label = t(key);
  return label === key ? fallback : label;
}

function taskDelivery(delivery) {
  const section = el('section', 'project-task-delivery');
  section.append(
    el('strong', '', taskHistoryLabel('projects.delivery', 'Member-reported delivery')),
    el('pre', 'project-task-result', delivery.summary),
  );
  function appendList(key, fallback, items) {
    if (!items.length) return;
    const list = el('ul');
    for (const item of items) list.append(el('li', '', item));
    section.append(el('strong', '', taskHistoryLabel(key, fallback)), list);
  }
  appendList('projects.deliveryReferences', 'References (not verified)', delivery.artifacts.map(({ label, path }) => `${label}: ${path}`));
  appendList('projects.deliveryUnresolved', 'Unresolved issues', delivery.unresolved);
  return section;
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
        const download = el('a', 'project-history', taskHistoryLabel('projects.downloadTranscript', 'Download task transcript'));
        download.href = base + '&taskId=' + encodeURIComponent(task.id) + '&download=1';
        download.hidden = task.totalChars === 0;
        let transcript = '';
        let offset = 0, loading = false, loaded = false;
        const more = button(t('projects.moreResult'), async () => {
          if (loading) return; loading = true; more.disabled = true; error.textContent = '';
          try {
            const page = await projectApi(base + '&taskId=' + encodeURIComponent(task.id) + '&offset=' + offset);
            if (!view.node.open || seq !== generation) return;
            transcript += page.text; offset = page.nextOffset; loaded = true;
            error.textContent = page.error || '';
            more.hidden = !page.hasMore;
            download.hidden = !transcript && !page.hasMore;
            result.textContent = transcript || (!task.delivery && !page.hasMore ? t('projects.noResult') : '');
            result.hidden = !result.textContent;
          } catch (e) { error.textContent = e.message; }
          finally { loading = false; more.disabled = false; }
        });
        card.addEventListener('toggle', () => { if (card.open && !loaded) more.click(); });
        card.append(title, route);
        if (task.delivery) card.append(taskDelivery(task.delivery));
        card.append(result, error, more, recipient, download); list.append(card);
      }
    } catch (e) { if (view.node.open && seq === generation) list.replaceChildren(el('p', 'project-error', e.message)); }
  };
  view.content.append(button(t('projects.refresh'), load), list); void load();
}
function antigravityReviewControl(project, isVisible) {
  const policy = window.electronAPI?.antigravityReviewPolicy;
  const node = el('section', 'project-review-policy');
  const label = el('p', 'project-note'); label.id = 'project-review-description';
  const status = el('p', 'project-review-error'); status.setAttribute('role', 'alert');
  let state = null, pending = false;
  const sync = () => {
    node.hidden = !state || !(state.available || state.enabled) || !isVisible();
    const enabled = state?.enabled === true;
    label.textContent = t(enabled ? 'projects.antigravityReviewOn' : 'projects.antigravityReviewOff');
    toggle.textContent = t(enabled ? 'projects.antigravityReviewDisable' : 'projects.antigravityReviewEnable');
    toggle.disabled = pending;
    toggle.setAttribute('aria-pressed', String(enabled));
  };
  const toggle = button('', async () => {
    if (!state || pending || node.hidden) return;
    pending = true; status.textContent = ''; sync();
    try { state = await policy(project.id, !state.enabled); }
    catch { status.textContent = t('projects.saveFailed'); }
    finally { pending = false; sync(); }
  }, 'project-button project-review-toggle');
  toggle.setAttribute('aria-describedby', label.id);
  node.append(toggle, label, status);
  sync();
  if (policy) void policy(project.id).then(value => { state = value; sync(); }).catch(() => {});
  return { node, sync };
}
function newProjectChat(project) {
  if (!project.cwd) { edit(project); return; }
  const projectRoot = project.cwd;
  const view = projectDialog(t('projects.newChat')); if (!view) return;
  view.content.append(el('p', 'project-note', t('projects.newChatHint')));
  const titleField = el('label', 'project-field', t('projects.chatTitle'));
  const title = el('input', 'p-input'); title.name = 'title'; title.maxLength = 100; title.placeholder = t('projects.autoTitle'); titleField.append(title);
  const modelField = el('div', 'project-field'); modelField.append(el('span', '', t('projects.model')));
  const modelToggle = button(t('projects.defaultModel'), () => {
    modelList.hidden = !modelList.hidden; modelToggle.ariaExpanded = String(!modelList.hidden);
    if (!modelList.hidden) { drawModels(); modelSearch.focus(); }
  }, 'project-model-toggle');
  modelToggle.ariaExpanded = 'false';
  const modelList = el('div', 'project-model-list'); modelList.hidden = true;
  const modelSearch = el('input', 'p-input'); modelSearch.type = 'search'; modelSearch.placeholder = t('projects.searchModel'); modelSearch.ariaLabel = t('projects.searchModel');
  const modelOptions = el('div', 'project-model-options'); modelList.append(modelSearch, modelOptions); modelField.append(modelToggle, modelList);
  const thinkingField = el('div', 'project-field'); thinkingField.append(el('span', '', t('model.thinking.title')));
  const levels = el('div', 'project-choices'); thinkingField.append(levels);
  const vpnField = el('div', 'project-field'); vpnField.append(el('span', '', t('network.title')));
  const vpnChoices = el('div', 'project-choices'); vpnField.append(vpnChoices);
  let selectedModel = null, selectedBackend = null, thinking = 'default', proxyEnabled = null;
  let catalog = [], catalogLoaded = false, catalogLoading = false, backends = [];
  const chooseLevel = () => {
    levels.replaceChildren();
    const choices = selectedModel?.thinkingLevels?.length ? ['default', ...selectedModel.thinkingLevels] : ['default'];
    for (const level of choices) {
      const b = button(thinkingLabel(level), () => { thinking = level; chooseLevel(); }, 'project-choice');
      b.ariaPressed = String(thinking === level); b.disabled = busy || !!createdId || !!selectedBackend; levels.append(b);
    }
  };
  const chooseVpn = () => {
    vpnChoices.replaceChildren();
    for (const [value, label] of [[null, 'network.reset'], [true, 'network.on'], [false, 'network.off']]) {
      const b = button(t(label), () => { proxyEnabled = value; chooseVpn(); }, 'project-choice');
      b.ariaPressed = String(proxyEnabled === value); b.disabled = busy || !!createdId || !!selectedBackend; vpnChoices.append(b);
    }
  };
  const chooseModel = (model, backend = null) => {
    if (busy || createdId || (backend && !backends.includes(backend))) return;
    selectedModel = model; selectedBackend = backend; thinking = 'default';
    syncOptions();
    modelToggle.textContent = backend?.label ?? (model ? model.id + ' · ' + model.provider : t('projects.defaultModel'));
    if (backend) modelToggle.setAttribute('aria-describedby', backendHint.id);
    else modelToggle.removeAttribute('aria-describedby');
    modelList.hidden = true; modelToggle.ariaExpanded = 'false'; modelToggle.focus();
  };
  const drawModels = () => {
    const query = modelSearch.value.trim().toLowerCase(); modelOptions.replaceChildren();
    const defaultOption = button(t('projects.defaultModel'), () => chooseModel(null), 'project-model-option');
    defaultOption.ariaPressed = String(!selectedModel && !selectedBackend); modelOptions.append(defaultOption);
    for (const backend of backends.filter(b => b.label.toLowerCase().includes(query))) {
      const b = button(backend.label, () => chooseModel(null, backend), 'project-model-option');
      b.ariaPressed = String(selectedBackend === backend); modelOptions.append(b);
    }
    for (const model of catalog.filter(m => (m.id + ' ' + m.provider).toLowerCase().includes(query))) {
      const b = button('', () => chooseModel(model), 'project-model-option');
      b.append(el('span', '', model.id), el('small', '', model.provider)); b.ariaPressed = String(selectedModel === model); modelOptions.append(b);
    }
    if (catalogLoading) modelOptions.append(el('p', 'project-note', t('projects.loading')));
    else if (!catalogLoaded) modelOptions.append(button(t('projects.retry'), loadModels, 'project-history'));
  };
  const loadModels = async () => {
    if (catalogLoading) return;
    catalogLoading = true; drawModels();
    try {
      const data = await projectApi('/api/models'); if (!view.node.open) return;
      catalog = (data.providers || []).flatMap(p => p.models.map(m => ({ ...m, provider: p.name })));
      catalogLoaded = true;
    } catch {} finally {
      catalogLoading = false;
      if (view.node.open) drawModels();
    }
  };
  const loadBackends = async () => {
    // Fetch independently so either catalog can work if the other is slow or unavailable.
    try {
      const data = await projectApi('/api/projects/session-backends');
      if (!view.node.open || !Array.isArray(data?.backends)) return;
      const ids = new Set();
      backends = data.backends.filter(b => {
        if (typeof b?.id !== 'string' || !b.id.trim() || typeof b.label !== 'string' || !b.label.trim() || ids.has(b.id)) return false;
        ids.add(b.id); return true;
      });
      if (backends.length) drawModels();
    } catch { /* Older hosts may not advertise project backends. */ }
  };
  modelSearch.addEventListener('input', drawModels);
  modelList.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); modelList.hidden = true; modelToggle.ariaExpanded = 'false'; modelToggle.focus(); } });
  const field = el('div', 'project-field'); field.append(el('span', '', t('projects.rootDirectory')), el('p', 'project-directory', projectRoot));
  const option = el('label', 'project-option'), isolated = el('input'); isolated.type = 'checkbox'; isolated.checked = false;
  option.append(isolated, el('span', 'project-option-body', t('projects.independentDirectory')));
  const hint = el('p', 'project-note', t('projects.isolateHint')); hint.hidden = true;
  const backendHint = el('p', 'project-note', t('projects.taskBackendHint'));
  backendHint.id = 'project-task-backend-hint';
  isolated.addEventListener('change', () => { hint.hidden = !!selectedBackend || !isolated.checked; });
  const error = el('p', 'project-error'); error.setAttribute('role', 'alert');
  let busy = false, createdId = '';
  const review = antigravityReviewControl(project, () => selectedBackend?.id === 'google-antigravity');
  const syncOptions = () => {
    const external = !!selectedBackend;
    backendHint.hidden = !external;
    setText(backendHint, t(selectedBackend?.taskProfile === 'inline-review' ? 'projects.inlineReviewHint' : 'projects.taskBackendHint'));
    review.sync();
    // These fields have explicit flex display rules, so hide them visually as well.
    thinkingField.style.display = vpnField.style.display = external ? 'none' : '';
    option.hidden = external;
    hint.hidden = external || !isolated.checked;
    isolated.disabled = busy || !!createdId || external;
    chooseLevel(); chooseVpn();
  };
  const openCreated = () => {
    if (spaEnabled()) switchTo(createdId); else window.location.href = '/' + createdId + '/';
    view.node.close();
  };
  const create = button(t('projects.createIsolated'), async () => {
    if (busy) return;
    if (createdId) { openCreated(); return; }
    // Bind creation to the root displayed when this dialog opened.
    const body = { projectId: project.id, cwd: projectRoot,
      ...(title.value.trim() ? { title: title.value.trim() } : {}),
      ...(selectedBackend ? { backend: selectedBackend.id } : {
        isolated: isolated.checked,
        ...(selectedModel ? { model: selectedModel.id, provider: selectedModel.provider, thinking } : {}),
        ...(proxyEnabled !== null ? { proxyEnabled } : {})
      }) };
    busy = true; error.textContent = ''; create.disabled = true;
    view.close.disabled = title.disabled = modelToggle.disabled = true;
    modelList.hidden = true; modelToggle.ariaExpanded = 'false'; syncOptions();
    try {
      const result = await projectApi('/api/projects/session', body);
      createdId = result.instanceId;
      // The first in-app view must know the backend before session lists refresh.
      if (typeof result.kind === 'string') setSessionKind(createdId, result.kind);
      await loadNetworkPolicy(); await refresh(); await pollStatus(); openCreated();
    } catch (e) {
      if (!createdId && e.instanceId) {
        createdId = e.instanceId;
        // Recovery can open the new view before /sessions lists it as well.
        if (typeof e.kind === 'string') setSessionKind(createdId, e.kind);
      }
      error.textContent = e.message;
      if (createdId) {
        error.textContent += '\n' + t('projects.createdWithError');
        create.textContent = t('projects.openCreatedChat');
      }
    }
    finally {
      busy = false; view.close.disabled = false;
      title.disabled = modelToggle.disabled = !!createdId;
      syncOptions(); create.disabled = false;
    }
  }, 'project-button primary');
  view.node.addEventListener('cancel', ev => { if (busy) ev.preventDefault(); });
  view.content.append(titleField, modelField, backendHint, review.node, thinkingField, vpnField, field, option, hint, error, create);
  syncOptions(); void loadModels(); void loadBackends(); title.focus();
}
export function createProject() { edit(null); }

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
  const review = project ? antigravityReviewControl(project, () => !deleting) : null;
  const deleteOptions = el('div', 'project-delete-options'); deleteOptions.hidden = true;
  const keepLabel = el('label', 'project-option');
  const keep = el('input'); keep.type = 'checkbox'; keep.checked = true;
  keepLabel.append(keep, el('span', '', t('projects.keepChats')));
  const deleteHint = el('p', 'project-note', t('projects.deleteHint'));
  keep.addEventListener('change', () => { deleteHint.textContent = t(keep.checked ? 'projects.deleteHint' : 'projects.deleteAllHint'); });
  deleteOptions.append(keepLabel, deleteHint);
  const save = el("button", "project-button primary", t("projects.save")); save.type = "submit";
  const cancel = button(t("projects.cancel"), () => dialog.close());
  const addConversation = project?.cwd ? button(t("projects.addNewConversation"), () => {
    if (busy || picking || deleting) return;
    currentDialog.addEventListener("close", () => newProjectChat(project), { once: true });
    currentDialog.close();
  }, "project-button project-add-conversation") : null;
  const remove = project ? button(t("projects.delete"), () => {
    if (!deleting) {
      deleting = true; heading.textContent = t("projects.delete"); remove.textContent = t("projects.confirmDelete");
      name.readOnly = true;
      hint.hidden = search.hidden = picker.hidden = save.hidden = directoryLabel.hidden = directoryHint.hidden = browse.hidden = true;
      if (addConversation) addConversation.hidden = true;
      review?.sync();
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
      const sameHub = await applyProjectWrite(Array.isArray(result) ? result : result.projects);
      render(); currentDialog.close();
      if (!sameHub) return; // Deletion receipts apply only to sessions from their Hub.
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
  if (addConversation) form.insertBefore(addConversation, search);
  if (review) form.insertBefore(review.node, search);
  // Modal keyboard actions must not reach global shortcuts (Escape cancels a turn).
  dialog.addEventListener("keydown", ev => ev.stopPropagation());
  dialog.addEventListener("cancel", ev => { if (busy) ev.preventDefault(); });
  dialog.addEventListener("close", () => { currentDialog.remove(); dialog = null; if (opener?.isConnected) opener.focus(); else document.getElementById("sidebar-view-select")?.focus(); });
  document.body.append(dialog); dialog.showModal(); name.focus();
}
if (root) {
  effect(() => { allSessions.value; activeSessionId.value; networkPolicy.value; render(); });
  document.addEventListener("langchange", render);
  window.addEventListener("focus", () => { if (visible && !dialog) void loadSidebarProjects().catch(() => {}); });
  document.addEventListener("focusin", () => { ++focusRevision; });
  document.addEventListener("ash:host-state-changed", event => {
    const domains = event.detail?.domains;
    if (Array.isArray(domains) && !domains.some(kind => kind === "sessions" || kind === "projects")) return;
    // Discard requests from before the host invalidation, including a poll
    // that is still pending when a new host epoch appears. The dialog lives
    // outside this list, so its drafts and focus survive the background read.
    ++hostReadRevision; ++generation; ++statusGeneration; ++groupReadSeq; ++statusReadSeq; ++workspaceReadSeq;
    refreshRead = pollRead = sessionsRead = null;
    loading = groupPolling = polling = workspacePolling = false;
    if (!visible) return;
    void refresh({ background: true });
    void pollStatus({ force: true, groups: false });
  });
}
