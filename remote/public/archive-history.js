/* Read-only archive viewer. No live-session, attachment or draft integration. */
(() => {
  function create({ rpc, context, supported, online, onOpen, onClose }) {
    const $ = id => document.getElementById(id);
    const trigger = $('archive-open'), dialog = $('archive-dialog');
    if (!trigger || !dialog) return null; // A cached shell can predate this control.
    const catalog = $('archive-catalog'), reader = $('archive-reader');
    const filter = $('archive-search'), list = $('archive-items'), messages = $('archive-messages');
    const title = $('archive-heading'), back = $('archive-back'), more = $('archive-more');
    const listStatus = $('archive-list-status'), historyStatus = $('archive-history-status');
    const retryList = $('archive-retry-list'), retryHistory = $('archive-retry-history');
    let view, pending, composing = false;
    const normalize = value => value.normalize('NFKC').toLowerCase();
    const active = state => state === view && dialog.open && supported() && state.key === context().key;

    function cancel() {
      if (!pending) return;
      const request = pending; pending = null;
      clearTimeout(request.timeout);
      request.controller.abort();
    }

    function clear() {
      cancel(); view = null; composing = false;
      filter.value = ''; list.replaceChildren(); messages.replaceChildren();
      title.textContent = '归档历史';
      catalog.hidden = false; reader.hidden = true; back.hidden = true;
      listStatus.textContent = ''; historyStatus.textContent = '';
      retryList.hidden = retryHistory.hidden = more.hidden = true;
      catalog.scrollTop = messages.scrollTop = 0;
    }

    function close(returnFocus = false) {
      const wasOpen = dialog.open;
      clear();
      if (wasOpen) {
        dialog.close();
        if (returnFocus) onClose();
      }
    }

    async function read(state, op, args, success, failure) {
      if (!active(state)) return;
      cancel();
      const controller = new AbortController();
      const request = { controller, timeout: setTimeout(() => controller.abort(), 30000) };
      pending = request;
      const current = () => pending === request && active(state);
      try {
        const data = await rpc(op, args, state.device, controller.signal);
        if (current()) {
          if (controller.signal.aborted) failure();
          else success(data);
        }
      } catch {
        if (current()) failure();
      } finally {
        clearTimeout(request.timeout);
        if (pending === request) pending = null;
      }
    }

    function visibleItems(state) {
      const query = normalize(filter.value.trim());
      return state.items.filter(item => !query || normalize(item.title).includes(query) || normalize(item.cwd).includes(query));
    }

    function renderList(state) {
      const items = visibleItems(state);
      list.replaceChildren(...items.map(item => {
        const li = document.createElement('li');
        const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'choice archive-item';
        choice.dataset.archiveId = item.id;
        const name = document.createElement('strong'); name.textContent = item.title;
        choice.append(name);
        if (item.cwd) {
          const path = document.createElement('small'); path.textContent = item.cwd; choice.append(path);
        }
        choice.onclick = () => { if (active(state) && !state.history) showHistory(state, item); };
        li.append(choice); return li;
      }));
      if (state.itemsLoaded) listStatus.textContent = !state.items.length ? '此设备暂无可查看的归档对话' : items.length ? '' : '没有符合条件的归档对话';
    }

    function loadList(state) {
      if (document.activeElement === retryList) $('archive-close').focus();
      retryList.hidden = true; listStatus.textContent = '正在读取归档列表…';
      void read(state, 'archived-sessions', {}, data => {
        if (!Array.isArray(data)) throw Error('Invalid archive list');
        const ids = new Set();
        state.items = data.flatMap(item => {
          if (typeof item?.id !== 'string' || !item.id || ids.has(item.id)) return [];
          ids.add(item.id);
          return [{ id: item.id, title: typeof item.title === 'string' && item.title ? item.title : '未命名对话', cwd: typeof item.cwd === 'string' ? item.cwd : '' }];
        });
        state.itemsLoaded = true;
        renderList(state);
      }, () => { listStatus.textContent = '无法读取归档列表，请重试'; retryList.hidden = false; });
    }

    function messageNode({ role, text }) {
      const card = document.createElement('article'); card.className = 'archive-message';
      const label = document.createElement('h3'); label.textContent = role === 'user' ? '你' : '助手';
      const body = document.createElement('div'); body.className = 'message archive-text';
      if (globalThis.marked && globalThis.DOMPurify) {
        // This reader renders text formatting only: even valid links and images
        // display no active navigation or network resources from old messages.
        body.innerHTML = DOMPurify.sanitize(marked.parse(text), {
          ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
          ALLOWED_ATTR: [], ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
        });
      } else { body.textContent = text; body.classList.add('archive-plain'); }
      card.append(label, body); return card;
    }

    function preserveReadingPosition(update) {
      // Measure each synchronous update separately, never across an RPC: the
      // reader may scroll while it is pending. Prepend keeps the anchor node.
      const anchor = messages.firstElementChild;
      const before = anchor?.getBoundingClientRect().top;
      update();
      if (anchor) {
        const delta = anchor.getBoundingClientRect().top - before;
        if (delta) messages.scrollTop += delta;
      }
    }

    function loadPage(state) {
      const history = state.history;
      if (!history || history.offset === null || pending) return;
      const offset = history.offset;
      preserveReadingPosition(() => {
        if (document.activeElement === retryHistory) back.focus({ preventScroll: true });
        retryHistory.hidden = true; more.setAttribute('aria-disabled', 'true');
        historyStatus.textContent = '正在读取历史正文…';
      });
      void read(state, 'archived-history', { session: history.item.id, offset }, data => {
        if (!Array.isArray(data?.messages) || (data.nextOffset !== null && (!Number.isSafeInteger(data.nextOffset) || data.nextOffset <= offset))) throw Error('Invalid archive page');
        const page = data.messages.filter(item => (item?.role === 'user' || item?.role === 'assistant') && typeof item.text === 'string').map(messageNode);
        preserveReadingPosition(() => {
          messages.prepend(...page);
          more.removeAttribute('aria-disabled');
          history.offset = data.nextOffset;
          if (history.offset === null && document.activeElement === more) messages.focus({ preventScroll: true });
          more.hidden = history.offset === null;
          historyStatus.textContent = messages.childElementCount
            ? (history.offset === null && offset > 0 ? '已显示全部历史正文' : '')
            : (history.offset === null ? '这条归档暂无可查看的文字记录' : '这一页暂无文字，可以继续读取更早的消息');
        });
      }, () => preserveReadingPosition(() => {
        historyStatus.textContent = '无法读取历史正文，请重试';
        retryHistory.hidden = false;
        if (document.activeElement === more) retryHistory.focus({ preventScroll: true });
        more.hidden = true; more.removeAttribute('aria-disabled');
      }));
    }

    function showHistory(state, item) {
      cancel();
      state.history = { item, offset: 0 };
      title.textContent = item.title; messages.replaceChildren(); reader.scrollTop = 0;
      catalog.hidden = true; reader.hidden = false; back.hidden = false; more.hidden = true;
      back.focus({ preventScroll: true });
      loadPage(state);
    }

    function showList() {
      const state = view;
      if (!state?.history || !active(state)) return;
      cancel();
      const id = state.history.item.id; state.history = null;
      reader.hidden = true; back.hidden = true; messages.replaceChildren(); historyStatus.textContent = '';
      title.textContent = '归档历史'; catalog.hidden = false;
      (Array.from(list.querySelectorAll('button')).find(node => node.dataset.archiveId === id) || filter).focus({ preventScroll: true });
    }

    trigger.onclick = () => {
      if (!supported() || !online() || dialog.open) return;
      clear();
      onOpen();
      view = { ...context(), items: [], itemsLoaded: false, history: null };
      dialog.showModal();
      loadList(view);
    };
    $('archive-close').onclick = () => close(true);
    back.onclick = showList;
    retryList.onclick = () => { if (view && active(view) && !pending) loadList(view); };
    more.onclick = retryHistory.onclick = () => { if (view && active(view)) loadPage(view); };
    filter.oninput = () => { if (view && active(view)) renderList(view); };
    filter.addEventListener('compositionstart', () => { composing = true; });
    filter.addEventListener('compositionend', () => { composing = false; });
    filter.addEventListener('keydown', event => {
      if (event.key === 'Escape' && (event.isComposing || composing || event.keyCode === 229)) { event.preventDefault(); event.stopPropagation(); }
    });
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (composing) return;
      if (view?.history) showList(); else close(true);
    });
    dialog.addEventListener('close', () => { if (!dialog.open) clear(); });
    return { close, sync() {
      trigger.hidden = !supported();
      trigger.disabled = !online();
      if (view && !active(view)) close();
    } };
  }
  globalThis.AsHubArchiveHistory = { create };
})();
