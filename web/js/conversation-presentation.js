/* Shared verbatim with remote/public/conversation-presentation.js. Presentation helpers only; no session or transport state. */
(() => {
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

  // A classic script on remote and a side-effect ESM import on desktop.
  globalThis.AsHubConversationPresentation = Object.freeze({ activityTimestamp, renderActivityTime, toolActivityKey, usageMetrics, toolDisplayName, thinkingPreview, renderThinkingContent });
})();
