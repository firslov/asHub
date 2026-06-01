export function stripContextWrappers(text: string): string {
  let out = String(text ?? "");
  for (;;) {
    const next = out.replace(/^\s*<(query_context|dynamic_context)>[\s\S]*?<\/\1>\s*/, "");
    if (next === out) return out;
    out = next;
  }
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === "string") return p;
      const part = p as { text?: string; content?: string };
      return part?.text ?? part?.content ?? "";
    }).join(" ");
  }
  return "";
}

/** Extract image data from multimodal content arrays (user/tool messages). */
export function extractImages(content: unknown): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(content)) return [];
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const part of content) {
    if (typeof part !== "object" || !part) continue;
    const p = part as { type?: string; image_url?: { url?: string } };
    if (p.type === "image_url" && p.image_url?.url) {
      const url = p.image_url.url;
      const m = url.match(/^data:(.+);base64,(.+)$/);
      if (m) images.push({ mimeType: m[1]!, data: m[2]! });
    }
  }
  return images;
}

export function snippet(text: string, max: number): string {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned || "(empty)";
  return cleaned.slice(0, max) + "…";
}

export function summarizeMessage(m: unknown): string {
  const msg = m as { role?: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string } }> };
  const role = msg?.role ?? "?";
  if (role === "assistant" && Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
    const tools = msg.tool_calls.map((tc) => tc?.function?.name ?? "tool").join(", ");
    const text = extractText(msg.content);
    const prefix = text ? `${snippet(text, 60)} → ` : "";
    return `assistant: ${prefix}called ${tools}`;
  }
  if (role === "tool") {
    const text = typeof msg?.content === "string" ? msg.content : extractText(msg?.content);
    return `tool result: ${snippet(text, 80)}`;
  }
  return `${role}: ${snippet(extractText(msg?.content), 100)}`;
}
