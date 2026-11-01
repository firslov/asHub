/* Shared file preview host. Renderers are registered by trusted UI modules;
   file contents never register or execute code. */
(() => {
  const renderers = new Map();
  let active = null;
  const words = {
    zh: { close:'返回对话', loading:'正在读取文件…', open:'默认应用打开', reveal:'在文件夹中显示', download:'下载副本', share:'存储或分享', unsupported:'此格式暂不支持应用内预览', large:'文件较大，请使用默认应用打开或下载', error:'文件无法读取，可能已移动、连接中断或不在共享目录内', changed:'文件已更新，请关闭后重新打开', zoomIn:'放大', zoomOut:'缩小', fit:'适应窗口', copy:'复制全文', copied:'已复制', source:'查看原文', reading:'阅读视图', search:'查找内容', prev:'上一页', next:'下一页', invalid:'无法预览此文件，请使用默认应用打开或下载' },
    en: { close:'Back to conversation', loading:'Loading file…', open:'Open with default app', reveal:'Show in folder', download:'Download a copy', share:'Save or share', unsupported:'Preview is not available for this format', large:'This file is large. Open it in an app or download it', error:'File unavailable. Check the connection, path and shared directory', changed:'File changed. Close and reopen the preview', zoomIn:'Zoom in', zoomOut:'Zoom out', fit:'Fit to window', copy:'Copy text', copied:'Copied', source:'View source', reading:'Reading view', search:'Find in text', prev:'Previous page', next:'Next page', invalid:'Unable to preview this file. Open it in an app or download it' }
  };
  const element = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls || ''; if (text !== undefined) e.textContent = text; return e; };
  function close() { active?.close(); }
  async function read(response, limit, signal) {
    const reader = response.body.getReader(), parts = []; let size = 0;
    try {
      while (true) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const {done, value} = await reader.read(); if (done) break;
        size += value.byteLength; if (size > limit) throw Error('too-large'); parts.push(value);
      }
      return new Blob(parts);
    } finally { await reader.cancel().catch(() => {}); }
  }
  async function open(options) {
    close();
    const w = words[options.lang === 'zh' ? 'zh' : 'en'];
    const controller = new AbortController(), cleanups = [], focus = document.activeElement;
    const dialog = element('dialog', 'artifact-preview'); dialog.setAttribute('aria-label', options.name);
    const header = element('header', 'artifact-preview-header');
    const title = element('div', 'artifact-preview-title');
    const name = element('strong', '', options.name), meta = element('span'); title.append(name, meta);
    const actions = element('div', 'artifact-preview-actions'), toolbar = element('div', 'artifact-preview-toolbar');
    const body = element('div', 'artifact-preview-body'), status = element('p', 'artifact-preview-status', w.loading);
    status.setAttribute('role', 'status');
    header.append(title, actions); body.append(status); dialog.append(header, toolbar, body); document.body.append(dialog);
    let alive = true;
    const current = () => alive && dialog.open && (!options.current || options.current());
    function dispose() {
      if (!alive) return; alive = false; controller.abort();
      for (const fn of cleanups.splice(0)) { try { fn(); } catch {} }
      dialog.remove(); if (active?.dialog === dialog) active = null;
      if (focus?.isConnected) focus.focus({preventScroll:true});
    }
    active = { dialog, close() { dialog.close(); dispose(); } };
    dialog.addEventListener('close', dispose);
    const routeLink = async e => {
      e.stopPropagation();
      if (e.type === 'auxclick' && e.button !== 1) return;
      const link = e.target.closest?.('a[href]');
      if (e.defaultPrevented || !link || link.hasAttribute('download') || !options.openExternal) return;
      const href = link.getAttribute('href');
      if (!/^https?:\/\//i.test(href || '')) return;
      // The modal isolates clicks from the host, so desktop link routing
      // must be supplied explicitly. Web/PWA links keep browser defaults.
      e.preventDefault();
      if (!current()) { close(); return; }
      try { await options.openExternal(href); }
      catch (e) { if (current()) { status.hidden = false; status.textContent = e?.message || w.error; } }
    };
    dialog.addEventListener('click', routeLink);
    dialog.addEventListener('auxclick', routeLink);
    // Keep conversation-level shortcuts outside the modal. Native Escape,
    // focus traversal and copying still retain their browser defaults.
    dialog.addEventListener('keydown', e => e.stopPropagation());
    const button = (parent, label, fn) => {
      const b = element('button', '', label); b.type = 'button'; b.title = label;
      b.addEventListener('click', async () => {
        if (!current()) { close(); return; }
        b.disabled = true;
        try { await fn(); } catch (e) { if (current() && e.name !== 'RenderingCancelledException') { status.hidden = false; status.textContent = e.message || w.error; } }
        finally { if (alive) b.disabled = false; }
      }); parent.append(b); return b;
    };
    const back = button(actions, w.close, () => close()); back.className = 'artifact-preview-back';
    dialog.showModal(); back.focus();
    const timer = setTimeout(() => controller.abort(), 120000); cleanups.push(() => clearTimeout(timer));
    try {
      const url = new URL(options.url, location.href);
      if (url.origin !== location.origin || !['http:', 'https:'].includes(url.protocol)) throw Error(w.error);
      const init = { signal:controller.signal, cache:'no-store' };
      const check = r => { if (!r.ok || !r.headers.get('content-disposition')?.startsWith('attachment;')) throw Error(r.status === 409 ? w.changed : w.error); };
      const head = await fetch(url, {...init, method:'HEAD'}); check(head); if (!current()) return;
      const length = head.headers.get('content-length'), size = length === null ? NaN : Number(length);
      if (!Number.isSafeInteger(size) || size < 0) throw Error(w.error);
      meta.textContent = size < 1024 ? `${size} B` : size < 1048576 ? `${(size/1024).toFixed(1)} KB` : `${(size/1048576).toFixed(1)} MB`;
      const version = head.headers.get('x-artifact-version'); if (version) url.searchParams.set('version', version);
      if (options.nativeAction) {
        button(actions, w.open, () => options.nativeAction('open'));
        button(actions, w.reveal, () => options.nativeAction('reveal'));
      }
      button(actions, w.download, () => {
        const a = element('a'); a.href = url.href; a.download = options.name; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.addEventListener('click', e => e.stopPropagation()); dialog.append(a); a.click(); a.remove();
      });
      if (options.share) button(actions, w.share, () => { close(); return options.share(new URL(url.href)); });
      const renderer = [...renderers.values()].find(r => r.accept(options.name));
      if (!renderer) { status.textContent = w.unsupported; return; }
      if (size > renderer.limit) { status.textContent = w.large; return; }
      const response = await fetch(url, init); check(response);
      const blob = await read(response, renderer.limit, controller.signal); if (!current()) return;
      if (blob.size !== size) throw Error(w.changed);
      status.hidden = true;
      await renderer.render({blob, name:options.name, body, toolbar, w, button, element, current, signal:controller.signal,
        cleanup:fn => { if (alive) cleanups.push(fn); else fn(); }, pdfBase:options.pdfBase});
    } catch (e) { if (current()) { status.hidden = false; status.textContent = e.message === 'too-large' ? w.large : e.name === 'AbortError' ? w.error : e.message || w.invalid; } }
    finally { clearTimeout(timer); }
  }
  globalThis.AsHubFilePreview = {
    open, close,
    register(id, renderer) {
      if (!id || !renderer || typeof renderer.accept !== 'function' || typeof renderer.render !== 'function'
        || !Number.isSafeInteger(renderer.limit) || renderer.limit < 1 || renderer.limit > 32 * 1024 * 1024) throw Error('Invalid preview renderer');
      if (renderers.has(id)) throw Error('Preview renderer already registered');
      renderers.set(id, renderer); return () => { if (renderers.get(id) === renderer) renderers.delete(id); };
    }
  };
})();
