import { signal } from '../vendor/signals-core.js';
export const networkPolicy = signal(null);
let revision = 0;
let writes = Promise.resolve();
const validPolicy = policy => typeof policy?.proxyEnabled === 'boolean'
  && policy.sessions && typeof policy.sessions === 'object' && !Array.isArray(policy.sessions);
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('ashub-network') : null;
export async function loadNetworkPolicy() {
  const seq = ++revision;
  try {
    const r = await fetch('/api/settings/network', { cache: 'no-store' });
    if (!r.ok) return;
    const policy = await r.json();
    if (!validPolicy(policy)) return;
    if (seq === revision) networkPolicy.value = policy;
  } catch {}
}
export function saveNetworkPolicy(enabled, session) {
  // Serialize writes from the settings panel and conversation controls. An older
  // full-policy response must never overwrite a later edit in this window.
  const saved = writes.then(async () => {
    ++revision;
    const r = await fetch('/api/settings/network', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled, session }),
    });
    if (!r.ok) throw Error(`HTTP ${r.status}`);
    const policy = await r.json();
    if (!validPolicy(policy)) throw Error('Invalid network settings response');
    ++revision; // Invalidate reads started before this write was acknowledged.
    networkPolicy.value = policy;
    channel?.postMessage('changed');
    // A failed refresh must not undo or delay an already confirmed save.
    void loadNetworkPolicy();
  });
  writes = saved.catch(() => {});
  return saved;
}

if (channel) channel.onmessage = () => { void loadNetworkPolicy(); };
window.addEventListener?.('focus', () => { void loadNetworkPolicy(); });
void loadNetworkPolicy();
