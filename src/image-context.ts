import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Fresh images have priority in this budget; they are never removed, even
// when they exceed it. Only repeated history images may become references.
export const HISTORY_IMAGE_BYTES = 2 * 1024 * 1024;
const extensions: Record<string, string> = { png: "png", jpeg: "jpg", webp: "webp", gif: "gif" };
type Message = { role?: string; content?: unknown; [key: string]: unknown };
type Options = { messages?: Message[]; [key: string]: unknown };

/** Keep a lossless local reference before removing an old inline image from a
 * request. Use the existing session upload lifecycle (including deletion). */
export function imageContext(options: Options, uploads: string, sessionId: string, budget = HISTORY_IMAGE_BYTES): Options {
  if (!Array.isArray(options.messages) || !/^[\w-]+$/.test(sessionId)) return options;
  // A reference is only useful if this request can actually read it. Text-only
  // compaction/completion calls and restricted subagents keep their input.
  if (!Array.isArray(options.tools) || !options.tools.some(t => t?.function?.name === "read_file")) return options;
  const messages = options.messages;
  let lastAssistant = -1, lastUser = -1;
  messages.forEach((m, i) => { if (m.role === "assistant") lastAssistant = i; if (m.role === "user") lastUser = i; });
  const replacements = new Map<number, unknown[]>();
  let remaining = Math.max(0, budget);
  // Do not add a full history allowance on top of a large fresh image batch.
  // Keep all new images lossless and let older images be read back as needed.
  messages.forEach((message, i) => {
    if (!Array.isArray(message.content) || (i <= lastAssistant && i !== lastUser && ['user', 'tool'].includes(message.role ?? ''))) return;
    for (const part of message.content) {
      const url = typeof part?.image_url === 'string' ? part.image_url : part?.image_url?.url;
      if (part?.type === 'image_url' && typeof url === 'string' && url.startsWith('data:image/')) remaining = Math.max(0, remaining - url.length);
    }
  });
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    // Never discard unseen tool results, the current user's attachments, or
    // system/developer input. A later read_file result is fresh again.
    if (i > lastAssistant || i === lastUser || !["user", "tool"].includes(message.role ?? "") || !Array.isArray(message.content)) continue;
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j];
      if (part?.type !== "image_url") continue;
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url !== "string") continue;
      const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
      if (!match || match[2]!.length % 4) continue;
      if (url.length <= remaining) { remaining -= url.length; continue; }
      try {
        const bytes = Buffer.from(match[2]!, "base64");
        // read_file supports up to 5 MiB. Unsupported data stays in the request.
        if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString("base64") !== match[2]) continue;
        const digest = createHash("sha256").update(bytes).digest("hex");
        const file = path.join(uploads, `${sessionId}_context_${digest}.${extensions[match[1]!]}`);
        fs.mkdirSync(uploads, { recursive: true, mode: 0o700 });
        try { fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 }); }
        catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          // A missing, replaced or corrupt reference must never lose context.
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.size !== bytes.length || !fs.readFileSync(file).equals(bytes)) continue;
        }
        const content = replacements.get(i) ?? [...message.content];
        content[j] = { type: "text", text: `[Historical image preserved at ${JSON.stringify(file)}. To inspect it again, use read_file with this path and offset=1. Only the repeated inline image was omitted from this request.]` };
        replacements.set(i, content);
      } catch { /* Storage failures preserve the original image, not a broken reference. */ }
    }
  }
  if (!replacements.size) return options;
  return { ...options, messages: messages.map((m, i) => replacements.has(i) ? { ...m, content: replacements.get(i) } : m) };
}

const guarded = new WeakSet<object>();
/** The shared client also covers subagents and llm:invoke, which bypass the
 * main loop's conversation:prepare hook. Preserve stream/complete contracts. */
export function guardImageContext(value: unknown, uploads: string, sessionId: string): void {
  if (!value || typeof value !== "object" || guarded.has(value)) return;
  const client = value as { stream: (o: Options) => unknown; complete: (o: Options) => unknown };
  if (typeof client.stream !== "function" || typeof client.complete !== "function") return;
  for (const method of ["stream", "complete"] as const) {
    const original = client[method];
    client[method] = function (options) { return original.call(this, imageContext(options, uploads, sessionId)); };
  }
  guarded.add(value);
}
