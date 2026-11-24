/** A tool-free call on the already configured client. stream() is used because
 * kernel complete() does not forward an AbortSignal to its transport. */
export interface SummaryClient {
  stream(opts: Record<string, unknown>): PromiseLike<AsyncIterable<{
    choices?: Array<{ delta?: { content?: string | null; tool_calls?: unknown[] }; finish_reason?: string | null }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  }> & { controller?: AbortController }>;
}

export interface SummaryUsage {
  inputTokens: number;
  outputTokens: number;
}

export async function generateSummary(
  client: SummaryClient,
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal,
  options: { model?: string; headers?: Record<string, string>; params?: Record<string, unknown>; timeoutMs?: number; maxTokens?: number; onUsage?: (usage: SummaryUsage) => void } = {},
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
      max_tokens: options.maxTokens ?? 8192, signal: controller.signal, ...(options.headers ? { headers: options.headers } : {}) });
    let text = "", finished = false, incomplete = false;
    let usage: SummaryUsage | undefined;
    try {
      controller.signal.throwIfAborted();
      for await (const chunk of stream) {
        controller.signal.throwIfAborted();
        if (options.onUsage && chunk.usage) {
          const { prompt_tokens: inputTokens, completion_tokens: outputTokens } = chunk.usage;
          if (typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) && inputTokens >= 0
            && typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens >= 0) {
            usage = { inputTokens, outputTokens };
          }
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.tool_calls?.length) throw new Error("Unexpected tool call in summary");
        text += choice?.delta?.content ?? "";
        if (text.length > 24000) throw new Error("Summary exceeds output budget");
        if (choice?.finish_reason) {
          if (choice.finish_reason === "stop") finished = true;
          else {
            // Streaming providers can report billable usage after truncation.
            // Allow the terminal usage frame without accepting partial output.
            if (!options.onUsage || !["length", "content_filter"].includes(choice.finish_reason)) throw new Error("Incomplete summary");
            incomplete = true;
          }
        }
      }
      if (incomplete) throw new Error("Incomplete summary");
      if (!finished || !text.trim()) throw new Error("Incomplete summary stream");
      return text;
    } finally {
      stream.controller?.abort();
      if (usage && !controller.signal.aborted) options.onUsage?.(usage);
    }
  };
  try { return await Promise.race([run(), aborted]); }
  finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
