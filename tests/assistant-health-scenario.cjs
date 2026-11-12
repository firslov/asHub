// Shared DOM assertions run in real desktop Chromium and remote WebKit.
module.exports = async function healthScenario({ moduleUrl, remote = false }) {
  const { mountResource, validateResourceView } = await import(moduleUrl);
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  const row = document.createElement('div');
  row.className = remote ? 'plugin-entry' : 'conversation-entry';
  row.style.cssText = 'position:fixed;left:16px;top:24px;width:240px;max-width:calc(100vw - 32px);z-index:9999;background:var(--bg)';
  const open = document.createElement('button');open.className = remote ? 'plugin-entry-open' : 'conversation-entry-open';open.textContent = '个人助手';
  const host = document.createElement('div');host.className = remote ? 'plugin-entry-control' : 'conversation-entry-control';
  row.append(open, host);document.body.append(row);
  const make = status => ({ actions: [{ id: 'refresh', label: 'Refresh', values: {} }], rows: [], toggle: { label: '长期记忆', checked: true, action: 'refresh', ...(status ? { status } : {}) } });
  const notice = '记忆整理暂缓 · 将自动重试';
  let dispose;
  try {
    for (const status of [{}, 'x'.repeat(161)]) {
      let rejected = false;try { validateResourceView(make(status)); } catch { rejected = true; }
      assert(rejected, 'invalid resource health notice was accepted');
    }
    let recovered = false;
    dispose = mountResource(host, { pluginId: 'fixture' }, 'memory', { inlineToggle: true, request: async body => {
      if (body) recovered = true;
      return { view: make(recovered ? '' : notice) };
    } });
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await settle();
    const status = host.querySelector('.resource-inline-status'), button = host.querySelector('[role=switch]');
    assert(status?.textContent === notice, 'persistent learning failure is not visible');
    assert(button.getAttribute('aria-describedby') === status.id && button.title.includes(notice), 'notice is not accessible');
    const sr = status.getBoundingClientRect(), br = button.getBoundingClientRect(), rr = row.getBoundingClientRect();
    assert(sr.top >= br.bottom - 1 && sr.left >= rr.left && sr.right <= rr.right + 1, 'health status overlaps controls or overflows');
    assert(row.scrollWidth <= row.clientWidth + 1, 'health status causes horizontal overflow');
    assert(!document.querySelector('.resource-toggle-confirm'), 'status opened an unwanted dialog');
    button.focus();button.click();await settle();
    assert(!host.querySelector('.resource-inline-status'), 'recovered state leaves a stale warning');
    assert(host.querySelector('[role=switch]').getAttribute('aria-checked') === 'true', 'health update changed memory authorization state');
    assert(document.activeElement === host.querySelector('[role=switch]'), 'health update loses keyboard focus');
    dispose();
    dispose = mountResource(host, { pluginId: 'fixture' }, 'memory', { inlineToggle: true, request: async body => body
      ? { confirmation: { id: 'test-grant', preview: { title: '开启长期记忆', fields: [] } } }
      : { view: make('') } });
    await settle();host.querySelector('[role=switch]').click();await settle();
    const dialog = document.querySelector('.resource-toggle-confirm[open]');
    const title = dialog && document.getElementById(dialog.getAttribute('aria-labelledby'));
    assert(title?.textContent === '开启长期记忆' && dialog.contains(title), 'permission dialog has no accessible name');
    dialog.querySelector('.p-btn').click();await settle();
    assert(!document.querySelector('.resource-toggle-confirm'), 'named permission dialog cannot be cancelled');
    // A second, non-memory plugin uses the same entry and confirmation surface.
    // Labels describe the plugin purpose; toggling still waits for confirmation.
    dispose();open.textContent = '阅读教练';
    let enabled = false, executions = 0;
    const coachView = () => ({ actions: [{ id: 'enable', label: '开启进度分析', values: {} }], rows: [],
      toggle: { label: '进度分析', checked: enabled, action: 'enable' } });
    dispose = mountResource(host, { pluginId: 'coach-fixture' }, 'progress', { inlineToggle: true, request: async body => {
      if (body?.confirm === 'coach-grant') { enabled = true; executions++; return { view: coachView() }; }
      return body ? { confirmation: { id: 'coach-grant', preview: { title: '分析阅读进度', fields: [
        { label: '读取范围', value: '仅此对话' }, { label: '使用额度', value: '每天最多 2 次后台调用' },
      ] } } } : { view: coachView() };
    } });
    await settle();host.querySelector('[role=switch]').click();await settle();
    const coachDialog = document.querySelector('.resource-toggle-confirm[open]');
    assert(coachDialog && coachDialog.textContent.includes('分析阅读进度') && coachDialog.textContent.includes('每天最多 2 次'), 'generic plugin preview lost its purpose or scope');
    assert(!/个人助手|长期记忆/.test(coachDialog.textContent + row.textContent), 'generic plugin inherited assistant business labels');
    assert(executions === 0 && host.querySelector('[role=switch]').getAttribute('aria-checked') === 'false', 'generic toggle bypassed confirmation');
    coachDialog.querySelector('.p-btn-primary').click();await settle();
    assert(executions === 1 && host.querySelector('[role=switch]').getAttribute('aria-checked') === 'true', 'generic confirmed action did not update its own switch');
    assert(!document.querySelector('.resource-toggle-confirm'), 'generic confirmation did not close');
  } finally { dispose?.(); row.remove(); }
};
