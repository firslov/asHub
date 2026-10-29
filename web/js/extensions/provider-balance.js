import { features, featureEnabled, featuresReady } from './feature-state.js';

// ── Balance display (DeepSeek, OpenRouter) ─────────────────────────
// Per-provider cache shared across all sessions. Refreshed at startup
// and after each agent response for the active session's provider.

export const BALANCE_PROVIDERS = new Set(["deepseek", "openrouter"]);

export function createProviderBalanceUI({ sessions, refreshModelChip }) {
  const _balanceCache = new Map();  // provider -> { data, ts }
  let _balanceGeneration = 0;

  async function fetchProviderBalance(provider) {
    if (!featureEnabled('provider-balance')) return null;
    const generation = _balanceGeneration;
    try {
      const r = await fetch(`/api/balance?provider=${provider}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (generation !== _balanceGeneration) return null;
      _balanceCache.set(provider, { data, ts: Date.now() });
      return data;
    } catch {
      return null;
    }
  }

  function renderBalance(el, data) {
    if (!el) return;
    if (!data?.is_available || !Array.isArray(data?.balance_infos) || !data.balance_infos.length) {
      el._balanceLabel = "";
      return;
    }
    const curSym = (cur) => cur === "CNY" ? "¥" : cur === "USD" ? "$" : (cur ?? "");
    const info = data.balance_infos[0];
    const total = info.total_balance ?? "—";
    el._balanceLabel = `💰 ${curSym(info.currency)}${total}`;
  }

  // Sync every session's balance chip: show cached data for supported
  // providers, hide for unsupported ones.
  function syncAllBalanceChips() {
    for (const [_, s] of sessions) {
      const el = s.balanceEl;
      if (!el) continue;
      const provider = s.agentInfo?.provider ?? "";
      if (!featureEnabled('provider-balance') || !BALANCE_PROVIDERS.has(provider)) {
        // Not a balance-tracked provider: `.usage-model-balance` doubles as
        // the model-name chip, so it must stay visible.  Just drop any stale
        // balance label and re-render the model-only chip.
        el._balanceLabel = "";
        refreshModelChip(s);
        continue;
      }
      const cached = _balanceCache.get(provider);
      if (cached?.data) {
        renderBalance(el, cached.data);
        refreshModelChip(s);
      } else {
        el._balanceLabel = "";
        refreshModelChip(s);
      }
    }
  }

  // Refresh a provider's balance and sync all chips for that provider.
  async function refreshProviderBalance(provider) {
    const generation = _balanceGeneration;
    const data = await fetchProviderBalance(provider);
    if (!data || generation !== _balanceGeneration) return;
    for (const [_, s] of sessions) {
      if ((s.agentInfo?.provider ?? "") === provider && s.balanceEl) {
        renderBalance(s.balanceEl, data);
        refreshModelChip(s);
      }
    }
  }

  // Config saves already notify model-catalog consumers. Balances use the
  // same provider credentials, including requests still in flight at save time.
  const invalidate = () => {
    _balanceGeneration++;
    _balanceCache.clear();
    syncAllBalanceChips();
    if (featureEnabled('provider-balance')) for (const provider of BALANCE_PROVIDERS) void refreshProviderBalance(provider);
  };
  document.addEventListener('ash:models-changed', invalidate);
  // Other clients and host restarts use the versioned host event path rather
  // than a local model-catalog event. Drop their old-credential results too.
  document.addEventListener('ash:host-state-changed', event => {
    const domains = event.detail?.domains;
    if (!Array.isArray(domains) || domains.includes('configuration')) invalidate();
  });
  let wasEnabled = featureEnabled('provider-balance');
  features.subscribe(() => {
    const enabled = featureEnabled('provider-balance');
    if (wasEnabled !== enabled) { wasEnabled = enabled; invalidate(); }
  });
  void featuresReady().then(() => { for (const provider of BALANCE_PROVIDERS) void refreshProviderBalance(provider); });
  return { syncAllBalanceChips, refreshProviderBalance };
}
