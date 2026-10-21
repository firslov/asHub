import { registerPanel } from './panel-manager.js';

const trigger = document.getElementById('mobile-access-toggle');
const panel = document.createElement('section');
panel.id = 'mobile-access-panel';
panel.className = 'p-drawer mobile-access-panel';
panel.hidden = true;
panel.setAttribute('aria-labelledby', 'mobile-title');
panel.innerHTML = `<form id="mobile-form">
<header class="p-head"><div class="p-heading"><h2 class="p-title" id="mobile-title">移动访问</h2><p class="mobile-subtitle">在手机上继续桌面对话</p></div><button class="p-icon-btn" type="button" id="mobile-close" aria-label="关闭移动访问面板"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m2 2 8 8M10 2l-8 8"/></svg></button></header>
<div class="p-body mobile-body">
<div class="mobile-connection"><div class="mobile-status-line"><span id="mobile-status" role="status" aria-live="polite">正在读取连接状态…</span><button type="button" id="mobile-retry" class="p-btn" hidden>重试</button></div><p id="mobile-link" hidden></p></div>
<div id="mobile-recovery" role="status" aria-live="polite" hidden></div>
<fieldset id="mobile-fields" disabled>
<section class="mobile-section" aria-labelledby="mobile-account-heading"><h3 class="p-section" id="mobile-account-heading">设备与账号</h3>
<label class="mobile-field">设备名称<input class="p-input" name="deviceName" maxlength="80" value="我的电脑" required placeholder="例如：我的 MacBook"></label>
<label class="mobile-field">用户名<input class="p-input" name="username" autocomplete="username" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}" required placeholder="你的移动访问账号" aria-describedby="mobile-username-hint"></label>
<p class="mobile-hint" id="mobile-username-hint">3–32 位字母、数字、点、下划线或连字符，以字母或数字开头</p>
<label class="mobile-field">密码<input class="p-input" name="password" type="password" autocomplete="current-password" minlength="12" maxlength="128" required placeholder="输入账号密码" aria-describedby="mobile-password-hint"></label>
<p class="mobile-hint" id="mobile-password-hint">至少 12 位，连接或更新授权时用于验证账号</p>
<label class="mobile-check"><input name="create" type="checkbox">注册新账号</label>
</section>
<section class="mobile-section" aria-labelledby="mobile-roots-heading"><div class="mobile-section-head"><h3 class="p-section" id="mobile-roots-heading">共享目录</h3><button class="p-btn" type="button" id="mobile-pick">添加目录</button></div>
<label class="mobile-field"><span class="mobile-hint">允许手机访问的项目目录</span><textarea class="p-input" name="roots" rows="3" required placeholder="每行一个绝对路径" aria-describedby="mobile-roots-hint"></textarea></label>
<p class="mobile-hint" id="mobile-roots-hint">仅共享这些目录及其子目录中的对话。缺少对话时，请检查其工作目录是否在授权范围内且仍然存在。</p>
</section>
</fieldset>
<details class="mobile-help"><summary>连接与权限说明</summary><p>电脑需保持在线，任务执行与对话历史保存在本机。手机断开不会停止任务。</p><p>工具沿用桌面端的权限设置；共享目录用于筛选对话，不是文件系统沙箱。</p><p>关闭访问后会保留加密的设备身份。彻底撤销授权，请在移动网页版「账号与设备」中解绑。</p></details>
</div>
<footer class="mobile-actions"><button class="p-btn" type="button" id="mobile-disable" disabled>关闭访问</button><button class="p-btn-primary" type="submit" id="mobile-connect" disabled>连接设备</button></footer>
</form>`;
(document.querySelector('.app') || document.body).append(panel);
const $ = id => panel.querySelector('#' + id);
const form = $('mobile-form'), status = $('mobile-status');
let busy = false, ready = false, available = false, enabled = false, timer, view = 0, read = 0;
// Keep unacknowledged codes only in this renderer's memory, independent of panel visibility.
// Key by account so a later registration cannot discard another account's recovery code.
const pendingRecoveries = new Map();
function renderRecoveries() {
  const box = $('mobile-recovery');
  box.replaceChildren(); box.hidden = panel.hidden || !pendingRecoveries.size;
  if (box.hidden) return;
  const heading = document.createElement('h3'); heading.className = 'p-section'; heading.textContent = '保存账号恢复码';
  const hint = document.createElement('p'); hint.className = 'mobile-hint'; hint.textContent = '切换菜单后仍可查看，请在退出应用或刷新页面前保存到安全的位置';
  box.append(heading, hint);
  for (const [username, code] of pendingRecoveries) {
    const card = document.createElement('div'); card.className = 'mobile-recovery-card';
    const account = document.createElement('p'); account.textContent = '账号：' + username;
    const value = document.createElement('code'); value.textContent = code;
    const saved = document.createElement('button'); saved.type = 'button'; saved.className = 'p-btn'; saved.textContent = '我已保存';
    saved.onclick = () => {
      if (pendingRecoveries.get(username) === code) pendingRecoveries.delete(username);
      renderRecoveries();
    };
    card.append(account, value, saved); box.append(card);
  }
  box.scrollIntoView?.({ block: 'nearest' });
}

function controls() {
  $('mobile-fields').disabled = busy || !ready || !available;
  $('mobile-connect').disabled = busy || !ready || !available;
  $('mobile-disable').disabled = busy || !ready || !available || !enabled;
  $('mobile-connect').textContent = busy ? '正在处理…' : enabled ? '更新授权' : '连接设备';
  $('mobile-pick').disabled = !window.electronAPI?.pickDirectory;
  $('mobile-pick').title = window.electronAPI?.pickDirectory ? '选择项目目录' : '请手动输入项目目录的绝对路径';
}
function showStatus(message, state = '') { status.textContent = message; status.dataset.state = state; }
async function api(route = '', body) {
  const r = await fetch('/api/mobile' + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Ashub-Local': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await r.json(); if (!r.ok) throw Error(result.error); return result;
}
async function refresh(fill = false) {
  const epoch = view, request = ++read;
  try {
    const s = await api();
    if (panel.hidden || epoch !== view || request !== read) return;
    ready = true; available = s.available; enabled = s.enabled;
    const labels = { online: '已连接 · 可从手机登录', connecting: '正在连接…', disabled: '尚未开启移动访问', revoked: '设备授权已撤销，请重新连接', error: '连接不可用' };
    showStatus(!available ? '请在支持系统安全存储的桌面端启用' : s.error || labels[s.status] || s.status, s.error || !available ? 'error' : s.status);
    $('mobile-retry').hidden = true;
    if (fill) { form.elements.namedItem('username').value = s.username || ''; form.elements.namedItem('deviceName').value = s.deviceName || '我的电脑'; form.elements.namedItem('roots').value = s.roots.join('\n'); }
    const link = document.createElement('a'); link.href = s.gateway; link.textContent = '打开移动网页版 ↗'; link.target = '_blank'; link.rel = 'noreferrer';
    $('mobile-link').replaceChildren(link); $('mobile-link').hidden = false;
    controls();
  } catch (e) { if (!panel.hidden && epoch === view && request === read) { showStatus(e.message, 'error'); $('mobile-retry').hidden = false; controls(); } }
}
function close() {
  panel.hidden = true; view++; read++; clearInterval(timer); trigger?.classList.remove('active');
  form.elements.namedItem('password').value = ''; renderRecoveries();
}
function open() {
  panel.hidden = false; view++; ready = false; controls(); showStatus('正在读取连接状态…');
  $('mobile-link').hidden = true; $('mobile-retry').hidden = true; renderRecoveries();
  void refresh(true); clearInterval(timer); timer = setInterval(() => { if (!busy && ready && $('mobile-retry').hidden) void refresh(); }, 5000);
}
registerPanel('mobile-access', { toggleBtnId: 'mobile-access-toggle', panelId: panel.id, open, close });
$('mobile-close').onclick = () => { close(); trigger?.focus(); };
$('mobile-retry').onclick = () => { if (!busy) void refresh(!ready); };
$('mobile-pick').onclick = async () => { const epoch = view; const picked = await window.electronAPI?.pickDirectory?.(); if (!panel.hidden && epoch === view && !busy && picked?.cwd) { const field = form.elements.namedItem('roots'); field.value = [...new Set([...field.value.split('\n').map(s => s.trim()).filter(Boolean), picked.cwd])].join('\n'); } };
form.elements.namedItem('create').onchange = e => { form.elements.namedItem('password').autocomplete = e.target.checked ? 'new-password' : 'current-password'; };
form.onsubmit = async e => {
  e.preventDefault(); if (busy || !ready || !available) return;
  // Capture before disabling the fieldset: disabled controls are omitted by FormData.
  const b = Object.fromEntries(new FormData(form)); b.create = b.create === 'on'; b.roots = b.roots.split('\n').map(s => s.trim()).filter(Boolean);
  busy = true; read++; controls(); showStatus('正在安全连接…', 'connecting');
  try {
    const result = await api('/connect', b); form.elements.namedItem('password').value = '';
    if (result.recovery) {
      pendingRecoveries.set(result.username || b.username.trim().toLowerCase(), result.recovery);
      renderRecoveries();
    }
    if (!panel.hidden) await refresh(true);
  } catch (e) { if (!panel.hidden) { showStatus(e.message, 'error'); $('mobile-retry').hidden = false; } }
  finally { busy = false; controls(); }
};
$('mobile-disable').onclick = async () => {
  if (busy || !ready || !available || !enabled) return;
  busy = true; read++; controls(); showStatus('正在关闭访问…');
  try { await api('/disconnect', {}); if (!panel.hidden) await refresh(true); }
  catch (e) { if (!panel.hidden) { showStatus(e.message, 'error'); $('mobile-retry').hidden = false; } }
  finally { busy = false; controls(); }
};
