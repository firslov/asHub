import type { runSubagent } from "agent-sh";
import { estimateContextTokens } from "../history/context-memory.js";

export type SubagentHistory = NonNullable<Parameters<typeof runSubagent>[0]["history"]>;

// A checkpoint stays in memory for this bridge. Allow long tool transcripts
// while capping both model input and retained images/other large payloads.
const MAX_HISTORY_TOKENS = 64_000;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const omittedHistory = "[Some earlier subagent context was omitted to fit the continuation. Omitted tool output does not imply the tool was never executed. Check the available evidence and current state before repeating an operation.]";
const clearedToolOutput = /^\[earlier tool output cleared to fit the context window \((\d+) chars\); re-run the tool if you need it\]$/;

interface HistoryGroup {
  messages: SubagentHistory;
  tokens: number;
  bytes: number;
}

function group(messages: SubagentHistory): HistoryGroup {
  return { messages, tokens: estimateContextTokens(messages), bytes: Buffer.byteLength(JSON.stringify(messages)) };
}

function continuationMessage(message: SubagentHistory[number]): SubagentHistory[number] {
  if (message.role === "tool" && typeof message.content === "string") {
    const cleared = clearedToolOutput.exec(message.content);
    if (cleared) return { ...message,
      content: `[Earlier tool output was omitted to fit the context window (${cleared[1]} chars). The recorded call was already attempted. Check current state before repeating an operation.]`,
    };
  }
  return message;
}

/** A provider overflow can insert fresh native markers before resending an
 * active continuation. Only canonical compaction markers are rewritten. */
export function sanitizeSubagentCompactionMarkers(messages: SubagentHistory): SubagentHistory {
  let sanitized: SubagentHistory | undefined;
  for (const [index, message] of messages.entries()) {
    const next = continuationMessage(message);
    if (!sanitized && next !== message) sanitized = messages.slice(0, index);
    sanitized?.push(next);
  }
  return sanitized ?? messages;
}

/** Keep the original task and whole completed tool interactions. The kernel's
 * resume input is an immutable snapshot rather than a summary of the prior reply. */
export function retainSubagentHistory(messages: SubagentHistory | undefined, contextWindow?: number): SubagentHistory | undefined {
  const task = messages?.[0];
  if (!messages || task?.role !== "user" || typeof task.content !== "string") return undefined;
  // Leave room for the new prompt, tool definitions and the response.
  const maxTokens = contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.min(MAX_HISTORY_TOKENS, Math.floor(contextWindow * 0.6)) : MAX_HISTORY_TOKENS;
  const taskGroup = group([task]);
  if (taskGroup.tokens > maxTokens || taskGroup.bytes > MAX_HISTORY_BYTES) return undefined;

  const groups: HistoryGroup[] = [];
  for (let index = 1; index < messages.length;) {
    const message = continuationMessage(messages[index++]!);
    if (message.role !== "assistant" && message.role !== "user") return undefined;
    const interaction: SubagentHistory = [message];
    if (message.role === "assistant" && message.tool_calls?.length) {
      const ids = message.tool_calls.map(call => call.id);
      const pending = new Set(ids);
      if (pending.size !== ids.length || ids.some(id => typeof id !== "string" || !id)) return undefined;
      while (messages[index]?.role === "tool") {
        const output = messages[index++];
        if (output?.role !== "tool" || !pending.delete(output.tool_call_id)) return undefined;
        interaction.push(continuationMessage(output));
      }
      if (pending.size) return undefined;
    }
    groups.push(group(interaction));
  }

  const total = groups.reduce((sum, item) => ({ tokens: sum.tokens + item.tokens, bytes: sum.bytes + item.bytes }), {
    tokens: taskGroup.tokens, bytes: taskGroup.bytes,
  });
  if (total.tokens <= maxTokens && total.bytes <= MAX_HISTORY_BYTES) return [task, ...groups.flatMap(item => item.messages)];

  const notice = group([{ role: "user", content: omittedHistory }]);
  let tokens = taskGroup.tokens + notice.tokens, bytes = taskGroup.bytes + notice.bytes;
  const newestFirst = [...groups].reverse();
  // Keep real tool evidence before standalone intermediate commentary when
  // everything cannot fit. Restore chronological order before submission.
  const candidates = [...newestFirst.filter(item => item.messages.length > 1),
    ...newestFirst.filter(item => item.messages.length === 1)];
  const kept = new Set<HistoryGroup>();
  for (const item of candidates) {
    const first = item.messages[0]!;
    if (first.role === "user" && first.content === omittedHistory) continue;
    if (tokens + item.tokens > maxTokens || bytes + item.bytes > MAX_HISTORY_BYTES) continue;
    tokens += item.tokens;
    bytes += item.bytes;
    kept.add(item);
  }
  if (!groups.some(item => kept.has(item) && item.messages[0]?.role === "assistant")) return undefined;
  return [task, ...notice.messages, ...groups.filter(item => kept.has(item)).flatMap(item => item.messages)];
}
