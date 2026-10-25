import { randomUUID } from "node:crypto";
import { requestFailure, type RequestDiagnostic } from "../request-diagnostics.js";

/** Preserve usage before agent-sh 0.16's translator defaults missing cache counts
 * to zero. The observer forwards response bytes unchanged and only retains a
 * whitelist of numeric usage fields, never prompts, headers or credentials. */
export interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

const count = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
export function usageCounters(value: any): CodexUsage {
  const out: CodexUsage = {};
  for (const key of ["input_tokens", "output_tokens", "total_tokens"] as const) {
    if (count(value?.[key])) out[key] = value[key];
  }
  for (const key of ["cached_tokens", "cache_write_tokens"] as const) {
    if (count(value?.input_tokens_details?.[key])) {
      (out.input_tokens_details ??= {})[key] = value.input_tokens_details[key];
    }
  }
  if (count(value?.output_tokens_details?.reasoning_tokens)) {
    out.output_tokens_details = { reasoning_tokens: value.output_tokens_details.reasoning_tokens };
  }
  return out;
}

/** A bounded, observational SSE parser; parse failures never interrupt output. */
export function usageObserver(onUsage: (usage: CodexUsage) => void, onTerminal?: (failed: boolean) => void, onLimit?: () => void) {
  const decoder = new TextDecoder();
  const limit = 4 * 1024 * 1024;
  let buffer = "", skipping = false;
  const consume = (block: string) => {
    try {
      const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart()).join("\n");
      // The upstream Codex protocol requires an explicit response terminal
      // event. A bare [DONE] is ignored by the kernel and cannot prove success.
      if (!data || data === "[DONE]") return;
      const event = JSON.parse(data);
      if (["response.completed", "response.done", "response.incomplete"].includes(event.type)
          && event.response?.usage && typeof event.response.usage === "object") {
        onUsage(usageCounters(event.response.usage));
      }
      if (["response.completed", "response.done", "response.incomplete", "response.failed", "error"].includes(event.type)) {
        onTerminal?.(["response.failed", "error"].includes(event.type));
      }
    } catch { /* Malformed diagnostics must not affect the provider stream. */ }
  };
  const skip = () => { skipping = true; try { onLimit?.(); } catch {} };
  const feed = (text: string) => {
    buffer += text;
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      if (!skipping) {
        if (boundary.index <= limit) consume(buffer.slice(0, boundary.index));
        else skip();
      }
      buffer = buffer.slice(boundary.index + boundary[0].length);
      skipping = false;
    }
    // Bound each event, not a fetch chunk containing many small events. Keep
    // enough delimiter overlap to resume after an oversized event, even when
    // CRLF is split across reads. Never disable observation of later events.
    if (!skipping && buffer.length > limit + 3) skip();
    if (skipping) buffer = buffer.slice(-3);
  };
  return (bytes?: Uint8Array) => {
    if (bytes) {
      // A single fetch chunk can itself be large; bound decoded scratch space.
      for (let i = 0; i < bytes.length; i += 65536) feed(decoder.decode(bytes.subarray(i, i + 65536), { stream: true }));
    } else {
      feed(decoder.decode());
      if (!skipping && buffer) {
        if (buffer.length <= limit) consume(buffer);
        else skip();
      }
      buffer = "";
    }
  };
}

type Observer = { url: string; sessionId: string; receive: (usage: CodexUsage) => void; request?: (event: RequestDiagnostic) => void };
const observers = new Set<Observer>();
let restoreFetch: (() => void) | undefined;

/** Scoped to a registered Codex endpoint AND its exact session header. Other
 * providers, OAuth, subagents and completions without that header pass through. */
export function observeCodexUsage(url: string, sessionId: string, receive: Observer["receive"], request?: Observer["request"]): () => void {
  const observer: Observer = { url: new URL(url).href, sessionId, receive, request };
  observers.add(observer);
  if (!restoreFetch) {
    const original = globalThis.fetch;
    const wrapped: typeof fetch = async (input, init) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const matches = [...observers].filter(o => o.url === requestUrl && headers.get("session_id") === o.sessionId);
      if (!matches.length) return original(input, init);
      const requestId = randomUUID(), started = Date.now();
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      // The kernel sends a JSON string. Never consume or clone a Request body
      // just to measure it; unknown body sizes remain unknown.
      const requestBytes = typeof init?.body === "string" ? new TextEncoder().encode(init.body).byteLength : undefined;
      let responseBytes = 0, settled = false;
      const notify = (phase: RequestDiagnostic["phase"], extra: Partial<RequestDiagnostic> = {}) => {
        const event = { requestId, phase, requestBytes, responseBytes, elapsedMs: Date.now() - started, ...extra };
        for (const o of matches) if (observers.has(o)) { try { o.request?.(event); } catch {} }
      };
      const finish = (phase: "complete" | "error" | "cancelled" | "unobserved", extra: Partial<RequestDiagnostic> = {}) => {
        if (settled) return;
        settled = true;
        notify(phase, extra);
      };
      const fail = (error: unknown) => {
        const { phase, ...details } = requestFailure(error, signal);
        finish(phase, details);
      };
      notify("request");
      let response: Response;
      try { response = await original(input, init); }
      catch (err) {
        fail(err);
        throw err;
      }
      notify("headers", { status: response.status });
      if (!response.ok || !response.body) {
        finish("error", { status: response.status, code: response.ok ? "STREAM_ENDED" : "HTTP_ERROR" });
        return response;
      }
      // The kernel always requests a Codex event stream, including for local
      // completions. Inspect its events regardless of gateway MIME headers;
      // a 200 response alone (e.g. an HTML error page) is not completion.
      let limited = false;
      const inspect = usageObserver(usage => {
        for (const o of matches) if (observers.has(o)) { try { o.receive(usage); } catch {} }
      }, failed => finish(failed ? "error" : "complete", failed ? { code: "UPSTREAM_ERROR" } : {}), () => { limited = true; });
      const reader = response.body.getReader();
      let first = true, cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { value, done } = await reader.read();
            if (cancelled) return;
            if (done) {
              inspect();
              if (signal?.aborted) fail(signal.reason);
              else if (limited) finish("unobserved", { code: "OBSERVATION_LIMIT" });
              else finish("error", { code: "STREAM_ENDED" });
              controller.close();
              reader.releaseLock();
              return;
            }
            responseBytes += value.byteLength;
            if (first) { first = false; notify("streaming"); }
            inspect(value);
            controller.enqueue(value);
          } catch (err) {
            fail(err);
            if (!cancelled) controller.error(err);
            reader.releaseLock();
          }
        },
        async cancel(reason) {
          cancelled = true;
          if (signal?.aborted) fail(signal.reason);
          // The kernel cancels upstream after reading a terminal event. If
          // that event exceeded our diagnostic budget, its outcome is unknown.
          else if (limited) finish("unobserved", { code: "OBSERVATION_LIMIT" });
          else finish("cancelled");
          try { await reader.cancel(reason); } finally { reader.releaseLock(); }
        },
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    globalThis.fetch = wrapped;
    restoreFetch = () => { if (globalThis.fetch === wrapped) globalThis.fetch = original; };
  }
  return () => {
    observers.delete(observer);
    if (!observers.size) { restoreFetch?.(); restoreFetch = undefined; }
  };
}
