import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as wait } from "node:timers/promises";
import { getSettings } from "agent-sh/settings";

const silentRetries = new AsyncLocalStorage<boolean>();
export const withSilentCodexRetries = <T>(run: () => T): T => silentRetries.run(true, run);

export const CODEX_HEADERS_TIMEOUT_MS = 15 * 60_000;
type Options = { signal?: AbortSignal; [key: string]: unknown };
type ClientConfiguration = { baseURL?: string; apiKey?: string; model?: string };
type ProxyError = Error & { type: string; error: { status: number; retryable: boolean; partial?: boolean; retry_after?: string } };
const guarded = new WeakSet<object>();
const endpoints = new Map<string, { registrations: number }>();
const configChanged = (current: ClientConfiguration | undefined, original: ClientConfiguration): boolean =>
  (["baseURL", "apiKey", "model"] as const).some(key => current?.[key] !== original[key]);

/** Identify managed Codex transports even if a broken loopback connection
 * prevents the proxy's structured error from reaching the SDK. */
export function registerCodexEndpoint(baseURL: string | undefined): () => void {
  if (!baseURL) return () => {};
  const endpoint = endpoints.get(baseURL) ?? { registrations: 0 };
  endpoint.registrations++;
  endpoints.set(baseURL, endpoint);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (--endpoint.registrations === 0) endpoints.delete(baseURL);
  };
}

function policy() {
  const raw = (getSettings() as Record<string, any>)["codex-provider"] ?? {};
  const count = (value: unknown, fallback: number, max: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : fallback;
  return { maxRetries: count(raw.maxRetries, 4, 6), headersTimeoutRetries: count(raw.headersTimeoutRetries, 1, 1) };
}

function proxyError(error: unknown): error is ProxyError {
  const e = error as ProxyError | undefined;
  return !!e && e.type === "codex_proxy_error" && Number.isInteger(e.error?.status)
    && e.error.status >= 400 && e.error.status <= 599
    && typeof e.error?.retryable === "boolean";
}

function exhausted(error: ProxyError): Error {
  // This layer owns the Codex budget in both engine loops. A terminal
  // disposition keeps the engine from retrying an exhausted request again.
  return Object.assign(new Error(error.message, { cause: error }), error, {
    error: { ...error.error, retryable: false },
  });
}

function disconnected(error: unknown, partial: boolean): Error {
  const original = error as { message?: string; status?: number } | undefined;
  const status = typeof original?.status === "number" && original.status >= 400 && original.status <= 599
    && Number.isInteger(original.status) ? original.status : 502;
  // The SDK may already have retried a failed loopback connection. Without a
  // proxy verdict, stop here rather than restarting the kernel/subagent run.
  return Object.assign(new Error(original?.message ?? String(error), { cause: error }), error, {
    type: "codex_proxy_error", error: { status, retryable: false, partial },
  });
}

function delayFor(error: ProxyError, attempt: number, deadline: boolean): number {
  const value = error.error.retry_after;
  if (value !== undefined) {
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
    if (Number.isFinite(ms) && ms >= 0 && ms <= 2_147_483_647) return ms;
  }
  return deadline ? 5000 : Math.min(2000 * 2 ** attempt, 30000);
}

/** Retry only a single model request, before any chunks have escaped. Tool
 * execution is outside this boundary, so completed tools are never replayed.
 * Other providers retain the kernel's existing retry behavior. */
export function guardCodexRetries(value: unknown, notify: (message: string) => void, {
  scopedEndpoint = false, sourceClient,
}: { scopedEndpoint?: boolean; sourceClient?: unknown } = {}): void {
  if (!value || typeof value !== "object" || guarded.has(value)) return;
  const client = value as {
    config?: ClientConfiguration;
    stream: (options: Options) => Promise<AsyncIterable<unknown>>;
  };
  if (typeof client.stream !== "function") return;
  const initialBaseURL = client.config?.baseURL ?? "";
  // A child client snapshots credentials at launch. Provider refresh may retire
  // its proxy instead of reconfiguring the child as it does the shared client.
  const initialEndpoint = scopedEndpoint ? endpoints.get(initialBaseURL) : undefined;
  const source = initialEndpoint && sourceClient && typeof sourceClient === "object"
    ? sourceClient as { config?: ClientConfiguration; model?: string } : undefined;
  const sourceConfig = { ...source?.config }, sourceModel = source?.model;
  const original = client.stream;
  client.stream = async function (options) {
    const receiver = this, { maxRetries, headersTimeoutRetries } = policy();
    const requestConfig = { ...receiver.config };
    let codexRequest = !!initialEndpoint || endpoints.has(receiver.config?.baseURL ?? "");
    return (async function* () {
      let deadlineRetries = 0;
      for (let attempt = 0; ; attempt++) {
        options.signal?.throwIfAborted();
        if (initialEndpoint && (receiver.config?.baseURL !== initialBaseURL || endpoints.get(initialBaseURL) !== initialEndpoint)) {
          throw disconnected(new Error("Codex request endpoint was replaced. Send the message again."), false);
        }
        if (source && (configChanged(source.config, sourceConfig) || source.model !== sourceModel)) {
          throw disconnected(new Error("Codex request settings changed. Send the message again."), false);
        }
        // Model selection and provider refresh reconfigure the shared client
        // immediately. Never resend old model parameters to its new endpoint.
        if (codexRequest && configChanged(receiver.config, requestConfig)) {
          throw disconnected(new Error("Codex request settings changed while waiting to retry. Send the message again."), false);
        }
        let emitted = false;
        try {
          const stream = await original.call(receiver, options);
          for await (const chunk of stream) {
            options.signal?.throwIfAborted();
            emitted = true;
            yield chunk;
          }
          return;
        } catch (error) {
          if (options.signal?.aborted) throw error;
          if (!proxyError(error)) {
            if (codexRequest) throw disconnected(error, emitted);
            throw error;
          }
          codexRequest = true;
          const deadline = error.error.status === 504 && error.error.partial === false
            && /^Codex upstream timed out waiting for response headers after [\d.]+s$/.test(error.message);
          if (emitted || error.error.partial === true || attempt >= maxRetries
              || (deadline ? deadlineRetries >= headersTimeoutRetries : !error.error.retryable)) {
            throw exhausted(error);
          }
          if (deadline) deadlineRetries++;
          const ms = delayFor(error, attempt, deadline);
          const reason = error.error.status === 429 ? "rate limited" : `error ${error.error.status}`;
          if (!silentRetries.getStore()) notify(`(${reason}, retrying in ${Math.ceil(ms / 1000)}s — attempt ${attempt + 2}/${maxRetries + 1})`);
          await wait(ms, undefined, { signal: options.signal });
        }
      }
    })();
  };
  guarded.add(value);
}
