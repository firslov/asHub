(() => {
  const payload = window.__RELEASE__ || {};
  const version = typeof payload.version === 'string' && /^\d+\.\d+\.\d+$/.test(payload.version) ? payload.version : '';
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const safeURL = value => {
    try { const u = new URL(value); return u.protocol === 'https:' ? u.href : null; } catch { return null; }
  };
  if (version) {
    document.querySelectorAll('[data-version]').forEach(el => { el.textContent = 'v' + version; el.hidden = false; });
  }
  let available = 0;
  document.querySelectorAll('[data-download]').forEach(link => {
    const file = assets.find(f => f && f.os === link.dataset.os && f.arch === link.dataset.arch && f.ext === link.dataset.ext && safeURL(f.url));
    if (!file) return; // The plain HTML fallback remains a working Releases link.
    link.href = safeURL(file.url);
    link.querySelector('[data-download-label]').textContent = '下载安装包';
    const size = Number(file.size);
    const meta = [file.ext.toUpperCase(), Number.isFinite(size) && size > 0 ? Math.round(size / 1e6) + ' MB' : ''].filter(Boolean).join(' · ');
    link.querySelector('[data-file-meta]').textContent = meta;
    available++;
  });
  if (available) document.querySelector('#download-status').textContent = (version ? '当前版本 v' + version + ' · ' : '') + '安装包通过镜像直连下载 · 应用内支持自动更新';
  const tabs = [...document.querySelectorAll('[data-showcase]')];
  function select(tab) {
    tabs.forEach(t => {
      const chosen = t === tab;
      t.setAttribute('aria-selected', String(chosen)); t.tabIndex = chosen ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !chosen;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
      if (event.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
      if (event.key === 'Home') next = tabs[0];
      if (event.key === 'End') next = tabs.at(-1);
      if (next) { event.preventDefault(); select(next); next.focus(); }
    });
  });
  document.querySelectorAll('[data-copy]').forEach(button => {
    let timer;
    button.addEventListener('click', async () => {
      const status = document.getElementById('copy-status');
      const code = document.getElementById(button.dataset.copy);
      clearTimeout(timer);
      try {
        await navigator.clipboard.writeText(code.textContent.trim());
        button.textContent = '已复制'; status.textContent = '命令已复制到剪贴板';
      } catch {
        const range = document.createRange(); range.selectNodeContents(code);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        button.textContent = '请手动复制'; status.textContent = '未能访问剪贴板，已选中命令，请手动复制';
      }
      timer = setTimeout(() => { button.textContent = '复制'; status.textContent = ''; }, 3500);
    });
  });
})();
