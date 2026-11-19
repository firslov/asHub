/* Ordinary Markdown workspace images: authenticated artifact transport only. */
(() => {
  if (typeof globalThis.marked?.use !== 'function') return;
  const escape = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function parse(ref) { return typeof ref === 'string' && ref.length > 0 && ref.length <= 8192 ? {id:ref} : null; }
  globalThis.marked.use({renderer:{image(token) {
    if (/^ashub-image:/i.test(token.href || '')) return false;
    return `<span class="image-resource artifact-image" data-artifact-ref="${escape(token.href || '')}" data-image-caption="${escape(token.text || '')}">${escape(token.text || '')}</span>`;
  }}});
  function imageMime(bytes) {
    if ([137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)) return 'image/png';
    if (bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
    const text = String.fromCharCode(...bytes.slice(0,12));
    if (text.startsWith('RIFF') && text.slice(8)==='WEBP') return 'image/webp';
    if (/^GIF8[79]a/.test(text)) return 'image/gif';
    throw Error('Unsupported image');
  }
  const states = new Map();
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
    return [...root.querySelectorAll('.artifact-image[data-artifact-ref]')].filter(node => states.has(node));
  }
  function normalize(root) {
    for (const node of root.querySelectorAll('.artifact-image[data-artifact-ref]')) {
      node.removeAttribute('style'); node.textContent = node.dataset.imageCaption || '';
    }
  }
  function hydrate(root, options, reuse = []) {
    const {scope, current, resolve, open, lang = 'zh'} = options;
    const zh = lang.startsWith('zh');
    for (let node of root.querySelectorAll('.artifact-image[data-artifact-ref]')) {
      // An unchanged live image already owns its state; reserve reuse for fresh placeholders.
      if (states.has(node)) continue;
      const ref = parse(node.dataset.artifactRef); if (!ref) continue;
      const old = reuse.find(n => states.get(n)?.scope === scope && n.dataset.artifactRef === node.dataset.artifactRef && n.dataset.imageCaption === node.dataset.imageCaption);
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
          if (!response.ok || Number(response.headers.get('content-length')) > 8388608) throw Error('Unavailable');
          const version = response.headers.get('x-artifact-version');
          if (version) url.searchParams.set('version', version);
          const reader = response.body.getReader(); const parts = []; let size = 0;
          try { for (;;) { const {done,value} = await reader.read(); if(done) break; size += value.length; if(size > 8388608) throw Error('Too large'); parts.push(value); } }
          finally { await reader.cancel().catch(()=>{}); }
          if (!valid()) return;
          const payload = new Blob(parts);
          const mime = imageMime(new Uint8Array(await payload.slice(0,12).arrayBuffer()));
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
      state.start = () => { globalThis.AsHubImageResources.enqueue(load); }; loading();
      if(observer) observer.observe(node); else state.start();
    }
  }
  globalThis.AsHubArtifactImages = {preserve,hydrate};
})();
