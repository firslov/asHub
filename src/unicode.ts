/** Match only unpaired UTF-16 surrogates; /u leaves valid emoji pairs intact. */
export function wellFormedText(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}

/** Like slice(), but move boundaries inward rather than splitting a code point. */
export function unicodeSlice(text: string, start = 0, end = text.length): string {
  const index = (n: number) => {
    n = Math.trunc(n) || 0;
    return n < 0 ? Math.max(text.length + n, 0) : Math.min(n, text.length);
  };
  const splitsPair = (i: number) => i > 0 && i < text.length
    && text.charCodeAt(i - 1) >= 0xD800 && text.charCodeAt(i - 1) <= 0xDBFF
    && text.charCodeAt(i) >= 0xDC00 && text.charCodeAt(i) <= 0xDFFF;
  let from = index(start), to = index(end);
  if (splitsPair(from)) from++;
  if (splitsPair(to)) to--;
  return text.slice(from, Math.max(from, to));
}

/** Keep opening context and trailing termination notes within the original budgets. */
export function clipHeadTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  const first = unicodeSlice(text, 0, head);
  const last = tail > 0 ? unicodeSlice(text, -tail) : "";
  return `${first}\n[... ${text.length - first.length - last.length} chars truncated ...]\n${last}`;
}

/** Copy JSON data without editing stored history. Transport objects (AbortSignal,
 * Headers instances, buffers, etc.) keep their identity and behavior. */
export function wellFormedJson<T>(input: T): T {
  const seen = new WeakMap<object, unknown>();
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return wellFormedText(value);
    if (value === null || typeof value !== "object") return value;
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== null && Object.getPrototypeOf(proto) !== null) return value;
    if (seen.has(value)) return seen.get(value);
    const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? new Array(value.length) : Object.create(proto);
    seen.set(value, copy);
    for (const key of Object.keys(value)) {
      const cleanKey = wellFormedText(key);
      if (Object.hasOwn(copy, cleanKey)) throw new Error("Invalid Unicode creates duplicate JSON keys");
      Object.defineProperty(copy, cleanKey, {
        value: visit((value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true,
      });
    }
    return copy;
  };
  return visit(input) as T;
}

type RequestClient = {
  stream: (options: Record<string, unknown>) => unknown;
  complete: (options: Record<string, unknown>) => unknown;
};
const guardedClients = new WeakSet<object>();

/** Wrap the shared client instance, not a getter: the main loop holds this same
 * instance, while subagents and llm:invoke bypass conversation:prepare. */
export function guardLlmUnicode(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const client = value as RequestClient;
  if (typeof client.stream !== "function" || typeof client.complete !== "function" || guardedClients.has(client)) return;
  const stream = client.stream, complete = client.complete;
  client.stream = function (options) { return stream.call(this, wellFormedJson(options)); };
  client.complete = function (options) { return complete.call(this, wellFormedJson(options)); };
  guardedClients.add(client);
}
