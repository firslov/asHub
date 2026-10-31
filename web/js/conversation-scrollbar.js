// Message navigation only. The stream remains the owner of scrolling and replay.
(() => {
  // Progressive enhancement: retain native scrolling in limited webviews.
  if (typeof ResizeObserver !== 'function' || typeof MutationObserver !== 'function' || typeof requestAnimationFrame !== 'function') return;
  const selector = '.live-wrap .session-stream, #messages';
  const messageSelector = '.agent-box:not(.pending), .agent-reply, .message.user, .message.reply:not(.task-output)';
  const states = new Map();
  let frame = 0;
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  const resize = new ResizeObserver(schedule);
  const zh = () => document.documentElement.lang.startsWith('zh');
  function jump(state, index, focus = false) {
    const target = state.items[index];
    if (!target) return;
    const top = state.el.scrollTop + target.getBoundingClientRect().top - state.el.getBoundingClientRect().top - 16;
    state.el.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    if (focus) {
      state.buttons[index].focus({ preventScroll: true });
      state.rail.scrollTop = index * 8 + 18 - state.rail.clientHeight / 2;
    }
    schedule();
  }
  function create(el) {
    const rail = document.createElement('nav');
    rail.className = 'conversation-nav';
    rail.hidden = true;
    document.body.append(rail);
    const state = { el, rail, items: [], buttons: [], active: -1, language: '', height: 0 };
    rail.addEventListener('click', e => {
      const button = e.target.closest('button');
      if (button) jump(state, state.buttons.indexOf(button));
    });
    rail.addEventListener('keydown', e => {
      const index = state.buttons.indexOf(e.target);
      if (index < 0) return;
      const next = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: state.items.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault(); jump(state, Math.max(0, Math.min(next, state.items.length - 1)), true);
    });
    resize.observe(el);
    states.set(el, state);
    return state;
  }
  function update() {
    frame = 0;
    for (const el of document.querySelectorAll(selector)) if (!states.has(el)) create(el);
    for (const [el, s] of states) {
      if (!el.isConnected) {
        resize.unobserve(el); s.items.forEach(n => resize.unobserve(n));
        s.rail.remove(); states.delete(el); continue;
      }
      const rect = el.getBoundingClientRect();
      if (!rect.width || rect.height < 56 || el.closest('[inert], [hidden]')) { s.rail.hidden = true; continue; }
      // Only top-level messages count; tools, thought details and queued drafts do not.
      const items = Array.from(el.children).filter(n => n.matches(messageSelector) && !n.hidden);
      const structureChanged = items.length !== s.items.length || items.some((n, i) => n !== s.items[i]);
      if (structureChanged) {
        const previous = new Map(s.items.map((n, i) => [n, s.buttons[i]]));
        const next = new Set(items);
        const activeMessage = s.items[s.active];
        const focused = s.rail.contains(document.activeElement) ? document.activeElement : null;
        for (const n of s.items) if (!next.has(n)) { resize.unobserve(n); previous.get(n).remove(); }
        s.buttons = items.map(n => {
          if (previous.has(n)) return previous.get(n);
          resize.observe(n);
          const b = document.createElement('button'); b.type = 'button'; b.tabIndex = -1;
          b.className = 'conversation-nav-tick'; return b;
        });
        // Appending a streaming reply must not replace the focused marker.
        let cursor = s.rail.firstChild;
        for (const b of s.buttons) {
          if (b === cursor) cursor = cursor.nextSibling;
          else s.rail.insertBefore(b, cursor);
        }
        if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
        s.items = items; s.active = items.indexOf(activeMessage); s.language = '';
      }
      const visible = items.length > 1 && el.scrollHeight > el.clientHeight + 2;
      el.classList.toggle('has-message-nav', visible);
      const wasHidden = s.rail.hidden;
      s.rail.hidden = !visible;
      if (!visible) continue;
      const language = zh() ? 'zh' : 'en';
      if (language !== s.language) {
        s.language = language;
        s.rail.setAttribute('aria-label', zh() ? '消息位置导航' : 'Message navigation');
        s.buttons.forEach((b, i) => {
          b.title = zh() ? `第 ${i + 1} 条消息` : `Message ${i + 1}`;
          b.setAttribute('aria-label', b.title);
        });
      }
      const height = Math.min(320, rect.height - 32, items.length * 8 + 28);
      const resized = height !== s.height;
      s.height = height;
      Object.assign(s.rail.style, { top: `${rect.top + (rect.height - height) / 2}px`,
        left: `${Math.min(innerWidth - 28, rect.right - 28)}px`, height: `${height}px` });
      // Binary search avoids measuring every message during each scroll frame.
      const line = rect.top + 24;
      let lo = 0, hi = items.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (items[mid].getBoundingClientRect().top <= line) lo = mid; else hi = mid - 1;
      }
      const active = el.scrollHeight - el.scrollTop - el.clientHeight <= 2 ? items.length - 1 : lo;
      const changed = active !== s.active;
      if (changed) {
        if (s.buttons[s.active]) { s.buttons[s.active].removeAttribute('aria-current'); s.buttons[s.active].tabIndex = -1; }
        s.buttons[active].setAttribute('aria-current', 'true');
        s.buttons[active].tabIndex = 0;
        s.active = active;
      }
      // A smaller viewport (including the mobile keyboard) can clip the same
      // active marker even when the reading position has not changed.
      // Resizing or restoring the rail must reveal the marker even under the
      // pointer; hover protection only applies to ordinary content updates.
      if (resized || wasHidden || ((changed || structureChanged) && !s.rail.matches(':hover'))) {
        s.rail.scrollTop = active * 8 + 18 - height / 2;
      }
    }
  }
  const observer = new MutationObserver(records => {
    if (records.some(r => !(r.target instanceof Element ? r.target : r.target.parentElement)?.closest('.conversation-nav'))) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'hidden', 'inert', 'lang'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  document.addEventListener('scroll', e => { if (e.target instanceof Element && e.target.matches(selector)) schedule(); }, { capture: true, passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  document.addEventListener('load', schedule, true);
  document.fonts?.ready.then(schedule);
  schedule();
})();
