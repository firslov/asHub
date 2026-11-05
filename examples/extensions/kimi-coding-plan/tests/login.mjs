import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceLogin, authorizationURL, openAuthorization } from "../login.mjs";
const challenge = {
  device_code: "PRIVATE_DEVICE_CODE",
  user_code: "TEST-CODE",
  verification_uri_complete: "https://auth.kimi.com/device?user_code=TEST-CODE",
  expires_in: 600,
  interval: 2,
};
const token = {
  access_token: "access",
  refresh_token: "refresh",
  expires_in: 3600,
};
test("device flow handles pending, slow_down and success without exposing private codes", async () => {
  const replies = [
    Response.json(challenge),
    Response.json({ error: "authorization_pending" }, { status: 400 }),
    Response.json({ error: "slow_down" }, { status: 400 }),
    Response.json(token),
  ];
  let saved, shown;
  const waits = [],
    forms = [];
  await deviceLogin(
    { headers: async () => ({}), saveLogin: async (data) => (saved = data) },
    {
      onAuthorization: (state) => (shown = state),
      sleep: async (ms) => waits.push(ms),
      fetchImpl: async (url, init) => {
        assert.equal(init.redirect, "error");
        assert.equal(new URL(url).hostname, "auth.kimi.com");
        forms.push(new URLSearchParams(init.body));
        return replies.shift();
      },
    },
  );
  assert.deepEqual(saved, token);
  assert.deepEqual(waits, [2000, 2000, 7000]);
  assert.equal(
    forms[1].get("grant_type"),
    "urn:ietf:params:oauth:grant-type:device_code",
  );
  assert.equal(forms[1].get("device_code"), challenge.device_code);
  assert.doesNotMatch(
    JSON.stringify(shown),
    /PRIVATE_DEVICE_CODE|access_token|refresh_token/,
  );
});
test("cancelled login never polls or saves credentials", async () => {
  const controller = new AbortController();
  let calls = 0,
    saves = 0;
  await assert.rejects(
    deviceLogin(
      { headers: async () => ({}), saveLogin: async () => saves++ },
      {
        signal: controller.signal,
        onAuthorization: () => controller.abort(),
        fetchImpl: async () => {
          calls++;
          return Response.json(challenge);
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
  assert.equal(saves, 0);
});
test("denied or expired authorization does not alter credentials", async () => {
  for (const code of ["access_denied", "expired_token"]) {
    let calls = 0,
      saves = 0;
    await assert.rejects(
      deviceLogin(
        { headers: async () => ({}), saveLogin: async () => saves++ },
        {
          sleep: async () => {},
          fetchImpl: async () =>
            ++calls === 1
              ? Response.json(challenge)
              : Response.json({ error: code }, { status: 400 }),
        },
      ),
      /已拒绝|已过期/,
    );
    assert.equal(saves, 0);
  }
});
test("rejects untrusted or malformed authorization responses", async () => {
  for (const changed of [
    { verification_uri_complete: "https://evil.example/" },
    { interval: 0 },
    { expires_in: -1 },
    { user_code: "<script>" },
  ]) {
    let shown = false;
    await assert.rejects(
      deviceLogin(
        { headers: async () => ({}) },
        {
          onAuthorization: () => (shown = true),
          fetchImpl: async () => Response.json({ ...challenge, ...changed }),
        },
      ),
    );
    assert.equal(shown, false);
  }
  for (const url of [
    "http://auth.kimi.com/",
    "https://auth.kimi.com.evil.example/",
    "https://user:password@auth.kimi.com/",
    "https://auth.kimi.com:8080/",
  ])
    assert.throws(() => authorizationURL(url));
});
test("Windows launch keeps URL out of shell source", () => {
  let invocation;
  const url =
    "https://auth.kimi.com/device?user_code=TEST-CODE&next=hello%25world";
  openAuthorization(url, "win32", (...args) => {
    invocation = args;
    return {
      on() {
        return this;
      },
      unref() {},
    };
  });
  assert.equal(invocation[0], "powershell.exe");
  assert.equal(invocation[2].env.ASHUB_KIMI_LOGIN_URL, url);
  assert.ok(!invocation[1].join(" ").includes(url));
  assert.equal(invocation[2].shell, undefined);
});
test("server failures retry while waiting but preserve cancellation", async () => {
  const controller = new AbortController();
  let calls = 0,
    waits = 0;
  await assert.rejects(
    deviceLogin(
      {
        headers: async () => ({}),
        saveLogin: () => assert.fail("must not save"),
      },
      {
        signal: controller.signal,
        sleep: async () => {
          if (++waits === 2) controller.abort();
        },
        fetchImpl: async () =>
          ++calls === 1
            ? Response.json(challenge)
            : Response.json({}, { status: 503 }),
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 2);
});

test("a successful token response arriving after cancellation is never saved", async () => {
  const controller = new AbortController();
  let calls = 0,
    saves = 0;
  await assert.rejects(
    deviceLogin(
      { headers: async () => ({}), saveLogin: async () => saves++ },
      {
        signal: controller.signal,
        sleep: async () => {},
        fetchImpl: async () => {
          if (++calls === 1) return Response.json(challenge);
          controller.abort();
          return Response.json(token);
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(saves, 0);
});

test("a superseded authorization response never opens a browser or starts polling", async () => {
  const controller = new AbortController();
  let opened = 0,
    calls = 0;
  await assert.rejects(
    deviceLogin(
      {
        headers: async () => ({}),
        saveLogin: () => assert.fail("must not save"),
      },
      {
        signal: controller.signal,
        onAuthorization: () => opened++,
        fetchImpl: async () => {
          calls++;
          controller.abort();
          return Response.json(challenge);
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(opened, 0);
  assert.equal(calls, 1);
});
