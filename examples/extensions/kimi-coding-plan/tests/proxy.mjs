import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { startProxy } from "../proxy.mjs";
const models = () => [
  {
    id: "k3",
    maxTokens: 32768,
    thinkingType: "only",
    efforts: ["low", "high", "max"],
  },
];
const send = (
  p,
  body = { model: "k3", messages: [], stream: true },
  headers = {},
) =>
  fetch(p.baseURL + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + p.secret,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
test("authenticated proxy preserves SSE and per-request async policy", async (t) => {
  const als = new AsyncLocalStorage();
  let seen;
  const sse =
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
  const p = await als.run("activation", () =>
    startProxy({
      models,
      effort: "low",
      client: {
        request: async (route, init) => {
          seen = als.getStore();
          assert.equal(route, "/chat/completions");
          assert.deepEqual(JSON.parse(init.body).thinking, {
            type: "enabled",
            effort: "low",
          });
          return new Response(sse, {
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    }),
  );
  t.after(() => p.close());
  const headers = als.run("conversation", () => p.requestHeaders());
  const res = await send(p, undefined, headers);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), sse);
  assert.equal(seen, "conversation");
  await (await send(p)).text();
  assert.equal(seen, "activation");
});
test("proxy rejects unknown credentials, browser origin, invalid model and wrong route", async (t) => {
  let calls = 0;
  const p = await startProxy({
    models,
    client: {
      request: async () => {
        calls++;
        return new Response("");
      },
    },
  });
  t.after(() => p.close());
  assert.equal(
    (await send(p, undefined, { Authorization: "Bearer bad" })).status,
    401,
  );
  assert.equal(
    (await send(p, undefined, { Origin: "https://attacker.example" })).status,
    401,
  );
  assert.equal((await send(p, { model: "no", messages: [] })).status, 400);
  assert.equal(
    (
      await fetch(p.baseURL + "/models", {
        headers: { Authorization: "Bearer " + p.secret },
      })
    ).status,
    404,
  );
  assert.equal(calls, 0);
});
test("upstream failure does not disclose credentials or response body", async (t) => {
  const p = await startProxy({
    models,
    client: {
      request: async () => new Response("SECRET_TOKEN", { status: 403 }),
    },
  });
  t.after(() => p.close());
  const res = await send(p);
  assert.equal(res.status, 403);
  assert.doesNotMatch(await res.text(), /SECRET_TOKEN/);
});
test("header timeout aborts upstream and returns retryable status", async (t) => {
  let aborted = false;
  const p = await startProxy({
    models,
    headersTimeoutMs: 25,
    client: {
      request: async (_, init) =>
        new Promise((_, reject) =>
          init.signal.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal.reason);
          }),
        ),
    },
  });
  t.after(() => p.close());
  const res = await send(p);
  assert.equal(res.status, 504);
  assert.equal(aborted, true);
});
test("stream idle timeout aborts unfinished stream", async (t) => {
  let cancelled = false;
  const p = await startProxy({
    models,
    idleTimeoutMs: 25,
    client: {
      request: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: partial\n\n"));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    },
  });
  t.after(() => p.close());
  const res = await send(p);
  await assert.rejects(res.text());
  assert.equal(cancelled, true);
});
test("disposal aborts active requests and closes listening socket", async () => {
  let started,
    aborted = false;
  const ready = new Promise((r) => (started = r));
  const p = await startProxy({
    models,
    client: {
      request: async (_, init) =>
        new Promise((_, reject) => {
          started();
          init.signal.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal.reason);
          });
        }),
    },
  });
  const pending = send(p).catch(() => null);
  await ready;
  await p.close();
  await pending;
  assert.equal(aborted, true);
  await assert.rejects(send(p));
});

test("missing local login is reported as authentication failure, not retryable network failure", async (t) => {
  const { Credentials, KimiClient } = await import("../auth.mjs");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-missing-login-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const p = await startProxy({
    models,
    client: new KimiClient(new Credentials(dir)),
  });
  t.after(() => p.close());
  const res = await send(p);
  assert.equal(res.status, 401);
  assert.match((await res.json()).error.message, /kimi login/);
});

test("upstream retry hints survive the loopback adapter", async (t) => {
  const p = await startProxy({
    models,
    client: {
      request: async () =>
        new Response("private upstream message", {
          status: 429,
          headers: {
            "retry-after": "12",
            "retry-after-ms": "12000",
            "x-should-retry": "false",
            "set-cookie": "secret-cookie",
          },
        }),
    },
  });
  t.after(() => p.close());
  const res = await send(p);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "12");
  assert.equal(res.headers.get("retry-after-ms"), "12000");
  assert.equal(res.headers.get("x-should-retry"), "false");
  assert.equal(res.headers.get("set-cookie"), null);
});

test(
  "downstream cancellation aborts an active upstream stream",
  { timeout: 2000 },
  async (t) => {
    let notifyAbort;
    const aborted = new Promise((r) => (notifyAbort = r));
    const p = await startProxy({
      models,
      client: {
        request: async (_, init) => {
          init.signal.addEventListener("abort", notifyAbort, { once: true });
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("data: partial\n\n"));
              },
            }),
          );
        },
      },
    });
    t.after(() => p.close());
    const controller = new AbortController();
    const res = await fetch(p.baseURL + "/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: "Bearer " + p.secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "k3", messages: [], stream: true }),
    });
    const reader = res.body.getReader();
    assert.equal((await reader.read()).done, false);
    controller.abort();
    await assert.rejects(reader.read());
    await aborted;
  },
);

test("nonstream completions preserve JSON response and finish reason", async (t) => {
  const answer = {
    choices: [
      { message: { role: "assistant", content: "OK" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 1 },
  };
  const p = await startProxy({
    models,
    client: {
      request: async (_, init) => {
        assert.equal(JSON.parse(init.body).stream, false);
        return Response.json(answer);
      },
    },
  });
  t.after(() => p.close());
  const res = await send(p, { model: "k3", messages: [], stream: false });
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await res.json(), answer);
});

test("403 reports a separate account-permission diagnostic while preserving HTTP status", async (t) => {
  const messages = [];
  const p = await startProxy({
    models,
    onDiagnostic: (message) => messages.push(message),
    client: {
      request: async () =>
        new Response("private upstream details", { status: 403 }),
    },
  });
  t.after(() => p.close());
  const res = await send(p);
  assert.equal(res.status, 403);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Coding Plan/);
  assert.match(messages[0], /kimi-login/);
  assert.doesNotMatch(messages[0], /private upstream/);
});
