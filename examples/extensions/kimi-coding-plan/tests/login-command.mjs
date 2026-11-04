import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import activate from "../index.mjs";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

for (const outcome of ["success", "failure", "cancel"])
  test(
    `web login handles an older catalog request: ${outcome}`,
    { timeout: 10000 },
    async (t) => {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), "kimi-login-command-"),
      );
      const originalFetch = globalThis.fetch,
        oldKey = process.env.KIMI_API_KEY,
        oldMoonshot = process.env.MOONSHOT_API_KEY;
      delete process.env.KIMI_API_KEY;
      delete process.env.MOONSHOT_API_KEY;
      const spawned = [];
      const launch = t.mock.method(childProcess, "spawn", (...args) => {
        spawned.push(args);
        return {
          on() {
            return this;
          },
          unref() {},
        };
      });
      syncBuiltinESMExports();
      const cleanup = [],
        commands = new Map(),
        oldRequest = deferred(),
        oldStarted = deferred(),
        loginSaved = deferred(),
        updated = deferred();
      let reg,
        modelCalls = 0;
      const authorization = [];
      await fs.mkdir(path.join(dir, "credentials"));
      await fs.writeFile(
        path.join(dir, "credentials/kimi-code.json"),
        JSON.stringify({
          access_token: "account-A",
          refresh_token: "refresh-A",
          expires_at: Date.now() / 1000 + 3600,
        }),
      );
      const catalog = (id) =>
        Response.json({
          data: [
            { id, limit: { context: 262144 }, reasoning: { type: "only" } },
          ],
        });
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith("/models")) {
          modelCalls++;
          authorization.push(init.headers.Authorization);
          if (modelCalls === 1) return catalog("account-A-model");
          if (modelCalls === 2) {
            oldStarted.resolve();
            return oldRequest.promise;
          }
          return catalog("account-B-model");
        }
        if (String(url).endsWith("/device_authorization"))
          return Response.json({
            device_code: "private-code",
            user_code: "TEST-CODE",
            verification_uri_complete:
              "https://www.kimi.com/code/authorize_device?user_code=TEST-CODE",
            interval: 0.01,
            expires_in: 600,
          });
        if (String(url).endsWith("/oauth/token"))
          return Response.json({
            access_token: "account-B",
            refresh_token: "refresh-B",
            expires_in: 3600,
          });
        throw Error("Unexpected request");
      };
      const ctx = {
        list: () => ["command:/help"],
        getExtensionSettings: (_, d) => ({ ...d, kimiHome: dir }),
        onDispose: (f) => cleanup.push(f),
        registerCommand: (n, _, f) => commands.set(n, f),
        agent: {
          providers: {
            configure() {},
            register: (r) => {
              reg = r;
              return () => {};
            },
          },
        },
        bus: {
          emit: (_, p) => {
            if (p.message.startsWith("Kimi 网页登录成功")) loginSaved.resolve();
            if (p.message.startsWith("Kimi 模型已更新")) updated.resolve();
          },
        },
      };
      try {
        await activate(ctx);
        const refreshing = commands.get("kimi-refresh")();
        await oldStarted.promise;
        commands.get("kimi-login")("");
        await loginSaved.promise;
        if (outcome === "cancel") commands.get("kimi-login")("cancel");
        if (outcome === "failure")
          oldRequest.reject(Error("Old account catalog failed"));
        else oldRequest.resolve(catalog("account-A-model"));
        await refreshing;
        if (outcome === "cancel") {
          await new Promise((r) => setImmediate(r));
          assert.equal(
            modelCalls,
            2,
            "Cancelled login must not start another model refresh",
          );
          return;
        }
        await updated.promise;
        assert.equal(
          modelCalls,
          3,
          "Login must not reuse a catalog request made with the old token",
        );
        assert.equal(authorization.at(-1), "Bearer account-B");
        assert.equal(reg.models[0].id, "account-B-model");
        assert.equal(spawned.length, 1);
      } finally {
        oldRequest.resolve(catalog("account-A-model"));
        for (const fn of cleanup) fn();
        launch.mock.restore();
        syncBuiltinESMExports();
        globalThis.fetch = originalFetch;
        if (oldKey === undefined) delete process.env.KIMI_API_KEY;
        else process.env.KIMI_API_KEY = oldKey;
        if (oldMoonshot === undefined) delete process.env.MOONSHOT_API_KEY;
        else process.env.MOONSHOT_API_KEY = oldMoonshot;
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
