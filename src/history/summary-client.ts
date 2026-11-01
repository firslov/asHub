/** A tool-free call on the already configured client. stream() is used because
 * kernel complete() does not forward an AbortSignal to its transport. */
export interface SummaryClient {
  stream(opts: Record<string, unknown>): PromiseLike<AsyncIterable<{
    choices?: Array<{ delta?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }>;
  }> & { controller?: AbortController }>;
}

export async function generateSummary(
  client: SummaryClient,
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal,
  options: { model?: string; headers?: Record<string, string>; params?: Record<string, unknown>; timeoutMs?: number } = {},
): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("Summary deadline exceeded")), options.timeoutMs ?? 90000);
  let rejectAbort: ((error: unknown) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort?.(controller.signal.reason ?? new Error("Summary cancelled"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (controller.signal.aborted) onAbort();
  const run = async () => {
    controller.signal.throwIfAborted();
    const stream = await client.stream({ ...options.params, messages, model: options.model,
      max_tokens: 8192, signal: controller.signal, ...(options.headers ? { headers: options.headers } : {}) });
    let text = "", finished = false;
    try {
      for await (const chunk of stream) {
        controller.signal.throwIfAborted();
        const choice = chunk.choices?.[0];
        if (choice?.delta?.tool_calls?.length) throw new Error("Unexpected tool call in summary");
        text += choice?.delta?.content ?? "";
        if (text.length > 24000) throw new Error("Summary exceeds output budget");
        if (choice?.finish_reason) {
          if (choice.finish_reason !== "stop") throw new Error("Incomplete summary");
          finished = true;
        }
      }
      if (!finished || !text.trim()) throw new Error("Incomplete summary stream");
      return text;
    } finally { stream.controller?.abort(); }
  };
  try { return await Promise.race([run(), aborted]); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
