import { toast } from './toast.js';
import { effect } from '../vendor/signals-core.js';
import { activeSessionId } from './store.js';
import { lang } from './i18n.js';

const api = window.electronAPI;
if (api?.browserStatus) {
  const main = document.querySelector('.app > .main');
  const pane = document.createElement('aside');
  pane.className = 'browser-pane';
  pane.hidden = true;
  pane.innerHTML =
    '<div class="browser-divider" role="separator" aria-orientation="vertical" tabindex="0"></div><header><div class="browser-switch"><button type="button" class="browser-chat"></button><button type="button" class="browser-web"></button></div><button type="button" class="browser-back">‹</button><button type="button" class="browser-forward">›</button><span class="browser-origin" dir="ltr"></span><span class="browser-owner"><span class="browser-controller" hidden></span><button type="button" class="browser-mode"></button></span><button type="button" class="browser-close">×</button></header><div class="browser-viewport"></div>';
  main.after(pane);
  const back = pane.querySelector('.browser-back'),
    forward = pane.querySelector('.browser-forward');
  const origin = pane.querySelector('.browser-origin'),
    mode = pane.querySelector('.browser-mode');
  const close = pane.querySelector('.browser-close'),
    viewport = pane.querySelector('.browser-viewport');
  let session = '',
    state = null,
    generation = 0,
    frame = 0,
    lastLayout = '';
  const divider = pane.querySelector('.browser-divider');
  const chat = pane.querySelector('.browser-chat'), web = pane.querySelector('.browser-web');
  const keyRatio = 'ash.browser.width-ratio';
  let ratio = 0.42, selected = 'chat', dragging = false;
  try {
    const saved = Number(localStorage.getItem(keyRatio));
    if (saved > 0 && saved < 1) ratio = saved;
  } catch {}
  const minPage = 320, minChat = 520;
  const available = () => pane.getBoundingClientRect().right - main.getBoundingClientRect().left;
  const clampPage = (width, total) => Math.max(minPage, Math.min(width, total - minChat));
  const saveRatio = () => { try { localStorage.setItem(keyRatio, String(ratio)); } catch {} };
  function sizePage(width) {
    const total = available();
    if (total >= minPage + minChat) ratio = clampPage(width, total) / total;
    layout();
  }
  divider.onpointerdown = event => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    divider.focus(); divider.setPointerCapture(event.pointerId);
    pane.classList.add('resizing');
    layout();
  };
  divider.onpointermove = event => {
    if (dragging) sizePage(pane.getBoundingClientRect().right - event.clientX);
  };
  divider.onlostpointercapture = () => {
    dragging = false; pane.classList.remove('resizing'); saveRatio(); layout();
  };
  divider.onpointerup = event => {
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  };
  divider.onkeydown = event => {
    const total = available(), width = clampPage(total * ratio, total);
    const next = { ArrowLeft: width + 24, ArrowRight: width - 24, Home: minPage, End: total - minChat }[event.key];
    if (next === undefined) return;
    event.preventDefault(); sizePage(next); saveRatio();
  };
  chat.onclick = () => { selected = 'chat'; layout(); };
  web.onclick = () => { selected = 'web'; layout(); };
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const obstructed = () =>
    sidebarBackdrop?.getClientRects().length || document.querySelector(
      'dialog[open],:popover-open,.img-lightbox,.model-dropdown:not([hidden]),.p-drawer:not([hidden]),[aria-modal="true"]:not([hidden]),.quick-create-overlay:not([hidden])',
    );
  function layout() {
    frame = 0;
    const total = state ? available() : 0;
    const compact = !!state && total < minPage + minChat;
    const pending = !!main.querySelector('session-view:not([hidden]) .permission-card:not(.decided)');
    const needsApprovalFocus = compact && pending && selected === 'web';
    if (needsApprovalFocus) selected = 'chat';
    pane.dataset.layout = compact ? 'compact' : 'split';
    pane.dataset.view = selected;
    main.classList.toggle('browser-compact', compact);
    main.classList.toggle('browser-behind', compact && selected === 'web');
    main.inert = compact && selected === 'web';
    chat.setAttribute('aria-pressed', String(selected === 'chat'));
    web.setAttribute('aria-pressed', String(selected === 'web'));
    web.disabled = compact && pending;
    // Reveal the request underneath an open panel without moving focus out of that panel.
    if (needsApprovalFocus && (document.activeElement === document.body || pane.contains(document.activeElement))) {
      chat.focus({ preventScroll: true });
    }
    if (state && !compact) {
      const width = Math.round(clampPage(total * ratio, total));
      main.parentElement.style.setProperty('--browser-width', width+'px');
      divider.setAttribute('aria-valuemin', String(minPage));
      divider.setAttribute('aria-valuemax', String(Math.floor(total - minChat)));
      divider.setAttribute('aria-valuenow', String(width));
    }
    const r = viewport.getBoundingClientRect();
    const bounds =
      state && !dragging && !document.hidden && !obstructed()
        && (!compact || (selected === 'web' && !document.querySelector('.update-card,.toast'))) && r.width > 1 && r.height > 1
        ? { x: r.x, y: r.y, width: r.width, height: r.height }
        : null;
    const key = JSON.stringify([session, bounds]);
    if (key !== lastLayout) {
      lastLayout = key;
      const style = document.documentElement.style;
      if (bounds && !compact) style.setProperty('--browser-pane-inset', window.innerWidth - bounds.x + 'px');
      else style.removeProperty('--browser-pane-inset');
      api.browserLayout(session, bounds);
    }
  }
  const schedule = () => {
    if (state && !frame) frame = requestAnimationFrame(layout);
  };
  const observer = new MutationObserver(schedule);
  const resize = new ResizeObserver(schedule);
  function show(next) {
    if (state && (!next || state.pageId !== next.pageId)) {
      ++controlIntent;
      mode.disabled = false;
    }
    state = next;
    pane.hidden = !state;
    main.classList.toggle('with-browser-pane', !!state);
    observer.disconnect();
    resize.disconnect();
    if (state) {
      const zh = lang.peek() === 'zh';
      chat.textContent = zh ? '对话' : 'Chat';
      web.textContent = zh ? '网页' : 'Web';
      divider.setAttribute('aria-label', zh ? '调整网页宽度' : 'Resize browser');
      back.disabled = !state.back;
      back.title = back.ariaLabel = zh ? '后退' : 'Back';
      forward.disabled = !state.forward;
      forward.title = forward.ariaLabel = zh ? '前进' : 'Forward';
      origin.textContent = state.origin;
      origin.title = state.origin;
      const controller = pane.querySelector('.browser-controller');
      controller.hidden = !state.manual; controller.textContent = zh ? '你正在控制' : 'You’re in control';
      mode.textContent = state.manual ? (zh ? '交还给助手' : 'Return to assistant') : zh ? '手动接管' : 'Take control';
      mode.setAttribute('aria-pressed', String(state.manual));
      close.title = close.ariaLabel = zh ? '关闭网页并撤销授权' : 'Close page and revoke access';
      pane.ariaLabel = zh ? '会话浏览器' : 'Conversation browser';
      resize.observe(viewport); resize.observe(main); resize.observe(main.parentElement);
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'open', 'aria-modal', 'class'],
        childList: true,
      });
    }
    lastLayout = '';
    layout();
  }
  async function sync(id) {
    const stamp = ++generation;
    if (session !== id) {
      api.browserLayout(session, null);
      ++controlIntent; mode.disabled = false;
      session = id; selected = 'chat';
      show(null);
    }
    if (!id) return;
    try {
      const result = await api.browserStatus(id);
      if (stamp === generation) show(result);
    } catch {
      if (stamp === generation) show(null);
    }
  }
  back.onclick = () => api.browserControl(session, 'back', state?.pageId);
  forward.onclick = () => api.browserControl(session, 'forward', state?.pageId);
  let controlIntent = 0;
  mode.onclick = async () => {
    const id = session, pageId = state?.pageId, expected = !state?.manual, intent = ++controlIntent;
    try {
      mode.disabled = true;
      api.browserControl(id, expected ? 'manual' : 'resume', pageId);
      const actual = await api.browserStatus(id);
      if (actual?.pageId === pageId && intent === controlIntent && session === id && actual?.manual !== expected) throw Error('control');
    } catch {
      if (intent === controlIntent && session === id) toast(lang.peek() === 'zh' ? '控制权未切换，请重试' : 'Control did not change. Try again.', { type: 'error' });
    } finally {
      if (intent === controlIntent && session === id) { mode.disabled = false; void sync(id); }
    }
  };
  close.onclick = () => api.browserControl(session, 'close', state?.pageId);
  effect(() => {
    const id = activeSessionId.value;
    lang.value;
    void sync(id);
  });
  api.onBrowserChanged((id) => {
    if (session === id) void sync(id);
  });
  document.addEventListener('visibilitychange', () => {
    lastLayout = '';
    if (document.hidden) layout(); else schedule();
  });
  document.addEventListener('toggle', schedule, true);
  window.addEventListener('focus', () => {
    lastLayout = '';
    schedule();
  });
  window.addEventListener('resize', schedule);
  window.addEventListener('pagehide', () => api.browserLayout(session, null));
}
