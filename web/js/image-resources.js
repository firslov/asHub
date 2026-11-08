/* Generic image-resource presentation. Keep identical in remote/public. */
(() => {
  if (typeof globalThis.marked?.use !== 'function') return;
  const pattern = /^ashub-image:([a-f0-9]{64})\/([1-9]\d{0,4})x([1-9]\d{0,4})$/;
  const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function parse(ref) {
    const m = pattern.exec(ref || '');
    if (!m || +m[2] > 16384 || +m[3] > 16384 || +m[2] * +m[3] > 32000000) return null;
    return { id:m[1], width:+m[2], height:+m[3] };
  }
  globalThis.marked?.use({renderer:{image(token) {
    const ref = parse(token.href);
    if (!ref) return /^ashub-image:/i.test(token.href || '') ? escape(token.text || '') : false;
    return `<span class="image-resource" data-image-ref="${escape(token.href)}" data-image-caption="${escape(token.text || '')}">${escape(token.text || '')}</span>`;
  }}});
  const states = new Map(), queue = []; let running = 0;
  function drain() {
    while (running < 2 && queue.length) {
      const run = queue.shift(); running++;
      Promise.resolve().then(run).finally(() => { running--; drain(); });
    }
  }
  function dispose(node, state) {
    state.controller?.abort(); if (state.blob) URL.revokeObjectURL(state.blob);
    observer?.unobserve(node); states.delete(node);
  }
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); states.get(e.target)?.start(); }
  }, {rootMargin:'240px'}) : null;
  // No image or pending request survives the removal of its owning reply.
  new MutationObserver(records => {
    if (records.some(r => r.removedNodes.length)) for (const [node,state] of states) if (!node.isConnected) dispose(node,state);
  }).observe(document.documentElement,{childList:true,subtree:true});
  function preserve(root) {
    return [...root.querySelectorAll('.image-resource[data-image-ref]')].filter(node => states.has(node));
  }
  function normalize(root) {
    for (const node of root.querySelectorAll('.image-resource[data-image-ref]')) {
      node.removeAttribute('style'); node.textContent = node.dataset.imageCaption || '';
    }
  }
  function hydrate(root, options, reuse = []) {
    const {scope, current, resolve, open, lang = 'zh'} = options;
    const zh = lang.startsWith('zh');
    for (let node of root.querySelectorAll('.image-resource[data-image-ref]')) {
      // An unchanged live image already owns its state; reserve reuse for fresh placeholders.
      if (states.has(node)) continue;
      const ref = parse(node.dataset.imageRef); if (!ref) continue;
      const old = reuse.find(n => states.get(n)?.scope === scope && n.dataset.imageRef === node.dataset.imageRef && n.dataset.imageCaption === node.dataset.imageCaption);
      if (old && old !== node) { reuse.splice(reuse.indexOf(old),1); node.replaceWith(old); node = old; }
      if (states.has(node)) continue;
      const caption = node.dataset.imageCaption || (zh ? '图片' : 'Image');
      const button = document.createElement('button'), label = document.createElement('span');
      button.type = 'button'; button.className = 'image-resource-surface'; button.setAttribute('aria-label',caption);
      // The intrinsic image supplies its ratio; a minimum-height aspect-ratio box
      // can impose a huge minimum width on tables and flex containers.
      label.className = 'image-resource-caption'; label.textContent = caption;
      node.replaceChildren(button,label);
      const state = {scope, blob:null, controller:null, busy:false, ready:false, start:null}; states.set(node,state);
      const valid = () => node.isConnected && states.get(node) === state && current();
      const loading = () => { button.textContent = zh ? '正在载入图片…' : 'Loading image…'; button.disabled = true; };
      const load = async () => {
        if (!valid() || state.ready || state.busy) return;
        state.busy = true; loading(); state.controller = new AbortController(); let url;
        const timer = setTimeout(() => state.controller.abort(),30000);
        try {
          url = new URL(resolve(ref.id),location.href);
          if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) throw Error('Invalid resource');
          const response = await fetch(url,{credentials:'same-origin',redirect:'error',signal:state.controller.signal});
          const mime = response.headers.get('content-type')?.split(';')[0];
          if (!response.ok || !['image/png','image/jpeg','image/webp'].includes(mime) || Number(response.headers.get('content-length')) > 8388608) throw Error('Unavailable');
          const reader = response.body.getReader(); const parts = []; let size = 0;
          try { for (;;) { const {done,value} = await reader.read(); if(done) break; size += value.length; if(size > 8388608) throw Error('Too large'); parts.push(value); } }
          finally { await reader.cancel().catch(()=>{}); }
          if (!valid()) return;
          const blob = URL.createObjectURL(new Blob(parts,{type:mime})); state.blob = blob;
          const img = new Image(); img.alt = caption; img.decoding = 'async'; img.src = blob; await img.decode();
          if (!valid()) return;
          if(img.naturalWidth > 16384 || img.naturalHeight > 16384 || img.naturalWidth * img.naturalHeight > 32000000) throw Error('Too large');
          button.replaceChildren(img); button.disabled = false; state.ready = true;
          button.onclick = event => { event.preventDefault(); event.stopPropagation(); if(valid()) open(url.href, `image.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`, valid); };
        } catch {
          if(state.blob) { URL.revokeObjectURL(state.blob); state.blob = null; }
          if(valid()) { button.disabled = false; button.textContent = zh ? '图片暂不可用 · 点击重试' : 'Image unavailable · Retry'; button.onclick = event => { event.preventDefault(); event.stopPropagation(); state.start(); }; }
        } finally { clearTimeout(timer); state.busy = false; if(!valid() && states.has(node)) dispose(node,state); }
      };
      state.start = () => { queue.push(load); drain(); }; loading();
      if(observer) observer.observe(node); else state.start();
    }
  }
  globalThis.AsHubImageResources = {parse,preserve,normalize,hydrate};
})();
