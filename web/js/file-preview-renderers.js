/* Basic, read-only viewers; PDF.js is loaded only when a PDF is opened. */
(() => {
  const registry = globalThis.AsHubFilePreview;
  const ext = name => name.split('.').pop().toLowerCase();
  registry.register('image', {
    accept: name => /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name), limit:16*1024*1024,
    async render(c) {
      const types = {png:'png',jpg:'jpeg',jpeg:'jpeg',gif:'gif',webp:'webp',bmp:'bmp',avif:'avif'};
      const url = URL.createObjectURL(new Blob([c.blob], {type:'image/'+types[ext(c.name)]})); c.cleanup(() => URL.revokeObjectURL(url));
      const img = c.element('img', 'artifact-preview-image'); img.alt = c.name; img.src = url;
      await img.decode(); if (!c.current()) return;
      c.body.append(img);
      // Zoom from the displayed size: a large image starts fitted to the
      // viewport, not at its natural pixel width.
      const zoom = factor => {
        const width = img.getBoundingClientRect().width;
        img.style.maxWidth = 'none';
        img.style.width = `${Math.max(1, Math.min(img.naturalWidth * 4, width * factor))}px`;
      };
      c.button(c.toolbar, c.w.zoomOut, () => zoom(1/1.25));
      c.button(c.toolbar, c.w.fit, () => { img.style.maxWidth = '100%'; img.style.width = ''; });
      c.button(c.toolbar, c.w.zoomIn, () => zoom(1.25));
    }
  });
  registry.register('text', {
    accept: name => /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|log|js|mjs|cjs|ts|tsx|jsx|css|html?|svg|py|sh|bash|zsh|sql|rs|go|java|c|h|cpp|toml|ini|cfg)$/i.test(name) || /^(license|readme|dockerfile|makefile)$/i.test(name), limit:2*1024*1024,
    async render(c) {
      const bytes = new Uint8Array(await c.blob.arrayBuffer());
      const bom16 = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
      const text = new TextDecoder(bom16).decode(bytes); if (text.includes('\0')) throw Error(c.w.invalid);
      if (!c.current()) return;
      const pre = c.element('pre', 'artifact-preview-text', text); c.body.append(pre);
      const search = c.element('input'); search.type = 'search'; search.placeholder = c.w.search; search.setAttribute('aria-label', c.w.search); c.toolbar.append(search);
      let index = -1;
      const find = () => {
        if (!search.value) { index = -1; pre.textContent = text; return; }
        // Case conversion can expand characters (e.g. İ → i + combining dot).
        // Match the original text so indices always refer to original code units.
        const query = search.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(query, 'giu');
        // Unicode regex engines round a position inside a surrogate pair
        // back to its start. Advance one complete code point between matches.
        pattern.lastIndex = index < 0 ? 0 : index + (text.codePointAt(index) > 0xffff ? 2 : 1);
        let match = pattern.exec(text);
        if (!match) { pattern.lastIndex = 0; match = pattern.exec(text); }
        index = match?.index ?? -1;
        pre.replaceChildren(); if (!match) { pre.textContent = text; return; }
        pre.append(document.createTextNode(text.slice(0,index)));
        const mark = c.element('mark', '', match[0]); pre.append(mark, document.createTextNode(text.slice(index+match[0].length))); mark.scrollIntoView({block:'center'});
      };
      search.addEventListener('input', () => {index=-1; find();}); search.addEventListener('keydown', e => {if(e.key==='Enter'){e.preventDefault();find();}});
      const copy = c.button(c.toolbar, c.w.copy, async () => { await navigator.clipboard.writeText(text); copy.textContent = c.w.copied; });
      if (/\.(md|markdown)$/i.test(c.name) && globalThis.marked && globalThis.DOMPurify) {
        const rendered = c.element('article', 'artifact-preview-markdown');
        rendered.innerHTML = DOMPurify.sanitize(marked.parse(text), {FORBID_TAGS:['img','svg','style','iframe','object','embed','form','input','video','audio'], FORBID_ATTR:['style','id','name']});
        for (const a of rendered.querySelectorAll('a')) {
          if (!/^https?:\/\//i.test(a.getAttribute('href') || '')) a.removeAttribute('href');
          else { a.target='_blank'; a.rel='noopener noreferrer'; }
        }
        c.body.append(rendered); pre.hidden=true; search.hidden=true;
        const toggle = c.button(c.toolbar, c.w.source, () => {pre.hidden=!pre.hidden; rendered.hidden=!rendered.hidden; search.hidden=pre.hidden; toggle.textContent=pre.hidden ? c.w.source : c.w.reading;});
      }
    }
  });
  registry.register('pdf', {
    accept: name => /\.pdf$/i.test(name), limit:24*1024*1024,
    async render(c) {
      const base = new URL(c.pdfBase, location.href);
      const pdfjs = await import(new URL('pdf.min.mjs',base).href);
      if (!c.current()) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs',base).href;
      const task = pdfjs.getDocument({data:new Uint8Array(await c.blob.arrayBuffer()),
        cMapUrl:new URL('cmaps/',base).href,cMapPacked:true,standardFontDataUrl:new URL('standard_fonts/',base).href,
        wasmUrl:new URL('wasm/',base).href,iccUrl:new URL('iccs/',base).href,isEvalSupported:false});
      c.cleanup(() => {void task.destroy().catch(() => {});});
      const pdf = await task.promise; if (!c.current()) return;
      const canvas = c.element('canvas', 'artifact-preview-pdf'); canvas.setAttribute('aria-label',c.name); c.body.append(canvas);
      let pageNo = 1, zoom = 1, renderTask = null, serial = Promise.resolve(), revision = 0, displayedPage = 0;
      const label = c.element('span'); c.toolbar.append(label);
      const paint = () => {
        const rev = ++revision; renderTask?.cancel();
        serial = serial.catch(() => {}).then(async () => {
          if (!c.current() || rev !== revision) return;
          const targetPage = pageNo;
          const page = await pdf.getPage(targetPage); if (!c.current() || rev !== revision) return;
          const original = page.getViewport({scale:1});
          const style = getComputedStyle(c.body);
          const available = c.body.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
          const scale = Math.min(1.6, Math.max(1, available)/original.width)*zoom;
          const view = page.getViewport({scale});
          const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(12000000/(view.width*view.height)));
          canvas.width = Math.ceil(view.width*ratio); canvas.height = Math.ceil(view.height*ratio);
          canvas.style.width = `${view.width}px`; canvas.style.height = `${view.height}px`;
          label.textContent = `${targetPage} / ${pdf.numPages}`;
          renderTask = page.render({canvasContext:canvas.getContext('2d'),viewport:view,transform:[ratio,0,0,ratio,0,0]});
          await renderTask.promise; renderTask=null; page.cleanup();
          // New pages start at the beginning; zoom and viewport resizing keep
          // the reader's position on the same page.
          if (c.current() && rev === revision && displayedPage !== targetPage) {
            c.body.scrollTop = 0; c.body.scrollLeft = 0; displayedPage = targetPage;
          }
        }); return serial;
      };
      c.cleanup(() => { revision++; renderTask?.cancel(); });
      c.button(c.toolbar,c.w.prev,() => {pageNo=Math.max(1,pageNo-1); return paint();});
      c.button(c.toolbar,c.w.next,() => {pageNo=Math.min(pdf.numPages,pageNo+1); return paint();});
      c.button(c.toolbar,c.w.zoomOut,() => {zoom=Math.max(.5,zoom/1.25); return paint();});
      c.button(c.toolbar,c.w.zoomIn,() => {zoom=Math.min(2,zoom*1.25); return paint();});
      let lastWidth = c.body.clientWidth;
      const resize = new ResizeObserver(() => {
        const width = c.body.clientWidth;
        if (width === lastWidth || !c.current()) return;
        lastWidth = width; void paint().catch(() => {});
      });
      resize.observe(c.body); c.cleanup(() => resize.disconnect());
      await paint().catch(e => { if (e.name !== 'RenderingCancelledException') throw e; });
    }
  });
})();
