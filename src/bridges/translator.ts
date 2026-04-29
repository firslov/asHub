/**
 * Translate ACP `session/update` notifications into the bus-shaped events
 * that the web UI already understands. Used only by AcpBridge — the
 * in-process AshBridge forwards bus events directly without translation.
 */

import type { BusEvent } from "./types.js";

/**
 * One translator per session. Holds tool-call state across the
 * tool_call → tool_call_update lifecycle so the bus shape lines up
 * (started carries kind/title, completed carries exitCode/resultDisplay).
 */
export class Translator {
  private toolMeta = new Map<string, { kind?: string; title?: string }>();

  translateUpdate(update: Record<string, unknown>): BusEvent[] {
    const kind = update.sessionUpdate as string;
    switch (kind) {
      case "agent_message_chunk": {
        const text = (update.content as { text?: string })?.text ?? "";
        if (!text) return [];
        return [{
          name: "agent:response-chunk",
          payload: { blocks: [{ type: "text", text }] },
        }];
      }
      case "agent_thought_chunk": {
        const text = (update.content as { text?: string })?.text ?? "";
        if (!text) return [];
        return [{ name: "agent:thinking-chunk", payload: { text } }];
      }
      case "tool_call": {
        const id = update.toolCallId as string;
        const title = (update.title as string) ?? "tool";
        const k = (update.kind as string) ?? "tool";
        this.toolMeta.set(id, { kind: k, title });
        return [{
          name: "agent:tool-started",
          payload: {
            toolCallId: id,
            title,
            kind: k,
            icon: iconForKind(k),
            rawInput: update.rawInput,
            displayDetail: undefined,
            locations: undefined,
          },
        }];
      }
      case "tool_call_update": {
        const id = update.toolCallId as string;
        const status = update.status as string | undefined;
        if (status !== "completed" && status !== "failed") return [];
        const meta = this.toolMeta.get(id) ?? {};
        this.toolMeta.delete(id);
        const exitCode = status === "completed" ? 0 : 1;
        const content = update.content as Array<Record<string, unknown>> | undefined;
        const resultDisplay = bodyFromContent(content);
        return [{
          name: "agent:tool-completed",
          payload: {
            toolCallId: id,
            exitCode,
            kind: meta.kind,
            resultDisplay,
          },
        }];
      }
      case "usage_update": {
        return [{
          name: "agent:usage",
          payload: {
            prompt_tokens: (update.inputTokens as number) ?? 0,
            completion_tokens: (update.outputTokens as number) ?? 0,
            total_tokens:
              ((update.inputTokens as number) ?? 0) +
              ((update.outputTokens as number) ?? 0),
          },
        }];
      }
      default:
        return [];
    }
  }
}

function iconForKind(kind: string): string {
  switch (kind) {
    case "read": return "◆";
    case "search": return "⌕";
    case "execute": return "▶";
    case "edit":
    case "diff":
    case "write": return "✎";
    default: return "·";
  }
}

function bodyFromContent(content: Array<Record<string, unknown>> | undefined):
  | { summary?: string; body?: { kind: "diff"; diff: unknown; filePath: string } | { kind: "lines"; lines: string[] } }
  | undefined
{
  if (!Array.isArray(content) || content.length === 0) return undefined;
  for (const c of content) {
    if (c.type === "diff" && typeof c.path === "string") {
      const oldText = String(c.oldText ?? "");
      const newText = String(c.newText ?? "");
      return {
        body: { kind: "diff", diff: simpleDiff(oldText, newText), filePath: c.path },
      };
    }
    if (c.type === "text" && typeof c.text === "string") {
      const lines = c.text.split("\n").filter(Boolean);
      if (lines.length > 0) {
        return { body: { kind: "lines", lines } };
      }
    }
  }
  return undefined;
}

/**
 * Crude block-replace diff: marks all of oldText as removed and all of
 * newText as added, no LCS. Replace with a real line-level diff later.
 */
function simpleDiff(oldText: string, newText: string) {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  const lines: Array<{ type: "context" | "added" | "removed"; oldNo: number | null; newNo: number | null; text: string }> = [];
  oldLines.forEach((t, i) => lines.push({ type: "removed", oldNo: i + 1, newNo: null, text: t }));
  newLines.forEach((t, i) => lines.push({ type: "added", oldNo: null, newNo: i + 1, text: t }));
  return {
    hunks: [{ lines }],
    added: newLines.length,
    removed: oldLines.length,
    isIdentical: oldText === newText,
    isNewFile: oldLines.length === 0,
  };
}
