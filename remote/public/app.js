/* The remote UI has no kernel or secrets: all effects are delegated to the local Hub. */
const { toolActivityKey, usageMetrics } = globalThis.AsHubConversationPresentation;
const { toolDisplayName, thinkingPreview, renderThinkingContent, activityTimestamp, renderActivityTime, diagnosticState, turnLifecycle, activityState } = globalThis.AsHubConversationPresentation;
const $ = id => document.getElementById(id);
const base = new URL('./', location.href);
let user = '', device = '', session = '', devices = [], sessions = [], source, generation = 0, poll, authMode = 'login';
let deviceListReady = false, sessionListDevice = '';
// Device reachability and completion of this subscription's replay are distinct.
const SYNC_WAIT_MS = 12000;
const streamViewer = crypto.randomUUID();
let streamAttempt = 0, streamRenewal;
let syncPhase = 'idle', syncWait = null, syncTimer = null, reconnectTimer = null, reconnectAttempt = 0, pageSuspended = false;
const viewHidden = () => document.hidden || pageSuspended;
const onlineDevice = () => devices.some(d => d.id === device && d.online);
const ownsSyncWait = wait => !!wait && wait.generation === generation && wait.device === device && wait.session === session;
function clearSyncTimers() {
  clearTimeout(syncTimer); syncTimer = null;
  clearTimeout(reconnectTimer); reconnectTimer = null;
}
function renderConnectionStatus() {
  const d = devices.find(d => d.id === device);
  const waiting = !streamReady && ownsSyncWait(syncWait) && !viewHidden() && !!d?.online && !!session;
  const overdue = waiting && Date.now() - syncWait.started >= SYNC_WAIT_MS;
  const limited = !!d?.online && !!session && syncPhase === 'limited';
  let title = '', hint = '';
  if (!d) { title = '尚未绑定电脑'; hint = '在桌面端打开「设备互联 → 允许其他设备访问本机」，登录同一账号并确认共享目录。'; }
  else if (!d.online) { title = '电脑离线'; hint = '请保持电脑联网、asHub 运行，并在「设备互联 → 允许其他设备访问本机」开启共享。草稿已保留。'; }
  else if (!session) title = '电脑在线 · 请选择对话';
  else if (viewHidden() || syncPhase === 'paused') { title = '连接已暂停，等待重新同步'; hint = '返回页面后自动同步；草稿已保留。'; }
  else if (streamReady) title = '已同步 · 在电脑上执行';
  else if (limited) { title = '打开的远控对话过多'; hint = '请关闭一个不用的远控对话窗口，然后重新同步。草稿与发送回执已保留。'; }
  else if (syncPhase === 'reconnecting') { title = '连接中断，正在自动重连…'; hint = overdue ? '仍未完成同步。可检查手机网络，或重新同步此对话；不会重发消息。' : '请检查手机网络，连接恢复后会自动同步。草稿已保留。'; }
  else { title = '正在同步对话…'; hint = overdue ? '同步用时较长，可重新同步此对话；草稿和待确认的发送状态会保留。' : '电脑在线，正在读取当前对话，请稍候。'; }
  if ($('connection').textContent !== title) $('connection').textContent = title;
  $('connection').dataset.state = !d ? 'unbound' : !d.online ? 'offline' : !session ? 'idle' : viewHidden() || syncPhase === 'paused' ? 'paused' : streamReady ? 'ready' : syncPhase;
  if ($('sync-help') && $('sync-help').textContent !== hint) $('sync-help').textContent = hint;
  if ($('sync-status')) $('sync-status').hidden = !session || !hint || viewHidden();
  if ($('sync-retry')) { $('sync-retry').hidden = !overdue && !limited; $('sync-retry').disabled = !overdue && !limited; }
}
function beginSync(phase, preserve = false) {
  const previous = preserve && ownsSyncWait(syncWait) ? syncWait : null;
  clearTimeout(syncTimer); syncTimer = null;
  streamReady = false; syncPhase = phase;
  // A fresh object also invalidates callbacks already queued by a cleared timer.
  syncWait = session && onlineDevice() && !viewHidden() ? {
    generation, device, session, started: previous?.started ?? Date.now(),
  } : null;
  const wait = syncWait;
  const arm = () => {
    if (syncWait !== wait || !ownsSyncWait(wait) || streamReady || viewHidden() || !onlineDevice()) return;
    const remaining = SYNC_WAIT_MS - (Date.now() - wait.started);
    if (remaining > 0) syncTimer = setTimeout(arm, remaining);
    else { syncTimer = null; renderConnectionStatus(); }
  };
  arm(); renderConnectionStatus(); controls();
}
function finishSync() {
  clearSyncTimers(); syncWait = null; syncPhase = 'ready'; reconnectAttempt = 0;
  streamReady = true; streamPaused = false; renderConnectionStatus();
}

let liveSegment = false, authGeneration = 0, authSubmitting = false, pendingSend = null, deviceRequest = 0;
let reply = null, activity = false, details = null, images = [], sending = false, streamReady = false, renderTimer;
let activityEventTime = null;
const permissions = new Map();
const pendingDecisions = new Set();
const sessionActionBusy = new Set();
const permissionRecords = new Map();
let pluginEntries = [], pluginResourceDispose = null;
let groups = [], viewFilter = 'browse', capabilities = {}, capabilitiesDevice = '', catalogRequest = 0, taskView = 0;
let modelInfo = {}, modelRevision = 0, modelPicker = null, todo = null, turnOutcome = '', usage = null;
const phases = new Set(), toolSteps = new Map();
// Ownership follows the displayed history, independently of active-work maps.
// Completed/previous-turn rows can still receive buffered output or results.
const diagnosticOwners = new Map();
const subagentLaunchOwners = new Map();
const agentSteps = new Map(), activityNode = $('activity'), activityText = $('activity-text');
let requestPhase = '', responseStreaming = false, streamPaused = false, recordsDirty = false;
const requestLabels = { sending: '正在发送上下文并等待响应', waiting: '已连接，正在等待回复', retrying: '正在重试连接' };
// Writes and removals remain authoritative for this page even if persistence fails.
const memoryStorage = new Map(), inFlightSends = new Map(), pendingChecks = new Map();
const storage = {
  get(k) { if (memoryStorage.has(k)) return memoryStorage.get(k); try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { memoryStorage.set(k, String(v)); try { localStorage.setItem(k, v); } catch {} },
  remove(k) { memoryStorage.set(k, null); try { localStorage.removeItem(k); } catch {} }
};
const key = suffix => `ashub-mobile:${user}:${device}:${session}:${suffix}`;
// Navigation stores IDs only. All labels and access come from fresh authorized catalogs.
let navigation = { recent: [], expanded: [], collapsed: [], last: '' }, restoreSession = false, navigationTouched = false;
const navigationKey = () => `ashub-mobile-navigation:${user}:${device}`;
const preferredDeviceKey = () => `ashub-mobile-device:${user}`;
function cancelSessionRestore() {
  // Explicit navigation wins even when the device/catalog is not loaded yet.
  navigationTouched = true; restoreSession = false;
}
function loadNavigation() {
  let saved; try { saved = JSON.parse(storage.get(navigationKey()) || '{}'); } catch {}
  const ids = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id.length <= 200))].slice(0, 100) : [];
  navigation = { recent: ids(saved?.recent).slice(0, 6), expanded: ids(saved?.expanded), collapsed: ids(saved?.collapsed), last: typeof saved?.last === 'string' ? saved.last : '' };
  restoreSession = !navigationTouched && !!navigation.last;
}
function saveNavigation() {
  if (user && device) storage.set(navigationKey(), JSON.stringify(navigation));
}
function projectFor(s) {
  return s && (s.projectId !== undefined ? groups.find(p => p.id === s.projectId) : groups.find(p => p.sessionIds.includes(s.instanceId)));
}
function pluginEntryFor(id) {
  return pluginEntries.find(entry => entry.sessionId === id);
}
function pluginEntryIsShared(entry) {
  return sessions.some(s => s.instanceId === entry.sessionId)
    && pluginEntries.some(e => e.sessionId === entry.sessionId && e.pluginId === entry.pluginId
      && e.key === entry.key && e.resource === entry.resource);
}
function projectMembers(project) {
  const members = sessions.filter(s => !pluginEntryFor(s.instanceId) && (s.projectId !== undefined ? s.projectId === project.id : project.sessionIds.includes(s.instanceId)));
  const pins = new Map((project.pinnedSessionIds || []).filter(id => members.some(s => s.instanceId === id)).map((id, i) => [id, i]));
  return members.sort((a, b) => (pins.get(a.instanceId) ?? pins.size) - (pins.get(b.instanceId) ?? pins.size));
}
function syncChatTitle() {
  const current = sessions.find(s => s.instanceId === session), project = projectFor(current);
  $('chat-title').textContent = session ? (current?.title || '新对话') : '';
  const entry = pluginEntryFor(session), label = $('chat-project');
  if (label) { label.textContent = entry?.description || project?.name || ''; label.hidden = !label.textContent; }
}
function rememberSession(id) {
  navigation.last = id;
  navigation.recent = [id, ...navigation.recent.filter(s => s !== id)].slice(0, 6);
  const project = projectFor(sessions.find(s => s.instanceId === id));
  if (project) {
    navigation.expanded = [...new Set([...navigation.expanded, project.id])].slice(-100);
    navigation.collapsed = navigation.collapsed.filter(p => p !== project.id);
  }
  saveNavigation();
}
function setTheme() {
  const saved = storage.get('ashub-mobile-theme');
  const theme = ['light', 'dark'].includes(saved) ? saved : (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#272824' : '#f4f2ec');
}
function toggleTheme() { storage.set('ashub-mobile-theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); setTheme(); }
setTheme(); $('theme').onclick = $('auth-theme').onclick = toggleTheme;
if ($('selection-theme')) $('selection-theme').onclick = toggleTheme;
function notice(message = '') {
  $('notice').textContent = message; $('notice').hidden = !message;
  if ($('selection-notice')) { $('selection-notice').textContent = message; $('selection-notice').hidden = !message; }
  syncWorkspaceView();
}
async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  const authEpoch = authGeneration;
  const r = await fetch(new URL('api/' + route, base), { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000), cache: 'no-store' });
  if (r.ok) return r.json();
  // Gateway errors can arrive as HTML. Keep the HTTP status for recovery.
  const result = await r.json().catch(() => null);
  if (r.status === 401 && user && authEpoch === authGeneration) signOut();
  throw Object.assign(Error(result?.error || '请求失败'), { status: r.status });
}
const rpc = (op, args = {}, target = device) => api(`devices/${target}/rpc`, { op, args });
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
let artifactDownload = null;
function closeArtifactDownload() {
  const pending = artifactDownload; artifactDownload = null;
  pending?.controller.abort();
  if (pending?.objectURL) URL.revokeObjectURL(pending.objectURL);
}
$('modal').addEventListener?.('close', () => { if (!$('modal').open) {closeArtifactDownload();pluginResourceDispose?.();pluginResourceDispose=null;} });
function modal(title, contents) { pluginResourceDispose?.();pluginResourceDispose=null; cancelSessionRestore(); closeArtifactDownload(); modelPicker = null; $('modal').classList.toggle('model-dialog', false); taskView++; $('modal-title').textContent = title; $('modal-body').replaceChildren(...contents); if (!$('modal').open) $('modal').showModal(); }
$('modal-close').onclick = () => $('modal').close();
function button(label, action, cls = 'choice') { const b = el('button', label, cls), epoch = authGeneration; b.onclick = async () => { if (epoch !== authGeneration) return; b.disabled = true; try { await action(); } catch (e) { if (epoch === authGeneration) notice(e.message); } finally { b.disabled = false; } }; return b; }
function recovery(code) { modal('保存账号恢复码', [el('p', '仅显示一次，请保存在安全的位置。恢复账号会撤销所有已绑定设备。'), el('pre', code), button('已保存', () => $('modal').close())]); }
function auth(mode) { authMode = mode; $('recover-field').hidden = mode !== 'recover'; $('auth-title').textContent = { login: '回到你的工作空间', register: '创建你的 asHub 账号', recover: '找回你的工作空间' }[mode]; $('auth-submit').textContent = { login: '登录', register: '创建账号', recover: '重设密码' }[mode]; $('auth-mode').textContent = mode === 'login' ? '创建账号' : '返回登录'; $('auth-caption').textContent = mode === 'recover' ? '输入新密码和首次注册时保存的恢复码' : '登录后，连接已绑定的电脑'; $('auth-error').textContent = ''; }
$('auth-mode').onclick = () => auth(authMode === 'login' ? 'register' : 'login'); $('recover-mode').onclick = () => auth('recover');
$('login-form').onsubmit = async e => {
  e.preventDefault(); if (authSubmitting) return;
  const mode = authMode; authSubmitting = true;
  for (const id of ['auth-submit', 'auth-mode', 'recover-mode']) $(id).disabled = true;
  $('auth-error').textContent = '';
  try {
    const b = Object.fromEntries(new FormData(e.target)), result = await api(mode, b);
    e.target.reset();
    if (mode === 'recover') { auth('login'); recovery(result.recovery); }
    else { await start(result.username); if (result.recovery) recovery(result.recovery); }
  } catch (e) { $('auth-error').textContent = e.message; } finally { authSubmitting = false; for (const id of ['auth-submit', 'auth-mode', 'recover-mode']) $(id).disabled = false; }
};
function closeSource({retainWait = false} = {}) {
  clearInterval(streamRenewal); streamRenewal = null;
  clearSyncTimers(); if (!retainWait) { syncWait = null; reconnectAttempt = 0; }
  syncPhase = 'paused';
  clearFrameQueue(); source?.close(); source = null; streamReady = false; streamPaused = true;
  refreshProgress(true); controls();
  // Visibility changes also close the stream. Do not leave an apparently
  // synced composer usable while foreground device refresh is still pending.
  renderConnectionStatus();
}
function signOut() {
  composerMedia?.cancel(); saveDraft(); pendingChecks.clear(); authGeneration++; generation++; globalThis.AsHubFilePreview?.close(); menu(false); closeSource(); clearInterval(poll); poll = null;
  user = ''; device = ''; session = ''; devices = []; sessions = []; groups = []; viewFilter = 'browse'; capabilities = {}; capabilitiesDevice = ''; catalogRequest++; taskView++; images = []; sending = false; pendingSend = null;
  resetPluginEntries(); renderPluginEntries();
  deviceListReady = false; sessionListDevice = ''; navigation = {recent: [], expanded: [], collapsed: [], last: ''}; restoreSession = false; navigationTouched = false;
  resetMessages(); renderAttachments(); notice();
  for (const id of ['sessions', 'devices', 'modal-body']) $(id).replaceChildren();
  for (const id of ['chat-title', 'chat-project', 'device-status', 'connection', 'modal-title']) { if ($(id)) $(id).textContent = ''; }
  if ($('chat-project')) $('chat-project').hidden = true;
  $('model').textContent = '模型'; $('query').value = ''; $('session-search').value = ''; sessionSearchExpanded = false; syncSessionSearch(); $('image-input').value = ''; $('new-chat').disabled = true;
  $('workspace').hidden = true; $('auth').hidden = false; $('modal').close();
}
async function start(name) {
  signOut(); user = name; $('auth').hidden = true; $('workspace').hidden = false; syncWorkspaceView();
  const epoch = authGeneration;
  const refresh = async () => { try { await refreshDevices(); } catch (e) { if (user && epoch === authGeneration) notice(e.message); } };
  // Recovery must stay active even if the first request fails.
  poll = setInterval(() => { if (!viewHidden() && epoch === authGeneration) void refresh(); }, 15000);
  await refresh();
}
// Reuse the same device/session controls as the mobile landing page. There is
// no hidden second list to drift out of sync with polling, filters or actions.
function syncWorkspaceView() {
  const choosing = !session;
  $('workspace').classList.toggle('choosing-session', choosing);
  if (choosing) document.body.classList.toggle('menu-open', false);
  const open = document.body.classList.contains('menu-open');
  $('shade').hidden = !open;
  $('menu').setAttribute('aria-expanded', String(open));
  $('sidebar').inert = matchMedia('(max-width:760px)').matches && !choosing && !open;
  const d = devices.find(d => d.id === device);
  $('devices').disabled = devices.length <= 1;
  $('sidebar').classList.toggle('single-device', devices.length === 1);
  if (!devices.length) {
    const option = el('option', deviceListReady ? '尚未绑定电脑' : '正在读取设备…'); option.value = '';
    $('devices').replaceChildren(option);
  }
  const state = $('selection-state');
  if (!state) return; // Support a previously cached HTML shell during upgrades.
  const message = !deviceListReady ? '正在读取设备…'
    : !d ? '在桌面端打开「设备互联 → 允许其他设备访问本机」，登录同一账号并确认共享目录'
    : !d.online ? '电脑离线，请保持电脑联网、asHub 运行，并在「设备互联 → 允许其他设备访问本机」开启共享'
    : sessionListDevice !== device ? '正在读取共享对话…'
    : !sessions.length ? '暂无共享对话。请在桌面端「设备互联 → 允许其他设备访问本机 → 设置共享目录」添加对话的工作目录并确认授权，也可新建对话'
    : '';
  state.textContent = message;
  state.hidden = !message || (!!$('notice').textContent && (!deviceListReady || (d?.online && sessionListDevice !== device)));
}
function menu(open) {
  document.body.classList.toggle('menu-open', open);
  syncWorkspaceView();
}
const mobileLayout = matchMedia('(max-width:760px)');
mobileLayout.addEventListener?.('change', () => menu(false));
menu(false);
document.addEventListener('keydown', event => { readingKey(event); if (event.key === 'Escape' && document.body.classList.contains('menu-open')) { menu(false); $('menu').focus(); } });
const appDisplay = matchMedia('(display-mode: standalone)');
const inPwa = () => appDisplay.matches || navigator.standalone === true;
function updateAppGestures() {
  document.documentElement.dataset.pwa = String(inPwa());
  document.querySelector('meta[name="viewport"]')?.setAttribute('content',
    'width=device-width, initial-scale=1, viewport-fit=cover' + (inPwa() ? ', maximum-scale=1, user-scalable=no' : ''));
}
appDisplay.addEventListener?.('change', updateAppGestures); updateAppGestures();
for (const name of ['gesturestart', 'gesturechange']) document.addEventListener(name, event => {
  if (inPwa()) event.preventDefault();
}, {passive:false});
document.addEventListener('touchmove', event => {
  if (inPwa() && event.touches.length > 1) event.preventDefault();
}, {passive:false});
function viewportSize() {
  if (!window.visualViewport || window.visualViewport.scale !== 1) return;
  document.documentElement.style.setProperty('--viewport-height', window.visualViewport.height + 'px');
  document.documentElement.style.setProperty('--viewport-top', Math.max(0, window.visualViewport.offsetTop || 0) + 'px');
}
window.visualViewport?.addEventListener('resize', viewportSize);
window.visualViewport?.addEventListener('scroll', viewportSize);
// A suspended PWA may miss keyboard resize/pan events. Re-read geometry on
// return without changing focus, drafts or the reader's scroll intent.
window.addEventListener('pageshow', viewportSize);
document.addEventListener('visibilitychange', () => { if (!document.hidden) viewportSize(); });
viewportSize();
$('menu').onclick = () => menu(true); $('shade').onclick = $('close-sidebar').onclick = () => menu(false);
async function refreshDevices() {
  if (!session) notice();
  const epoch = authGeneration, request = ++deviceRequest; let g = generation;
  // Polling, manual refresh and foreground recovery can overlap. Only the
  // latest request may change connectivity or surface a connection warning.
  const current = () => user && epoch === authGeneration && g === generation && request === deviceRequest;
  const onFailure = error => { if (current()) throw error; };
  const list = await api('devices').catch(onFailure); if (!current()) return; devices = list; deviceListReady = true;
  $('devices').replaceChildren(...devices.map(d => { const o = el('option', d.name + (d.online ? '' : ' · 离线')); o.value = d.id; return o; }));
  if (device && !devices.some(d => d.id === device)) { resetDevice(''); g = generation; }
  if (!device && devices.length) {
    const saved = storage.get(preferredDeviceKey());
    device = devices.find(d => d.id === saved)?.id || devices.find(d => d.online)?.id || devices[0].id;
    loadNavigation();
    storage.set(preferredDeviceKey(), device);
  }
  $('devices').value = device;
  if (!session && !$('messages').children.length) { const empty = el('div', undefined, 'empty'); empty.append(el('h2', '工作，在这里接着展开'), el('p', '打开左上角会话列表，选择对话或开始新的思考')); $('messages').append(empty); }
  const d = devices.find(d => d.id === device);
  $('device-status').textContent = d ? (d.online ? '● 电脑在线' : '○ 电脑离线') : '尚未绑定电脑';
  $('new-chat').disabled = !d?.online; controls();
  if (!d?.online) { catalogRequest++; closeSource(); controls(); return; }
  await refreshSessions().catch(onFailure); if (current() && session && !source && !viewHidden()) resumeStream();
}
function sessionStatus(s) {
  if (s.waitingApproval) return ['approval', '需要确认'];
  if (s.isProcessing) return ['running', '正在处理'];
  if (s.lastTurnError) return ['failed', '回复中断'];
  if (s.hasUnread) return ['unread', '有新回复'];
  if (s.queuedCount > 0) return ['queued', `${s.queuedCount} 条排队中`];
  return ['idle', ''];
}
function sessionRow(s, project, context = false) {
  const did = device;
  const b = button('', () => { if (did === device) return openSession(s.instanceId); }, 'session-button' + (s.instanceId === session ? ' active' : ''));
  b.dataset.sessionId = s.instanceId; b.dataset.navKey = 'session:' + (project?.id || '') + ':' + s.instanceId;
  b.setAttribute('aria-current', s.instanceId === session ? 'page' : 'false');
  const [status, label] = sessionStatus(s); b.dataset.status = status;
  const title = el('span', s.title || '新对话', 'session-name');
  if (project?.pinnedSessionIds?.includes(s.instanceId)) {
    const marker = el('span', '置顶', 'session-pin'); marker.title = '已在电脑端置顶'; title.append(marker);
  }
  b.append(title);
  const caption = [context ? (pluginEntryFor(s.instanceId)?.label || project?.name || (s.projectId ? '项目对话' : '独立对话')) : '', label].filter(Boolean).join(' · ');
  if (caption) b.append(el('small', caption));
  if (project && s.cwd && (s.projectExternal ?? (project.sessionIds.map(id => sessions.find(s => s.instanceId === id)).find(s => s?.cwd)?.cwd !== s.cwd))) {
    const row = el('div', undefined, 'session-entry'); row.dataset.sessionId = s.instanceId; row._sessionButton = b;
    const folder = s.cwd.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || s.cwd;
    const directory = button('其他目录 · ' + folder, () => { if (did === device) modal('工作目录', [el('p', s.cwd, 'directory-detail')]); }, 'session-directory');
    directory.title = s.cwd; directory.setAttribute('aria-label', '查看工作目录：' + s.cwd);
    row.append(b, directory); return row;
  }
  return b;
}
function renderNavigation() {
  const nodes = [], recent = navigation.recent.map(id => sessions.find(s => s.instanceId === id)).filter(s => s && !pluginEntryFor(s.instanceId)).slice(0, 3);
  if (recent.length) {
    nodes.push(el('p', '最近使用', 'nav-section-label'));
    nodes.push(...recent.map(s => { const row = sessionRow(s, projectFor(s), true); const b = row._sessionButton || row; b.dataset.navKey = 'recent:' + s.instanceId; return row; }));
  }
  const section = (id, title, members, project) => {
    const group = el('section', undefined, 'nav-group'); group.dataset.groupId = id;
    const opened = navigation.expanded.includes(id) || (!navigation.collapsed.includes(id) && (project ? projectFor(sessions.find(s => s.instanceId === (session || navigation.last)))?.id === id : !groups.length));
    const did = device, epoch = authGeneration;
    const toggle = el('button', '', 'nav-group-toggle');
    toggle.type = 'button';
    // Keep focus on this synchronous control so renderSessions can restore it.
    toggle.onclick = () => {
      if (epoch !== authGeneration || did !== device) return;
      cancelSessionRestore();
      if (opened) { navigation.expanded = navigation.expanded.filter(p => p !== id); navigation.collapsed = [...new Set([...navigation.collapsed, id])].slice(-100); }
      else { navigation.collapsed = navigation.collapsed.filter(p => p !== id); navigation.expanded = [...new Set([...navigation.expanded, id])].slice(-100); }
      saveNavigation(); renderSessions();
    };
    toggle.dataset.navKey = 'group:' + id; toggle.setAttribute('aria-expanded', String(opened));
    toggle.append(el('span', '›', 'nav-chevron'), el('span', title, 'nav-group-name'), el('small', String(members.length), 'nav-count'));
    group.append(toggle);
    if (Array.isArray(project?.activities)) for (const a of project.activities) group.append(el('small', a.label, 'nav-work-status'));
    if (opened) {
      const body = el('div', undefined, 'nav-members');
      if (project && capabilities.tasks) {
        const tasks = button('协作任务', () => { if (did === device) return showTasks(project); }, 'nav-project-tasks');
        tasks.dataset.navKey = 'tasks:' + id; body.append(tasks);
      }
      body.append(...members.map(s => sessionRow(s, project)));
      if (!members.length) {
        const hasDedicatedEntry = project && sessions.some(s => projectFor(s)?.id === id && pluginEntryFor(s.instanceId));
        body.append(el('p', hasDedicatedEntry ? '暂无其他共享对话' : '暂无共享对话，请在桌面端「设备互联 → 允许其他设备访问本机 → 设置共享目录」检查工作目录。', 'empty-list'));
      }
      group.append(body);
    }
    return group;
  };
  if (groups.length) nodes.push(el('p', '项目', 'nav-section-label'));
  nodes.push(...groups.map(p => section(p.id, p.name, projectMembers(p), p)));
  const independent = sessions.filter(s => !pluginEntryFor(s.instanceId) && (s.projectId !== undefined ? !s.projectId : !projectFor(s)));
  if (independent.length) nodes.push(section('@independent', '独立对话', independent));
  // A failed project catalog must not make already-authorized sessions inaccessible.
  const unlisted = sessions.filter(s => s.projectId && !projectFor(s) && !pluginEntryFor(s.instanceId));
  if (unlisted.length) { nodes.push(el('p', '项目对话 · 信息待同步', 'nav-section-label')); nodes.push(...unlisted.map(s => sessionRow(s, null))); }
  return nodes;
}
function syncSessionActions() {
  const control = $('session-actions'); if (!control) return;
  control.hidden = !session || !(capabilities.sessionNetwork || capabilities.sessionDelete || pluginEntries.some(e=>e.sessionId===session));
  control.disabled = !devices.some(d => d.id === device && d.online) || sessionActionBusy.has(key('settings'));
}
async function showSessionActions() {
  if (!session || !(capabilities.sessionNetwork || capabilities.sessionDelete || pluginEntries.some(e=>e.sessionId===session)) || !devices.some(d => d.id === device && d.online) || sessionActionBusy.has(key('settings'))) return;
  const did = device, sid = session, g = generation, owner = key('settings');
  const title = sessions.find(s => s.instanceId === sid)?.title || '新对话';
  const content = el('div', undefined, 'session-settings');
  content.append(el('p', title, 'session-settings-name'));
  modal('对话设置', [content]); const ticket = taskView;
  const valid = () => device === did && session === sid && g === generation && ticket === taskView && $('modal').open;
  const error = el('p', '', 'picker-error'); error.setAttribute('role', 'status');
  const buttons = []; let busy = false, policy = null, status, choices;
  function render() {
    for (const b of buttons) b.disabled = busy || !devices.some(d => d.id === did && d.online);
    if (!choices) return;
    for (const b of choices.children) { b.disabled = busy || !policy || !devices.some(d => d.id === did && d.online); b.setAttribute('aria-pressed', String(!!policy && b._value === policy.enabled)); }
    status.textContent = policy ? `当前${policy.effective ? '使用代理' : '直接联网'}${policy.enabled === null ? ' · 跟随全局设置' : ''}` : '正在读取设置…';
  }
  function checked(value) {
    if (value?.session !== sid || ![true, false, null].includes(value.enabled) || typeof value.effective !== 'boolean' || typeof value.globalEnabled !== 'boolean') throw Error('无法读取 VPN 设置，请重试');
    return value;
  }
  async function network(enabled, write = false) {
    if (!valid() || busy) return;
    busy = true; error.textContent = '';
    if (write) { sessionActionBusy.add(owner); syncSessionActions(); }
    render();
    try {
      const result = await rpc(write ? 'set-session-network' : 'session-network', {session: sid, ...(write ? {enabled} : {})}, did);
      if (valid()) policy = checked(result);
    } catch (e) { if (valid()) { error.textContent = e.message; if (!policy) status.textContent = '暂时无法读取'; } }
    finally { busy = false; if (write) sessionActionBusy.delete(owner); syncSessionActions(); if (valid()) { render(); if (!policy) status.textContent = '暂时无法读取'; } }
  }

  if (capabilities.sessionNetwork) {
    const section = el('section', undefined, 'session-settings-network');
    section.append(el('h3', 'VPN / 代理'));
    choices = el('div', undefined, 'session-network-options'); choices.setAttribute('role','group'); choices.setAttribute('aria-label','对话 VPN 设置');
    for (const [value,label] of [[null,'跟随全局'],[true,'开启'],[false,'关闭']]) {
      const b = button(label, () => network(value, true), 'session-network-choice'); b._value = value; choices.append(b);
    }
    status = el('p', '', 'session-network-status');
    const refresh = button('重新读取', () => network(), 'text-button'); buttons.push(refresh);
    section.append(choices, status, el('p','仅控制此对话是否使用 asHub 代理，不开关系统 VPN；修改用于后续网络请求，不会重启当前回复。','session-settings-note'), refresh); content.append(section);
  }
  if (capabilities.sessionDelete) {
    const remove = button('删除对话', () => { if (valid() && !busy) confirmSessionDeletion(did, sid, title); }, 'session-delete-button');
    buttons.push(remove); content.append(remove);
  }
  content.append(error); render();
  if (capabilities.sessionNetwork) await network();
}
function confirmSessionDeletion(did, sid, title) {
  const g = generation, owner = key('settings'), draftKey = key('draft');
  const requestId = crypto.randomUUID();
  const note = el('p', '将永久删除此对话及其历史记录，桌面端同步删除。正在运行的任务会停止；工作目录中的文件不会删除。', 'session-settings-note');
  const error = el('p', '', 'picker-error'); error.setAttribute('role','status');
  let busy = false;
  const cancel = button('取消', () => { if (!busy) $('modal').close(); }, 'choice');
  const confirm = button('确认删除', async () => {
    if (!valid() || busy) return;
    busy = true; sessionActionBusy.add(owner); syncSessionActions(); confirm.disabled = cancel.disabled = true; error.textContent = '';
    try {
      await rpc('session-delete', {session:sid, confirm:true, requestId}, did);
      const result = await waitRequest(requestId, did);
      if (!result?.ok) throw Error('删除结果未确认，请重试查询');
      if (!valid()) return;
      resetSession(); sessions = sessions.filter(s => s.instanceId !== sid);
      navigation.recent = navigation.recent.filter(id => id !== sid); if (navigation.last === sid) navigation.last = ''; saveNavigation();
      storage.remove(draftKey); storage.remove(draftKey + ':images'); imageDrafts.delete(draftKey); renderSessions();
      const after = generation;
      try { await refreshSessions(); } catch (e) { if (generation === after && device === did) notice('对话已删除，列表暂时无法刷新：' + e.message); }
    } catch (e) { if (valid()) { error.textContent = e.message; confirm.textContent = '重试确认'; } }
    finally { busy = false; sessionActionBusy.delete(owner); syncSessionActions(); if (valid()) confirm.disabled = cancel.disabled = false; }
  }, 'choice session-delete-button');
  modal('删除对话？', [el('p', title, 'session-settings-name'), note, error, cancel, confirm]);
  const ticket = taskView;
  const valid = () => device === did && session === sid && generation === g && taskView === ticket && $('modal').open;
}
if ($('session-actions')) $('session-actions').onclick = showSessionActions;
let pluginEntryControls=[];
function resetPluginEntries() {
  pluginEntries = [];
  pluginResourceDispose?.();
  pluginResourceDispose = null;
}
function renderPluginEntries() {
  let host=$('plugin-entries');if(!host){host=el('nav','','plugin-entries');host.id='plugin-entries';$('sessions').before(host);}
  const live=pluginEntries.filter(e=>sessions.some(s=>s.instanceId===e.sessionId));
  for(const row of host.children){const active=row.dataset.sessionId===session;row.dataset.active=String(active);const b=row.querySelector('.plugin-entry-open');if(active)b?.setAttribute('aria-current','page');else b?.removeAttribute('aria-current');}
  const signature=JSON.stringify([device,generation,live]);if(host._signature===signature)return;host._signature=signature;
  for(const dispose of pluginEntryControls)dispose();pluginEntryControls=[];
  host.hidden=!live.length;host.replaceChildren(...live.map(e=>{
    const row=el('div','','plugin-entry');row.dataset.active=String(e.sessionId===session);row.dataset.sessionId=e.sessionId;
    const did=device,g=generation;
    const valid=()=>device===did&&generation===g&&pluginEntryIsShared(e);
    const open=button(e.label,()=>{if(valid())return openSession(e.sessionId);},'plugin-entry-open');if(e.sessionId===session)open.setAttribute('aria-current','page');
    const control=el('div','','plugin-entry-control');
    row.append(open,control);
    void import('./plugin-resource-view.js').then(({mountResource})=>{if(!valid()||!control.isConnected)return;pluginEntryControls.push(mountResource(control,{pluginId:e.pluginId},e.resource,{inlineToggle:true,onManage:()=>{if(valid())void openPluginResource(e);},
      request:async(body,signal)=>{
        if(!valid()||signal.aborted)throw Error('页面已切换');const requestId=body?crypto.randomUUID():undefined;
        let result=await rpc('plugin-resource',{session:e.sessionId,pluginId:e.pluginId,resourceId:e.resource,...(body?{body,requestId}:{})},did);
        if(body){const receipt=result.state==='done'?result.result:await waitRequest(requestId,did);if(!valid()||signal.aborted)throw Error('页面已切换');result=await rpc('plugin-resource',{session:e.sessionId,pluginId:e.pluginId,resourceId:e.resource,receipt:receipt.resourceReceipt},did);}
        if(!valid()||signal.aborted)throw Error('页面已切换');return result;
      }}));}).catch(error=>{if(valid()&&control.isConnected)control.textContent='暂不可用';});
    return row;
  }));
}
async function openPluginResource(entry){
  const did=device,sid=entry.sessionId,g=generation;
  const container=el('div','','plugin-resource-container');modal(entry.label,[container]);const ticket=taskView;
  const valid=()=>did===device && g===generation && ticket===taskView && $('modal').open && pluginEntryIsShared(entry);
  try{
    const {mountResource}=await import('./plugin-resource-view.js');if(!valid())return;
    pluginResourceDispose=mountResource(container,{pluginId:entry.pluginId},entry.resource,{
      request:async(body,signal)=>{if(!valid()||signal.aborted)throw Error('页面已切换');const requestId=body?crypto.randomUUID():undefined;
        let result=await rpc('plugin-resource',{session:sid,pluginId:entry.pluginId,resourceId:entry.resource,...(body?{body,requestId}:{})},did);
        if(body){const receipt=result.state==='done'?result.result:await waitRequest(requestId,did);if(!valid()||signal.aborted)throw Error('页面已切换');result=await rpc('plugin-resource',{session:sid,pluginId:entry.pluginId,resourceId:entry.resource,receipt:receipt.resourceReceipt},did);}
        if(!valid()||signal.aborted)throw Error('页面已切换');return result;},
      openConversation:id=>{if(valid()&&id===sid){$('modal').close();void openSession(id);}}
    });
  }catch(e){if(valid())container.textContent=e.message;}
}
function renderSessions() {
  renderPluginEntries();
  syncSessionSearch(); syncWorkspaceView(); syncChatTitle(); syncSessionActions();
  const selected = groups.find(p => 'project:' + p.id === viewFilter);
  if (viewFilter.startsWith('project:') && !selected) viewFilter = 'browse';
  const labels = { browse: '全部对话', all: '独立对话', attention: '需要关注', running: '进行中', unread: '未读回复' };
  const attention = sessions.filter(s => ['approval', 'failed'].includes(sessionStatus(s)[0])).length;
  $('view-filter').textContent = (selected?.name || labels[viewFilter] || labels.browse) + (viewFilter === 'browse' && attention ? ` · ${attention} 待关注` : '') + ' ⌄';
  $('project-tasks').hidden = !selected || !capabilities.tasks;
  const query = $('session-search').value.trim().toLocaleLowerCase();
  const sidebar = $('sidebar'), list = $('sessions'), top = sidebar.scrollTop, listTop = list.scrollTop;
  const focused = document.activeElement?.dataset?.navKey;
  // Polling may finish between pointer-down and pointer-up. Keep the existing
  // targets (and native touch scrolling) when their rendered state is unchanged.
  const signature = JSON.stringify([authGeneration, user, device, session, viewFilter, query, sessions, groups, !!capabilities.tasks, navigation, pluginEntries]);
  if (list._navigationSignature === signature && list.children.length) return;
  let nodes;
  if (viewFilter === 'browse' && !query) nodes = renderNavigation();
  else {
    const members = selected ? projectMembers(selected) : [];
    const candidates = selected ? (query ? [...members, ...sessions.filter(s => !members.includes(s))] : members) : sessions;
    const visible = candidates.filter(s => query ? [s.title || '新对话', projectFor(s)?.name || '', pluginEntryFor(s.instanceId)?.label || ''].some(text => text.toLocaleLowerCase().includes(query))
      : (viewFilter !== 'all' || (!(s.projectId !== undefined ? s.projectId : projectFor(s)) && !pluginEntryFor(s.instanceId)))
      && (viewFilter !== 'attention' || ['approval', 'failed'].includes(sessionStatus(s)[0]))
      && (viewFilter !== 'running' || s.isProcessing || s.queuedCount > 0)
      && (viewFilter !== 'unread' || s.hasUnread));
    nodes = visible.map(s => sessionRow(s, projectFor(s), !!query || !selected && viewFilter !== 'all'));
  }
  if (!nodes.length && (viewFilter !== 'browse' || query || $('plugin-entries').hidden)) {
    nodes.push(el('p', sessions.length ? '没有符合条件的对话' : '暂无共享对话，请在桌面端「设备互联 → 允许其他设备访问本机 → 设置共享目录」添加工作目录', 'empty-list'));
  }
  list.replaceChildren(...nodes);
  list._navigationSignature = signature;
  if (focused) [...list.querySelectorAll('[data-nav-key]')].find(e => e.dataset.navKey === focused)?.focus({preventScroll:true});
  sidebar.scrollTop = top; list.scrollTop = listTop;
}
async function refreshSessions() {
  const d = device, request = ++catalogRequest; let g = generation;
  // Discover rendering capabilities alongside access, so images/queued messages
  // work on the first replay without an extra network round trip.
  const capabilityRead = capabilitiesDevice !== d ? rpc('capabilities').catch(() => null) : null;
  const list = await rpc('sessions'); if (d !== device || g !== generation || request !== catalogRequest) return;
  sessions = list; sessionListDevice = d; syncWorkspaceView();
  const shared = new Set(list.map(s => s.instanceId));
  pluginEntries = pluginEntries.filter(e => shared.has(e.sessionId));
  navigation.recent = navigation.recent.filter(id => shared.has(id));
  if (navigation.last && !shared.has(navigation.last)) { navigation.last = ''; restoreSession = false; }
  saveNavigation();
  if (session && !shared.has(session)) { resetSession(); $('messages').replaceChildren(el('p', '此会话已关闭或不再共享')); renderSessions(); return; }
  // Conversations are usable as soon as they arrive; optional metadata must
  // not leave the mobile landing page blank while another RPC is pending.
  renderSessions();
  const metadataWarning = '项目与功能信息暂时无法更新，请稍后刷新';
  let metadataFailed = false;
  if (capabilitiesDevice !== d) {
    const result = await capabilityRead;
    if (d !== device || g !== generation || request !== catalogRequest) return;
    // Preserve the last successful catalog on transient failure. resetDevice
    // already clears it when changing computers. Only success can remove it.
    if (result) {
      capabilities = result; capabilitiesDevice = d;
      if (!capabilities.projects) groups = [];
      if (!capabilities.pluginResources) resetPluginEntries();
    } else metadataFailed = true;
  }
  // Access and rendering capabilities are ready. Project and plugin catalogs
  // only enrich the sidebar and must not hold up the conversation replay.
  if (!viewHidden() && devices.some(item => item.id === d && item.online)) {
    if (restoreSession && !session) {
      restoreSession = false;
      if (sessions.some(s => s.instanceId === navigation.last)) {
        const restoredGeneration = g + 1;
        await openSession(navigation.last);
        // Only accept the generation change caused by our own restoration.
        if (d !== device || generation !== restoredGeneration || request !== catalogRequest) return;
        g = restoredGeneration;
      }
    }
    if (session && !source) resumeStream();
  }
  if (capabilities.projects) {
    try { const result = await rpc('project-groups'); if (d !== device || g !== generation || request !== catalogRequest) return; groups = result; }
    catch { if (d !== device || g !== generation || request !== catalogRequest) return; metadataFailed = true; }
  }
  if (capabilities.pluginResources) {
    try {
      const result = await rpc('plugin-entries');
      if (d !== device || g !== generation || request !== catalogRequest) return;
      if (!Array.isArray(result)) throw Error('无效的专属对话目录');
      pluginEntries = result.filter(e => typeof e?.sessionId === 'string' && shared.has(e.sessionId)
        && [e.pluginId, e.key, e.label, e.resource].every(value => typeof value === 'string' && value.trim()));
    } catch {
      if (d !== device || g !== generation || request !== catalogRequest) return;
      metadataFailed = true;
    }
  }
  if (metadataFailed) notice(metadataWarning);
  else if ($('notice').textContent === metadataWarning) notice();
  renderSessions();
}
let sessionSearchExpanded = false;
function syncSessionSearch() {
  if (!$('session-search-panel')) return; // Cached HTML may predate the disclosure.
  const active = !!$('session-search').value.trim();
  const visible = sessionSearchExpanded || active;
  $('session-search-panel').hidden = !visible;
  $('session-search-toggle').setAttribute('aria-expanded', String(visible));
  $('session-search-toggle').dataset.active = String(active);
}
function closeSessionSearch(focus = true) {
  cancelSessionRestore();
  $('session-search').value = ''; sessionSearchExpanded = false;
  renderSessions();
  if (focus) $('session-search-toggle').focus();
}
$('session-search').oninput = () => { cancelSessionRestore(); sessionSearchExpanded = true; renderSessions(); };
if ($('session-search-toggle') && $('session-search-panel') && $('session-search-close')) {
$('session-search-toggle').onclick = () => {
  cancelSessionRestore();
  if (!$('session-search-panel').hidden) { closeSessionSearch(); return; }
  sessionSearchExpanded = true; syncSessionSearch(); $('session-search').focus();
};
$('session-search-close').onclick = () => closeSessionSearch();
$('session-search').onkeydown = event => {
  if (event.key !== 'Escape' || event.isComposing || $('session-search-panel').hidden) return;
  event.preventDefault(); event.stopPropagation(); closeSessionSearch();
};
$('session-search-close').onkeydown = $('session-search-toggle').onkeydown = $('session-search').onkeydown;
// Close explicitly so pointer/touch actions below search do not move on blur.
}
syncSessionSearch();
$('view-filter').onclick = () => {
  const did = device;
  const choose = (label, value) => button(label + (value === viewFilter ? ' ✓' : ''), () => { if (did !== device) return; viewFilter = value; $('session-search').value = ''; renderSessions(); $('modal').close(); });
  modal('筛选对话', [choose('全部对话', 'browse'), choose('需要关注', 'attention'), choose('进行中', 'running'), choose('未读回复', 'unread'), choose('独立对话', 'all')]);
};
async function showTasks(project) {
  const g = generation, did = device;
  modal(project.name + ' · 协作任务', [el('p', '正在读取…')]); const ticket = taskView;
  const valid = () => g === generation && ticket === taskView && $('modal').open;
  try {
    const tasks = await rpc('project-tasks', { projectId: project.id }, did); if (!valid()) return;
    const labels = { queued: '排队中', running: '进行中', completed: '已完成', failed: '未完成', cancelled: '已停止', interrupted: '已中断' };
    const title = id => sessions.find(s => s.instanceId === id)?.title || '对话';
    modal(project.name + ' · 协作任务', [button('刷新', () => showTasks(project), 'text-button'), ...tasks.map(task => {
      const b = button('', () => showTask(project, task), 'choice task-choice');
      b.append(el('span', `${title(task.sourceId)} → ${title(task.recipientId)}`, 'task-route'), el('strong', task.message || '协作任务'), el('small', labels[task.state] || task.state)); return b;
    }), ...(!tasks.length ? [el('p', '暂无双方都已共享的协作任务')] : [])]);
  } catch (e) { if (valid()) modal('无法读取协作任务', [el('p', e.message), button('重试', () => showTasks(project))]); }
}
async function showTask(project, task) {
  const g = generation, did = device;
  const article = el('article', undefined, 'message reply task-output'), error = el('p', '', 'task-error');
  const more = button('继续读取', () => load(), 'choice'); let offset = 0, text = '';
  modal('协作结果', [button('返回任务列表', () => showTasks(project), 'text-button'), el('p', task.message), error, article, more]); const ticket = taskView;
  const valid = () => g === generation && ticket === taskView && $('modal').open;
  async function load() {
    if (!valid()) return;
    try {
      const page = await rpc('project-tasks', { projectId: project.id, taskId: task.id, offset }, did);
      if (!valid()) return;
      text += page.text; offset = page.nextOffset; error.textContent = page.error || '';
      renderMarkdown(article, text || '暂时没有输出', task.recipientId, did);
      // The current end of a running task is not the end of its eventual output.
      more.hidden = !page.hasMore && page.terminal !== false;
      more.textContent = page.hasMore ? '继续读取' : '刷新进度';
    } catch (e) {
      if (!valid()) return;
      error.textContent = e.message; more.hidden = false; more.textContent = '重试读取';
    }
  }
  more.disabled = true;
  try { await load(); } finally { more.disabled = false; }
}
$('project-tasks').onclick = () => { const p = groups.find(p => 'project:' + p.id === viewFilter); if (p) void showTasks(p); };
function resetSession() {
  composerMedia?.cancel();
  // Preserve the old draft before invalidating delayed sends, dialogs and stream callbacks.
  composerMedia?.cancel(); fullHistory = false; clearFrameQueue(); saveDraft(); closeSource(); generation++; globalThis.AsHubFilePreview?.close(); taskView++; session = ''; queuedMessages = []; images = []; sending = false; pendingSend = null;
  resetMessages(); renderAttachments(); notice();
  $('query').value = ''; $('image-input').value = '';
  $('chat-title').textContent = ''; if ($('chat-project')) { $('chat-project').textContent = ''; $('chat-project').hidden = true; } $('model').textContent = '模型'; $('connection').textContent = '';
  $('modal').close(); $('modal-title').textContent = ''; $('modal-body').replaceChildren();
}
function resetDevice(next) {
  resetPluginEntries();
  resetSession(); device = next; if (next) navigationTouched = false; loadNavigation(); if (user && device) storage.set(preferredDeviceKey(), device); sessionListDevice = ''; sessions = []; groups = []; viewFilter = 'browse'; capabilities = {}; capabilitiesDevice = ''; catalogRequest++; $('session-search').value = ''; sessionSearchExpanded = false; renderSessions();
  $('sessions').replaceChildren(); $('device-status').textContent = ''; $('new-chat').disabled = true;
}
$('devices').onchange = async () => { resetDevice($('devices').value); const g = generation; await refreshDevices().catch(e => { if (g === generation) notice(e.message); }); };
$('refresh').onclick = () => { capabilitiesDevice = ''; return refreshDevices().catch(e => notice(e.message)); };
const imageDrafts = new Map(), pendingImageSends = new Map();
function draftImages(k = key('draft')) {
  if (imageDrafts.has(k)) return imageDrafts.get(k);
  try { const refs = JSON.parse(storage.get(k + ':images') || '[]'); return Array.isArray(refs) ? refs.filter(x => x && typeof x.id === 'string') : []; } catch { return []; }
}
function storeImages(k, value) {
  imageDrafts.set(k, value);
  // Persist small upload references from withdrawn messages, not large image data.
  storage.set(k + ':images', JSON.stringify(value.filter(x => x.id)));
}
function saveDraft() { if (user && device && session) { storage.set(key('draft'), $('query').value); storeImages(key('draft'), images); } }
let queuedMessages = [], queueTimer, queueRevision = 0;
const withdrawing = new Set();
function pendingWithdrawals(k = key('withdrawals')) {
  try { return JSON.parse(storage.get(k) || '[]'); } catch { return []; }
}
function renderLegacyQueue() {
  const container = $('queued-messages'); if (!container) return;
  // Queue RPCs settle after replay. Capture following intent before the
  // composer changes height, otherwise it can look like a scroll into history.
  const near = nearBottom();
  container.replaceChildren(); container.classList.toggle('queue-modern', false); delete container.dataset.owner;
  if (!session || !capabilities.queue) { container.hidden = true; scroll(near); return; }
  const pending = pendingWithdrawals();
  const items = [...queuedMessages, ...pending.filter(p => !queuedMessages.some(m => m.id === p.id))];
  container.hidden = !items.length;
  for (const item of items) {
    const row = el('div', undefined, 'queued-message');
    const label = el('span', item.query || '图片消息'); label.title = item.query || '图片消息';
    const edit = button(pending.some(p => p.id === item.id) ? '恢复草稿' : '撤回编辑', () => void withdrawMessage(item), 'text-button');
    edit.disabled = !streamReady || sending || withdrawing.has(key('withdrawals') + ':' + item.id);
    row.append(el('small', item.delivery === 'steer' ? '等待接入' : '排队中'), label, edit); container.append(row);
  }
  scroll(near);
}
// Keep editor nodes alive while SSE status updates and queue refreshes arrive.
const queueChanges = new Map();
const queueIcons = {
  edit: '<path d="m13 4 3 3M4 16l3-.6L17 5a2.1 2.1 0 0 0-3-3L3.6 13z"/>',
  withdraw: '<path d="m6 6 8 8M14 6l-8 8"/>',
  promote: '<path d="M5 4h10M10 16V7m-4 4 4-4 4 4"/>',
};
function queueState(id) {
  const k = key('queue-actions') + ':' + id;
  if (!queueChanges.has(k)) {
    // Cached editors hold unsaved text, including while another conversation is open.
    if (queueChanges.size > 128) for (const [old, value] of queueChanges) { if (!value.busy && !value.editor) { queueChanges.delete(old); break; } }
    queueChanges.set(k, {});
  }
  return queueChanges.get(k);
}
function renderQueue() {
  if (!capabilities.queueActions) { renderLegacyQueue(); return; }
  const container = $('queued-messages'); if (!container) return;
  const near = nearBottom(), owner = key('queue-actions');
  if (container.dataset.owner !== owner) { container.replaceChildren(); container.dataset.owner = owner; }
  if (!session || !capabilities.queue) { container.hidden = true; scroll(near); return; }
  const recovering = pendingWithdrawals();
  container.hidden = !queuedMessages.length && !recovering.length; container.classList.add('queue-modern');
  let head = container.querySelector('.queue-heading');
  if (!head) { head = el('div', '待处理消息', 'queue-heading'); container.prepend(head); }
  const existing = new Map([...container.querySelectorAll('.queued-message')].map(row => [row.dataset.id, row]));
  const items = queuedMessages.filter(item => !recovering.some(p => p.id === item.id));
  const ids = new Set(items.map(item => item.id));
  // Remove departed rows before choosing insertion anchors. Moving a surviving
  // row ahead of a stale one detaches its editor and drops focus/IME input.
  for (const [id, row] of existing) if (!ids.has(id)) { row.remove(); existing.delete(id); }
  let cursor = head.nextSibling;
  for (const item of items) {
    const state = queueState(item.id);
    let row = existing.get(item.id);
    if (!row) {
      row = el('div', undefined, 'queued-message'); row.dataset.id = item.id;
      const summary = el('div', undefined, 'queue-summary'); summary.append(el('span', '', 'queue-label'), el('small', '', 'queue-status'));
      const actions = el('div', undefined, 'queue-actions');
      for (const name of ['edit', 'withdraw', 'promote']) {
        const control = button('', () => name === 'edit' ? editQueue(row._item) : void changeQueue(row._item, name), 'queue-action');
        control.dataset.action = name;
        const title = {edit:'编辑',withdraw:'撤回',promote:'插队 · 下一次模型请求前接入'}[name];
        control.title = title; control.setAttribute('aria-label', title);
        control.innerHTML = `<svg viewBox="0 0 20 20" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${queueIcons[name]}</svg>`;
        actions.append(control);
      }
      row.append(summary, actions);
    }
    row._item = item;
    const label = row.querySelector('.queue-label'); label.textContent = item.query || '图片消息'; label.title = item.query || '图片消息';
    row.querySelector('.queue-status').textContent = (item.delivery === 'steer' ? '等待接入' : '排队中') + (item.images?.length ? ` · ${item.images.length} 张图片` : '');
    for (const control of row.querySelectorAll('.queue-action')) control.disabled = !streamReady || state.busy || (control.dataset.action === 'promote' && (item.delivery === 'steer' || !!state.editor));
    row.classList.toggle('queue-editing', !!state.editor);
    if (state.editor && state.editor.parentElement !== row) row.append(state.editor);
    if (!state.editor) row.querySelector('.queue-editor')?.remove();
    let error = row.querySelector('.queue-error');
    if (state.error) { if (!error) { error = el('div', '', 'queue-error'); error.setAttribute('role', 'status'); row.append(error); } error.textContent = state.error; }
    else error?.remove();
    if (cursor !== row) container.insertBefore(row, cursor);
    cursor = row.nextSibling; existing.delete(item.id);
  }
  for (const row of existing.values()) row.remove();
  // Preserve recoverability for an uncertain withdraw-and-edit started by an older client.
  let recovery = container.querySelector('.queue-recovery');
  if (recovering.length) {
    if (!recovery) { recovery = el('div', undefined, 'queue-recovery'); container.append(recovery); }
    recovery.replaceChildren();
    for (const item of recovering) {
      const recover = button('恢复此前撤回的草稿', () => void withdrawMessage(item), 'text-button');
      recover.disabled = !streamReady || withdrawing.has(key('withdrawals') + ':' + item.id);
      recovery.append(recover);
    }
  } else recovery?.remove();
  scroll(near);
}
function editQueue(item) {
  const state = queueState(item.id); if (state.busy) return;
  if (state.editor) { state.editor.querySelector('textarea').focus(); return; }
  const form = el('form', undefined, 'queue-editor'), input = el('textarea');
  input.value = item.query || ''; input.rows = 3; input.maxLength = 1000000; input.setAttribute('aria-label', '编辑排队消息');
  const actions = el('div', undefined, 'queue-editor-actions');
  const close = () => { state.editor = null; renderQueue(); };
  // The form owns saving/busy state. The generic async button wrapper disables
  // before native submission and captures an auth epoch that cached editors outlive.
  const cancel = el('button', '取消', 'text-button'); cancel.type = 'button'; cancel.onclick = close;
  const save = el('button', '保存', 'text-button'); save.type = 'submit';
  actions.append(el('span', '保留原位置和附件'), cancel, save); form.append(input, actions);
  const revision = item.revision || 0;
  form.onsubmit = async e => { e.preventDefault(); if (await changeQueue(item, 'edit', input.value, revision)) close(); };
  input.onkeydown = e => { if (e.isComposing || state.busy) return; if (e.key === 'Escape') { e.preventDefault(); close(); } if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); } };
  state.editor = form; renderQueue(); input.focus();
}
async function changeQueue(item, action, query, revision = item.revision || 0) {
  const state = queueState(item.id); if (state.busy || !streamReady) return false;
  const owner = key('queue-actions'), sid = session, did = device;
  const active = () => key('queue-actions') === owner;
  const payload = action === 'withdraw' ? {session:sid,id:item.id} : {session:sid,id:item.id,action,query,revision};
  const fingerprint = JSON.stringify(payload);
  if (state.request?.fingerprint !== fingerprint) state.request = {fingerprint,requestId:crypto.randomUUID()};
  state.busy = true; state.error = ''; ++queueRevision; renderQueue();
  const editorInput = state.editor?.querySelector('textarea'); if (editorInput) editorInput.readOnly = true;
  for (const control of state.editor?.querySelectorAll('button') || []) control.disabled = true;
  try {
    const result = await rpc(action === 'withdraw' ? 'queue-withdraw' : 'queue-update', {...payload,requestId:state.request.requestId}, did);
    state.request = null;
    if (active()) {
      if (action === 'withdraw') queuedMessages = queuedMessages.filter(m => m.id !== item.id);
      else queuedMessages = queuedMessages.map(m => m.id === item.id && (m.revision || 0) <= result.revision ? result : m);
    }
    return true;
  } catch (e) {
    if (e.status === 400 || e.status === 409) state.request = null;
    state.error = e.status === 409 ? '消息已变更或开始处理，请核对队列后重试' : '操作未完成，请重试';
    if (active()) notice(state.error); return false;
  } finally {
    state.busy = false; if (editorInput) editorInput.readOnly = false;
    for (const control of state.editor?.querySelectorAll('button') || []) control.disabled = false;
    if (active()) { renderQueue(); scheduleQueue(); }
  }
}
function scheduleQueue() {
  const g = generation, rev = ++queueRevision; clearTimeout(queueTimer);
  if (!session || !capabilities.queue || !streamReady) return;
  queueTimer = setTimeout(async () => {
    try {
      const list = await rpc('queue', { session });
      if (g === generation && rev === queueRevision) {
        // Only an accepted server snapshot proves a message has left the queue.
        // Loading/reconnect views must not discard drafts; in-flight mutations
        // retain their state until completion schedules another queue refresh.
        const prefix = key('queue-actions') + ':', ids = new Set(list.map(item => item.id));
        for (const [k, state] of queueChanges) {
          if (k.startsWith(prefix) && !ids.has(k.slice(prefix.length)) && !state.busy) queueChanges.delete(k);
        }
        queuedMessages = list; renderQueue();
      }
    }
    catch { /* Preserve the last confirmed queue during reconnect. */ }
  }, 80);
}
async function withdrawMessage(item) {
  const sid = session, did = device, owner = user, draftKey = key('draft'), pendingKey = key('withdrawals');
  const isActive = () => user === owner && device === did && session === sid;
  const lock = pendingKey + ':' + item.id; if (withdrawing.has(lock) || sending) return;
  let pending = pendingWithdrawals(pendingKey), entry = pending.find(p => p.id === item.id);
  if (!entry) {
    if (images.length + (item.images?.length || 0) > 4) { notice('请先整理输入框中的图片，再撤回这条消息'); return; }
    entry = { ...item, requestId: crypto.randomUUID() }; pending.push(entry); storage.set(pendingKey, JSON.stringify(pending));
  }
  withdrawing.add(lock); renderQueue();
  try {
    // Same request ID makes retries safe if the connection drops after removal.
    const message = await rpc('queue-withdraw', { session: sid, id: item.id, requestId: entry.requestId }, did);
    if (user !== owner) return;
    const active = isActive();
    const text = active ? $('query').value : (storage.get(draftKey) || '');
    const restored = [message.query, text].filter(Boolean).join('\n');
    const attachments = [...(active ? images : draftImages(draftKey)), ...(message.images || []).map(img => ({ ...img, name: '图片' }))];
    storage.set(draftKey, restored); storeImages(draftKey, attachments);
    storage.set(pendingKey, JSON.stringify(pendingWithdrawals(pendingKey).filter(p => p.id !== item.id)));
    if (active) { $('query').value = restored; images = attachments; renderAttachments(); $('query').focus(); notice('已撤回，可编辑后重新发送'); }
    if (isActive()) queuedMessages = queuedMessages.filter(m => m.id !== item.id);
  } catch (e) {
    // Keep an uncertain receipt available for retry; a definitive failure has
    // no effect and can be dismissed without recovering any draft.
    if (e.status === 409 || e.status === 400) storage.set(pendingKey, JSON.stringify(pendingWithdrawals(pendingKey).filter(p => p.id !== item.id)));
    if (isActive()) notice(e.message);
  } finally { withdrawing.delete(lock); if (isActive()) { renderQueue(); scheduleQueue(); } }
}
$('query').oninput = saveDraft;
let deliveryMode = storage.get('ash.delivery-mode') === 'queue' ? 'queue' : 'steer';
$('delivery-mode').onclick = () => {
  deliveryMode = deliveryMode === 'steer' ? 'queue' : 'steer';
  storage.set('ash.delivery-mode', deliveryMode); controls();
};
function controls() {
  renderConnectionStatus();
  syncSessionActions();
  $('delivery-mode').hidden = !session || !streamReady || !activity || !capabilities.steering;
  $('delivery-mode').textContent = deliveryMode === 'steer' ? '中途补充' : '排队发送';
  $('delivery-mode').title = deliveryMode === 'steer' ? '当前思考和工具调用结束后接入，点击切换为排队' : '当前任务结束后处理，点击切换为中途补充'; syncWorkspaceView(); const enabled = !!session && devices.some(d => d.id === device && d.online) && streamReady; $('query').disabled = !enabled; $('send').disabled = !enabled || sending; $('model').disabled = !enabled || activity; $('image-input').disabled = !enabled; $('stop').hidden = !enabled || !activity; modelPicker?.render(); renderQueue(); }
let fullHistory = false;
let frameQueue = [], frameTimer = null, batchingFrames = false, batchNear = false;
function clearFrameQueue() { clearTimeout(frameTimer); frameTimer = null; frameQueue = []; }
function enqueueFrame(data) {
  frameQueue.push(data);
  if (frameTimer !== null) return;
  frameTimer = setTimeout(drainFrames, 0);
}
function drainFrames() {
  frameTimer = null; batchNear = nearBottom(); batchingFrames = true;
  // Bound work per task so touch input and painting get time during replay.
  const batch = frameQueue.splice(0, 60);
  try {
    for (const data of batch) {
      try { frame(data); } catch { notice('部分内容暂时无法显示，请刷新对话'); }
    }
  }
  finally { batchingFrames = false; scroll(batchNear); }
  if (frameQueue.length) frameTimer = setTimeout(drainFrames, 0);
}
function resolvePermission(requestId, outcome) {
  const card = permissions.get(requestId) || permissionRecords.get(requestId);
  permissions.delete(requestId);
  if (outcome === 'unconfirmed') {
    if (card?.dataset.unconfirmed) return;
    const record = el('p', '授权送达未确认，请先核对执行结果再重试', 'permission');
    record.dataset.unconfirmed = 'true';
    if (card?.parentNode) card.parentNode.insertBefore(record, card);
    else $('messages').append(record);
    permissionRecords.set(requestId, record);
  } else {
    if (card?.dataset.unconfirmed && !outcome) return;
    permissionRecords.delete(requestId);
  }
  card?.remove();
}
function resetMessages() {
  followingBottom = true; readerScrolling = false; lastScrollTop = 0;
  if (batchingFrames) batchNear = true;
  if (modelPicker) { modelPicker = null; taskView++; $('modal').close(); }
  clearTimeout(renderTimer); renderTimer = null; reply = null; liveSegment = false; details = null; todo = null;
  permissions.clear(); permissionRecords.clear(); phases.clear(); toolSteps.clear(); agentSteps.clear(); diagnosticOwners.clear(); subagentLaunchOwners.clear(); turnOutcome = ''; modelInfo = {}; modelRevision++; usage = null; streamPaused = false;
  $('usage').textContent = ''; $('messages').replaceChildren(); setActivity(false);
}
function phaseLabel(phase) {
  // Async collaborators can still need approval after the main reply ends.
  // Completed phases keep their status and original time during later approvals.
  const state = activityState({ finished: phase.outcome || (phase.done ? 'done' : ''),
    sealed: phase.sealed, pending: phase.tools.size, delegated: phase.agents.size,
    waiting: permissions.size > 0 && ((!phase.done && activity) || phase.agents.size > 0) });
  const running = state !== 'settled', waiting = state === 'waiting';
  phase.summary.textContent = waiting ? '等待你的确认' : running
    ? phase.agents.size ? '正在协作处理' : phase.tools.size ? toolProgress([...phase.tools.values()].at(-1))
      : (phase === details && requestLabels[requestPhase]) || '正在梳理思路'
    : phase.outcome === 'error' ? '回复中断' : phase.outcome === 'stopped' ? '已停止' : '处理记录';
  if (state !== 'settled') phase.settledAt = null;
  else if (phase.box.dataset.state !== 'settled') {
    // Replayed text may precede this phase's last parallel completion in time.
    phase.settledAt = activityEventTime && phase.lastWorkAt?.iso > activityEventTime.iso ? phase.lastWorkAt : activityEventTime;
  }
  phase.timeNode ||= el('time', '', 'activity-time');
  renderActivityTime(phase.timeNode, phase.settledAt);
  if (phase.settledAt) phase.summary.append(phase.timeNode);
  else phase.timeNode.remove();
  if (phase.box.dataset.state !== state || phase.box.dataset.outcome !== (phase.outcome || '') || phase.box._recordDone !== phase.done) recordsDirty = true;
  phase.box._recordDone = phase.done;
  phase.box.dataset.state = state;
  phase.box.dataset.paused = String(streamPaused);
  phase.box.dataset.outcome = phase.outcome || '';
}
// Group only adjacent, successfully finished records. Keep the underlying
// phase objects and their event routing intact, including late collaborator events.
function compactCompletedRecords() {
  if (!recordsDirty) return;
  recordsDirty = false;
  const messages = $('messages');
  const quiet = phase => phase.done && !phase.outcome && !phase.tools.size && !phase.agents.size
    && phase.box.dataset.state === 'settled';
  for (const node of [...messages.children]) {
    if (!node._recordPhases || node._recordPhases.every(quiet)) continue;
    for (const phase of node._recordPhases) messages.insertBefore(phase.box, node);
    node.remove();
  }
  let previous = null;
  for (const node of [...messages.children]) {
    const members = node._recordPhases || (node._recordPhase ? [node._recordPhase] : []);
    // Do not move content the user is inspecting, or cross any visible message,
    // task plan, approval, error or active processing boundary.
    if (!members.length || node.open || !members.every(quiet)) { previous = null; continue; }
    if (!previous) { previous = node; continue; }
    let group = previous;
    if (!group._recordPhases) {
      group = el('details', undefined, 'detail record-group');
      group.dataset.state = 'settled'; group.dataset.outcome = '';
      group.append(el('summary', '处理记录'));
      group._recordPhases = [previous._recordPhase];
      messages.insertBefore(group, previous); group.append(previous);
      group.ontoggle = () => {
        recordsDirty = true;
        if (!group.open) return;
        for (const phase of group._recordPhases) { phase.box.open = true; flushDiagnostics(phase); }
      };
    }
    group._recordPhases.push(...members);
    for (const phase of members) group.append(phase.box);
    if (node._recordPhases) node.remove();
    previous = group;
  }
  for (const group of [...messages.children]) {
    if (!group._recordPhases) continue;
    const times = group._recordPhases.map(phase => phase.settledAt);
    const latest = times.every(Boolean) ? times.reduce((a, b) => a.iso > b.iso ? a : b) : null;
    group._timeNode ||= el('time', '', 'activity-time');
    renderActivityTime(group._timeNode, latest);
    if (latest) group.children[0].append(group._timeNode);
    else group._timeNode.remove();
  }
}
function toolProgress(tool) {
  return { 'activity.collaboration.wait': '正在等待协作结果', 'activity.delegating': '正在协作处理', 'activity.reading': '正在查阅资料', 'activity.searching': '正在查找资料',
    'activity.writing': '正在更新文件' }[toolActivityKey(tool)] || '正在处理任务';
}
function refreshProgress(allPhases = false) {
  if (allPhases) recordsDirty = true;
  // Permission and connection state also affect sealed disclosures and
  // collaborators that outlive their originating turn.
  if (allPhases) for (const phase of new Set([...phases, ...agentSteps.values()])) phaseLabel(phase);
  else if (details) phaseLabel(details);
  const owned = details && !details.done && !details.sealed;
  const visible = activity && !streamPaused && !owned && (!responseStreaming || permissions.size > 0);
  activityNode.hidden = !visible;
  if (!visible) activityNode.remove();
  else {
    activityText.textContent = permissions.size ? '等待你的确认' : requestLabels[requestPhase] || '正在梳理思路';
    // A transient message-stream node, never a composer/status-strip child.
    if ($('messages').lastElementChild !== activityNode) $('messages').append(activityNode);
  }
  compactCompletedRecords();
}
function sealDetails() {
  if (!details) return;
  details.sealed = true; phaseLabel(details); details = null;
}
function settlePhases(outcome = '') {
  for (const phase of phases) { phase.done = true; if (outcome || !phase.outcome) phase.outcome = outcome; phaseLabel(phase); }
  details = null;
}
function setActivity(value) {
  activity = value; requestPhase = ''; responseStreaming = false;
  if (value) streamPaused = false;
  if (!value) settlePhases(turnOutcome);
  refreshProgress(); controls();
}
// Only an explicit reading gesture cancels following. WebKit may dispatch
// delayed scroll events (restoration, anchoring or momentum) with unchanged
// dimensions; a scroll event alone is not evidence that the user scrolled up.
let followingBottom = true, readerScrolling = false, lastScrollTop = 0, bottomFrame = 0;
function placeAtBottom() {
  const m = $('messages');
  if (!followingBottom || !session || document.hidden || m.clientHeight <= 0) return;
  m.scrollTop = m.scrollHeight;
  lastScrollTop = m.scrollTop;
  // iOS momentum can temporarily defer a scrollTop write. Retry on a paint,
  // stopping immediately if the reader takes over or the page is hidden.
  if (m.scrollHeight - m.clientHeight - m.scrollTop > 2) scheduleBottom();
}
function scheduleBottom() {
  if (bottomFrame || typeof requestAnimationFrame !== 'function') return;
  bottomFrame = requestAnimationFrame(() => { bottomFrame = 0; placeAtBottom(); });
}
function scroll(near) {
  if (batchingFrames) return;
  followingBottom = near;
  if (near) { placeAtBottom(); scheduleBottom(); }
}
function nearBottom() { return batchingFrames ? batchNear : followingBottom; }
function readHistory(scrolling = true) {
  followingBottom = false; readerScrolling = scrolling; lastScrollTop = $('messages').scrollTop;
  if (batchingFrames) batchNear = false;
}
function readingKey(event) {
  if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
  const target = event.target;
  if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (target?.closest?.('#messages, .conversation-nav')) readHistory();
}
const messageScroller = $('messages');
messageScroller.addEventListener?.('wheel', event => { if (event.deltaY) readHistory(); }, { passive: true });
// A tap should not disable following; an actual one-finger drag should.
messageScroller.addEventListener?.('touchmove', event => { if (event.touches.length === 1) readHistory(); }, { passive: true });
messageScroller.addEventListener?.('pointerdown', event => {
  if (event.pointerType !== 'touch' && event.clientX >= messageScroller.getBoundingClientRect().right - 18) readHistory();
}, { passive: true });
messageScroller.addEventListener?.('scroll', () => {
  const top = messageScroller.scrollTop;
  if (followingBottom) scheduleBottom();
  else if (readerScrolling && top > lastScrollTop && messageScroller.scrollHeight - top - messageScroller.clientHeight < 140) {
    followingBottom = true; readerScrolling = false; scheduleBottom();
  }
  lastScrollTop = top;
}, { passive: true });
messageScroller.addEventListener?.('click', event => {
  if (event.target.closest?.('summary')) readHistory(false);
});
// Capture before the navigation rail jumps so its programmatic scroll retains
// the same user intent as wheel, touch and keyboard navigation.
document.addEventListener('click', event => {
  if (event.target.closest?.('.conversation-nav-tick')) readHistory(false);
}, true);
if (typeof ResizeObserver === 'function' && typeof MutationObserver === 'function') {
  const observed = new Set();
  const resized = new ResizeObserver(() => { if (followingBottom) { placeAtBottom(); scheduleBottom(); } });
  resized.observe(messageScroller);
  const observeMessages = () => {
    for (const node of observed) if (node.parentElement !== messageScroller) { resized.unobserve(node); observed.delete(node); }
    for (const node of messageScroller.children) if (!observed.has(node)) { observed.add(node); resized.observe(node); }
  };
  new MutationObserver(observeMessages).observe(messageScroller, { childList: true });
  observeMessages();
}
function artifactTarget(href, owner) {
  if (!href || href.startsWith('#')) return null;
  const local = new URL(href, 'http://127.0.0.1/' + owner + '/');
  const relative = href.trim().split(/[?#]/)[0];
  if (relative && !/^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(relative)) return { session: owner, path: decodeURIComponent(relative) };
  if (!['http:', 'https:'].includes(local.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(local.hostname)) return null;
  const match = local.pathname.match(/^\/([0-9a-f]{4,32})\/(.+)$/);
  if (!match || match[2] === 'index.html') return null;
  if (match[2] === 'artifacts') return { session: match[1], path: local.searchParams.get('path') || '' };
  return { session: match[1], path: decodeURIComponent(match[2]) };
}
function showArtifactPreview(url, name, did) {
  const epoch = generation;
  if (!globalThis.AsHubFilePreview) return showArtifactDownload(url, name, did);
  return globalThis.AsHubFilePreview.open({url:url.href, name, lang:'zh', pdfBase:new URL('pdfjs/', base).href,
    current:() => epoch === generation && device === did,
    share:(versionedUrl = url) => showArtifactDownload(versionedUrl, name, did)});
}
async function showArtifactDownload(url, name, did) {
  const g = generation;
  const status = el('p', '正在检查文件…'), actions = el('div', undefined, 'download-actions');
  const back = button('返回对话', () => $('modal').close(), 'text-button');
  modal('保存文件', [el('p', name, 'download-name'), status, actions, back]);
  const transfer = { controller: new AbortController(), objectURL: null };
  artifactDownload = transfer;
  const current = () => artifactDownload === transfer && $('modal').open && g === generation && device === did;
  const check = response => {
    if (!response.ok || !response.headers.get('content-disposition')?.startsWith('attachment;'))
      throw Error(response.status === 409 ? '文件已更新，请返回对话重新打开预览' : '文件无法下载，请检查电脑连接、共享范围或文件是否仍存在');
  };
  const timeout = setTimeout(() => transfer.controller.abort(), 120000);
  try {
    const options = {cache:'no-store', signal:transfer.controller.signal};
    const head = await fetch(url, {...options, method:'HEAD'}); check(head);
    if (!current()) return;
    const size = Number(head.headers.get('content-length'));
    const limit = 32 * 1024 * 1024;
    let file;
    // Prepare small files within the authenticated PWA. The next explicit tap
    // opens the system share sheet without losing browser user activation.
    if (typeof File === 'function' && typeof navigator.share === 'function'
        && navigator.canShare?.({files:[new File([], name, {type:'application/octet-stream'})]})
        && Number.isSafeInteger(size) && size >= 0 && size <= limit) {
      status.textContent = '正在准备文件…';
      const response = await fetch(url, options); check(response);
      const reader = response.body.getReader(), parts = []; let total = 0;
      try {
        while (true) {
          const {done, value} = await reader.read(); if (done) break;
          total += value.byteLength;
          if (total > limit) throw Error('文件较大，请使用浏览器下载');
          parts.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (!current()) return;
      file = new File(parts, name, {type:'application/octet-stream'});
      transfer.objectURL = URL.createObjectURL(file);
    }
    if (!current()) return;
    const download = el('a', '在浏览器中下载', 'download-link');
    download.href = transfer.objectURL || url.href; download.target = '_blank'; download.rel = 'noopener noreferrer'; download.download = name;
    download.onclick = event => { if (!current()) event.preventDefault(); };
    if (file && navigator.canShare?.({files:[file]})) {
      actions.append(button('存储或分享文件', async () => {
        if (!current()) return;
        try { await navigator.share({files:[file], title:name}); }
        catch (e) { if (e.name !== 'AbortError' && current()) status.textContent = '系统分享暂不可用，可使用下方的浏览器下载'; }
      }, 'primary'));
      status.textContent = '在系统菜单中存储到文件或分享，当前对话会保留';
    } else status.textContent = '下载将在独立页面打开，当前对话会保留';
    actions.append(download);
  } catch (e) {
    if (current()) status.textContent = e.name === 'AbortError' ? '文件准备超时，请关闭后重试' : e.message;
  } finally { clearTimeout(timeout); }
}
const markdownTableState = new WeakMap();
function renderMarkdown(target, text, owner = session, did = device) {
  const savedImages = globalThis.AsHubImageResources?.preserve(target);
  const savedArtifacts = globalThis.AsHubArtifactImages?.preserve(target);
  const epoch = generation, viewer = session;
  const previous = markdownTableState.get(target);
  // Only carry positions across a redraw or append of the same message.
  const tablePositions = previous && previous.epoch === epoch && previous.viewer === viewer &&
    previous.owner === owner && previous.did === did && text.startsWith(previous.text)
    ? Array.from(target.querySelectorAll('table'), table =>
      table.scrollLeft && table.tHead ? { left: table.scrollLeft, heading: table.tHead.textContent } : null)
    : [];
  target.innerHTML = DOMPurify.sanitize(marked.parse(globalThis.AsHubMath?.extractMath(text) ?? text), { FORBID_TAGS: ['img', 'style', 'form', 'input', 'video', 'audio', 'iframe', 'svg'], FORBID_ATTR: ['style'] });
  globalThis.AsHubMath?.renderMathIn(target);
  globalThis.AsHubArtifactImages?.hydrate(target, {
    scope: `${epoch}:${did}:${owner}`, current: () => generation === epoch && device === did && session === viewer,
    resolve: href => {
      if (!capabilities.artifacts) throw Error('Update desktop');
      const file = artifactTarget(href, owner);
      if (!file) throw Error('Only authorized workspace images are supported');
      const url = new URL(`api/devices/${did}/artifact`,base);
      url.searchParams.set('session',file.session); url.searchParams.set('path',file.path); return url.href;
    },
    open: (url,name,current) => globalThis.AsHubFilePreview?.open({url,name,current,lang:'zh',pdfBase:new URL('pdfjs/',base).href}),
  }, savedArtifacts);
  globalThis.AsHubImageResources?.hydrate(target, {
    scope: `${epoch}:${did}:${owner}`, current: () => generation === epoch && device === did && session === viewer,
    resolve: id => {
      if (!capabilities.imageResources) throw Error('Update desktop');
      const url = new URL(`api/devices/${did}/image-resource`,base); url.searchParams.set('session',owner); url.searchParams.set('id',id); return url.href;
    },
    open: (url,name,current) => globalThis.AsHubFilePreview?.open({url,name,current,lang:'zh',pdfBase:new URL('pdfjs/',base).href}),
  }, savedImages);
  for (const a of target.querySelectorAll('a')) {
    const href = a.getAttribute('href'); let file;
    try { file = artifactTarget(href, owner); } catch { a.removeAttribute('href'); continue; }
    a.rel = 'noreferrer noopener'; a.target = '_blank';
    if (file) {
      const url = new URL(`api/devices/${did}/artifact`, base); url.searchParams.set('session', file.session); url.searchParams.set('path', file.path);
      a.href = url.href; a.download = file.path.split('/').pop() || 'download';
      a.onclick = event => {
        event.preventDefault();
        if (!capabilities.artifacts) { notice('请更新桌面端以下载成果文件'); return; }
        if (device !== did) return;
        void showArtifactPreview(url, a.download, did);
      };
    } else if (!/^https?:/.test(a.href) || ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(a.href).hostname)) a.removeAttribute('href');
  }
  const tables = target.querySelectorAll('table');
  tables.forEach((table, index) => {
    const position = tablePositions[index];
    if (position && table.tHead?.textContent === position.heading) table.scrollLeft = position.left;
  });
  if (tables.length) markdownTableState.set(target, { epoch, viewer, owner, did, text });
  else markdownTableState.delete(target);
}
function renderReply() { if (!reply) return; const near = nearBottom(); renderMarkdown(reply.el, reply.text); scroll(near); }
function chunk(text) { if (!text) return; requestPhase = ''; responseStreaming = true; if (!details?.replyAnchor || details.replyAnchor !== reply?.el) sealDetails(); refreshProgress(); if (!reply) { reply = { el: el('article', undefined, 'message reply'), text: '' }; $('messages').append(reply.el); } reply.text += text; if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; renderReply(); }, 100); }
function finishReply() { clearTimeout(renderTimer); renderTimer = null; renderReply(); reply = null; }
// Presentation only: lifecycle and late-event ownership remain in diagnostic().
function appendDiagnosticRow(phase, row) {
  if (phase.traceRow) phase.body.insertBefore(row, phase.traceRow);
  else phase.body.append(row);
}
function diagnosticTrace(phase, name, payload) {
  phase.traceEvents ||= [];
  phase.traceEvents.push({ name, payload });
  if (!phase.traceRow) {
    phase.traceRow = el('details', undefined, 'step trace-step');
    phase.traceRow.append(el('summary', '原始记录'));
    phase.traceText = el('pre');
    phase.traceRow.append(phase.traceText); phase.body.append(phase.traceRow);
    phase.traceRow.ontoggle = () => {
      if (phase.traceRow.open) phase.traceText.textContent = JSON.stringify(phase.traceEvents, null, 2);
    };
  }
  if (phase.traceRow.open) phase.traceRow.ontoggle();
}
const diagnosticStatus = { failed: '未完成', partial: '部分完成', cancelled: '已取消', ended: '已结束' };
function diagnosticCall(phase, name, payload, forLaunch) {
  const child = !forLaunch && name.startsWith('subagent:');
  const started = name === 'agent:tool-started' || name === 'subagent:started';
  const completed = name === 'agent:tool-completed' || name === 'subagent:done';
  const output = name === 'agent:tool-output' || name === 'agent:tool-output-chunk';
  const id = child ? payload.subagentId : payload.toolCallId;
  // Do not guess which concurrent call an unlabelled completion belongs to.
  const key = typeof id === 'string' && id ? `${child ? 'agent' : 'tool'}:${id}`
    : output ? 'unassigned-output' : Symbol(name);
  phase.callRows ||= new Map();
  let call = phase.callRows.get(key);
  if (!call) {
    const row = el('details', undefined, 'step tool-step');
    const summary = el('summary'), title = el('span', '', 'step-title');
    const hint = el('span', '', 'step-hint'), status = el('span', '', 'step-status');
    summary.append(title, hint, status);
    const body = el('div', undefined, 'step-content');
    row.append(summary, body); appendDiagnosticRow(phase, row);
    call = { row, title, hint, status, body, events: [] }; phase.callRows.set(key, call);
    row.ontoggle = () => { if (row.open) renderDiagnosticCall(call); };
  }
  if (started) call.start = payload;
  if (completed && (payload.cancelled === true || call.result?.cancelled !== true)) call.result = payload;
  if (output) {
    phase.outputs ||= new Map();
    const outputKey = typeof id === 'string' ? id : '';
    if (!call.output) { call.output = el('pre', '', 'tool-output'); phase.outputs.set(outputKey, call.output); }
    const value = payload.chunk ?? payload.text ?? payload.output ?? '';
    call.output.textContent += typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } else call.events.push({ name, payload });
  const info = call.start || call.result || payload;
  call.title.textContent = child ? String(info.task || info.title || '协作任务')
    : toolDisplayName(info, 'zh');
  const context = info.displayDetail || info.locations?.[0]?.path || info.rawInput?.path || info.rawInput?.command || '';
  call.hint.textContent = typeof context === 'string' ? context.replace(/\s+/g, ' ').trim() : '';
  call.hint.title = call.hint.textContent;
  const result = call.result;
  const outcome = diagnosticState(result);
  call.row.dataset.state = outcome === 'pending' || outcome === 'cancelled' ? outcome : outcome === 'ended' ? 'done' : 'incomplete';
  call.status.textContent = diagnosticStatus[outcome] || '';
  if (call.row.open) renderDiagnosticCall(call);
}
function setDiagnosticText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}
function renderDiagnosticCall(call) {
  // Build the inner structure once; live output must not reset scroll or focus.
  if (!call.source) {
    call.inputSection = el('section'); call.inputText = el('pre');
    call.inputSection.append(el('p', '参数', 'step-caption'), call.inputText);
    call.outputSection = el('section'); call.outputSection.append(el('p', '输出', 'step-caption'));
    call.resultSection = el('section'); call.resultText = el('pre');
    call.resultSection.append(el('p', '结果', 'step-caption'), call.resultText);
    call.source = el('details', undefined, 'step-source'); call.sourceText = el('pre');
    call.source.append(el('summary', '原始记录'), call.sourceText);
    call.source.ontoggle = () => { if (call.source.open) setDiagnosticText(call.sourceText, JSON.stringify(call.events, null, 2)); };
    call.body.append(call.inputSection, call.outputSection, call.resultSection, call.source);
  }
  // Mobile replay replaces long diagnostic payloads with a labelled text
  // preview. Show that preview here as well as in the original record; never
  // imply the truncated payload is the complete arguments or result.
  const inputPreview = call.start?.rawInput === undefined && call.start?.detailsOmitted === true && typeof call.start.text === 'string';
  const input = inputPreview ? call.start.text : call.start?.rawInput;
  const fullResult = call.result?.rawOutput ?? call.result?.result ?? call.result?.output ?? call.result?.error;
  const resultPreview = fullResult === undefined && call.result?.detailsOmitted === true && typeof call.result.text === 'string';
  const result = resultPreview ? call.result.text : fullResult;
  const format = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  setDiagnosticText(call.inputSection.children[0], inputPreview ? '调用信息 · 精简预览' : '参数');
  setDiagnosticText(call.resultSection.children[0], resultPreview ? '结果 · 精简预览' : '结果');
  call.inputSection.hidden = input === undefined; setDiagnosticText(call.inputText, input === undefined ? '' : format(input));
  call.outputSection.hidden = !call.output;
  if (call.output && call.output.parentNode !== call.outputSection) call.outputSection.append(call.output);
  const resultText = result === undefined ? '' : format(result);
  // Identical streamed and final output is one reading surface, not two copies.
  call.resultSection.hidden = result === undefined || resultText === call.output?.textContent;
  setDiagnosticText(call.resultText, resultText);
  call.source.hidden = !call.events.length;
  if (call.source.open) call.source.ontoggle();
}

function flushDiagnostics(phase) {
  for (const item of phase.pending.splice(0)) diagnostic(item.name, item.payload, phase, item.forLaunch);
}
function diagnostic(name, payload, targetPhase = null, forLaunch = null) {
  const materializing = !!targetPhase;
  const summaryEvent = name === 'agent:thinking-chunk' || name === 'agent:thinking';
  const outputEvent = name === 'agent:tool-output' || name === 'agent:tool-output-chunk';
  const toolId = typeof payload.toolCallId === 'string' ? payload.toolCallId : '';
  const toolOwner = forLaunch || toolSteps.get(toolId) || diagnosticOwners.get('tool:'+toolId);
  const childFinished = name === 'subagent:done';
  const agentOwner = payload.subagentId && (agentSteps.get(payload.subagentId) || diagnosticOwners.get('agent:'+payload.subagentId));
  if (!materializing && !forLaunch && childFinished) {
    // A recent-history replay can omit the child's start. Its completion
    // cannot claim the current phase or another launch with the same tool ID.
    if (payload.subagentId && !agentOwner) return;
    if (payload.cancelled === true && toolId) {
      const launch = subagentLaunchOwners.get(payload.subagentId);
      const owner = payload.subagentId ? (launch?.toolId === toolId ? launch.phase : null) : toolOwner;
      if (owner) diagnostic(name, payload, null, owner);
      if (!payload.subagentId) return;
    }
  }
  const toolFinished = forLaunch || name === 'agent:tool-completed';
  const childId = toolId.includes('-tool-') ? toolId.slice(0, toolId.lastIndexOf('-tool-')) : '';
  const child = childId ? (agentSteps.get(childId) || diagnosticOwners.get('agent:'+childId)) : null;
  const linked = targetPhase || (childFinished && !forLaunch && agentOwner)
    || ((toolFinished || outputEvent) && toolOwner) || child;
  // A late result belongs to its original phase, not the current reply summary.
  if (!materializing && !linked && details?.replyAnchor && (!summaryEvent || details.replyAnchor !== reply?.el)) sealDetails();
  if (!details && !linked) {
    const box = el('details', undefined, 'detail'), summary = el('summary', '正在处理'), body = el('div', undefined, 'detail-body');
    const replyAnchor = summaryEvent && reply?.el?.parentNode === $('messages') ? reply.el : null;
    box.append(summary, body);
    if (replyAnchor) $('messages').insertBefore(box, replyAnchor); else $('messages').append(box);
    details = { box, summary, body, replyAnchor, done: !activity, outcome: turnOutcome, pending: [], sealed: false, tools: new Map(), agents: new Set() }; phases.add(details); box._recordPhase = details; phaseLabel(details);
    const created = details;
    box.ontoggle = () => {
      recordsDirty = true;
      if (!box.open) return;
      flushDiagnostics(created);
    };
  }
  const phase = linked || details;
  // Track lifecycle even while the disclosure is collapsed. Materializing its
  // queued details later must not restart tools or overwrite current progress.
  if (!materializing) {
    if (!forLaunch && toolId && (name === 'agent:tool-started' || toolFinished || outputEvent)) diagnosticOwners.set('tool:'+toolId,phase);
    if (!forLaunch && typeof payload.subagentId === 'string' && payload.subagentId && (name === 'subagent:started' || childFinished)) diagnosticOwners.set('agent:'+payload.subagentId,phase);
    if (activityEventTime && (!phase.lastWorkAt || activityEventTime.iso > phase.lastWorkAt.iso)) phase.lastWorkAt = activityEventTime;
    if (name === 'agent:tool-started' && toolId) { phase.tools.set(toolId, payload); toolSteps.set(toolId, phase); }
    if (toolFinished && toolId) {
      phase.tools.delete(toolId);
      if (toolSteps.get(toolId) === phase) toolSteps.delete(toolId);
    }
    if (name === 'subagent:started' && payload.subagentId) {
      phase.agents.add(payload.subagentId); agentSteps.set(payload.subagentId, phase);
      if (toolOwner) subagentLaunchOwners.set(payload.subagentId, { toolId, phase: toolOwner });
    }
    if (childFinished && !forLaunch && payload.subagentId) {
      phase.agents.delete(payload.subagentId); agentSteps.delete(payload.subagentId); subagentLaunchOwners.delete(payload.subagentId);
    }
    if (phase === details && ['agent:tool-started', 'agent:thinking', 'agent:thinking-chunk', 'subagent:started'].includes(name)) { requestPhase = ''; responseStreaming = false; }
    phaseLabel(phase); refreshProgress();
  }
  // The native toggle event is asynchronous. Drain earlier chunks before any
  // live event that observes open=true, even if ontoggle has not run yet.
  if (!materializing && phase.box.open) flushDiagnostics(phase);
  if (!materializing && !phase.box.open) {
    phase.pending.push({ name, payload, forLaunch });
    return;
  }
  if (name === 'agent:thinking-chunk' || name === 'agent:thinking') {
    if (!phase.thinking) {
      const disclosure = el('details', undefined, 'step thinking-step');
      const summary = el('summary'), body = el('div', '', 'thinking-text');
      phase.thinking = body; phase.thinkingSummary = summary; body._source = '';
      disclosure.append(summary, body); appendDiagnosticRow(phase, disclosure);
      disclosure.ontoggle = () => { if (disclosure.open) renderThinkingContent(body, body._source); };
    }
    phase.thinking._source += payload.text || payload.thinking || payload.chunk || '';
    phase.thinkingSummary.textContent = '思路 · ' + thinkingPreview(phase.thinking._source);
    if (phase.thinking.parentNode.open) renderThinkingContent(phase.thinking, phase.thinking._source);
    else phase.thinking.textContent = phase.thinking._source;
    return;
  }
  // Late parallel results do not end the model's current thinking segment.
  if (name === 'agent:tool-started' || name === 'subagent:started') phase.thinking = null;
  if (outputEvent || ['agent:tool-started', 'agent:tool-completed', 'subagent:started', 'subagent:done'].includes(name)) {
    diagnosticCall(phase, name, payload, forLaunch);
    return;
  }
  // Batch bookkeeping and unknown extension events remain inspectable without
  // competing with actual operations in the primary detail list.
  diagnosticTrace(phase, name, payload);
}
function renderTodo(payload) {
  recordsDirty = true;
  const items = (Array.isArray(payload.todos) ? payload.todos : []).filter(t => t && typeof t.title === 'string');
  if (!items.length) { todo?.remove(); todo = null; return; }
  if (!todo) {
    // Match the desktop's content boundary: subsequent activity belongs below
    // the new plan. Later task updates keep both the plan and activity in place.
    sealDetails();
    todo = el('details', undefined, 'plan'); todo.open = true; $('messages').append(todo);
  }
  const summary = el('summary', `任务进度 · ${items.filter(t => t.status === 'done').length}/${items.length}`);
  const list = el('ul'); for (const item of items) { const li = el('li', item.title); li.dataset.state = item.status; list.append(li); }
  const plan = todo;
  // Native summary activation (including keyboard clicks) records user intent;
  // automatic completion may collapse and reopen only an untouched plan.
  summary.onclick = () => { plan.dataset.userToggled = 'true'; };
  todo.replaceChildren(summary, list);
  if (!todo.dataset.userToggled) todo.open = !items.every(t => t.status === 'done');
}
function renderUsage(p) {
  usage = p;
  const metrics = usageMetrics(p, modelInfo.contextWindow);
  const bits = [`${(metrics.total / 1000).toFixed(1)}k tokens`];
  if (!metrics.cacheReported) bits.push('缓存未提供');
  else if (metrics.hasCache) bits.push(`缓存 ${metrics.cachePercent}%`);
  if (metrics.contextPercent !== null) bits.push(`上下文 ${metrics.contextPercent}%`);
  $('usage').textContent = bits.join(' · ');
}
function renderImage(target, img, g, sid, did) {
  const mimeAllowed = /^image\/(png|jpeg|jpg|gif|webp)$/i;
  const inline = !img?.id && mimeAllowed.test(img?.mimeType) && typeof img.data === 'string'
    && img.data.length <= 8 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(img.data);
  if (!inline && !(typeof img?.id === 'string' && /^[a-z0-9_]+$/.test(img.id))) return;
  const isCurrent = () => g === generation && target.isConnected && b.isConnected;
  const b = button('查看图片', async () => {
    try {
      if (!isCurrent()) return;
      const result = inline ? img : await rpc('image', { session: sid, id: img.id }, did);
      if (!isCurrent() || !mimeAllowed.test(result.mimeType)) return;
      const i = el('img'); i.alt = '对话附件'; i.src = `data:${result.mimeType};base64,${result.data}`;
      await i.decode();
      if (isCurrent()) b.replaceWith(i);
    } catch (error) {
      // A switched or replayed message no longer owns the notice area.
      if (isCurrent()) throw error;
    }
  }, 'text-button'); target.append(b);
}
function frame(data) {
  activityEventTime = activityTimestamp(data.meta);
  const name = data.meta?.name, p = data.payload || {}, near = nearBottom();
  const lifecycle = turnLifecycle(name, turnOutcome);
  if (name === 'hub:history-window') {
    const banner = el('div', undefined, 'history-window');
    banner.append(el('span', p.hasEarlier ? '显示最近 12 轮对话' : '处理记录为精简预览'));
    banner.append(button('查看完整历史与处理记录', () => { fullHistory = true; connectStream(); }, 'text-button'));
    $('messages').append(banner); return;
  }
  if (name === 'hub:branch-switched') {
    // Rewind/branch changes rebuild history on the existing live stream.
    // Keep historical busy events from enabling actions between render batches.
    // A persisted reset can follow this replay's preview notice. Preserve
    // its full-history action, but never carry one across a live branch change.
    const preview = !streamReady && $('messages').querySelector('.history-window');
    beginSync('syncing', !streamReady); resetMessages();
    if (preview) $('messages').append(preview);
    renderConnectionStatus(); return;
  }
  if (name === 'hub:replay-done') { finishSync(); scheduleQueue(); refreshProgress(true); controls(); return; }
  if (name === 'agent:query') {
    if (streamReady) scheduleQueue();
    finishReply();
    // Desktop slash commands are visible stream boundaries, not new model
    // turns. Keep pending tools, the plan and live-segment deduplication.
    if (p.command === true) sealDetails();
    else if (p.steering === true) { sealDetails(); liveSegment = false; }
    else { settlePhases(turnOutcome); phases.clear(); toolSteps.clear(); turnOutcome = ''; todo = null; liveSegment = false; details = null; }
    const article = el('article', p.query || '', 'message user'); $('messages').append(article);
    for (const img of p.images || []) renderImage(article, img, generation, session, device);
  } else if (name === 'agent:response-chunk') { chunk((p.blocks || []).filter(b => b.type === 'text').map(b => b.text || '').join('')); liveSegment = true; }
  else if (name === 'agent:response-segment') { if (!liveSegment) chunk(p.text || ''); liveSegment = false; }
  // Hub segments are authoritative: a mid-turn replay flush may precede response-done,
  // while the remaining segment follows it. The full response would duplicate that tail.
  else if (name === 'agent:response-done') renderReply();
  else if (lifecycle?.started) { turnOutcome = lifecycle.outcome; setActivity(true); }
  else if (name === 'agent:request-status') {
    if (!activity || !['sending', 'waiting', 'retrying', 'clear'].includes(p.phase)) return;
    requestPhase = p.phase === 'clear' ? '' : p.phase;
    if (requestPhase) responseStreaming = false;
  }
  else if (name === 'agent:processing-done' || name === 'agent:cancelled') {
    finishReply();
    // Normal completion does not resolve background approvals. Their own
    // resolved/cleanup/expiry events remain authoritative; cancel stops all.
    turnOutcome = lifecycle.outcome === 'done' ? '' : lifecycle.outcome;
    if (name === 'agent:cancelled') { for (const card of permissions.values()) card.remove(); permissions.clear(); }
    setActivity(false); refreshProgress(true);
  }
  else if (name === 'agent:error') { finishReply(); turnOutcome = lifecycle.outcome; setActivity(false); const e = el('p', '回复中断：' + (p.message || p.error || '请在电脑端检查'), 'message interruption'); $('messages').append(e); }
  else if (name === 'agent:tool-started') { finishReply(); liveSegment = false; diagnostic(name, p); }
  else if (name === 'agent:queued' || name === 'agent:queued-done' || name === 'agent:queue-updated') { if (streamReady) scheduleQueue(); if (name === 'agent:queued' && !capabilities.queue) notice('消息已进入本地队列'); }
  else if (name === 'permission:request' && p.pending !== false && p.expiresAt > Date.now()) {
    if (permissions.has(p.requestId)) return;
    const card = el('section', undefined, 'permission'), sid = session, did = device, g = generation;
    card.append(el('strong', p.title || '需要你的确认'));
    if (p.filePath || p.path) card.append(el('p', p.filePath || p.path, 'permission-path'));
    if (p.description) card.append(el('p', p.description));
    appendApprovalPreview(card, p.items);
    const diagnostic = el('details', undefined, 'permission-detail'); diagnostic.append(el('summary', '操作详情'), el('pre', JSON.stringify(p, null, 2))); card.append(diagnostic);
    const persistent = p.scope === 'site' || p.scope === 'daily7';
    const desktopOnly = persistent || p.requiresDesktop === true;
    if (desktopOnly) {
      const reason = p.scope === 'site' ? '访问整个站点需要在电脑端确认'
        : p.scope === 'daily7' ? '连续 7 天的授权需要在电脑端确认'
        : p.acpExtendedOption === null ? '代理仅提供拒绝选项，本次请求仅可拒绝'
        : '此操作缺少明确的单次授权选项，需要在电脑端确认';
      card.append(el('p', reason));
    }
    const choices = desktopOnly ? [['拒绝', 'denied']] : [['允许本次', 'approved'], ['拒绝', 'denied']];
    const account = authGeneration;
    const key = JSON.stringify([account, did, sid, p.requestId]);
    const sameConversation = () => account === authGeneration && did === device && sid === session;
    const actions = choices.map(([label, outcome]) => button(label, async () => {
      if (g !== generation || !card.isConnected || pendingDecisions.has(key)) return;
      pendingDecisions.add(key); card.refreshDecision();
      try {
        let ack;
        try { ack = await rpc('permission', { session: sid, requestId: p.requestId, outcome }, did); }
        catch (error) {
          if (!sameConversation() || !permissions.has(p.requestId)) return;
          if (error.status !== 409 || error.message !== 'permission expired or already handled') throw error;
        }
        if (!sameConversation() || (!permissions.has(p.requestId) && !permissionRecords.has(p.requestId))) return;
        resolvePermission(p.requestId, ack?.outcome); refreshProgress(true);
      } finally {
        pendingDecisions.delete(key);
        if (sameConversation()) permissions.get(p.requestId)?.refreshDecision();
      }
    }, ''));
    card.refreshDecision = () => { for (const action of actions) action.disabled = pendingDecisions.has(key); };
    card.append(...actions); card.refreshDecision();
    permissions.set(p.requestId, card); $('messages').append(card);
    setTimeout(() => {
      if (g !== generation || permissions.get(p.requestId) !== card) return;
      if (card.isConnected) {
        card.replaceChildren(el('span', '此审批已到期'));
        permissionRecords.set(p.requestId, card);
      }
      permissions.delete(p.requestId); refreshProgress(true);
    }, Math.max(0, p.expiresAt - Date.now()));
  } else if (name === 'permission:resolved') resolvePermission(p.requestId, p.outcome);
  else if (name === 'permission:request-cleanup') { for (const card of permissions.values()) card.remove(); permissions.clear(); }
  else if (name === 'session:title') $('chat-title').textContent = p.title || '新对话';
  else if (name === 'agent:info') updateModelInfo(p);
  else if (name === 'agent:usage') renderUsage(p);
  // Child counters are not main-turn progress or cache usage (desktop parity).
  else if (name === 'subagent:usage') return;
  // Storage/restore warnings matter remotely too, but do not end the model turn.
  else if (name === 'ui:error') notice(p.message || '操作未完成，请在电脑端检查');
  else if (name === 'agent:todo') renderTodo(p);
  else if (name === 'hub:compaction-marker') {
    $('messages').append(globalThis.AsHubConversationPresentation.renderCompaction(p));
  } else if (name === 'ui:info') {
    const presentation=globalThis.AsHubConversationPresentation, stats=presentation.parseCompactionNotice(p.message);
    if(stats && !presentation.mergeCompactionNotice($('messages'),p.message)) $('messages').append(presentation.renderCompaction(stats));
  }
  else if (name?.includes('tool-') || name?.startsWith('subagent:') || name === 'agent:thinking' || name === 'agent:thinking-chunk') diagnostic(name, p);
  refreshProgress(name?.startsWith('permission:')); scroll(near);
}
function resumeStream() {
  if (syncPhase === 'limited') return;
  connectStream({preserveWait: true, reconnecting: syncPhase === 'reconnecting'});
}
function connectStream({preserveWait = false, reconnecting = false} = {}) {
  closeSource({retainWait: preserveWait});
  if (!session || viewHidden() || !onlineDevice()) return;
  const g = generation, did = device, sid = session;
  const url = new URL(`api/devices/${encodeURIComponent(did)}/events?session=${encodeURIComponent(sid)}&history=${fullHistory ? 'all' : 'recent'}&viewer=${streamViewer}&attempt=${++streamAttempt}`, base);
  const s = new EventSource(url); source = s;
  const current = () => g === generation && device === did && session === sid && source === s && !viewHidden();
  beginSync(reconnecting ? 'reconnecting' : 'syncing', preserveWait);
  s.onopen = () => {
    if (!current()) return;
    if (!streamReady) beginSync('syncing', true);
    clearInterval(streamRenewal);
    streamRenewal = setInterval(() => {
      if (!current()) return;
      void fetch(url, {method:'POST', cache:'no-store', signal:AbortSignal.timeout(8000)}).then(async response => {
        await response.body?.cancel();
        if (current() && response.status === 405) { clearInterval(streamRenewal); streamRenewal = null; }
      }).catch(() => {});
    }, 15000);
  };
  s.addEventListener('reset', () => {
    if (!current()) return;
    clearFrameQueue(); beginSync('syncing', !streamReady); resetMessages();
  });
  s.onmessage = e => {
    if (!current()) return;
    try {
      const frame = JSON.parse(e.data);
      if (frame.meta?.name === 'hub:stream-limit') {
        closeSource(); syncPhase = 'limited'; renderConnectionStatus();
      } else enqueueFrame(frame);
    } catch { notice('部分内容暂时无法显示，请刷新对话'); }
  };
  s.onerror = () => {
    if (!current()) return;
    closeSource({retainWait: true}); beginSync('reconnecting', true);
    const wait = syncWait;
    reconnectTimer = setTimeout(() => {
      if (syncWait !== wait || !ownsSyncWait(wait) || source || viewHidden() || !onlineDevice()) return;
      reconnectTimer = null; connectStream({preserveWait: true, reconnecting: true});
    }, Math.min(2000 * 2 ** reconnectAttempt++, 15000));
  };
}
if ($('sync-retry')) $('sync-retry').onclick = () => {
  if (streamReady || viewHidden() || !onlineDevice() || (syncPhase !== 'limited' && (!ownsSyncWait(syncWait) || Date.now() - syncWait.started < SYNC_WAIT_MS))) return;
  // Do not call openSession: it resets history range and pending-send state.
  // Only replace the subscription; the current send receipt keeps its owner.
  saveDraft(); connectStream();
};
async function openSession(id) {
  cancelSessionRestore();
  composerMedia?.cancel(); fullHistory = false; clearFrameQueue(); saveDraft(); closeSource(); generation++; globalThis.AsHubFilePreview?.close(); taskView++; $('modal').close(); session = id; queuedMessages = []; images = draftImages(); renderAttachments(); sending = false; pendingSend = null;
  $('query').value = storage.get(key('draft')) || ''; rememberSession(id); syncChatTitle(); notice(); menu(false); resetMessages(); connectStream();
  renderSessions();
  const pending = storage.get(key('pending')); if (pending) { sending = true; controls(); void checkPending(pending, generation, key('pending')); }
}
async function waitRequest(requestId, target = device) {
  for (let n = 0; n < 30; n++) { const r = await rpc('request-status', { requestId }, target); if (r.state === 'done') return r.result; if (r.state === 'unknown') throw Error(r.error || '结果未知，请先在桌面确认'); await new Promise(r => setTimeout(r, 1000)); }
  throw Error('请求尚未完成，请刷新会话列表查看');
}
async function checkPending(id, g, pendingKey) {
  const did = device, transfer = inFlightSends.get(pendingKey), check = {};
  pendingChecks.set(pendingKey, check);
  try {
    const r = await rpc('request-status', { requestId: id }, did); if (g !== generation || storage.get(pendingKey) !== id) return;
    // An older nonterminal snapshot must not undo a newer confirmation. A done
    // receipt is definitive for this request and may still settle it out of order.
    if (pendingChecks.get(pendingKey) !== check && r.state !== 'done') return;
    // A missing snapshot taken before submit settles is not a rejection. It may
    // have raced upload/authorization, even if the submit response arrived first.
    if (r.state === 'missing' && (transfer?.id === id || inFlightSends.get(pendingKey)?.id === id)) {
      notice('正在确认发送，请稍候');
      setTimeout(() => { if (g === generation && storage.get(pendingKey) === id) void checkPending(id, g, pendingKey); }, 2500);
    } else if (r.state === 'missing' || r.state === 'unknown') {
      notice(r.error || '上次发送结果未确认，请先查看对话，再决定是否重发');
      if (!$('query').value) $('query').value = storage.get(pendingKey + ':draft') || '';
      saveDraft(); pendingSend = null; storage.remove(pendingKey); storage.remove(pendingKey + ':draft');
    } else if (r.state === 'done') {
      const sent = pendingImageSends.get(pendingKey);
      let refs = []; try { refs = JSON.parse(storage.get(pendingKey + ':images') || '[]'); } catch {}
      images = images.filter(img => sent?.id === id ? !sent.images.includes(img) : !refs.includes(img.id));
      renderAttachments(); storeImages(key('draft'), images); pendingImageSends.delete(pendingKey);
      storage.remove(pendingKey + ':images');
      if (pendingSend?.id === id && pendingSend.key === pendingKey) pendingSend = null;
      if ($('query').value === storage.get(pendingKey + ':draft')) { $('query').value = ''; saveDraft(); }
      storage.remove(pendingKey); storage.remove(pendingKey + ':draft'); notice();
    } else {
      notice('消息已交给电脑处理');
      setTimeout(() => { if (g === generation && storage.get(pendingKey) === id) void checkPending(id, g, pendingKey); }, 2500);
    }
  } catch (e) { if (g === generation && storage.get(pendingKey) === id && pendingChecks.get(pendingKey) === check) { notice('无法确认发送状态，恢复连接后再检查'); setTimeout(() => { if (g === generation && storage.get(pendingKey) === id) void checkPending(id, g, pendingKey); }, 15000); } }
  finally { if (pendingChecks.get(pendingKey) === check && !storage.get(pendingKey)) pendingChecks.delete(pendingKey); if (g === generation) { sending = !!storage.get(pendingKey); if (!sending) { pendingImageSends.delete(pendingKey); storage.remove(pendingKey + ':images'); } controls(); } }
}
$('composer').onsubmit = async e => {
  e.preventDefault(); if (sending || !streamReady || (!$('query').value.trim() && !images.length)) return;
  const requestId = crypto.randomUUID(), g = generation, k = key('pending'), query = $('query').value, submittedImages = [...images]; pendingSend = { id: requestId, key: k, images: submittedImages }; sending = true; storage.set(k, requestId); storage.set(k + ':draft', query); controls();
  const transfer = { id: requestId }; inFlightSends.set(k, transfer);
  pendingImageSends.set(k, { id: requestId, images: submittedImages }); storage.set(k + ':images', JSON.stringify(submittedImages.filter(img => img.id).map(img => img.id)));
  let sendError;
  try { await rpc('submit', { session, query, images: submittedImages.map(({ id, data, mimeType }) => id ? ({ id, mimeType }) : ({ data, mimeType })), requestId, ...(activity && capabilities.steering ? {delivery: deliveryMode} : {}) }); }
  catch (e) { sendError = e; }
  finally { if (inFlightSends.get(k) === transfer) inFlightSends.delete(k); }
  if (g !== generation || storage.get(k) !== requestId) return;
  if (sendError) notice(sendError.message + '；正在确认发送状态');
  await checkPending(requestId, g, k);
};
$('stop').onclick = () => rpc('cancel', { session }).catch(e => notice(e.message));
function renderAttachments() { $('attachments').replaceChildren(...images.map((img, i) => button((img.name || '图片') + ' ×', () => { images.splice(i, 1); renderAttachments(); saveDraft(); }, 'text-button'))); }
$('image-input').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length || !user || !device || !session) return;
  const epoch = authGeneration, draftKey = key('draft');
  saveDraft();
  const active = () => key('draft') === draftKey;
  const current = () => epoch === authGeneration && imageDrafts.has(draftKey);
  const warn = text => { if (current() && active()) notice(text); };
  for (const f of files) {
    if (!current()) return;
    if (draftImages(draftKey).length >= 4 || f.size > 3 * 1024 * 1024 || !/^image\/(png|jpeg|webp|gif)$/.test(f.type)) {
      warn('最多 4 张图片，每张不超过 3 MB');
      continue;
    }
    let data;
    try {
      data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(f);
      });
    } catch {
      warn('无法读取图片，请重新选择');
      continue;
    }
    // File reading can outlast a conversation switch. Keep the image in the
    // original draft, unless the account changed or the draft was deleted.
    if (!current()) return;
    const draft = draftImages(draftKey);
    if (draft.length >= 4) { warn('最多 4 张图片，每张不超过 3 MB'); continue; }
    const totalSize = draft.reduce((size, image) => size + (image.data?.length || 0), data.length);
    if (totalSize > 5 * 1024 * 1024) { warn('图片总大小超过限制'); continue; }
    draft.push({ data, mimeType: f.type, name: f.name });
    storeImages(draftKey, draft);
    if (active()) renderAttachments();
  }
};
$('new-chat').onclick = async () => {
  cancelSessionRestore();
  const g = generation, ticket = ++taskView;
  const current = () => g === generation && ticket === taskView;
  try { const did = device, projects = await rpc('projects'); if (!current()) return; modal('选择工作目录', projects.map(p => { const id = crypto.randomUUID(); return button(p.name, async () => {
    await rpc('create', { project: p.id, requestId: id }, did); const result = await waitRequest(id, did); if (g !== generation || device !== did) return; $('modal').close(); await refreshSessions(); if (g !== generation || device !== did) return; await openSession(result.id || result.instanceId);
  }); })); } catch (e) { if (current()) notice(e.message); }
};
const thinkingLabel = level => ({default:'默认',off:'关闭',none:'关闭',on:'开启'})[level] || level;
function updateModelInfo(p) {
  if (p.name === 'web-renderer') return;
  const changed = (p.model && p.model !== modelInfo.model) || (p.provider && p.provider !== modelInfo.provider);
  if (changed) modelInfo = {model: p.model || modelInfo.model, provider: p.provider || modelInfo.provider};
  const reasoningChanged = p.model || p.provider || typeof p.thinkingLevel === 'string' || typeof p.thinkingSupported === 'boolean' || Array.isArray(p.thinkingLevels);
  if (reasoningChanged) modelRevision++;
  modelInfo = { ...modelInfo, ...p };
  $('model').textContent = modelInfo.model || '模型';
  const depth = modelInfo.thinkingSupported && modelInfo.thinkingLevel ? '思考 · ' + thinkingLabel(modelInfo.thinkingLevel) : '';
  $('model').title = [modelInfo.provider, modelInfo.model, depth].filter(Boolean).join(' · ');
  if (usage) renderUsage(usage);
  if (reasoningChanged) modelPicker?.sync();
  else modelPicker?.render();
}
function applyThinking(data) {
  if (!data || typeof data.model !== 'string' || typeof data.provider !== 'string' || typeof data.level !== 'string'
    || !Array.isArray(data.levels) || !data.levels.every(v => typeof v === 'string')) throw Error('无法读取思考选项，请重试');
  updateModelInfo({model:data.model, provider:data.provider, thinkingLevel:data.level, thinkingLevels:data.levels,
    thinkingSupported:data.supported === true, thinkingDefault:data.defaultLevel});
}
$('model').onclick = async () => {
  const g = generation, sid = session, did = device;
  modal('模型与思考', [el('p', '正在读取模型…', 'picker-note')]);
  $('modal').classList.toggle('model-dialog', true);
  const ticket = taskView;
  const current = () => g === generation && sid === session && did === device && ticket === taskView && $('modal').open;
  const error = el('p', '', 'picker-error'); error.setAttribute('role', 'status');
  try {
    const models = await rpc('models', {}, did); if (!current()) return;
    const search = el('input'); search.type = 'search'; search.placeholder = '搜索模型或提供商'; search.setAttribute('aria-label', '搜索模型');
    const list = el('div', undefined, 'model-options'), thinking = el('section', undefined, 'model-thinking');
    const note = el('p', '与桌面同步 · 使用电脑端已配置的模型', 'picker-note');
    let busy = false, loading = false, failed = false, readSeq = 0, signature = '', options = [];
    const editable = () => !activity && streamReady && devices.some(d => d.id === did && d.online);
    const choices = () => modelInfo.thinkingSupported && Array.isArray(modelInfo.thinkingLevels) && modelInfo.thinkingLevels.length
      ? ['default', ...modelInfo.thinkingLevels] : [];
    function render() {
      if (!current()) return;
      for (const b of options) {
        const selected = b.dataset.model === modelInfo.model && b.dataset.provider === modelInfo.provider;
        b.setAttribute('aria-pressed', String(selected)); b.classList.toggle('selected', selected); b.disabled = busy || !editable();
      }
      const next = JSON.stringify([modelInfo, busy, loading, failed, editable(), capabilities.thinking]);
      if (signature === next) return; signature = next;
      const focused = thinking.contains?.(document.activeElement) ? document.activeElement?.dataset.level : null;
      const head = el('div', undefined, 'thinking-head');
      head.append(el('span', '思考深度'), el('span', busy ? '正在保存…' : loading ? '正在读取…' : thinkingLabel(modelInfo.thinkingLevel || 'default'), 'thinking-value'));
      thinking.replaceChildren(head); thinking.setAttribute('aria-busy', String(busy || loading));
      if (!capabilities.thinking) { thinking.append(el('p', '此电脑暂不支持远程调整思考深度，请更新桌面端后刷新', 'picker-note')); return; }
      if (failed) { thinking.append(button('重新读取思考选项', () => load(), 'text-button')); return; }
      if (loading) return;
      if (!choices().length) { thinking.append(el('p', '此模型未提供可调整的思考深度', 'picker-note')); return; }
      const levels = el('div', undefined, 'thinking-options'); levels.setAttribute('role', 'group'); levels.setAttribute('aria-label', '思考深度');
      for (const level of choices()) {
        const b = button(thinkingLabel(level), () => save(level), 'thinking-option'); b.dataset.level = level;
        b.setAttribute('aria-pressed', String(level === modelInfo.thinkingLevel)); b.disabled = busy || !editable(); levels.append(b);
        // Restore keyboard focus only when it was inside these options.
        if (level === focused && !b.disabled) queueMicrotask(() => { if (current() && b.isConnected) b.focus(); });
      }
      thinking.append(levels);
      thinking.append(el('p', activity ? '回复结束后可调整' : '仅列出当前模型支持的等级 · 默认由模型决定', 'picker-note'));
    }
    async function load() {
      if (!current() || !capabilities.thinking) return;
      const seq = ++readSeq, revision = modelRevision; loading = true; failed = false; error.textContent = ''; render();
      try {
        const data = await rpc('thinking', {session:sid}, did);
        if (!current() || seq !== readSeq || revision !== modelRevision) return;
        applyThinking(data);
      } catch (e) {
        if (current() && seq === readSeq && revision === modelRevision) { failed = true; error.textContent = e.message; }
      } finally { if (current() && seq === readSeq) { loading = false; render(); } }
    }
    async function save(level) {
      if (!current() || busy || loading || !editable() || !choices().includes(level)) return;
      const identity = {model:modelInfo.model,provider:modelInfo.provider}, revision = modelRevision;
      busy = true; ++readSeq; error.textContent = ''; render();
      try {
        const data = await rpc('set-thinking', {session:sid,...identity,level}, did);
        if (current() && revision === modelRevision) applyThinking(data);
      } catch (e) { if (current() && revision === modelRevision) error.textContent = e.message; }
      finally { if (current()) { busy = false; render(); } }
    }
    async function select(name, provider) {
      if (!current() || busy || !editable()) return;
      const revision = modelRevision; busy = true; loading = false; ++readSeq; error.textContent = ''; render();
      try {
        await rpc('model', {session:sid,model:name,provider}, did); if (!current()) return;
        // A later desktop event is authoritative, including an A → B → A switch.
        if (revision === modelRevision) updateModelInfo({model:name,provider});
        await load();
      } catch (e) { if (current()) error.textContent = e.message; }
      finally { if (current()) { busy = false; render(); } }
    }
    function filter() {
      const query = search.value.toLowerCase(); list.replaceChildren(); options = [];
      for (const p of models.providers || []) {
        const label = p.name === 'codex' ? 'OpenAI Coding Plan' : p.name;
        const matches = (p.models || []).filter(m => ((typeof m === 'string' ? m : m.id) + ' ' + p.name + ' ' + label).toLowerCase().includes(query));
        if (!matches.length) continue;
        list.append(el('p', label, 'section-label'));
        for (const m of matches) {
          const name = typeof m === 'string' ? m : m.id;
          const b = el('button', name, 'model-option'); b.onclick = () => select(name,p.name); b.dataset.model = name; b.dataset.provider = p.name;
          list.append(b); options.push(b);
        }
      }
      if (!options.length) list.append(el('p', '没有匹配的模型', 'picker-note'));
      render();
    }
    search.oninput = filter;
    $('modal-body').replaceChildren(search, list, thinking, error, note);
    modelPicker = {render, sync() { failed = false; loading = false; error.textContent = ''; ++readSeq; render(); }}; filter(); await load();
  } catch (e) {
    if (current()) $('modal-body').replaceChildren(el('p', e.message, 'picker-error'), button('重新读取模型', () => $('model').onclick()));
  }
};
$('sharing-help').onclick = () => modal('对话共享范围', [
  el('p', '这里只显示当前电脑已授权项目目录中的对话，不限制对话数量。'),
  el('p', '缺少对话时，请在桌面端「设备互联 → 允许其他设备访问本机 → 设置共享目录」添加该对话的工作目录，再确认授权。目录已移动或删除的对话，请先在桌面恢复或调整工作目录。归档对话需先在桌面恢复。')
]);
$('account').onclick = async () => {
  cancelSessionRestore();
  const g = generation, ticket = ++taskView, epoch = authGeneration;
  const current = () => g === generation && ticket === taskView;
  try { const list = await api('devices'); if (!current()) return; modal('账号与设备', [el('p', user), ...list.map(d => {
    const card = el('div', undefined, 'device-card'), info = el('div', undefined, 'device-info');
    info.append(el('div', d.name), el('small', d.online ? '在线' : '离线')); card.append(info);
    card.append(button('解绑', async () => { modal('移除设备授权', [el('p', `移除「${d.name}」后，将立即断开远程访问。重新使用需在桌面端「设备互联 → 允许其他设备访问本机」验证账号并授权。`), button('确认解绑', async () => { await api(`devices/${d.id}`, {}, 'DELETE'); if (g !== generation) return; $('modal').close(); await refreshDevices(); })]); }, '')); return card;
  }), button('退出其他网页登录', () => api('logout-others', {}).then(() => { if (g === generation) notice('其他网页登录已退出'); })), button('退出登录', async () => { saveDraft(); await api('logout', {}); if (epoch === authGeneration) signOut(); })]); } catch (e) { if (current()) notice(e.message); }
};
function resumeRemoteView() {
  if (!user || viewHidden()) return;
  const epoch = authGeneration, g = generation;
  if (session && !source && onlineDevice() && syncPhase !== 'limited') {
    if (!ownsSyncWait(syncWait)) beginSync('reconnecting');
    else { syncPhase = 'reconnecting'; renderConnectionStatus(); }
  }
  void refreshDevices().then(() => {
    if (epoch !== authGeneration || g !== generation || viewHidden()) return;
    const id = storage.get(key('pending')); if (id) return checkPending(id, generation, key('pending'));
  }).catch(e => { if (epoch === authGeneration && g === generation && !viewHidden()) notice(e.message); });
}
document.addEventListener('visibilitychange', () => { if (viewHidden()) { saveDraft(); closeSource(); } else resumeRemoteView(); });
window.addEventListener('pagehide', () => { pageSuspended = true; saveDraft(); closeSource(); });
window.addEventListener('pageshow', e => { const resume = pageSuspended || e.persisted; pageSuspended = false; if (resume) resumeRemoteView(); });
window.addEventListener('online', resumeRemoteView);
const bootEpoch = authGeneration;
void api('me').then(r => { if (bootEpoch === authGeneration) return start(r.username); }).catch(() => {});
if ('serviceWorker' in navigator) void navigator.serviceWorker.register(new URL('sw.js', base)).catch(() => {});

var composerMedia = globalThis.AsHubComposerMedia?.mount({container:document.querySelector('.composer-tools > div'),input:$('query'),form:$('composer'),
 owner:()=>session?device+':'+session+':'+generation+':'+authGeneration:'',enabled:()=>!!capabilities.composerInputs&&streamReady&&onlineDevice()&&!sending&&!pendingSend,
 request:(target,action,args)=>rpc('composer-input',{...args,session:target.split(':')[1],action},target.split(':')[0])});
