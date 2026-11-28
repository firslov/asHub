import type { AgentMessage } from "./session-store.js";

/** The restore projection keeps one slot per original message. It is never
 * written back to the journal. Ambiguous removals are for restore compatibility
 * only: a live compaction must not infer that those calls have stopped. */
export function projectToolCalls(messages: AgentMessage[]): { messages: AgentMessage[]; ambiguous: Set<number> } {
  const ambiguous = new Set<number>();
  const projected = messages.map((message, i) => {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || !message.tool_calls.length) return message;
    const answered = new Set<string>(), counts = new Map<string, number>();
    // Tool IDs can repeat in another assistant batch (e.g. inline IDs after a
    // restart). Steering may appear between results in this same batch.
    for (let j = i + 1; j < messages.length; j++) {
      const result = messages[j]!;
      if (result.role === "assistant") break;
      if (result.role === "tool" && result.tool_call_id) answered.add(result.tool_call_id);
    }
    for (const call of message.tool_calls) {
      if (call?.id) counts.set(call.id, (counts.get(call.id) ?? 0) + 1);
    }
    const retained = message.tool_calls.filter(call => {
      const id = call?.id;
      if (id && answered.has(id)) return true;
      if (typeof id !== "string" || counts.get(id) !== 1) ambiguous.add(i);
      return false;
    });
    if (retained.length === message.tool_calls.length) return message;
    const copy = { ...message };
    if (retained.length) copy.tool_calls = retained;
    else {
      delete copy.tool_calls;
      if (!copy.content) copy.content = "[interrupted]";
    }
    return copy;
  });
  return { messages: projected, ambiguous };
}
