import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("desktop Antigravity uses the selected system proxy route", async () => {
  const { antigravityProxyUrl } = await import("../dist/builtin-plugins/google-antigravity/bridge.js");
  assert.equal(antigravityProxyUrl("PROXY 127.0.0.1:7897; DIRECT"), "http://127.0.0.1:7897/");
  assert.equal(antigravityProxyUrl("SOCKS5 [::1]:7897"), "socks5://[::1]:7897");
  assert.equal(antigravityProxyUrl("DIRECT; PROXY 127.0.0.1:7897"), undefined);
  assert.equal(antigravityProxyUrl("PROXY user:pass@127.0.0.1:7897"), undefined);
});

test("Antigravity is an opt-in interactive desktop session that resumes by ACP ID", { timeout: 20000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ashub-antigravity-test-"));
  process.env.AGENT_SH_HOME = home;
  process.env.ASHUB_TOKEN = "antigravity-fixture";
  const childFile = path.join(home, "fake-acp.cjs");
  const logFile = path.join(home, "rpc.jsonl");
  await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ disabledBuiltins: ["codex-provider"] }));
  await fs.writeFile(childFile, `
    const fs = require("node:fs");
    const readline = require("node:readline");
    let pending;
    const send = value => console.log(JSON.stringify({ jsonrpc: "2.0", ...value }));
    const chunk = text => send({ method: "session/update", params: { sessionId: "google-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    readline.createInterface({ input: process.stdin }).on("line", line => {
      const m = JSON.parse(line);
      fs.appendFileSync(process.argv[2], line + "\\n");
      const reply = result => send({ id: m.id, result });
      if (m.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
      if (m.method === "session/new") {
        if (m.params.cwd.endsWith("signed-out")) {
          send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
        } else reply({ sessionId: "google-session" });
      }
      if (m.method === "session/load") {
        chunk("ACP playback must not duplicate the asHub transcript");
        reply({});
      }
      if (m.method === "session/prompt") {
        if (m.params.prompt[0].text === "Please wait") pending = m.id;
        else if (m.params.prompt[0].text === "Disconnect") process.exit(0);
        else { chunk("Response from Antigravity"); reply({ stopReason: "end_turn" }); }
      }
      if (m.method === "session/cancel" && pending) {
        send({ id: pending, result: { stopReason: "cancelled" } });
        pending = undefined;
      }
    });
  `);
  await fs.mkdir(path.join(home, "signed-out"));
  const { startHub } = await import("../dist/hub.js");
  const { AcpBridge } = await import("../dist/bridges/acp.js");
  const { AshBridge } = await import("../dist/bridges/ash.js");
  let hub;
  t.after(async () => {
    try { await hub?.shutdown(); } finally { await fs.rm(home, { recursive: true, force: true }); }
  });
  const calls = async () => {
    const content = await fs.readFile(logFile, "utf8");
    return content.trim().split("\n").map(line => JSON.parse(line));
  };
  async function start(enable) {
    hub = startHub({
      host: "127.0.0.1", port: 0, webRoot: path.resolve(import.meta.dirname, "../web"),
      makeBridge: opts => new AshBridge(opts),
      makeAntigravityBridge: enable ? opts => new AcpBridge({ ...opts, extra: {
        command: process.execPath, args: [childFile, logFile], antigravity: true,
      } }) : undefined,
    });
    await once(hub.server, "listening");
  }
  const request = (route, body, signal, method = body === undefined ? "GET" : "POST") => fetch(`http://127.0.0.1:${hub.server.address().port}${route}`, {
    signal, method, body: JSON.stringify(body),
    headers: { authorization: "Bearer antigravity-fixture", "content-type": "application/json" },
  });
  const json = async (route, body) => {
    const r = await request(route, body);
    assert(r.ok, `${route}: ${r.status} ${await r.clone().text()}`);
    return r.json();
  };

  await start(false);
  assert.equal((await request("/sessions", { cwd: home, kind: "antigravity" })).status, 403);
  const browserOnly = await json("/sessions", { cwd: home });
  assert.equal((await request(`/${browserOnly.instanceId}/antigravity`, {})).status, 403);
  await hub.shutdown();
  await start(true);
  const signedOut = await request("/sessions", { cwd: path.join(home, "signed-out"), kind: "antigravity" });
  assert.equal(signedOut.status, 422);
  assert.match(await signedOut.text(), /agy acp --login/);
  const unavailable = await json("/sessions", { cwd: path.join(home, "signed-out") });
  const failedSwitch = await request(`/${unavailable.instanceId}/antigravity`, {});
  assert.equal(failedSwitch.status, 422);
  assert.match(await failedSwitch.text(), /agy acp --login/);
  assert.equal((await json("/sessions")).find(s => s.instanceId === unavailable.instanceId).kind, "agent");
  const ordinary = browserOnly;
  await json("/api/projects", { action: "create", name: "Fixture", cwd: home, add: [ordinary.instanceId] });
  assert.equal((await request(`/${ordinary.instanceId}/antigravity`, {})).status, 409);
  const named = await json("/sessions", { cwd: home });
  await json(`/${named.instanceId}/title`, { title: "Keep this conversation" });
  assert.equal((await request(`/${named.instanceId}/antigravity`, {})).status, 409);
  const empty = await json("/sessions", { cwd: home });
  const switches = await Promise.all([request(`/${empty.instanceId}/antigravity`, {}), request(`/${empty.instanceId}/antigravity`, {})]);
  assert.deepEqual(switches.map(r => r.status).sort(), [200, 409]);
  const { instanceId, cwd } = await switches.find(r => r.ok).json();
  assert.equal(cwd, home);
  assert.notEqual(instanceId, empty.instanceId);
  const sessions = await json("/sessions");
  assert(!sessions.some(s => s.instanceId === empty.instanceId));
  assert.equal(sessions.filter(s => s.kind === "antigravity").length, 1);
  assert.equal(sessions.find(s => s.instanceId === ordinary.instanceId).kind, "agent");
  const acp = sessions.find(s => s.instanceId === instanceId);
  assert.equal(acp.kind, "antigravity");
  assert.equal(acp.readOnlyContext, true);
  assert.equal(acp.title, "Antigravity");
  const networkEndpoint = "/api/settings/network";
  const networkBefore = await json(networkEndpoint);
  const acpNetwork = await request(networkEndpoint, { session: instanceId, enabled: false }, undefined, "PUT");
  assert.equal(acpNetwork.status, 409);
  assert.deepEqual(await json(networkEndpoint), networkBefore);
  const normalNetwork = await request(networkEndpoint, { session: ordinary.instanceId, enabled: false }, undefined, "PUT");
  assert.equal(normalNetwork.status, 200);
  assert.equal((await normalNetwork.json()).sessions[ordinary.instanceId], false);
  assert.equal((await request("/api/projects", { action: "create", name: "Test", cwd: home, add: [instanceId] })).status, 400);

  const prompt = '{"query":"literal user prompt","images":[]}';
  await json(`/${instanceId}/submit`, { query: prompt });
  const context = async () => json(`/${instanceId}/context`);
  const waitFor = async (fn) => {
    for (let count = 0; count < 75; count++) {
      const result = await fn();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail("Expected ACP event did not appear");
  };
  await waitFor(async () => (await context()).messages.some(m => m.content === "Response from Antigravity"));
  assert.deepEqual((await calls()).find(m => m.method === "session/prompt").params, {
    sessionId: "google-session", prompt: [{ type: "text", text: prompt }],
  });
  await waitFor(async () => (await json("/sessions")).find(s => s.instanceId === instanceId).title === prompt);

  await hub.shutdown();
  await start(true);
  assert.equal((await calls()).filter(m => m.method === "session/load").length, 0, "start must stay lazy");
  const restored = await context();
  assert.equal(restored.messages.filter(m => m.content === "Response from Antigravity").length, 1);
  assert(!restored.messages.some(m => String(m.content).startsWith("ACP playback")));
  assert.deepEqual((await calls()).find(m => m.method === "session/load").params, {
    sessionId: "google-session", cwd: home, mcpServers: [],
  });

  await json(`/${instanceId}/submit`, { query: "Please wait" });
  await waitFor(async () => (await calls()).some(m => m.method === "session/prompt" && m.params.prompt[0].text === "Please wait"));
  await json(`/${instanceId}/cancel`, {});
  await waitFor(async () => !(await json("/sessions")).find(s => s.instanceId === instanceId).isProcessing);
  assert.deepEqual((await calls()).find(m => m.method === "session/cancel").params, { sessionId: "google-session" });
  assert.equal((await calls()).filter(m => m.method === "session/prompt").length, 2);
  await json(`/${instanceId}/submit`, { query: "Disconnect" });
  await waitFor(async () => !(await json("/sessions")).find(s => s.instanceId === instanceId).isProcessing);
  assert.equal((await context()).messages.filter(m => m.content === "Response from Antigravity").length, 1);
  assert.equal((await calls()).filter(m => m.method === "session/load").length, 2);
  assert.equal((await calls()).filter(m => m.method === "session/prompt").length, 3, "disconnect must not replay a prompt");
  await assert.rejects(fs.access(path.join(home, "hub-sessions", `${instanceId}.jsonl`)), { code: "ENOENT" });
});
