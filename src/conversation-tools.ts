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
    description: "Read the full user-visible transcript of a collaboration task returned by conversation_send. Prefer conversation_wait for concise delivery results. Optionally wait up to 30 seconds for completion. Read all output using nextOffset while hasMore is true; contexts and tool logs are not copied. Completed means the recipient turn ended, not that its claims have been verified.",
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
  tools.push({
    name: "conversation_wait", readOnly: true, showOutput: true, maxResultBytes: 128000,
    description: "Wait for any of 1–16 collaboration tasks to end (up to 120 seconds). Returns only unseen terminal results with explicitly submitted delivery, never progress logs. Pass the full returned cursors as targets on the next call to avoid repeats. If hasMore is true, continue with these cursors and waitMs:0 to read deferred results. Omit a cursor to reread a result. A timeout returns compact statuses only; settled means all watched results were already delivered. delivery:null means no explicit delivery was submitted; use conversation_task for the original transcript. Completion is not independent verification.",
    input_schema: { type: "object", properties: {
      targets: { type: "array", minItems: 1, maxItems: 16, items: { type: "object", properties: {
        id: { type: "string", description: "Task ID from conversation_send" },
        afterRevision: { type: "integer", minimum: 0, description: "Use the cursor returned for this task" },
        afterState: { type: "string", enum: ["queued", "running", "completed", "failed", "cancelled", "interrupted"], description: "Preserve the returned state cursor across restarts" },
      }, required: ["id"], additionalProperties: false } },
      waitMs: { type: "integer", minimum: 0, maximum: 120000, description: "Default 120000; use 0 for a snapshot" },
    }, required: ["targets"], additionalProperties: false },
    async execute(args, _onChunk, ctx) {
      try {
        ctx?.signal?.throwIfAborted();
        const a = args as { targets: import("./collaboration.js").TaskWatch[]; waitMs?: number };
        return { content: JSON.stringify(await access.waitTasks(a.targets, a.waitMs ?? 120000, ctx?.signal)), exitCode: 0, isError: false };
      } catch (e) { return { content: String(e), exitCode: 1, isError: true }; }
    },
  }, {
    name: "conversation_deliver", readOnly: false, showOutput: true,
    description: "Submit a concise explicit delivery for the collaboration task currently executing in THIS recipient conversation. Use its Task ID from the incoming message. Records the result without sending a new message, waking another model, or marking the turn complete. Include conclusions, artifact references and unresolved issues; references are not fetched or verified. May replace the delivery during this same running task; cannot modify another task or a finished task.",
    input_schema: { type: "object", properties: {
      id: { type: "string", description: "Task ID of the incoming collaboration message" },
      summary: { type: "string", minLength: 1, maxLength: 2000 },
      artifacts: { type: "array", maxItems: 8, items: { type: "object", properties: {
        label: { type: "string", minLength: 1, maxLength: 120 }, path: { type: "string", minLength: 1, maxLength: 1000 },
      }, required: ["label", "path"], additionalProperties: false } },
      unresolved: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 300 } },
    }, required: ["id", "summary", "artifacts", "unresolved"], additionalProperties: false },
    async execute(args, _onChunk, ctx) {
      try {
        ctx?.signal?.throwIfAborted();
        const a = args as unknown as import("./collaboration.js").TaskDelivery & { id: string };
        return { content: JSON.stringify(await access.deliver(a.id, { summary: a.summary, artifacts: a.artifacts, unresolved: a.unresolved }, ctx?.signal)), exitCode: 0, isError: false };
      } catch (e) { return { content: String(e), exitCode: 1, isError: true }; }
    },
  });
  return tools;
}
