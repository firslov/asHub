import { setTimeout as wait } from "node:timers/promises";
import { getSettings } from "agent-sh/settings";

export const CODEX_HEADERS_TIMEOUT_MS = 15 * 60_000;
type Options = { signal?: AbortSignal; [key: string]: unknown };
type ProxyError = Error & { type: string; error: { status: number; retryable: boolean; partial?: boolean; retry_after?: string } };
const guarded = new WeakSet<object>();
const endpoints = new Map<string, number>();

/** Identify managed Codex transports even if a broken loopback connection
 * prevents the proxy's structured error from reaching the SDK. */
export function registerCodexEndpoint(baseURL: string | undefined): () => void {
  if (!baseURL) return () => {};
  endpoints.set(baseURL, (endpoints.get(baseURL) ?? 0) + 1);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const remaining = (endpoints.get(baseURL) ?? 1) - 1;
    if (remaining) endpoints.set(baseURL, remaining);
    else endpoints.delete(baseURL);
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
    && typeof e.error?.retryable === "boolean";
}

function exhausted(error: ProxyError): Error {
  // The kernel and subagent each have an outer retry loop. This layer owns the
  // Codex budget; never multiply it by replaying an exhausted request/run.
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
export function guardCodexRetries(value: unknown, notify: (message: string) => void): void {
  if (!value || typeof value !== "object" || guarded.has(value)) return;
  const client = value as {
    config?: { baseURL?: string; apiKey?: string; model?: string };
    stream: (options: Options) => Promise<AsyncIterable<unknown>>;
  };
  if (typeof client.stream !== "function") return;
  const original = client.stream;
  client.stream = async function (options) {
    const receiver = this, { maxRetries, headersTimeoutRetries } = policy();
    const requestConfig = { ...receiver.config };
    let codexRequest = endpoints.has(receiver.config?.baseURL ?? "");
    return (async function* () {
      let deadlineRetries = 0;
      for (let attempt = 0; ; attempt++) {
        options.signal?.throwIfAborted();
        // Model selection and provider refresh reconfigure the shared client
        // immediately. Never resend old model parameters to its new endpoint.
        if (codexRequest && (["baseURL", "apiKey", "model"] as const)
          .some(key => receiver.config?.[key] !== requestConfig[key])) {
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
          notify(`(${reason}, retrying in ${Math.ceil(ms / 1000)}s — attempt ${attempt + 2}/${maxRetries + 1})`);
          await wait(ms, undefined, { signal: options.signal });
        }
      }
    })();
  };
  guarded.add(value);
}
