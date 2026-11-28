import { request } from "node:http";
import {
  isRecord, MAX_CALL_BYTES, MAX_REPLY_BYTES, TASK_MCP_PATH, TASK_MCP_PORT, TASK_MCP_TOKEN, taskMcpTools,
} from "./mcp.js";

const port = Number(process.env[TASK_MCP_PORT]);
const token = process.env[TASK_MCP_TOKEN] ?? "";
const configured = Number.isInteger(port) && port > 0 && port <= 65535 && /^[a-f0-9]{64}$/.test(token) && token.length === 64;
const versions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const decoder = new TextDecoder("utf-8", { fatal: true });

type Id = string | number | null;
const result = (id: Id, value: object) => ({ jsonrpc: "2.0", id, result: value });
const error = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolError = (message: string) => ({ isError: true, content: [{ type: "text", text: message }] });
const gatewayErrors: ReadonlyMap<number, string> = new Map([
  [400, "Invalid tool or arguments"], [403, "Task ID does not match this turn"], [409, "No active task"], [422, "Task materials cannot be relayed"],
  [500, "Task operation failed"],
]);

async function relay(name: string, args: Record<string, unknown>): Promise<object> {
  if (!configured) return toolError("Task gateway unavailable");
  let body: string;
  try { body = JSON.stringify({ name, arguments: args }); }
  catch { return toolError("Invalid tool or arguments"); }
  if (Buffer.byteLength(body) > MAX_CALL_BYTES) return toolError("Tool arguments too large");
  try {
    return await new Promise<object>((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1", port, path: TASK_MCP_PATH, method: "POST", agent: false,
        signal: AbortSignal.timeout(35_000),
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      }, res => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("error", reject);
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_REPLY_BYTES) {
            reject(new Error("Reply too large"));
            req.destroy();
          } else {
            chunks.push(chunk);
          }
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(toolError(gatewayErrors.get(res.statusCode ?? 0) ?? "Task gateway unavailable"));
            return;
          }
          try {
            const reply: unknown = JSON.parse(decoder.decode(Buffer.concat(chunks)));
            if (!isRecord(reply) || !isRecord(reply.result)) throw new Error("Invalid reply");
            const text = JSON.stringify(reply.result);
            if (text.includes(token)) throw new Error("Invalid reply");
            resolve({ content: [{ type: "text", text }] });
          } catch (err) { reject(err); }
        });
      });
      req.on("error", reject);
      req.end(body);
    });
  } catch {
    return toolError("Task gateway unavailable");
  }
}

function write(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, err => err ? reject(err) : resolve());
  });
}

async function main(): Promise<void> {
  const pending = new Set<Promise<void>>();
  let initialized = false;
  async function handle(line: Buffer): Promise<void> {
    let rpc: unknown;
    try { rpc = JSON.parse(decoder.decode(line)); }
    catch { await write(error(null, -32700, "Parse error")); return; }
    if (!isRecord(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      await write(error(null, -32600, "Invalid request"));
      return;
    }
    // Notifications (including initialized and cancelled) never produce a response.
    if (!Object.hasOwn(rpc, "id")) return;
    const id = rpc.id;
    if (!(id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id)))
      || (typeof id === "string" && token && id.includes(token))) {
      await write(error(null, -32600, "Invalid request ID"));
      return;
    }
    const params = rpc.params;
    if (params !== undefined && !isRecord(params)) {
      await write(error(id, -32602, "Invalid params"));
      return;
    }
    if (rpc.method === "ping") { await write(result(id, {})); return; }
    if (rpc.method === "initialize") {
      const version = params?.protocolVersion;
      if (typeof version !== "string" || initialized) {
        await write(error(id, -32602, "Invalid initialization"));
        return;
      }
      initialized = true;
      await write(result(id, {
        protocolVersion: versions.includes(version) ? version : versions[0],
        capabilities: { tools: {} }, serverInfo: { name: "ashub_task", version: "1.0.0" },
      }));
      return;
    }
    if (!initialized) { await write(error(id, -32002, "Not initialized")); return; }
    if (rpc.method === "tools/list") { await write(result(id, { tools: taskMcpTools })); return; }
    if (rpc.method !== "tools/call") { await write(error(id, -32601, "Method not found")); return; }
    const name = params?.name;
    const args = params?.arguments === undefined ? {} : params.arguments;
    if (typeof name !== "string" || !taskMcpTools.some(tool => tool.name === name) || !isRecord(args)) {
      await write(error(id, -32602, "Invalid tool or arguments"));
      return;
    }
    if (pending.size >= 8) { await write(result(id, toolError("Task gateway busy"))); return; }
    // Start immediately; never queue a call that might otherwise run during a later turn.
    const work = relay(name, args).then(value => write(result(id, value))).catch(() => {
      process.exitCode = 1;
      process.stdin.destroy();
    });
    pending.add(work);
    void work.then(() => pending.delete(work));
  }

  // A bounded byte scanner handles split UTF-8 sequences and discards oversized lines up to the next newline.
  const line = Buffer.alloc(MAX_CALL_BYTES);
  let used = 0;
  let overflow = false;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - start;
      if (used + length > line.length) overflow = true;
      if (!overflow) { chunk.copy(line, used, start, end); used += length; }
      if (newline < 0) break;
      if (overflow) await write(error(null, -32700, "Message too large"));
      else if (used > 0 && !(used === 1 && line[0] === 0x0d)) await handle(line.subarray(0, used));
      used = 0;
      overflow = false;
      start = end + 1;
    }
  }
  await Promise.all(pending);
}

// Avoid raw exceptions on either protocol stream (including socket errors with request metadata).
process.stdout.on("error", () => { process.exitCode = 1; process.stdin.destroy(); });
void main().catch(() => { process.exitCode = 1; process.stdin.destroy(); });
