import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const host = process.env.ASHUB_TEST_ROOT;
test("real asHub loader and kernel integration", { skip: !host }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-host-test-"));
  process.env.AGENT_SH_HOME = dir;
  process.env.KIMI_API_KEY = "fixture";
  const nativeFetch = globalThis.fetch;
  let calls = [],
    catalogReads = 0;
  const raw = {
    data: [
      {
        id: "k3",
        limit: { context: 1048576 },
        modalities: { input: ["text", "image"] },
        reasoning: { type: "only", effort: { valid: ["low", "high", "max"] } },
      },
    ],
  };
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://api.kimi.com/"))
      return nativeFetch(input, init);
    if (String(input).endsWith("/models")) {
      catalogReads++;
      return Response.json(raw);
    }
    const body = JSON.parse(init.body);
    calls.push(body);
    const chunk = {
      id: "test",
      object: "chat.completion.chunk",
      created: 1,
      model: "k3",
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: "test reasoning",
            tool_calls: [
              {
                index: 0,
                id: "test-call",
                type: "function",
                function: { name: "echo_test", arguments: '{"value":"OK"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    return new Response(
      "data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const { createCore } = await import(
    host + "/node_modules/agent-sh/dist/core/index.js"
  );
  const { activateAgent } = await import(
    host + "/node_modules/agent-sh/dist/agent/index.js"
  );
  const { loadBuiltinExtensions } = await import(
    host + "/node_modules/agent-sh/dist/extensions/index.js"
  );
  const { LlmClient } = await import(
    host + "/node_modules/agent-sh/dist/agent/llm-client.js"
  );
  const { PluginRuntime, preparePluginRegistrations } = await import(
    host + "/dist/plugin-runtime.js"
  );
  const { parsePluginManifest } = await import(
    host + "/dist/extensions/manifest.js"
  );
  const root = fileURLToPath(new URL("../", import.meta.url));
  parsePluginManifest(
    JSON.parse(await fs.readFile(path.join(root, "ashub-plugin.json"))),
    "ashub-kimi-coding-plan",
  );
  const settings = path.join(dir, "settings.json");
  await fs.writeFile(
    settings,
    JSON.stringify({ extensions: [path.join(root, "index.mjs")] }),
  );
  const cores = [],
    runtimes = [];
  try {
    for (let i = 0; i < 3; i++) {
      const core = createCore({});
      cores.push(core);
      const ctx = core.extensionContext({ quit() {} });
      preparePluginRegistrations(ctx);
      activateAgent(ctx);
      preparePluginRegistrations(ctx);
      await loadBuiltinExtensions(
        ctx,
        i === 2
          ? ["slash-commands", "codex-provider", "file-autocomplete"]
          : ["codex-provider", "file-autocomplete"],
      );
      const runtime = new PluginRuntime(settings);
      runtimes.push(runtime);
      await runtime.load(ctx);
      assert.equal(
        runtime.status[0].state,
        "loaded",
        JSON.stringify(runtime.status),
      );
      ctx.bus.emit("core:extensions-loaded", {
        names: ["ashub-kimi-coding-plan"],
      });
      const models = ctx.call("agent:get-models");
      assert.equal(
        models.find((m) => m.provider === "kimi-coding-plan").id,
        "k3",
      );
      const endpoint = ctx.call("agent:resolve-endpoint", {
        provider: "kimi-coding-plan",
        id: "k3",
      });
      const client = new LlmClient({ ...endpoint, model: "k3" });
      const result = await client.stream({
        messages: [{ role: "user", content: "test" }],
        headers: endpoint.buildRequestHeaders({ sessionId: "test" }),
      });
      let tool;
      for await (const frame of result) {
        tool = frame.choices?.[0]?.delta?.tool_calls?.[0] ?? tool;
      }
      assert.equal(tool.function.name, "echo_test");
      assert.equal(calls.at(-1).max_completion_tokens, 32768);
      if (i === 2) {
        assert.ok(!ctx.list().includes("command:/kimi-refresh"));
        assert.ok(!ctx.list().includes("command:/kimi-login"));
        continue;
      }
      let missing = false;
      ctx.bus.on("agent:providers:changed", () => {
        if (
          !ctx
            .call("agent:get-models")
            .some((m) => m.provider === "kimi-coding-plan")
        )
          missing = true;
      });
      assert.ok(ctx.list().includes("command:/kimi-refresh"));
      assert.ok(ctx.list().includes("command:/kimi-login"));
      const beforeRefresh = catalogReads;
      await ctx.call("command:/kimi-refresh", "");
      assert.equal(catalogReads, beforeRefresh + 1);
      assert.equal(
        missing,
        false,
        "refresh must not temporarily unregister the active provider",
      );
      if (i === 0) runtime.close();
    }
    console.log(
      "PASS: manifest, real asHub plugin loader, two isolated kernel instances, model catalog, native LlmClient SSE/tool parsing, output cap, disable cleanup",
    );
  } finally {
    for (const r of runtimes) r.close();
    for (const c of cores) c.kill();
    globalThis.fetch = nativeFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
