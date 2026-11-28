import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { CollaborationTurn } from "../../bridges/types.js";

export const TASK_MCP_PORT = "ASHUB_TASK_MCP_PORT";
export const TASK_MCP_TOKEN = "ASHUB_TASK_MCP_TOKEN";
export const TASK_MCP_PATH = "/task";
export const MAX_CALL_BYTES = 128 * 1024;
export const MAX_REPLY_BYTES = 512 * 1024;

// Use the same shapes for tool discovery and gateway validation.
type Schema =
  | { type: "string"; minLength: number; maxLength: number; pattern?: string }
  | { type: "array"; maxItems: number; items: Schema }
  | { type: "object"; properties: Record<string, Schema>; required: string[]; additionalProperties: false };
const text = (maxLength: number): Schema => ({ type: "string", minLength: 1, maxLength });
const list = (items: Schema): Schema => ({ type: "array", maxItems: 8, items });
const object = (properties: Record<string, Schema>): Schema => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
export const taskMcpTools = [
  { name: "get_task", description: "Read only the explicitly supplied inline materials for the active collaboration task.", inputSchema: object({}) },
  { name: "deliver", description: "Record delivery for the taskId returned by get_task. Artifact paths are references only; this tool does not open files.", inputSchema: object({
    taskId: text(64), summary: text(2000), artifacts: list(object({ label: text(120), path: text(1000) })), unresolved: list(text(300)),
  }) },
  { name: "report_blocked", description: "Notify the coordinator of a decision needed on the taskId returned by get_task. Reuse the same requestKey for the same blocker.", inputSchema: object({
    taskId: text(64), requestKey: { type: "string", minLength: 8, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" },
    question: text(600), evidence: text(600), recommendation: text(400),
  }) },
] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matches(value: unknown, schema: Schema): boolean {
  switch (schema.type) {
    case "string": return typeof value === "string" && value.length >= schema.minLength && value.length <= schema.maxLength
      && (!schema.pattern || new RegExp(schema.pattern).exec(value)?.[0] === value);
    case "array": return Array.isArray(value) && value.length <= schema.maxItems && value.every(item => matches(item, schema.items));
    case "object": return isRecord(value) && Object.keys(value).length === schema.required.length
      && schema.required.every(key => Object.hasOwn(value, key) && matches(value[key], schema.properties[key]));
  }
}

function reply(res: ServerResponse, status: number, body: object): void {
  if (res.destroyed || res.writableEnded) return;
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Connection": "close", "Cache-Control": "no-store" });
  res.end(json);
}

export async function createTaskMcp(): Promise<{
  server: { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
  run<T>(turn: CollaborationTurn, fn: () => Promise<T>): Promise<T>;
  close(): void;
}> {
  const token = randomBytes(32).toString("hex");
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  let closed = false;
  let active: { turn: CollaborationTurn; scope: AbortController } | undefined;
  const gateway = createServer({ maxHeaderSize: 4096, requestTimeout: 5_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000 }, (req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      reply(res, 401, { error: "Unauthorized" });
      return;
    }
    if (req.method !== "POST" || req.url !== TASK_MCP_PATH || req.headers["content-type"] !== "application/json") {
      reply(res, 400, { error: "Invalid request" });
      return;
    }
    const length = Number(req.headers["content-length"]);
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_CALL_BYTES || req.headers["transfer-encoding"]) {
      reply(res, 400, { error: "Invalid request size" });
      return;
    }
    // Capture the lease before reading the body: a request must never carry over to the next turn.
    const lease = active;
    const inactive = () => reply(res, 409, { error: "No active task" });
    if (!lease || lease.scope.signal.aborted) { inactive(); return; }
    const { turn, scope } = lease;
    scope.signal.addEventListener("abort", inactive, { once: true });
    res.once("close", () => scope.signal.removeEventListener("abort", inactive));
    const usable = () => active === lease && !scope.signal.aborted && !res.destroyed && !res.writableEnded;

    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        if (!usable()) return;
        let call: unknown;
        try { call = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { reply(res, 400, { error: "Invalid JSON" }); return; }
        const tool = isRecord(call) && Object.keys(call).length === 2 && Object.hasOwn(call, "name") && Object.hasOwn(call, "arguments")
          ? taskMcpTools.find(t => t.name === call.name) : undefined;
        if (!tool || !isRecord(call) || !matches(call.arguments, tool.inputSchema)) {
          reply(res, 400, { error: "Invalid tool or arguments" });
          return;
        }
        const args = call.arguments;
        if (tool.name === "get_task") {
          const { id, message } = turn.read();
          if (!usable()) return;
          // Don't echo arbitrary host objects, or leak the credential even if it appears in task text.
          if (typeof id !== "string" || typeof message !== "string" || id.length + message.length > MAX_REPLY_BYTES
            || id.includes(token) || message.includes(token)
            || Buffer.byteLength(JSON.stringify({ result: { id, message } })) > MAX_REPLY_BYTES) {
            reply(res, 422, { error: "Task materials cannot be relayed" });
          } else {
            reply(res, 200, { result: { id, message } });
          }
          return;
        }
        const { taskId, ...fields } = args as Record<string, unknown>;
        if (taskId !== turn.read().id) { reply(res, 403, { error: "Task ID does not match this turn" }); return; }
        if (tool.name === "deliver") {
          await turn.deliver(fields as unknown as Parameters<CollaborationTurn["deliver"]>[0]);
          if (usable()) reply(res, 200, { result: { ok: true } });
        } else {
          const { requestKey, ...message } = fields as Parameters<CollaborationTurn["blocked"]>[1] & { requestKey: string };
          const receipt = await turn.blocked(requestKey, message);
          // Report the actual host disposition without leaking task routing metadata.
          const state = isRecord(receipt) && typeof receipt.state === "string" &&
            ["pending", "consumed", "rejected", "uncertain", "task_ended", "dropped", "interrupted", "modified"].includes(receipt.state)
            ? receipt.state : "unknown";
          if (usable()) reply(res, 200, { result: { state } });
        }
      } catch {
        if (usable()) reply(res, 500, { error: "Task operation failed" });
      }
    })();
  });
  gateway.maxConnections = 8;
  gateway.maxRequestsPerSocket = 1;
  const close = () => {
    if (closed) return;
    closed = true;
    active?.scope.abort();
    gateway.close();
    gateway.closeAllConnections();
  };
  try {
    const listening = once(gateway, "listening");
    gateway.listen(0, "127.0.0.1");
    await listening;
  } catch {
    close();
    throw new Error("Could not start task MCP gateway");
  }
  gateway.on("error", close);
  gateway.unref();
  const address = gateway.address();
  if (!address || typeof address === "string") {
    close();
    throw new Error("Could not start task MCP gateway");
  }

  return {
    server: {
      name: "ashub_task",
      command: process.execPath,
      args: [fileURLToPath(new URL("./mcp-stdio.js", import.meta.url))],
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: TASK_MCP_PORT, value: String(address.port) },
        { name: TASK_MCP_TOKEN, value: token },
      ],
    },
    async run<T>(turn: CollaborationTurn, fn: () => Promise<T>): Promise<T> {
      if (closed || active) throw new Error("Task MCP gateway is unavailable");
      turn.signal.throwIfAborted();
      const scope = new AbortController();
      const abort = () => scope.abort();
      active = { turn, scope };
      turn.signal.addEventListener("abort", abort, { once: true });
      try {
        return await fn();
      } finally {
        active = undefined;
        turn.signal.removeEventListener("abort", abort);
        abort();
      }
    },
    close,
  };
}
