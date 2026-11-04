import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Credentials, KimiClient } from "../auth.mjs";
const fresh = () => ({
  access_token: "old",
  refresh_token: "refresh",
  expires_at: Date.now() / 1000 + 3600,
});
async function fixture(t, data, fetcher) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "credentials"));
  const c = new Credentials(dir, fetcher);
  await fs.writeFile(c.file, JSON.stringify(data));
  return c;
}
test("unexpired login does not refresh", async (t) => {
  const c = await fixture(t, fresh(), () => {
    throw Error("unexpected");
  });
  assert.equal(await c.get(), "old");
});
test("concurrent expired requests share refresh and save secure rotated credentials", async (t) => {
  let count = 0;
  const c = await fixture(
    t,
    { ...fresh(), expires_at: 0 },
    async (url, init) => {
      count++;
      assert.equal(new URL(url).hostname, "auth.kimi.com");
      assert.equal(init.redirect, "error");
      await new Promise((r) => setTimeout(r, 10));
      return Response.json({
        access_token: "new",
        refresh_token: "rotated",
        expires_in: 3600,
      });
    },
  );
  assert.deepEqual(
    await Promise.all(Array.from({ length: 8 }, () => c.get())),
    Array(8).fill("new"),
  );
  assert.equal(count, 1);
  const saved = JSON.parse(await fs.readFile(c.file));
  assert.equal(saved.refresh_token, "rotated");
  if (process.platform !== "win32")
    assert.equal((await fs.stat(c.file)).mode & 0o777, 0o600);
});
test("failed refresh keeps original login", async (t) => {
  const initial = { ...fresh(), expires_at: 0 };
  const c = await fixture(
    t,
    initial,
    async () => new Response("secret error", { status: 403 }),
  );
  await assert.rejects(c.get(), /HTTP 403/);
  assert.deepEqual(JSON.parse(await fs.readFile(c.file)), initial);
});
test("external login during refresh is not overwritten", async (t) => {
  let c;
  c = await fixture(t, { ...fresh(), expires_at: 0 }, async () => {
    await fs.writeFile(
      c.file,
      JSON.stringify({
        ...fresh(),
        access_token: "other",
        refresh_token: "other-refresh",
      }),
    );
    return Response.json({ access_token: "stale", expires_in: 3600 });
  });
  assert.equal(await c.get(), "other");
  assert.equal(JSON.parse(await fs.readFile(c.file)).access_token, "other");
});
test("logout during refresh is not resurrected", async (t) => {
  let c;
  c = await fixture(t, { ...fresh(), expires_at: 0 }, async () => {
    await fs.rm(c.file);
    return Response.json({ access_token: "new", expires_in: 3600 });
  });
  await assert.rejects(c.get());
  await assert.rejects(fs.access(c.file));
});
test("401 refreshes once; API key and 429 are not retried", async () => {
  let gets = [],
    calls = 0;
  const auth = {
    get: async (stale) => {
      gets.push(stale);
      return stale ? "new" : "old";
    },
    headers: async () => ({}),
  };
  const c = new KimiClient(auth, null, async (url, init) => {
    calls++;
    assert.ok(url.startsWith("https://api.kimi.com/coding/v1/"));
    return calls === 1
      ? new Response("", { status: 401 })
      : Response.json({ ok: true });
  });
  assert.equal((await c.request("/models")).status, 200);
  assert.deepEqual(gets, [undefined, "old"]);
  assert.equal(calls, 2);
  calls = 0;
  const keyed = new KimiClient(auth, "key", async () => {
    calls++;
    return new Response("", { status: 401 });
  });
  assert.equal((await keyed.request("/models")).status, 401);
  assert.equal(calls, 1);
  calls = 0;
  const limited = new KimiClient(auth, null, async () => {
    calls++;
    return new Response("", { status: 429 });
  });
  assert.equal((await limited.request("/models")).status, 429);
  assert.equal(calls, 1);
});
test("aborted request does not access credentials or network", async () => {
  const c = new KimiClient(
    {
      get: () => {
        throw Error("unexpected");
      },
    },
    null,
  );
  await assert.rejects(c.request("/models", { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
});
test("caller cancellation does not wait for a shared credentials refresh", async () => {
  const c = new KimiClient(
    { get: () => new Promise(() => {}), headers: async () => ({}) },
    null,
  );
  const controller = new AbortController();
  const request = c.request("/models", { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
});

test("refresh denial remains an authentication error and preserves credentials", async (t) => {
  const { KimiAuthError } = await import("../auth.mjs");
  const initial = { ...fresh(), expires_at: 0 };
  const c = await fixture(
    t,
    initial,
    async () => new Response("private denial details", { status: 403 }),
  );
  await assert.rejects(
    c.get(),
    (e) =>
      e instanceof KimiAuthError &&
      e.status === 401 &&
      e.message.includes("kimi login") &&
      !e.message.includes("private denial"),
  );
  assert.deepEqual(JSON.parse(await fs.readFile(c.file)), initial);
});

test("refresh throttling preserves status and retry delay without asking for login", async (t) => {
  const { KimiAuthError } = await import("../auth.mjs");
  const initial = { ...fresh(), expires_at: 0 };
  const c = await fixture(
    t,
    initial,
    async () =>
      new Response("", { status: 429, headers: { "retry-after": "30" } }),
  );
  await assert.rejects(
    c.get(),
    (e) =>
      e instanceof KimiAuthError &&
      e.status === 429 &&
      e.retryHeaders["retry-after"] === "30" &&
      !e.message.includes("kimi login"),
  );
  assert.deepEqual(JSON.parse(await fs.readFile(c.file)), initial);
});

test("OAuth invalid_grant on HTTP 400 requires login instead of retrying later", async (t) => {
  const { KimiAuthError } = await import("../auth.mjs");
  const initial = { ...fresh(), expires_at: 0 };
  const c = await fixture(t, initial, async () =>
    Response.json(
      {
        error: "invalid_grant",
        error_description: "private credential details",
      },
      { status: 400 },
    ),
  );
  await assert.rejects(
    c.get(),
    (e) =>
      e instanceof KimiAuthError &&
      e.status === 401 &&
      e.message.includes("kimi login") &&
      !e.message.includes("private credential"),
  );
  assert.deepEqual(JSON.parse(await fs.readFile(c.file)), initial);
});

test("separate credential instances coordinate one refresh through the file lock", async (t) => {
  let calls = 0;
  const refresh = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 15));
    return Response.json({
      access_token: "new",
      refresh_token: "rotated",
      expires_in: 3600,
    });
  };
  const a = await fixture(t, { ...fresh(), expires_at: 0 }, refresh);
  const b = new Credentials(a.home, refresh);
  assert.deepEqual(await Promise.all([a.get(), b.get()]), ["new", "new"]);
  assert.equal(calls, 1);
});

test("other HTTP 400 refresh errors are not misclassified as invalid_grant", async (t) => {
  for (const body of [
    "not JSON",
    JSON.stringify({
      error: "invalid_request",
      error_description: "invalid_grant",
    }),
  ]) {
    const initial = { ...fresh(), expires_at: 0 };
    const c = await fixture(
      t,
      initial,
      async () => new Response(body, { status: 400 }),
    );
    await assert.rejects(
      c.get(),
      (e) => e.status === 400 && !e.message.includes("kimi login"),
    );
    assert.deepEqual(JSON.parse(await fs.readFile(c.file)), initial);
  }
});

test("web login saves only valid credentials atomically and supports a fresh home", async (t) => {
  const c = await fixture(t, fresh(), async () => {
    throw Error("unexpected network");
  });
  await fs.rm(path.dirname(c.file), { recursive: true });
  await c.saveLogin({
    access_token: "web",
    refresh_token: "web-refresh",
    expires_in: 3600,
    private_extra: "do not save",
  });
  const saved = JSON.parse(await fs.readFile(c.file));
  assert.equal(saved.access_token, "web");
  assert.equal(saved.private_extra, undefined);
  assert.ok(saved.expires_at > Date.now() / 1000);
  if (process.platform !== "win32")
    assert.equal((await fs.stat(c.file)).mode & 0o777, 0o600);
  for (const data of [
    null,
    { access_token: "invalid", expires_in: 3600 },
    { access_token: "x", refresh_token: "y", expires_in: 0 },
  ])
    await assert.rejects(c.saveLogin(data));
  await assert.rejects(
    c.saveLogin(
      {
        access_token: "cancelled",
        refresh_token: "cancelled",
        expires_in: 3600,
      },
      AbortSignal.abort(),
    ),
  );
  assert.equal(JSON.parse(await fs.readFile(c.file)).access_token, "web");
});
test("web login serialized after an in-flight refresh remains the final login", async (t) => {
  let entered, release;
  const started = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  const c = await fixture(t, { ...fresh(), expires_at: 0 }, async () => {
    entered();
    await gate;
    return Response.json({
      access_token: "refreshed-old-account",
      refresh_token: "old-account",
      expires_in: 3600,
    });
  });
  const refresh = c.get();
  await started;
  const login = c.saveLogin({
    access_token: "web-new-account",
    refresh_token: "new-account",
    expires_in: 3600,
  });
  release();
  await Promise.all([refresh, login]);
  assert.equal((await c.load()).access_token, "web-new-account");
});
