/* Shared verbatim with remote/public/conversation-presentation.js. Pure rules only. */
(() => {
  function toolActivityKey(tool) {
    const name = tool?.name || tool?.toolName || '', kind = tool?.kind;
    if (kind === 'read' || /^(read|read_file|ls|list_files)$/.test(name)) return 'activity.reading';
    if (kind === 'search' || /^(grep|glob|search|web_search|web_fetch)$/.test(name)) return 'activity.searching';
    if (kind === 'edit' || kind === 'write' || /^(write|edit|write_file|edit_file|apply_patch)$/.test(name)) return 'activity.writing';
    return 'activity.working';
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
  globalThis.AsHubConversationPresentation = Object.freeze({ toolActivityKey, usageMetrics });
})();
