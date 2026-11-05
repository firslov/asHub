import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { KimiAuthError, retryHeaders } from "./auth.mjs";
import { prepare } from "./provider.mjs";
const error = (res, status, message) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: { message, type: "kimi_provider_error", code: status },
    }),
  );
};
export async function startProxy({
  client,
  models,
  effort = "default",
  headersTimeoutMs = 120000,
  idleTimeoutMs = 300000,
  onDiagnostic = () => {},
}) {
  const diagnostic = (message) => {
    try {
      onDiagnostic(message);
    } catch {}
  };
  const runDefault = AsyncLocalStorage.snapshot();
  const secret = randomBytes(32).toString("hex"),
    requests = new Set(),
    contexts = new Map();
  let stopped = false;
  const requestHeaders = () => {
    const now = Date.now();
    for (const [k, v] of contexts) if (v.at < now - 300000) contexts.delete(k);
    if (contexts.size >= 256) contexts.delete(contexts.keys().next().value);
    const id = randomBytes(16).toString("hex");
    contexts.set(id, { at: now, run: AsyncLocalStorage.snapshot() });
    return { "x-ashub-kimi-context": id };
  };
  const server = http.createServer(async (req, res) => {
    const auth = Buffer.from(String(req.headers.authorization || "")),
      expected = Buffer.from("Bearer " + secret);
    if (
      req.headers.origin ||
      auth.length !== expected.length ||
      !timingSafeEqual(auth, expected)
    )
      return error(res, 401, "Unauthorized");
    if (req.method !== "POST" || req.url !== "/v1/chat/completions")
      return error(res, 404, "Not found");
    if (stopped) return error(res, 503, "Kimi 插件已停用");
    const controller = new AbortController();
    requests.add(controller);
    let timer;
    const abort = () => controller.abort();
    res.once("close", abort);
    req.once("aborted", abort);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          error(res, 413, "请求过大");
          return;
        }
        chunks.push(chunk);
      }
      let body;
      try {
        body = prepare(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          models(),
          effort,
        );
      } catch (e) {
        return error(res, 400, e.message);
      }
      const context = contexts.get(req.headers["x-ashub-kimi-context"]);
      // Restore the caller's async context across the local HTTP boundary,
      // including asHub's per-conversation proxy policy.
      const run = context?.run ?? runDefault;
      timer = setTimeout(abort, headersTimeoutMs);
      timer.unref?.();
      const upstream = await run(() =>
        client.request("/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
      );
      clearTimeout(timer);
      if (!upstream.ok) {
        if (upstream.status === 401)
          diagnostic(
            "Kimi 登录已失效，请运行 /kimi-login 完成网页授权，无需填写 API Key",
          );
        if (upstream.status === 403)
          diagnostic(
            "Kimi 拒绝了此模型请求（HTTP 403）。请在 Kimi 官方账号中检查 Coding Plan 套餐及模型访问权限；可通过 /kimi-login 切换账号。内核可能将此错误笼统显示为“检查 API key”",
          );
        for (const [name, value] of Object.entries(
          retryHeaders(upstream.headers),
        ))
          res.setHeader(name, value);
        await upstream.body?.cancel();
        return error(
          res,
          upstream.status,
          `Kimi 请求失败（HTTP ${upstream.status}）${upstream.status === 401 ? "，请重新登录" : upstream.status === 403 ? "，请检查账号的 Kimi Coding Plan 权益及模型访问权限" : upstream.status === 429 ? "，请稍后重试或检查套餐额度" : ""}`,
        );
      }
      if (!upstream.body) return error(res, 502, "Kimi 返回空响应");
      res.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") || "text/event-stream",
        "Cache-Control": "no-store",
      });
      const stream = Readable.fromWeb(upstream.body);
      const reset = () => {
        clearTimeout(timer);
        timer = setTimeout(abort, idleTimeoutMs);
        timer.unref?.();
      };
      reset();
      stream.on("data", reset);
      await pipeline(stream, res, { signal: controller.signal });
    } catch (e) {
      if (
        !res.destroyed &&
        !controller.signal.aborted &&
        e instanceof KimiAuthError
      ) {
        if (e.status === 401) diagnostic(e.message);
        for (const [name, value] of Object.entries(e.retryHeaders))
          res.setHeader(name, value);
        error(res, e.status, e.message);
      } else if (!res.destroyed)
        error(
          res,
          controller.signal.aborted ? 504 : 502,
          controller.signal.aborted
            ? "Kimi 请求已取消或等待超时"
            : "无法连接 Kimi，请检查网络或登录状态",
        );
    } finally {
      clearTimeout(timer);
      requests.delete(controller);
      res.off("close", abort);
      req.off("aborted", abort);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    secret,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    requestHeaders,
    async close() {
      stopped = true;
      contexts.clear();
      for (const c of requests) c.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
