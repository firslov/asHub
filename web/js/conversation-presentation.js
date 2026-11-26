/* Shared verbatim with remote/public/conversation-presentation.js. Callers own session and transport state. */
(() => {
  function collaborationPart(value) {
    if (!value || !['task', 'supplement', 'blocker'].includes(value.kind) ||
        typeof value.taskId !== 'string' || !value.taskId.trim() || value.taskId.length > 160 ||
        typeof value.sender?.id !== 'string' || !value.sender.id.trim() ||
        typeof value.sender.title !== 'string' ||
        typeof value.body !== 'string' || !value.body.trim() || value.body.length > 8000 ||
        typeof value.authorization !== 'string' || !value.authorization.trim() || value.authorization.length > 1024) return null;
    const { kind, taskId, sender, body, authorization } = value;
    return { kind, taskId, sender: { id: sender.id, title: sender.title }, body, authorization };
  }

  function parseCollaborationMessage(payload) {
    // The authenticated host marks authored events. Raw query text cannot
    // supply or recreate provenance, even when copied from a real event.
    const value = payload?.collaboration;
    const part = collaborationPart(value);
    if (!part || value.supplements === undefined) return part;
    if (part.kind !== 'task' || !Array.isArray(value.supplements) || value.supplements.length > 32) return null;
    const supplements = [];
    for (const candidate of value.supplements) {
      const update = collaborationPart(candidate);
      if (update?.kind !== 'supplement' || update.taskId !== part.taskId ||
          update.sender.id !== part.sender.id || candidate.supplements !== undefined) return null;
      supplements.push(update);
    }
    return { ...part, supplements };
  }

  function renderCollaborationMessage(document, payload, options = {}) {
    const message = parseCollaborationMessage(payload);
    if (!message) return null;
    const english = typeof options.locale === 'string' && options.locale.startsWith('en');
    const labels = english
      ? { task: 'Collaboration task', supplement: 'Task supplement', blocker: 'Blocker notice', details: 'Details', taskId: 'Task ID', authorization: 'Authorization' }
      : { task: '协作任务', supplement: '任务补充', blocker: '阻塞通知', details: '详情', taskId: '任务 ID', authorization: '授权提示' };
    const element = (tag, className, text) => {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const root = element('div', 'collaboration-message');
    for (const part of [message, ...(message.supplements ?? [])]) {
      const item = element('div', 'collaboration-message-part');
      const heading = element('div', 'collaboration-message-heading');
      heading.append(
        element('span', 'collaboration-message-kind', labels[part.kind]),
        element('bdi', 'collaboration-message-sender', part.sender.title.trim() ? part.sender.title : part.sender.id),
      );
      const body = element('div', 'collaboration-message-body', part.body);
      const details = element('details', 'collaboration-message-details');
      const task = element('div', 'collaboration-message-detail');
      const authorization = element('div', 'collaboration-message-detail');
      task.append(element('span', '', labels.taskId + ' '), element('code', 'collaboration-message-task-id', part.taskId));
      authorization.append(element('span', '', labels.authorization + ' '),
        element('span', 'collaboration-message-authorization', part.authorization));
      details.append(element('summary', '', labels.details), task, authorization);
      item.append(heading, body, details);
      root.append(item);
    }
    return root;
  }

  // Event schema v1: completion means execution ended, not that the user's
  // overall task succeeded. A failed child/tool attempt never changes the
  // main turn's outcome. Legacy providers may express failure in any of
  // these fields; lightweight replay must retain them.
  function diagnosticState(result) {
    if (!result || typeof result !== 'object') return 'pending';
    if (result.cancelled === true) return 'cancelled';
    if (result.success === false || result.isError === true || result.error
      || (Number.isFinite(result.exitCode) && result.exitCode !== 0)) return 'failed';
    if (result.degraded === 'budget' || result.degraded === 'iterations') return 'partial';
    return 'ended';
  }

  // Cleanup can emit processing-done after an error or cancellation. The
  // terminal outcome is sticky until an explicit new processing-start.
  function turnLifecycle(name, previous = '') {
    if (name === 'agent:processing-start') return { started: true, outcome: '' };
    if (name === 'agent:error') return { started: false, outcome: 'error' };
    if (name === 'agent:cancelled') return { started: false, outcome: 'stopped' };
    if (name === 'agent:processing-done') return { started: false,
      outcome: previous === 'error' || previous === 'stopped' ? previous : 'done' };
    return null;
  }

  // Async collaborators may outlive a normally completed main turn. A
  // stopped/failed turn never resumes its indicator because of late events.
  function activityState({ finished = '', sealed = false, pending = 0,
    thinking = false, delegated = 0, waiting = false } = {}) {
    const running = !finished ? !sealed || pending > 0 || thinking || delegated > 0
      : finished === 'done' && delegated > 0;
    return running ? waiting ? 'waiting' : 'running' : 'settled';
  }

  // Branch reconstruction timestamps describe the rebuild, not the original work.
  function activityTimestamp(meta) {
    if (!meta || /^hub:.*:branch:\d+$/.test(meta.id || '')) return null;
    const value = meta.ts;
    if ((typeof value !== 'number' && typeof value !== 'string') || value === '') return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const pad = n => String(n).padStart(2, '0');
    const label = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(':');
    return { iso: date.toISOString(), label,
      title: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${label}` };
  }

  function renderActivityTime(node, value) {
    node.hidden = !value;
    node.textContent = value?.label || '';
    node.dateTime = value?.iso || '';
    node.title = value?.title || '';
  }

  function toolActivityKey(tool) {
    const name = tool?.name || tool?.toolName || '', kind = tool?.kind;
    if (name === 'conversation_wait') return 'activity.collaboration.wait';
    if (/^conversation_(send|read|list|task|deliver)$/.test(name)) return 'activity.delegating';
    if (kind === 'read' || /^(read|read_file|ls|list_files)$/.test(name)) return 'activity.reading';
    if (kind === 'search' || /^(grep|glob|search|web_search|web_fetch)$/.test(name)) return 'activity.searching';
    if (kind === 'edit' || kind === 'write' || /^(write|edit|write_file|edit_file|apply_patch)$/.test(name)) return 'activity.writing';
    return 'activity.working';
  }

  // Labels describe an operation, never claim that it succeeded.
  function toolDisplayName(tool, language = 'en') {
    const name = tool?.name || tool?.toolName || '';
    const labels = {
      conversation_wait: ['等待协作结果', 'Wait for collaborators'],
      conversation_send: ['发送协作消息', 'Send collaboration message'],
      conversation_read: ['查看对话进展', 'Read conversation progress'],
      conversation_list: ['查看项目成员', 'List project members'],
      conversation_task: ['查看协作结果', 'Read collaboration result'],
      conversation_deliver: ['提交协作成果', 'Submit collaboration result'],
      read_file: ['读取文件', 'Read file'], read: ['读取文件', 'Read file'],
      ls: ['查看目录', 'List directory'], list_files: ['查看目录', 'List directory'],
      grep: ['搜索内容', 'Search content'], glob: ['查找文件', 'Find files'],
      web_search: ['搜索网页', 'Search the web'], web_fetch: ['读取网页', 'Read web page'],
      write_file: ['写入文件', 'Write file'], edit_file: ['编辑文件', 'Edit file'],
      apply_patch: ['修改文件', 'Apply changes'], bash: ['运行命令', 'Run command'],
    };
    const pair = Object.hasOwn(labels, name) ? labels[name] : null;
    return pair ? pair[language === 'zh' ? 0 : 1] : String(tool?.title || name || (language === 'zh' ? '工具调用' : 'Tool call'));
  }

  function thinkingPreview(text) {
    // Preview only: full source remains available in the expanded content.
    const plain = String(text ?? '').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(?:\*\*|__)([\s\S]*?)(?:\*\*|__)/g, '$1')
      .replace(/`([^`]+)`/g, '$1').replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/\s+/g, ' ').trim();
    const chars = Array.from(plain);
    return chars.length > 100 ? chars.slice(0, 100).join('') + '…' : plain;
  }

  function renderThinkingContent(target, text) {
    target.classList?.remove('thinking-formatted');
    target.textContent = String(text ?? '');
    const parser = globalThis.marked, purifier = globalThis.DOMPurify;
    if (!parser?.parse || !parser.Renderer || !purifier?.sanitize) return;
    // Preserve reference addresses and literal HTML as inert text. Sanitizing
    // a normal document renderer would silently discard this information.
    const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
    const renderer = new parser.Renderer();
    // GFM normally emits disabled inputs, which the prose sanitizer removes.
    renderer.checkbox = ({ checked }) => checked ? '☑ ' : '☐ ';
    renderer.html = ({ text }) => escape(text);
    renderer.link = function ({ tokens, href, title }) {
      const label = this.parser.parseInline(tokens), address = escape(href);
      return label + (label === address ? '' : ' (' + address + ')') + (title ? ' — ' + escape(title) : '');
    };
    renderer.image = ({ text, href, title }) => escape(text) + ' (' + escape(href) + ')' + (title ? ' — ' + escape(title) : '');
    renderer.heading = function ({ tokens }) { return '<p><strong>' + this.parser.parseInline(tokens) + '</strong></p>\n'; };
    try {
      target.innerHTML = purifier.sanitize(parser.parse(String(text ?? ''), { renderer }), {
        ALLOWED_TAGS: ['p','strong','em','del','code','pre','ul','ol','li','blockquote','br','hr',
          'table','thead','tbody','tr','th','td'], ALLOWED_ATTR: ['start'],
      });
      target.classList?.add('thinking-formatted');
    } catch { /* Formatting must never interrupt the stream; retain plain text. */ }
  }

  function usageMetrics(usage = {}, contextWindow = 0) {
    const finite = value => Number.isFinite(value) && value >= 0;
    const count = value => finite(value) ? value : 0;
    const input = count(usage.prompt_tokens), output = count(usage.completion_tokens);
    const cacheHit = count(usage.prompt_cache_hit_tokens), cacheMiss = count(usage.prompt_cache_miss_tokens);
    const cacheTotal = cacheHit + cacheMiss;
    const cacheRatio = cacheTotal > 0 ? cacheHit / cacheTotal : 0;
    return {
      input, output,
      // Some providers include additional billable tokens in the total.
      total: finite(usage.total_tokens) ? usage.total_tokens : input + output,
      cacheHit, cacheMiss, cacheRatio,
      cacheReported: usage.cache_reported !== false,
      hasCache: cacheTotal > 0,
      // A near-perfect hit rate must not round up to a perfect 100%.
      cachePercent: Math.floor(cacheRatio * 1000) / 10,
      contextPercent: finite(contextWindow) && contextWindow > 0 ? Math.round(input / contextWindow * 100) : null,
    };
  }

  function parseCompactionNotice(message) {
    if (typeof message !== 'string') return null;
    const match = /^\((?:compacted|auto-compacted|context overflow — compacted):? ~(\d+|\d{1,3}(?:,\d{3})+) → ~(\d+|\d{1,3}(?:,\d{3})+) tokens(?:, evicted \d+|, retrying)?\)$/.exec(message);
    if (!match) return null;
    const beforeTokens = Number(match[1].replaceAll(',', '')), afterTokens = Number(match[2].replaceAll(',', ''));
    return Number.isSafeInteger(beforeTokens) && beforeTokens > 0 && Number.isSafeInteger(afterTokens) && afterTokens >= 0
      ? { beforeTokens, afterTokens } : null;
  }

  function renderCompaction(payload = {}, locale = 'zh', existing) {
    payload = payload && typeof payload === 'object' ? payload : {};
    const zh = locale === 'zh', pick = (a,b) => zh ? a : b;
    const valid = n => Number.isFinite(n) && n >= 0;
    const short = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n));
    const node = existing || document.createElement('details');
    const opened = node.open;
    node.className = 'compaction-marker';
    node._compactionData = { ...payload };
    const summary = document.createElement('summary');summary.className = 'cm-summary';
    const title = document.createElement('span');title.className = 'cm-title';title.textContent = pick('上下文已整理','Context compacted');
    const info = [];
    if (Number.isSafeInteger(payload.evictedCount) && payload.evictedCount > 0) info.push(pick(`${payload.evictedCount} 条记录`,`${payload.evictedCount} records`));
    if (valid(payload.beforeTokens) && payload.beforeTokens > 0 && valid(payload.afterTokens)) info.push(`~${short(payload.beforeTokens)} → ~${short(payload.afterTokens)}`);
    const metrics = document.createElement('span');metrics.className = 'cm-metrics';metrics.textContent = info.join(' · ');
    summary.append(title,metrics);
    const body = document.createElement('div');body.className = 'cm-details';
    const rows = [];
    if (valid(payload.beforeTokens) && payload.beforeTokens > 0 && valid(payload.afterTokens)) rows.push([pick('上下文估算','Estimated context'),`${Math.round(payload.beforeTokens).toLocaleString()} → ${Math.round(payload.afterTokens).toLocaleString()} tokens`]);
    if (payload.mode === 'semantic' || payload.mode === 'fallback') rows.push([pick('整理方式','Method'),payload.mode === 'semantic' ? pick('语义整理','Semantic summary') : pick('保底整理','Fallback summary')]);
    if (valid(payload.elapsedMs)) rows.push([pick('整理耗时','Duration'),`${(payload.elapsedMs / 1000).toFixed(1)} s`]);
    const dl = document.createElement('dl');
    for (const [label,value] of rows) { const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;dl.append(dt,dd); }
    const note=document.createElement('p');note.textContent=pick('Token 为上下文估算值，不代表实际计费。','Token counts estimate context size, not billed usage.');
    body.append(dl,note);node.replaceChildren(summary,body);node.open=opened;
    return node;
  }

  function mergeCompactionNotice(root, message, locale = 'zh') {
    const stats = parseCompactionNotice(message);
    if (!stats || !root) return false;
    // A matching checkpoint is required. Never attach an unrelated completion
    // to an older boundary merely because it happens to be the last one.
    const marker = [...root.querySelectorAll('.compaction-marker')].at(-1);
    if (!marker || marker._compactionData?.beforeTokens !== stats.beforeTokens) return false;
    const focused = marker.contains(document.activeElement);
    renderCompaction({ ...marker._compactionData, ...stats }, locale, marker);
    if (focused) marker.querySelector('summary').focus();
    return true;
  }

  // A classic script on remote and a side-effect ESM import on desktop.
  globalThis.AsHubConversationPresentation = Object.freeze({ eventVersion: 1, diagnosticState, turnLifecycle, activityState, activityTimestamp, renderActivityTime, toolActivityKey, usageMetrics, toolDisplayName, thinkingPreview, renderThinkingContent, parseCompactionNotice, renderCompaction, mergeCompactionNotice, parseCollaborationMessage, renderCollaborationMessage });
})();
