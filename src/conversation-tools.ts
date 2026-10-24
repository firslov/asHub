import type { ConversationAccess } from "./bridges/types.js";
import type { ToolDefinition } from "agent-sh";

export function conversationTools(access: ConversationAccess): ToolDefinition[] {
  const tools: ToolDefinition[] = ["list", "read", "send"].map(action => ({
    name: `conversation_${action}`,
    description: action === "list" ? "List available conversations in this conversation's project. Contexts remain independent."
      : action === "read" ? "Read recent user/assistant text from another conversation in the same project. Tool logs and attachments are omitted; long messages are truncated."
      : "Send a message to another conversation in the same project within the user's authorized task. Starts or queues a turn; returns acceptance, not the result. Never automatically reply to received messages.",
    readOnly: action !== "send",
    input_schema: {
      type: "object", properties: action === "list" ? {} : {
        id: { type: "string", description: "Exact conversation ID from conversation_list" },
        ...(action === "read" ? { limit: { type: "integer", minimum: 1, maximum: 40, description: "Recent messages; default 10" } } : { message: { type: "string", maxLength: 8000 } }),
      }, required: action === "list" ? [] : action === "read" ? ["id"] : ["id", "message"],
    },
    async execute(args, _onChunk, ctx) {
      try {
        if (ctx?.signal?.aborted) throw new Error("Cancelled");
        const a = args as { id: string; limit?: number; message: string };
        const result = action === "list" ? access.list() : action === "read" ? await access.read(a.id, a.limit ?? 10, ctx?.signal) : await access.send(a.id, a.message, ctx?.signal);
        return { content: JSON.stringify(result), exitCode: 0, isError: false };
      } catch (e) { return { content: String(e), exitCode: 1, isError: true }; }
    },
  }));
  tools.push({
    name: "conversation_task", readOnly: true,
    description: "Check a collaboration task returned by conversation_send. Optionally wait up to 30 seconds for completion. Read all output using nextOffset while hasMore is true; contexts and tool logs are not copied. Completed means the recipient turn ended, not that its claims have been verified.",
    input_schema: { type: "object", properties: {
      id: { type: "string", description: "Task ID from conversation_send" },
      offset: { type: "integer", minimum: 0, description: "Result character offset; use returned nextOffset" },
      waitMs: { type: "integer", minimum: 0, maximum: 30000, description: "Wait for completion; default 0" },
    }, required: ["id"] },
    async execute(args, _onChunk, ctx) {
      try {
        const a = args as { id: string; offset?: number; waitMs?: number };
        ctx?.signal?.throwIfAborted();
        return { content: JSON.stringify(await access.task(a.id, a.offset ?? 0, a.waitMs ?? 0, ctx?.signal)), exitCode: 0, isError: false };
      } catch (e) { return { content: String(e), exitCode: 1, isError: true }; }
    },
  });
  return tools;
}
