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
export function usageObserver(onUsage: (usage: CodexUsage) => void) {
  const decoder = new TextDecoder();
  let buffer = "", disabled = false;
  const consume = (block: string) => {
    try {
      const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") return;
      const event = JSON.parse(data);
      if (["response.completed", "response.done", "response.incomplete"].includes(event.type)
          && event.response?.usage && typeof event.response.usage === "object") {
        onUsage(usageCounters(event.response.usage));
      }
    } catch { /* Malformed diagnostics must not affect the provider stream. */ }
  };
  return (bytes?: Uint8Array) => {
    if (disabled) return;
    buffer += bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode();
    // Large final responses can contain the full output. Bound temporary memory.
    if (buffer.length > 4 * 1024 * 1024) { buffer = ""; disabled = true; return; }
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      consume(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
    }
    if (!bytes && buffer) { consume(buffer); buffer = ""; }
  };
}

type Observer = { url: string; sessionId: string; receive: (usage: CodexUsage) => void };
const observers = new Set<Observer>();
let restoreFetch: (() => void) | undefined;

/** Scoped to a registered Codex endpoint AND its exact session header. Other
 * providers, OAuth, subagents and completions without that header pass through. */
export function observeCodexUsage(url: string, sessionId: string, receive: Observer["receive"]): () => void {
  const observer: Observer = { url: new URL(url).href, sessionId, receive };
  observers.add(observer);
  if (!restoreFetch) {
    const original = globalThis.fetch;
    const wrapped: typeof fetch = async (input, init) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const matches = [...observers].filter(o => o.url === requestUrl && headers.get("session_id") === o.sessionId);
      const response = await original(input, init);
      if (!matches.length || !response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
      const inspect = usageObserver(usage => {
        for (const o of matches) if (observers.has(o)) o.receive(usage);
      });
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) { inspect(chunk); controller.enqueue(chunk); },
        flush() { inspect(); },
      }));
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
