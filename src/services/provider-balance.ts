import type { IncomingMessage, ServerResponse } from "node:http";

export interface ProviderBalanceDependencies {
  resolveApiKey(provider: string): { key?: string | null };
  resolveProvider(provider: string): { baseURL?: string } | null | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export type ProviderBalance = Record<string, unknown>;

/** One application's provider credentials, cache and in-flight requests. */
export function createProviderBalanceService(dependencies: ProviderBalanceDependencies) {
  const cache = new Map<string, { data: ProviderBalance; ts: number }>();
  const now = dependencies.now ?? (() => Date.now());
  const fetch: typeof globalThis.fetch = (...args) => (dependencies.fetch ?? globalThis.fetch)(...args);
  let generation = 0;
  let pending = 0;
  let closed = false;
  let closeTask: Promise<void> | undefined;
  let resolveDrain: (() => void) | undefined;
  const cacheTTL = 60_000;
  const lifecycle = new AbortController();

  // Race the actual I/O, including body decoding: injected fetch functions
  // may ignore their signal, and must not hold shutdown or mutate late caches.
  function cancellable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const abort = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      try {
        Promise.resolve(operation()).then(value => {
          cleanup();
          if (signal.aborted) reject(signal.reason);
          else resolve(value);
        }, error => { cleanup(); reject(error); });
      } catch (error) { cleanup(); reject(error); }
    });
  }

  function unavailable(error: unknown): ProviderBalance {
    return { is_available: false, error: error instanceof Error ? error.message : String(error) };
  }

  function invalidate(): void {
    ++generation;
    cache.clear();
  }

  async function fetchBalance(provider: string, signal: AbortSignal): Promise<ProviderBalance> {
    // A credential change while a response is in flight invalidates both
    // successful and failed responses from the previous account.
    while (true) {
      if (signal.aborted) return unavailable(signal.reason);
      const currentGeneration = generation;
      const cached = cache.get(provider);
      if (cached && now() - cached.ts < cacheTTL) return cached.data;
      let body: ProviderBalance;
      try {
        if (provider === "deepseek" || provider === "openrouter") {
          const apiKey = dependencies.resolveApiKey(provider).key ?? "";
          if (!apiKey) body = { is_available: false, error: "no api key" };
          else {
            const baseURL = dependencies.resolveProvider(provider)?.baseURL
              ?? (provider === "deepseek" ? "https://api.deepseek.com" : "https://openrouter.ai/api/v1");
            let balanceURL: string;
            if (provider === "deepseek") {
              try { balanceURL = `${new URL(baseURL).origin}/user/balance`; }
              catch { balanceURL = `${baseURL.replace(/\/+$/, "")}/user/balance`; }
            } else balanceURL = `${baseURL.replace(/\/+$/, "")}/credits`;
            const response = await cancellable(() => fetch(balanceURL, {
              headers: { Authorization: `Bearer ${apiKey}` },
              signal,
            }), signal);
            if (!response.ok) body = { is_available: false, error: `HTTP ${response.status}` };
            else if (provider === "deepseek") body = await cancellable(() => response.json(), signal) as ProviderBalance;
            else {
              const { data } = await cancellable(() => response.json(), signal) as { data?: { total_credits?: number; total_usage?: number } };
              const remaining = (data?.total_credits ?? 0) - (data?.total_usage ?? 0);
              body = { is_available: true, balance_infos: [{ currency: "USD", total_balance: remaining.toFixed(2) }] };
            }
          }
        } else body = { is_available: false };
      } catch (error) {
        body = unavailable(error);
      }
      // Shutdown cancels read-only queries. Do not cache a late result or
      // follow generation invalidations into another network request.
      if (signal.aborted) return unavailable(signal.reason);
      if (currentGeneration !== generation) continue;
      if (body?.is_available !== false || !body?.error) cache.set(provider, { data: body, ts: now() });
      return body;
    }
  }

  async function query(provider: string): Promise<ProviderBalance> {
    if (closed) throw new Error("Provider balance service is closed");
    if (!provider) throw new Error("missing provider");
    ++pending;
    const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(10_000)]);
    try {
      while (true) {
        const currentGeneration = generation;
        const body = await fetchBalance(provider, signal);
        // Cached results also cross an async boundary before reaching callers.
        if (signal.aborted) return unavailable(signal.reason);
        if (currentGeneration !== generation) continue;
        return body;
      }
    } finally { if (--pending === 0) resolveDrain?.(); }
  }

  async function getBalance(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closed) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Provider balance service is closed" }));
      return;
    }
    const provider = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("provider") ?? "";
    if (!provider) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing provider" }));
      return;
    }
    let body: ProviderBalance;
    while (true) {
      const currentGeneration = generation;
      body = await query(provider);
      if (closed) { body = unavailable(lifecycle.signal.reason); break; }
      if (currentGeneration === generation) break;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function close(): Promise<void> {
    if (!closeTask) {
      closed = true;
      lifecycle.abort(new Error("Provider balance service is closed"));
      closeTask = (pending ? new Promise<void>(resolve => { resolveDrain = resolve; }) : Promise.resolve())
        .then(() => { cache.clear(); });
    }
    return closeTask;
  }

  return { query, getBalance, invalidate, close, get pendingCount() { return pending; } };
}

export type ProviderBalanceService = ReturnType<typeof createProviderBalanceService>;
