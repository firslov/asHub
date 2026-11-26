import './composer-media.js';
import { extractMath, renderMathIn } from './math.js';
import { mountResource } from './extensions/resource-view.js';
const $ = id => document.getElementById(id), el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined)
    n.textContent = text; if (cls)
    n.className = cls; return n; };
// A workspace is immutable: changing machines creates/focuses another window.
const backend = new URL(location.href).searchParams.get('connection');
if (!/^[a-f0-9]{32}$/.test(backend || ''))
    throw Error('Invalid backend workspace');
const base = '/api/backends/' + backend, presentation = globalThis.AsHubConversationPresentation;
const streamViewer = crypto.randomUUID();
let streamAttempt = 0;
const stored = { get: key => { try {
        return localStorage.getItem('ash.backend.' + backend + '.' + key);
    }
    catch {
        return null;
    } }, set: (key, value) => { try {
        if (value === null)
            localStorage.removeItem('ash.backend.' + backend + '.' + key);
        else
            localStorage.setItem('ash.backend.' + backend + '.' + key, value);
    }
    catch { } } };
let session = '', generation = 0, source = null, ready = false, busy = false, online = false, sessions = [], groups = [], pluginEntries = [], capabilities = {}, modelInfo = {}, images = [], reply = null, liveSegment = false, phase = null, turnOutcome = '', retry = null, queueTimer = null, renderTimer = null, modalGeneration = 0, disposeResource = null, catalogVersion = 0, queueVersion = 0, receiptTimer = null;
const owners = new Map(), approvals = new Map(), imageDrafts = new Map();
const SYNC_WAIT_MS = 12000;
let syncWait = null, syncTimer = null, syncPhase = 'idle', suspended = false, invalidated = false, connectionNotice = '';
let renderedSessions = '';
const hidden = () => document.hidden || suspended;
const text = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
function syncStatus() {
    const expired = syncWait && syncWait.g === generation && syncWait.sid === session && Date.now() - syncWait.started >= SYNC_WAIT_MS;
    text('connection', syncPhase === 'ready' ? '已同步 · 在远程电脑执行' : syncPhase === 'syncing' ? '正在同步对话…' : syncPhase === 'reconnecting' ? '连接中断，正在恢复…' : syncPhase === 'invalid' ? '授权已失效' : syncPhase === 'offline' ? '执行设备离线' : syncPhase === 'unknown' ? '设备状态待确认' : syncPhase === 'limited' ? '打开的远控对话过多' : syncPhase === 'paused' ? '连接已暂停' : '选择一个对话');
    const help = syncPhase === 'invalid' ? '请返回设备列表重新登录或确认授权。草稿与发送回执已保留。'
        : syncPhase === 'offline' ? '请在执行设备上启动 asHub 并保持联网，恢复后将自动同步。'
        : syncPhase === 'unknown' ? '暂时无法确认设备状态，正在重试。草稿与发送回执已保留。'
        : syncPhase === 'limited' ? '请关闭一个不用的远控对话窗口，然后重新同步。草稿与发送回执已保留。'
        : expired && !ready && !hidden() ? '同步用时较长，可以重新同步。草稿和待确认发送将保留，不会自动重发。' : '';
    text('sync-help', help); $('sync-status').hidden = !help;
    $('sync-retry').hidden = !session || hidden() || (syncPhase !== 'limited' && (!expired || !['syncing','reconnecting','unknown'].includes(syncPhase)));
}
function watchSync() {
    ready = false;
    if (!syncWait || syncWait.g !== generation || syncWait.sid !== session) syncWait = { g: generation, sid: session, started: Date.now() };
    clearTimeout(syncTimer); const ticket = syncWait;
    syncTimer = setTimeout(() => { if (syncWait === ticket) syncStatus(); }, Math.max(0, SYNC_WAIT_MS - (Date.now() - ticket.started)));
    syncStatus(); controls();
}
function stopWatch() { clearTimeout(syncTimer); syncTimer = null; syncWait = null; }
function retryConnection() {
    clearTimeout(retry);
    const g = generation;
    if (session && !hidden() && !invalidated && syncPhase !== 'limited') retry = setTimeout(() => { if (g === generation && !hidden()) void refresh(); }, 2000);
}
let frameQueue = [], frameTimer = null;
function notice(text = '') { $('notice').textContent = text; $('notice').hidden = !text; }
async function api(path, body, signal) { const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(35000), cache: 'no-store' }); const value = await r.json(); if (!r.ok)
    throw Object.assign(Error(value.error || '连接失败'), { status: r.status }); return value; }
const rpc = (op, args = {}, signal) => api('/request', { op, args }, signal);
function controls() { const enabled = online && ready && !!session; $('query').disabled = !enabled; $('send').disabled = !enabled || !!pending(); $('upload').disabled = !enabled; $('model').disabled = !enabled || busy; $('stop').hidden = !enabled || !busy; $('delivery').hidden = !busy || !capabilities.steering; $('settings').hidden = !session; $('create').disabled = !online; for (const b of approvals.values())
    for (const a of b.querySelectorAll('button'))
        a.disabled = !enabled || b.deciding || b.expiresAt <= Date.now(); }
function draft() { if (session) { stored.set(session + '.draft', $('query').value); imageDrafts.set(session, images.slice()); } }
function pending() { try {
    return session ? JSON.parse(stored.get(session + '.pending') || 'null') : null;
}
catch {
    return null;
} }
function modal(title, nodes) { disposeResource?.(); disposeResource = null; modalGeneration++; $('dialog-title').textContent = title; $('dialog-body').replaceChildren(...nodes); if (!$('dialog').open)
    $('dialog').showModal(); return modalGeneration; }
function closeModal() { modalGeneration++; disposeResource?.(); disposeResource = null; $('dialog').close(); }
$('dialog-close').onclick = closeModal;
$('dialog').addEventListener('close', () => { disposeResource?.(); disposeResource = null; modalGeneration++; });
function button(label, run) { const b = el('button', label); b.type = 'button'; b.onclick = async () => { const owner = generation; b.disabled = true; try {
    await run();
}
catch (e) {
    if (owner === generation && b.isConnected)
        notice(e.message);
}
finally {
    if (b.isConnected)
        b.disabled = false;
} }; return b; }
function saveTheme(theme) { document.documentElement.dataset.theme = theme; stored.set('theme', theme); }
saveTheme(stored.get('theme') || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'));
$('theme').onclick = () => saveTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
function renderSessions() {
    const search = $('search').value.trim().toLowerCase(), nodes = [], dedicated = new Set();
    const row = (s, entryLabel = '') => {
        const b = button(entryLabel || s.title || '未命名对话', () => openSession(s.instanceId));
        b.dataset.sessionId = s.instanceId;
        b.classList.toggle('bw-dedicated-session', !!entryLabel);
        if (session === s.instanceId) {
            b.classList.add('active');
            b.setAttribute('aria-current', 'page');
        }
        b.title = s.title || entryLabel || s.instanceId;
        return b;
    };
    const shared = new Map(sessions.map(s => [s.instanceId, s]));
    // Registered plugin conversations have a stable entry label even after a
    // rename. The current shared list is still the source of accessible chats.
    for (const entry of pluginEntries) {
        const s = shared.get(entry?.sessionId);
        if (!s || dedicated.has(s.instanceId) || typeof entry.label !== 'string' || !entry.label.trim())
            continue;
        dedicated.add(s.instanceId);
        if (!search || [entry.label, s.title || ''].some(label => label.toLowerCase().includes(search)))
            nodes.push(row(s, entry.label));
    }
    const placed = new Set(dedicated);
    for (const group of groups) {
        const rows = sessions.filter(s => !dedicated.has(s.instanceId) && ((group.sessionIds || []).includes(s.instanceId) || s.projectId === group.id)).filter(s => !search || (group.name + ' ' + s.title).toLowerCase().includes(search));
        if (!rows.length)
            continue;
        const pins = group.pinnedSessionIds || [];
        rows.sort((a, b) => { const i = pins.indexOf(a.instanceId), j = pins.indexOf(b.instanceId); return (i < 0 ? Infinity : i) - (j < 0 ? Infinity : j); });
        nodes.push(el('h3', group.name));
        for (const s of rows) {
            placed.add(s.instanceId);
            nodes.push(row(s));
        }
    }
    const rest = sessions.filter(s => !placed.has(s.instanceId) && (!search || String(s.title || '').toLowerCase().includes(search)));
    if (rest.length) {
        nodes.push(el('h3', '独立对话'));
        nodes.push(...rest.map(s => row(s)));
    }
    const signature = JSON.stringify(nodes.map(node => [node.tagName, node.textContent, node.dataset.sessionId, node.title, node.className]));
    // Background reads can complete between pointer-down and pointer-up.
    // Keep the buttons themselves when the rendered navigation is identical.
    if (signature !== renderedSessions) {
        const list = $('sessions'), focus = document.activeElement?.dataset.sessionId, scrollTop = list.scrollTop;
        list.replaceChildren(...nodes);
        renderedSessions = signature;
        if (focus)
            nodes.find(node => node.dataset.sessionId === focus)?.focus({ preventScroll: true });
        list.scrollTop = scrollTop;
    }
    $('title').textContent = sessions.find(s => s.instanceId === session)?.title || '选择一个对话';
}
$('search').oninput = renderSessions;
async function refreshCatalog(version, operation, update, warning) {
    try {
        const value = await rpc(operation);
        if (version !== catalogVersion)
            return;
        if (!Array.isArray(value))
            throw Error('收到无法识别的列表');
        update(value);
        renderSessions();
    } catch (error) {
        if (version === catalogVersion && warning)
            notice(warning + error.message);
    }
}
async function refresh() {
    const version = ++catalogVersion, owner = generation, connection = source;
    const current = () => version === catalogVersion && owner === generation && connection === source;
    if (session && !source && !hidden() && !invalidated && !['offline','limited'].includes(syncPhase)) {
        if (syncPhase !== 'unknown') syncPhase = 'reconnecting';
        watchSync();
    }
    try {
        const info = await api('/info');
        if (!current())
            return;
        online = info.online; invalidated = false;
        if (connectionNotice && $('notice').textContent === connectionNotice) notice();
        connectionNotice = '';
        $('device-name').textContent = info.label;
        document.title = info.label + ' · asHub';
        text('execution-device', '执行设备：' + info.label); $('execution-device').title = info.label;
        $('device-status').textContent = online ? '在线 · 远程执行' : info.status === 'unknown' ? '状态待确认' : '离线 · 草稿已保留';
        controls();
        if (!online) {
            disconnect({ retainWait: info.status === 'unknown' });
            syncPhase = info.status === 'unknown' ? 'unknown' : 'offline'; syncStatus(); retryConnection();
            return;
        }
        const [list, caps] = await Promise.all([rpc('sessions'), rpc('capabilities')]);
        if (!current())
            return;
        sessions = list;
        capabilities = caps;
        if (!caps.projects)
            groups = [];
        // A later reuse of the same identifier must be classified by fresh
        // metadata once it has disappeared from the authorized list.
        pluginEntries = caps.pluginResources ? pluginEntries.filter(entry => sessions.some(s => s.instanceId === entry?.sessionId)) : [];
        if (session && !sessions.some(s => s.instanceId === session)) {
            draft();
            closeSessionView();
            notice('此对话已关闭或不再共享');
        }
        renderSessions();
        if (!session) {
            const last = stored.get('last');
            if (last && sessions.some(s => s.instanceId === last))
                openSession(last);
        }
        else if (!source && !hidden() && syncPhase !== 'limited')
            connect();
        // Optional metadata must not delay the list, replay, or each other.
        if (caps.projects)
            void refreshCatalog(version, 'project-groups', value => { groups = value; }, '项目列表暂未刷新：');
        if (caps.pluginResources)
            void refreshCatalog(version, 'plugin-entries', value => {
                pluginEntries = value.filter(entry => sessions.some(s => s.instanceId === entry?.sessionId));
            });
        controls();
    }
    catch (e) {
        if (current()) {
            online = false;
            if (e.status === 410 || e.status === 401) {
                draft();
                closeSessionView();
                invalidated = true;
                syncPhase = 'invalid';
                sessions = []; groups = []; pluginEntries = []; capabilities = {};
                renderSessions();
                text('device-status', '连接已失效');
            } else {
                disconnect({ retainWait: true });
                syncPhase = 'unknown';
                text('device-status', '暂时无法连接');
            }
            controls(); syncStatus(); retryConnection();
            connectionNotice = e.message; notice(connectionNotice);
        }
    }
}
$('refresh').onclick = () => void refresh();
$('sync-retry').onclick = () => {
    if (!session || invalidated || hidden()) return;
    draft(); ++catalogVersion; stopWatch();
    // Replace only the event subscription. Pending receipt IDs and in-flight sends survive.
    if (online) connect(); else void refresh();
};
$('return-devices').onclick = async () => {
    const b = $('return-devices'); if (b.disabled) return;
    b.disabled = true; draft();
    try { await api('/owner', {}); } catch (e) { notice('无法打开设备列表：' + e.message); }
    finally { b.disabled = false; }
};
function disconnect({ retainWait = false } = {}) {
    queueVersion++; clearTimeout(queueTimer); clearTimeout(receiptTimer); globalThis.AsHubFilePreview?.close();
    source?.close(); source = null; clearTimeout(retry); retry = null;
    clearTimeout(frameTimer); frameTimer = null; frameQueue = []; ready = false;
    if (!retainWait) stopWatch();
    syncPhase = session ? 'paused' : 'idle'; syncStatus(); controls();
}
function closeSessionView() {
    composerMedia.cancel();
    generation++;
    closeModal();
    session = '';
    disconnect();
    images = [];
    $('query').value = '';
    renderAttachments();
    clearMessages();
    renderReceipt();
}
function clearMessages() { turnOutcome = ''; clearTimeout(renderTimer); reply = null; liveSegment = false; phase = null; owners.clear(); approvals.clear(); $('messages').replaceChildren(); busy = false; modelInfo = {}; $('model').textContent = '选择模型'; $('queue').replaceChildren(); $('queue')._renderedSignature = null; }
function connect() {
    disconnect({ retainWait: true });
    if (!session || hidden() || !online)
        return;
    const g = generation, sid = session;
    clearMessages();
    syncPhase = 'syncing'; watchSync();
    const stream = new EventSource(base + '/events?session=' + encodeURIComponent(sid) + '&viewer=' + streamViewer + '&attempt=' + ++streamAttempt);
    source = stream;
    stream.onmessage = event => { if (source !== stream || generation !== g)
        return; try {
        const frame = JSON.parse(event.data);
        if (frame.meta?.name === 'hub:stream-limit') {
            disconnect(); syncPhase = 'limited'; syncStatus(); return;
        }
        frameQueue.push(frame);
        if (frameTimer === null)
            frameTimer = setTimeout(drain, 0);
    }
    catch {
        notice('收到无法识别的事件，请重新连接');
    } };
    stream.onerror = () => { if (source !== stream || generation !== g)
        return; disconnect({ retainWait: true }); syncPhase = 'reconnecting'; watchSync(); retryConnection(); };
}
function openSession(id) { if (!sessions.some(s => s.instanceId === id))
    return; composerMedia.cancel(); draft(); disconnect(); generation++; closeModal(); session = id; images = imageDrafts.get(id)?.slice() || []; renderAttachments(); $('query').value = stored.get(id + '.draft') || ''; stored.set('last', id); notice(); renderSessions(); connect(); renderReceipt(); }
function nearBottom() { const box = $('messages'); return box.scrollHeight - box.scrollTop - box.clientHeight < 100; }
function drain() { frameTimer = null; const near = !ready || nearBottom(); for (const event of frameQueue.splice(0, 60)) {
    try {
        frame(event);
    }
    catch {
        notice('部分内容显示失败，请重新连接');
    }
} renderReply(); if (near)
    requestAnimationFrame(() => { $('messages').scrollTop = $('messages').scrollHeight; }); if (frameQueue.length)
    frameTimer = setTimeout(drain, 0); }
function artifact(href) { try {
    if (!href || href.startsWith('#'))
        return null;
    const relative = href.split(/[?#]/)[0];
    if (relative && !/^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(relative))
        return { session, path: decodeURIComponent(relative) };
    const url = new URL(href, location.href);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        return null;
    const match = /^\/([a-f0-9]{4,32})\/(.+)$/.exec(url.pathname);
    if (match)
        return { session: match[1], path: match[2] === 'artifacts' ? url.searchParams.get('path') || '' : decodeURIComponent(match[2]) };
    if (url.pathname.endsWith('/artifact') && url.searchParams.has('path'))
        return { session: url.searchParams.get('session') || session, path: url.searchParams.get('path') };
}
catch { } return null; }
function resourceURL(args) { return base + '/resource?' + new URLSearchParams(args); }
function preview(url, name) { const g = generation, sid = session; globalThis.AsHubFilePreview?.open({ url, name, current: () => generation === g && session === sid && new URL(url, location.href).pathname.startsWith(base + '/'), lang: 'zh', pdfBase: new URL('/vendor/pdfjs/', location.href).href }); }
function markdown(target, text) {
    const g = generation, sid = session, savedImages = globalThis.AsHubImageResources?.preserve(target), artifactImages = [...target.querySelectorAll('img[data-backend-artifact]')];
    const fragment = DOMPurify.sanitize(marked.parse(extractMath(text)), { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'svg', 'video', 'audio', 'source'], FORBID_ATTR: ['style', 'srcset'] });
    for (const img of fragment.querySelectorAll('img')) {
        const file = artifact(img.getAttribute('src'));
        if (!file) {
            img.replaceWith(el('span', img.alt || '外部图片'));
            continue;
        }
        const url = resourceURL({ kind: 'artifact', ...file });
        const old = artifactImages.find(i => i.dataset.backendArtifact === url && i.alt === img.alt);
        if (old) {
            artifactImages.splice(artifactImages.indexOf(old), 1);
            img.replaceWith(old);
            continue;
        }
        img.dataset.backendArtifact = url;
        img.src = url;
        img.loading = 'lazy';
        img.onclick = () => preview(img.src, img.alt || file.path.split('/').pop());
    }
    for (const a of fragment.querySelectorAll('a')) {
        const file = artifact(a.getAttribute('href'));
        if (file) {
            a.href = resourceURL({ kind: 'artifact', ...file });
            a.onclick = e => { e.preventDefault(); preview(a.href, file.path.split('/').pop()); };
        }
        else {
            try {
                const url = new URL(a.href);
                if (!['http:', 'https:'].includes(url.protocol) || url.origin === location.origin) {
                    a.removeAttribute('href');
                    continue;
                }
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
            }
            catch {
                a.removeAttribute('href');
            }
        }
    }
    target.replaceChildren(fragment);
    globalThis.AsHubImageResources?.hydrate(target, { scope: backend + ':' + g + ':' + sid, current: () => generation === g && session === sid, resolve: id => resourceURL({ kind: 'image-resource', session: sid, id }), open: (url, name, current) => globalThis.AsHubFilePreview?.open({ url, name, current, lang: 'zh' }) }, savedImages);
    renderMathIn(target);
}
function renderReply() { if (reply?.dirty) {
    markdown(reply.el, reply.text);
    reply.dirty = false;
} }
function finishReply() { renderReply(); reply = null; liveSegment = false; if (phase)
    phase.summary.textContent = '处理记录' + (phase.count ? ' · ' + phase.count + ' 次调用' : ''); phase = null; }
function chunk(text) { if (!text)
    return; if (!reply) {
    reply = { el: el('article', undefined, 'bw-message assistant'), text: '', dirty: false };
    $('messages').append(reply.el);
} reply.text += text; reply.dirty = true; }
function newPhase() { const box = el('details', undefined, 'bw-phase'), summary = el('summary', '处理中'), body = el('div'); box.append(summary, body); const item = { box, summary, body, count: 0, thinking: null }; if (reply?.el.parentNode === $('messages'))
    $('messages').insertBefore(box, reply.el);
else
    $('messages').append(box); return item; }
function diagnostic(name, p) {
    const id = name.startsWith('subagent:') && p.subagentId ? 'agent:' + p.subagentId
        : p.toolCallId ? 'tool:' + p.toolCallId : p.subagentId ? 'agent:' + p.subagentId : p.swarmId ? 'swarm:' + p.swarmId : null;
    const isThinking = name === 'agent:thinking' || name === 'agent:thinking-chunk';
    const matched = owners.get(id);
    const launch = name === 'subagent:done' && p.cancelled === true && p.toolCallId
        ? p.subagentId ? matched?.launch : owners.get('tool:' + p.toolCallId) : null;
    const owner = matched ?? launch;
    if (!isThinking && owner && !name.endsWith('started')) {
        owner.output.textContent = typeof (p.rawOutput ?? p.text ?? p.output) === 'string' ? (p.rawOutput ?? p.text ?? p.output) : JSON.stringify(p.rawOutput ?? p.output ?? p);
        if (name.endsWith('completed') || name === 'subagent:done') {
            const outcome = owner.cancelled ? 'cancelled' : presentation.diagnosticState(p);
            owner.cancelled = outcome === 'cancelled';
            const label = outcome === 'cancelled' ? '已取消' : outcome === 'partial' ? '部分完成' : outcome === 'failed' ? '失败' : '完成';
            owner.label.textContent = owner.title + ' · ' + label;
            if (launch && launch !== owner) {
                launch.cancelled = true;
                launch.label.textContent = launch.title + ' · ' + label;
            }
        }
        return;
    }
    if (!isThinking && !name.endsWith('started'))
        return;
    if (!phase)
        phase = newPhase();
    if (isThinking) {
        if (!phase.thinking) {
            const details = el('details'), title = el('summary', '思考摘要'), text = el('pre', '');
            details.append(title, text);
            phase.body.append(details);
            phase.thinking = { text, title, value: '' };
        }
        const value = typeof p.text === 'string' ? p.text : typeof p.thinking === 'string' ? p.thinking : typeof p.chunk === 'string' ? p.chunk : '';
        phase.thinking.value += value;
        phase.thinking.title.textContent = '思路 · ' + presentation.thinkingPreview(phase.thinking.value);
        presentation.renderThinkingContent(phase.thinking.text, phase.thinking.value);
        return;
    }
    if (name.endsWith('started')) {
        phase.thinking = null;
        phase.count++;
        phase.summary.textContent = '处理中 · ' + phase.count + ' 次调用';
        const details = el('details'), title = presentation.toolDisplayName(p, 'zh'), label = el('summary', title), output = el('pre', JSON.stringify(p.rawInput ?? p.input ?? {}, null, 2));
        details.append(label, output);
        phase.body.append(details);
        if (id) {
            const launch = name === 'subagent:started' && p.toolCallId ? owners.get('tool:' + p.toolCallId) : null;
            owners.set(id, { label, output, title, launch });
        }
    }
}
function frame({ meta = {}, payload: p = {} }) {
    const name = meta.name;
    if (name === 'backend:reset' || name === 'hub:branch-switched') {
        clearMessages();
        queueVersion++; clearTimeout(queueTimer); clearTimeout(receiptTimer);
        syncPhase = 'syncing'; watchSync();
        return;
    }
    if (name === 'hub:replay-done') {
        ready = true; stopWatch(); syncPhase = 'ready'; syncStatus();
        controls();
        void loadQueue();
        void checkReceipt();
        return;
    }
    if (name === 'agent:query') {
        finishReply();
        liveSegment = false;
        const collaboration = presentation.renderCollaborationMessage?.(document, p, { locale: document.documentElement.lang || 'zh-CN' });
        const user = el('article', collaboration ? undefined : p.query || '', 'bw-message user');
        if (collaboration) { user.classList.add('has-collaboration-message'); user.append(collaboration); }
        $('messages').append(user);
        for (const image of p.images || [])
            if (image.id) {
                const g = generation;
                void rpc('image', { session, id: image.id }).then(value => { if (g !== generation || !user.isConnected)
                    return; const img = el('img'); img.src = 'data:' + value.mimeType + ';base64,' + value.data; user.append(img); }).catch(() => { });
            }
        return;
    }
    if (name === 'agent:response-chunk') {
        chunk((p.blocks || []).filter(b => b.type === 'text').map(b => b.text).join(''));
        liveSegment = true;
        return;
    }
    if (name === 'agent:response-segment') {
        if (!liveSegment)
            chunk(p.text || '');
        liveSegment = false;
        return;
    }
    if (name === 'agent:response-done') {
        renderReply();
        return;
    }
    const lifecycle = presentation.turnLifecycle(name, turnOutcome);
    if (lifecycle) turnOutcome = lifecycle.outcome;
    if (name === 'agent:processing-start') {
        busy = true;
        controls();
        return;
    }
    if (['agent:processing-done', 'agent:cancelled', 'agent:error'].includes(name)) {
        renderReply();
        if (phase) {
            phase.summary.textContent = (turnOutcome === 'error' ? '处理异常' : turnOutcome === 'stopped' ? '已停止' : '处理完成') + (phase.count ? ' · ' + phase.count + ' 次调用' : '');
            const timestamp = presentation.activityTimestamp(meta);
            if (timestamp) {
                const time = el('time', '', 'bw-phase-time');
                presentation.renderActivityTime(time, timestamp);
                phase.summary.append(time);
            }
        }
        phase = null;
        finishReply();
        busy = false;
        controls();
        if (name === 'agent:error')
            $('messages').append(el('p', p.message || '回复中断', 'bw-message'));
        return;
    }
    if (name === 'agent:tool-started' || name === 'subagent:started') {
        if (reply)
            finishReply();
        liveSegment = false;
        diagnostic(name, p);
        return;
    }
    if (name?.includes('tool-') || name?.startsWith('subagent:') || name?.startsWith('agent:thinking')) {
        diagnostic(name, p);
        return;
    }
    if (name === 'agent:info') {
        modelInfo = { ...modelInfo, ...p };
        $('model').textContent = modelInfo.model || '选择模型';
        return;
    }
    if (name === 'permission:request' && p.pending !== false && p.expiresAt > Date.now()) {
        approval(p);
        return;
    }
    if (name?.startsWith('permission:') && p.requestId && name !== 'permission:request') {
        approvals.get(p.requestId)?.remove();
        approvals.delete(p.requestId);
        return;
    }
    if (['agent:queued', 'agent:queued-done', 'agent:queue-updated'].includes(name) && ready) {
        clearTimeout(queueTimer);
        queueTimer = setTimeout(() => void loadQueue(), 100);
    }
    if (name === 'agent:compaction') {
        const marker = presentation.renderCompaction(p, 'zh');
        if (marker)
            $('messages').append(marker);
    }
}
function approval(p) {
    if (approvals.has(p.requestId))
        return;
    const g = generation, sid = session, card = el('section', undefined, 'bw-permission');
    card.append(el('strong', p.title || '需要确认'), el('p', p.description || ''));
    const detail = el('details'), summary = el('summary', '操作详情');
    detail.append(summary, el('pre', JSON.stringify(p.items || p, null, 2)));
    card.append(detail);
    card.expiresAt = p.expiresAt;
    const desktopOnly = p.requiresDesktop || ['site', 'daily7'].includes(p.scope);
    if (desktopOnly)
        card.append(el('p', '持续授权或本机权限需要在执行任务的电脑上确认'));
    for (const [label, outcome] of (desktopOnly ? [['拒绝', 'denied']] : [['允许本次', 'approved'], ['拒绝', 'denied']]))
        card.append(button(label, async () => { if (g !== generation || !ready || card.deciding || p.expiresAt <= Date.now())
            throw Error('连接或授权请求已变更'); card.deciding = true; controls(); try {
            await rpc('permission', { session: sid, requestId: p.requestId, outcome });
            if (g !== generation)
                return;
            card.remove();
            approvals.delete(p.requestId);
        }
        finally {
            card.deciding = false;
            if (g === generation)
                controls();
        } }));
    approvals.set(p.requestId, card);
    $('messages').append(card);
    controls();
}
const queueRequests = new Map();
async function queueChange(item, action, query) { const payload = action === 'withdraw' ? { session, id: item.id } : { session, id: item.id, revision: item.revision || 0, action, query }; const key = JSON.stringify(payload); if (!queueRequests.has(key))
    queueRequests.set(key, crypto.randomUUID()); queueVersion++; try {
    const result = await rpc(action === 'withdraw' ? 'queue-withdraw' : 'queue-update', { ...payload, requestId: queueRequests.get(key) });
    queueRequests.delete(key);
    return result;
}
catch (e) {
    if ([400, 409].includes(e.status))
        queueRequests.delete(key);
    throw e;
} }
async function loadQueue() {
    const g = generation, sid = session, version = ++queueVersion;
    if (!ready || !capabilities.queue)
        return;
    try {
        const data = await rpc('queue', { session: sid });
        if (g !== generation || !ready || version !== queueVersion)
            return;
        const items = Array.isArray(data) ? data : data.items || data.queue || [];
        const queue = $('queue');
        const signature = JSON.stringify([g, sid, !!capabilities.queueActions, items]);
        // Background refreshes must not collapse open details or replace a
        // focused control when the authoritative queue has not changed.
        if (queue._renderedSignature === signature) return;
        queue._renderedSignature = signature;
        const existing = new Map([...queue.children].filter(row => row._queueId).map(row => [row._queueId, row]));
        const ids = new Set(items.map(item => item.id));
        for (const row of [...queue.children]) {
            if (!row._queueId || !ids.has(row._queueId)) { row.remove(); existing.delete(row._queueId); }
        }
        let cursor = queue.firstElementChild;
        for (const item of items) {
            const itemSignature = JSON.stringify([g, sid, !!capabilities.queueActions, item]);
            let row = existing.get(item.id);
            if (row?._queueSignature === itemSignature) {
                if (row !== cursor) queue.insertBefore(row, cursor);
                cursor = row.nextElementSibling;
                existing.delete(item.id);
                continue;
            }
            if (row) { if (row === cursor) cursor = row.nextElementSibling; row.remove(); existing.delete(item.id); }
            row = el('div');
            row._queueId = item.id;
            row._queueSignature = itemSignature;
            const collaboration = presentation.renderCollaborationMessage?.(document, item, { locale: document.documentElement.lang || 'zh-CN' });
            if (collaboration) {
                row.className = 'bw-queue-collaboration';
                row.append(el('span', item.delivery === 'steer' ? '等待接入' : '排队'), collaboration);
            } else {
                row.append(el('span', (item.delivery === 'steer' ? '等待接入 · ' : '排队 · ') + (item.query || '图片消息')));
            }
            if (capabilities.queueActions) {
                for (const [label, action] of [['编辑', 'edit'], ['撤回', 'withdraw'], ['插队', 'promote']])
                    row.append(button(label, async () => {
                        if (g !== generation || !ready)
                            throw Error('对话已切换或连接中断');
                        if (action === 'edit') {
                            const input = el('textarea');
                            input.value = item.query;
                            const view = modal('编辑排队消息', [input, button('保存', async () => { if (g !== generation || view !== modalGeneration || !ready)
                                    throw Error('对话已切换'); await queueChange(item, 'edit', input.value); if (g !== generation || view !== modalGeneration)
                                    return; closeModal(); await loadQueue(); })]);
                        }
                        else {
                            await queueChange(item, action);
                            if (g === generation)
                                await loadQueue();
                        }
                    }));
            }
            queue.insertBefore(row, cursor);
            cursor = row.nextElementSibling;
        }
        for (const row of existing.values()) row.remove();
    }
    catch (e) {
        if (g === generation)
            notice(e.message);
    }
}
function renderAttachments() { $('attachments').replaceChildren(...images.map((img, i) => button(img.name + ' ×', () => { images.splice(i, 1); draft(); renderAttachments(); }))); }
function checkImageDraftSize(file, drafts) {
    if (drafts.length >= 4) throw Error('最多添加 4 张图片');
    if (file.size + drafts.reduce((n, image) => n + Math.ceil(image.data.length * 3 / 4), 0) > 3 * 1024 * 1024)
        throw Error('图片总大小请控制在 3 MB 内，支持 PNG、JPEG、WebP 和 GIF');
}
$('upload').onchange = async event => {
    const picker = event.currentTarget, owner = session, files = [...picker.files];
    picker.value = '';
    if (!owner || !files.length) return;
    draft();
    const draftsForOwner = () => session === owner ? images : imageDrafts.get(owner);
    try {
        for (const file of files) {
            const drafts = draftsForOwner();
            if (!drafts) return;
            if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
                throw Error('图片总大小请控制在 3 MB 内，支持 PNG、JPEG、WebP 和 GIF');
            checkImageDraftSize(file, drafts);
            const value = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(file);
            });
            // View switches keep the selection with its original draft. If the
            // conversation was deleted during the read, that draft is gone.
            const latest = draftsForOwner();
            if (!latest) return;
            checkImageDraftSize(file, latest);
            latest.push({ id: crypto.randomUUID(), name: file.name, data: String(value).split(',')[1], mimeType: file.type });
            if (owner === session) { draft(); renderAttachments(); }
        }
    } catch (error) {
        if (owner === session) notice(error.message);
    }
};
$('query').oninput = draft;
$('query').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
} };
function ownsReceipt(record, g) { return g === generation && pending()?.requestId === record.requestId; }
function renderReceipt() { const receipt = pending(); $('receipt').hidden = !receipt; $('receipt').replaceChildren(); if (receipt) {
    $('receipt').append(el('span', '正在确认上次发送；请勿重复提交。'), button('检查状态', checkReceipt), button('重试原请求', () => sendReceipt(receipt)), button('结束核对', () => { const sid = session; modal('结束发送核对', [el('p', '请先核对远程历史。结束核对不会撤回已发送的消息，也不会自动重发草稿。'), button('已核对，保留草稿', () => { if(pending()?.requestId!==receipt.requestId)return; stored.set(sid + '.pending', null); closeModal(); renderReceipt(); })]); }));
} controls(); }
async function checkReceipt() {
    const record = pending(), g = generation, sid = session;
    if (!record || !ready)
        return;
    try {
        const result = await rpc('request-status', { requestId: record.requestId });
        if (!ownsReceipt(record, g))
            return;
        if (result.state === 'pending') {
            clearTimeout(receiptTimer);
            receiptTimer = setTimeout(() => { if (ownsReceipt(record, g))
                void checkReceipt(); }, 1000);
            return;
        }
        if (result.state === 'done') {
            if ($('query').value === record.query) {
                $('query').value = '';
                draft();
            }
            const sentIds = new Set(record.attachmentIds || []);
            images = images.filter(image => !sentIds.has(image.id));
            draft(); renderAttachments();
            stored.set(sid + '.pending', null);
            renderReceipt();
        }
        else
            notice(result.error || '发送结果尚未确认；检查历史后，可用原请求编号重试。');
    }
    catch (e) {
        if (ownsReceipt(record, g))
            notice(e.message);
    }
}
const sending = new Set();
async function sendReceipt(record, { firstAttempt = false } = {}) { const g = generation, sid = session; if (!ready || !ownsReceipt(record, g) || record.session !== sid || sending.has(record.requestId))
    return; sending.add(record.requestId); try {
    const {attachmentIds, ...payload} = record;
    await rpc('submit', payload);
    if (!ownsReceipt(record, g))
        return;
    void checkReceipt();
}
catch (e) {
    if (ownsReceipt(record, g)) {
        // A retry can be rejected by a new authorization check before it
        // sees the original result. Only a first-attempt rejection settles it.
        if (firstAttempt && [400, 403, 413].includes(e.status))
            stored.set(sid + '.pending', null);
        notice(e.message);
    }
}
finally {
    sending.delete(record.requestId);
    if (g === generation)
        renderReceipt();
} }
$('composer').onsubmit = async (e) => { e.preventDefault(); if (!ready || !online || pending() || (!$('query').value.trim() && !images.length))
    return; const record = { session, query: $('query').value, attachmentIds:images.map(image=>image.id), images: images.map(({ data, mimeType }) => ({ data, mimeType })), requestId: crypto.randomUUID(), delivery: busy && capabilities.steering ? $('delivery').value : 'queue' }; stored.set(session + '.pending', JSON.stringify(record)); if (!pending()) {
    notice('无法保存发送凭据，请释放本地存储后重试');
    return;
} renderReceipt(); await sendReceipt(record, { firstAttempt: true }); };
$('stop').onclick = async () => { const g = generation; try {
    await rpc('cancel', { session });
}
catch (e) {
    if (g === generation)
        notice(e.message);
} };
async function waitRequest(requestId, g) { for (let i = 0; i < 30; i++) {
    if (g !== generation)
        throw Error('对话已切换');
    const result = await rpc('request-status', { requestId });
    if (g !== generation)
        throw Error('对话已切换');
    if (result.state === 'done')
        return result.result;
    if (['unknown', 'missing'].includes(result.state))
        throw Error(result.error || '结果未确认，请检查远程电脑');
    await new Promise(r => setTimeout(r, 1000));
} throw Error('仍在处理，请稍后检查结果'); }
$('model').onclick = async () => {
    const g = generation, sid = session, ticket = modal('模型与思考', [el('p', '正在读取模型…')]);
    const current = () => g === generation && ticket === modalGeneration && $('dialog').open;
    try {
        const catalog = await rpc('models');
        if (!current())
            return;
        const search = el('input');
        search.placeholder = '搜索模型';
        const list = el('div'), thinking = el('div');
        const rows = Array.isArray(catalog) ? catalog : (catalog.providers || []).flatMap(p => (p.models || []).map(m => ({ model: typeof m === 'string' ? m : m.id, provider: p.name })));
        const render = () => { list.replaceChildren(...rows.filter(m => (m.provider + ' ' + m.model).toLowerCase().includes(search.value.toLowerCase())).map(m => button(m.model + ' · ' + m.provider, async () => { if (!current() || busy)
            throw Error('请等待当前回复结束'); const data = await rpc('model', { session: sid, model: m.model, provider: m.provider }); if (!current())
            return; modelInfo = { ...modelInfo, ...data, model: m.model, provider: m.provider }; $('model').textContent = m.model; closeModal(); }))); };
        search.oninput = render;
        render();
        $('dialog-body').replaceChildren(search, thinking, list);
        if (capabilities.thinking) {
            const data = await rpc('thinking', { session: sid });
            if (!current())
                return;
            const label = el('label', '思考深度'), select = el('select');
            for (const level of ['default', ...(data.levels || [])]) {
                const o = el('option', level);
                o.value = level;
                select.append(o);
            }
            select.value = data.level;
            select.disabled = !data.supported || busy;
            select.onchange = async () => { select.disabled = true; try {
                if (!current())
                    return;
                await rpc('set-thinking', { session: sid, model: data.model, provider: data.provider, level: select.value });
            }
            catch (e) {
                if (current())
                    notice(e.message);
            }
            finally {
                if (current())
                    select.disabled = busy;
            } };
            label.append(select);
            thinking.append(label);
        }
    }
    catch (e) {
        if (current())
            notice(e.message);
    }
};
$('create').onclick = async () => {
    const g = generation, ticket = modal('新建远程对话', [el('p', '正在读取共享目录…')]);
    try {
        const roots = await rpc('projects');
        if (ticket !== modalGeneration || g !== generation)
            return;
        const select = el('select');
        for (const root of roots) {
            const option = el('option', root.label || root.name || root.path || root.id);
            option.value = root.id;
            select.append(option);
        }
        let requestId = null;
        $('dialog-body').replaceChildren(el('p', '对话将在这台远程电脑的共享目录中创建。'), select, button('创建', async () => { if (!select.value || ticket !== modalGeneration)
            throw Error('请选择共享目录'); requestId ??= crypto.randomUUID(); select.disabled = true; const result = await rpc('create', { project: select.value, requestId }); const created = result.state === 'done' ? result.result : await waitRequest(requestId, g); if (ticket !== modalGeneration || g !== generation)
            return; closeModal(); await refresh(); if (g === generation && created.instanceId)
            openSession(created.instanceId); }));
    }
    catch (e) {
        if (g === generation && ticket === modalGeneration)
            notice(e.message);
    }
};
$('settings').onclick = async () => {
    const sid = session, g = generation, ticket = modal('对话设置', []), current = () => g === generation && ticket === modalGeneration && $('dialog').open;
    try {
        if (capabilities.sessionNetwork) {
            const value = await rpc('session-network', { session: sid });
            if (!current())
                return;
            const label = el('label', '远程模型 VPN'), select = el('select');
            for (const [id, text] of [['inherit', '跟随远程电脑'], ['true', '开启'], ['false', '关闭']]) {
                const option = el('option', text);
                option.value = id;
                select.append(option);
            }
            select.value = value.enabled === null ? 'inherit' : String(value.enabled);
            select.onchange = async () => { select.disabled = true; try {
                await rpc('set-session-network', { session: sid, enabled: select.value === 'inherit' ? null : select.value === 'true' });
            }
            catch (e) {
                if (current())
                    notice(e.message);
            }
            finally {
                if (current())
                    select.disabled = false;
            } };
            label.append(select);
            $('dialog-body').append(label);
        }
        if (capabilities.pluginResources) {
            const entries = await rpc('plugin-entries');
            if (!current())
                return;
            for (const entry of entries.filter(e => e.sessionId === sid))
                $('dialog-body').append(button(entry.label, async () => {
                    const container = el('div'), requestIds = new Map();
                    const view = modal(entry.label, [container]);
                    disposeResource = mountResource(container, { pluginId: entry.pluginId }, entry.resource, { request: async (body, signal) => {
                            if (g !== generation || view !== modalGeneration || signal.aborted)
                                throw Error('页面已切换');
                            const key = JSON.stringify(body);
                            if (body && !requestIds.has(key))
                                requestIds.set(key, crypto.randomUUID());
                            const requestId = requestIds.get(key);
                            const args = { session: sid, pluginId: entry.pluginId, resourceId: entry.resource };
                            let result = await rpc('plugin-resource', { ...args, ...(body ? { body, requestId } : {}) }, signal);
                            if (body) {
                                const receipt = result.state === 'done' ? result.result : await waitRequest(requestId, g);
                                if (g !== generation || view !== modalGeneration || signal.aborted)
                                    throw Error('页面已切换');
                                result = await rpc('plugin-resource', { ...args, receipt: receipt.resourceReceipt }, signal);
                                requestIds.delete(key);
                            }
                            return result;
                        } });
                }));
        }
        if (capabilities.sessionDelete) {
            let requestId = null;
            $('dialog-body').append(button('删除对话', async () => { const confirm = modal('删除远程对话', [el('p', '此操作会删除远程电脑上的对话，不能撤销。')]); $('dialog-body').append(button('确认删除', async () => { if (g !== generation || confirm !== modalGeneration)
                return; requestId ??= crypto.randomUUID(); const result = await rpc('session-delete', { session: sid, confirm: true, requestId }); if (result.state !== 'done')
                await waitRequest(requestId, g); if (g !== generation)
                return; stored.set(sid + '.draft', null); imageDrafts.delete(sid); stored.set(sid + '.pending', null); stored.set('last', null); closeSessionView(); await refresh(); })); }));
        }
    }
    catch (e) {
        if (current())
            notice(e.message);
    }
};
window.addEventListener('pagehide', () => { suspended = true; draft(); ++catalogVersion; disconnect(); clearInterval(poll); closeModal(); });
document.addEventListener('visibilitychange', () => { if (hidden()) {
    draft(); ++catalogVersion; disconnect();
} else void refresh(); });
window.addEventListener('online', () => { if (!hidden()) void refresh(); });
const startPoll = () => setInterval(() => { if (!hidden()) void refresh(); }, 15000);
let poll = startPoll();
void refresh();
window.addEventListener('pageshow', event => { suspended = false; if (event.persisted) {
    clearInterval(poll); poll = startPoll(); void refresh();
} });

const composerMedia = globalThis.AsHubComposerMedia.mount({container:document.querySelector('.bw-composer-actions'), input:$('query'),form:$('composer'),
 owner:()=>session?backend+':'+session+':'+generation:'',enabled:()=>!!capabilities.composerInputs&&ready&&online&&!pending(),
 request:(target,action,args,signal)=>rpc('composer-input',{...args,session:target.split(':')[1],action},signal)});
